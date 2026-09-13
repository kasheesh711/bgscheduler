# Progress-paper model evaluation

This harness compares source preservation, structured-output completion, PDF rendering, elapsed time and returned token usage. It never writes application records, sends notifications, or publishes to Wise.

Private inputs and results live under ignored `output/progress-tests-pdf/`. The existing `source-regression.pdf`, fixture PDFs and manually reviewed `benchmark/ground-truth.json` are required to reproduce this experiment. Preserve their exact bytes; changed inputs require a separate experiment directory. Do not commit student documents or raw model responses.

## Codex allowance

The user requested these runs through the signed-in Codex desktop runtime after declining additional API funding. The harness checks ChatGPT login, removes API-key environment variables, disables tools and runs each model in an ephemeral read-only directory. The app binary can be selected with `--binary=...`.

Run the first sweep, then the repeat sweep **sequentially**:

```bash
node --import tsx scripts/progress-paper-benchmark/codex.ts --run
node --import tsx scripts/progress-paper-benchmark/codex.ts --run --efforts=low,medium --repetitions=3
```

Completed identifiers are skipped. Do not run two writers against the same evidence directory. The first invocation covers 60 combinations; the second adds 48 low/medium repeats, giving 108 outcomes. `SIGTERM` stops dispatching new work and lets current calls finish. Each call has a 300-second capture limit. An older CLI's Astra compatibility errors are retained in a separate diagnostic directory and excluded from the app-runtime comparison.

PDF rendering may run alongside the model sweep. It makes no model calls:

```bash
node --import tsx scripts/progress-paper-benchmark/render.ts --codex --watch
```

Codex does not reproduce the website's Responses API environment. Its timing includes runtime startup, and its image handling, system instructions, output limit and transport behavior differ. Do not pool its outcomes or token counts with API trials, infer API invoices from Codex allowance, or use Codex times for website progress estimates.

## Offline analysis

These commands consume saved evidence only:

```bash
node --import tsx scripts/progress-paper-benchmark/verify-scoring.ts
node --import tsx scripts/progress-paper-benchmark/report.ts
node --import tsx scripts/progress-paper-benchmark/report.ts --images
node --import tsx scripts/progress-paper-benchmark/codex-report.ts
node --import tsx scripts/progress-paper-benchmark/evidence.ts
node --import tsx scripts/progress-paper-benchmark/dashboard.ts
```

`evidence.ts` writes aggregate JSON to the handbook; `dashboard.ts` produces a self-contained HTML comparison with local fonts, filters, CSV exports and an adjustable tutor-time scenario. The manually written analysis documents the recommendation and limitations.

`run.ts --run` makes paid Responses API calls. Those runs remain paused because the account has no API credit and the user declined a top-up. Do not resume them as part of offline analysis. `--prepare-only` verifies existing input fingerprints without requests. Rendering retries and `replay-layout.ts` reuse saved responses without another model call.

The scorer checks rendered mathematical blocks, selected wording, coverage, total and visible subpart marks, tables, source figures and private-key separation. It is a regression proxy, not a full semantic or educational quality assessment. Preserve raw responses and rescore all models consistently after evaluator corrections. Inspect finalist PDF pages separately; automated rasterization and bounds checks are not equivalent to a human visual review.

The final 13 September comparison contains 108 Codex outcomes: 95 complete responses rendered to 190 PDFs, 25 source-check failures and 13 capture timeouts. All final results include the manually verified Q24 subpart-mark checks; interim scores embedded in older render logs are not authoritative. Reports always rescore the original responses. Working-space suitability is a separate manual finding. The benchmark renderer historically added duplicate missing-mark warning text on some papers; warning-banner counts are not compared with production.
