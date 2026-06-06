# Phase 11: IDENT-01 Webhook-Side LINE Identity Resolution - Context

**Gathered:** 2026-06-06
**Status:** Ready for planning

<domain>
## Phase Boundary

Link the parents who actually message the LINE OA (identified by the Messaging-API webhook `source.userId`) to Wise students, so downstream scheduling automation has trustworthy identity. Delivered via: content-based link suggestions from AI-extracted names, a `followers/ids` re-anchor, a re-pointed verification UI, and quarantine of the wrong-namespace OA-resolver phantoms. Conversational self-identify, any Wise mutation, and autonomous replies are explicitly out of scope (later phases).

</domain>

<spec_lock>
## Requirements (locked via SPEC.md)

**6 requirements are locked.** See `11-SPEC.md` for full requirements, boundaries, and acceptance criteria. Downstream agents MUST read `11-SPEC.md` before planning or implementing — requirements are not duplicated here.

**In scope (from SPEC.md):**
- Name-based content matcher (studentName/parentName → student directory) producing `suggested` links on messaging contacts
- One-time `GET /v2/bot/followers/ids` + `getProfile` re-anchor (idempotent)
- Re-pointed Mapping Validation UI verifying real-contact suggestions
- Quarantine (flag + exclude) of the ~520 phantom OA-resolver contacts/links
- Review re-link refresh on verify (the minor stale-snapshot fix)
- A labeled eval set measuring matcher precision/recall

**Out of scope (from SPEC.md):**
- Conversational self-identify (deferred — touches outbound-reply path)
- Any Wise mutation / writeback (cancel/reschedule/book)
- Autonomous reply / auto-send to parents
- Deleting phantom data (quarantine only)
- Changing the classifier / AI extraction itself (reuse existing extracted names)
- Deprecating/removing the OA-resolver extension code (quarantine its output only)

</spec_lock>

<decisions>
## Implementation Decisions

### Match presentation (tiered)
- **D-01:** Tiered match handling. A **confident single** directory match → one `suggested` link on the contact. **Multiple plausible** matches (siblings, common names) → a **ranked shortlist** surfaced to the admin to pick from (still `suggested`, never auto-chosen). **No/weak** match → contact stays unlinked and its scheduling reviews route to **Needs Review**. Reinforces SPEC IDENT-02: no path auto-verifies; a human (or, in a later phase, the parent) always confirms.

### followers/ids re-anchor
- **D-02:** Re-anchor runs as an **admin-triggered, re-runnable button** in the LINE admin UI (e.g. on the Mapping Validation workspace), not a one-off script or cron. Must be **idempotent** (re-run creates no duplicate contacts) and produce only `suggested` links via the same matcher (D-01). Pulls `GET /v2/bot/followers/ids` (OA is verified/premium) + `getProfile`, upserting correct-namespace `line_contacts`.

### Phantom quarantine
- **D-03:** Quarantine = **hidden from active views** (validation worklist, verified-count summaries, action-readiness checks) but **visible behind a labeled 'legacy / needs re-match' archive filter**. Reversible — implemented as a flag/exclusion, **never a delete** (preserves the audit trail).

### Mapping Validation UI re-point
- **D-04:** **Minimal** change — widen the existing link-validation worklist to surface `suggested` links on real messaging/follower contacts (drop the `lineOaResolverSourceCondition()` OA-resolver-only scope), reusing the current verify flow and UI. A dedicated 'verify messaging contacts' surface is deferred unless volume warrants it.

### Claude's Discretion (builder/researcher decisions)
- **Name-matching algorithm internals** — normalization (incl. Thai), fuzzy/token strategy, confidence scoring, candidate dedup. Constrained by the tiered posture (D-01) and fail-closed. Researcher to investigate options.
- **Confidence thresholds** — single-suggest vs shortlist vs drop — calibrated against the eval set; precision-first (wrong-student is the worst error).
- **Quarantine flag mechanism** — new column vs derived predicate (e.g. `sourceKind = 'line_oa_resolver'` AND no thread) — schema/impl detail; must support the archive filter (D-03).
- **Re-link recompute trigger** — inline-on-verify vs lightweight backfill — plus the queue-badge live-read change (`studentLinkVisibilityForReview`, `utils.ts:124`).
- **followers/ids pagination + rate-limit handling**, `getProfile` batching.
- **Eval set construction** — sample of real Thai/English scheduling messages with ground-truth `studentKey`; precision/recall measurement; integrate with the existing AI-scheduler eval-harness pattern.

</decisions>

<canonical_refs>
## Canonical References

**Downstream agents MUST read these before planning or implementing.**

### Phase requirements (read first)
- `.planning/phases/11-ident-01-webhook-side-line-identity-resolution/11-SPEC.md` — Locked requirements (IDENT-01..06), boundaries, acceptance criteria. MUST read before planning.

### LINE feature + identity model
- `docs/features/line-integration.md` — Contact resolution, student-link lifecycle (suggested/verified/rejected), OA-resolver flow, review service, classifier, write-path dry-run status.
- `docs/reference/api/index.md` — LINE route inventory (webhook, contacts, student-links, link-validation, OA-resolver) — for where the new re-anchor route + widened verify flow fit.

### Conventions / architecture (project-wide, non-negotiable)
- `.planning/codebase/CONVENTIONS.md` — Naming, error-handling 4-step route pattern, fail-closed rules, Zod-everywhere, named-exports.
- `.planning/codebase/ARCHITECTURE.md` — Snapshot/index spine, fail-closed at the data boundary, single-flight discipline for syncs.
- `.planning/codebase/STACK.md` — Locked stack (Next.js 16, Drizzle, Neon), OpenAI Responses API usage.

### Milestone context (external to repo — reference only)
- `~/.claude/plans/start-a-workflow-to-misty-valiant.md` — The v1.2 Autonomous LINE Scheduling roadmap (autonomy ladder); this phase is its identity foundation. Lives outside the repo; not required reading for planning but explains the why.

</canonical_refs>

<code_context>
## Existing Code Insights

### Reusable Assets
- `ensureLineContactStudentLinkSuggestions` + `resolveLineStudentCodeMatches` / `matchParsedCodeForStudent` (`src/lib/line/student-links.ts:315-490`) — current code-only matcher; **extend** with the name-based matcher (D-01). Today it returns ~nothing for real parents (no dotted codes in display names).
- `listCurrentLineStudents` / `LineStudentDirectoryRow` (`src/lib/line/student-links.ts:182-252`) — the student directory (studentKey, studentName, parentName, activated/has-future/has-package) to match against.
- `studentLinkEvidence` (`src/lib/line/student-links.ts:418`) — evidence builder; add `source:"message_content"` and `source:"line_followers"`.
- `extractSchedulerStateWithOpenAi` + `SchedulerExtractedState.studentName/parentName` (`src/lib/ai/scheduler-conversation.ts`) — the names to feed the matcher are already extracted here; also surfaced in review `intentPayload` / classifier output.
- `patchLineLinkValidationTaskStatus`, `listLineLinkValidationTasks`, `lineOaResolverSourceCondition` (`src/lib/line/link-validation.ts`) — the verify flow + the scope predicate to **widen** (D-04) and to drive the quarantine filter (D-03).
- `buildLineOperationalReviewPlan` (`src/lib/line/operational.ts:584`) + `patchLineSchedulerOperationalState` (`src/lib/line/data.ts:876`) + the `operational-plan` route (`src/app/api/line/scheduler-reviews/[reviewId]/operational-plan/route.ts`) — reuse for the re-link recompute-on-verify.
- `studentLinkVisibilityForReview` (`src/components/line-review/utils.ts:124`) — queue badge; switch the non-selected branch to live link state.
- LINE client (`src/lib/line/client.ts`) — `fetchLineProfile` (getProfile), `pushLineTextMessage`; **add** a `followers/ids` fetcher here.

### Established Patterns
- Suggestion → human-verify lifecycle on `line_contact_student_links` (status `suggested`/`verified`/`rejected`) — the spine to reuse; just change WHAT produces suggestions and WHICH contacts the verify UI shows.
- Mutating-route 4-step pattern (auth → json → Zod → try/catch) for the new re-anchor route.
- Idempotent upsert via `onConflictDoNothing` (e.g. `recordLineWebhookPayload` on `webhookEventId`) — pattern for the re-anchor's contact upsert.

### Integration Points
- `processLineMessageForScheduler` (`src/lib/line/review-service.ts:126`) — wire the content-match suggestion in here (per inbound message).
- Mapping Validation workspace (`src/components/line-review/mapping-validation-workspace.tsx`) + link-validation routes — host the widened worklist (D-04), the re-anchor button (D-02), and the archive filter (D-03).
- LINE review queue badge (`src/components/line-review/utils.ts`, `case-header.tsx`, `review-queue.tsx`) — reflect live link state + the recompute (Claude's discretion).

</code_context>

<specifics>
## Specific Ideas

- Production signal (2026-06-06): 252 messaging contacts, all with display names/profiles, avg ~8 inbound messages, 805 scheduling-classified messages — rich enough for content matching; the eval should sample these real messages with ground-truth `studentKey`.
- OA is **verified/premium**, so `GET /v2/bot/followers/ids` is available (returns correct-namespace userIds) — the re-anchor's leverage point.
- The ~520 phantom links sit on `line_oa_resolver`-sourced contacts with no thread / wrong-namespace `line_user_id` — the quarantine predicate target.

</specifics>

<deferred>
## Deferred Ideas

- **Conversational self-identify** (AI asks the parent "which student is this for?") — high-value, next phase; needs the outbound-reply path.
- **followers/ids as a recurring job** — considered for D-02; deferred in favor of an idempotent admin-triggered button (re-anchor is mostly one-time).
- **Dedicated 'verify messaging contacts' surface** — deferred per D-04; revisit if volume makes the widened worklist cramped.
- **Hard-deleting or removing the OA-resolver extension flow** — quarantine only this phase; formal removal is a separate cleanup.
- (From SPEC) Wise mutation/writeback and autonomous replies — later autonomy-ladder phases.

</deferred>

---

*Phase: 11-ident-01-webhook-side-line-identity-resolution*
*Context gathered: 2026-06-06*
