---
quick_id: 260929-gvd
status: executed
source_plan: ~/.claude/plans/for-online-classes-i-inherited-moonbeam.md (approved 2026-09-29)
---

# Online-class AI feedback autowriter — Kevin pilot + GLM Flash vs GPT-6 Luna

## Context
Kevin wants post-class feedback for ONLINE classes written from Wise's AI class summaries and submitted to
Wise automatically. Pilot = only Wise teacher "Kevin (Kev) Y. Hsieh Online" (Wise user `696e2c4343579bbada2340ed`).
Institution-wide run waits; give a scale cost estimate.

User decisions (2026-09-29, chat):
1. Build, then submit Kevin's pending online feedback now (canary first). No content-review gate.
2. **Scope = only not-yet-due sessions** (class ended, feedback deadline not passed) → no late deductions, billing current.
3. **Fill Wise auto-blank submissions too**, re-sending the SAME sessionStatus/creditsConsumed they carry; no double charge.
   Human-written feedback is never touched.
4. Sessions with no submission: submit only when Wise attendance data + AI summary show the class ran with the
   student present; credits = Wise default for the class, cross-checked vs past submissions. Else left for Kevin.
5. A/B: half the sessions submitted from `~z-ai/glm-flash-latest`, half from `openai/gpt-6-luna`, both reasoning `max`,
   via OpenRouter. After: actual cost breakdown for both models.
6. Opus 5.5 in Claude Code grades both models on the deep-dive rubric
   (`~/Downloads/BeGifted-feedback-deep-dive-2026-09-29/grading/RUBRIC.md`: spec, evid, action, hw, personal, prof, overall 1–5 + placeholder/absence/lang).

## Key facts (checked against origin/main)
- **Read**: `fetchWiseSessionDetail` (src/lib/wise/fetchers.ts:393) = `GET /user/classes/{cid}/sessions/{sid}` with insight/config/submission
  flags. Wise Postman docs (collection 17903053/2sA3XPChyE): `showSessionFiles=true` adds "transcript, session summary etc."
  Nothing in repo reads summaries → field/format found in Phase 0.
- **Write**: `POST /teacher/classes/{cid}/session/{sid}/feedback`, example `{answers:[{answer}], sessionStatus:"COMPLETED", creditsConsumed:1}`
  (positional answers). No feedback write exists in repo; post-class-feedback (PCF) is read-only by design (docs/features/post-class-feedback.md:23,:144;
  workspace-contract.test.ts:35-47) → new code lives in its own domain, never in PCF or its UI.
- **Auto-blanks**: Wise auto-submits blank feedback under the teacher profile; only the activity event says `autoSubmitted`
  (post-class-feedback/events.ts, `post_class_feedback_event_links.auto_submitted`).
- **Timing**: PCF on-time proof = earliest non-auto `SessionFeedbackSubmittedEvent` ≤ deadline, role-blind (D-EVT-04).
  Deadline = 23:59:59.999 Bangkok, 2nd day after class end (`calculateFeedbackDeadline`). Unknowns → canary: stored `profile`
  must be `teacher`; an event must be emitted and not flagged auto.
- **Attribution**: one institute identity (Basic WISE_USER_ID:WISE_API_KEY) → PCF shows "Admin rescued" if actor is ADMIN;
  Progress Tests ignores versions not authored by the session teacher (progress-tests/workspace/data.ts:96). Accepted for pilot.
- **Billing**: payroll flags credits ≠ scheduled hours (payroll/data.ts `duration_mismatch`); `fetchSessionCredits`
  (credit-control/wise.ts:268-279) exposes `sessionCreditHistory` + available balance.
- **Content policy** (policy.ts): 3 required fields ≥300 code points combined, `assessFeedbackContent` → require `compliant` AND zero
  failedFields; `isPlaceholderFeedback`; `postClassDeductionExemption` (deduction-exemption.ts:64) must return null (absence/cancel
  wording would exempt the class); `assessAiSuspect` (similarity.ts:108) flags 300–349 chars, fields <50, ≥0.85 similarity to last 90 days.
- **Wise client**: `post()` retries 408/429/5xx and parses JSON (client.ts:138,:201) → writes use a per-session
  `new WiseClient({... maxRetries:0, maxConcurrency:1, requestsPerSecond:1, stopOnRateLimit:true, beforeRequest: killSwitch})`
  like `nativeWise` (progress-tests/workspace/wise-publication.ts:41); any throw after send = UNKNOWN outcome → GET-reconcile, never re-POST.
- **Local checkout** is on `codex/outlook-calendar`, dirty, 18 commits behind origin/main → build elsewhere.

## Design
Worktree `/Users/kevinhsieh/Developer/Scheduling-feedback-autowriter`, branch `feat/online-feedback-autowriter` from fresh
`origin/main`; run under `/gsd-quick` (CLAUDE.md); implement via executor, separate reviewer pass (Wise write + billing path).
Copy `.env.local` (0600) and add `OPENROUTER_API_KEY` there only. No commit/push unless Kevin asks (then draft PR).

`src/lib/feedback-autowriter/` (all logic + tests here; CLI stays thin because `scripts/**` is outside vitest):
- `session.ts` — detail GET (+`showSessionFiles`), `extractAiSummary`, `classifySubmissions` (none | auto-blank | human | other-profile),
  attendance from participant/insight durations, identity checks. Parses form with `parseWisePostClassSession` +
  `mapAnswersToFields` / `hashFeedbackAnswers` (post-class-feedback/wise.ts:382,:239,:256) using the active `post_class_field_mappings`;
  requires mapping ready with no unmapped/ambiguous questions. Path ids checked against a Mongo-objectId regex.
- `select.ts` — DB shortlist from `post_class_sessions`: teacher id = allowlist, `final_status='ENDED'`, `scheduled_end_at < now()`,
  `deadline_at > now() + 30 min`, `wise_deleted_at IS NULL`, eligibility reason not cancelled/missed/trial/excluded. Does NOT trust
  `latest_feedback_version_id`/`content_status` for "no submission" — the live gate decides.
- Gates (fail closed → "left for Kevin" + reason): live teacher id = allowlist; ONE_TO_ONE; exactly one student; type SCHEDULED;
  meeting ENDED; submissions ∈ {none, auto-blank (event autoSubmitted=true, all answers blank)}; any human or non-teacher submission → skip;
  summary present; student joined ≥50% of scheduled time.
- `billing.ts` — auto-blank: reuse its own sessionStatus/credits. None: credits = scheduled hours AND = modal credits of ≥2 prior
  submissions for the same class + duration (live GETs), sessionStatus = modal value of Kevin's prior human submissions,
  session absent from `sessionCreditHistory`, available balance ≥ credits. Any disagreement → skip.
- `prompt.ts` — shared prompt for both models: summary redacted with `redactKnownNames` + nickname tokens from a copied
  `parseStudentDisplay` (its bracketed nickname otherwise leaks); placeholders `[STUDENT_1]`/`[TUTOR]` restored locally. Rules:
  facts only from summary; no attendance/cancel wording; concrete next steps; homework only as stated (or "No homework set" if
  summary says so); each required field ≥80 chars, combined 450–900. Strict JSON schema output
  `{topics, performance, improvement, homework, studentAttended, lessonHappened}`.
- `openrouter.ts` — `POST https://openrouter.ai/api/v1/chat/completions`, `response_format` json_schema strict,
  `reasoning:{effort:"max"}`, `max_tokens` 32000 (same both arms), 240 s timeout, no retries; `provider:{order:[pinned],
  allow_fallbacks:false, data_collection:"deny", require_parameters:true}` (+`zdr:true` if available for both). GLM pinned to
  Z.AI first-party unless it fails `deny` in Phase 0 (then one fixed fp8 host at the same $0.15/$0.50); Luna pinned to OpenAI.
  Returns content, resolved model/provider, `usage` (prompt/completion/reasoning/cached tokens, `cost`), latency, finish_reason.
- `validate.ts` — Zod, policy checks above on the restored text, suspect check vs Kevin's last 90 days + the other drafts,
  `studentAttended && lessonHappened`, no leftover placeholder tokens, `finish_reason==="stop"`, reasoning_tokens > 0.
- `submit.ts` — per session: claim `.feedback-autowriter/ledger/<sessionId>.json` via `writeJsonArtifactExclusive` (create-once; an
  existing claim → GET-reconcile only) → fresh GET, re-run gates, abort on any change → POST (answers in form order with
  `questionId`) → GET verify: exactly one teacher submission, `hashFeedbackAnswers` matches, status/credits as intended,
  meeting still ENDED; credits history moved by exactly the intended amount (0 for auto-blank). Mismatch → stop whole run.
- `ab.ts` — deterministic assignment: sort by (classId, start), alternate within class from a seeded first arm.
- `run.ts` — orchestration + artifacts under `.feedback-autowriter/<ISO>/` (add to .gitignore; 0600).
CLI `scripts/autowrite-online-feedback.ts` (`npx tsx --tsconfig scripts/tsconfig.json …`, env via `loadPayoutScriptEnvironment()`):
`--probe`, `--generate`, `--submit --session <id>`, `--submit --all`, `--eval-set`; dry-run default; allowlist hard-coded to Kevin Online.
Also: `.env.example` gains blank `OPENROUTER_API_KEY`; docs/reference/wise-api.md write table gets the feedback POST.

Tests `src/lib/feedback-autowriter/__tests__/`: gates (each skip reason), submission classification, billing (agree/disagree/
auto-blank reuse/balance), redaction incl. nickname + restore, validator (policy, exemption wording, suspect band, placeholders),
OpenRouter parsing (usage/cost, length truncation, non-200, zero reasoning), submit (existing human submission → no POST;
no-retry client; ledger claim idempotency; unknown-outcome path never re-POSTs; verify mismatch stops run), A/B determinism.

## A/B + grading design
- **Paired generation**: both models draft EVERY candidate session (same prompt, limits, providers pinned); only the pre-assigned
  arm's draft is submitted (half/half as asked). Cost and quality compare on identical inputs.
- **Eval-only set** (never submitted): up to 20 of Kevin's most recent online sessions that already have his human feedback →
  both models draft from the summary → paired with Kevin's real feedback as the human baseline. Makes the comparison meaningful
  when only a handful of sessions are not-yet-due.
- **Hold rule (fixed before grading)**: a to-be-submitted draft is held (left for Kevin) if Opus marks `faithful:false`,
  `placeholder:true` or `absence:true`. Held drafts count as that model's failures.
- **Opus 5.5 grading**: Claude Code subagents (model `opus`) grade a cleaned export in the session scratchpad (no model/provider
  names, shuffled opaque ids; arm map kept elsewhere). Exact RUBRIC.md keys, plus `faithful` for AI drafts only (unfaithful caps
  spec/evid/personal at 2), plus a per-session blind preference rank. Human baseline interleaved in the same batches. ~20% of
  items re-graded for consistency.
- Primary metric: mean `overall`; secondary: per-dimension means, faithful rate, validator pass rate; cost per ACCEPTED draft
  (includes failed calls), latency p50/p90.

## Execution sequence
0. **Probe (read-only)**: ~10 Wise GETs on 3 Kevin online sessions + Wise events for them; 2 synthetic OpenRouter calls (no student
   data) to confirm providers, `deny`/ZDR routing, `max` effort + json_schema on both models. Record summary field/format/size,
   form question ids (`_id` vs `questionId`), prior submission status/credits/profile, participant durations, auto-blank presence.
   STOP + ask Kevin if summaries are not exposed to the vendor API.
1. Build + `npx vitest run --project unit src/lib/feedback-autowriter` + `npm run typecheck` + `npm run lint`.
2. `--generate` on not-yet-due candidates + `--eval-set` → validator → usage/cost logged.
3. Opus blind grading → apply hold rule.
4. **Canary A** (no-submission session, latest deadline): POST → verify submission/profile/hash/status/credits/credit history →
   `GET /institutes/{id}/events` shows `SessionFeedbackSubmittedEvent` with `autoSubmitted` not true (+ actor/role recorded).
   **Canary B** (an auto-blank session, if any): same + credit history unchanged (no double charge) and not a duplicate submission.
   Any failure → STOP, report; Kevin re-saves in Wise UI before its deadline.
5. Submit remaining passing drafts sequentially (1 req/s, fresh GET-before-POST each).
6. Poll PCF (feedback-event / recheck lanes are not guaranteed next tick) for up to ~1 h: versions ingested as `teacher`,
   compliant, timing on_time. Report any stragglers.
7. Report to Kevin (below).

## Cost (OpenRouter public pricing, 2026-09-29)
| | `~z-ai/glm-flash-latest` | `openai/gpt-6-luna` |
|---|---|---|
| Resolves to | `z-ai/glm-5.3-flash` (moving alias; log per call) | fixed |
| $/1M input / output | 0.15 / 0.50 (Z.AI; hosts range 0.03–0.30 / 0.50–1.00) | 0.10 / 0.50 (OpenAI; flex 0.05/0.25) |
| Reasoning | mandatory, default max | optional, default medium; max used |
Reasoning bills as output; no OpenRouter markup; 5.5% card fee on top-ups.
Pre-run estimate per session: ~2.5k in + ~5k reasoning + ~0.3k visible ≈ **$0.003 either model** (range $0.0015–0.006).
Pilot (candidates + eval set, both models, probes) ≈ $0.20 (worst ~$0.60).
Institution scale: ~700–1,000 online sessions/month (≈29% online share per student-schedule/data.ts note; exact count computed
read-only during the run) → **≈ $2–3/month per model at max effort** (worst ~$6), ~$25–40/yr. Wise: +~3 GETs + 1 POST per
session — negligible vs ~170k calls/day today. Final report replaces estimates with measured $/accepted draft.

Report to Kevin: per model — generated / validator-failed / held / submitted, tokens (prompt, reasoning, visible; mean + p90),
measured $/session and $/accepted draft, latency; Opus rubric means per dimension + overall + faithful rate vs Kevin's own
baseline; head-to-head preference; scale projection; scale-up blockers (PCF "never generates feedback" stance, "Admin rescued"
attribution, Progress Tests context loss, parent-visible AI text in Parent Report, per-tutor opt-in, scheduler for recurring runs).

## Security
- The OpenRouter key was pasted into chat → treat as exposed: `.env.local` only, set a credit limit on it (e.g. $5), rotate after pilot.
- Untracked `.playwright-mcp/wise-trends-request-headers.txt` holds a live Wise bearer token + API key → delete/rotate.
- Student data to third-party model hosts: redacted names, `data_collection:"deny"` (+ZDR when available).
- Auto-mode classifier blocked prod DB reads during planning; the run needs approval for prod DB reads, Wise GET/POST, OpenRouter calls.

## Verification
- Unit tests + typecheck + lint green in the worktree; reviewer pass on submit/billing code.
- Probe + canary evidence (pre/post GETs, event rows, credit history) saved as artifacts.
- After the run: every submitted session has exactly one teacher submission in Wise matching its ledger hash; zero human-written
  submissions touched; credit history deltas = intended; PCF shows on-time compliant versions.
