# Tiny Bot — Beat Buy-and-Hold on Solana

[![make.fun](https://make.fun/badge/u-gorun-gadget-tiny-bot-easy-2-beat-a48f3ce1.svg)](https://make.fun/bounty/u-gorun-gadget-tiny-bot-easy-2-beat-a48f3ce1)
[![rank](https://make.fun/badge/u-gorun-gadget-tiny-bot-easy-2-beat-a48f3ce1/hanafixampret/makefun-tiny-bot-solana/rank.svg)](https://make.fun/bounty/u-gorun-gadget-tiny-bot-easy-2-beat-a48f3ce1)
[![reward](https://make.fun/badge/u-gorun-gadget-tiny-bot-easy-2-beat-a48f3ce1/hanafixampret/makefun-tiny-bot-solana/reward.svg)](https://make.fun/bounty/u-gorun-gadget-tiny-bot-easy-2-beat-a48f3ce1)

A deterministic long-only trading bot for the `agent-fun/bars-replay/v1`
protocol. It trades hourly bars of FARTCOIN, JITOSOL, POPCAT, RAY, SOL, WETH
and WIF against USDC, aiming to beat the buy-and-hold baseline on net PnL.

## Strategy

Two entry signals, one shared risk frame:

- **Dip (mean reversion):** buy when a symbol's close sits 3.5% below its
  24-bar average; exit when the close reverts to that average.
- **Trend (pullback):** buy when the 6-bar average is above the 24-bar average
  and the close is within 0.5% of the 6-bar average; exit when the 6-bar
  average falls back below the 24-bar average.

Every position also exits on a 4% stop-loss or a 6% take-profit from its entry
close. At most 5 positions, 15% of equity each. When several symbols signal at
once, the strongest signals go first — deepest dip, then strongest trend —
ranked by exact bigint fractions, so a market-wide dip buys the most oversold
names instead of the first names in the universe. The bot stays mostly in
cash in a falling market and still clears the 8-trade guardrail in a quiet one.

All decisions use exact bigint arithmetic on the closes — no floats, no clock,
no environment, no randomness — so two executions produce identical action
logs. The entrypoint is `main.ts`; `vendor/makefun-bars.ts` is the kit's own
bars-replay shim, vendored byte-identical.

## Local grade (dev window)

```
node <kit>/cli/makefun.mjs grade-local --kit <kit> --bot . --driver process
```

Dev-window result: net PnL **+199.99 USDC** over 42 trades (win rate 0.524,
max drawdown 2.55%, exposure 0.361), vs buy-and-hold **−869.34 USDC** on the
same window. Result SHA256
`112ee6b1c226ad8401de6ce8be3e99c6d43d29e80f6ac22a5638c555c9f87116`
(L1 regrade reproduced byte for byte).
