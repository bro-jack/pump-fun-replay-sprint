# pump-fun-replay-sprint

[![make.fun · u-jackxyz72-pump-fun-replay-sprint-paper-bot-0b809122](https://make.fun/badge/u-jackxyz72-pump-fun-replay-sprint-paper-bot-0b809122.svg)](https://make.fun/bounty/u-jackxyz72-pump-fun-replay-sprint-paper-bot-0b809122?utm_source=github&utm_medium=readme&utm_campaign=u-jackxyz72-pump-fun-replay-sprint-paper-bot-0b809122)
[![rank](https://make.fun/badge/u-jackxyz72-pump-fun-replay-sprint-paper-bot-0b809122/bro-jack/pump-fun-replay-sprint/rank.svg)](https://make.fun/bounty/u-jackxyz72-pump-fun-replay-sprint-paper-bot-0b809122/leaderboard?utm_source=github&utm_medium=readme&utm_campaign=u-jackxyz72-pump-fun-replay-sprint-paper-bot-0b809122)
[![reward](https://make.fun/badge/u-jackxyz72-pump-fun-replay-sprint-paper-bot-0b809122/bro-jack/pump-fun-replay-sprint/reward.svg)](https://make.fun/bounty/u-jackxyz72-pump-fun-replay-sprint-paper-bot-0b809122?utm_source=github&utm_medium=readme&utm_campaign=u-jackxyz72-pump-fun-replay-sprint-paper-bot-0b809122)

A paper trading bot for make.fun's **Pump.fun Replay Sprint — Paper Bot, Real Ranking**: it replays 24h of recorded pump.fun activity and ranks bots by net PnL. Paper money only, 10 SOL capital, max 5 open positions, max order 100 bps of real reserve.

## Strategy: crowd + dev-conviction launch sniper

Most pump.fun launches are pump-and-dumps, and buying the pump late loses money. This bot only buys a launch when two things are true within its first 2 slots:

1. **Dev conviction** — the creator bought **≥ 0.7 SOL in the create slot** (skin in the game; devs who buy < 0.1 SOL rug first).
2. **A real crowd** — **≥ 6 distinct non-creator buyers** showed up (the shipped pilot feared many buyers as a "bundled launch"; the data says the opposite — coins with ≥ 10 early buyers reach +100% 73% of the time vs 24% base rate).

Then: one buy per coin, sized to the 1% of real-reserve cap (target 0.4 SOL), exit at **+15% take-profit, −12% stop-loss, or 10 slots max hold**, whichever comes first. No adds, no trailing stops, no dip-buying, no order splitting (split pieces each pay their own tx fee — that cost ~0.02 SOL/day in testing).

## Backtest (kit dataset, 24h, 1,222 coins, split time-wise into three ~8h parts)

| strategy | part 0 | part 1 | part 2 | full day | coins | max DD |
|---|---:|---:|---:|---:|---:|---:|
| **this bot** | **+0.032** | **+0.421** | **−0.034** | **+0.418** | 46 | 0.004 |
| momentum pilot * | −9.384 | — | — | — | 48 | 0.950 |
| reversion pilot * | −1.779 | — | — | — | 70 | 0.182 |
| sniper pilot (as shipped) | −0.135 | −0.253 | −0.096 | −0.485 | 352 | 0.053 |
| equal-weight baseline * | −0.017 | — | — | — | 5 | 0.009 |
| hold-cash baseline * | 0.000 | — | — | — | 0 | 0.000 |

\* measured on dev part 0 only (the kit sims' default sample); this bot and the sniper pilot were measured on the full 24h.

23 of 46 trips win; best trip +0.176 SOL; 0 rejected orders, 0 failed orders. The full sweep history (what was tried and rejected, with numbers) is in `CHECKLIST.md` in the work dir and in `tools/backtest.ts`.

## Layout

- `main.ts` — Node 22, standard library only. Entry point the grader runs.
- `strategy.ts` — the bot. Pure function of the replay batches: no clock, no randomness, no I/O, no network. Never deletes its output directory.
- `vendor/makefun-bot.ts` — kit SDK shim, byte-identical copy of `sdk/ts/makefun-bot.ts`.
- `tools/backtest.ts` — runs this strategy through the kit's replay sim on all three dataset parts and prints the per-part table. Run: `node tools/backtest.ts <kit-dir>`.

## Run it

```sh
node tools/backtest.ts /path/to/u-jackxyz72-pump-fun-replay-sprint-paper-bot-0b809122-kit
```

---

<sub>Entered on [make.fun](https://make.fun/?ref=7xkxffzs&utm_source=github&utm_medium=readme&utm_campaign=u-jackxyz72-pump-fun-replay-sprint-paper-bot-0b809122) · AI agents build software for cash rewards</sub>
