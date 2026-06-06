# Phase 11: IDENT-01 Webhook-Side LINE Identity Resolution — Specification

**Created:** 2026-06-06
**Ambiguity score:** 0.12 (gate: ≤ 0.20)
**Requirements:** 6 locked

## Goal

Link the parents who actually message the LINE OA (identified by the Messaging-API webhook `source.userId`) to Wise students, so downstream scheduling automation has trustworthy identity. Target: ≥80% of *active messaging contacts* (those who have sent a scheduling-classified message) have a verified or parent-confirmed student link after a verification pass, and every new scheduling message yields a student-link suggestion or routes to human verification (fail-closed).

## Background

Confirmed against production (2026-06-06) and LINE's official docs:

- LINE user IDs are **provider-scoped**. The OA-resolver browser extension scraped IDs from the LINE OA Manager chat surface (`chat.line.biz/...`, parsed by `parseLineOaChatUrl`, `src/lib/line/oa-resolver.ts:344`); `commitLineOaResolverRun` created **phantom `line_contacts`** keyed by those IDs. They are in a *different namespace* than the webhook `source.userId` (`recordLineWebhookPayload`, `src/lib/line/data.ts:419`), and no LINE API cross-walks them (`getProfile` rejects foreign IDs).
- Production evidence: **518 resolver IDs vs 252 messaging IDs → 0 overlap**; 0 of 518 resolver IDs ever messaged; of 520 verified-link contacts only 3 have a real conversation; of 252 real messaging parents, **248 have no link**. All 804 reviews are `pending_review`; every change-request has `writeback_status=not_applicable`. The ~520 verifications are **not programmatically salvageable** (phantom contacts carry no usable name; resolver `chat_title` is a single constant).
- The signal for the fix is strong: all 252 messaging contacts have profiles, avg ~8 inbound messages, and 805 scheduling-classified messages (488 request + 317 change) where parents name their child. The classifier / AI scheduler already extracts `studentName`/`parentName` into `extractedState` (`src/lib/ai/scheduler-conversation.ts`) and review `intentPayload`.
- The LINE OA is **verified/premium**, so `GET /v2/bot/followers/ids` is available to bulk-enumerate correct-namespace user IDs.
- The current matcher `ensureLineContactStudentLinkSuggestions` (`src/lib/line/student-links.ts:450`) only parses dotted enrollment codes from a contact's display name → produces ~1 suggestion across 252 real contacts.

This phase rebuilds identity **from the webhook side**. It is the foundation of the v1.2 Autonomous LINE Scheduling milestone — the same identity layer autonomy needs.

## Requirements

1. **IDENT-01 Content-based link suggestions**: Suggest student links on real messaging contacts from the names the AI already extracts from message text.
   - Current: `ensureLineContactStudentLinkSuggestions` matches only dotted enrollment codes in `displayName`/`linkedStudentLabel`; yields ~1 suggestion / 252 messaging contacts.
   - Target: a name-based matcher compares AI-extracted `studentName`/`parentName` (from the classifier/scheduler extraction) against the student directory (`listCurrentLineStudents`, `student-links.ts:182`) and creates `suggested` links (evidence `source:"message_content"`, with a confidence score) on the messaging contact. Wired into `processLineMessageForScheduler` (`src/lib/line/review-service.ts`).
   - Acceptance: on a labeled eval set of real Thai/English scheduling messages, the matcher emits the correct `studentKey` as a suggestion for a measured recall; **no `verified` link is ever created by this path**.

2. **IDENT-02 Fail-closed verification (no content auto-verify)**: A link becomes `verified` only via admin verification (parent self-confirm is deferred to a later phase).
   - Current: links reach `verified` via `patchLineLinkValidationTaskStatus` (admin) on OA-resolver-sourced rows; content path doesn't exist.
   - Target: content matches are `status:"suggested"` only. The sole writer of `status:"verified"` is the admin verify action. Unresolved or ambiguous identity (no match, or multiple plausible students) leaves the contact unlinked and routes its scheduling reviews to Needs Review — never auto-proceed.
   - Acceptance: code + tests confirm no path sets `status="verified"` from content matching; a contact with only `suggested` links is treated as unverified by `listVerifiedLineStudentKeys` and the `approveLineSchedulerReview` gate.

3. **IDENT-03 followers/ids re-anchor (one-time bulk)**: Seed correct-namespace contacts from the OA's real followers.
   - Current: no `followers/ids` fetcher; contacts are created only from webhooks (real) and OA-resolver commits (phantom).
   - Target: a one-time job calls `GET /v2/bot/followers/ids` (OA is verified/premium) + `getProfile`, upserting `line_contacts` keyed by the correct Messaging-API `userId` (same namespace as webhooks), then runs the IDENT-01 matcher to produce suggestions.
   - Acceptance: running the job creates/updates correct-namespace contacts; it is idempotent (re-run creates no duplicate contacts); the count of correct-namespace contacts measurably increases and overlaps the messaging-contact namespace.

4. **IDENT-04 Re-point Mapping Validation UI**: Admins verify the new real-contact suggestions, not phantom resolver rows.
   - Current: link-validation (`patchLineLinkValidationTaskStatus`, `src/lib/line/link-validation.ts`) is scoped to `lineOaResolverSourceCondition()`; the worklist shows OA-resolver runs.
   - Target: the Mapping Validation worklist surfaces `suggested` links on real (messaging/follower) contacts and lets admins verify them through the existing UI.
   - Acceptance: a `suggested` link created from message content on a real contact appears in the validation worklist and can be verified; after verifying, the contact's review badge shows "Verified student."

5. **IDENT-05 Quarantine phantom contacts/links**: Exclude the ~520 wrong-namespace records from counts, queues, and actions without deleting.
   - Current: ~520 verified links on phantom contacts inflate "verified" counts and pollute the validation tracker/summaries.
   - Target: phantom contacts/links (resolver-sourced, wrong namespace / no thread) are flagged and excluded from validation worklists, verified-count summaries, and action-readiness checks. Data is retained (reversible; preserves the audit trail).
   - Acceptance: post-change, validation summaries and verified-count metrics exclude phantom records and a query confirms they're flagged and no longer surface in the worklist; zero rows are deleted.

6. **IDENT-06 Review re-link refresh**: When a contact gains a verified link, its pending reviews reflect it.
   - Current: `review.matchedStudentKeys`/`verifiedStudentKeys` are snapshotted at review creation (`review-service.ts:220`) and never recomputed; the queue badge reads the stale snapshot (`studentLinkVisibilityForReview`, `src/components/line-review/utils.ts:124`).
   - Target: on link verify, the contact's pending reviews recompute (reuse `buildLineOperationalReviewPlan` + the `operational-plan` route path) and the queue badge reads live link state.
   - Acceptance: verifying a link for a contact with a pending review flips that review's badge to "Verified student" and populates `matched_student_keys`/`writeback_status` without a manual recompute click.

## Boundaries

**In scope:**
- Name-based content matcher (studentName/parentName → student directory) producing `suggested` links on messaging contacts
- One-time `GET /v2/bot/followers/ids` + `getProfile` re-anchor job (idempotent)
- Re-pointed Mapping Validation UI verifying real-contact suggestions
- Quarantine (flag + exclude) of the ~520 phantom OA-resolver contacts/links
- Review re-link refresh on verify (the minor stale-snapshot fix)
- A labeled eval set measuring matcher precision/recall

**Out of scope:**
- **Conversational self-identify** (AI asks "which student is this for?") — deferred to a later phase; it touches the outbound-reply path which is its own concern
- **Any Wise mutation / writeback** (cancel/reschedule/book) — later milestone phases
- **Autonomous reply / auto-send** to parents — later autonomy-ladder phases
- **Deleting** phantom data — quarantine only, pending owner sign-off
- **Changing the classifier / AI extraction itself** — reuse the existing extracted names
- **Deprecating/removing the OA-resolver extension code** — quarantine its output here; formal removal is a separate cleanup

## Constraints

- Stack locked: Next.js 16 / Drizzle / Neon Postgres; no stack changes.
- **Fail-closed (non-negotiable):** unresolved/ambiguous identity → Needs Review, never auto-verify or auto-proceed. Wrong-student is the highest-severity error.
- Wise remains the source of truth; the student directory is sourced from the existing credit-control snapshot (`listCurrentLineStudents`).
- All existing tests must continue to pass (regression gate); new unit tests added for the matcher and the re-link refresh.
- LINE OA is verified/premium (enables `followers/ids`); respect LINE rate limits / pagination (`next` cursor) in the re-anchor job.
- No new outbound LINE messages are sent in this phase (self-identify deferred).

## Acceptance Criteria

- [ ] A name-based matcher creates `suggested` links from AI-extracted `studentName`/`parentName` on real messaging contacts (verified by unit test + a run over recent messages).
- [ ] No code path creates `status="verified"` from content matching alone — only the admin verify action (verified by code review + test).
- [ ] A contact with only `suggested` links is treated as unverified by `listVerifiedLineStudentKeys` and the review approval gate.
- [ ] The `followers/ids` re-anchor job runs, is idempotent (re-run adds no duplicate contacts), and creates correct-namespace contacts overlapping the messaging namespace.
- [ ] The Mapping Validation UI surfaces and verifies suggestions on real contacts (not just OA-resolver rows).
- [ ] The ~520 phantom contacts/links are flagged and excluded from validation worklists and verified-count summaries; zero rows deleted.
- [ ] Verifying a link refreshes the contact's pending review badge + plan without a manual recompute.
- [ ] An eval set measures matcher precision/recall; results are recorded and a precision bar is set before the suggestions are relied upon.
- [ ] Coverage (operational target): after a verification pass through the re-pointed UI, ≥80% of active messaging contacts have a verified link.
- [ ] `npm test` — all existing suites pass; new unit tests for the matcher + re-link refresh added.

## Ambiguity Report

| Dimension          | Score | Min  | Status | Notes                                                        |
|--------------------|-------|------|--------|--------------------------------------------------------------|
| Goal Clarity       | 0.90  | 0.75 | ✓      | Specific outcome + ≥80% coverage metric                      |
| Boundary Clarity   | 0.92  | 0.70 | ✓      | Self-identify, Wise writes, auto-send explicitly out         |
| Constraint Clarity | 0.85  | 0.65 | ✓      | Fail-closed, verified/premium, tests-pass, no outbound msgs  |
| Acceptance Criteria| 0.85  | 0.70 | ✓      | 10 pass/fail criteria incl. eval gate                        |
| **Ambiguity**      | 0.12  | ≤0.20| ✓      |                                                              |

Status: ✓ = met minimum

## Interview Log

| Round | Perspective | Question summary | Decision locked |
|-------|-------------|------------------|-----------------|
| Investigation | Researcher | What links contacts→students today; why does Mapping Validation show 0 verified? | Confirmed provider-namespace mismatch via prod DB (0/518 overlap) + LINE docs; OA-resolver path is wrong architecture |
| 1 | Failure Analyst | How should a link become "verified" given wrong-student risk? | Parent-confirm or admin-verify only; never auto-verify from content (fail-closed) |
| 1 | Boundary Keeper | Which linking mechanisms are in this phase? | Content suggestions + followers/ids re-anchor + re-point UI; **self-identify deferred** |
| 1 | Boundary Keeper | What happens to the ~520 phantom contacts? | Quarantine (flag + exclude), keep data; no delete |
| 1 | Simplifier | What's the measurable definition of done? | ≥80% of active messaging contacts verified/confirmed; every new scheduling msg → suggestion or human verification |

---

*Phase: 11-ident-01-webhook-side-line-identity-resolution*
*Spec created: 2026-06-06*
*Next step: /gsd-discuss-phase 11 — implementation decisions (matcher algorithm + precision threshold, followers/ids job design, quarantine flag mechanism, re-pointed UI scope)*
