---
quick_id: 260930-hfu
status: approved
source_plan: "One hardening follow-ups PR that closes the non-blocking findings of today's two reviews" — coordinator brief for the owner (Kevin), 2026-09-30 evening
base: main (`1096f33`, PRs #113 and #114 merged)
branch: fix/autowriter-hardening-followups
---

# Autowriter: hardening follow-ups to the judge tweaks (#113) and the rate-limit retries (#114)

Both PRs were reviewed independently today and merged. Their non-blocking findings are closed here, in one draft
PR, to be reviewed and merged before `FEEDBACK_AUTOWRITER_TRANSCRIPT_FIRST` is switched on (1 Oct morning).

## Hard rules
- Work only in `.claude/worktrees/slot-a`; Node 22; no `npm ci`, no build, no stash, no force push.
- No writes to Wise or to the production database, no Vercel env changes, none of the CLI's write modes.
- **No live OpenRouter or Soniox calls at all**: production shares the key and the writer's route is rate limited.
  Fakes only.
- No prompt text changes: `PROMPT_VERSION` and `JUDGE_PROMPT_VERSION` stay 5. No migration.
- Public repo: synthetic names only. Draft PR only, never marked ready, merged or set to auto-merge.

## Owner decisions that bind this PR
- 30 Sep 17:00: a run in which Sol's transcript draft is rejected by a judge and the Luna fallback then fails
  **counts** toward `writer_failed`. The code already does this; only the wording that says the count is "reset
  whenever the writer delivers a draft" is wrong. The count restarts when a run ends in a judge failure or with a
  stored draft.
- 30 Sep 14:00: judge failures never count toward `writer_failed`; they retry.
- A rate limit is never the writer's failure and never a reason for the fallback writer.

## Tasks
A. **A sweep under a lasting rate limit** (`job.ts`, `pipeline.ts`, `openrouter.ts`). Once a class of a sweep ends
   still rate limited, the rest of that sweep makes no in-run retries (a rate limit is returned at once, as before
   #114). The sweep starts the rows that call no model (a stored judged draft to post, a recording to wait for or
   submit to Soniox, a Soniox job to look at) before the rows that need the writer. Webhook runs keep their retries.
B. **A judge that keeps failing on one class** (`job.ts`, `store.ts`, `alerts.ts`, `config.ts`). The third
   judge-stage failure in a row on a class raises one `judge_failing` alert through the digest — once per episode,
   dropped when the judge answers or the class settles; the class keeps retrying. `listDueRows` sorts rows whose
   last reason starts with `infra:` after the rows that have not failed.
C. **`Retry-After`** (`openrouter.ts`). Never a retry before the time OpenRouter asked for: an asked wait that does
   not fit what is left of the call's waits ends the retries. Never less than the schedule's wait. Read on an HTTP
   429 whose body is not JSON. `X-RateLimit-Reset` only from the error's own header list. An empty or `0` HTTP
   `Retry-After` does not hide the one listed with the error.
D. **Call records** (`pipeline.ts`, `review-job.ts`, `quality.ts`). Each rate-limited attempt records when its
   request was sent and what was waited (`attemptAt`, `retryAfterMs`, `waitedMs`); "when we started writing" in the
   coverage figures reads that time before `created_at`.
E. **Robustness.** A reply that is JSON but not an object is `invalid_json_response` (`openrouter.ts`); the POST
   budget is checked before the three pre-POST Wise reads, with an end-to-end test of the deferred POST
   (`submit.ts`); a rejected draft counts once even when the writer's reply has no generation id (`pipeline.ts`,
   `dashboard.ts`); a judge level makes no second try and no further in-run retry once the other level has rejected
   the draft or stopped (`pipeline.ts`); the type parameter `Request` is renamed (`openrouter.ts`).
F. **Docs and comments.** The worst-case time arithmetic (`config.ts`, feature page); what `rateLimitRetry` rows
   count (runbook); the unused `AUTOWRITER_MODELS.judge.effort` removed; "versions are now 4" → "became 4"; the
   `writer_failed` wording of the owner decision above.
G. Rate-limit detection shapes: nothing beyond tests if a gap shows.

## Verify
`npm run typecheck`; `npx eslint src/lib/feedback-autowriter src/components/feedback-autowriter`;
`npx vitest run --project unit`; `npx vitest run --project integration src/lib/feedback-autowriter` (OrbStack);
`git diff --check`. Mutation check: each of A–E reverted in turn, a test fails every time.

## Then
Summary (`260930-hfu-SUMMARY.md`), push, draft PR against `main`, report back with the worst-case time budget and
every judgement call (B's alert semantics and A's ordering rule first).
