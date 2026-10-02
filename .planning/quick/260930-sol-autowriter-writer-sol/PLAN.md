---
quick_id: 260930-sol
status: complete
source: owner request 2026-09-30 ("Switch the writer to Sol for everyone today")
---

# Feedback autowriter: GPT-6.1 Sol writes for everyone

## Context
The autowriter has written with GLM 5.3 Flash (Together, zero data retention) since the 29 Sep pilot, with GPT-6 Luna
as the fallback on a non-ZDR OpenAI route. A blind comparison on 11 classes (same Soniox transcripts, v4 rules) found:

| Writer | Drafts needing no real fix | Critical errors | Real errors / 100 claims |
|---|---:|---:|---:|
| GPT-6.1 Sol, reasoning `low` | 82% | 0 | 0.9 |
| GPT-6 Luna | 64% | — | — |
| GLM 5.3 Flash (current) | 30% | — | 4.1 |

OpenRouter now serves Sol and Luna with zero data retention (via Azure; verified 30 Sep: 12/12 Sol calls in the
comparison came back as exactly `openai/gpt-6.1-sol`, provider `Azure`). Sol-low cost ≈ $0.04 per draft (mean of the
12 comparison drafts), ~6 s per call.

## Tasks
1. `config.ts`: an OpenAI ZDR route (`zdr`, `data_collection: deny`, `require_parameters`); writer = Sol-low on it
   (`expectModel` only — any ZDR host is acceptable); fallback = Luna-max on the same route; judge unchanged (GLM,
   Together ZDR); effort type accepts `low`; doc comments.
2. `pipeline.ts`: every writer is on a ZDR route, so transcripts also get `[writer, fallbackWriter]`; comments.
3. `types.ts` `ModelArm` + `schema.ts` arm `$type`s gain `sol`.
4. Migration `0100_feedback_autowriter_sol.sql` (written as 0099; renumbered after #110 took 0099) (hand-written, journal entry only, like 0098): both arm checks allow
   `sol`. Not applied here — Claude applies it after review.
5. Dashboard: label arm `sol` / model `openai/gpt-6.1-sol`.
6. Eval CLI (`run.ts`, script): arm → writer config by arm (GLM keeps its old writer config for evals), `sol` added
   to the eval generation and cost summary. A/B assignment (`ab.ts`) stays GLM/Luna.
7. Docs: feature page models section, runbook rollback note, DB reference.
8. Tests: writer request (Sol, `zdr`, `low`), transcript fallback to Luna, route check rejecting a non-Sol model,
   integration row with arm `sol` (0100 applied by Testcontainers).

## Out of scope
`submit.ts`, the POST path, `store.ts` claim/release; applying the migration; merging.
