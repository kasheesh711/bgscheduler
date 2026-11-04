# Hiring call queue Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** HR calls every gate-passing candidate with a profile score at or above `callThreshold` (80) before the pre-screen form can go; good call releases them to the send queue, bad call stops them, no answer keeps them waiting.

**Architecture:** The call rule lives inside `profileGate` (`src/lib/hiring/insights.ts`), so every existing path that reads the gate (the queue read, the release row-lock check, hold notes, the "ready" count) obeys it with no new branch. A `call_review` jsonb column holds the good call and the tries. A new `callQueue` read and `recordCall` action live in `queue.ts`; a new **Calls** tab reuses the Seek screen's résumé panel.

**Tech Stack:** Next.js 16, Drizzle 0.45, Postgres, Zod 4, Vitest + Testcontainers.

**Spec:** `docs/superpowers/specs/2026-11-04-hiring-call-queue-design.md`

## Global Constraints

- `callThreshold`: integer 0–100 or `null` (off), `.default(80)`; refused when below `profileThreshold`.
- A call result never queues an outbox row and never changes `stage` or `revision`.
- Every call click takes `lockQueue` and writes an `audit` row.
- Migration `0123` (0122 is taken by `feat/hiring-campaigns`).
- Bangkok times on screen.

## Review Focus

- A candidate at exactly 80 needs a call; 79 does not. (Task 1 test.)
- A good-called candidate who also has earlier contact still passes the gate. (Task 1 test.)
- `callThreshold: null` puts nobody in the call queue and gates nobody. (Task 1 test.)
- A click on a candidate who left the call queue (stopped, invited by hand) gets 409. (Task 2 test.)
- A SEEK stop still stops a good-called candidate. (Task 3 test.)

---

### Task 1: Setting, column, gate rule

**Files:**
- Modify: `src/lib/hiring/model.ts` (schema field + `configRuleErrors`), `src/lib/hiring/limits.ts` (type), `src/lib/hiring/insights.ts` (`profileGate`), `src/lib/db/schema.ts`, `src/lib/hiring/queue.ts` (`preScreenQueue` select adds `callReview`)
- Create: `drizzle/0123_hiring_call_review.sql` + journal entry
- Test: `src/lib/hiring/__tests__/insights.test.ts`, `src/lib/hiring/__tests__/rules.test.ts` (or wherever `configRuleErrors` is tested)

**Interfaces:**
- Produces: `type CallReview = { good: { at: string; by: string; manual?: true } | null; tries: { at: string; by: string }[] }` in `limits.ts`; column `callReview: jsonb("call_review").$type<CallReview>()`; `profileGate(candidate & { callReview?: CallReview | null }, config)` now also returns `awaitingCall: boolean`.

- [ ] Tests: score 80, no call → `eligible false`, `awaitingCall true`, `short` includes `"Waiting for a call"`; score 79 → eligible; score 85 with `callReview.good` → eligible; good call + `previouslyContacted` → eligible; `callThreshold: null` → eligible at 95; `configRuleErrors` refuses `callThreshold 50` with `profileThreshold 60`.
- [ ] Run, see them fail.
- [ ] Implement: `callThreshold: z.number().int().min(0).max(100).nullable().default(80)`; gate adds a non-final reason `"HR must call this candidate first."` / `"Waiting for a call"` when score ≥ `callThreshold` and no good call; skip the earlier-contact reason when a good call exists. Add `callThreshold`/`profileThreshold` to `GateConfig` and `configRuleErrors` picks.
- [ ] Run unit tests for hiring: `npx vitest run src/lib/hiring` → PASS.
- [ ] Commit.

### Task 2: Call queue read, call action, hand invite, API

**Files:**
- Modify: `src/lib/hiring/queue.ts`, `src/lib/hiring/service.ts` (dashboard payload `callQueue`; hand-invite branch records good call), `src/app/api/hiring/route.ts`
- Test: `src/lib/hiring/__tests__/queue.integration.test.ts`

**Interfaces:**
- Consumes: Task 1 types.
- Produces: `callQueue(db, config): Promise<QueueEntry[]>` — same base read as `preScreenQueue`, keeps rows whose gate fails only for `awaitingCall`, sorted score desc, then `createdAt` asc, then id; `recordCall(id: string, result: "good" | "no_answer", actor: string, db, now): Promise<void>`; dashboard field `callQueue: string[]`; API command `{ action: "call_result", id: uuid, result: "good" | "no_answer" }`.

- [ ] Integration tests: candidate at 85 → no form row after `releaseQueues`, present in `callQueue`; after `recordCall good` → form row queued by `releaseQueues`; candidate at 70 → form row at once; `no_answer` twice → two tries, still in `callQueue`, no outbox row, `revision` unchanged; `recordCall` on a stopped candidate → 409; hand `advance` on an uncalled 85 → form queued and `callReview.good.manual === true`.
- [ ] Run, see them fail.
- [ ] Implement.
- [ ] `npx vitest run --project integration src/lib/hiring/__tests__/queue.integration.test.ts` → PASS.
- [ ] Commit.

### Task 3: SEEK moves after a good call

**Files:**
- Modify: `src/lib/hiring/sources.ts` (`observeSeekState`)
- Test: `src/lib/hiring/__tests__/workflow.integration.test.ts` (existing `observeSeekState` tests)

- [ ] Tests: good-called `new` candidate with SEEK status "Shortlist" stays `new`; good-called candidate at `pre_screen` with a pending form and a new SEEK contact keeps the form row `pending`; good-called candidate with "Not Suitable" is `stopped`.
- [ ] Run, see them fail.
- [ ] Implement: `externallyAdvanced` false when `callReview?.good`; on new contact with a good call, the cancel excludes key `${id}:pre-screen`.
- [ ] Run → PASS. Commit.

### Task 4: Calls tab and setting field

**Files:**
- Create: `src/components/hiring/calls-screen.tsx`, `src/components/hiring/__tests__/calls-screen.test.tsx`
- Modify: `src/components/hiring/dashboard.tsx` (`VIEWS.calls = "Calls"` between seek and prescreen), `src/components/hiring/seek-screen.tsx` (export `SeekPanel`), `src/components/hiring/setup-panel.tsx` (call score input beside profile threshold, blank = off)

- [ ] Component tests: rows sorted as `data.callQueue`; **Good call** posts `{action:"call_result", id, result:"good"}`; **No answer** posts `result:"no_answer"`; **Bad call** asks `window.confirm` and posts `{action:"stop", id, revision, subjects, reason:"Bad call before the pre-screen form."}`; empty queue text "Nobody is waiting for a call."; the row shows tries count and last try time.
- [ ] Implement; row click opens `SeekPanel`.
- [ ] `npx vitest run src/components/hiring` → PASS. Commit.

### Task 5: Docs and checks

- [ ] `docs/features/hiring.md`: a **Calls** section, the gate line, the setting, the SEEK rule.
- [ ] `npm run typecheck`, `npm test`, hiring integration suites, `npm run lint` on changed files.
- [ ] code-reviewer agent, then verifier agent. Commit, push, open a draft PR.
