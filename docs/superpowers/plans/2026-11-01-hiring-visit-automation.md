# Hiring Visit Automation Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Run tutor hiring from SEEK application to a booked onsite visit, inside limits Kevin sets, with full visibility in `/hiring`.

**Architecture:** Hiring stays on its existing spine: Postgres tables, a Mac worker for SEEK and subscription scoring, and Vercel for booking and delivery. One pure limit function controls every invitation. A visit is two linked `hiring_bookings` rows, so the existing overlap triggers still apply. All new rules live in `hiring_settings.config`.

**Tech Stack:** Next.js 16, Drizzle, Neon Postgres, Vitest with Testcontainers, `@vercel/blob`, Claude subscription runner, plain SVG.

**Spec:** `docs/superpowers/specs/2026-11-01-hiring-visit-automation-design.md`. Screens: `https://claude.ai/artifact/5Wz9cdwaJStzGoPSDbMP98` (sample data; the code does not copy its data).

## Global Constraints

- Before coding, read the relevant guide in `node_modules/next/dist/docs/` for route handlers and streaming.
- Base all work on `origin/main`, in a slot under `.claude/worktrees/`, created with `scripts/dev/worktrees.sh`. Run `scripts/dev/worktrees.sh status` first and do not take a slot with an open PR. Do not create `~/Developer/Scheduling-*` folders. Do not use `.codex/worktrees/hiring-automation`.
- Times use `Asia/Bangkok`. A limit week starts on Monday.
- No new dependency. No model API key. Scoring uses `runClaude` on the subscription.
- Code style: match each file. Tests go in a sibling `__tests__/`. Route errors go through `hiringError`.
- Candidate-facing and interface copy is plain English. AI briefs are ASD-STE100.
- Never send a real message, change production data or apply a production migration during implementation. Integration tests use `startTestDb` and mocks.
- Local commands use Node 24. Run `npm test -- src/lib/hiring` during a task, and `npm run verify:release` before each PR.
- Open PRs as draft until the code-reviewer agent and the integration suite pass. Do not merge. Each merge, migration and passes run need Kevin's approval. Migration `0119` must reach production before the PR that contains it merges, because Drizzle selects the new columns.

### PR order

| PR | Tasks | Needs migration | Live effect when merged |
|---|---|---|---|
| A: Visibility | 1, 2 | No | New chart, short evidence, status column. No behaviour change. |
| B: Scoring and data | 3, 4, 5 | Yes (0119) | New rules and score passes available. Automation stays paused. |
| C: Queue and visit | 6, 7, 8, 9 | No | New flow ready. Automation stays paused. |
| D: Screens | 10, 11 | No | Head schedules and full settings. |
| E: Résumés | 12, 13 | No | Résumé viewer, SEEK re-read, retention cron. |
| Close-out | 14 | No | Docs and go-live record. |

## Review Focus

Each line has a test in the owning task.

1. Two workers, or a worker and a click, take the last limit place at the same time: only one invitation is queued (Task 7).
2. Kevin lowers a limit below current use, or sets it to 0: nothing is released, the meter shows full and no count goes negative (Task 6).
3. A form timestamp that cannot be parsed, or an email that differs in case or spaces: case and spaces still match, and an unparsable time needs a click (Task 7).
4. Wise is stale, or no time fits, when a candidate opens the link: the page explains and gives the LINE contact, and it does not show an empty form or a crash (Task 9).
5. A résumé with an unsafe file name, a false extension, or a deleted file: the name cannot inject a header, the wrong type is refused and the panel says the file is gone (Task 12).

---

### Task 1: Short evidence display and DSCTE pentagon

**Files:**
- Create: `src/components/hiring/pentagon.tsx`, `src/components/hiring/__tests__/pentagon.test.tsx`
- Modify: `src/lib/hiring/scoring.ts`, `src/components/hiring/candidate-inspector.tsx`, `src/components/hiring/dashboard.tsx`, `src/components/hiring/dashboard.module.css`, `src/lib/hiring/insights.ts`

**Interfaces:**
- Produces: `Pentagon({ shapes, labels, size }: { shapes: { label: string; values: number[]; tone: "profile" | "preScreen" }[]; labels: { name: string; value: string }[]; size?: number })`
- Produces: `criterionValues(assessment: { criteria: { id: string; result: CriterionResult }[] }): number[]` in `insights.ts`, returning Degree, Subject, Curriculum, Teaching, English as 1, 0.5 or 0. `averageValues(candidates): number[]`.
- Produces: optional `brief?: string` on each criterion and `briefSummary?: string` on `assessmentSchema`, in `scoring.ts`.

- [ ] **Step 1: Write failing tests**

```ts
it("maps results to values in DSCTE order", () => {
  expect(criterionValues(a({ degree: "met", subject: "partial", curriculum: "unknown", teaching: "not_met", english: "met" }))).toEqual([1, 0.5, 0, 0, 1]);
});
it("draws one polygon per shape and labels every corner", () => {
  render(<Pentagon shapes={[{ label: "Profile", values: [1,1,1,1,1], tone: "profile" }]} labels={DSCTE.map((name) => ({ name, value: "Met" }))} />);
  for (const name of DSCTE) expect(screen.getByText(name)).toBeTruthy();
  expect(screen.getByRole("img").getAttribute("aria-label")).toContain("Degree: Met");
});
it("shows a result label and no long reason when a brief is missing", () => { /* render CandidateInspector with no brief: result label shows; reason sits inside the closed Details */ });
```

- [ ] **Step 2: Run** `npm test -- src/components/hiring src/lib/hiring/__tests__/insights.test.ts`. Expected: FAIL.

- [ ] **Step 3: Implement.** Geometry: centre (110, 100), radius 72, angle `-90 + 72i`, `viewBox="-50 -14 320 210"`, as in the mockup. Corner labels: name, then result (`Partial → Met` when pre-screen differs). In the panel, `AssessmentBlock` shows `briefSummary` and each `brief`. The long reason and exact quote move inside the `<details>`. On Pipeline add a card with the average pentagon using `averageValues` for the rows passing the current filter, with a percentage at each corner. Existing rows stay valid because the new fields are optional.

- [ ] **Step 4: Run tests.** Expected: PASS.

- [ ] **Step 5: Commit** `feat(hiring): add DSCTE pentagon and short evidence display`.

### Task 2: Pre-screen status column and answers

**Files:**
- Create: `src/lib/hiring/status.ts`, `src/lib/hiring/__tests__/status.test.ts`
- Modify: `src/lib/hiring/service.ts` (`dashboard` outbox select), `src/components/hiring/candidate-table.tsx`, `src/components/hiring/candidate-inspector.tsx`

**Interfaces:**
- Produces: `preScreenStatus(candidate, outboxForCandidate, ready: boolean): { status: "Not sent" | "Queued" | "Sent" | "Reminded" | "Replied" | "No reply" | "Earlier contact"; sentAt: Date | null; remindedAt: Date | null; repliedAt: string | null }`
- The dashboard outbox rows gain `key` and `workflowStage` (`payload->>'workflowStage'`). They must not return `payload`.

- [ ] **Step 1: Write failing tests**

```ts
it("is Sent after the outbox receipt", ...);          // key `${id}:pre-screen`, status sent → Sent, sentAt set
it("is Reminded after a sent reminder", ...);         // key `${id}:pre-screen-reminder`
it("is Replied whenever a response exists", ...);     // preScreen set → Replied, repliedAt = submittedAt
it("is Earlier contact with no app send and previouslyContacted", ...);
it("is No reply at stage no_reply", ...);
it("is Queued when ready and not sent", ...);
it("does not return outbox payload from dashboard", ...); // no `payload` key on outbox rows
```

- [ ] **Step 2: Run** `npm test -- src/lib/hiring/__tests__/status.test.ts`. Expected: FAIL.

- [ ] **Step 3: Implement** the function. In the table add Pre-screen (pill plus dates), Pre-screen score and Visit columns, and filter buttons: All, Queued, Sent (Sent and Reminded), Replied, No reply, Visit booked. In the panel show the score parts and a `<details>` with all answers from `candidate.preScreen`. Pills use the mockup's colours through module CSS. This PR runs before the new stages exist, so type `no_reply` handling with a string compare until Task 3.

- [ ] **Step 4: Run tests.** Expected: PASS.

- [ ] **Step 5: Commit** `feat(hiring): show pre-screen status and answers`. Open PR A after `verify:release`.

### Task 3: Migration, schema and settings

**Files:**
- Create: `drizzle/0119_hiring_visit_automation.sql` (confirm the next free number)
- Modify: `src/lib/db/schema.ts`, `src/lib/hiring/model.ts`, `src/lib/hiring/insights.ts` (labels), `src/lib/hiring/__tests__/policy.test.ts`, `src/lib/hiring/__tests__/workflow.integration.test.ts`

**Interfaces:**
- Produces in `model.ts`: `stageSchema` adds `onsite_invited`, `onsite_booked`, `no_reply`, `no_booking`. `kindSchema` stays `paper | mock`. A new `tokenKindSchema` adds `visit`.
- Produces `configSchema` additions, with these defaults:

```ts
preScreenLimits: { perDay: 5, perWeek: 15, waiting: 15, perSubject: 3 }
onsiteLimits: { perWeek: 3, unbooked: 2, perHeadPerWeek: 2, perSubject: 2 }
preScreenFollowUp: { remindDays: 3, expireDays: 7 }
onsiteFollowUp: { remindDays: 3, expireDays: 7 }
preScreenThreshold: null            // number | null, 0–100
preScreenWeights: { degree: 10, subject: 10, curriculum: 15, teaching: 15, english: 15, prestige: 10, written: 15, availability: 10 } // must total 100
acceptedWorkRights: ["I have permanent work rights with no restrictions"]
seenWorkRights: []                  // string[]: every answer read from SEEK
subjectPriority: SUBJECTS.map((subject) => ({ subject, hiring: true }))
visitStartMinute: 600, visitEndMinute: 960
resumeRetentionMonths: 12
// interviewers[] gains optional fallbackWeek: Week
```

- [ ] **Step 1: Write failing tests**

```ts
it("parses a stored config without the new keys", () => { expect(configSchema.parse({}).onsiteLimits.perWeek).toBe(3); expect(configSchema.parse({}).preScreenThreshold).toBeNull(); });
it("refuses pre-screen weights that do not total 100", ...);
// integration
it("accepts a mock outside 10:00–16:00 and refuses one over an hour", ...);
it("accepts the new stages and refuses an unknown stage", ...);
```

- [ ] **Step 2: Run** `npm test -- src/lib/hiring/__tests__/policy.test.ts`. Expected: FAIL.

- [ ] **Step 3: Write the migration.** `npm run db:generate` can emit unrelated catch-up statements. Trim its output so the file holds only:
  - drop and recreate `hiring_stage` with the four new values;
  - drop `hiring_mock_window`, recreate it keeping interviewer, email, LINE group, one subject, one hour and same Bangkok date, and remove the weekday and time terms;
  - `hiring_bookings`: add `visit_id uuid`, `reschedule_of uuid REFERENCES hiring_bookings(id)`, and index `visit_id`; widen status to include `no_show`;
  - `hiring_candidates`: add `work_rights_answer text`, `visit_subject text`, `pre_screen_replied_at timestamptz`, `pre_screen_resubmitted boolean NOT NULL DEFAULT false`, and `resume_path`, `resume_name`, `resume_type`, `resume_sha256` (text), `resume_size` (integer), `resume_stored_at` (timestamptz);
  - backfill: `UPDATE hiring_candidates SET work_rights_answer='I have permanent work rights with no restrictions' WHERE work_rights_confirmed IS TRUE`.

  This plan replaces the spec's `pre_screen_queued_at` with a derived queue, and adds the reply fields needed by the reply rule. The guard trigger treats only `confirmed` as active, so a `no_show` frees the slot.

- [ ] **Step 4: Run** `npm test -- src/lib/hiring` and `npm run test:integration -- src/lib/hiring/__tests__/workflow.integration.test.ts`. Expected: PASS.

- [ ] **Step 5: Commit** `feat(hiring): add visit stages, limits and settings`.

### Task 4: Pre-screen scoring and hard stops

**Files:**
- Modify: `src/lib/hiring/scoring.ts`, `src/lib/hiring/worker.ts`, `src/lib/hiring/model.ts`, `src/lib/hiring/sources.ts`, `scripts/hiring-seek.ts`, `scripts/hiring-score.ts`, `src/lib/hiring/insights.ts`, `src/lib/hiring/__tests__/policy.test.ts`

**Interfaces:**
- Produces: `applicationSchema` gains `workRightsAnswer: string | null`. `readApplication` keeps the exact answer text. `importApplication` writes `work_rights_answer` and also calls `recordWorkRightsAnswer(tx, answer)`, which adds an unseen answer to `config.seenWorkRights` and raises the settings revision.
- Produces: `preScreenAssessmentSchema` (6 criteria, adding `written`), `PRE_SCREEN_SYSTEM`.
- Produces: `englishLevel(english, evidence)`: `Native` in the `english` argument returns 5 (C2).
- Produces: `availabilityFraction(pre: PreScreen): number`.
- Produces: `preScreenPoints(assessment, weights, prestigeFraction, availability): { degree, subject, curriculum, teaching, english, prestige, written, availability, total }`.
- Produces: `workRightsAccepted(answer: string | null, accepted: string[]): boolean`.
- Produces: `hardStops(pre: PreScreen, answer: string | null, declared: Subject[], config: HiringConfig): { stops: string[]; subjects: Subject[] }`.
- Produces: `profileGate(candidate, config): { eligible: boolean; reasons: string[]; subject: Subject | null }`. `readyToInvite` calls it.
- Produces: `scorePreScreens(db, config, assess, opts?: { candidateId?: string }): Promise<number>` in `worker.ts`.

- [ ] **Step 1: Write failing tests**

```ts
it("treats Native as C2 only from the form field", () => {
  expect(englishLevel("Native", "")).toBe(5);
  expect(englishLevel("Upper-Intermediate (B2)", "Native-English")).toBe(3);
});
it("scores availability", () => {
  expect(availabilityFraction(pre({ availability: "Weekday Evening (17:00-21:00), Weekend Morning (before 12:00)", weeklyHours: "40+" }))).toBe(1);
  expect(availabilityFraction(pre({ availability: "Weekday Evening (17:00-21:00), Weekend Morning (before 12:00)", weeklyHours: "11-20" }))).toBeCloseTo(0.8);
  expect(availabilityFraction(pre({ availability: "Weekday Morning (before 12:00)", weeklyHours: "1-10" }))).toBeCloseTo(0.1);
});
it("does not stop on an unrelated degree field", ...);    // hardStops has no relevance check
it("stops on no bachelor, B1 for Biology, no weekend, and an unaccepted work-rights answer", ...);
it("stops EFL/ESL at B2 and passes Biology at B2", ...);  // subjects narrows, stops only when none remain
it("keeps the portfolio rule for Art", ...);
it("profile gate no longer needs degree and subject to be met", ...); // partial passes, not_met degree fails
it("profile gate refuses a not-hiring subject and earlier contact", ...);
it("score-only pre-screen pass changes no stage and adds no outbox row", ...); // integration
```

- [ ] **Step 2: Run tests.** Expected: FAIL.

- [ ] **Step 3: Implement.** `PRE_SCREEN_SYSTEM` adds to `ASSESSMENT_SYSTEM`: the `written` criterion scores the two written answers for specific diagnosis, specific actions and care for the student, and must ignore grammar, accent and suspected AI use. Keep the rule against inferring English from a name or nationality. `hiring_candidates.pre_screen_assessment` gets the new type. No rows use the old shape. `preScreenRows`, `preScreenText` stay. `scorePreScreens` covers every stage, refuses to run while `enabled` or `deliveryEnabled` is true, and writes one audit row with the source hash. Add `--pre-screen` to `scripts/hiring-score.ts`. Remove the old `preScreenResult` once Task 7 stops calling it, in the same PR.

- [ ] **Step 4: Run tests.** Expected: PASS.

- [ ] **Step 5: Commit** `feat(hiring): score pre-screen responses and apply hard stops`.

### Task 5: Short evidence generation

**Files:**
- Modify: `src/lib/hiring/scoring.ts`, `src/lib/hiring/worker.ts`, `scripts/hiring-score.ts`, `src/lib/hiring/__tests__/policy.test.ts`

**Interfaces:**
- Produces: `BRIEF_SYSTEM`, `briefOutputSchema`, `validateBriefs(value): { briefSummary: string; briefs: Record<CriterionId, string> }`.
- Produces: `rewriteBriefs(db, assess, opts: { max: number }): Promise<number>` in `worker.ts`.

- [ ] **Step 1: Write failing tests**

```ts
it("refuses a summary over 25 words or a brief over 15 words", ...);
it("accepts text at exactly the limits", ...);
it("new assessments need briefs; stored rows without them still parse", ...);
it("rewrite changes only brief fields", ...); // integration: result, evidence, reason, stage, revision, outbox count all unchanged
it("rewrite skips a row already holding briefs", ...);
```

- [ ] **Step 2: Run tests.** Expected: FAIL.

- [ ] **Step 3: Implement.** `BRIEF_SYSTEM`: rewrite the given summary and reasons in ASD-STE100, active voice, short sentences, no new facts, no quotes. Limits: 25 words for the summary, 15 per criterion. On a violation, retry up to 3 times with the exact count, as the existing evidence retry does, then leave the row without briefs. Add `--briefs` to `scripts/hiring-score.ts`, reusing `HIRING_SCORE_UNTIL`, the lock and 4 concurrent calls. New profile and pre-screen runs ask for briefs in the same call.

- [ ] **Step 4: Run tests.** Expected: PASS.

- [ ] **Step 5: Commit** `feat(hiring): generate short STE evidence`. Open PR B. Migration approval is a Kevin step.

### Task 6: Limit function

**Files:**
- Create: `src/lib/hiring/limits.ts`, `src/lib/hiring/__tests__/limits.test.ts`

**Interfaces:**
- Produces:

```ts
export type Funnel = "pre_screen" | "onsite";
export type LimitName = "perDay" | "perWeek" | "waiting" | "unbooked" | "perSubject";
export type LimitUsage = { perDay: number; perWeek: number; waiting: number; unbooked: number; bySubject: Partial<Record<Subject, number>> };
export type QueueEntry = { id: string; subject: Subject; score: number; createdAt: Date };
export function rankQueue(entries: QueueEntry[], priority: HiringConfig["subjectPriority"]): QueueEntry[];
export function blockingLimit(funnel: Funnel, subject: Subject, usage: LimitUsage, config: HiringConfig): LimitName | null;
export function releaseQueue(funnel: Funnel, entries: QueueEntry[], usage: LimitUsage, config: HiringConfig): { release: QueueEntry[]; held: (QueueEntry & { position: number; limit: LimitName })[] };
export function bangkokDayStart(now: Date): Date;
export function bangkokWeekStart(now: Date): Date;
```

- [ ] **Step 1: Write failing tests**

```ts
it("orders by subject rank, then score, then earliest application", ...);
it("releases 5 of 40 at a daily limit of 5, and holds 35 with positions", ...);
it("releases 0 on a second run the same day", ...); // usage.perDay = 5
it("applies the per-subject limit while walking the queue", ...); // 5 Maths, perSubject 3 → 3 Maths, then next subject
it("excludes a not-hiring subject", ...);
it("releases nothing when a limit is 0 or lowered below use", () => { /* perDay 2, used 5 → release [] */ });
it("names the blocking limit", () => { expect(blockingLimit("onsite", "Physics", usage({ unbooked: 2 }), cfg)).toBe("unbooked"); });
it("uses Bangkok boundaries", () => {
  expect(bangkokDayStart(new Date("2026-11-01T17:00:00Z")).toISOString()).toBe("2026-11-01T17:00:00.000Z");
  expect(bangkokWeekStart(new Date("2026-11-01T16:59:00Z")).toISOString()).toBe("2026-10-25T17:00:00.000Z");
  expect(bangkokWeekStart(new Date("2026-11-01T17:00:00Z")).toISOString()).toBe("2026-11-01T17:00:00.000Z");
});
```

- [ ] **Step 2: Run** `npm test -- src/lib/hiring/__tests__/limits.test.ts`. Expected: FAIL.

- [ ] **Step 3: Implement.** Pure functions with no I/O. `release` increments a local copy of usage as it walks the ranked list.

- [ ] **Step 4: Run tests.** Expected: PASS.

- [ ] **Step 5: Commit** `feat(hiring): add invitation limit function`.

### Task 7: Queue, follow-ups, reply rule and tracker guard

**Files:**
- Create: `src/lib/hiring/queue.ts`, `src/lib/hiring/__tests__/queue.integration.test.ts`
- Modify: `src/lib/hiring/worker.ts`, `src/lib/hiring/service.ts`, `src/lib/hiring/sources.ts`, `src/lib/hiring/status.ts`, `src/lib/hiring/__tests__/workflow.integration.test.ts`

**Interfaces:**
- Consumes: Task 4 `profileGate`, `hardStops`, `preScreenPoints`; Task 6 functions.
- Produces in `queue.ts`:
  - `readLimitUsage(db, funnel, now): Promise<LimitUsage>`
  - `preScreenQueue(db, config): Promise<QueueEntry[]>`, `onsiteQueue(db, config): Promise<QueueEntry[]>`
  - `releaseQueues(db, now?): Promise<{ preScreen: number; onsite: number }>`
  - `runFollowUps(db, now?): Promise<{ reminded: number; expired: number }>`
  - `autoInviteEligible(candidate, formSentAt: Date | null, config): boolean`
- Produces in `service.ts`: `inviteToVisit(tx, candidate, config, key)`.
- Produces in `sources.ts`: `isNewFlow(candidate, appFormSent: boolean): boolean`, `parseFormTimestamp(value: string): Date | null` (format `d/m/yyyy, H:mm:ss` in GMT).
- The onsite token has a fixed 30-day life. `inviteExpiresAt` holds the same second. A link is valid only if the two are equal, so a new link ends the old one.

- [ ] **Step 1: Write failing tests** (integration, with sheets, email and calendar mocked)

```ts
it("does not exceed a limit under two concurrent releases", ...);       // Promise.all([releaseQueues, releaseQueues]) → outbox count = limit
it("a release and a click cannot both take the last onsite place", ...);
it("counts a pending outbox row as used", ...);
it("does not repeat a form email", ...);                                 // second release → one row with key `${id}:pre-screen`
it("only stage new enters the form queue", ...);                         // review, stopped, earlier contact: 0
it("reminds once on day 3 and marks no reply on day 7", ...);
it("does not start the follow-up clock until sentAt", ...);              // delivery paused: no reminder or expiry
it("frees the place when the onsite link expires and clears the link", ...);
it("a late reply on no_reply is scored", ...);
it("a first reply after the app send queues automatically", ...);
it("requires a click for: no app send, a stopped candidate, a resubmission, a time before the send, an unparsable time", ...);
it("matches an email with different case and spaces", ...);
it("keeps the candidate waiting when the pass score is empty", ...);     // preScreenThreshold null → no invite
it("tracker change on a new-flow candidate changes nothing and queues nothing", ...);
it("tracker change on an old-flow candidate behaves as today", ...);
```

- [ ] **Step 2: Run** `npm run test:integration -- src/lib/hiring/__tests__/queue.integration.test.ts`. Expected: FAIL.

- [ ] **Step 3: Implement.**
  - `assessCandidates` no longer sends. It stores assessments. A profile below the gate moves to `review` as today. A pre-screen below the score or with a stop moves to `review` with the reason in `reviewNote`. `pre_screen` and `no_reply` both count as scoring stages.
  - In `syncTracker`, when a response changes: set `pre_screen_replied_at` on the first response, and `pre_screen_resubmitted = true` on a later change. On a reply at `no_reply`, set the stage to `pre_screen`.
  - `syncTracker` applies `isNewFlow` to Recruitment rows and to the mock log. A new-flow row updates only `trackerHash`.
  - `releaseQueues` runs in `withDatabaseTransaction` under `pg_advisory_xact_lock(hashtext('hiring-queue'))`, and requires `enabled`, `rubricApproved` and `runtimeWritesAllowed()`. An onsite release sets `visit_subject` to the highest-ranked subject from `hardStops().subjects`.
  - `runHiringCycle` order: `syncTracker`, `assessCandidates`, `runFollowUps`, `releaseQueues`, `mirrorTracker`.
  - Reminder keys: `{id}:pre-screen-reminder`, `{id}:visit-reminder:{revision}`, with matching `workflowStage`.
  - Email copy: plain and short. Include subject, the link, the 3-hour visit (2-hour exam, 1-hour mock), the prepared IGCSE topic note from the current mock text, and the LINE contact.

- [ ] **Step 4: Run** `npm test -- src/lib/hiring`, then the integration suites. Expected: PASS. Update older workflow tests that assert the removed direct invitations.

- [ ] **Step 5: Commit** `feat(hiring): queue invitations within limits`.

### Task 8: Visit slots

**Files:**
- Modify: `src/lib/hiring/availability.ts`, `src/lib/hiring/model.ts`, `src/lib/hiring/__tests__/policy.test.ts`
- Create: `src/lib/hiring/__tests__/visit-slots.test.ts`

**Interfaces:**
- Produces: `VisitSlot = { date: string; examStart: string; mockStart: string; mockEnd: string; interviewerKey: string; subject: Subject }`.
- Produces: `availableVisitSlots(db, config, subject, now?): Promise<VisitSlot[]>`.
- Produces: `headInOffice(head, date, startMinute, endMinute, ctx): boolean`, with `ctx = { schedules, exceptions, enrollments }`.
- Produces: `assignHead(candidates: { key: string; weekMocks: number }[]): string`.
- Keep `availableSlots` and `verifyLiveSlot` for legacy bookings, but remove the positive onsite Wise-hours requirement from `indexedSlotAvailable` and `verifyLiveSlot`. `verifyLiveSlot` still reads sessions and leave.

- [ ] **Step 1: Write failing tests**

```ts
it("offers Ek Mon–Thu and never Friday", ...);
it("uses the fallback week for Gift", ...);
it("needs no Wise working hours, but a class or leave blocks the mock hour", ...);
it("a Wise class during the exam does not block the head", ...);
it("starts exams on the hour from 10:00 to 13:00, with the mock right after", ...);
it("refuses when exam capacity is full", ...);       // paperCapacity
it("removes a head at the weekly mock limit", ...);  // perHeadPerWeek 2; counts confirmed mocks in that Bangkok week
it("shows each time once and assigns the head with fewer mocks", ...);
it("excludes weekends and closed dates", ...);
it("stays fail-closed on stale Wise data and identity, leave or session data issues", ...);
```

- [ ] **Step 2: Run** `npm test -- src/lib/hiring/__tests__/visit-slots.test.ts`. Expected: FAIL.

- [ ] **Step 3: Implement.** Extract the attendance logic from the current loop into `headInOffice`. The data-issue filter becomes `/identity|leave|session/i`. A tie in `assignHead` picks the earlier key in `config.interviewers`.

- [ ] **Step 4: Run tests.** Expected: PASS.

- [ ] **Step 5: Commit** `feat(hiring): offer one-visit slots from saved head hours`.

### Task 9: Booking, move-once and staff actions

**Files:**
- Modify: `src/lib/hiring/service.ts`, `src/lib/hiring/tokens.ts`, `src/lib/hiring/worker.ts`, `src/lib/hiring/google.ts`, `src/app/api/hiring/route.ts`, `src/app/api/hiring/book/[token]/route.ts`, `src/components/hiring/booking.tsx`, `src/components/hiring/candidate-inspector.tsx`, `src/lib/hiring/__tests__/workflow.integration.test.ts`

**Interfaces:**
- Produces: `visitBookingSchema = { start: iso, subject, onsiteConfirmed: true, teachingCommitmentConfirmed: true, move?: boolean }`.
- Produces: `visitView(token, db?, now?)` returning `{ subject, location, enabled, slots, visit: { examStart, mockStart, mockEnd, head } | null, canMove: boolean, notice: string | null }`.
- Produces: `bookVisit(token, value, db?, now?)`.
- Produces `reviewCandidate` actions: `invite_onsite`, `send_new_link`, `cancel_visit`, `mark_no_show`. All need a reason of at least 5 characters and write an audit row.
- A `line` outbox job gains payload `{ notice?: "moved" | "cancelled" }`.

- [ ] **Step 1: Write failing tests**

```ts
it("books an exam row and a mock row with one visit_id", ...);       // 10:00–12:00 paper, 12:00–13:00 mock, stage onsite_booked
it("sends one email holding both times", ...);                       // outbox: 1 email, 2 calendar, 1 line
it("candidates cannot pick a head", ...);                            // server assigns
it("moves once, cancels the old rows, and notifies the head", ...);
it("refuses a second move and a move inside 24 hours, with the LINE contact", ...);
it("ends the old link after send_new_link", ...);
it("advance to the form obeys limits, work rights and not-hiring", ...);
it("advance with a response now goes to the onsite invite, not a paper invite", ...);
it("click: passes a low score", ...);
it("click: refused for a hard stop, not-hiring subject or full limit, naming the reason", ...);
it("cancel and no-show free the slot and the limit", ...);
it("send_new_link resets the move count and obeys limits", ...);
it("old paper and mock links still work for old-flow candidates", ...);
it("shows a notice and the LINE contact when Wise is stale or no slot fits", ...);
```

- [ ] **Step 2: Run** the integration suite. Expected: FAIL.

- [ ] **Step 3: Implement.** `bookVisit` follows `bookInterview`: verify with `verifyLiveSlot`, then re-check `availableVisitSlots` in the transaction, take the same locks and insert both rows. The token route dispatches on `kind === "visit"`. `visitView` catches the stale-Wise `HiringError` and returns a `notice`. `booking.tsx` adds a visit mode: one subject, exam and mock times, both confirmation boxes, the current booking and Move button, and the LINE contact (`https://lin.ee/OjMHF41`) for a notice or an empty list. `deliverCalendar` titles events "BeGifted exam" and "BeGifted mock teaching", and only the mock invites the head. Move count: a confirmed row with `reschedule_of` set and no later `send_new_link` audit. The panel shows actions per stage, and Send new link after a cancel or no-show.

- [ ] **Step 4: Run** `npm test -- src/lib/hiring` and the integration suite. Expected: PASS.

- [ ] **Step 5: Commit** `feat(hiring): book, move and manage one-visit appointments`. Open PR C.

### Task 10: Head schedules

**Files:**
- Create: `src/lib/hiring/head-schedule.ts`, `src/lib/hiring/__tests__/head-schedule.test.ts`, `src/components/hiring/head-schedules.tsx`
- Modify: `src/app/api/hiring/route.ts`, `src/components/hiring/dashboard.tsx`, `src/components/hiring/dashboard.module.css`, `docs/reference/production-route-surface.json` only if the manifest needs it

**Interfaces:**
- Produces: `buildHeadWeek(input): HeadWeek`, a pure function, and `headWeek(db, config, key, weekStart, now?): Promise<HeadWeek>`.

```ts
type HeadWeek = { key: string; name: string; subjects: Subject[]; weekStart: string; mocks: number; limit: number; stale: boolean;
  days: { date: string; office: { start: string; end: string } | null;
    blocks: { kind: "wise" | "leave" | "mock" | "exam" | "sit_in"; start: string; end: string; candidateId?: string; candidate?: string; subject?: Subject; clash: boolean }[] }[];
  visits: { candidateId: string; candidate: string; subject: Subject; examStart: string; mockStart: string; mockEnd: string; clash: boolean }[] };
```
- Route: `GET /api/hiring?head=Peat&weekStart=2026-11-02`, behind `requireHiringAdmin`.

- [ ] **Step 1: Write failing tests**

```ts
it("returns office hours per day, null when out of office", ...);
it("blocks carry no student names", ...);                 // JSON has no session title or student field
it("marks a mock clash when a Wise session overlaps", ...);
it("does not mark an exam-only overlap as a clash", ...);
it("refuses an unknown head and a week before the current week", ...);
it("needs Hiring access", ...);                           // route test: 401 and 403
it("excludes cancelled and no-show bookings", ...);
```

- [ ] **Step 2: Run** `npm test -- src/lib/hiring/__tests__/head-schedule.test.ts`. Expected: FAIL.

- [ ] **Step 3: Implement.** Add a third view to the `viewSwitch`, named "Head schedules". Calendar range 09:00–19:00 at 56 px an hour, with day columns Mon–Fri. Office band, hatched non-office days, a legend and a list of visits as in the mockup. Clicking a mock opens the candidate on Pipeline. The app shows a banner when `stale` is true or a clash exists. Add a clash marker on the candidate's table row, from the same function.

- [ ] **Step 4: Run tests.** Expected: PASS.

- [ ] **Step 5: Commit** `feat(hiring): add head schedule calendar`.

### Task 11: Rules and setup, and Pipeline meters

**Files:**
- Modify: `src/components/hiring/setup-panel.tsx`, `src/components/hiring/pipeline-charts.tsx`, `src/components/hiring/operations-rail.tsx`, `src/components/hiring/dashboard.tsx`, `src/lib/hiring/service.ts`, `src/app/api/hiring/route.ts`
- Create: `src/components/hiring/__tests__/setup-rules.test.tsx`

**Interfaces:**
- Produces: `saveHeadDays(key: string, days: boolean[], revision: number, actor: string, db?)`. An enrolled head saves through `saveAttendanceSettings` with `action: "schedule"`, effective the next Bangkok day. An unenrolled head updates `fallbackWeek`.
- `dashboard()` returns `usage: { preScreen: LimitUsage; onsite: LimitUsage }`.

- [ ] **Step 1: Write failing tests**

```ts
it("edits each limit and saves it", ...);
it("refuses to save when pre-screen weights do not total 100", ...);
it("moves a subject up and down, and marks it not hiring", ...);
it("lists a new SEEK work-rights answer unticked", ...);
it("shows the empty pass score as a blocker for automatic invitations", ...);
it("saves head days to attendance for an enrolled head, with a visible warning", ...);
it("saves Gift's days to the fallback week and does not enrol Gift", ...);
it("refuses attendance writes for a user without attendance admin, with a message", ...);
it("renders limit meters from dashboard usage", ...);
it("warns when automation is on and the last worker run is over 60 minutes old", ...);
```

- [ ] **Step 2: Run tests.** Expected: FAIL.

- [ ] **Step 3: Implement.** Sections as in the mockup. Add a line under Head office days: "This also changes Tutor Attendance." Keep existing sections. Add the two meter cards on Pipeline. Show the queue position and limit in the Pre-screen column.

- [ ] **Step 4: Run tests.** Expected: PASS.

- [ ] **Step 5: Commit** `feat(hiring): add limit, priority and head-day settings`. Open PR D.

### Task 12: Résumé storage and viewer

**Files:**
- Create: `src/lib/hiring/resume-files.ts`, `src/app/api/hiring/resume/[id]/route.ts`, `src/app/api/internal/hiring-resume-upload/route.ts`, `src/app/api/internal/hiring-resume-retention/route.ts`, `src/lib/hiring/__tests__/resume-files.test.ts`
- Modify: `src/lib/hiring/dispatch.ts`, `scripts/hiring-seek.ts`, `scripts/hiring-worker.ts`, `src/components/hiring/candidate-inspector.tsx`, `src/components/hiring/candidate-table.tsx`, `vercel.json`, `src/lib/data-health/cron-registry.ts`, `src/__tests__/vercel-crons.test.ts`, `docs/reference/production-route-surface.json`

**Interfaces:**
- Produces: `sniffResume(bytes: Buffer): { type: "application/pdf" | "application/vnd.openxmlformats-officedocument.wordprocessingml.document"; extension: "pdf" | "docx" } | null`.
- Produces: `resumePath(candidateId: string, sha256: string, extension: string): string` = `hiring-resumes/{id}/{sha}.{ext}`.
- Produces: `storeResume(candidateId, file: { bytes: Buffer; name: string }, db): Promise<void>`. It refuses over 15 MB. It uploads through a token from the signed route, and writes the columns.
- Produces: `deleteExpiredResumes(db, now, months): Promise<number>`.
- `readApplication` returns a `resumeFile` beside `resumeText`. `Application` itself stays free of file bytes: the worker passes the file to `storeResume` through a separate callback.
- Upload route: `POST` with an `HMAC-HIRING` signature over the body `{ candidateId, sha256, extension }`, using a distinct context string (`hiring-resume-upload`). It uses `generateClientTokenFromReadWriteToken` from `@vercel/blob/client`, scoped to the one path, 15 MB, 5-minute life. It rejects preview environments.

- [ ] **Step 1: Write failing tests**

```ts
it("recognises PDF and DOCX by signature and refuses others", ...);  // a .pdf holding text → null
it("needs Hiring access", ...);                                       // 401, 403
it("streams a PDF inline and a Word file as an attachment, with no-store and nosniff", ...);
it("cleans the file name in Content-Disposition", ...);               // name with quotes and CRLF
it("accepts only a stored path that matches the pattern", ...);
it("returns 404 with a clear message when the file is gone", ...);
it("refuses an unsigned or stale upload request", ...);
it("issues a token only for the requested path", ...);
it("deletes only files past retention, and keeps the text", ...);
it("the panel shows that the file was deleted", ...);
```

- [ ] **Step 2: Run** `npm test -- src/lib/hiring/__tests__/resume-files.test.ts`. Expected: FAIL.

- [ ] **Step 3: Implement.** In `readApplication`, read the file bytes before `rm`. Continue to send only redacted text to `Application`. The retention route uses the shared `cron-auth`, `maxDuration = 60`, one daily schedule in the 03:00–04:00 Bangkok hour on a free minute, and a new `hiring_resume_retention` registry entry with `manualOnly: false`. The panel embeds a PDF in an `<iframe>` with a `sandbox` attribute that keeps the browser's PDF viewer working. A Word file shows Download. The row's Open button opens the panel with the viewer open. The source text remains under "Extracted profile and résumé".

- [ ] **Step 4: Run** `npm test -- src/lib/hiring src/__tests__/vercel-crons.test.ts src/lib/data-health`. Expected: PASS.

- [ ] **Step 5: Commit** `feat(hiring): keep and open original résumés`.

### Task 13: One-time SEEK and tracker passes

**Files:**
- Create: `scripts/hiring-backfill.ts`, `src/lib/hiring/__tests__/backfill.integration.test.ts`
- Modify: `scripts/hiring-seek.ts`, `src/lib/hiring/sources.ts`, `package.json`

**Interfaces:**
- Produces: `applyBackfill(db, applicationId, { workRightsAnswer, file }): Promise<void>`.
- Produces: `reconcileTracker(db, config): Promise<{ sourcing: number; scheduling: number; missing: { sourceTab: string; row: number }[] }>`, report only.
- Produces: `importMissingTracker(db, config): Promise<number>`, which adds people with `previouslyContacted: true`, stage `review`, and the note "No source text".
- `npm run hiring:backfill -- --seek | --tracker-report | --tracker-import`.

- [ ] **Step 1: Write failing tests**

```ts
it("SEEK pass changes no stage, revision or review note and adds no outbox row", ...);
it("is resumable: a candidate with an answer and a file is skipped", ...);
it("adds a new work-rights answer to seenWorkRights, unticked", ...);
it("tracker report writes nothing", ...);
it("tracker import never makes a person eligible for an email", ...);
```

- [ ] **Step 2: Run** the integration test. Expected: FAIL.

- [ ] **Step 3: Implement.** The SEEK pass uses the existing selectors in a read-only way, and it never clicks Move. It takes the same `hiring-worker` advisory lock and refuses to run while automation is on. It saves after each candidate and prints counts only, with no personal data.

- [ ] **Step 4: Run tests.** Expected: PASS.

- [ ] **Step 5: Commit** `feat(hiring): add resumable source backfill`. Open PR E.

### Task 14: Documentation and go-live record

**Files:**
- Modify: `docs/features/hiring.md`, `docs/reference/crons.md`, `docs/reference/api/misc.md`, `docs/reference/database/index.md`, `docs/reference/env.md` if a new variable appears, `/Users/kevinhsieh/Developer/Codex_Workflows/TASKS.md`

- [ ] **Step 1: Update the feature page** in ASD-STE100: the new flow, scoring, hard stops, limits, reply rule, tracker rule, résumé retention. Remove the old "treats Native as uncalibrated" text and the paper-then-mock steps for new candidates.

- [ ] **Step 2: Verify.** Run `npm run verify:release`, `npm run test:integration -- src/lib/hiring`, and the signed-in browser check of Pipeline, Head schedules and Rules at desktop and 375 px, against a preview or local dev with seeded test data. Each must pass.

- [ ] **Step 3: Run the code-reviewer and verifier agents** on the branch. Fix their findings.

- [ ] **Step 4: Update the task record** with the results, keeping local checks, merge, deployment, live use, delivery and acceptance separate.

- [ ] **Step 5: Commit** `docs(hiring): document visit automation`.

## Go-live runbook (Kevin approves each step)

Each step needs Kevin's approval. The step says who acts. Do the steps in order. Do not skip a step.

Where the work stands: local checks passed on the five pull requests. Merge, migration, deployment, live delivery and acceptance are separate steps. None of them has happened. An approval for one step is not an approval for the next.

1. **Merge PR A (#241).** Who: Claude merges after Kevin approves. PR A changes only what `/hiring` shows. It has no migration.
2. **Apply migration `0119` to production, read it back, then merge PR B (#242).** Who: Claude applies and reads back after Kevin approves. Kevin approves again before PR B merges.
   - Before the apply, check that `select max(created_at) from drizzle.__drizzle_migrations` returns `1793404800000` (migration `0118`). Then only `0119` applies. If it returns another value, stop and tell Kevin.
   - Apply only `0119`. Do not apply other pending migrations.
   - Read back: the ledger has a row with `created_at` `1793491200000` (the journal entry `0119_hiring_visit_automation`). `select conname, pg_get_constraintdef(oid) from pg_constraint where conname in ('hiring_stage','hiring_mock_window','hiring_bookings_status_check')` shows the four new stages, no weekday or time terms in `hiring_mock_window`, and `no_show` in the status check. This work-rights backfill check returns 0:
     ```sql
     SELECT count(*) FROM hiring_candidates WHERE work_rights_confirmed IS TRUE AND work_rights_answer IS DISTINCT FROM 'I have permanent work rights with no restrictions';
     ```
   - Merge PR B only after the migration is applied. The new code selects the new columns.
   - **Rollback warning.** After the first settings save on the new code, the old code's strict check rejects the new settings keys. To go back, remove these keys from `hiring_settings.config`: `preScreenLimits`, `onsiteLimits`, `preScreenFollowUp`, `onsiteFollowUp`, `preScreenThreshold`, `preScreenWeights`, `acceptedWorkRights`, `seenWorkRights`, `subjectPriority`, `visitStartMinute`, `visitEndMinute`, `resumeRetentionMonths`. The exact SQL is in the description of PR B (#242). The Codex task `CW-20261101-hiring-university-seed` must rebase after PR B merges, for the same reason.
3. **Merge PR C (#243) and PR D (#244) in that order.** Who: Claude merges after Kevin approves each. Vercel deploys each merge. Automation and Messages stay off. PR C holds the queue and the visit. PR D holds the screens.
4. **Save Gift's hours on the Rules page, straight after PR D deploys.** Who: Kevin, or Claude with Kevin watching, in Rules and setup under Head office days. Tick Monday to Friday for Gift and save. A day you add gets 10:00 to 16:00. Do this before any pass and before Automation. Gift is the only head for 11 subjects, and Gift is not enrolled in Tutor Attendance, so these saved hours are the only source of Gift's hours. Until they are saved, an old-flow mock link for a Gift-only subject shows no times and gives the LINE contact. Today one candidate is at `paper_passed`. If Gift is missing under Mock interviewers, add Gift, save the rules, then set the days.
5. **Merge PR E (#245).** Who: Claude merges after Kevin approves. Vercel deploys it. PR E holds the résumés, the passes and this page. The résumé upload route lives here, so deploy PR E before the SEEK pass.
6. **Test the SEEK pass on 5 candidates.** Who: Claude runs it on the Mac after Kevin approves.
   - If SEEK is signed out, run `npm run hiring:worker -- --connect-seek` first and sign in.
   - Stop any paused `--watch` worker first. It holds the worker lock, and the pass cannot start while it runs.
   - Run `HIRING_WRITES_ENABLED=true HIRING_BACKFILL_UNTIL=<ISO time> npm run hiring:backfill -- --seek --limit 5`.
   - Check the counts: `read` is 5, `filesStored` is near 5, and `readFailed` is 0.
   - Check those 5 rows in the Hiring panel. The table row has a **Résumé** button. The panel section **Original résumé** must not say "(no file yet)". A PDF must show in the frame, and a Word file must show **Download**.
   - Read the real labels on the SEEK page. The pass looks for a button or tab named "Resumé" (one accent, SEEK's spelling) and a button named "Download document". If `read` is 5 but `filesStored` is 0, SEEK may use different labels. Stop and tell Claude.
7. **Run the full SEEK pass.** Who: Claude runs it after Kevin approves. Use a stop time about 5 hours ahead. Expect 3 to 4 hours. The pass is finished only when the process exits with code 0 **and** the summary says `stoppedEarly: false`. If it stopped early, or the SEEK list changed while it ran, run the same command again. It skips candidates that are already read. Read the summary: `newWorkRightsAnswers` lists how many new answers appeared. Each new answer shows in Rules as not accepted.
8. **Run the tracker report.** Who: Claude runs `npm run hiring:backfill -- --tracker-report`. The `Hiring Automation` tab holds at most 2,000 candidates. If the current number of candidates (654 on 1 November 2026) plus the `sourcing` and `scheduling` counts is over 2,000, stop and tell Kevin. Run `--tracker-import` only if Kevin approves the counts.
9. **Score the held responses and write the short lines.** Who: Claude runs both on the Mac after Kevin approves. Automation and Messages must be off.
   - `HIRING_WRITES_ENABLED=true npm run hiring:score -- --pre-screen`
   - `HIRING_WRITES_ENABLED=true HIRING_SCORE_UNTIL=<ISO time> npm run hiring:score -- --briefs`
   - Each pass uses Kevin's Claude subscription allowance. `--briefs` refuses to start without `HIRING_SCORE_UNTIL`. Exit code 2 means some answers were not stored. Run the pass again.
10. **Kevin decides about the PDF link.** Kevin chooses to keep the warning line, to open PDFs in a new tab, or to render with pdf.js (see [Résumé files](../../features/hiring.md#résumé-files)). Claude makes any code change as a new pull request.
11. **Kevin reviews the scores and sets the rules.** Who: Kevin, in Rules and setup. Kevin reads the spread of the pre-screen scores and sets the pass score. Kevin ranks the subjects and sets each head's days. Kevin ticks the SEEK work-rights answers he accepts. Kevin checks the limits.
12. **Count before the switch.** Who: Claude, read-only, then reports to Kevin. Count the rows that would leave `new` for review at the first cycle. Count the tracker rows whose hash changed. On 2 November 2026, 6 of 335 `new` candidates would move to review for a `not_met` degree. The 2 candidates at `pre_screen` may go to No reply on the first cycle, with no reminder, because their sends are old. Kevin approves the counts.
13. **Kevin turns on Automation and Messages.** Who: Kevin in Rules and setup. Messages needs the organizer's Google Calendar connected, or the save is refused. The save bar shows how many forms a day and a week the limits allow. Then Claude runs `npm run hiring:worker -- --once` on the Mac. Claude checks every recipient against the limits and checks the provider readbacks.
14. **Load the worker agent.** Who: Claude, after step 13 passes and Kevin approves. Install the LaunchAgent from the template (see [Setup](../../features/hiring.md#setup)).
