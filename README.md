[![make.fun · token-radar-01](https://make.fun/badge/token-radar-01.svg)](https://make.fun/bounty/token-radar-01?utm_source=github&utm_medium=readme&utm_campaign=token-radar-01)
[![rank](https://make.fun/badge/token-radar-01/yorhedxx/token-radar-entry/rank.svg)](https://make.fun/bounty/token-radar-01/leaderboard?utm_source=github&utm_medium=readme&utm_campaign=token-radar-01)
[![reward](https://make.fun/badge/token-radar-01/yorhedxx/token-radar-entry/reward.svg)](https://make.fun/bounty/token-radar-01?utm_source=github&utm_medium=readme&utm_campaign=token-radar-01)

# Launch Radar — priced from the record

An entry for make.fun's [Token Radar](https://make.fun/bounty/token-radar-01) bounty: rank the protocols in the competition's sealed DefiLlama snapshot that have no token yet by their implied launch value, and hand in the board as a web dashboard.

## What it does

`main.ts` (Node 22, standard library only) reads the sealed snapshot, runs the model in `lib/model.ts`, and writes the outputs the scorer reads: `board.json`, the dashboard data, copies of `dashboard/` and `screenshots/`, and `dossier.json` built with the vendored `vendor/makefun-board.ts`. The run is deterministic — two runs on the same snapshot write identical bytes.

The dashboard is a dark terminal page that renders fully offline: the 198-row board with filters, a detail view for every protocol with the model's decomposition and a costed farm plan, an evidence-and-method view with the validation tables and the full accounting ledger, and an integrity strip that recomputes every row's implied value in the page from the printed coefficients (198 of 198 reproduced; board checksum `e4040d63`).

## The model (radar-2)

- **Classification** — all 758 snapshot protocols are accounted for exactly once: 198 ranked (the 40-protocol watchlist covered exactly, 138 house-style-clean pre-token protocols below the $50M floor, and a flagged tier of 20 pre-token protocols at or above the floor that the watchlist leaves out, ranked with a stated ×0.5 lineage discount), 416 that already record a token (144 priced, 272 unpriced), and 144 excluded by stated rules (category, versioned name, wrapped/staked name).
- **Implied value = fitted launch value × fitted launch odds.** Launch value is a log-log OLS of log(market cap) on log(TVL) fitted on the snapshot's own priced record (128 protocols with a positive cap; intercept 6.9646, slope 0.5223) plus shrunk per-category effects. Launch odds are a logistic fit over all 758 protocols on years listed, leave-self-out category token share, log TVL, and clamped 7-day growth. No protocol names anywhere in the model — rules and fits only.
- **Farm plans** — six costed steps per row with the assumptions printed on the dashboard ($1,000 reference deposit, expected drop = 4% of implied value, per-chain gas classes, 8%/yr capital charge): 135 FARM / 15 MARGINAL / 48 SKIP verdicts in net $/hour.

## Validation (on the snapshot's own record)

| model | leave-one-out ×-miss | walk-forward ×-miss |
| --- | ---: | ---: |
| fitted (radar-2, shipped) | ×3.86 | ×3.03 |
| starter formula | ×5.11 | ×5.26 |
| flat 0.25 × TVL | ×4.91 | ×4.14 |

The stated P25–P75 band holds 47.7% of actual caps leave-one-out (nominal 50% — the band is honest). Odds Brier: 0.2009 in-sample, 0.2048 ten-fold, base rate 0.2476. A log chain-count term won leave-one-out (×3.72) but lost walk-forward (×3.57), so it was rejected under the pre-agreed two-test rule; the failed ablation is printed in the dashboard's evidence view. Final `board.json` sha256: `f69337883755149efecca303e0d114a229467b832db7316bb783358b3652c434`.

## Run it

```sh
mkdir -p out && MAKEFUN_OUTPUT_DIR=out node main.ts --input <snapshot.json>
```

In the grader's container the snapshot is mounted at `/input/snapshot.json` and output goes to `/output`; outside it, `--input` and `MAKEFUN_OUTPUT_DIR` (or `--output`) stand in for those paths.

## Layout

- `main.ts` — the entry program
- `lib/model.ts` — classification, valuation model, validation, farm plans
- `vendor/makefun-board.ts` — the kit's board/dossier library, byte-identical to the kit's
- `dashboard/` — the offline dashboard (3 files, 34,339 bytes)
- `screenshots/` — board, detail, and FARM-filtered views at 1440×900
- `tools/` — the local gate replica and the screenshot tool

## License

MIT — see `LICENSE`.
