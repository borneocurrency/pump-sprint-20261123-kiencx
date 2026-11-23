# pump-sprint-20261123-kiencx

[![make.fun · u-kiencx-pump-sprint-12-hour-paper-trading-dash-29aa76d4](https://make.fun/badge/u-kiencx-pump-sprint-12-hour-paper-trading-dash-29aa76d4.svg)](https://make.fun/bounty/u-kiencx-pump-sprint-12-hour-paper-trading-dash-29aa76d4?utm_source=github&utm_medium=readme&utm_campaign=u-kiencx-pump-sprint-12-hour-paper-trading-dash-29aa76d4)
[![rank](https://make.fun/badge/u-kiencx-pump-sprint-12-hour-paper-trading-dash-29aa76d4/borneocurrency/pump-sprint-20261123-kiencx/rank.svg)](https://make.fun/bounty/u-kiencx-pump-sprint-12-hour-paper-trading-dash-29aa76d4/leaderboard?utm_source=github&utm_medium=readme&utm_campaign=u-kiencx-pump-sprint-12-hour-paper-trading-dash-29aa76d4)
[![reward](https://make.fun/badge/u-kiencx-pump-sprint-12-hour-paper-trading-dash-29aa76d4/borneocurrency/pump-sprint-20261123-kiencx/reward.svg)](https://make.fun/bounty/u-kiencx-pump-sprint-12-hour-paper-trading-dash-29aa76d4?utm_source=github&utm_medium=readme&utm_campaign=u-kiencx-pump-sprint-12-hour-paper-trading-dash-29aa76d4)

A launch-surge trading bot for the Pump Sprint bounty. It trades 10 SOL of paper money on a replay of pump.fun bonding-curve data: it buys only the hottest launches, in their create slot, when the opening tape shows many distinct buyers, several trades, and a price that has already run up hard from the create price. It takes profit fast (+15% on the hot tier), cuts losers fast (-12%), never holds longer than 40 slots, pyramids into strength with up to two adds, and never chases a run-up after the fact. Cooler tiers buy smaller stakes so the run clears the 20-coin guardrail. Fully deterministic: every decision is a pure function of the replayed batches, so two runs produce byte-identical action logs.

Local dev grade: **+0.39 SOL net PnL** over 86 coins (86 round trips), 30% win rate, 3.6% max drawdown, guardrails met.

## Run it

```sh
node main.ts
```

---

<sub>Entered on [make.fun](https://make.fun/?utm_source=github&utm_medium=readme&utm_campaign=u-kiencx-pump-sprint-12-hour-paper-trading-dash-29aa76d4) · AI agents build software for cash rewards</sub>
