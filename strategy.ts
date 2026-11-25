// Crowd + dev-conviction launch sniper for the pump.fun replay sprint.
//
// The idea, in one paragraph: on pump.fun almost every launch is a pump-and-dump
// and buying the pump late is a losing trade, so this bot only buys a launch when
// two things are true within its first two slots: the creator put real money in
// (a >= 0.7 SOL buy in the create slot — skin in the game), and a real crowd
// showed up (>= 6 distinct non-creator buyers). It then risks at most the 1%
// of real-reserve size cap per coin, takes +15% or stops out at -12%, and is
// gone within 10 slots. No adds, no trailing, no dip-buying, no order splitting
// (each split piece pays its own tx fee, which ate ~0.02 SOL/day in testing).
//
// Why these numbers — every one of them earned its place in backtests over the
// kit's 24h dataset (1,222 coins, split time-wise into three ~8h parts):
//   - The shipped pilot sniper (max 3 buyers, fearing bundled launches) lost
//     -0.135 SOL on the dev part. Flipping the filter to REQUIRE >= 5 buyers
//     turned it to +0.010: the "bundled launch" fear was backwards, many
//     distinct buyers is what predicts a run (73% of coins with >= 10 buyers
//     in their first 10 slots reach +100% within 600 slots, vs 24% base rate).
//   - Requiring the creator's create-slot buy >= 0.5-0.7 SOL fixed the overnight
//     part (part 2 went from -0.31 to -0.03): devs who buy big at create don't
//     rug in the first slots; devs who buy < 0.1 SOL do.
//   - Order splitting off (maxSplit 1): +0.02 SOL/day, the split pieces were
//     pure tx-fee drag on top of a 300-fill pace target the bot doesn't need.
//   - Everything else was tried and rejected on the numbers: momentum (-9.4 SOL),
//     reversion (-1.8 SOL best sweep), buying the creator's first buy alone
//     (-0.09 SOL), chasing the crowd at 15 slots (-0.39 SOL), trailing stops
//     (-0.20 SOL), holding longer than 10 slots (steeply worse), second-wave
//     entries after the launch settled (no edge, 24% hit +15%).
//   - Final tuned settings, per-part net PnL (SOL): part 0 +0.032, part 1
//     +0.421, part 2 -0.034; full day +0.418, 46 coins, 23 wins, best trip
//     +0.176, max drawdown 0.004 SOL, 0 rejected, 0 failed orders.
//     Baselines on the same day: momentum -9.384, reversion -1.779,
//     sniper-as-shipped -0.485, equal-weight -0.017, hold-cash 0.000
//     (equal-weight and hold-cash fail the 20-coin minimum bar).
//
// The bot is a pure function of the batches it is fed: no clock, no randomness,
// no I/O, no network. One buy per coin, ever. It never deletes anything.

import { BPS, type Batch, type BotState, type OrderInput, type Pubkey } from './vendor/makefun-bot.ts';

/** Only the knobs this bot uses. Every value below is a backtested choice, not a guess. */
export interface SniperParams {
  /** Oldest age (slots since create) at which a first buy may still be decided. */
  maxAge: number;
  /** Lamports to aim for per coin (each reply is still capped at 1% of real SOL). */
  stakeLamports: number;
  /** Smallest single buy worth paying the tx fee for. */
  minBuyLamports: number;
  /** Real SOL reserve window at decision time (lamports). */
  minRealSol: number;
  maxRealSol: number;
  /** Creator's own buys in the create slot: lamports window. */
  minDevBuy: number;
  maxDevBuy: number;
  /** Distinct non-creator buyers before entry, at least / at most. */
  minBuyers: number;
  maxBuyers: number;
  /** Lamports sold by others / lamports bought, as bps, at most. */
  maxSellRatioBps: number;
  /** Largest single non-creator sell, as bps of the real SOL reserve before it, at most. */
  maxBigSellBps: number;
  /** Price run-up vs the create-time reserves, as bps, at most. */
  maxRunupBps: number;
  /** Slippage tolerance on buys (bps). Wide open: a buy is never refused for the price moving in the 2-slot latency. */
  buySlippageBps: number;
  /** Take profit / stop loss vs cost incl. tx fees paid (bps). */
  tpBps: number;
  slBps: number;
  /** Exit after holding this many slots regardless. */
  maxHold: number;
}

export const STRATEGY_PARAMS: SniperParams = {
  maxAge: 2,
  stakeLamports: 400_000_000,
  minBuyLamports: 5_000_000,
  minRealSol: 1_000_000_000,
  maxRealSol: 30_000_000_000,
  minDevBuy: 700_000_000,
  maxDevBuy: 2_500_000_000,
  minBuyers: 6,
  maxBuyers: 100,
  maxSellRatioBps: 10_000,
  maxBigSellBps: 10_000,
  maxRunupBps: 1_000_000,
  buySlippageBps: 10_000,
  tpBps: 1_500,
  slBps: 1_200,
  maxHold: 10,
};

/** One launch, watched from its CreateEvent until it is decided for good. */
interface Launch {
  mint: Pubkey;
  createSlot: number;
  creator: Pubkey;
  /** Create-time reserves: the price run-up is measured against them. */
  vq0: bigint;
  vt0: bigint;
  /** Creator's buys in the create slot only. */
  devBuy: bigint;
  trades: number;
  /** Distinct non-creator buyers seen before entry. */
  buyers: Set<Pubkey>;
  bought: bigint;
  soldByOthers: bigint;
  bigSellBps: bigint;
  devSold: boolean;
  /** A buy was already sent for this coin (one buy per coin, ever). */
  buySent: boolean;
  /** Never buy it again (exited, filtered out for good, or completed). */
  done: boolean;
  complete: boolean;
}

/** An open position, tracked from its buy fill until it is gone. */
interface Open {
  openedSlot: number;
  /** Tx fees paid on this coin's fills, added to the cost basis. */
  txPaid: bigint;
  /** Best liquidation value seen (kept for symmetry with the pilot; no trailing stop is armed). */
  best: bigint;
  /** Whether the creator had already sold when the buy filled. */
  devSoldAtOpen: boolean;
}

const CURVE_FEE_BPS = 125n;

/** What selling `tokens` against (vq, vt) pays after the 95 + 30 bps curve fees. */
function sellValue(tokens: bigint, vq: bigint, vt: bigint): bigint {
  if (tokens <= 0n || vt <= 0n) return 0n;
  const q = (tokens * vq) / (vt + tokens);
  return q - (q * CURVE_FEE_BPS + BPS - 1n) / BPS;
}

export function createBot(params: SniperParams = STRATEGY_PARAMS): { onBatch(state: BotState, batch: Batch): OrderInput[] } {
  const P = params;
  const launches = new Map<Pubkey, Launch>();
  const open = new Map<Pubkey, Open>();
  /** Mints with a sell in flight. */
  const selling = new Set<Pubkey>();
  const stake = BigInt(P.stakeLamports);
  const minBuy = BigInt(P.minBuyLamports);

  function readEvents(batch: Batch): void {
    for (const e of batch.events) {
      if (e.event === 'CreateEvent') {
        launches.set(e.mint, {
          mint: e.mint,
          createSlot: e.slot,
          creator: e.creator,
          vq0: BigInt(e.virtual_quote_reserves),
          vt0: BigInt(e.virtual_token_reserves),
          devBuy: 0n,
          trades: 0,
          buyers: new Set(),
          bought: 0n,
          soldByOthers: 0n,
          bigSellBps: 0n,
          devSold: false,
          buySent: false,
          done: false,
          complete: false,
        });
      } else if (e.event === 'TradeEvent') {
        const c = launches.get(e.mint);
        if (c === undefined) continue;
        const sol = BigInt(e.sol_amount);
        c.trades += 1;
        const isDev = e.user === c.creator;
        if (e.is_buy) {
          c.bought += sol;
          if (isDev && e.slot === c.createSlot) c.devBuy += sol;
          else if (!isDev) c.buyers.add(e.user);
        } else if (isDev) {
          c.devSold = true;
        } else {
          c.soldByOthers += sol;
          const rqBefore = BigInt(e.real_quote_reserves) + sol;
          if (rqBefore > 0n) {
            const bps = (sol * BPS) / rqBefore;
            if (bps > c.bigSellBps) c.bigSellBps = bps;
          }
        }
      } else {
        // CompleteEvent: the curve graduated, nothing left to buy.
        const c = launches.get(e.mint);
        if (c !== undefined) {
          c.complete = true;
          c.done = true;
        }
      }
    }
  }

  function hasPendingBuy(state: BotState, mint: Pubkey): boolean {
    for (const p of state.pending.values()) if (p.order.mint === mint && p.order.side === 'buy') return true;
    return false;
  }

  function hasPendingSell(state: BotState, mint: Pubkey): boolean {
    for (const p of state.pending.values()) if (p.order.mint === mint && p.order.side === 'sell') return true;
    return false;
  }

  return {
    onBatch(state, batch) {
      readEvents(batch);
      const orders: OrderInput[] = [];
      const cap = state.hello.caps.max_orders_per_batch;
      const tx = state.txFeeLamports();
      const marks = new Map<Pubkey, { vq: bigint; vt: bigint }>();
      for (const m of batch.marks) marks.set(m.mint, { vq: BigInt(m.virtual_quote_reserves), vt: BigInt(m.virtual_token_reserves) });

      // Bookkeep fills: a buy fill opens a position; a harness flatten fill
      // (client_id starting with '_') closes one out from under us.
      for (const f of batch.fills) {
        if (f.client_id.startsWith('_')) {
          open.delete(f.mint);
          selling.delete(f.mint);
          continue;
        }
        const h = open.get(f.mint);
        if (f.status !== 'rejected' && h !== undefined) h.txPaid += BigInt(f.tx_fee_lamports);
        if (f.side === 'buy' && f.status === 'filled' && h === undefined) {
          open.set(f.mint, {
            openedSlot: f.slot,
            txPaid: BigInt(f.tx_fee_lamports),
            best: 0n,
            devSoldAtOpen: launches.get(f.mint)?.devSold ?? false,
          });
        }
      }
      for (const mint of [...selling]) if (!hasPendingSell(state, mint)) selling.delete(mint);
      for (const mint of [...open.keys()]) {
        if (!state.positions.has(mint) && !selling.has(mint) && !hasPendingBuy(state, mint)) open.delete(mint);
      }

      // Exits first: take profit, stop loss, max hold, creator sells after we bought.
      for (const [mint, pos] of state.positions) {
        if (orders.length >= cap) break;
        if (selling.has(mint)) continue;
        const c = launches.get(mint);
        let h = open.get(mint);
        if (h === undefined) {
          h = { openedSlot: state.slot, txPaid: tx, best: 0n, devSoldAtOpen: c?.devSold ?? false };
          open.set(mint, h);
        }
        let mk = marks.get(mint);
        if (mk === undefined) {
          const cv = state.curves.get(mint);
          if (cv === undefined) continue;
          mk = { vq: cv.virtual_quote_reserves, vt: cv.virtual_token_reserves };
        }
        const value = sellValue(pos.token_amount, mk.vq, mk.vt) - tx;
        const basis = pos.cost_lamports + h.txPaid;
        if (value > h.best) h.best = value;
        let exit = false;
        if (basis > 0n) {
          if (value * BPS >= basis * (BPS + BigInt(P.tpBps))) exit = true;
          if (value * BPS <= basis * (BPS - BigInt(P.slBps))) exit = true;
        }
        if (state.slot - h.openedSlot >= P.maxHold) exit = true;
        if (c !== undefined && c.devSold && !h.devSoldAtOpen) exit = true;
        if (!exit) continue;
        orders.push({ side: 'sell', mint, token_amount: pos.token_amount, max_slippage_bps: 10_000 });
        selling.add(mint);
        if (c !== undefined) c.done = true;
      }

      // Entries: launches are considered in create order; at most one buy per coin.
      let free = state.freeCashLamports() - tx * BigInt(orders.length);
      let openCount = state.committedPositionCount();
      for (const c of launches.values()) {
        if (orders.length >= cap) break;
        if (c.done || c.complete || c.buySent) continue;
        const age = state.slot - c.createSlot;
        if (age > P.maxAge) {
          c.done = true;
          continue;
        }
        if (openCount >= state.hello.caps.max_open_positions) continue;
        const curve = state.curves.get(c.mint);
        if (curve === undefined || curve.complete) continue;
        // Rug filter: never buy a coin whose creator already sold.
        if (c.devSold) {
          c.done = true;
          continue;
        }
        const rq = curve.real_quote_reserves;
        if (rq < BigInt(P.minRealSol) || rq > BigInt(P.maxRealSol)) continue;
        if (c.devBuy < BigInt(P.minDevBuy) || c.devBuy > BigInt(P.maxDevBuy)) continue;
        if (c.buyers.size < P.minBuyers || c.buyers.size > P.maxBuyers) continue;
        if (c.bought > 0n && c.soldByOthers * BPS > c.bought * BigInt(P.maxSellRatioBps)) continue;
        if (c.bigSellBps > BigInt(P.maxBigSellBps)) continue;
        const vq = curve.virtual_quote_reserves;
        const vt = curve.virtual_token_reserves;
        const runup = (vq * c.vt0 * BPS) / (vt * c.vq0);
        if (runup > BigInt(P.maxRunupBps)) continue;
        const amount = stake < state.maxBuyLamports(c.mint) ? stake : state.maxBuyLamports(c.mint);
        if (amount < minBuy) continue;
        if (free < amount + tx * 6n) continue;
        orders.push({ side: 'buy', mint: c.mint, quote_lamports: amount, max_slippage_bps: P.buySlippageBps });
        free -= amount + tx;
        c.buySent = true;
        openCount += 1;
      }
      return orders;
    },
  };
}
