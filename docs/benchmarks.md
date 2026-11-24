# Benchmark log

Nothing has been measured yet. This file is for numbers you record on your own
machine, following `loadtests/README.md`.

Write down the machine too. A result without its conditions cannot be compared
with anything.

## Environment

| | |
|---|---|
| Machine (CPU, RAM) | |
| OS, Docker version | |
| Date | |
| Git commit | |

## Results

One row per run. Change one thing between runs.

| # | Script | Users | What changed | Requests/s | p50 | p95 | p99 | Errors | Notes |
|---|---|---|---|---|---|---|---|---|---|
| 1 | `http.js` | 50 | Baseline: 2 API, 2 gateway | | | | | | |
| 2 | | | | | | | | | |

## Findings

For each comparison, three sentences: what you changed, what happened to the
numbers, and why you think it happened. For example:

> **Run 3 vs run 1 (history cache off).** *(fill in)*

These paragraphs, with real numbers behind them, are what belongs on a résumé
and what an interviewer will ask about.
