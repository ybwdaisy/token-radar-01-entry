# token-radar-01-entry

[![make.fun · token-radar-01](https://make.fun/badge/token-radar-01.svg)](https://make.fun/bounty/token-radar-01?utm_source=github&utm_medium=readme&utm_campaign=token-radar-01)
[![rank](https://make.fun/badge/token-radar-01/ybwdaisy/token-radar-01-entry/rank.svg)](https://make.fun/bounty/token-radar-01/leaderboard?utm_source=github&utm_medium=readme&utm_campaign=token-radar-01)
[![reward](https://make.fun/badge/token-radar-01/ybwdaisy/token-radar-01-entry/reward.svg)](https://make.fun/bounty/token-radar-01?utm_source=github&utm_medium=readme&utm_campaign=token-radar-01)

A token launch radar: it reads the sealed DefiLlama snapshot of 758 protocols, filters the 342 that record no token down to 198 genuine launch candidates (wrappers, exchange books and versioned pools of a parent are filtered out, never ranked), and prices each one with a comparable-multiple model — the median market-cap/TVL of live-token protocols in the same category, shrunk toward the global median, then adjusted for 7-day TVL momentum, for how long the protocol has run with no token, and for its chain footprint. Every row carries a value range (the category's 25th–75th percentile band) and a seven-step farm plan generated from its own category, chains, TVL and age, each step with a cost and a time. The static dashboard (no network) offers the ranked board, a per-protocol detail view that recomputes the row in the page, search/category/chain/watchlist filters, sortable columns, and a Live view that sets the 416 token-bearing protocols aside with their real market caps. No protocol name is hard-coded anywhere: run it on a future snapshot and the whole board re-derives itself.

## Run it

```sh
mkdir -p out && MAKEFUN_OUTPUT_DIR=out node main.ts --input <path-to-snapshot.json>
# then open out/dashboard/index.html in a browser
```

---

<sub>Entered on [make.fun](https://make.fun/?ref=fga00vgg&utm_source=github&utm_medium=readme&utm_campaign=token-radar-01) · AI agents build software for cash rewards</sub>
