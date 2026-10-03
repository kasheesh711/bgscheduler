# Automatic Class Capture verification

## Implemented and checked locally

- Separate default-off workflow flag, additive migration 0111, authenticated actions and minutely durable recovery.
- Real React UI with synthetic services: selected M4A and stopped recording produce drafts with no further processing clicks; autosave; approval/copy; 24 concurrent photo uploads; compact previews; failed-file retry; reload; preservation of edited feedback during proposals.
- Postgres integration tests: consent/flag gating, duplicate processing claims, recording/upload/debounce waits, 24 photos in pairs, edits during generation, stale evidence revisions, proposal acceptance conflicts, uncertain paid outcomes, known throttling, interrupted finalization, and deletion during generation.
- Unit checks: source/citation validation, unsupported fields, separate evidence/questions, image data URLs and ZDR route, mixed Thai/English speaker turns, endpoint access/CSRF checks, existing legacy behavior, and cron registration.
- Production build, TypeScript, scoped lint and production route-surface guard passed. The full unit run passed 608 of 609 suites; the remaining assertion was updated to require the new private-read abort signal, then its 30 tests passed. A subsequent focused run passed 505 tests across 16 suites. Original capture integration suites plus automatic jobs passed; the final automatic suite contains 12 passing tests.

## Measured photo transfer

The exact same batch of 24 synthetic 12MP textured worksheet photos was uploaded over Chromium's shared 10 Mbps uplink with 150ms emulated latency:

| Flow | Time |
| --- | ---: |
| Original JPEGs, sequential upload | 141.88 seconds |
| Browser resize/compression, three concurrent uploads | 17.02 seconds |
| Reduction | **88.0%** |

Each photo shrank from 7,139,955 bytes to 858,922 bytes. The copy is 1,920 × 2,560 pixels. Full-size visual inspection found the synthetic worksheet text legible. The measured optimized run includes serial browser image preparation and real HTTP requests to the local fixture. It excludes production Blob validation, network variability, and AI processing. This is not an actual iPhone timing result.

Reproduce with `node scripts/dev/verify-class-capture-automatic.mjs`. The JSON receipt records timings, metrics and limits.

## Activation remains gated

- No production migration, deployment or flag activation was performed for this workflow.
- A physical iPhone is unavailable in this environment. Its acceptance checklist remains in `docs/operations/class-capture.md`.
- The local environment files and the protected production environment export did not supply usable OpenRouter access to the evaluator. The explicit synthetic provider evaluation exited before any paid call. `scripts/dev/evaluate-class-capture-automatic.ts --live --env-file PATH` is ready for an environment with approved credentials. Actual model quality on the ambiguity/marked-work/blank-work fixtures, private Blob transport and live Soniox transcription remain unverified.
- OpenRouter's public model metadata confirms image input and structured output for the configured model. This is capability metadata, not proof that a private provider request succeeded.
- Rollback keeps the additive schema and retention infrastructure and disables only `CLASS_CAPTURE_AUTOMATIC_WORKFLOW`.
