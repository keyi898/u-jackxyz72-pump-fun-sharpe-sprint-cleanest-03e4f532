# Pump.fun Sharpe Sprint — Cleanest Paper Bot

[![make.fun · u-jackxyz72-pump-fun-sharpe-sprint-cleanest-03e4f532](https://make.fun/badge/u-jackxyz72-pump-fun-sharpe-sprint-cleanest-03e4f532.svg)](https://make.fun/bounty/u-jackxyz72-pump-fun-sharpe-sprint-cleanest-03e4f532?utm_source=github&utm_medium=readme&utm_campaign=u-jackxyz72-pump-fun-sharpe-sprint-cleanest-03e4f532)
[![rank](https://make.fun/badge/u-jackxyz72-pump-fun-sharpe-sprint-cleanest-03e4f532/keyi898/u-jackxyz72-pump-fun-sharpe-sprint-cleanest-03e4f532/rank.svg)](https://make.fun/bounty/u-jackxyz72-pump-fun-sharpe-sprint-cleanest-03e4f532/leaderboard?utm_source=github&utm_medium=readme&utm_campaign=u-jackxyz72-pump-fun-sharpe-sprint-cleanest-03e4f532)
[![reward](https://make.fun/badge/u-jackxyz72-pump-fun-sharpe-sprint-cleanest-03e4f532/keyi898/u-jackxyz72-pump-fun-sharpe-sprint-cleanest-03e4f532/reward.svg)](https://make.fun/bounty/u-jackxyz72-pump-fun-sharpe-sprint-cleanest-03e4f532?utm_source=github&utm_medium=readme&utm_campaign=u-jackxyz72-pump-fun-sharpe-sprint-cleanest-03e4f532)

Bounty: https://make.fun/bounty/u-jackxyz72-pump-fun-sharpe-sprint-cleanest-03e4f532

A paper-trading bot for the `agent-fun/replay/v2` harness, built for hourly
Sharpe. The design follows what the dev window actually measures: on
pump.fun bonding curves the median coin bleeds steadily after its first
trades and round-trip friction is ~2.5% in curve fees plus tx fees, so
active momentum trading loses money with high variance. This bot trades
rarely and small.

## Strategy

- **Selective entries (the PnL engine).** A mint qualifies only at the exact
  trade where its real SOL reserve first crosses 3 SOL, and only if that
  happens within 100 slots of its first trade, with at least 4 distinct
  non-creator buyers so far and the creator's own buys at most 30% of buy
  volume — fast, broad, organic demand rather than a dev bundle. One entry
  per mint, sized up to 0.08 SOL but always under the per-batch cap (1% of
  real reserve). Exits are mechanical: stop-loss at −12% of cost (marked to
  the bonding curve net of fees), a trailing stop that arms at +15% and
  fires 15% below peak proceeds, a 600-slot max hold, and a dead-coin exit.
- **Guardrail banking (the insurance).** The minimum bar needs round trips
  of at least 0.01 SOL on 20 distinct mints. If selective entries are not
  covering that count as slots pass, the bot banks minimum-size (0.012 SOL)
  round trips on live mints, paced at most one per 150 slots, and exits
  within a few slots of entry — the cost is essentially the fees and
  exposure time is tiny, so hourly returns stay near-flat.
- **Risk shape.** At most 5 open positions, each at most ~0.08 SOL on
  10 SOL capital: maximum exposure under 4% of capital, so drawdown stays
  small by construction.

## Determinism

No clock, no randomness, no network, no environment access. Decisions depend
only on the `hello`/`batch` messages; ties break on the mint string, so two
runs emit byte-identical action logs.

## Layout

- `main.ts` — the strategy (Node 22, native TypeScript, no dependencies).
- `vendor/makefun-bot.ts` — the kit's `agent-fun/replay/v2` wire shim.

Paper trading only: the replay uses market data, never real funds.
