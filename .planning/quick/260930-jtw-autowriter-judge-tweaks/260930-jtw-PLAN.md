---
quick_id: 260930-jtw
status: approved
source_plan: "Four owner decisions from the 30 Sep 14:00 interview" — approved by the owner (Kevin), 2026-09-30
base: feat/autowriter-transcript-first (PR #109, `20ba88e`)
branch: feat/autowriter-judge-tweaks
---

# Autowriter: both judge levels, a longer transcript judge, writer-only `writer_failed`, no other names

Follow-up to PR #109, to merge before `FEEDBACK_AUTOWRITER_TRANSCRIPT_FIRST` is switched on (1 Oct morning).

## Hard rules
- Work only in `.claude/worktrees/slot-b`; Node 22; no `npm ci`, no build, no stash, no force push.
- No writes to Wise or to the production database, no Vercel env changes. The CLI's write modes (`--sweep`,
  `--process`, `--mode`, `--resume`, `--retry`, `--tutor-on/off`) are never run; the read-only `--replay` is allowed
  (≤ 3 classes, ≤ $1).
- Public repo: synthetic names only, no lesson text in commits, the PR or docs. Draft PR only.

## Owner decisions
1. **Both judge levels must pass.** The judge (GLM on Together, v4 prompt) runs at `medium` and `high`, in parallel, on
   byte-identical messages, for every draft (summary and transcript). A draft passes only if both return a complete v4
   verdict with `faithful: true`. Problems = the union of both verdicts, deduped, in `judgeProblems` order. A parse
   failure or time-out at either level is a judge failure handled exactly like today's (one more try, then the class
   retries later). Both calls are recorded with their effort. Stored verdicts record both levels; every draft-reuse
   path (`reusableTranscriptDraft`, the requeue SQL) reuses only a draft judged at both levels — a single-judge draft
   is written and judged again, never posted on its old verdict. `JUDGE_PROMPT_VERSION` 4 → 5; old stored verdicts
   stay displayable.
2. **Longer judge time-out on transcripts.** 240 s for transcript evidence, 120 s for summaries; a judge is never
   started without its full time-out; the time budget is checked end to end (deadline − 45 s, `maxDuration` 800, the
   740 s dispatch budget, the 560 s floor, writer ≤ 180 s, both judges in parallel) and the worst case stated.
3. **Writer failures only.** `writer_failed` (transcript first) counts only the writer's own model failures; judge
   failures just retry. Label "Writer failed 3 times on the transcript — from summary"; tests and docs.
4. **Never name other people (prompt only).** Summary writer: a rule that the feedback names no one but
   `[STUDENT_1]` — others are "another student", "a classmate", "a family member". Transcript rule 13 made to cover
   other people too, minimally. `PROMPT_VERSION` 4 → 5; exact-text prompt tests pinned; no validator gate. The rule
   is absolute (no exception for authors or characters in lesson material — coordinator, 30 Sep).

## Tasks
1. `config.ts`: `AUTOWRITER_JUDGE_EFFORTS`, `AUTOWRITER_WRITER_TIMEOUT_MS`, `AUTOWRITER_JUDGE_TIMEOUT_MS`,
   `AUTOWRITER_CALL_DEADLINE_MARGIN_MS`; budget comment on `AUTOWRITER_SWEEP_MIN_REMAINING_MS`.
2. `judge.ts`: v5, `StoredJudgeVerdictSchema`, `combineJudgeVerdicts`, `passingStoredVerdict`.
3. `pipeline.ts`: two levels in parallel, per-level retry, judge time-out by evidence, no judge without its full
   time-out, `stage` on infra results, effort (and the judged writer generation) in the call records.
4. `job.ts` / `store.ts`: reuse only v5 two-level drafts; count only writer failures (a writer that delivered starts
   the count again).
5. `prompt.ts`: v5 rules. `dashboard.ts`: label, rejected drafts counted once. `replay.ts`: the pipeline's two levels
   instead of a medium re-run; posted drafts judged at both; writer-only `writer_failed`.
6. Tests (unit + Testcontainers), mutation checks per decision, docs (feature page, runbook, env reference).
7. Read-only replay on ≤ 3 classes from the last 24 h: both levels run, latency, verdicts.
8. Summary, commit, push, draft PR (base `main` if #109 has merged — merge `origin/main` first — otherwise #109's branch).
