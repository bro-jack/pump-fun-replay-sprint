// Pump.fun Replay Sprint — crowd + dev-conviction launch sniper.
//
// Run by the grader as `node /bot/main.ts` with this directory mounted at /bot.
// Node 22.18+ runs this TypeScript as it is; no build step, no dependencies,
// no network, no I/O beyond the harness protocol on stdin/stdout.
//
// What it does (full reasoning lives in strategy.ts): it watches every launch
// and buys only the ones where the creator bought >= 0.7 SOL in the create slot
// AND at least 6 distinct non-creator buyers showed up within 2 slots. One buy
// per coin, sized to the 1% of real-reserve cap (target 0.4 SOL), out at +15%
// or -12% or after 10 slots, whichever comes first. Backtested on the kit's
// 24h dataset: +0.418 SOL over the full day (+0.032 / +0.421 / -0.034 per
// ~8h part), 46 coins, 23 wins, max drawdown 0.004 SOL — vs -9.384 for the
// momentum pilot, -1.779 for reversion, -0.485 for the sniper as shipped.

import { runBot } from './vendor/makefun-bot.ts';
import { createBot, STRATEGY_PARAMS } from './strategy.ts';

const bot = createBot(STRATEGY_PARAMS);

await runBot({
  onBatch: (state, batch) => bot.onBatch(state, batch),
});
