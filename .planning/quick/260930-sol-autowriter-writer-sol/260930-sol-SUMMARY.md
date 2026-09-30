---
quick_id: 260930-sol
status: complete
date: 2026-09-30
pr: 108
commit: 0c45345
---

# Autowriter writer → GPT-6.1 Sol (low), everyone

## What shipped
- **Writer:** `openai/gpt-6.1-sol` (reasoning `low`) on a new OpenAI zero-data-retention route (`zdr`, `data_collection: "deny"`, `require_parameters`). The route check matches the model id.
- **Fallback:** Luna moved to the same zero-retention route, and now also backs up transcript drafts.
- **Judge:** unchanged (GLM on Together, zero retention).
- **Arm `sol`:**
  - added to the types and schema;
  - migration `0100_feedback_autowriter_sol` (written as 0099; renumbered after Codex's #110 took 0099) widens both arm checks;
  - the dashboard labels it "GPT-6.1 Sol".
- **Evaluation CLI fix:** it no longer calls whatever the production writer is "GLM". It uses a per-arm writer table (`AUTOWRITER_WRITER_BY_ARM`).
- **Docs:** feature page (models, transcript step, costs), runbook §7 (deploy order, post-deploy query, rollback), DB reference.

## Evidence
- **Owner request:** "Switch the writer to Sol for everyone today" (30 Sep).
- **Blind comparison** (11 classes from 29 Sep; same Soniox transcripts, v4 rules, each draft checked against the transcript):

  | Writer | Drafts needing no real fix | Critical | Real errors per 100 claims |
  |---|---|---|---|
  | Sol-low | 82% | 0 | 0.9 |
  | Luna | 64% | — | 2.1 |
  | GLM | 30% | — | 4.1 |

- **Routing:** all 12 Sol calls returned exactly `openai/gpt-6.1-sol` via Azure. About $0.04 per draft; median about 6 s.

## Verification
- Typecheck and lint are clean.
- Unit: 484 files, 5,578 tests pass.
- Autowriter integration: 88 pass. A verified row stores arm `sol`; calls record `writer:sol` and `judge:glm`.
- Without the 0100 journal entry, the first integration test ends `infra`, which proves the migration must be applied first.

## Deploy
1. Apply 0100 to production (done 30 Sep, as 0099: prod ledger id 102, `when` 1790735838903).
2. Merge.
3. Confirm the first class shows `writer:sol` calls.

**#105:** it must renumber its migration to 0100.

**Rollback:** revert the PR. Keep 0100, since it's backward compatible.
