// Backtest for the entry in this repo: runs strategy.ts through the kit's own
// replay sim (baselines/pilot/momentum/tools/sim.ts — the local port of the
// grader's engine) over all three dataset parts and prints the per-part table
// plus the minimum-bar check (round trips >= 0.01 SOL on >= 20 coins).
// Usage:
//   node tools/backtest.ts <kit-dir>
//   node tools/backtest.ts <kit-dir> --per-part   # each part standalone, fresh capital
// No network, no randomness: two runs print byte-identical numbers.
import { readFileSync } from 'node:fs';
import { gunzipSync } from 'node:zlib';
import { createHash } from 'node:crypto';
import { createBot, STRATEGY_PARAMS } from '../strategy.ts';

const kit = process.argv[2]!;
const simMod: any = await import(`${kit}/baselines/pilot/momentum/tools/sim.ts`);
const { makeHello, phaseSeed, simulate } = simMod;
type Dataset = { sha256: string; events: any[]; endSlot: number; batches: { slot: number; events: any[] }[] };

const kitJson = JSON.parse(readFileSync(`${kit}/kit.json`, 'utf8'));
const manifest = JSON.parse(readFileSync(`${kit}/dataset/manifest.json`, 'utf8'));

function loadAll(kitDir: string): { full: Dataset; part0: Dataset; bounds: number[] } {
  const { modulus, residue } = manifest.universe.sample;
  const excluded = new Set<string>(manifest.excluded_mints ?? []);
  const bounds: number[] = [];
  const allEvents: any[] = [];
  const part0Events: any[] = [];
  for (let i = 0; i < 3; i++) {
    const raw = gunzipSync(readFileSync(`${kitDir}/dataset/events/part-0000${i}.ndjson.gz`)).toString('utf8');
    const lines = raw.split('\n').filter((l) => l.length > 0).map((l) => JSON.parse(l));
    const members = new Set<string>();
    const kept: any[] = [];
    for (const e of lines) {
      if (e.event === 'CreateEvent' && !members.has(e.mint)) {
        const h = BigInt('0x' + createHash('sha256').update(e.mint, 'utf8').digest('hex'));
        if (e.quote_mint === '11111111111111111111111111111111' && !e.is_mayhem_mode && !e.is_cashback_enabled && !excluded.has(e.mint) && h % BigInt(modulus) === BigInt(residue)) members.add(e.mint);
      }
      if (members.has(e.mint)) kept.push(e);
    }
    bounds.push(kept[kept.length - 1].slot);
    allEvents.push(...kept);
    if (i === 0) part0Events.push(...kept);
  }
  const toDs = (events: any[]): Dataset => {
    const batches: { slot: number; events: any[] }[] = [];
    for (const e of events) {
      const tail = batches[batches.length - 1];
      if (tail !== undefined && tail.slot === e.slot) tail.events.push(e);
      else batches.push({ slot: e.slot, events: [e] });
    }
    return { sha256: kitJson.dataset_sha256, events, endSlot: manifest.window?.end_slot ?? events[events.length - 1].slot, batches };
  };
  return { full: toDs(allEvents), part0: toDs(part0Events), bounds };
}

const { full, part0, bounds } = loadAll(kit);
const hello = makeHello(phaseSeed('pilot-pumpfun-replay', 'dev', full.sha256));
const sol = (x: bigint | number) => (Number(x) / 1e9).toFixed(3);

// Wrap the bot to record buy sizes: a coin counts toward the minimum bar when
// its buy leg is >= 0.01 SOL (10_000_000 lamports) and the trip closes.
function makeInstrumentedBot() {
  const bot = createBot(STRATEGY_PARAMS);
  const buys = new Map<string, bigint>();
  return {
    bot: {
      onBatch(state: any, batch: any) {
        const orders = bot.onBatch(state, batch);
        for (const o of orders) {
          if (o.side === 'buy') buys.set(o.mint, (buys.get(o.mint) ?? 0n) + BigInt(o.quote_lamports));
        }
        return orders;
      },
    },
    buys,
  };
}

const inst0 = makeInstrumentedBot();
const r0 = simulate(part0, hello, inst0.bot);
const inst = makeInstrumentedBot();
const rf = simulate(full, hello, inst.bot);

const perPart = [0, 0, 0];
for (const t of rf.trips) {
  const idx = t.close <= bounds[0]! ? 0 : t.close <= bounds[1]! ? 1 : 2;
  perPart[idx]! += Number(t.pnl) / 1e9;
}
const wins = rf.trips.filter((t) => t.pnl > 0n).length;
const best = Math.max(0, ...rf.trips.map((t) => Number(t.pnl) / 1e9));
const closedMints = new Set(rf.trips.map((t) => t.mint));
let qualifying = 0;
for (const [mint, amount] of inst.buys) {
  if (closedMints.has(mint) && amount >= 10_000_000n) qualifying++;
}

console.log(`strategy: crowd + dev-conviction sniper ${JSON.stringify(STRATEGY_PARAMS)}`);
console.log(`dev part0 : net ${sol(r0.netPnl)} SOL, fills ${r0.fills}, coins ${r0.mints}, dd ${r0.maxDrawdown.toFixed(3)}`);
console.log(`full 24h : net ${sol(rf.netPnl)} SOL  [part0 ${perPart[0]!.toFixed(3)}  part1 ${perPart[1]!.toFixed(3)}  part2 ${perPart[2]!.toFixed(3)}]`);
console.log(`trips ${rf.trips.length}, wins ${wins} (${(wins / Math.max(1, rf.trips.length) * 100).toFixed(0)}%), best trip +${best.toFixed(3)} SOL, max drawdown ${rf.maxDrawdown.toFixed(3)} SOL`);
console.log(`rejected ${rf.rejected} (${JSON.stringify(rf.rejectReasons)}), failed ${rf.failed}`);
console.log(`minimum bar: ${qualifying} coins with round trips >= 0.01 SOL (need >= 20) -> ${qualifying >= 20 ? 'PASS' : 'FAIL'}`);

if (process.argv.includes('--per-part')) {
  for (let i = 0; i < 3; i++) {
    const ev = full.events.filter((e: any) => (i === 0 ? e.slot <= bounds[0]! : i === 1 ? e.slot > bounds[0]! && e.slot <= bounds[1]! : e.slot > bounds[1]!));
    const batches: { slot: number; events: any[] }[] = [];
    for (const e of ev) {
      const tail = batches[batches.length - 1];
      if (tail !== undefined && tail.slot === e.slot) tail.events.push(e);
      else batches.push({ slot: e.slot, events: [e] });
    }
    const ds: Dataset = { sha256: full.sha256, events: ev, endSlot: ev[ev.length - 1].slot, batches };
    const r = simulate(ds, hello, createBot(STRATEGY_PARAMS));
    console.log(`  part${i} standalone: net ${sol(r.netPnl)} fills ${r.fills} coins ${r.mints} trips ${r.trips.length} wins ${r.trips.filter((t) => t.pnl > 0n).length}`);
  }
}
