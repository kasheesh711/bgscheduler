# Tutor Offboarding PR 1 (read-only dashboard) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Ship `/tutor-offboarding`: a read-only page that scores every tutor on the Wise roster by how likely they have left BeGifted, explains each score in plain words, lets admins mark "Still with us", shows Wise ADMIN accounts read-only, and lets the owner manage who may remove tutors (removal itself is PR 2).

**Architecture:** The 30-minute snapshot sync additionally persists four roster details per Wise account (best effort, after promotion). A pure calibration module turns BeGifted's own teaching history into a return-rate curve; a pure score module combines the curve with evidence into a likelihood, band, reasons and exclusions. A signals loader reads everything from Postgres (cached per snapshot); decisions and grants are read fresh. API routes use Shape B error handling; the page is an async Server Component around a client workspace.

**Tech Stack:** Next.js 16 App Router (`cacheComponents: true`, `"use cache"`), React 19, TypeScript, Drizzle ORM 0.45 on Neon Postgres, Zod 4, Tailwind 4 + shadcn/ui over `@base-ui/react`, Vitest 4 (unit + Testcontainers integration).

**Spec:** [`docs/superpowers/specs/2026-10-01-tutor-offboarding-design.md`](../specs/2026-10-01-tutor-offboarding-design.md). PR 1 covers spec §4 (scoring), §5 (dashboard), §7 migration A, §8.1 rows marked PR 1, §9, §10 for PR 1, §11 step 1.

## Global Constraints

- **Read-only toward Wise.** PR 1 adds no Wise write code and makes no Wise call on any request path. The only new Wise-derived data is persisted by the existing sync from the roster it already fetches.
- **PR 2 scope stays out:** selection checkboxes, the sticky Remove bar, removal runs and the History tab's run list are PR 2. PR 1 shows each person's removal check as text in the drawer only.
- **React SSR text:** component tests render with `renderToStaticMarkup`, which separates adjacent text nodes with `<!-- -->`. Any text a test asserts as one string must be rendered as one template literal.
- **OFF-02:** an unknown signal (null column, failed availability fetch) contributes nothing to a score and is never evidence of departure.
- **OFF-03:** any account with Wise `relation = ADMIN` is never in the review list; it appears only in the read-only Staff accounts panel.
- **OFF-07:** active snapshot older than 2 hours, or another feed's last successful run older than 3 days → amber banner, scores provisional. Judge the snapshot by `snapshots.created_at`, never `sync_runs.status` (promoted runs are recorded `failed` whenever contact warnings exist).
- **Decision IDs `OFF-01`…`OFF-14` are load-bearing:** cite the ID in a comment wherever a rule is implemented.
- **Missing tables never 500 a GET:** a 42P01/42703 SQLSTATE becomes the typed `{ available: false, reason: "not_set_up" }` payload.
- **Conventions:** kebab-case files; tests in a sibling `__tests__/`; double quotes; semicolons; named exports only (pages/routes excepted); `db: Database = getDb()` as a defaulted trailing parameter; `console.error` only, logging error name + SQLSTATE, never bodies, emails or notes.
- **Instants are ISO strings** in every payload (cacheable, client-safe). Bangkok day math uses `bangkokDateKey` from `@/lib/room-capacity/dates`.
- **Copy is plain language** for non-technical admins: "likelihood", "last class", "still with us"; no "model", "logit", "probability".
- **Fixtures use made-up names and `@example.com` emails only.** Never real tutor names.
- **Migration:** hand-written SQL plus a journal entry; take the next free number at build time (this plan says `0102`; the autowriter plans earmark 0102–0104, so renumber if `origin/main` already has it). Never commit untrimmed `db:generate` output. Applying it to production needs the owner's word. Apply 0102 to production BEFORE PR 1 merges: the sync's reads of `tutor_wise_accounts` name the new columns.
- **Worktree:** work only in `.claude/worktrees/slot-a` on branch `feat/tutor-offboarding`. No local `npm run build` (CI builds).
- **Every commit message ends with** `Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>`.
- **PR stays draft** until a reviewer reports CLEAR; merge only with the owner's OK.

---

## File Structure

| File | Responsibility |
|---|---|
| `drizzle/0102_tutor_offboarding.sql` (create) | Migration A: 4 roster columns + 3 tables |
| `drizzle/meta/_journal.json` (modify) | Journal entry for 0102 |
| `src/lib/db/schema.ts` (modify) | Drizzle declarations matching the migration |
| `src/tests/integration/db-helper.ts` (modify) | `truncateAll` covers new and newly seeded tables |
| `src/lib/wise/types.ts` (modify) | Optional roster fields on `WiseTeacher` / `WiseUserReference` |
| `src/lib/tutor-onboarding/roster-facts.ts` (create) | `extractRosterFacts` (pure) + `persistRosterFacts` (one bulk UPDATE) |
| `src/lib/db/sql-state.ts` (create) | `sqlStateOf`: SQLSTATE of a driver or Drizzle error (`code ?? cause.code`, never message text); used by the sync's roster step and by Task 5 |
| `src/lib/sync/orchestrator.ts` (modify) | Best-effort roster-facts step after promotion; result in run metadata |
| `src/lib/tutor-offboarding/calibration.ts` (create) | Pure: taught dates → return-rate curve; base likelihood for a gap |
| `src/lib/tutor-offboarding/types.ts` (create) | Every Tutor Offboarding type |
| `src/lib/tutor-offboarding/day-label.ts` (create) | "3 Jun" Bangkok day labels with fixed month names (server = browser) |
| `src/lib/tutor-offboarding/score.ts` (create) | Pure: signals + curve → likelihood, band, reasons, exclusion, removability |
| `src/lib/tutor-offboarding/signals.ts` (create) | Postgres loaders: people + history (`loadOffboardingSignals`), feed timestamps |
| `src/lib/tutor-offboarding/errors.ts` (create) | `TutorOffboardingError`, `isMissingSchemaError` |
| `src/lib/tutor-offboarding/decisions.ts` (create) | Still-with-us decisions store |
| `src/lib/tutor-offboarding/grants.ts` (create) | Removal-grant store (OFF-11) |
| `src/lib/tutor-offboarding/access.ts` (create) | `viewerForEmail`, `requireTutorOffboardingAdmin` |
| `src/lib/tutor-offboarding/api.ts` (create) | Shape B `tutorOffboardingErrorResponse` |
| `src/lib/tutor-offboarding/data.ts` (create) | Pure dashboard builder, freshness, open decisions |
| `src/lib/tutor-offboarding/service.ts` (create) | Cached signals + dashboard loading (server-only) |
| `src/app/api/tutor-offboarding/**/route.ts` (create ×4) | GET dashboard; POST/DELETE decisions; GET/POST grants |
| `src/components/tutor-offboarding/*.tsx|ts` (create) | Atoms, format helpers, row, inbox, detail/drawer, dialog, rail, grants, history, workspace |
| `src/app/(app)/tutor-offboarding/page.tsx` (create) | Async Server Component + skeleton |
| `src/lib/navigation/tools.ts` (modify) | Nav entry "Tutor Offboarding" |
| `scripts/dev/render-tutor-offboarding.mjs` (create) | Fixture render to PNG for owner review |
| `.gitignore` (modify) | Ignore `.tutor-offboarding/` previews |
| `docs/features/tutor-offboarding.md`, `docs/reference/api/tutor-offboarding.md` (create); `docs/reference/api/index.md`, `docs/reference/database/index.md`, `docs/reference/wise-api.md` (modify) | Docs |

---

### Task 0: Prepare the worktree

**Files:** none.

- [ ] **Step 1: Confirm the branch and clean tree**

```bash
cd /Users/kevinhsieh/Developer/Scheduling/.claude/worktrees/slot-a
git status --short --branch
```

Expected: `## feat/tutor-offboarding...origin/main [ahead 2]` (the spec and this plan) and no other lines.

- [ ] **Step 2: Rebase onto the latest main and check the migration number**

```bash
git fetch origin && git rebase origin/main
ls drizzle | grep -E '^[0-9]{4}_' | tail -1
```

Expected: the last file is `0101_feedback_autowriter_review.sql`. If a `0102_*` exists, use the next free number everywhere this plan says `0102` (file name, journal `idx`, `tag`).

- [ ] **Step 3: Install dependencies by clone**

```bash
scripts/dev/worktrees.sh deps slot-a
```

Expected: ends with node_modules cloned (or `npm ci` when no checkout has this lockfile). Then `npx vitest --version` prints 4.x.

---

### Task 1: Migration A and roster facts persisted by the sync

**Files:**
- Create: `drizzle/0102_tutor_offboarding.sql`
- Modify: `drizzle/meta/_journal.json` (append one entry)
- Modify: `src/lib/db/schema.ts` (`tutorWiseAccounts` block; append section at end of file)
- Modify: `src/tests/integration/db-helper.ts` (`truncateAll` list)
- Modify: `src/lib/wise/types.ts:3-16`
- Create: `src/lib/tutor-onboarding/roster-facts.ts`
- Modify: `src/lib/sync/orchestrator.ts` (imports; after the modality-history block; final metadata update)
- Test: `src/lib/tutor-onboarding/__tests__/roster-facts.test.ts`
- Test: `src/lib/tutor-onboarding/__tests__/roster-facts.integration.test.ts`

**Interfaces:**
- Consumes: `WiseTeacher` (`src/lib/wise/types.ts`), `Database` (`@/lib/db`).
- Produces:
  - `interface RosterFact { wiseTeacherId: string; relation: string | null; joinedOn: Date | null; courseCount: number | null; activated: boolean | null }`
  - `extractRosterFacts(teachers: WiseTeacher[]): RosterFact[]`
  - `persistRosterFacts(db: Database, facts: RosterFact[]): Promise<number>` (rows changed)
  - Schema: `tutorWiseAccounts.wiseRelation | wiseJoinedOn | wiseCourseCount | wiseActivated`; tables `tutorOffboardingDecisions`, `tutorOffboardingAccessGrants`, `tutorOffboardingAccessAuditLog`.
  - `sync_runs.metadata.rosterFacts: { updated?: number; error?: string }`.

- [ ] **Step 1: Write the failing unit test**

Create `src/lib/tutor-onboarding/__tests__/roster-facts.test.ts`:

```ts
import { describe, expect, it } from "vitest";
import type { WiseTeacher } from "@/lib/wise/types";
import { extractRosterFacts } from "../roster-facts";

describe("extractRosterFacts", () => {
  it("reads relation, joined date, course count and login activation from a live roster row", () => {
    const teacher: WiseTeacher = {
      _id: "t1",
      userId: { _id: "u1", name: "Aria (Aria)", activated: true },
      relation: "teacher",
      joinedOn: "2026-08-15T03:00:00.000Z",
      classes: [{ _id: "c1", name: "Maths" }, "c2"],
    };
    expect(extractRosterFacts([teacher])).toEqual([{
      wiseTeacherId: "t1",
      relation: "TEACHER",
      joinedOn: new Date("2026-08-15T03:00:00.000Z"),
      courseCount: 2,
      activated: true,
    }]);
  });

  it("keeps every missing or malformed field unknown (null), never a guessed value (OFF-02)", () => {
    expect(extractRosterFacts([
      { _id: "t2", userId: "u2" },
      { _id: "t3", userId: { _id: "u3" }, relation: "  ", joinedOn: "not a date", classes: "x" as never },
    ])).toEqual([
      { wiseTeacherId: "t2", relation: null, joinedOn: null, courseCount: null, activated: null },
      { wiseTeacherId: "t3", relation: null, joinedOn: null, courseCount: null, activated: null },
    ]);
  });

  it("counts an explicitly empty course list as zero", () => {
    expect(extractRosterFacts([{ _id: "t4", classes: [] }])[0].courseCount).toBe(0);
  });
});
```

- [ ] **Step 2: Run it to verify it fails**

Run: `npx vitest run --project unit src/lib/tutor-onboarding/__tests__/roster-facts.test.ts`
Expected: FAIL — `Failed to resolve import "../roster-facts"`.

- [ ] **Step 3: Add the roster fields to the Wise types**

In `src/lib/wise/types.ts`, replace the `WiseUserReference` and `WiseTeacher` interfaces (lines 3-16) with:

```ts
export interface WiseUserReference {
  _id: string;
  name?: string;
  email?: string;
  /** True once the user has activated their Wise login (live roster only). */
  activated?: boolean;
  phoneNumber?: string;
  [key: string]: unknown;
}

/** A course the live roster lists under a teacher. */
export interface WiseTeacherClassReference {
  _id: string;
  name?: string;
  subject?: string;
  [key: string]: unknown;
}

export interface WiseTeacher {
  _id: string;
  userId?: string | WiseUserReference;
  name?: string;
  tags?: WiseTag[];
  /** Live-roster extras (Tutor Offboarding). Optional: fixtures and older payloads omit them. */
  relation?: string;
  joinedOn?: string;
  status?: string;
  updatedAt?: string;
  classes?: Array<WiseTeacherClassReference | string>;
  [key: string]: unknown;
}
```

- [ ] **Step 4: Write `extractRosterFacts` and `persistRosterFacts`**

Create `src/lib/tutor-onboarding/roster-facts.ts`:

```ts
import { sql } from "drizzle-orm";
import type { Database } from "@/lib/db";
import type { WiseTeacher } from "@/lib/wise/types";

/** Roster details of one Wise teacher account that Tutor Offboarding scores on. Null = unknown (OFF-02). */
export interface RosterFact {
  wiseTeacherId: string;
  relation: string | null;
  joinedOn: Date | null;
  courseCount: number | null;
  activated: boolean | null;
}

/** Pure: the roster details of each teacher row, with anything missing or malformed left unknown. */
export function extractRosterFacts(teachers: WiseTeacher[]): RosterFact[] {
  return teachers.map((teacher) => {
    const user = typeof teacher.userId === "object" && teacher.userId !== null ? teacher.userId : null;
    const relation = typeof teacher.relation === "string" ? teacher.relation.trim().toUpperCase() : "";
    const joined = typeof teacher.joinedOn === "string" ? new Date(teacher.joinedOn) : null;
    return {
      wiseTeacherId: teacher._id,
      relation: relation || null,
      joinedOn: joined && !Number.isNaN(joined.getTime()) ? joined : null,
      courseCount: Array.isArray(teacher.classes) ? teacher.classes.length : null,
      activated: typeof user?.activated === "boolean" ? user.activated : null,
    };
  });
}

/**
 * Writes roster details onto `tutor_wise_accounts` in one statement and returns how many rows changed.
 * Accounts not on the roster (absent) are untouched and keep their last known values. The sync calls this
 * after promotion, outside the promotion transaction, and treats a failure as non-fatal.
 */
export async function persistRosterFacts(db: Database, facts: RosterFact[]): Promise<number> {
  if (facts.length === 0) return 0;
  const values = sql.join(facts.map((fact) => sql`(${fact.wiseTeacherId}::text, ${fact.relation}::text, ${
    fact.joinedOn ? fact.joinedOn.toISOString() : null}::timestamptz, ${fact.courseCount}::integer, ${fact.activated}::boolean)`), sql`, `);
  const result = await db.execute(sql`
    update tutor_wise_accounts as account set
      wise_relation = fact.relation,
      wise_joined_on = fact.joined_on,
      wise_course_count = fact.course_count,
      wise_activated = fact.activated
    from (values ${values}) as fact(wise_teacher_id, relation, joined_on, course_count, activated)
    where account.wise_teacher_id = fact.wise_teacher_id
      and (account.wise_relation, account.wise_joined_on, account.wise_course_count, account.wise_activated)
        is distinct from (fact.relation, fact.joined_on, fact.course_count, fact.activated)
    returning account.wise_teacher_id
  `);
  return result.rows.length;
}
```

- [ ] **Step 5: Run the unit test to verify it passes**

Run: `npx vitest run --project unit src/lib/tutor-onboarding/__tests__/roster-facts.test.ts`
Expected: PASS (3 tests).

- [ ] **Step 6: Declare the schema**

In `src/lib/db/schema.ts`, in `export const tutorWiseAccounts = pgTable("tutor_wise_accounts", {`, replace

```ts
  status: text("status").notNull(),
  lastSnapshotId: uuid("last_snapshot_id").notNull(),
```

with

```ts
  status: text("status").notNull(),
  // Tutor Offboarding roster details (OFF-02: null = unknown), written best-effort after each promotion.
  wiseRelation: text("wise_relation"),
  wiseJoinedOn: timestamp("wise_joined_on", { withTimezone: true }),
  wiseCourseCount: integer("wise_course_count"),
  wiseActivated: boolean("wise_activated"),
  lastSnapshotId: uuid("last_snapshot_id").notNull(),
```

Append at the end of `src/lib/db/schema.ts`:

```ts
// ── Tutor Offboarding ────────────────────────────────────────────────

/** "Still with us" decisions on the departed-tutor detector; each keeps the score it overrode (future labels). */
export const tutorOffboardingDecisions = pgTable("tutor_offboarding_decisions", {
  id: uuid("id").primaryKey().defaultRandom(),
  canonicalKey: text("canonical_key").notNull(),
  kind: text("kind").notNull().default("still_with_us"),
  note: text("note"),
  snoozeUntil: timestamp("snooze_until", { withTimezone: true }).notNull(),
  likelihoodAtDecision: integer("likelihood_at_decision").notNull(),
  bandAtDecision: text("band_at_decision").notNull(),
  reasons: jsonb("reasons").$type<string[]>().notNull().default([]),
  decidedByEmail: text("decided_by_email").notNull(),
  decidedAt: timestamp("decided_at", { withTimezone: true }).notNull().defaultNow(),
  revokedAt: timestamp("revoked_at", { withTimezone: true }),
  revokedByEmail: text("revoked_by_email"),
}, (table) => [
  index("tod_open_key_idx").on(table.canonicalKey).where(sql`${table.revokedAt} is null`),
  index("tod_decided_at_idx").on(table.decidedAt),
  check("tod_kind_check", sql`${table.kind} in ('still_with_us')`),
  check("tod_band_check", sql`${table.bandAtDecision} in ('very_likely_gone', 'likely_gone', 'unclear', 'active')`),
]);

/** OFF-11: who may remove departed tutors from Wise. Managed by the owner; read fresh on every request. */
export const tutorOffboardingAccessGrants = pgTable("tutor_offboarding_access_grants", {
  email: text("email").primaryKey(),
  grantedByEmail: text("granted_by_email").notNull(),
  grantedAt: timestamp("granted_at", { withTimezone: true }).notNull().defaultNow(),
});

/** Immutable history of removal-grant changes. */
export const tutorOffboardingAccessAuditLog = pgTable("tutor_offboarding_access_audit_log", {
  id: uuid("id").primaryKey().defaultRandom(),
  action: text("action").notNull(),
  email: text("email").notNull(),
  actorEmail: text("actor_email").notNull(),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
}, (table) => [
  index("toaal_created_at_idx").on(table.createdAt),
  check("toaal_action_check", sql`${table.action} in ('grant', 'revoke')`),
]);
```

- [ ] **Step 7: Write the migration and journal entry**

Create `drizzle/0102_tutor_offboarding.sql`:

```sql
-- Tutor Offboarding PR 1, migration A (spec docs/superpowers/specs/2026-10-01-tutor-offboarding-design.md §7).
-- Additive only: four nullable roster columns and three new tables. OWNER GATE: apply this BEFORE deploying the
-- code that declares these columns, because the sync reads and upserts tutor_wise_accounts by column name (a
-- missing column fails every sync with 42703). Applying it early is safe for the code live today: additive, nullable.
ALTER TABLE "tutor_wise_accounts" ADD COLUMN "wise_relation" text;
--> statement-breakpoint
ALTER TABLE "tutor_wise_accounts" ADD COLUMN "wise_joined_on" timestamp with time zone;
--> statement-breakpoint
ALTER TABLE "tutor_wise_accounts" ADD COLUMN "wise_course_count" integer;
--> statement-breakpoint
ALTER TABLE "tutor_wise_accounts" ADD COLUMN "wise_activated" boolean;
--> statement-breakpoint
CREATE TABLE "tutor_offboarding_decisions" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"canonical_key" text NOT NULL,
	"kind" text DEFAULT 'still_with_us' NOT NULL,
	"note" text,
	"snooze_until" timestamp with time zone NOT NULL,
	"likelihood_at_decision" integer NOT NULL,
	"band_at_decision" text NOT NULL,
	"reasons" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"decided_by_email" text NOT NULL,
	"decided_at" timestamp with time zone DEFAULT now() NOT NULL,
	"revoked_at" timestamp with time zone,
	"revoked_by_email" text,
	CONSTRAINT "tod_kind_check" CHECK ("tutor_offboarding_decisions"."kind" in ('still_with_us')),
	CONSTRAINT "tod_band_check" CHECK ("tutor_offboarding_decisions"."band_at_decision" in ('very_likely_gone', 'likely_gone', 'unclear', 'active'))
);
--> statement-breakpoint
CREATE INDEX "tod_open_key_idx" ON "tutor_offboarding_decisions" USING btree ("canonical_key") WHERE "tutor_offboarding_decisions"."revoked_at" is null;
--> statement-breakpoint
CREATE INDEX "tod_decided_at_idx" ON "tutor_offboarding_decisions" USING btree ("decided_at");
--> statement-breakpoint
CREATE TABLE "tutor_offboarding_access_grants" (
	"email" text PRIMARY KEY NOT NULL,
	"granted_by_email" text NOT NULL,
	"granted_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "tutor_offboarding_access_audit_log" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"action" text NOT NULL,
	"email" text NOT NULL,
	"actor_email" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "toaal_action_check" CHECK ("tutor_offboarding_access_audit_log"."action" in ('grant', 'revoke'))
);
--> statement-breakpoint
CREATE INDEX "toaal_created_at_idx" ON "tutor_offboarding_access_audit_log" USING btree ("created_at");
```

In `drizzle/meta/_journal.json`, append this object to the end of the `entries` array (after the `0101_feedback_autowriter_review` entry; keep the array sorted by `idx`, and `when` above `1790740000000`):

```json
    {
      "idx": 102,
      "version": "7",
      "when": 1790830000000,
      "tag": "0102_tutor_offboarding",
      "breakpoints": true
    }
```

- [ ] **Step 8: Let the integration helper truncate the new and newly seeded tables**

In `src/tests/integration/db-helper.ts`, inside `truncateAll`, replace the first two lines of the table list

```
      tutor_sit_in_assignments,
      tutor_sit_in_grants,
```

with

```
      tutor_offboarding_decisions,
      tutor_offboarding_access_grants,
      tutor_offboarding_access_audit_log,
      progress_test_attendance_ledger,
      progress_test_sync_runs,
      wise_activity_events,
      wise_activity_sync_runs,
      leave_requests,
      leave_request_sync_runs,
      tutor_attendance_enrollments,
      tutor_sit_in_assignments,
      tutor_sit_in_grants,
```

(`RESTART IDENTITY CASCADE` already empties any table that references these.)

- [ ] **Step 9: Write the failing integration test**

Create `src/lib/tutor-onboarding/__tests__/roster-facts.integration.test.ts`:

```ts
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { eq } from "drizzle-orm";
import { startTestDb, stopTestDb, truncateAll } from "@/tests/integration/db-helper";
import type { Database } from "@/lib/db";
import * as schema from "@/lib/db/schema";
import { runFullSync } from "@/lib/sync/orchestrator";
import type { WiseTeacher } from "@/lib/wise/types";
import { persistRosterFacts } from "../roster-facts";

let handle: Awaited<ReturnType<typeof startTestDb>>;
let db: Database;
const SNAPSHOT_ID = "00000000-0000-4000-8000-000000000001";

beforeAll(async () => { handle = await startTestDb(); db = handle.db as unknown as Database; });
afterAll(async () => { if (handle) await stopTestDb(handle); });
beforeEach(async () => {
  await truncateAll(handle.db);
});

async function seedAccounts() {
  await handle.db.insert(schema.tutorWiseAccounts).values([
    { wiseTeacherId: "t1", wiseUserId: "u1", canonicalKey: "Aria", displayName: "Aria (Aria)", isOnlineVariant: false,
      email: "aria@example.com", status: "active", lastSnapshotId: SNAPSHOT_ID },
    { wiseTeacherId: "t9", wiseUserId: "u9", canonicalKey: "Gone", displayName: "Gone (Gone)", isOnlineVariant: false,
      email: null, status: "absent", lastSnapshotId: SNAPSHOT_ID, wiseRelation: "TEACHER", wiseCourseCount: 3 },
  ]);
}

async function account(wiseTeacherId: string) {
  const [row] = await handle.db.select().from(schema.tutorWiseAccounts).where(eq(schema.tutorWiseAccounts.wiseTeacherId, wiseTeacherId));
  return row;
}

describe("persistRosterFacts", () => {
  it("writes roster details onto the account rows and counts only rows that changed", async () => {
    await seedAccounts();
    const facts = [{ wiseTeacherId: "t1", relation: "TEACHER", joinedOn: new Date("2026-01-20T00:00:00.000Z"), courseCount: 0, activated: false }];
    expect(await persistRosterFacts(db, facts)).toBe(1);
    expect(await account("t1")).toMatchObject({
      wiseRelation: "TEACHER", wiseJoinedOn: new Date("2026-01-20T00:00:00.000Z"), wiseCourseCount: 0, wiseActivated: false,
    });
    // The same facts again change nothing, so nothing is rewritten.
    expect(await persistRosterFacts(db, facts)).toBe(0);
  });

  it("leaves absent accounts as they were and ignores ids it does not know", async () => {
    await seedAccounts();
    expect(await persistRosterFacts(db, [{ wiseTeacherId: "nope", relation: "ADMIN", joinedOn: null, courseCount: 1, activated: true }])).toBe(0);
    expect(await account("t9")).toMatchObject({ wiseRelation: "TEACHER", wiseCourseCount: 3, status: "absent" });
  });

  it("turns a known value back into unknown when Wise stops sending it, and skips an empty roster", async () => {
    await seedAccounts();
    expect(await persistRosterFacts(db, [])).toBe(0);
    await persistRosterFacts(db, [{ wiseTeacherId: "t1", relation: "TEACHER", joinedOn: null, courseCount: 2, activated: true }]);
    expect(await persistRosterFacts(db, [{ wiseTeacherId: "t1", relation: null, joinedOn: null, courseCount: null, activated: null }])).toBe(1);
    expect(await account("t1")).toMatchObject({ wiseRelation: null, wiseJoinedOn: null, wiseCourseCount: null, wiseActivated: null });
  });
});

describe("snapshot sync", () => {
  it("persists roster details after promotion and records the result in the run metadata", async () => {
    const teachers: WiseTeacher[] = [{
      _id: "t-new",
      userId: { _id: "u-new", name: "New (New) Tutor", email: "new@example.com", activated: true },
      relation: "TEACHER",
      joinedOn: "2026-08-20T00:00:00.000Z",
      classes: [{ _id: "c1", name: "Maths" }],
    }];
    const client = {
      get: async (path: string) => path.endsWith("/teachers") ? { data: { teachers } }
        : path.endsWith("/sessions") ? { data: { sessions: [], page_count: 1 } }
        : { data: { workingHours: { slots: [] }, leaves: [] } },
      getStats: () => ({ requests: 0, byPath: {} }),
    };
    const result = await runFullSync(db, client as never, "institute", { now: new Date("2026-09-06T00:00:00Z") });
    expect(result.promotedSnapshotId).toBeTruthy();
    expect(await account("t-new")).toMatchObject({
      wiseRelation: "TEACHER", wiseJoinedOn: new Date("2026-08-20T00:00:00.000Z"), wiseCourseCount: 1, wiseActivated: true,
    });
    const [run] = await handle.db.select().from(schema.syncRuns);
    expect(run.metadata).toMatchObject({ rosterFacts: { updated: 1 } });
  });
});
```

- [ ] **Step 10: Run it to verify the sync test fails**

Run (Docker must be running; otherwise set `TEST_DATABASE_URL` to a scratch Postgres):
`npx vitest run --project integration src/lib/tutor-onboarding/__tests__/roster-facts.integration.test.ts`
Expected: the three `persistRosterFacts` tests PASS (the migration applies cleanly); `snapshot sync` FAILS — `wiseRelation` is `null` and `metadata` has no `rosterFacts`.

- [ ] **Step 11: Add the best-effort step to the sync**

In `src/lib/sync/orchestrator.ts`, after the import line `import { loadAccountMappings, promoteWithTutorContacts } from "@/lib/tutor-onboarding/sync";` add:

```ts
import { extractRosterFacts, persistRosterFacts } from "@/lib/tutor-onboarding/roster-facts";
```

and, after the line `import * as schema from "@/lib/db/schema";`, add (the helper lives in `src/lib/db/sql-state.ts`, see File Structure):

```ts
import { sqlStateOf } from "@/lib/db/sql-state";
```

Directly after the existing block that ends

```ts
        console.error("[sync-orchestrator] modality history capture failed", modalityHistory.error);
      }
    }
```

insert:

```ts
    // Tutor Offboarding (OFF-02): roster details the detector scores on. A failure of THIS step never blocks a
    // sync: it is best effort and runs outside the promotion transaction. Migration 0102 is different: it must be
    // applied before this code deploys, because the sync's own reads and upserts of tutor_wise_accounts
    // (loadAccountMappings, promoteWithTutorContacts) name these columns, so a missing column fails every sync
    // with 42703. Only the error's name and SQLSTATE are kept: a database error's message is the query and its
    // parameters.
    let rosterFacts: { updated?: number; error?: string } = {};
    if (promotedSnapshotId && importContacts) {
      try {
        rosterFacts = { updated: await persistRosterFacts(db, extractRosterFacts(wiseTeachers)) };
      } catch (error) {
        const errorName = error instanceof Error ? error.name : "UnknownError";
        const sqlState = sqlStateOf(error);
        rosterFacts = { error: `${errorName} (${sqlState ?? "no SQLSTATE"})` };
        console.error("[sync-orchestrator] roster facts capture failed", { errorName, sqlState });
      }
    }
```

Then replace

```ts
          .set({ metadata: { ...successMetadata, pruning, modalityHistory } })
```

with

```ts
          .set({ metadata: { ...successMetadata, pruning, modalityHistory, rosterFacts } })
```

- [ ] **Step 12: Run the integration tests again, plus the onboarding suite**

Run: `npx vitest run --project integration src/lib/tutor-onboarding/__tests__/roster-facts.integration.test.ts src/lib/tutor-onboarding/__tests__/sync.integration.test.ts`
Expected: PASS (all tests in both files).

- [ ] **Step 13: Typecheck and run the sync unit suites**

Run: `npm run typecheck && npx vitest run --project unit src/lib/sync src/lib/tutor-onboarding src/lib/wise`
Expected: no type errors; all PASS.

- [ ] **Step 14: Commit**

```bash
git add drizzle/0102_tutor_offboarding.sql drizzle/meta/_journal.json src/lib/db/schema.ts src/tests/integration/db-helper.ts \
  src/lib/wise/types.ts src/lib/tutor-onboarding/roster-facts.ts src/lib/sync/orchestrator.ts \
  src/lib/tutor-onboarding/__tests__/roster-facts.test.ts src/lib/tutor-onboarding/__tests__/roster-facts.integration.test.ts
git commit -m "$(cat <<'EOF'
Tutor Offboarding: migration A and roster facts persisted by the sync

Adds four nullable roster columns to tutor_wise_accounts plus the decisions and
removal-grant tables. The snapshot sync writes relation, joined date, course
count and login activation best-effort after promotion (OFF-02).

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>
EOF
)"
```

---

### Task 2: Calibration curve from BeGifted's own history

**Files:**
- Create: `src/lib/tutor-offboarding/calibration.ts`
- Test: `src/lib/tutor-offboarding/__tests__/calibration.test.ts`

**Interfaces:**
- Consumes: nothing.
- Produces:
  - `HISTORY_START: Date` (`2026-03-01T00:00:00+07:00`), `HISTORY_START_KEY = "2026-03-01"`
  - `GAP_THRESHOLDS = [21, 30, 45, 60, 90] as const`, `type GapThreshold`
  - `DEFAULT_GONE_PROBABILITY: Record<GapThreshold, number>`, `ACTIVE_BASE_PROBABILITY = 0.03`, `MIN_SAMPLE = 5`
  - `interface CurvePoint { thresholdDays: GapThreshold; returned: number; stillIdle: number; goneProbability: number; usedDefault: boolean }`
  - `interface CalibrationCurve { points: CurvePoint[]; tutorsObserved: number; historyStart: string }`
  - `daysBetweenDateKeys(from: string, to: string): number`
  - `buildCalibrationCurve(taughtDates: ReadonlyMap<string, readonly string[]>, todayKey: string): CalibrationCurve`
  - `baseGoneProbability(curve: CalibrationCurve, gapDays: number): number`

- [ ] **Step 1: Write the failing test**

Create `src/lib/tutor-offboarding/__tests__/calibration.test.ts`:

```ts
import { describe, expect, it } from "vitest";
import {
  ACTIVE_BASE_PROBABILITY,
  baseGoneProbability,
  buildCalibrationCurve,
  daysBetweenDateKeys,
  type CalibrationCurve,
} from "../calibration";

const TODAY = "2026-10-01";

/** The Bangkok date key `days` before 1 Oct 2026. */
function daysBefore(days: number): string {
  return new Date(Date.UTC(2026, 9, 1) - days * 86_400_000).toISOString().slice(0, 10);
}

function probabilities(curve: CalibrationCurve): number[] {
  return curve.points.map((point) => point.goneProbability);
}

describe("daysBetweenDateKeys", () => {
  it("counts calendar days between two date keys", () => {
    expect(daysBetweenDateKeys("2026-03-01", "2026-10-01")).toBe(214);
    expect(daysBetweenDateKeys("2026-10-01", "2026-10-01")).toBe(0);
  });
});

describe("buildCalibrationCurve", () => {
  it("measures returns and still-idle gaps per threshold with Jeffreys smoothing", () => {
    const history = new Map<string, string[]>([
      ["T1", ["2026-09-30"]],
      ["T2", ["2026-09-20"]],
      ["T3", ["2026-08-01"]],
      ["T4", ["2026-06-01"]],
      ["T5", ["2026-05-01"]],
      ["T6", ["2026-04-01"]],
      ["T7", ["2026-03-01", "2026-05-15", "2026-09-29"]], // came back after 75 and 137 days
      ["T8", ["2026-07-01", "2026-08-10", "2026-09-30"]], // came back after 40 and 51 days
    ]);
    const curve = buildCalibrationCurve(history, TODAY);
    expect(curve.tutorsObserved).toBe(8);
    expect(curve.points.map((p) => [p.thresholdDays, p.returned, p.stillIdle, p.usedDefault])).toEqual([
      [21, 4, 4, false],
      [30, 4, 4, false],
      [45, 3, 4, false],
      [60, 2, 4, false],
      [90, 1, 3, true], // only 4 observations: the default stands
    ]);
    const [p21, p30, p45, p60, p90] = probabilities(curve);
    expect(p21).toBeCloseTo(0.5, 6); // 1 - (4 + 0.5) / (4 + 4 + 1)
    expect(p30).toBeCloseTo(0.5, 6);
    expect(p45).toBeCloseTo(0.5625, 6); // 1 - 3.5 / 8
    expect(p60).toBeCloseTo(0.642857, 5); // 1 - 2.5 / 7
    expect(p90).toBe(0.96);
  });

  it("never lets a longer gap look less final than a shorter one", () => {
    // Five tutors came back after 63-70 days; nobody is idle past 60 days today.
    const history = new Map([63, 64, 65, 66, 70].map((gap, index) => [`T${index}`, [daysBefore(50 + gap), daysBefore(50)]]));
    const curve = buildCalibrationCurve(history, TODAY);
    expect(curve.points[3]).toMatchObject({ thresholdDays: 60, returned: 5, stillIdle: 0, usedDefault: false });
    expect(curve.points[3].goneProbability).toBeCloseTo(0.5, 6); // raw 0.083 raised to the 45-day value
    expect(probabilities(curve)).toEqual([...probabilities(curve)].sort((a, b) => a - b));
  });

  it("falls back to the defaults when there is no history", () => {
    const curve = buildCalibrationCurve(new Map(), TODAY);
    expect(curve.tutorsObserved).toBe(0);
    expect(curve.points.every((point) => point.usedDefault)).toBe(true);
    expect(probabilities(curve)).toEqual([0.6, 0.7, 0.78, 0.9, 0.96]);
    expect(curve.historyStart).toBe("2026-02-28T17:00:00.000Z");
  });

  it("ignores duplicate and unsorted dates", () => {
    const curve = buildCalibrationCurve(new Map([["T1", ["2026-09-30", "2026-09-01", "2026-09-30"]]]), TODAY);
    expect(curve.tutorsObserved).toBe(1);
    expect(curve.points[0]).toMatchObject({ returned: 1, stillIdle: 0 });
  });
});

describe("baseGoneProbability", () => {
  const curve: CalibrationCurve = {
    tutorsObserved: 72,
    historyStart: "2026-02-28T17:00:00.000Z",
    points: [
      { thresholdDays: 21, returned: 13, stillIdle: 21, goneProbability: 0.61, usedDefault: false },
      { thresholdDays: 30, returned: 8, stillIdle: 19, goneProbability: 0.7, usedDefault: false },
      { thresholdDays: 45, returned: 4, stillIdle: 15, goneProbability: 0.78, usedDefault: false },
      { thresholdDays: 60, returned: 1, stillIdle: 15, goneProbability: 0.91, usedDefault: false },
      { thresholdDays: 90, returned: 0, stillIdle: 14, goneProbability: 0.97, usedDefault: false },
    ],
  };

  it("uses the largest threshold the gap has reached", () => {
    expect(baseGoneProbability(curve, 0)).toBe(ACTIVE_BASE_PROBABILITY);
    expect(baseGoneProbability(curve, 20)).toBe(ACTIVE_BASE_PROBABILITY);
    expect(baseGoneProbability(curve, 21)).toBe(0.61);
    expect(baseGoneProbability(curve, 59)).toBe(0.78);
    expect(baseGoneProbability(curve, 60)).toBe(0.91);
    expect(baseGoneProbability(curve, 400)).toBe(0.97);
  });
});
```

- [ ] **Step 2: Run it to verify it fails**

Run: `npx vitest run --project unit src/lib/tutor-offboarding/__tests__/calibration.test.ts`
Expected: FAIL — `Failed to resolve import "../calibration"`.

- [ ] **Step 3: Implement the calibration**

Create `src/lib/tutor-offboarding/calibration.ts`:

```ts
// ----------------------------------------------------------------------------
// Tutor Offboarding calibration (spec §4.3): how often BeGifted tutors came back
// after being idle for a given number of days, learned from our own history.
// Pure; works on Bangkok date keys (YYYY-MM-DD).
// ----------------------------------------------------------------------------

/** First Bangkok day of usable teaching history: the progress-test attendance ledger starts here. */
export const HISTORY_START = new Date("2026-03-01T00:00:00+07:00");
export const HISTORY_START_KEY = "2026-03-01";

export const GAP_THRESHOLDS = [21, 30, 45, 60, 90] as const;
export type GapThreshold = (typeof GAP_THRESHOLDS)[number];

/** Used when a threshold has fewer than MIN_SAMPLE observations (the 1 Oct 2026 backtest). */
export const DEFAULT_GONE_PROBABILITY: Record<GapThreshold, number> = { 21: 0.6, 30: 0.7, 45: 0.78, 60: 0.9, 90: 0.96 };
/** Base likelihood for a gap under the first threshold. */
export const ACTIVE_BASE_PROBABILITY = 0.03;
export const MIN_SAMPLE = 5;

export interface CurvePoint {
  thresholdDays: GapThreshold;
  /** Closed gaps at least this long: the tutor taught again afterwards. */
  returned: number;
  /** Open gaps at least this long: idle up to today. */
  stillIdle: number;
  goneProbability: number;
  usedDefault: boolean;
}

export interface CalibrationCurve {
  points: CurvePoint[];
  tutorsObserved: number;
  historyStart: string;
}

function dayNumber(key: string): number {
  const [year, month, day] = key.split("-").map(Number);
  return Math.round(Date.UTC(year, month - 1, day) / 86_400_000);
}

export function daysBetweenDateKeys(from: string, to: string): number {
  return dayNumber(to) - dayNumber(from);
}

/**
 * Builds the return-rate curve:
 * 1. per tutor, consecutive taught dates form closed gaps; the last date to today is the open gap;
 * 2. per threshold, P(gone) = 1 - (returned + 0.5) / (returned + stillIdle + 1), Jeffreys-smoothed;
 * 3. thresholds with fewer than MIN_SAMPLE observations use DEFAULT_GONE_PROBABILITY;
 * 4. the curve is made non-decreasing, so a longer gap never looks less final.
 * Tutors who never taught are not in `taughtDates` and do not count.
 */
export function buildCalibrationCurve(taughtDates: ReadonlyMap<string, readonly string[]>, todayKey: string): CalibrationCurve {
  const closed: number[] = [];
  const open: number[] = [];
  let tutorsObserved = 0;
  for (const dates of taughtDates.values()) {
    const sorted = [...new Set(dates)].sort();
    if (sorted.length === 0) continue;
    tutorsObserved += 1;
    for (let index = 1; index < sorted.length; index += 1) closed.push(daysBetweenDateKeys(sorted[index - 1], sorted[index]));
    open.push(Math.max(0, daysBetweenDateKeys(sorted[sorted.length - 1], todayKey)));
  }
  let previous = 0;
  const points = GAP_THRESHOLDS.map((thresholdDays): CurvePoint => {
    const returned = closed.filter((gap) => gap >= thresholdDays).length;
    const stillIdle = open.filter((gap) => gap >= thresholdDays).length;
    const usedDefault = returned + stillIdle < MIN_SAMPLE;
    const raw = usedDefault ? DEFAULT_GONE_PROBABILITY[thresholdDays] : 1 - (returned + 0.5) / (returned + stillIdle + 1);
    const goneProbability = Math.max(raw, previous);
    previous = goneProbability;
    return { thresholdDays, returned, stillIdle, goneProbability, usedDefault };
  });
  return { points, tutorsObserved, historyStart: HISTORY_START.toISOString() };
}

/** Base likelihood for an idle gap: the value at the largest threshold the gap has reached. */
export function baseGoneProbability(curve: CalibrationCurve, gapDays: number): number {
  let probability = ACTIVE_BASE_PROBABILITY;
  for (const point of curve.points) if (gapDays >= point.thresholdDays) probability = point.goneProbability;
  return probability;
}
```

- [ ] **Step 4: Run it to verify it passes**

Run: `npx vitest run --project unit src/lib/tutor-offboarding/__tests__/calibration.test.ts`
Expected: PASS (7 tests).

- [ ] **Step 5: Commit**

```bash
git add src/lib/tutor-offboarding/calibration.ts src/lib/tutor-offboarding/__tests__/calibration.test.ts
git commit -m "$(cat <<'EOF'
Tutor Offboarding: return-rate calibration from teaching history

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>
EOF
)"
```

---

### Task 3: Types and the score

**Files:**
- Create: `src/lib/tutor-offboarding/types.ts`
- Create: `src/lib/tutor-offboarding/day-label.ts`
- Create: `src/lib/tutor-offboarding/score.ts`
- Test: `src/lib/tutor-offboarding/__tests__/day-label.test.ts`
- Test: `src/lib/tutor-offboarding/__tests__/score.test.ts`

**Interfaces:**
- Consumes: `CalibrationCurve`, `baseGoneProbability`, `daysBetweenDateKeys`, `HISTORY_START`, `HISTORY_START_KEY` (Task 2); `bangkokDateKey` (`@/lib/room-capacity/dates`).
- Produces (types.ts, used by every later task): `OffboardingBand`, `OffboardingExclusion`, `ReasonCode`, `OffboardingAccount`, `LastTaughtBySource`, `PersonSignals`, `OffboardingSignals`, `ScoreReason`, `PersonScore`, `FeedTimestamps`, `FeedKey`, `FeedStatus`, `FreshnessReport`, `DecisionRecord`, `DecisionView`, `GrantRecord`, `TutorOffboardingViewer`, `OffboardingPersonRow`, `OffboardingSummary`, `OffboardingDashboardData`, `OffboardingUnavailableReason`, `OffboardingDashboard`.
- Produces (day-label.ts): `bangkokDayLabel(iso: string, withYear?: boolean): string` — "3 Jun" / "3 Jun 2026" with fixed month names (Node's ICU writes "Sept" in en-GB, browsers "Sep"; a mismatch would also break hydration).
- Produces (score.ts): `EVIDENCE_WEIGHTS`, `MAX_LIKELIHOOD = 99`, `NEW_ACCOUNT_GRACE_DAYS = 60`, `REMOVAL_MIN_IDLE_DAYS = 45`, `RECENT_ACTION_DAYS = 30`, `interface ScoreContext { now: Date; curve: CalibrationCurve; snoozedKeys: ReadonlySet<string>; freshnessOk: boolean }`, `bandFor(likelihood: number): OffboardingBand`, `scorePerson(signals: PersonSignals, ctx: ScoreContext): PersonScore`.

- [ ] **Step 1: Write the types**

Create `src/lib/tutor-offboarding/types.ts`:

```ts
import type { CalibrationCurve } from "./calibration";

// ----------------------------------------------------------------------------
// Tutor Offboarding types. Instants are ISO strings everywhere, so the signals
// payload can be cached ("use cache") and sent to the client unchanged.
// ----------------------------------------------------------------------------

export type OffboardingBand = "very_likely_gone" | "likely_gone" | "unclear" | "active";

export type OffboardingExclusion =
  | "wise_admin"
  | "teaching"
  | "full_time"
  | "identity_conflict"
  | "awaiting_details"
  | "new_account"
  | "still_with_us";

export type ReasonCode =
  | "idle_gap"
  | "no_class_on_record"
  | "no_working_hours"
  | "no_courses"
  | "never_activated"
  | "recent_wise_action"
  | "on_leave";

/** One Wise account of a person, as the last promoted sync saw it. Null = unknown (OFF-02). */
export interface OffboardingAccount {
  wiseTeacherId: string;
  wiseUserId: string | null;
  displayName: string;
  isOnlineVariant: boolean;
  email: string | null;
  /** `tutor_wise_accounts.status`; null when the account has no durable row yet. */
  status: string | null;
  relation: string | null;
  joinedOn: string | null;
  courseCount: number | null;
  activated: boolean | null;
  /** False when the active snapshot recorded an availability fetch failure for this account. */
  availabilityKnown: boolean;
  workingHourWindows: number;
}

export interface LastTaughtBySource {
  ledger: string | null;
  pastBlocks: string | null;
  postClass: string | null;
}

/** Everything the score needs about one person (OFF-01: an identity group's canonical key). */
export interface PersonSignals {
  canonicalKey: string;
  displayName: string;
  accounts: OffboardingAccount[];
  lastTaughtAt: string | null;
  lastTaughtBySource: LastTaughtBySource;
  upcomingSessions: number;
  nextSessionAt: string | null;
  /** Latest end of an upcoming Wise leave or leave request; null when none. */
  upcomingLeaveUntil: string | null;
  lastTeacherActionAt: string | null;
  lastAdminActionAt: string | null;
  fullTime: boolean;
}

/** The cached part of the dashboard: people on the active snapshot plus every tutor's taught dates. */
export interface OffboardingSignals {
  snapshotId: string;
  snapshotCreatedAt: string;
  generatedAt: string;
  people: PersonSignals[];
  /** Canonical key → sorted Bangkok date keys with a taught session, on the roster or not. */
  taughtDates: Record<string, string[]>;
}

export interface ScoreReason {
  code: ReasonCode;
  direction: "toward_gone" | "toward_active";
  text: string;
}

export interface PersonScore {
  likelihood: number;
  band: OffboardingBand;
  idleDays: number;
  neverTaught: boolean;
  /** reasons[0] is always the idle / no-class reason. */
  reasons: ScoreReason[];
  exclusion: { code: OffboardingExclusion; text: string } | null;
  removable: boolean;
  removableBlockedBy: string | null;
}

export interface FeedTimestamps {
  tutorSnapshot: string | null;
  progressTests: string | null;
  postClass: string | null;
  wiseActivity: string | null;
  leaveRequests: string | null;
}

export type FeedKey = keyof FeedTimestamps;

export interface FeedStatus {
  key: FeedKey;
  label: string;
  lastSuccessAt: string | null;
  maxAgeHours: number;
  fresh: boolean;
}

export interface FreshnessReport {
  ok: boolean;
  feeds: FeedStatus[];
}

export interface DecisionRecord {
  id: string;
  canonicalKey: string;
  note: string | null;
  snoozeUntil: string;
  likelihoodAtDecision: number;
  bandAtDecision: OffboardingBand;
  reasons: string[];
  decidedByEmail: string;
  decidedAt: string;
  revokedAt: string | null;
  revokedByEmail: string | null;
}

export interface DecisionView extends DecisionRecord {
  displayName: string;
}

export interface GrantRecord {
  email: string;
  grantedByEmail: string;
  grantedAt: string;
}

export interface TutorOffboardingViewer {
  email: string;
  isOwner: boolean;
  canRemove: boolean;
}

export interface OffboardingPersonRow {
  signals: PersonSignals;
  score: PersonScore;
  openDecision: DecisionRecord | null;
}

export interface OffboardingSummary {
  veryLikely: number;
  likely: number;
  unclear: number;
  veryLikelyAccounts: number;
}

export interface OffboardingDashboardData {
  /** When this payload was assembled (uncached). */
  servedAt: string;
  /** When the cached signals were read. */
  generatedAt: string;
  snapshotCreatedAt: string;
  freshness: FreshnessReport;
  curve: CalibrationCurve;
  /** Not excluded and not Active, most likely first. */
  inbox: OffboardingPersonRow[];
  activeCount: number;
  /** Excluded for any reason except a Wise ADMIN account. */
  excluded: OffboardingPersonRow[];
  /** OFF-03: people with a Wise ADMIN account. */
  staff: OffboardingPersonRow[];
  decisions: DecisionView[];
  /** Owner only. */
  grants: GrantRecord[] | null;
  viewer: TutorOffboardingViewer;
  summary: OffboardingSummary;
}

export type OffboardingUnavailableReason = "not_set_up" | "no_snapshot" | "load_failed";

export type OffboardingDashboard =
  | ({ available: true } & OffboardingDashboardData)
  | { available: false; reason: OffboardingUnavailableReason; viewer: TutorOffboardingViewer };
```

- [ ] **Step 2: Write the failing tests**

Create `src/lib/tutor-offboarding/__tests__/day-label.test.ts`:

```ts
import { describe, expect, it } from "vitest";
import { bangkokDayLabel } from "../day-label";

describe("bangkokDayLabel", () => {
  it("writes Bangkok days with fixed month names, September included", () => {
    expect(bangkokDayLabel("2026-09-21T03:00:00.000Z")).toBe("21 Sep");
    expect(bangkokDayLabel("2026-02-28T17:00:00.000Z")).toBe("1 Mar"); // midnight in Bangkok
    expect(bangkokDayLabel("2026-01-20T00:00:00.000Z", true)).toBe("20 Jan 2026");
  });
});
```

Create `src/lib/tutor-offboarding/__tests__/score.test.ts`:

```ts
import { describe, expect, it } from "vitest";
import type { CalibrationCurve } from "../calibration";
import { bandFor, scorePerson, type ScoreContext } from "../score";
import type { OffboardingAccount, PersonSignals } from "../types";

const NOW = new Date("2026-10-01T05:00:00.000Z"); // 12:00 Bangkok

const CURVE: CalibrationCurve = {
  tutorsObserved: 72,
  historyStart: "2026-02-28T17:00:00.000Z",
  points: [
    { thresholdDays: 21, returned: 13, stillIdle: 21, goneProbability: 0.6, usedDefault: false },
    { thresholdDays: 30, returned: 8, stillIdle: 19, goneProbability: 0.7, usedDefault: false },
    { thresholdDays: 45, returned: 4, stillIdle: 15, goneProbability: 0.78, usedDefault: false },
    { thresholdDays: 60, returned: 1, stillIdle: 15, goneProbability: 0.9, usedDefault: false },
    { thresholdDays: 90, returned: 0, stillIdle: 14, goneProbability: 0.96, usedDefault: false },
  ],
};

function account(overrides: Partial<OffboardingAccount> = {}): OffboardingAccount {
  return {
    wiseTeacherId: "t1", wiseUserId: "u1", displayName: "Aria (Aria)", isOnlineVariant: false, email: "aria@example.com",
    status: "active", relation: "TEACHER", joinedOn: "2026-01-20T00:00:00.000Z", courseCount: 3, activated: true,
    availabilityKnown: true, workingHourWindows: 4, ...overrides,
  };
}

function person(overrides: Partial<PersonSignals> = {}): PersonSignals {
  return {
    canonicalKey: "Aria", displayName: "Aria", accounts: [account()],
    lastTaughtAt: "2026-06-03T03:00:00.000Z", // 120 days before NOW
    lastTaughtBySource: { ledger: "2026-06-03T03:00:00.000Z", pastBlocks: null, postClass: null },
    upcomingSessions: 0, nextSessionAt: null, upcomingLeaveUntil: null,
    lastTeacherActionAt: null, lastAdminActionAt: null, fullTime: false, ...overrides,
  };
}

function ctx(overrides: Partial<ScoreContext> = {}): ScoreContext {
  return { now: NOW, curve: CURVE, snoozedKeys: new Set(), freshnessOk: true, ...overrides };
}

describe("bandFor", () => {
  it("cuts the bands at 90, 70 and 40", () => {
    expect([90, 89, 70, 69, 40, 39].map(bandFor)).toEqual([
      "very_likely_gone", "likely_gone", "likely_gone", "unclear", "unclear", "active",
    ]);
  });
});

describe("scorePerson", () => {
  it("scores a long-idle tutor from the curve and explains it", () => {
    const score = scorePerson(person(), ctx());
    expect(score).toMatchObject({ likelihood: 96, band: "very_likely_gone", idleDays: 120, neverTaught: false, exclusion: null, removable: true, removableBlockedBy: null });
    expect(score.reasons).toEqual([{ code: "idle_gap", direction: "toward_gone", text: "Last class 120 days ago (3 Jun)" }]);
  });

  it("adds supporting evidence and never claims certainty", () => {
    const score = scorePerson(person({ accounts: [account({ workingHourWindows: 0, courseCount: 0, activated: false })] }), ctx());
    expect(score.likelihood).toBe(99);
    expect(score.reasons.map((reason) => reason.text)).toEqual([
      "Last class 120 days ago (3 Jun)",
      "No working hours set in Wise",
      "Not assigned to any Wise course",
      "Never activated their Wise login",
    ]);
  });

  it("lets unknown signals add nothing (OFF-02)", () => {
    const unknown = account({ workingHourWindows: 0, availabilityKnown: false, courseCount: null, activated: null });
    expect(scorePerson(person({ accounts: [unknown] }), ctx()).likelihood).toBe(96);
    // Evidence must hold for every account: one known course keeps "no courses" off.
    const mixed = [account({ courseCount: 0 }), account({ wiseTeacherId: "t2", courseCount: 2 })];
    expect(scorePerson(person({ accounts: mixed }), ctx()).reasons.map((reason) => reason.code)).toEqual(["idle_gap"]);
  });

  it("lowers the score for recent Wise activity and for leave", () => {
    const recent = person({ lastTeacherActionAt: "2026-09-21T03:00:00.000Z" });
    expect(scorePerson(recent, ctx())).toMatchObject({ likelihood: 76, band: "likely_gone" });
    const onLeave = person({ lastTeacherActionAt: "2026-09-21T03:00:00.000Z", upcomingLeaveUntil: "2026-10-20T10:00:00.000Z" });
    const score = scorePerson(onLeave, ctx());
    expect(score).toMatchObject({ likelihood: 42, band: "unclear" });
    expect(score.reasons.slice(1)).toEqual([
      { code: "recent_wise_action", direction: "toward_active", text: "Used Wise on 21 Sep" },
      { code: "on_leave", direction: "toward_active", text: "On leave until 20 Oct" },
    ]);
  });

  it("measures a never-taught person from 1 Mar or from their joined date (OFF-14)", () => {
    const longAgo = scorePerson(person({ lastTaughtAt: null }), ctx());
    expect(longAgo).toMatchObject({ idleDays: 214, neverTaught: true, likelihood: 96, removable: true });
    expect(longAgo.reasons[0]).toEqual({ code: "no_class_on_record", direction: "toward_gone", text: "No class on record since 1 Mar" });
    const joinedJuly = scorePerson(person({ lastTaughtAt: null, accounts: [account({ joinedOn: "2026-07-10T03:00:00.000Z" })] }), ctx());
    expect(joinedJuly).toMatchObject({ idleDays: 83, likelihood: 90, band: "very_likely_gone" });
    expect(joinedJuly.reasons[0].text).toBe("No class on record since 10 Jul");
  });

  it("applies the exclusions in order, first match wins", () => {
    const cases: Array<[Partial<PersonSignals>, string, string]> = [
      [{ accounts: [account({ relation: "ADMIN" })], upcomingSessions: 2 }, "wise_admin", "Wise admin account (staff)"],
      [{ upcomingSessions: 1 }, "teaching", "Teaching: 1 upcoming class"],
      [{ upcomingSessions: 3 }, "teaching", "Teaching: 3 upcoming classes"],
      [{ fullTime: true }, "full_time", "Full-time tutor (office attendance)"],
      [{ accounts: [account({ status: "identity_conflict" })] }, "identity_conflict", "Identity needs fixing in Wise first"],
      [{ lastTaughtAt: null, accounts: [account({ joinedOn: null })] }, "awaiting_details", "Waiting for Wise account details (next sync)"],
      [{ lastTaughtAt: null, accounts: [account({ joinedOn: "2026-09-11T03:00:00.000Z" })] }, "new_account", "New account, not started yet"],
    ];
    for (const [overrides, code, text] of cases) {
      const score = scorePerson(person(overrides), ctx());
      expect(score.exclusion).toEqual({ code, text });
      expect(score).toMatchObject({ removable: false, removableBlockedBy: null });
    }
    expect(scorePerson(person(), ctx({ snoozedKeys: new Set(["Aria"]) })).exclusion).toEqual({ code: "still_with_us", text: "Marked still with us" });
  });

  it("explains why a person outside the exclusions is not removable yet", () => {
    const recent = scorePerson(person({ lastTaughtAt: "2026-09-01T03:00:00.000Z" }), ctx());
    expect(recent).toMatchObject({ likelihood: 70, band: "likely_gone", removable: false, removableBlockedBy: "Last class 30 days ago; removal opens at 45 days" });
    expect(scorePerson(person(), ctx({ freshnessOk: false })).removableBlockedBy).toBe("Data is out of date");
    expect(scorePerson(person({ accounts: [account({ relation: null })] }), ctx()).removableBlockedBy).toBe("Waiting for Wise account details");
    expect(scorePerson(person({ lastTaughtAt: "2026-09-26T03:00:00.000Z" }), ctx())).toMatchObject({ band: "active", removableBlockedBy: "Looks active" });
  });
});
```

- [ ] **Step 3: Run them to verify they fail**

Run: `npx vitest run --project unit src/lib/tutor-offboarding/__tests__/day-label.test.ts src/lib/tutor-offboarding/__tests__/score.test.ts`
Expected: FAIL — `Failed to resolve import "../day-label"` and `"../score"`.

- [ ] **Step 4: Implement the day label and the score**

Create `src/lib/tutor-offboarding/day-label.ts`:

```ts
const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"] as const;
const BANGKOK_PARTS = new Intl.DateTimeFormat("en-GB", { timeZone: "Asia/Bangkok", year: "numeric", month: "numeric", day: "numeric" });

/**
 * "3 Jun" (or "3 Jun 2026") for an instant, on the Bangkok calendar. Month names are fixed rather than taken from the
 * runtime's locale data: Node writes "Sept" in en-GB where browsers write "Sep", which would also break hydration.
 */
export function bangkokDayLabel(iso: string, withYear = false): string {
  const parts = new Map(BANGKOK_PARTS.formatToParts(new Date(iso)).map((part) => [part.type, part.value]));
  const label = `${Number(parts.get("day"))} ${MONTHS[Number(parts.get("month")) - 1]}`;
  return withYear ? `${label} ${parts.get("year")}` : label;
}
```

Create `src/lib/tutor-offboarding/score.ts`:

```ts
import { bangkokDateKey } from "@/lib/room-capacity/dates";
import { baseGoneProbability, daysBetweenDateKeys, HISTORY_START, HISTORY_START_KEY, type CalibrationCurve } from "./calibration";
import { bangkokDayLabel } from "./day-label";
import type { OffboardingBand, OffboardingExclusion, PersonScore, PersonSignals, ScoreReason } from "./types";

// ----------------------------------------------------------------------------
// Tutor Offboarding score (spec §4.4-4.5): calibrated base likelihood plus fixed
// evidence weights, bands, exclusions and the removal checks. Pure.
// ----------------------------------------------------------------------------

/** Log-odds added by each piece of evidence (spec §4.4). */
export const EVIDENCE_WEIGHTS = {
  noWorkingHours: 0.8,
  noCourses: 0.8,
  neverActivated: 0.5,
  recentWiseAction: -2,
  onLeave: -1.5,
} as const;

/** OFF-14: the page never claims certainty. */
export const MAX_LIKELIHOOD = 99;
/** OFF-05: a never-taught account younger than this is a new hire, not a departure. */
export const NEW_ACCOUNT_GRACE_DAYS = 60;
/** OFF-06: removal needs the last class at least this long ago. */
export const REMOVAL_MIN_IDLE_DAYS = 45;
export const RECENT_ACTION_DAYS = 30;

const DAY_MS = 86_400_000;

export interface ScoreContext {
  now: Date;
  curve: CalibrationCurve;
  /** Canonical keys with an open "Still with us" decision. */
  snoozedKeys: ReadonlySet<string>;
  /** OFF-07: every feed is fresh. */
  freshnessOk: boolean;
}

export function bandFor(likelihood: number): OffboardingBand {
  if (likelihood >= 90) return "very_likely_gone";
  if (likelihood >= 70) return "likely_gone";
  if (likelihood >= 40) return "unclear";
  return "active";
}

function day(iso: string): string {
  return bangkokDayLabel(iso);
}

function plural(count: number, word: string, many = `${word}s`): string {
  return `${count} ${count === 1 ? word : many}`;
}

/** Earliest joined date across the accounts, or null when any of them is unknown. */
function earliestJoined(signals: PersonSignals): string | null {
  const dates = signals.accounts.map((account) => account.joinedOn);
  if (dates.length === 0 || dates.some((date) => date === null)) return null;
  return (dates as string[]).reduce((earliest, date) => (date < earliest ? date : earliest));
}

function exclusionFor(signals: PersonSignals, ctx: ScoreContext, neverTaught: boolean, accountAgeDays: number | null): PersonScore["exclusion"] {
  const exclude = (code: OffboardingExclusion, text: string) => ({ code, text });
  // OFF-03: staff accounts are never in the review list.
  if (signals.accounts.some((account) => account.relation === "ADMIN")) return exclude("wise_admin", "Wise admin account (staff)");
  // OFF-04: anyone with an upcoming class is teaching.
  if (signals.upcomingSessions > 0) return exclude("teaching", `Teaching: ${plural(signals.upcomingSessions, "upcoming class", "upcoming classes")}`);
  if (signals.fullTime) return exclude("full_time", "Full-time tutor (office attendance)");
  if (signals.accounts.some((account) => account.status === "identity_conflict")) return exclude("identity_conflict", "Identity needs fixing in Wise first");
  // OFF-02: a never-taught person with an unknown joined date could be a brand-new hire.
  if (neverTaught && accountAgeDays === null) return exclude("awaiting_details", "Waiting for Wise account details (next sync)");
  // OFF-05
  if (neverTaught && accountAgeDays !== null && accountAgeDays < NEW_ACCOUNT_GRACE_DAYS) return exclude("new_account", "New account, not started yet");
  if (ctx.snoozedKeys.has(signals.canonicalKey)) return exclude("still_with_us", "Marked still with us");
  return null;
}

export function scorePerson(signals: PersonSignals, ctx: ScoreContext): PersonScore {
  const todayKey = bangkokDateKey(ctx.now);
  const joined = earliestJoined(signals);
  const joinedKey = joined ? bangkokDateKey(new Date(joined)) : null;
  const accountAgeDays = joinedKey ? daysBetweenDateKeys(joinedKey, todayKey) : null;
  const neverTaught = signals.lastTaughtAt === null;
  // OFF-14: a never-taught person is measured from 1 Mar or their joined date, whichever is later.
  const anchorIso = !neverTaught ? signals.lastTaughtAt! : joined && joinedKey! > HISTORY_START_KEY ? joined : HISTORY_START.toISOString();
  const idleDays = Math.max(0, daysBetweenDateKeys(bangkokDateKey(new Date(anchorIso)), todayKey));

  const reasons: ScoreReason[] = [neverTaught
    ? { code: "no_class_on_record", direction: "toward_gone", text: `No class on record since ${day(anchorIso)}` }
    : {
      code: "idle_gap",
      direction: idleDays >= 21 ? "toward_gone" : "toward_active",
      text: idleDays === 0 ? "Taught today" : `Last class ${plural(idleDays, "day")} ago (${day(anchorIso)})`,
    }];
  const base = baseGoneProbability(ctx.curve, idleDays);
  let logOdds = Math.log(base / (1 - base));

  // OFF-02: each piece of evidence must hold for every account; unknown values never count.
  const accounts = signals.accounts;
  if (accounts.length > 0 && accounts.every((account) => account.availabilityKnown && account.workingHourWindows === 0)) {
    logOdds += EVIDENCE_WEIGHTS.noWorkingHours;
    reasons.push({ code: "no_working_hours", direction: "toward_gone", text: "No working hours set in Wise" });
  }
  if (accounts.length > 0 && accounts.every((account) => account.courseCount === 0)) {
    logOdds += EVIDENCE_WEIGHTS.noCourses;
    reasons.push({ code: "no_courses", direction: "toward_gone", text: "Not assigned to any Wise course" });
  }
  if (accounts.length > 0 && accounts.every((account) => account.activated === false)) {
    logOdds += EVIDENCE_WEIGHTS.neverActivated;
    reasons.push({ code: "never_activated", direction: "toward_gone", text: "Never activated their Wise login" });
  }
  if (signals.lastTeacherActionAt && ctx.now.getTime() - Date.parse(signals.lastTeacherActionAt) <= RECENT_ACTION_DAYS * DAY_MS) {
    logOdds += EVIDENCE_WEIGHTS.recentWiseAction;
    reasons.push({ code: "recent_wise_action", direction: "toward_active", text: `Used Wise on ${day(signals.lastTeacherActionAt)}` });
  }
  if (signals.upcomingLeaveUntil && Date.parse(signals.upcomingLeaveUntil) > ctx.now.getTime()) {
    logOdds += EVIDENCE_WEIGHTS.onLeave;
    reasons.push({ code: "on_leave", direction: "toward_active", text: `On leave until ${day(signals.upcomingLeaveUntil)}` });
  }

  const likelihood = Math.min(MAX_LIKELIHOOD, Math.round(100 / (1 + Math.exp(-logOdds))));
  const band = bandFor(likelihood);
  const exclusion = exclusionFor(signals, ctx, neverTaught, accountAgeDays);

  let removableBlockedBy: string | null = null;
  if (!exclusion) {
    if (!ctx.freshnessOk) removableBlockedBy = "Data is out of date"; // OFF-07
    else if (accounts.some((account) => account.relation !== "TEACHER")) removableBlockedBy = "Waiting for Wise account details";
    else if (band === "active") removableBlockedBy = "Looks active";
    else if (!neverTaught && idleDays < REMOVAL_MIN_IDLE_DAYS) {
      removableBlockedBy = `Last class ${plural(idleDays, "day")} ago; removal opens at ${REMOVAL_MIN_IDLE_DAYS} days`; // OFF-06
    }
  }

  return { likelihood, band, idleDays, neverTaught, reasons, exclusion, removable: exclusion === null && removableBlockedBy === null, removableBlockedBy };
}
```

- [ ] **Step 5: Run them to verify they pass**

Run: `npx vitest run --project unit src/lib/tutor-offboarding/__tests__/day-label.test.ts src/lib/tutor-offboarding/__tests__/score.test.ts`
Expected: PASS (1 + 8 tests).

- [ ] **Step 6: Commit**

```bash
git add src/lib/tutor-offboarding/types.ts src/lib/tutor-offboarding/day-label.ts src/lib/tutor-offboarding/score.ts \
  src/lib/tutor-offboarding/__tests__/day-label.test.ts src/lib/tutor-offboarding/__tests__/score.test.ts
git commit -m "$(cat <<'EOF'
Tutor Offboarding: likelihood score, bands, exclusions and removal checks

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>
EOF
)"
```

---

### Task 4: Signals loader and feed timestamps

**Files:**
- Create: `src/lib/tutor-offboarding/signals.ts`
- Test: `src/lib/tutor-offboarding/__tests__/signals.integration.test.ts`

**Interfaces:**
- Consumes: schema tables (Task 1 columns), `HISTORY_START` (Task 2), types (Task 3), `bangkokDateKey`.
- Produces:
  - `loadOffboardingSignals(db?: Database, now?: Date): Promise<OffboardingSignals | null>` (null = no active snapshot)
  - `loadFeedTimestamps(db?: Database): Promise<FeedTimestamps>`

- [ ] **Step 1: Write the failing integration test**

Create `src/lib/tutor-offboarding/__tests__/signals.integration.test.ts`:

```ts
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { startTestDb, stopTestDb, truncateAll } from "@/tests/integration/db-helper";
import type { Database } from "@/lib/db";
import * as schema from "@/lib/db/schema";
import { loadFeedTimestamps, loadOffboardingSignals } from "../signals";

let handle: Awaited<ReturnType<typeof startTestDb>>;
let db: Database;
const NOW = new Date("2026-10-01T05:00:00.000Z");

beforeAll(async () => { handle = await startTestDb(); db = handle.db as unknown as Database; });
afterAll(async () => { if (handle) await stopTestDb(handle); });
beforeEach(async () => { await truncateAll(handle.db); });

const HOUR = 3_600_000;

function futureBlock(snapshotId: string, groupId: string, wiseTeacherId: string, wiseSessionId: string, start: string, isBlocking: boolean) {
  const startTime = new Date(start);
  return { snapshotId, groupId, wiseTeacherId, wiseSessionId, startTime, endTime: new Date(startTime.getTime() + HOUR),
    weekday: 1, startMinute: 600, endMinute: 660, wiseStatus: isBlocking ? "UPCOMING" : "CANCELLED", isBlocking };
}

function pastBlock(groupCanonicalKey: string, wiseTeacherId: string, wiseSessionId: string, start: string, isBlocking: boolean) {
  const startTime = new Date(start);
  return { groupCanonicalKey, wiseTeacherId, wiseSessionId, startTime, endTime: new Date(startTime.getTime() + HOUR),
    weekday: 1, startMinute: 600, endMinute: 660, wiseStatus: isBlocking ? "UPCOMING" : "CANCELLED", isBlocking };
}

function ledgerRow(wiseSessionId: string, tutorCanonicalKey: string, start: string, meetingStatus: string) {
  return { enrollmentKey: "enr-1", wiseSessionId, wiseClassId: "c1", wiseStudentId: "st1", studentKey: "st1", studentName: "Student One",
    scheduledStartTime: new Date(start), meetingStatus, tutorCanonicalKey };
}

function postClassRow(wiseSessionId: string, start: string, finalStatus: string) {
  const startAt = new Date(start);
  return { wiseSessionId, wiseClassId: "c1", canonicalTutorKey: "Aria", scheduledStartAt: startAt,
    scheduledEndAt: new Date(startAt.getTime() + HOUR), deadlineAt: new Date(startAt.getTime() + 25 * HOUR), finalStatus };
}

async function seed() {
  const [old] = await handle.db.insert(schema.snapshots).values({ active: false, createdAt: new Date("2026-09-30T00:00:00Z") }).returning();
  const [snapshot] = await handle.db.insert(schema.snapshots).values({ active: true, createdAt: new Date("2026-10-01T04:30:00Z") }).returning();
  const [aria, bodhi, cleo] = await handle.db.insert(schema.tutorIdentityGroups).values([
    { snapshotId: snapshot.id, canonicalKey: "Aria", displayName: "Aria" },
    { snapshotId: snapshot.id, canonicalKey: "Bodhi", displayName: "Bodhi" },
    { snapshotId: snapshot.id, canonicalKey: "Cleo", displayName: "Cleo" },
  ]).returning();
  const [stale] = await handle.db.insert(schema.tutorIdentityGroups).values({ snapshotId: old.id, canonicalKey: "Stale", displayName: "Stale" }).returning();
  await handle.db.insert(schema.tutorIdentityGroupMembers).values([
    { snapshotId: snapshot.id, groupId: aria.id, wiseTeacherId: "t-aria-on", wiseUserId: "u-aria-on", wiseDisplayName: "Aria (Aria) Online", isOnlineVariant: true },
    { snapshotId: snapshot.id, groupId: aria.id, wiseTeacherId: "t-aria-off", wiseUserId: "u-aria-off", wiseDisplayName: "Aria (Aria)", isOnlineVariant: false },
    { snapshotId: snapshot.id, groupId: bodhi.id, wiseTeacherId: "t-bodhi", wiseUserId: "u-bodhi", wiseDisplayName: "Bodhi (Bodhi)", isOnlineVariant: false },
    { snapshotId: snapshot.id, groupId: cleo.id, wiseTeacherId: "t-cleo", wiseUserId: "u-cleo", wiseDisplayName: "Cleo (Cleo)", isOnlineVariant: false },
    { snapshotId: old.id, groupId: stale.id, wiseTeacherId: "t-stale", wiseUserId: "u-stale", wiseDisplayName: "Stale (Stale)", isOnlineVariant: false },
  ]);
  await handle.db.insert(schema.tutorWiseAccounts).values([
    { wiseTeacherId: "t-aria-on", wiseUserId: "u-aria-on", canonicalKey: "Aria", displayName: "Aria (Aria) Online", isOnlineVariant: true,
      email: "aria.online@example.com", status: "active", lastSnapshotId: snapshot.id,
      wiseRelation: "TEACHER", wiseJoinedOn: new Date("2026-01-20T00:00:00Z"), wiseCourseCount: 0, wiseActivated: true },
    { wiseTeacherId: "t-aria-off", wiseUserId: "u-aria-off", canonicalKey: "Aria", displayName: "Aria (Aria)", isOnlineVariant: false,
      email: "aria@example.com", status: "active", lastSnapshotId: snapshot.id,
      wiseRelation: "TEACHER", wiseJoinedOn: new Date("2026-01-20T00:00:00Z"), wiseCourseCount: 2, wiseActivated: false },
    { wiseTeacherId: "t-bodhi", wiseUserId: "u-bodhi", canonicalKey: "Bodhi", displayName: "Bodhi (Bodhi)", isOnlineVariant: false,
      email: "bodhi@example.com", status: "active", lastSnapshotId: snapshot.id, wiseRelation: "ADMIN" },
    // Cleo has no durable account row yet: every roster detail is unknown.
  ]);
  await handle.db.insert(schema.futureSessionBlocks).values([
    futureBlock(snapshot.id, bodhi.id, "t-bodhi", "s-b1", "2026-10-02T03:00:00Z", true),
    futureBlock(snapshot.id, bodhi.id, "t-bodhi", "s-b2", "2026-10-05T03:00:00Z", true),
    futureBlock(snapshot.id, bodhi.id, "t-bodhi", "s-b3", "2026-10-06T03:00:00Z", false), // cancelled: not counted
    futureBlock(snapshot.id, aria.id, "t-aria-off", "s-a1", "2026-10-01T01:00:00Z", true), // started before NOW
  ]);
  await handle.db.insert(schema.recurringAvailabilityWindows).values([
    { snapshotId: snapshot.id, groupId: aria.id, wiseTeacherId: "t-aria-off", weekday: 1, startMinute: 540, endMinute: 720 },
    { snapshotId: snapshot.id, groupId: aria.id, wiseTeacherId: "t-aria-off", weekday: 3, startMinute: 540, endMinute: 720 },
  ]);
  await handle.db.insert(schema.dataIssues).values({
    snapshotId: snapshot.id, type: "completeness", severity: "high", entityType: "teacher", entityId: "t-cleo", entityName: "Cleo (Cleo)",
    message: 'Failed to fetch availability for teacher "Cleo (Cleo)": Wise API 500',
  });
  await handle.db.insert(schema.datedLeaves).values([
    { snapshotId: snapshot.id, groupId: aria.id, wiseTeacherId: "t-aria-off", startTime: new Date("2026-10-10T00:00:00Z"), endTime: new Date("2026-10-20T10:00:00Z") },
    { snapshotId: snapshot.id, groupId: aria.id, wiseTeacherId: "t-aria-off", startTime: new Date("2026-09-01T00:00:00Z"), endTime: new Date("2026-09-05T00:00:00Z") },
  ]);
  await handle.db.insert(schema.leaveRequests).values({
    spreadsheetId: "sheet", sheetName: "Form Responses 1", sourceRowNumber: 2, sourceFingerprint: "fp-1",
    tutorName: "Cleo", tutorCanonicalKey: "Cleo", endDate: "2026-10-15",
  });
  await handle.db.insert(schema.pastSessionBlocks).values([
    pastBlock("Aria", "t-aria-off", "p-a1", "2026-06-03T03:00:00Z", true),
    pastBlock("Aria", "t-aria-off", "p-a2", "2026-08-03T03:00:00Z", false), // cancelled
    pastBlock("Aria", "t-aria-off", "p-a0", "2026-02-10T03:00:00Z", true), // before history starts
    pastBlock("Departed", "t-departed", "p-d1", "2026-04-10T03:00:00Z", true), // not on the roster: history only
  ]);
  await handle.db.insert(schema.progressTestAttendanceLedger).values([
    ledgerRow("l-1", "Aria", "2026-05-20T03:00:00Z", "ENDED"),
    ledgerRow("l-2", "Aria", "2026-07-01T03:00:00Z", "CANCELLED"),
  ]);
  await handle.db.insert(schema.postClassSessions).values([
    postClassRow("pc-1", "2026-07-25T03:00:00Z", "ENDED"),
    postClassRow("pc-2", "2026-08-01T03:00:00Z", "CANCELLED"),
  ]);
  await handle.db.insert(schema.wiseActivityEvents).values([
    { eventId: "e1", eventName: "SessionFeedbackSubmitted", eventTimestamp: new Date("2026-09-20T03:00:00Z"), actorWiseUserId: "u-aria-on", actorRole: "TEACHER" },
    { eventId: "e2", eventName: "SessionUpdated", eventTimestamp: new Date("2026-09-30T03:00:00Z"), actorWiseUserId: "u-bodhi", actorRole: "ADMIN" },
    { eventId: "e3", eventName: "SessionUpdated", eventTimestamp: new Date("2026-09-29T03:00:00Z"), actorWiseUserId: "u-aria-off", actorRole: "STUDENT" },
  ]);
  await handle.db.insert(schema.tutorAttendanceEnrollments).values({ canonicalKey: "Bodhi", loginEmail: "bodhi@example.com", startDate: "2026-09-15" });
  return { snapshot };
}

describe("loadOffboardingSignals", () => {
  it("returns null without an active snapshot", async () => {
    expect(await loadOffboardingSignals(db, NOW)).toBeNull();
  });

  it("assembles each person on the active snapshot from every source", async () => {
    const { snapshot } = await seed();
    const signals = await loadOffboardingSignals(db, NOW);
    expect(signals).toMatchObject({ snapshotId: snapshot.id, snapshotCreatedAt: "2026-10-01T04:30:00.000Z", generatedAt: NOW.toISOString() });
    expect(signals!.people.map((person) => person.canonicalKey)).toEqual(["Aria", "Bodhi", "Cleo"]);

    const [aria, bodhi, cleo] = signals!.people;
    expect(aria.accounts.map((account) => account.wiseTeacherId)).toEqual(["t-aria-off", "t-aria-on"]);
    expect(aria.accounts[0]).toMatchObject({ relation: "TEACHER", courseCount: 2, activated: false, workingHourWindows: 2, availabilityKnown: true, email: "aria@example.com" });
    expect(aria.accounts[1]).toMatchObject({ courseCount: 0, activated: true, workingHourWindows: 0, joinedOn: "2026-01-20T00:00:00.000Z" });
    expect(aria.lastTaughtBySource).toEqual({ ledger: "2026-05-20T03:00:00.000Z", pastBlocks: "2026-06-03T03:00:00.000Z", postClass: "2026-07-25T03:00:00.000Z" });
    expect(aria).toMatchObject({
      lastTaughtAt: "2026-07-25T03:00:00.000Z", upcomingSessions: 0, nextSessionAt: null,
      upcomingLeaveUntil: "2026-10-20T10:00:00.000Z", lastTeacherActionAt: "2026-09-20T03:00:00.000Z", lastAdminActionAt: null, fullTime: false,
    });

    expect(bodhi).toMatchObject({ upcomingSessions: 2, nextSessionAt: "2026-10-02T03:00:00.000Z", lastAdminActionAt: "2026-09-30T03:00:00.000Z", fullTime: true });
    expect(bodhi.accounts[0].relation).toBe("ADMIN");

    expect(cleo.lastTaughtAt).toBeNull();
    expect(cleo.accounts[0]).toMatchObject({ status: null, relation: null, joinedOn: null, courseCount: null, activated: null, availabilityKnown: false, email: null });
    expect(cleo.upcomingLeaveUntil).toBe("2026-10-15T16:59:59.000Z");

    expect(signals!.taughtDates).toEqual({ Aria: ["2026-05-20", "2026-06-03", "2026-07-25"], Departed: ["2026-04-10"] });
  });
});

describe("loadFeedTimestamps", () => {
  it("reads the active snapshot's age and each feed's last successful run", async () => {
    await seed();
    await handle.db.insert(schema.progressTestSyncRuns).values([
      { status: "success", finishedAt: new Date("2026-10-01T02:57:00Z") },
      { status: "failed", finishedAt: new Date("2026-10-01T03:27:00Z") },
    ]);
    await handle.db.insert(schema.postClassSyncRuns).values({ status: "success", finishedAt: new Date("2026-10-01T03:13:00Z"), windowStart: "2026-09-28", windowEnd: "2026-10-01" });
    await handle.db.insert(schema.wiseActivitySyncRuns).values({ status: "success", triggerType: "cron", finishedAt: new Date("2026-10-01T03:02:00Z") });
    expect(await loadFeedTimestamps(db)).toEqual({
      tutorSnapshot: "2026-10-01T04:30:00.000Z",
      progressTests: "2026-10-01T02:57:00.000Z",
      postClass: "2026-10-01T03:13:00.000Z",
      wiseActivity: "2026-10-01T03:02:00.000Z",
      leaveRequests: null,
    });
  });
});
```

- [ ] **Step 2: Run it to verify it fails**

Run: `npx vitest run --project integration src/lib/tutor-offboarding/__tests__/signals.integration.test.ts`
Expected: FAIL — `Failed to resolve import "../signals"`.

- [ ] **Step 3: Implement the loaders**

Create `src/lib/tutor-offboarding/signals.ts`:

```ts
import { and, count, eq, gt, gte, inArray, isNotNull, isNull, like, lt, max, min, or, sql, type AnyColumn, type SQL } from "drizzle-orm";
import { getDb, type Database } from "@/lib/db";
import * as schema from "@/lib/db/schema";
import { bangkokDateKey } from "@/lib/room-capacity/dates";
import { HISTORY_START } from "./calibration";
import type { FeedTimestamps, LastTaughtBySource, OffboardingAccount, OffboardingSignals, PersonSignals } from "./types";

// ----------------------------------------------------------------------------
// Tutor Offboarding signals (spec §4.2): everything the score needs, read from
// Postgres only — never from Wise on the request path.
// ----------------------------------------------------------------------------

interface TaughtDayRow {
  canonicalKey: string | null;
  day: string;
  last: Date | null;
}

const iso = (value: Date | null | undefined): string | null => (value ? value.toISOString() : null);
const later = (a: string | null, b: string | null): string | null => (a === null ? b : b === null ? a : a > b ? a : b);
const earlier = (a: string | null, b: string | null): string | null => (a === null ? b : b === null ? a : a < b ? a : b);

/** The Bangkok calendar day of a timestamp column, as YYYY-MM-DD. */
function bangkokDay(column: AnyColumn): SQL<string> {
  return sql<string>`to_char((${column} at time zone 'Asia/Bangkok')::date, 'YYYY-MM-DD')`;
}

/** Taught days per person from the three history sources; a session counts only when it really happened (spec §4.3). */
async function loadTaughtDays(db: Database, now: Date) {
  const ledger = schema.progressTestAttendanceLedger;
  const blocks = schema.pastSessionBlocks;
  const postClass = schema.postClassSessions;
  const ledgerDay = bangkokDay(ledger.scheduledStartTime);
  const blockDay = bangkokDay(blocks.startTime);
  const postClassDay = bangkokDay(postClass.scheduledStartAt);
  const [fromLedger, fromBlocks, fromPostClass] = await Promise.all([
    db.select({ canonicalKey: ledger.tutorCanonicalKey, day: ledgerDay, last: max(ledger.scheduledStartTime) })
      .from(ledger)
      .where(and(isNotNull(ledger.tutorCanonicalKey), eq(ledger.meetingStatus, "ENDED"),
        gte(ledger.scheduledStartTime, HISTORY_START), lt(ledger.scheduledStartTime, now)))
      .groupBy(ledger.tutorCanonicalKey, ledgerDay),
    db.select({ canonicalKey: blocks.groupCanonicalKey, day: blockDay, last: max(blocks.startTime) })
      .from(blocks)
      .where(and(eq(blocks.isBlocking, true), gte(blocks.startTime, HISTORY_START), lt(blocks.startTime, now)))
      .groupBy(blocks.groupCanonicalKey, blockDay),
    db.select({ canonicalKey: postClass.canonicalTutorKey, day: postClassDay, last: max(postClass.scheduledStartAt) })
      .from(postClass)
      .where(and(isNotNull(postClass.canonicalTutorKey), eq(postClass.finalStatus, "ENDED"),
        gte(postClass.scheduledStartAt, HISTORY_START), lt(postClass.scheduledStartAt, now)))
      .groupBy(postClass.canonicalTutorKey, postClassDay),
  ]);
  return { fromLedger, fromBlocks, fromPostClass };
}

/** People on the active snapshot with every signal, plus every tutor's taught dates. Null without an active snapshot. */
export async function loadOffboardingSignals(db: Database = getDb(), now: Date = new Date()): Promise<OffboardingSignals | null> {
  const [snapshot] = await db.select({ id: schema.snapshots.id, createdAt: schema.snapshots.createdAt })
    .from(schema.snapshots).where(eq(schema.snapshots.active, true)).limit(1);
  if (!snapshot) return null;

  const groups = schema.tutorIdentityGroups;
  const members = schema.tutorIdentityGroupMembers;
  const accounts = schema.tutorWiseAccounts;
  const memberRows = await db.select({
    groupId: groups.id,
    canonicalKey: groups.canonicalKey,
    groupDisplayName: groups.displayName,
    wiseTeacherId: members.wiseTeacherId,
    wiseUserId: members.wiseUserId,
    displayName: members.wiseDisplayName,
    isOnlineVariant: members.isOnlineVariant,
    email: accounts.email,
    status: accounts.status,
    relation: accounts.wiseRelation,
    joinedOn: accounts.wiseJoinedOn,
    courseCount: accounts.wiseCourseCount,
    activated: accounts.wiseActivated,
  }).from(members)
    .innerJoin(groups, eq(groups.id, members.groupId))
    .leftJoin(accounts, eq(accounts.wiseTeacherId, members.wiseTeacherId))
    .where(eq(groups.snapshotId, snapshot.id));

  const userIds = [...new Set(memberRows.map((row) => row.wiseUserId).filter((id): id is string => Boolean(id)))];
  const todayKey = bangkokDateKey(now);
  const blocks = schema.futureSessionBlocks;
  const windows = schema.recurringAvailabilityWindows;
  const leaves = schema.datedLeaves;
  const requests = schema.leaveRequests;
  const events = schema.wiseActivityEvents;
  const [upcoming, windowCounts, availabilityIssues, wiseLeaves, leaveRequests, actions, fullTime, taught] = await Promise.all([
    db.select({ groupId: blocks.groupId, sessions: count(), next: min(blocks.startTime) })
      .from(blocks)
      .where(and(eq(blocks.snapshotId, snapshot.id), eq(blocks.isBlocking, true), gt(blocks.startTime, now)))
      .groupBy(blocks.groupId),
    db.select({ wiseTeacherId: windows.wiseTeacherId, windows: count() })
      .from(windows).where(eq(windows.snapshotId, snapshot.id)).groupBy(windows.wiseTeacherId),
    db.selectDistinct({ wiseTeacherId: schema.dataIssues.entityId })
      .from(schema.dataIssues)
      .where(and(eq(schema.dataIssues.snapshotId, snapshot.id), like(schema.dataIssues.message, "Failed to fetch availability%"))),
    db.select({ groupId: leaves.groupId, until: max(leaves.endTime) })
      .from(leaves).where(and(eq(leaves.snapshotId, snapshot.id), gt(leaves.endTime, now))).groupBy(leaves.groupId),
    db.select({ canonicalKey: requests.tutorCanonicalKey, endTime: max(requests.leaveEndTime), endDate: max(requests.endDate) })
      .from(requests)
      .where(and(isNotNull(requests.tutorCanonicalKey), or(gt(requests.leaveEndTime, now),
        and(isNull(requests.leaveEndTime), gte(requests.endDate, todayKey)))))
      .groupBy(requests.tutorCanonicalKey),
    userIds.length === 0
      ? Promise.resolve([] as Array<{ userId: string | null; role: string | null; last: Date | null }>)
      : db.select({ userId: events.actorWiseUserId, role: events.actorRole, last: max(events.eventTimestamp) })
        .from(events)
        .where(and(inArray(events.actorWiseUserId, userIds), inArray(events.actorRole, ["TEACHER", "ADMIN", "OWNER"])))
        .groupBy(events.actorWiseUserId, events.actorRole),
    db.select({ canonicalKey: schema.tutorAttendanceEnrollments.canonicalKey })
      .from(schema.tutorAttendanceEnrollments).where(eq(schema.tutorAttendanceEnrollments.active, true)),
    loadTaughtDays(db, now),
  ]);

  const upcomingByGroup = new Map(upcoming.map((row) => [row.groupId, row]));
  const windowsByTeacher = new Map(windowCounts.map((row) => [row.wiseTeacherId, row.windows]));
  // OFF-02: a failed availability fetch makes working hours unknown, not zero.
  const failedAvailability = new Set(availabilityIssues.map((row) => row.wiseTeacherId).filter((id): id is string => Boolean(id)));
  const wiseLeaveByGroup = new Map(wiseLeaves.map((row) => [row.groupId, iso(row.until)]));
  const leaveRequestByKey = new Map(leaveRequests.filter((row) => row.canonicalKey).map((row) => [
    row.canonicalKey as string,
    later(iso(row.endTime), row.endDate ? new Date(`${row.endDate}T23:59:59+07:00`).toISOString() : null),
  ]));
  const fullTimeKeys = new Set(fullTime.map((row) => row.canonicalKey));
  const teacherActionByUser = new Map<string, string>();
  const adminActionByUser = new Map<string, string>();
  for (const row of actions) {
    if (!row.userId || !row.last) continue;
    const target = row.role === "TEACHER" ? teacherActionByUser : adminActionByUser;
    target.set(row.userId, later(target.get(row.userId) ?? null, row.last.toISOString())!);
  }

  const taughtDates = new Map<string, Set<string>>();
  const lastBySource = new Map<string, LastTaughtBySource>();
  const addDays = (rows: TaughtDayRow[], source: keyof LastTaughtBySource) => {
    for (const row of rows) {
      if (!row.canonicalKey) continue;
      const days = taughtDates.get(row.canonicalKey) ?? new Set<string>();
      days.add(row.day);
      taughtDates.set(row.canonicalKey, days);
      const bySource = lastBySource.get(row.canonicalKey) ?? { ledger: null, pastBlocks: null, postClass: null };
      bySource[source] = later(bySource[source], iso(row.last));
      lastBySource.set(row.canonicalKey, bySource);
    }
  };
  addDays(taught.fromLedger, "ledger");
  addDays(taught.fromBlocks, "pastBlocks");
  addDays(taught.fromPostClass, "postClass");

  const byKey = new Map<string, { displayName: string; groupIds: Set<string>; rows: typeof memberRows }>();
  for (const row of memberRows) {
    const entry = byKey.get(row.canonicalKey) ?? { displayName: row.groupDisplayName, groupIds: new Set<string>(), rows: [] };
    entry.groupIds.add(row.groupId);
    entry.rows.push(row);
    byKey.set(row.canonicalKey, entry);
  }

  const people: PersonSignals[] = [...byKey.entries()].map(([canonicalKey, entry]) => {
    const personAccounts: OffboardingAccount[] = entry.rows.map((row) => ({
      wiseTeacherId: row.wiseTeacherId,
      wiseUserId: row.wiseUserId,
      displayName: row.displayName,
      isOnlineVariant: row.isOnlineVariant,
      email: row.email ?? null,
      status: row.status ?? null,
      relation: row.relation ?? null,
      joinedOn: iso(row.joinedOn),
      courseCount: row.courseCount ?? null,
      activated: row.activated ?? null,
      availabilityKnown: !failedAvailability.has(row.wiseTeacherId),
      workingHourWindows: windowsByTeacher.get(row.wiseTeacherId) ?? 0,
    })).sort((a, b) => Number(a.isOnlineVariant) - Number(b.isOnlineVariant) || a.displayName.localeCompare(b.displayName));
    const groupIds = [...entry.groupIds];
    const upcomingRows = groupIds.flatMap((id) => upcomingByGroup.get(id) ?? []);
    const bySource = lastBySource.get(canonicalKey) ?? { ledger: null, pastBlocks: null, postClass: null };
    const ids = personAccounts.map((account) => account.wiseUserId).filter((id): id is string => Boolean(id));
    return {
      canonicalKey,
      displayName: entry.displayName,
      accounts: personAccounts,
      lastTaughtAt: later(later(bySource.ledger, bySource.pastBlocks), bySource.postClass),
      lastTaughtBySource: bySource,
      upcomingSessions: upcomingRows.reduce((total, row) => total + row.sessions, 0),
      nextSessionAt: upcomingRows.reduce<string | null>((next, row) => earlier(next, iso(row.next)), null),
      upcomingLeaveUntil: later(groupIds.reduce<string | null>((until, id) => later(until, wiseLeaveByGroup.get(id) ?? null), null),
        leaveRequestByKey.get(canonicalKey) ?? null),
      lastTeacherActionAt: ids.reduce<string | null>((last, id) => later(last, teacherActionByUser.get(id) ?? null), null),
      lastAdminActionAt: ids.reduce<string | null>((last, id) => later(last, adminActionByUser.get(id) ?? null), null),
      fullTime: fullTimeKeys.has(canonicalKey),
    };
  }).sort((a, b) => a.displayName.localeCompare(b.displayName));

  return {
    snapshotId: snapshot.id,
    snapshotCreatedAt: snapshot.createdAt.toISOString(),
    generatedAt: now.toISOString(),
    people,
    taughtDates: Object.fromEntries([...taughtDates.entries()].map(([key, days]) => [key, [...days].sort()])),
  };
}

/**
 * OFF-07 inputs. The tutor snapshot is judged by its own age: promoted runs are recorded `failed` whenever contact
 * warnings exist, so `sync_runs` has no recent `success` row. The other feeds use their last successful run.
 */
export async function loadFeedTimestamps(db: Database = getDb()): Promise<FeedTimestamps> {
  const [[snapshot], [progressTests], [postClass], [wiseActivity], [leaveRequests]] = await Promise.all([
    db.select({ at: schema.snapshots.createdAt }).from(schema.snapshots).where(eq(schema.snapshots.active, true)).limit(1),
    db.select({ at: max(schema.progressTestSyncRuns.finishedAt) }).from(schema.progressTestSyncRuns)
      .where(eq(schema.progressTestSyncRuns.status, "success")),
    db.select({ at: max(schema.postClassSyncRuns.finishedAt) }).from(schema.postClassSyncRuns)
      .where(eq(schema.postClassSyncRuns.status, "success")),
    db.select({ at: max(schema.wiseActivitySyncRuns.finishedAt) }).from(schema.wiseActivitySyncRuns)
      .where(eq(schema.wiseActivitySyncRuns.status, "success")),
    db.select({ at: max(schema.leaveRequestSyncRuns.finishedAt) }).from(schema.leaveRequestSyncRuns)
      .where(eq(schema.leaveRequestSyncRuns.status, "success")),
  ]);
  return {
    tutorSnapshot: iso(snapshot?.at),
    progressTests: iso(progressTests?.at),
    postClass: iso(postClass?.at),
    wiseActivity: iso(wiseActivity?.at),
    leaveRequests: iso(leaveRequests?.at),
  };
}
```

- [ ] **Step 4: Run it to verify it passes**

Run: `npx vitest run --project integration src/lib/tutor-offboarding/__tests__/signals.integration.test.ts`
Expected: PASS (3 tests). If a column name differs from the schema, fix the loader, not the test's expectations about behaviour.

- [ ] **Step 5: Typecheck**

Run: `npm run typecheck`
Expected: no errors.

- [ ] **Step 6: Commit**

```bash
git add src/lib/tutor-offboarding/signals.ts src/lib/tutor-offboarding/__tests__/signals.integration.test.ts
git commit -m "$(cat <<'EOF'
Tutor Offboarding: signals loader and feed timestamps from Postgres

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>
EOF
)"
```

---

### Task 5: Decisions, grants, access and the error mapper

**Files:**
- Create: `src/lib/tutor-offboarding/errors.ts`, `decisions.ts`, `grants.ts`, `access.ts`, `api.ts`
- Test: `src/lib/tutor-offboarding/__tests__/store.integration.test.ts`
- Test: `src/lib/tutor-offboarding/__tests__/api.test.ts`

**Interfaces:**
- Consumes: schema (Task 1), types (Task 3), `withDatabaseTransaction` (`@/lib/db/transaction`), `sqlStateOf` (`@/lib/db/sql-state`), `isSuperAdminEmail` (`@/lib/admin-users/policy`), `AdminUsersAccessError` (`@/lib/admin-users/types`), `auth` (`@/lib/auth`).
- Produces:
  - `class TutorOffboardingError extends Error { status: 400 | 401 | 403 | 404 | 409 | 422 }`, `isMissingSchemaError(error: unknown): boolean`
  - `SNOOZE_DAYS = [90, 365] as const`, `type SnoozeDays`, `listDecisions(db?, now?, logLimit?): Promise<DecisionRecord[]>`, `recordStillWithUs(db, input): Promise<DecisionRecord>`, `revokeDecision(db, input): Promise<DecisionRecord>`
  - `normalizeOffboardingEmail(value): string`, `listGrants(db?): Promise<GrantRecord[]>`, `hasRemovalGrant(email, db?): Promise<boolean>`, `changeGrant(db, input): Promise<GrantRecord[]>`
  - `viewerForEmail(email, db?, env?): Promise<TutorOffboardingViewer>`, `requireTutorOffboardingAdmin(db?, env?): Promise<TutorOffboardingViewer>`
  - `tutorOffboardingErrorResponse(route: string, error: unknown, fallback: string): NextResponse`

- [ ] **Step 1: Write the failing integration test for the stores**

Create `src/lib/tutor-offboarding/__tests__/store.integration.test.ts`:

```ts
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { asc, eq } from "drizzle-orm";
import { startTestDb, stopTestDb, truncateAll } from "@/tests/integration/db-helper";
import type { Database } from "@/lib/db";
import * as schema from "@/lib/db/schema";
import { listDecisions, recordStillWithUs, revokeDecision } from "../decisions";
import { changeGrant, hasRemovalGrant } from "../grants";

let handle: Awaited<ReturnType<typeof startTestDb>>;
let db: Database;
const NOW = new Date("2026-10-01T05:00:00.000Z");
const SCORE = { likelihood: 96, band: "very_likely_gone" as const, reasons: ["Last class 120 days ago (3 Jun)"] };

beforeAll(async () => { handle = await startTestDb(); db = handle.db as unknown as Database; });
afterAll(async () => { if (handle) await stopTestDb(handle); });
beforeEach(async () => { await truncateAll(handle.db); });

describe("still-with-us decisions", () => {
  it("records the score it overrode and refuses a second open decision for the same person", async () => {
    const decision = await recordStillWithUs(db, { canonicalKey: "Aria", note: "On a term break", snoozeDays: 90, actorEmail: "admin@example.com", score: SCORE, now: NOW });
    expect(decision).toMatchObject({
      canonicalKey: "Aria", note: "On a term break", likelihoodAtDecision: 96, bandAtDecision: "very_likely_gone",
      reasons: ["Last class 120 days ago (3 Jun)"], decidedByEmail: "admin@example.com",
      decidedAt: NOW.toISOString(), snoozeUntil: "2026-12-30T05:00:00.000Z", revokedAt: null,
    });
    await expect(recordStillWithUs(db, { canonicalKey: "Aria", note: null, snoozeDays: 365, actorEmail: "other@example.com", score: SCORE, now: NOW }))
      .rejects.toMatchObject({ status: 409 });
  });

  it("undoes a decision once, after which a new one is allowed", async () => {
    const decision = await recordStillWithUs(db, { canonicalKey: "Aria", note: null, snoozeDays: 90, actorEmail: "admin@example.com", score: SCORE, now: NOW });
    expect(await revokeDecision(db, { decisionId: decision.id, actorEmail: "other@example.com", now: NOW }))
      .toMatchObject({ revokedAt: NOW.toISOString(), revokedByEmail: "other@example.com" });
    await expect(revokeDecision(db, { decisionId: decision.id, actorEmail: "other@example.com", now: NOW })).rejects.toMatchObject({ status: 404 });
    await expect(recordStillWithUs(db, { canonicalKey: "Aria", note: null, snoozeDays: 90, actorEmail: "admin@example.com", score: SCORE, now: NOW }))
      .resolves.toMatchObject({ canonicalKey: "Aria" });
  });

  it("always lists open decisions, even beyond the log limit", async () => {
    const aria = await recordStillWithUs(db, { canonicalKey: "Aria", note: null, snoozeDays: 90, actorEmail: "admin@example.com", score: SCORE, now: NOW });
    const bodhi = await recordStillWithUs(db, { canonicalKey: "Bodhi", note: null, snoozeDays: 90, actorEmail: "admin@example.com", score: SCORE,
      now: new Date(NOW.getTime() + 60_000) });
    const listed = await listDecisions(db, new Date(NOW.getTime() + 120_000), 1);
    expect(listed.map((decision) => decision.id)).toEqual([bodhi.id, aria.id]);
  });
});

describe("removal grants (OFF-11)", () => {
  beforeEach(async () => {
    await handle.db.insert(schema.adminUsers).values([{ email: "Ops@Example.com" }, { email: "off@example.com", disabled: true }]);
  });

  it("grants only enabled admins, refuses duplicates, and audits every change", async () => {
    expect(await changeGrant(db, { action: "grant", email: " ops@example.com ", actorEmail: "owner@example.com" }))
      .toEqual([{ email: "ops@example.com", grantedByEmail: "owner@example.com", grantedAt: expect.any(String) }]);
    await expect(changeGrant(db, { action: "grant", email: "ops@example.com", actorEmail: "owner@example.com" })).rejects.toMatchObject({ status: 409 });
    await expect(changeGrant(db, { action: "grant", email: "off@example.com", actorEmail: "owner@example.com" })).rejects.toMatchObject({ status: 422 });
    await expect(changeGrant(db, { action: "grant", email: "stranger@example.com", actorEmail: "owner@example.com" })).rejects.toMatchObject({ status: 422 });
    expect(await hasRemovalGrant("OPS@example.com", db)).toBe(true);
    expect(await changeGrant(db, { action: "revoke", email: "ops@example.com", actorEmail: "owner@example.com" })).toEqual([]);
    await expect(changeGrant(db, { action: "revoke", email: "ops@example.com", actorEmail: "owner@example.com" })).rejects.toMatchObject({ status: 404 });
    expect(await hasRemovalGrant("ops@example.com", db)).toBe(false);
    const audit = await handle.db.select().from(schema.tutorOffboardingAccessAuditLog).orderBy(asc(schema.tutorOffboardingAccessAuditLog.createdAt));
    expect(audit.map((row) => [row.action, row.email, row.actorEmail])).toEqual([
      ["grant", "ops@example.com", "owner@example.com"],
      ["revoke", "ops@example.com", "owner@example.com"],
    ]);
  });

  it("stops honouring a grant once the admin is disabled", async () => {
    await changeGrant(db, { action: "grant", email: "ops@example.com", actorEmail: "owner@example.com" });
    await handle.db.update(schema.adminUsers).set({ disabled: true }).where(eq(schema.adminUsers.email, "Ops@Example.com"));
    expect(await hasRemovalGrant("ops@example.com", db)).toBe(false);
  });
});
```

- [ ] **Step 2: Write the failing unit test for the error mapper**

Create `src/lib/tutor-offboarding/__tests__/api.test.ts`:

```ts
import { afterEach, describe, expect, it, vi } from "vitest";
import { z } from "zod";
import { AdminUsersAccessError } from "@/lib/admin-users/types";
import { tutorOffboardingErrorResponse } from "../api";
import { TutorOffboardingError } from "../errors";

afterEach(() => vi.restoreAllMocks());

describe("tutorOffboardingErrorResponse", () => {
  it("passes Next's abandoned-render signal through", () => {
    const signal = { digest: "HANGING_PROMISE_REJECTION" };
    expect(() => tutorOffboardingErrorResponse("route", signal, "fallback")).toThrow();
  });

  it("maps its own and the owner errors to their status", async () => {
    const own = tutorOffboardingErrorResponse("route", new TutorOffboardingError("Already marked.", 409), "fallback");
    expect([own.status, await own.json()]).toEqual([409, { error: "Already marked." }]);
    const owner = tutorOffboardingErrorResponse("route", new AdminUsersAccessError("nope", 403), "fallback");
    expect([owner.status, await owner.json()]).toEqual([403, { error: "Only the website owner can change who can remove tutors." }]);
  });

  it("maps validation errors to 400 and a missing migration to 503", async () => {
    const parsed = z.object({ a: z.string() }).safeParse({});
    const invalid = tutorOffboardingErrorResponse("route", parsed.error, "fallback");
    expect(invalid.status).toBe(400);
    const missing = tutorOffboardingErrorResponse("route", { cause: { code: "42P01" } }, "fallback");
    expect([missing.status, await missing.json()]).toEqual([503, { error: "Tutor Offboarding is not set up yet (database migration pending)." }]);
  });

  it("hides unknown errors and logs only their name and SQLSTATE", async () => {
    const log = vi.spyOn(console, "error").mockImplementation(() => undefined);
    const response = tutorOffboardingErrorResponse("[route]", new Error("insert into ... values ('secret note')"), "Could not save.");
    expect([response.status, await response.json()]).toEqual([500, { error: "Could not save." }]);
    expect(log).toHaveBeenCalledWith("[route]", { errorName: "Error", sqlState: null });
  });
});
```

- [ ] **Step 3: Run both to verify they fail**

Run: `npx vitest run --project unit src/lib/tutor-offboarding/__tests__/api.test.ts`
Expected: FAIL — `Failed to resolve import "../api"`.
Run: `npx vitest run --project integration src/lib/tutor-offboarding/__tests__/store.integration.test.ts`
Expected: FAIL — `Failed to resolve import "../decisions"`.

- [ ] **Step 4: Write the errors module**

Create `src/lib/tutor-offboarding/errors.ts`:

```ts
import { sqlStateOf } from "@/lib/db/sql-state";

/** A request Tutor Offboarding refuses on purpose; the message is safe to show. */
export class TutorOffboardingError extends Error {
  constructor(message: string, readonly status: 400 | 401 | 403 | 404 | 409 | 422) {
    super(message);
    this.name = "TutorOffboardingError";
  }
}

/** 42P01 (table) or 42703 (column) missing: migration A is not applied yet. */
export function isMissingSchemaError(error: unknown): boolean {
  const state = sqlStateOf(error);
  return state === "42P01" || state === "42703";
}
```

- [ ] **Step 5: Write the decisions store**

Create `src/lib/tutor-offboarding/decisions.ts`:

```ts
import { and, desc, eq, gt, isNull, sql } from "drizzle-orm";
import { getDb, type Database } from "@/lib/db";
import * as schema from "@/lib/db/schema";
import { withDatabaseTransaction } from "@/lib/db/transaction";
import { TutorOffboardingError } from "./errors";
import type { DecisionRecord, OffboardingBand } from "./types";

export const SNOOZE_DAYS = [90, 365] as const;
export type SnoozeDays = (typeof SNOOZE_DAYS)[number];

const DAY_MS = 86_400_000;
type DecisionRow = typeof schema.tutorOffboardingDecisions.$inferSelect;

function toRecord(row: DecisionRow): DecisionRecord {
  return {
    id: row.id,
    canonicalKey: row.canonicalKey,
    note: row.note,
    snoozeUntil: row.snoozeUntil.toISOString(),
    likelihoodAtDecision: row.likelihoodAtDecision,
    bandAtDecision: row.bandAtDecision as OffboardingBand,
    reasons: row.reasons,
    decidedByEmail: row.decidedByEmail,
    decidedAt: row.decidedAt.toISOString(),
    revokedAt: row.revokedAt?.toISOString() ?? null,
    revokedByEmail: row.revokedByEmail,
  };
}

/** The newest `logLimit` decisions plus every open one, newest first. */
export async function listDecisions(db: Database = getDb(), now: Date = new Date(), logLimit = 200): Promise<DecisionRecord[]> {
  const table = schema.tutorOffboardingDecisions;
  const [open, recent] = await Promise.all([
    db.select().from(table).where(and(isNull(table.revokedAt), gt(table.snoozeUntil, now))),
    db.select().from(table).orderBy(desc(table.decidedAt)).limit(logLimit),
  ]);
  const byId = new Map([...recent, ...open].map((row) => [row.id, row]));
  return [...byId.values()].sort((a, b) => b.decidedAt.getTime() - a.decidedAt.getTime()).map(toRecord);
}

/** Records "Still with us" with the score it overrides (future labels). One open decision per person. */
export async function recordStillWithUs(db: Database, input: {
  canonicalKey: string;
  note: string | null;
  snoozeDays: SnoozeDays;
  actorEmail: string;
  score: { likelihood: number; band: OffboardingBand; reasons: string[] };
  now?: Date;
}): Promise<DecisionRecord> {
  const now = input.now ?? new Date();
  const table = schema.tutorOffboardingDecisions;
  return withDatabaseTransaction(db, async (tx) => {
    await tx.execute(sql`select pg_advisory_xact_lock(hashtext(${`tutor_offboarding_decision:${input.canonicalKey}`}))`);
    const [open] = await tx.select({ id: table.id }).from(table)
      .where(and(eq(table.canonicalKey, input.canonicalKey), isNull(table.revokedAt), gt(table.snoozeUntil, now))).limit(1);
    if (open) throw new TutorOffboardingError("This tutor is already marked still with us.", 409);
    const [row] = await tx.insert(table).values({
      canonicalKey: input.canonicalKey,
      note: input.note,
      snoozeUntil: new Date(now.getTime() + input.snoozeDays * DAY_MS),
      likelihoodAtDecision: input.score.likelihood,
      bandAtDecision: input.score.band,
      reasons: input.score.reasons,
      decidedByEmail: input.actorEmail,
      decidedAt: now,
    }).returning();
    return toRecord(row);
  });
}

export async function revokeDecision(db: Database, input: { decisionId: string; actorEmail: string; now?: Date }): Promise<DecisionRecord> {
  const table = schema.tutorOffboardingDecisions;
  const [row] = await db.update(table).set({ revokedAt: input.now ?? new Date(), revokedByEmail: input.actorEmail })
    .where(and(eq(table.id, input.decisionId), isNull(table.revokedAt))).returning();
  if (!row) throw new TutorOffboardingError("That decision was not found or was already undone.", 404);
  return toRecord(row);
}
```

- [ ] **Step 6: Write the grants store**

Create `src/lib/tutor-offboarding/grants.ts`:

```ts
import { asc, eq, sql } from "drizzle-orm";
import { getDb, type Database } from "@/lib/db";
import * as schema from "@/lib/db/schema";
import { withDatabaseTransaction } from "@/lib/db/transaction";
import { TutorOffboardingError } from "./errors";
import type { GrantRecord } from "./types";

export function normalizeOffboardingEmail(value: string | null | undefined): string {
  return String(value ?? "").trim().toLowerCase();
}

export async function listGrants(db: Database = getDb()): Promise<GrantRecord[]> {
  const grants = schema.tutorOffboardingAccessGrants;
  const rows = await db.select().from(grants).orderBy(asc(grants.email));
  return rows.map((row) => ({ email: row.email, grantedByEmail: row.grantedByEmail, grantedAt: row.grantedAt.toISOString() }));
}

/** OFF-11: a grant counts only while its holder is an enabled admin, and is always read from Postgres. */
export async function hasRemovalGrant(email: string, db: Database = getDb()): Promise<boolean> {
  const normalized = normalizeOffboardingEmail(email);
  if (!normalized) return false;
  const grants = schema.tutorOffboardingAccessGrants;
  const rows = await db.select({ email: grants.email }).from(grants)
    .innerJoin(schema.adminUsers, sql`lower(btrim(${schema.adminUsers.email})) = ${grants.email}`)
    .where(sql`${grants.email} = ${normalized} and ${schema.adminUsers.disabled} = false`)
    .limit(1);
  return rows.length > 0;
}

/** Owner-only grant change, serialized and audited. Returns the grants after the change. */
export async function changeGrant(db: Database, input: { action: "grant" | "revoke"; email: string; actorEmail: string }): Promise<GrantRecord[]> {
  const email = normalizeOffboardingEmail(input.email);
  const grants = schema.tutorOffboardingAccessGrants;
  return withDatabaseTransaction(db, async (tx) => {
    await tx.execute(sql`select pg_advisory_xact_lock(hashtext('tutor_offboarding_grants'))`);
    if (input.action === "grant") {
      const [admin] = await tx.select({ disabled: schema.adminUsers.disabled }).from(schema.adminUsers)
        .where(sql`lower(btrim(${schema.adminUsers.email})) = ${email}`).limit(1);
      if (!admin || admin.disabled) throw new TutorOffboardingError("Only an enabled admin user can be allowed to remove tutors.", 422);
      const inserted = await tx.insert(grants).values({ email, grantedByEmail: input.actorEmail }).onConflictDoNothing().returning({ email: grants.email });
      if (inserted.length === 0) throw new TutorOffboardingError("That admin can already remove tutors.", 409);
    } else {
      const removed = await tx.delete(grants).where(eq(grants.email, email)).returning({ email: grants.email });
      if (removed.length === 0) throw new TutorOffboardingError("That admin was not allowed to remove tutors.", 404);
    }
    await tx.insert(schema.tutorOffboardingAccessAuditLog).values({ action: input.action, email, actorEmail: input.actorEmail });
    return listGrants(tx);
  });
}
```

- [ ] **Step 7: Write access guards and the error mapper**

Create `src/lib/tutor-offboarding/access.ts`:

```ts
import "server-only";

import { isSuperAdminEmail } from "@/lib/admin-users/policy";
import type { AdminAccessEnvironment } from "@/lib/admin-users/types";
import { auth } from "@/lib/auth";
import { getDb, type Database } from "@/lib/db";
import { isMissingSchemaError, TutorOffboardingError } from "./errors";
import { hasRemovalGrant, normalizeOffboardingEmail } from "./grants";
import type { TutorOffboardingViewer } from "./types";

/** Who is looking: owner status from SUPER_ADMIN_EMAILS; the removal grant read fresh (OFF-11). */
export async function viewerForEmail(
  email: string,
  db: Database = getDb(),
  env: AdminAccessEnvironment = process.env,
): Promise<TutorOffboardingViewer> {
  const normalized = normalizeOffboardingEmail(email);
  const canRemove = await hasRemovalGrant(normalized, db).catch((error: unknown) => {
    if (isMissingSchemaError(error)) return false;
    throw error;
  });
  return { email: normalized, isOwner: isSuperAdminEmail(normalized, env), canRemove };
}

/** An admin session is required; page scope (`allowedPages`) is enforced by the proxy. */
export async function requireTutorOffboardingAdmin(
  db: Database = getDb(),
  env: AdminAccessEnvironment = process.env,
): Promise<TutorOffboardingViewer> {
  const session = await auth();
  const email = normalizeOffboardingEmail(session?.user?.email);
  if (!email) throw new TutorOffboardingError("Unauthorized", 401);
  if (session?.user?.role !== "admin") throw new TutorOffboardingError("Forbidden", 403);
  return viewerForEmail(email, db, env);
}
```

Create `src/lib/tutor-offboarding/api.ts`:

```ts
import { NextResponse } from "next/server";
import { ZodError } from "zod";
import { AdminUsersAccessError } from "@/lib/admin-users/types";
import { sqlStateOf } from "@/lib/db/sql-state";
import { isMissingSchemaError, TutorOffboardingError } from "./errors";

/**
 * Shape B error mapper for the Tutor Offboarding routes. Unknown errors are never serialized: database errors can
 * carry query parameters, and those hold admin notes and emails.
 */
export function tutorOffboardingErrorResponse(route: string, error: unknown, fallback: string): NextResponse {
  if (typeof error === "object" && error !== null && (error as { digest?: unknown }).digest === "HANGING_PROMISE_REJECTION") {
    throw error;
  }
  if (error instanceof TutorOffboardingError) return NextResponse.json({ error: error.message }, { status: error.status });
  if (error instanceof AdminUsersAccessError) {
    return NextResponse.json(
      { error: error.status === 403 ? "Only the website owner can change who can remove tutors." : error.message },
      { status: error.status },
    );
  }
  if (error instanceof ZodError) {
    return NextResponse.json({ error: "The request payload is invalid.", issues: error.issues }, { status: 400 });
  }
  if (isMissingSchemaError(error)) {
    return NextResponse.json({ error: "Tutor Offboarding is not set up yet (database migration pending)." }, { status: 503 });
  }
  console.error(route, { errorName: error instanceof Error ? error.name : "UnknownError", sqlState: sqlStateOf(error) });
  return NextResponse.json({ error: fallback }, { status: 500 });
}
```

- [ ] **Step 8: Run both test files to verify they pass**

Run: `npx vitest run --project unit src/lib/tutor-offboarding/__tests__/api.test.ts`
Expected: PASS (4 tests).
Run: `npx vitest run --project integration src/lib/tutor-offboarding/__tests__/store.integration.test.ts`
Expected: PASS (5 tests).

- [ ] **Step 9: Commit**

```bash
git add src/lib/tutor-offboarding/errors.ts src/lib/tutor-offboarding/decisions.ts src/lib/tutor-offboarding/grants.ts \
  src/lib/tutor-offboarding/access.ts src/lib/tutor-offboarding/api.ts \
  src/lib/tutor-offboarding/__tests__/store.integration.test.ts src/lib/tutor-offboarding/__tests__/api.test.ts
git commit -m "$(cat <<'EOF'
Tutor Offboarding: decisions and removal-grant stores, access, error mapper

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>
EOF
)"
```

---

### Task 6: Dashboard builder and the cached service

**Files:**
- Create: `src/lib/tutor-offboarding/data.ts`
- Create: `src/lib/tutor-offboarding/service.ts`
- Test: `src/lib/tutor-offboarding/__tests__/data.test.ts`

**Interfaces:**
- Consumes: `buildCalibrationCurve` (Task 2), `scorePerson` (Task 3), `loadOffboardingSignals`, `loadFeedTimestamps` (Task 4), `listDecisions`, `listGrants`, `isMissingSchemaError` (Task 5).
- Produces:
  - `FEEDS: ReadonlyArray<{ key: FeedKey; label: string; maxAgeHours: number }>`
  - `evaluateFreshness(timestamps: FeedTimestamps, now: Date): FreshnessReport`
  - `openDecisionsByKey(decisions: DecisionRecord[], now: Date): Map<string, DecisionRecord>`
  - `buildOffboardingDashboard(input: { signals: OffboardingSignals; feeds: FeedTimestamps; decisions: DecisionRecord[]; grants: GrantRecord[] | null; viewer: TutorOffboardingViewer; now: Date }): OffboardingDashboardData`
  - `getCachedOffboardingSignals(): Promise<OffboardingSignals | null>` (`"use cache"`, tag `snapshot`)
  - `loadTutorOffboardingDashboard(viewer: TutorOffboardingViewer): Promise<OffboardingDashboard>`
  - `findPersonRow(viewer: TutorOffboardingViewer, canonicalKey: string): Promise<OffboardingPersonRow | null>`

- [ ] **Step 1: Write the failing test**

Create `src/lib/tutor-offboarding/__tests__/data.test.ts`:

```ts
import { describe, expect, it } from "vitest";
import { buildOffboardingDashboard, evaluateFreshness, openDecisionsByKey } from "../data";
import type { DecisionRecord, FeedTimestamps, OffboardingAccount, OffboardingSignals, PersonSignals } from "../types";

const NOW = new Date("2026-10-01T05:00:00.000Z");
const FRESH: FeedTimestamps = {
  tutorSnapshot: "2026-10-01T04:30:00.000Z",
  progressTests: "2026-10-01T02:57:00.000Z",
  postClass: "2026-10-01T03:13:00.000Z",
  wiseActivity: "2026-10-01T03:02:00.000Z",
  leaveRequests: "2026-10-01T03:15:00.000Z",
};
const VIEWER = { email: "admin@example.com", isOwner: false, canRemove: false };

function account(key: string, overrides: Partial<OffboardingAccount> = {}): OffboardingAccount {
  return {
    wiseTeacherId: `t-${key}`, wiseUserId: `u-${key}`, displayName: `${key} (${key})`, isOnlineVariant: false, email: `${key.toLowerCase()}@example.com`,
    status: "active", relation: "TEACHER", joinedOn: "2026-01-20T00:00:00.000Z", courseCount: 2, activated: true,
    availabilityKnown: true, workingHourWindows: 3, ...overrides,
  };
}

function person(key: string, overrides: Partial<PersonSignals> = {}): PersonSignals {
  return {
    canonicalKey: key, displayName: key, accounts: [account(key)], lastTaughtAt: "2026-06-03T03:00:00.000Z",
    lastTaughtBySource: { ledger: null, pastBlocks: "2026-06-03T03:00:00.000Z", postClass: null },
    upcomingSessions: 0, nextSessionAt: null, upcomingLeaveUntil: null, lastTeacherActionAt: null, lastAdminActionAt: null,
    fullTime: false, ...overrides,
  };
}

function signals(people: PersonSignals[]): OffboardingSignals {
  return { snapshotId: "snap", snapshotCreatedAt: "2026-10-01T04:30:00.000Z", generatedAt: "2026-10-01T04:45:00.000Z", people, taughtDates: {} };
}

function decision(overrides: Partial<DecisionRecord> = {}): DecisionRecord {
  return {
    id: "d1", canonicalKey: "Gus", note: "Back in January", snoozeUntil: "2026-12-30T05:00:00.000Z", likelihoodAtDecision: 96,
    bandAtDecision: "very_likely_gone", reasons: [], decidedByEmail: "admin@example.com", decidedAt: "2026-09-30T05:00:00.000Z",
    revokedAt: null, revokedByEmail: null, ...overrides,
  };
}

describe("buildOffboardingDashboard", () => {
  it("sorts the inbox by likelihood and routes staff, exclusions and active people out of it", () => {
    const data = buildOffboardingDashboard({
      signals: signals([
        person("Aria"),                                                   // 96: very likely gone
        person("Bodhi", { lastTaughtAt: "2026-09-01T03:00:00.000Z" }),    // 70: likely gone
        person("Cleo", { lastTeacherActionAt: "2026-09-21T03:00:00.000Z" }), // 76: likely gone
        person("Dara", { upcomingSessions: 3 }),                          // teaching
        person("Emil", { accounts: [account("Emil", { relation: "ADMIN" })] }), // staff
        person("Fern", { lastTaughtAt: "2026-09-28T03:00:00.000Z" }),    // active
        person("Gus"),                                                    // snoozed
      ]),
      feeds: FRESH, decisions: [decision()], grants: null, viewer: VIEWER, now: NOW,
    });
    expect(data.inbox.map((row) => [row.signals.canonicalKey, row.score.likelihood])).toEqual([["Aria", 96], ["Cleo", 76], ["Bodhi", 70]]);
    expect(data.staff.map((row) => row.signals.canonicalKey)).toEqual(["Emil"]);
    expect(data.excluded.map((row) => [row.signals.canonicalKey, row.score.exclusion?.code])).toEqual([["Dara", "teaching"], ["Gus", "still_with_us"]]);
    expect(data.excluded[1].openDecision?.id).toBe("d1");
    expect(data.activeCount).toBe(1);
    expect(data.summary).toEqual({ veryLikely: 1, likely: 2, unclear: 0, veryLikelyAccounts: 1 });
    expect(data.decisions[0]).toMatchObject({ id: "d1", displayName: "Gus" });
    expect(data).toMatchObject({ servedAt: NOW.toISOString(), generatedAt: "2026-10-01T04:45:00.000Z", snapshotCreatedAt: "2026-10-01T04:30:00.000Z" });
    expect(data.curve.tutorsObserved).toBe(0);
  });

  it("marks every score provisional and blocks removal when a feed is stale (OFF-07)", () => {
    const data = buildOffboardingDashboard({
      signals: signals([person("Aria")]), feeds: { ...FRESH, tutorSnapshot: "2026-10-01T02:00:00.000Z" },
      decisions: [], grants: null, viewer: VIEWER, now: NOW,
    });
    expect(data.freshness.ok).toBe(false);
    expect(data.inbox[0].score).toMatchObject({ removable: false, removableBlockedBy: "Data is out of date" });
  });
});

describe("evaluateFreshness", () => {
  it("allows 2 hours for the snapshot and 3 days for the other feeds; a feed that never ran is stale", () => {
    const report = evaluateFreshness({ ...FRESH, progressTests: "2026-09-28T06:00:00.000Z", leaveRequests: null }, NOW);
    expect(report.ok).toBe(false);
    expect(report.feeds.map((feed) => [feed.key, feed.fresh])).toEqual([
      ["tutorSnapshot", true], ["progressTests", true], ["postClass", true], ["wiseActivity", true], ["leaveRequests", false],
    ]);
    expect(evaluateFreshness(FRESH, NOW).ok).toBe(true);
  });
});

describe("openDecisionsByKey", () => {
  it("keeps the latest open decision per person and ignores undone or expired ones", () => {
    const open = openDecisionsByKey([
      decision({ id: "old", decidedAt: "2026-09-01T00:00:00.000Z" }),
      decision({ id: "new", decidedAt: "2026-09-30T00:00:00.000Z" }),
      decision({ id: "undone", canonicalKey: "Hana", revokedAt: "2026-09-30T06:00:00.000Z" }),
      decision({ id: "expired", canonicalKey: "Ivo", snoozeUntil: "2026-09-30T00:00:00.000Z" }),
    ], NOW);
    expect([...open.entries()].map(([key, value]) => [key, value.id])).toEqual([["Gus", "new"]]);
  });
});
```

- [ ] **Step 2: Run it to verify it fails**

Run: `npx vitest run --project unit src/lib/tutor-offboarding/__tests__/data.test.ts`
Expected: FAIL — `Failed to resolve import "../data"`.

- [ ] **Step 3: Implement the builder**

Create `src/lib/tutor-offboarding/data.ts`:

```ts
import { bangkokDateKey } from "@/lib/room-capacity/dates";
import { buildCalibrationCurve } from "./calibration";
import { scorePerson } from "./score";
import type {
  DecisionRecord,
  FeedKey,
  FeedTimestamps,
  FreshnessReport,
  GrantRecord,
  OffboardingDashboardData,
  OffboardingPersonRow,
  OffboardingSignals,
  TutorOffboardingViewer,
} from "./types";

/** OFF-07: how old each feed may be before scores turn provisional. */
export const FEEDS: ReadonlyArray<{ key: FeedKey; label: string; maxAgeHours: number }> = [
  { key: "tutorSnapshot", label: "Wise roster and upcoming classes", maxAgeHours: 2 },
  { key: "progressTests", label: "Class attendance", maxAgeHours: 72 },
  { key: "postClass", label: "Class feedback sessions", maxAgeHours: 72 },
  { key: "wiseActivity", label: "Wise activity", maxAgeHours: 72 },
  { key: "leaveRequests", label: "Leave requests", maxAgeHours: 72 },
];

export function evaluateFreshness(timestamps: FeedTimestamps, now: Date): FreshnessReport {
  const feeds = FEEDS.map(({ key, label, maxAgeHours }) => {
    const lastSuccessAt = timestamps[key];
    const fresh = lastSuccessAt !== null && now.getTime() - Date.parse(lastSuccessAt) <= maxAgeHours * 3_600_000;
    return { key, label, lastSuccessAt, maxAgeHours, fresh };
  });
  return { ok: feeds.every((feed) => feed.fresh), feeds };
}

/** The latest open (not undone, not expired) decision per canonical key. */
export function openDecisionsByKey(decisions: DecisionRecord[], now: Date): Map<string, DecisionRecord> {
  const open = new Map<string, DecisionRecord>();
  for (const decision of decisions) {
    if (decision.revokedAt !== null || Date.parse(decision.snoozeUntil) <= now.getTime()) continue;
    const current = open.get(decision.canonicalKey);
    if (!current || decision.decidedAt > current.decidedAt) open.set(decision.canonicalKey, decision);
  }
  return open;
}

const byName = (a: OffboardingPersonRow, b: OffboardingPersonRow) => a.signals.displayName.localeCompare(b.signals.displayName);

/** Pure: scores everyone and splits them into the page's lists. */
export function buildOffboardingDashboard(input: {
  signals: OffboardingSignals;
  feeds: FeedTimestamps;
  decisions: DecisionRecord[];
  grants: GrantRecord[] | null;
  viewer: TutorOffboardingViewer;
  now: Date;
}): OffboardingDashboardData {
  const freshness = evaluateFreshness(input.feeds, input.now);
  const curve = buildCalibrationCurve(new Map(Object.entries(input.signals.taughtDates)), bangkokDateKey(input.now));
  const open = openDecisionsByKey(input.decisions, input.now);
  const snoozedKeys = new Set(open.keys());
  const rows: OffboardingPersonRow[] = input.signals.people.map((signals) => ({
    signals,
    score: scorePerson(signals, { now: input.now, curve, snoozedKeys, freshnessOk: freshness.ok }),
    openDecision: open.get(signals.canonicalKey) ?? null,
  }));
  const inbox = rows.filter((row) => !row.score.exclusion && row.score.band !== "active")
    .sort((a, b) => b.score.likelihood - a.score.likelihood || byName(a, b));
  const veryLikely = inbox.filter((row) => row.score.band === "very_likely_gone");
  const names = new Map(input.signals.people.map((person) => [person.canonicalKey, person.displayName]));
  return {
    servedAt: input.now.toISOString(),
    generatedAt: input.signals.generatedAt,
    snapshotCreatedAt: input.signals.snapshotCreatedAt,
    freshness,
    curve,
    inbox,
    activeCount: rows.filter((row) => !row.score.exclusion && row.score.band === "active").length,
    excluded: rows.filter((row) => row.score.exclusion && row.score.exclusion.code !== "wise_admin").sort(byName),
    staff: rows.filter((row) => row.score.exclusion?.code === "wise_admin").sort(byName),
    decisions: input.decisions.map((decision) => ({ ...decision, displayName: names.get(decision.canonicalKey) ?? decision.canonicalKey })),
    grants: input.grants,
    viewer: input.viewer,
    summary: {
      veryLikely: veryLikely.length,
      likely: inbox.filter((row) => row.score.band === "likely_gone").length,
      unclear: inbox.filter((row) => row.score.band === "unclear").length,
      veryLikelyAccounts: veryLikely.reduce((total, row) => total + row.signals.accounts.length, 0),
    },
  };
}
```

- [ ] **Step 4: Run it to verify it passes**

Run: `npx vitest run --project unit src/lib/tutor-offboarding/__tests__/data.test.ts`
Expected: PASS (4 tests).

- [ ] **Step 5: Write the cached service**

Create `src/lib/tutor-offboarding/service.ts`:

```ts
import "server-only";

import { cacheLife, cacheTag } from "next/cache";
import { getDb } from "@/lib/db";
import { buildOffboardingDashboard } from "./data";
import { listDecisions } from "./decisions";
import { isMissingSchemaError } from "./errors";
import { listGrants } from "./grants";
import { loadFeedTimestamps, loadOffboardingSignals } from "./signals";
import type { OffboardingDashboard, OffboardingPersonRow, OffboardingSignals, TutorOffboardingViewer } from "./types";

/** Cached per snapshot: the sync's revalidateTag("snapshot") clears it. Freshness, decisions and grants are read uncached. */
export async function getCachedOffboardingSignals(): Promise<OffboardingSignals | null> {
  "use cache";
  cacheTag("snapshot");
  cacheLife("hours");
  return loadOffboardingSignals(getDb(), new Date());
}

export async function loadTutorOffboardingDashboard(viewer: TutorOffboardingViewer): Promise<OffboardingDashboard> {
  const db = getDb();
  try {
    const [signals, feeds, decisions, grants] = await Promise.all([
      getCachedOffboardingSignals(),
      loadFeedTimestamps(db),
      listDecisions(db),
      viewer.isOwner ? listGrants(db) : Promise.resolve(null),
    ]);
    if (!signals) return { available: false, reason: "no_snapshot", viewer };
    return { available: true, ...buildOffboardingDashboard({ signals, feeds, decisions, grants, viewer, now: new Date() }) };
  } catch (error) {
    if (isMissingSchemaError(error)) return { available: false, reason: "not_set_up", viewer };
    throw error;
  }
}

/** The row the page shows for a person (review list, excluded or staff); null when they are on none of them. */
export async function findPersonRow(viewer: TutorOffboardingViewer, canonicalKey: string): Promise<OffboardingPersonRow | null> {
  const dashboard = await loadTutorOffboardingDashboard({ ...viewer, isOwner: false });
  if (!dashboard.available) return null;
  return [...dashboard.inbox, ...dashboard.excluded, ...dashboard.staff].find((row) => row.signals.canonicalKey === canonicalKey) ?? null;
}
```

- [ ] **Step 6: Typecheck**

Run: `npm run typecheck`
Expected: no errors.

- [ ] **Step 7: Commit**

```bash
git add src/lib/tutor-offboarding/data.ts src/lib/tutor-offboarding/service.ts src/lib/tutor-offboarding/__tests__/data.test.ts
git commit -m "$(cat <<'EOF'
Tutor Offboarding: dashboard builder, freshness gate, cached signals service

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>
EOF
)"
```

---

### Task 7: API routes

**Files:**
- Create: `src/app/api/tutor-offboarding/route.ts`
- Create: `src/app/api/tutor-offboarding/decisions/route.ts`
- Create: `src/app/api/tutor-offboarding/decisions/[decisionId]/route.ts`
- Create: `src/app/api/tutor-offboarding/grants/route.ts`
- Test: `src/app/api/tutor-offboarding/__tests__/routes.test.ts`

**Interfaces:**
- Consumes: `requireTutorOffboardingAdmin` (Task 5), `requireSuperAdmin` (`@/lib/admin-users/access`), `loadTutorOffboardingDashboard`, `findPersonRow` (Task 6), `recordStillWithUs`, `revokeDecision`, `listGrants`, `changeGrant` (Task 5), `tutorOffboardingErrorResponse`, `TutorOffboardingError`.
- Produces: `GET /api/tutor-offboarding`; `POST /api/tutor-offboarding/decisions` `{ canonicalKey, note?, snoozeDays: 90 | 365 }`; `DELETE /api/tutor-offboarding/decisions/{decisionId}`; `GET|POST /api/tutor-offboarding/grants` `{ action: "grant" | "revoke", email }`.

- [ ] **Step 1: Write the failing route tests**

Create `src/app/api/tutor-offboarding/__tests__/routes.test.ts`:

```ts
import { beforeEach, describe, expect, it, vi } from "vitest";
import { NextRequest } from "next/server";

vi.mock("server-only", () => ({}));
vi.mock("@/lib/auth", () => ({ auth: vi.fn() }));
vi.mock("@/lib/db", () => ({ getDb: vi.fn(() => ({})) }));
vi.mock("@/lib/admin-users/access", () => ({ requireSuperAdmin: vi.fn() }));
vi.mock("@/lib/tutor-offboarding/service", () => ({ loadTutorOffboardingDashboard: vi.fn(), findPersonRow: vi.fn() }));
vi.mock("@/lib/tutor-offboarding/decisions", () => ({ recordStillWithUs: vi.fn(), revokeDecision: vi.fn() }));
vi.mock("@/lib/tutor-offboarding/grants", async (importOriginal) => ({
  ...await importOriginal<typeof import("@/lib/tutor-offboarding/grants")>(),
  hasRemovalGrant: vi.fn(async () => false),
  listGrants: vi.fn(async () => []),
  changeGrant: vi.fn(async () => []),
}));

import { auth } from "@/lib/auth";
import { requireSuperAdmin } from "@/lib/admin-users/access";
import { AdminUsersAccessError } from "@/lib/admin-users/types";
import { recordStillWithUs, revokeDecision } from "@/lib/tutor-offboarding/decisions";
import { TutorOffboardingError } from "@/lib/tutor-offboarding/errors";
import { changeGrant } from "@/lib/tutor-offboarding/grants";
import { findPersonRow, loadTutorOffboardingDashboard } from "@/lib/tutor-offboarding/service";
import type { OffboardingPersonRow } from "@/lib/tutor-offboarding/types";
import { GET } from "../route";
import { POST as postDecision } from "../decisions/route";
import { DELETE as deleteDecision } from "../decisions/[decisionId]/route";
import { GET as getGrants, POST as postGrant } from "../grants/route";

const authMock = vi.mocked(auth as unknown as () => Promise<unknown>);
const dashboardMock = vi.mocked(loadTutorOffboardingDashboard);
const findMock = vi.mocked(findPersonRow);
const recordMock = vi.mocked(recordStillWithUs);
const revokeMock = vi.mocked(revokeDecision);
const ownerMock = vi.mocked(requireSuperAdmin);
const grantMock = vi.mocked(changeGrant);

const DECISION_ID = "11111111-1111-4111-8111-111111111111";
const ROW = {
  signals: { canonicalKey: "Aria" },
  score: { likelihood: 96, band: "very_likely_gone", reasons: [{ code: "idle_gap", direction: "toward_gone", text: "Last class 120 days ago (3 Jun)" }] },
} as unknown as OffboardingPersonRow;

function json(body: unknown, url = "http://localhost/api/tutor-offboarding/decisions", method = "POST") {
  return new NextRequest(url, { method, body: typeof body === "string" ? body : JSON.stringify(body), headers: { "Content-Type": "application/json" } });
}

function signedIn(role = "admin") {
  authMock.mockResolvedValue({ user: { email: "Admin@Example.com", role } });
}

beforeEach(() => {
  vi.clearAllMocks();
  signedIn();
  ownerMock.mockResolvedValue({ email: "owner@example.com", accessVersion: 1 });
});

describe("GET /api/tutor-offboarding", () => {
  it("requires an admin session", async () => {
    authMock.mockResolvedValue(null);
    expect((await GET()).status).toBe(401);
    signedIn("teacher");
    expect((await GET()).status).toBe(403);
    expect(dashboardMock).not.toHaveBeenCalled();
  });

  it("returns the dashboard for the signed-in admin", async () => {
    dashboardMock.mockResolvedValue({ available: false, reason: "not_set_up", viewer: { email: "admin@example.com", isOwner: false, canRemove: false } });
    const response = await GET();
    expect(response.status).toBe(200);
    expect(dashboardMock).toHaveBeenCalledWith({ email: "admin@example.com", isOwner: false, canRemove: false });
    expect(await response.json()).toMatchObject({ available: false, reason: "not_set_up" });
  });

  it("hides an unexpected failure behind a generic message", async () => {
    vi.spyOn(console, "error").mockImplementation(() => undefined);
    dashboardMock.mockRejectedValue(new Error("connection reset"));
    const response = await GET();
    expect([response.status, await response.json()]).toEqual([500, { error: "The tutor offboarding dashboard could not load." }]);
  });
});

describe("POST /api/tutor-offboarding/decisions", () => {
  it("rejects bad bodies, including a client-sent score", async () => {
    for (const body of ["not json", { canonicalKey: "Aria", snoozeDays: 30 }, { canonicalKey: "", snoozeDays: 90 }, { canonicalKey: "Aria", snoozeDays: 90, likelihood: 1 }]) {
      expect((await postDecision(json(body))).status).toBe(400);
    }
    expect(recordMock).not.toHaveBeenCalled();
  });

  it("refuses a person who is not on the page", async () => {
    findMock.mockResolvedValue(null);
    expect((await postDecision(json({ canonicalKey: "Nobody", snoozeDays: 90 }))).status).toBe(404);
  });

  it("records the decision with the score the server computed", async () => {
    findMock.mockResolvedValue(ROW);
    recordMock.mockResolvedValue({ id: DECISION_ID } as never);
    const response = await postDecision(json({ canonicalKey: "Aria", note: "  On a term break ", snoozeDays: 365 }));
    expect(response.status).toBe(200);
    expect(recordMock).toHaveBeenCalledWith({}, {
      canonicalKey: "Aria", note: "On a term break", snoozeDays: 365, actorEmail: "admin@example.com",
      score: { likelihood: 96, band: "very_likely_gone", reasons: ["Last class 120 days ago (3 Jun)"] },
    });
  });

  it("passes a conflict through as 409", async () => {
    findMock.mockResolvedValue(ROW);
    recordMock.mockRejectedValue(new TutorOffboardingError("This tutor is already marked still with us.", 409));
    const response = await postDecision(json({ canonicalKey: "Aria", snoozeDays: 90 }));
    expect([response.status, await response.json()]).toEqual([409, { error: "This tutor is already marked still with us." }]);
  });
});

describe("DELETE /api/tutor-offboarding/decisions/[decisionId]", () => {
  it("undoes a decision by id and rejects anything that is not one", async () => {
    revokeMock.mockResolvedValue({ id: DECISION_ID } as never);
    const ok = await deleteDecision(json({}, `http://localhost/api/tutor-offboarding/decisions/${DECISION_ID}`, "DELETE"), { params: Promise.resolve({ decisionId: DECISION_ID }) });
    expect(ok.status).toBe(200);
    expect(revokeMock).toHaveBeenCalledWith({}, { decisionId: DECISION_ID, actorEmail: "admin@example.com" });
    const bad = await deleteDecision(json({}, "http://localhost/api/tutor-offboarding/decisions/x", "DELETE"), { params: Promise.resolve({ decisionId: "x" }) });
    expect(bad.status).toBe(404);
  });
});

describe("/api/tutor-offboarding/grants", () => {
  it("is owner-only", async () => {
    ownerMock.mockRejectedValue(new AdminUsersAccessError("Only the website owner can manage access", 403));
    const response = await getGrants();
    expect([response.status, await response.json()]).toEqual([403, { error: "Only the website owner can change who can remove tutors." }]);
    expect((await postGrant(json({ action: "grant", email: "ops@example.com" }, "http://localhost/api/tutor-offboarding/grants"))).status).toBe(403);
    expect(grantMock).not.toHaveBeenCalled();
  });

  it("validates the change and passes it to the store", async () => {
    expect((await postGrant(json({ action: "promote", email: "ops@example.com" }, "http://localhost/api/tutor-offboarding/grants"))).status).toBe(400);
    expect((await postGrant(json({ action: "grant", email: "not-an-email" }, "http://localhost/api/tutor-offboarding/grants"))).status).toBe(400);
    const response = await postGrant(json({ action: "grant", email: "ops@example.com" }, "http://localhost/api/tutor-offboarding/grants"));
    expect(response.status).toBe(200);
    expect(grantMock).toHaveBeenCalledWith({}, { action: "grant", email: "ops@example.com", actorEmail: "owner@example.com" });
  });
});
```

- [ ] **Step 2: Run it to verify it fails**

Run: `npx vitest run --project unit src/app/api/tutor-offboarding/__tests__/routes.test.ts`
Expected: FAIL — `Failed to resolve import "../route"`.

- [ ] **Step 3: Write the four routes**

Create `src/app/api/tutor-offboarding/route.ts`:

```ts
import { NextResponse } from "next/server";
import { requireTutorOffboardingAdmin } from "@/lib/tutor-offboarding/access";
import { tutorOffboardingErrorResponse } from "@/lib/tutor-offboarding/api";
import { loadTutorOffboardingDashboard } from "@/lib/tutor-offboarding/service";

/** Read-only dashboard payload: scores, exclusions, staff accounts, decisions and (owner only) removal grants. */
export async function GET() {
  try {
    const viewer = await requireTutorOffboardingAdmin();
    return NextResponse.json(await loadTutorOffboardingDashboard(viewer));
  } catch (error) {
    return tutorOffboardingErrorResponse("[tutor-offboarding] dashboard failed", error, "The tutor offboarding dashboard could not load.");
  }
}
```

Create `src/app/api/tutor-offboarding/decisions/route.ts`:

```ts
import { type NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { getDb } from "@/lib/db";
import { requireTutorOffboardingAdmin } from "@/lib/tutor-offboarding/access";
import { tutorOffboardingErrorResponse } from "@/lib/tutor-offboarding/api";
import { recordStillWithUs } from "@/lib/tutor-offboarding/decisions";
import { TutorOffboardingError } from "@/lib/tutor-offboarding/errors";
import { findPersonRow } from "@/lib/tutor-offboarding/service";

const DecisionBody = z.object({
  canonicalKey: z.string().trim().min(1).max(200),
  note: z.string().trim().max(1_000).nullish(),
  snoozeDays: z.union([z.literal(90), z.literal(365)]),
}).strict();

/** "Still with us": hides a person from the review list for 90 days or a year. The score is computed here, never sent by the client. */
export async function POST(request: NextRequest) {
  try {
    const viewer = await requireTutorOffboardingAdmin();
    let json: unknown;
    try {
      json = await request.json();
    } catch {
      throw new TutorOffboardingError("Invalid JSON body.", 400);
    }
    const parsed = DecisionBody.safeParse(json);
    if (!parsed.success) return NextResponse.json({ error: parsed.error.flatten() }, { status: 400 });
    const row = await findPersonRow(viewer, parsed.data.canonicalKey);
    if (!row) throw new TutorOffboardingError("This tutor is not on the review page.", 404);
    const decision = await recordStillWithUs(getDb(), {
      canonicalKey: row.signals.canonicalKey,
      note: parsed.data.note ? parsed.data.note : null,
      snoozeDays: parsed.data.snoozeDays,
      actorEmail: viewer.email,
      score: { likelihood: row.score.likelihood, band: row.score.band, reasons: row.score.reasons.map((reason) => reason.text) },
    });
    return NextResponse.json({ ok: true, decision });
  } catch (error) {
    return tutorOffboardingErrorResponse("[tutor-offboarding] decision failed", error, "The decision could not be saved.");
  }
}
```

Create `src/app/api/tutor-offboarding/decisions/[decisionId]/route.ts`:

```ts
import { type NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { getDb } from "@/lib/db";
import { requireTutorOffboardingAdmin } from "@/lib/tutor-offboarding/access";
import { tutorOffboardingErrorResponse } from "@/lib/tutor-offboarding/api";
import { revokeDecision } from "@/lib/tutor-offboarding/decisions";
import { TutorOffboardingError } from "@/lib/tutor-offboarding/errors";

type DecisionRouteContext = { params: Promise<{ decisionId: string }> };

/** Undo a "Still with us" decision; the person returns to the review list if still idle. */
export async function DELETE(_request: NextRequest, context: DecisionRouteContext) {
  try {
    const viewer = await requireTutorOffboardingAdmin();
    const { decisionId } = await context.params;
    if (!z.uuid().safeParse(decisionId).success) throw new TutorOffboardingError("That decision was not found.", 404);
    const decision = await revokeDecision(getDb(), { decisionId, actorEmail: viewer.email });
    return NextResponse.json({ ok: true, decision });
  } catch (error) {
    return tutorOffboardingErrorResponse("[tutor-offboarding] undo failed", error, "The decision could not be undone.");
  }
}
```

Create `src/app/api/tutor-offboarding/grants/route.ts`:

```ts
import { type NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { requireSuperAdmin } from "@/lib/admin-users/access";
import { getDb } from "@/lib/db";
import { tutorOffboardingErrorResponse } from "@/lib/tutor-offboarding/api";
import { TutorOffboardingError } from "@/lib/tutor-offboarding/errors";
import { changeGrant, listGrants } from "@/lib/tutor-offboarding/grants";

const GrantBody = z.object({
  action: z.enum(["grant", "revoke"]),
  email: z.email().max(320),
}).strict();

/** OFF-11: who may remove tutors from Wise. Owner only. */
export async function GET() {
  try {
    await requireSuperAdmin();
    return NextResponse.json({ grants: await listGrants() });
  } catch (error) {
    return tutorOffboardingErrorResponse("[tutor-offboarding] grants read failed", error, "The removal access list could not load.");
  }
}

export async function POST(request: NextRequest) {
  try {
    const owner = await requireSuperAdmin();
    let json: unknown;
    try {
      json = await request.json();
    } catch {
      throw new TutorOffboardingError("Invalid JSON body.", 400);
    }
    const parsed = GrantBody.safeParse(json);
    if (!parsed.success) return NextResponse.json({ error: parsed.error.flatten() }, { status: 400 });
    const grants = await changeGrant(getDb(), { action: parsed.data.action, email: parsed.data.email, actorEmail: owner.email });
    return NextResponse.json({ ok: true, grants });
  } catch (error) {
    return tutorOffboardingErrorResponse("[tutor-offboarding] grant change failed", error, "The removal access could not be changed.");
  }
}
```

- [ ] **Step 4: Run it to verify it passes**

Run: `npx vitest run --project unit src/app/api/tutor-offboarding/__tests__/routes.test.ts`
Expected: PASS (10 tests).

- [ ] **Step 5: Lint and typecheck**

Run: `npx eslint src/app/api/tutor-offboarding src/lib/tutor-offboarding && npm run typecheck`
Expected: no errors.

- [ ] **Step 6: Commit**

```bash
git add src/app/api/tutor-offboarding
git commit -m "$(cat <<'EOF'
Tutor Offboarding: dashboard, decision and owner grant API routes

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>
EOF
)"
```

---

### Task 8: UI building blocks

**Files:**
- Create: `src/components/tutor-offboarding/atoms.tsx`, `format.ts`, `person-row.tsx`, `inbox.tsx`, `person-detail.tsx`, `still-with-us-dialog.tsx`, `rail.tsx`, `grants-panel.tsx`, `history-table.tsx`
- Create: `src/components/tutor-offboarding/__tests__/fixtures.ts`
- Test: `src/components/tutor-offboarding/__tests__/format.test.ts`, `person-detail.test.tsx`, `rail.test.tsx`

**Interfaces:**
- Consumes: types and `bangkokDayLabel` (Task 3), `buildOffboardingDashboard` (Task 6, fixtures only), `HISTORY_START` (Task 2), ui primitives (`Button`, `Dialog*`, `Textarea`, `Input`).
- Produces:
  - format: `formatDay(iso)`, `formatDayYear(iso)`, `formatAge(fromIso, now)`, `BAND_LABEL`, `INBOX_BANDS`, `topLineSentence(summary)`, `curveSentence(curve)` (the row subtitle is the score's first reason, e.g. "Last class 120 days ago (3 Jun)")
  - components: `Panel`, `Upper`, `CountChip`, `Tag`, `Disclosure`; `LikelihoodBar`, `accountLabel`, `PersonRow`; `Inbox`; `PersonDetail`, `PersonDrawer`, `removalCheck`; `StillWithUsDialog`; `FreshnessBanner`, `HowScoreWorks`, `StaffAccounts`, `ExcludedList`; `GrantsPanel`; `HistoryTable`
  - fixtures: `FIXTURE_NOW`, `OWNER`, `ADMIN`, `dashboardFixture(viewer?)`, `staleDashboardFixture()`, `emptyDashboardFixture()`, `notSetUpFixture()`

- [ ] **Step 1: Write the fixtures (made-up people only)**

Create `src/components/tutor-offboarding/__tests__/fixtures.ts`:

```ts
import { buildOffboardingDashboard } from "@/lib/tutor-offboarding/data";
import type {
  DecisionRecord,
  FeedTimestamps,
  OffboardingAccount,
  OffboardingDashboard,
  OffboardingDashboardData,
  PersonSignals,
  TutorOffboardingViewer,
} from "@/lib/tutor-offboarding/types";

// Made-up people and @example.com addresses only: never real tutors.

export const FIXTURE_NOW = new Date("2026-10-01T05:00:00.000Z");
export const OWNER: TutorOffboardingViewer = { email: "owner@example.com", isOwner: true, canRemove: true };
export const ADMIN: TutorOffboardingViewer = { email: "admin@example.com", isOwner: false, canRemove: false };

const FRESH: FeedTimestamps = {
  tutorSnapshot: "2026-10-01T04:48:00.000Z",
  progressTests: "2026-10-01T02:57:00.000Z",
  postClass: "2026-10-01T03:13:00.000Z",
  wiseActivity: "2026-10-01T03:02:00.000Z",
  leaveRequests: "2026-10-01T03:15:00.000Z",
};

function daysBefore(days: number): string {
  return new Date(FIXTURE_NOW.getTime() - days * 86_400_000).toISOString();
}

function dayKey(days: number): string {
  return daysBefore(days).slice(0, 10);
}

function account(name: string, overrides: Partial<OffboardingAccount> = {}): OffboardingAccount {
  return {
    wiseTeacherId: `t-${name.toLowerCase()}`, wiseUserId: `u-${name.toLowerCase()}`, displayName: `${name} (${name})`, isOnlineVariant: false,
    email: `${name.toLowerCase()}@example.com`, status: "active", relation: "TEACHER", joinedOn: "2026-01-20T00:00:00.000Z",
    courseCount: 2, activated: true, availabilityKnown: true, workingHourWindows: 3, ...overrides,
  };
}

function person(name: string, overrides: Partial<PersonSignals> = {}): PersonSignals {
  const lastTaughtAt = overrides.lastTaughtAt === undefined ? daysBefore(120) : overrides.lastTaughtAt;
  return {
    canonicalKey: name, displayName: name, accounts: [account(name)], lastTaughtAt,
    lastTaughtBySource: { ledger: lastTaughtAt, pastBlocks: lastTaughtAt, postClass: null },
    upcomingSessions: 0, nextSessionAt: null, upcomingLeaveUntil: null, lastTeacherActionAt: null, lastAdminActionAt: null,
    fullTime: false, ...overrides,
  };
}

const PEOPLE: PersonSignals[] = [
  person("Aria", { lastTaughtAt: null, accounts: [account("Aria", { workingHourWindows: 0, courseCount: 0, activated: false })] }),
  person("Bodhi", { accounts: [account("Bodhi", { workingHourWindows: 0 }), account("Bodhi", { wiseTeacherId: "t-bodhi-on", isOnlineVariant: true, displayName: "Bodhi (Bodhi) Online", email: "bodhi.online@example.com", workingHourWindows: 0 })] }),
  person("Cleo", { lastTaughtAt: daysBefore(160) }),
  person("Dara", { lastTaughtAt: daysBefore(35) }),
  person("Lena", { lastTaughtAt: daysBefore(50) }),
  person("Emil", { lastTaughtAt: daysBefore(70), lastTeacherActionAt: daysBefore(6) }),
  person("Fern", { upcomingSessions: 6, nextSessionAt: "2026-10-02T03:00:00.000Z", lastTaughtAt: daysBefore(1) }),
  person("Gus", { accounts: [account("Gus", { relation: "ADMIN" })], lastAdminActionAt: daysBefore(1), lastTaughtAt: daysBefore(40) }),
  person("Hana", { accounts: [account("Hana", { relation: "ADMIN" })], lastTaughtAt: null }),
  person("Ivo", { lastTaughtAt: daysBefore(150) }),
  person("Juno", { lastTaughtAt: null, accounts: [account("Juno", { joinedOn: daysBefore(20) })] }),
  person("Kai", { lastTaughtAt: daysBefore(3) }),
];

/** Weekly class dates from `fromDays` down to (at least) `toDays` days before FIXTURE_NOW. */
function weekly(fromDays: number, toDays: number): string[] {
  const days: string[] = [];
  for (let day = fromDays; day >= toDays; day -= 7) days.push(dayKey(day));
  return days;
}

// A history shaped like the real one (1 Oct 2026): 40 tutors teach weekly, 6 came back after a 30-62 day break,
// 14 stopped for good 95+ days ago. Curve: 60+ days idle → 91% never came back, based on 60 tutors.
const TAUGHT: Record<string, string[]> = Object.fromEntries([
  ...Array.from({ length: 40 }, (_, index) => [`weekly-${index}`, weekly(200, index % 7)]),
  ...[30, 35, 40, 45, 50, 62].map((gap, index) => [`returned-${index}`, [...weekly(200, 130), ...weekly(130 - gap, 3)]]),
  ...Array.from({ length: 14 }, (_, index) => [`left-${index}`, weekly(200, 95 + index * 5)]),
]);

const DECISIONS: DecisionRecord[] = [
  { id: "d-ivo", canonicalKey: "Ivo", note: "Back after his exams in January", snoozeUntil: "2026-12-29T05:00:00.000Z", likelihoodAtDecision: 96,
    bandAtDecision: "very_likely_gone", reasons: ["Last class 150 days ago (4 May)"], decidedByEmail: "admin@example.com",
    decidedAt: "2026-09-30T05:00:00.000Z", revokedAt: null, revokedByEmail: null },
  { id: "d-kai", canonicalKey: "Kai", note: null, snoozeUntil: "2026-12-01T05:00:00.000Z", likelihoodAtDecision: 72,
    bandAtDecision: "likely_gone", reasons: ["Last class 33 days ago (27 Jul)"], decidedByEmail: "admin@example.com",
    decidedAt: "2026-09-02T05:00:00.000Z", revokedAt: "2026-09-10T05:00:00.000Z", revokedByEmail: "owner@example.com" },
];

function build(viewer: TutorOffboardingViewer, feeds: FeedTimestamps, people: PersonSignals[]): OffboardingDashboardData {
  return buildOffboardingDashboard({
    signals: { snapshotId: "snap", snapshotCreatedAt: "2026-10-01T04:48:00.000Z", generatedAt: "2026-10-01T04:50:00.000Z", people, taughtDates: TAUGHT },
    feeds,
    decisions: DECISIONS,
    grants: viewer.isOwner ? [{ email: "ops@example.com", grantedByEmail: "owner@example.com", grantedAt: "2026-09-30T02:00:00.000Z" }] : null,
    viewer,
    now: FIXTURE_NOW,
  });
}

export function dashboardFixture(viewer: TutorOffboardingViewer = OWNER): OffboardingDashboardData {
  return build(viewer, FRESH, PEOPLE);
}

export function staleDashboardFixture(): OffboardingDashboardData {
  return build(OWNER, { ...FRESH, tutorSnapshot: "2026-09-30T20:00:00.000Z", leaveRequests: null }, PEOPLE);
}

export function emptyDashboardFixture(): OffboardingDashboardData {
  return build(OWNER, FRESH, PEOPLE.filter((signals) => ["Fern", "Gus", "Kai"].includes(signals.canonicalKey)));
}

export function notSetUpFixture(): OffboardingDashboard {
  return { available: false, reason: "not_set_up", viewer: ADMIN };
}
```

- [ ] **Step 2: Write the failing tests**

Create `src/components/tutor-offboarding/__tests__/format.test.ts`:

```ts
import { describe, expect, it } from "vitest";
import { curveSentence, formatAge, formatDay, formatDayYear, topLineSentence } from "../format";
import { dashboardFixture } from "./fixtures";

describe("format", () => {
  it("formats Bangkok days", () => {
    expect(formatDay("2026-06-03T03:00:00.000Z")).toBe("3 Jun");
    expect(formatDay("2026-02-28T17:00:00.000Z")).toBe("1 Mar");
    expect(formatDayYear("2026-01-20T00:00:00.000Z")).toBe("20 Jan 2026");
  });

  it("says how old the data is", () => {
    const now = new Date("2026-10-01T05:00:00.000Z");
    expect(formatAge("2026-10-01T04:48:00.000Z", now)).toBe("12 min old");
    expect(formatAge("2026-10-01T01:00:00.000Z", now)).toBe("4 h old");
    expect(formatAge("2026-09-28T05:00:00.000Z", now)).toBe("3 days old");
  });

  it("writes the top line in plain words", () => {
    expect(topLineSentence({ veryLikely: 23, veryLikelyAccounts: 41, likely: 1, unclear: 1 }))
      .toBe("23 tutors (41 Wise accounts) are very likely no longer with us; 1 likely, 1 unclear.");
    expect(topLineSentence({ veryLikely: 1, veryLikelyAccounts: 2, likely: 0, unclear: 0 }))
      .toBe("1 tutor (2 Wise accounts) is very likely no longer with us.");
    expect(topLineSentence({ veryLikely: 0, veryLikelyAccounts: 0, likely: 2, unclear: 0 }))
      .toBe("No tutor is very likely gone; 2 likely.");
    expect(topLineSentence({ veryLikely: 0, veryLikelyAccounts: 0, likely: 0, unclear: 0 }))
      .toBe("No tutors look like they have left. Nothing to review.");
  });

  it("states the calibration in one sentence", () => {
    const { curve } = dashboardFixture();
    expect(curveSentence(curve)).toBe("Idle 60+ days → 91% never came back · based on 60 tutors since 1 Mar");
    expect(curveSentence({ ...curve, points: curve.points.map((point) => ({ ...point, usedDefault: true, goneProbability: 0.9 })) }))
      .toBe("Idle 60+ days → 90% never came back · default estimate until there is enough history");
  });
});
```

Create `src/components/tutor-offboarding/__tests__/person-detail.test.tsx`:

```tsx
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { PersonDetail, removalCheck } from "../person-detail";
import { dashboardFixture } from "./fixtures";

function row(key: string) {
  const data = dashboardFixture();
  const found = [...data.inbox, ...data.excluded, ...data.staff].find((candidate) => candidate.signals.canonicalKey === key);
  if (!found) throw new Error(`fixture has no ${key}`);
  return found;
}

describe("PersonDetail", () => {
  it("shows every reason, the sources, and each account's Wise details", () => {
    const html = renderToStaticMarkup(<PersonDetail row={row("Aria")} />);
    expect(html).toContain("No class on record since 1 Mar");
    expect(html).toContain("No working hours set in Wise");
    expect(html).toContain("Never activated their Wise login");
    expect(html).toContain("none since 1 Mar");
    expect(html).toContain("Joined 20 Jan 2026");
    expect(html).toContain("Never logged in");
    expect(html).toContain("0 courses");
    expect(html).toContain("aria@example.com");
  });

  it("states the removal check in words", () => {
    expect(removalCheck(row("Aria"))).toBe("Passes every removal check");
    expect(removalCheck(row("Dara"))).toBe("Not removable yet: Last class 35 days ago; removal opens at 45 days");
    expect(removalCheck(row("Fern"))).toBe("Not removable: Teaching: 6 upcoming classes");
  });
});
```

Create `src/components/tutor-offboarding/__tests__/rail.test.tsx`:

```tsx
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { ExcludedList, FreshnessBanner, HowScoreWorks, StaffAccounts } from "../rail";
import { curveSentence } from "../format";
import { dashboardFixture, staleDashboardFixture } from "./fixtures";

const noop = () => undefined;

describe("rail", () => {
  it("explains the score with the curve and its table", () => {
    const { curve } = dashboardFixture();
    const html = renderToStaticMarkup(<HowScoreWorks curve={curve} />);
    expect(html).toContain(curveSentence(curve));
    expect(html).toContain("90+ days");
    expect(html).toContain("Unknown data never counts.");
  });

  it("lists staff accounts read-only with their last admin action", () => {
    const html = renderToStaticMarkup(<StaffAccounts rows={dashboardFixture().staff} onOpen={noop} />);
    expect(html).toContain("Remove departed staff by hand in Wise.");
    expect(html).toContain("Gus");
    expect(html).toContain("Last admin action 30 Sep");
    expect(html).toContain("Hana");
    expect(html).toContain("No admin activity on record");
    expect(html).not.toContain("Still with us");
  });

  it("counts teaching people and lists the other exclusions with Undo for snoozes", () => {
    const html = renderToStaticMarkup(<ExcludedList rows={dashboardFixture().excluded} onOpen={noop} onUndo={noop} />);
    expect(html).toContain("1 teaching (have upcoming classes).");
    expect(html).toContain("Juno");
    expect(html).toContain("New account, not started yet");
    expect(html).toContain("Back after his exams in January");
    expect(html).toContain("Undo");
  });

  it("names each stale feed in the banner", () => {
    const html = renderToStaticMarkup(<FreshnessBanner report={staleDashboardFixture().freshness} />);
    expect(html).toContain("Scores are provisional: some data is out of date.");
    expect(html).toContain("Wise roster and upcoming classes (last updated 1 Oct 2026)");
    expect(html).toContain("Leave requests (never updated)");
  });
});
```

- [ ] **Step 3: Run them to verify they fail**

Run: `npx vitest run --project unit src/components/tutor-offboarding`
Expected: FAIL — `Failed to resolve import "../format"` (and the others).

- [ ] **Step 4: Write `atoms.tsx` and `format.ts`**

Create `src/components/tutor-offboarding/atoms.tsx`:

```tsx
import type { ComponentProps, ReactNode } from "react";
import { ChevronRight } from "lucide-react";
import { cn } from "@/lib/utils";

/** The page's small presentational pieces, drawn like the autowriter dashboard's (mockup A). */

export type Tone = "neutral" | "amber" | "green" | "red";

/** The `available` token is a fill colour: as small text on a light card it is darkened to stay readable. */
const GREEN_TEXT = "text-[color:color-mix(in_oklch,var(--available),black_32%)] dark:text-available";

const TAG_TONE: Record<Tone, string> = {
  neutral: "border-border bg-muted/40 text-muted-foreground",
  amber: "border-amber-200 bg-amber-50 text-amber-800 dark:border-amber-900 dark:bg-amber-950 dark:text-amber-200",
  green: `border-available/30 bg-available/10 ${GREEN_TEXT}`,
  red: "border-conflict/30 bg-conflict/10 text-conflict",
};

export function Panel({ className, ...props }: ComponentProps<"section">) {
  return <section className={cn("overflow-hidden rounded-[10px] border bg-card shadow-[0_2px_3px_rgb(37_52_65/0.02)]", className)} {...props} />;
}

export function Upper({ className, children }: { className?: string; children: ReactNode }) {
  return <span className={cn("text-[10px] font-semibold uppercase tracking-[0.09em] text-muted-foreground", className)}>{children}</span>;
}

export function CountChip({ className, children }: { className?: string; children: ReactNode }) {
  return <span className={cn("rounded bg-muted px-1.5 py-[3px] text-[10px] font-semibold leading-none text-muted-foreground", className)}>{children}</span>;
}

export function Tag({ tone = "neutral", className, children }: { tone?: Tone; className?: string; children: ReactNode }) {
  return (
    <span className={cn("inline-flex items-center gap-1 rounded border px-[5px] py-[3px] text-[10px] font-medium leading-none whitespace-nowrap", TAG_TONE[tone], className)}>
      {children}
    </span>
  );
}

export function Disclosure({ title, count, children }: { title: string; count?: number; children: ReactNode }) {
  return (
    <details className="group overflow-hidden rounded-[10px] border bg-card shadow-[0_2px_3px_rgb(37_52_65/0.02)]">
      <summary className="flex cursor-pointer list-none items-center gap-[9px] px-5 py-3.5 outline-none hover:bg-muted/30 focus-visible:bg-muted/40 [&::-webkit-details-marker]:hidden">
        <ChevronRight aria-hidden className="size-3.5 text-muted-foreground transition-transform group-open:rotate-90" />
        <span className="text-[13px] font-semibold">{title}</span>
        {count !== undefined ? <CountChip>{count}</CountChip> : null}
      </summary>
      <div className="border-t">{children}</div>
    </details>
  );
}
```

Create `src/components/tutor-offboarding/format.ts`:

```ts
import type { CalibrationCurve } from "@/lib/tutor-offboarding/calibration";
import { bangkokDayLabel } from "@/lib/tutor-offboarding/day-label";
import type { OffboardingBand, OffboardingSummary } from "@/lib/tutor-offboarding/types";

/** "3 Jun" on the Bangkok calendar (fixed month names: server and browser render the same text). */
export function formatDay(iso: string): string {
  return bangkokDayLabel(iso);
}

/** "3 Jun 2026" on the Bangkok calendar. */
export function formatDayYear(iso: string): string {
  return bangkokDayLabel(iso, true);
}

/** "12 min old", "4 h old", "3 days old". */
export function formatAge(fromIso: string, now: Date): string {
  const minutes = Math.max(0, Math.floor((now.getTime() - Date.parse(fromIso)) / 60_000));
  if (minutes < 60) return `${minutes} min old`;
  const hours = Math.floor(minutes / 60);
  if (hours < 48) return `${hours} h old`;
  return `${Math.floor(hours / 24)} days old`;
}

export const BAND_LABEL: Record<OffboardingBand, string> = {
  very_likely_gone: "Very likely gone",
  likely_gone: "Likely gone",
  unclear: "Unclear",
  active: "Active",
};

export const INBOX_BANDS: OffboardingBand[] = ["very_likely_gone", "likely_gone", "unclear"];

export function topLineSentence(summary: OffboardingSummary): string {
  const { veryLikely, veryLikelyAccounts, likely, unclear } = summary;
  if (veryLikely + likely + unclear === 0) return "No tutors look like they have left. Nothing to review.";
  const head = veryLikely > 0
    ? `${veryLikely} ${veryLikely === 1 ? "tutor" : "tutors"} (${veryLikelyAccounts} Wise ${veryLikelyAccounts === 1 ? "account" : "accounts"}) ${veryLikely === 1 ? "is" : "are"} very likely no longer with us`
    : "No tutor is very likely gone";
  const rest = [likely ? `${likely} likely` : null, unclear ? `${unclear} unclear` : null].filter(Boolean).join(", ");
  return rest ? `${head}; ${rest}.` : `${head}.`;
}

/** The calibration in one sentence, at the 60-day threshold. */
export function curveSentence(curve: CalibrationCurve): string {
  const point = curve.points.find((candidate) => candidate.thresholdDays === 60) ?? curve.points[curve.points.length - 1];
  const percent = Math.round(point.goneProbability * 100);
  const basis = point.usedDefault
    ? "default estimate until there is enough history"
    : `based on ${curve.tutorsObserved} tutors since ${formatDay(curve.historyStart)}`;
  return `Idle ${point.thresholdDays}+ days → ${percent}% never came back · ${basis}`;
}
```

- [ ] **Step 5: Write the row, inbox and detail components**

Create `src/components/tutor-offboarding/person-row.tsx`:

```tsx
"use client";

import { Button } from "@/components/ui/button";
import type { OffboardingAccount, OffboardingPersonRow } from "@/lib/tutor-offboarding/types";
import { cn } from "@/lib/utils";
import { Tag } from "./atoms";

export function LikelihoodBar({ value }: { value: number }) {
  const tone = value >= 90 ? "bg-conflict" : value >= 70 ? "bg-amber-500" : "bg-muted-foreground/50";
  return (
    <span className="flex items-center gap-2" role="meter" aria-valuemin={0} aria-valuemax={100} aria-valuenow={value} aria-label="Likelihood no longer with us">
      <span className="h-1.5 w-20 overflow-hidden rounded-full bg-muted">
        <span className={cn("block h-full rounded-full", tone)} style={{ width: `${value}%` }} />
      </span>
      <span className="text-xs font-semibold tabular-nums">{value}%</span>
    </span>
  );
}

export function accountLabel(account: OffboardingAccount): string {
  return `${account.isOnlineVariant ? "Online" : "Onsite"}${account.email ? ` · ${account.email}` : ""}`;
}

export function PersonRow({ row, onOpen, onKeep }: { row: OffboardingPersonRow; onOpen: () => void; onKeep: () => void }) {
  const { signals, score } = row;
  return (
    <li className="flex items-start gap-4 border-t px-5 py-3.5 first:border-t-0">
      <button type="button" onClick={onOpen} className="min-w-0 flex-1 rounded text-left outline-none focus-visible:ring-2 focus-visible:ring-ring/50">
        <span className="flex flex-wrap items-center gap-3">
          <span className="truncate text-[13px] font-semibold">{signals.displayName}</span>
          <LikelihoodBar value={score.likelihood} />
        </span>
        <span className="mt-1 block text-xs text-muted-foreground">{score.reasons[0]?.text}</span>
        <span className="mt-2 flex flex-wrap gap-1">
          {score.reasons.slice(1).map((reason) => (
            <Tag key={reason.code} tone={reason.direction === "toward_gone" ? "amber" : "green"}>{reason.text}</Tag>
          ))}
          {signals.accounts.map((account) => <Tag key={account.wiseTeacherId}>{accountLabel(account)}</Tag>)}
        </span>
      </button>
      <Button type="button" size="sm" variant="outline" onClick={onKeep}>Still with us</Button>
    </li>
  );
}
```

Create `src/components/tutor-offboarding/inbox.tsx`:

```tsx
"use client";

import type { OffboardingPersonRow } from "@/lib/tutor-offboarding/types";
import { CountChip, Panel } from "./atoms";
import { BAND_LABEL, INBOX_BANDS } from "./format";
import { PersonRow } from "./person-row";

/** The review list: one panel per band, most likely first. */
export function Inbox({ rows, onOpen, onKeep }: { rows: OffboardingPersonRow[]; onOpen: (key: string) => void; onKeep: (key: string) => void }) {
  if (rows.length === 0) {
    return (
      <Panel>
        <p className="px-5 py-6 text-sm text-muted-foreground">
          Nobody to review. Every tutor on the Wise roster is teaching, new, staff, or marked still with us.
        </p>
      </Panel>
    );
  }
  return (
    <div className="space-y-4">
      {INBOX_BANDS.map((band) => {
        const group = rows.filter((row) => row.score.band === band);
        if (group.length === 0) return null;
        return (
          <Panel key={band} data-band={band}>
            <header className="flex items-center gap-2 border-b px-5 py-3">
              <span className="text-[13px] font-semibold">{BAND_LABEL[band]}</span>
              <CountChip>{group.length}</CountChip>
            </header>
            <ul>
              {group.map((row) => (
                <PersonRow key={row.signals.canonicalKey} row={row}
                  onOpen={() => onOpen(row.signals.canonicalKey)} onKeep={() => onKeep(row.signals.canonicalKey)} />
              ))}
            </ul>
          </Panel>
        );
      })}
    </div>
  );
}
```

Create `src/components/tutor-offboarding/person-detail.tsx`:

```tsx
"use client";

import { useRef } from "react";
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { HISTORY_START } from "@/lib/tutor-offboarding/calibration";
import type { OffboardingPersonRow } from "@/lib/tutor-offboarding/types";
import { Tag, Upper } from "./atoms";
import { BAND_LABEL, formatDay, formatDayYear } from "./format";
import { accountLabel, LikelihoodBar } from "./person-row";

const SHEET = "top-0 right-0 left-auto flex h-dvh w-full max-w-none translate-x-0 translate-y-0 flex-col gap-0 rounded-none border-l p-0 data-open:zoom-in-100 data-closed:zoom-out-100 sm:max-w-[560px]";

function plural(count: number, word: string): string {
  return `${count} ${word}${count === 1 ? "" : "s"}`;
}

export function removalCheck(row: OffboardingPersonRow): string {
  if (row.score.exclusion) return `Not removable: ${row.score.exclusion.text}`;
  if (row.score.removableBlockedBy) return `Not removable yet: ${row.score.removableBlockedBy}`;
  return "Passes every removal check";
}

/** The evidence behind one person's score: reasons, sources, what is next, and each Wise account. */
export function PersonDetail({ row }: { row: OffboardingPersonRow }) {
  const { signals, score } = row;
  const none = `none since ${formatDay(HISTORY_START.toISOString())}`;
  const when = (iso: string | null, fallback: string) => (iso ? formatDayYear(iso) : fallback);
  return (
    <div className="space-y-5 text-sm">
      <section>
        <Upper>Likelihood no longer with us</Upper>
        <div className="mt-2 flex items-center gap-3"><LikelihoodBar value={score.likelihood} /><Tag>{BAND_LABEL[score.band]}</Tag></div>
        <ul className="mt-3 space-y-1.5">
          {score.reasons.map((reason) => (
            <li key={reason.code} className="flex gap-2">
              <span aria-hidden className={reason.direction === "toward_gone" ? "text-amber-600" : "text-available"}>
                {reason.direction === "toward_gone" ? "▲" : "▼"}
              </span>
              {reason.text}
            </li>
          ))}
        </ul>
        <p className="mt-3 text-xs text-muted-foreground">{removalCheck(row)}</p>
      </section>
      <section>
        <Upper>Last class, by source</Upper>
        <dl className="mt-2 grid grid-cols-[auto_1fr] gap-x-4 gap-y-1 text-xs">
          <dt className="text-muted-foreground">Class attendance</dt><dd>{when(signals.lastTaughtBySource.ledger, none)}</dd>
          <dt className="text-muted-foreground">Past classes</dt><dd>{when(signals.lastTaughtBySource.pastBlocks, none)}</dd>
          <dt className="text-muted-foreground">Class feedback</dt><dd>{when(signals.lastTaughtBySource.postClass, none)}</dd>
        </dl>
      </section>
      <section>
        <Upper>Now and next</Upper>
        <dl className="mt-2 grid grid-cols-[auto_1fr] gap-x-4 gap-y-1 text-xs">
          <dt className="text-muted-foreground">Upcoming classes</dt>
          <dd>{signals.upcomingSessions === 0 || !signals.nextSessionAt ? "None" : `${signals.upcomingSessions} (next ${formatDayYear(signals.nextSessionAt)})`}</dd>
          <dt className="text-muted-foreground">Leave</dt>
          <dd>{signals.upcomingLeaveUntil ? `Until ${formatDayYear(signals.upcomingLeaveUntil)}` : "None"}</dd>
          <dt className="text-muted-foreground">Last teacher action in Wise</dt><dd>{when(signals.lastTeacherActionAt, "None on record")}</dd>
          <dt className="text-muted-foreground">Last admin action in Wise</dt><dd>{when(signals.lastAdminActionAt, "None on record")}</dd>
        </dl>
      </section>
      <section>
        <Upper>Wise accounts</Upper>
        <ul className="mt-2 space-y-2">
          {signals.accounts.map((account) => (
            <li key={account.wiseTeacherId} className="rounded-md border px-3 py-2 text-xs">
              <div className="font-medium">{account.displayName}</div>
              <div className="text-muted-foreground">{accountLabel(account)}</div>
              <div className="mt-1 flex flex-wrap gap-1">
                <Tag>{account.relation ?? "Role unknown"}</Tag>
                <Tag>{account.joinedOn ? `Joined ${formatDayYear(account.joinedOn)}` : "Joined date unknown"}</Tag>
                <Tag>{account.courseCount === null ? "Courses unknown" : plural(account.courseCount, "course")}</Tag>
                <Tag>{account.activated === null ? "Login unknown" : account.activated ? "Login activated" : "Never logged in"}</Tag>
                <Tag>{account.availabilityKnown ? plural(account.workingHourWindows, "working-hour window") : "Working hours unknown"}</Tag>
              </div>
            </li>
          ))}
        </ul>
      </section>
    </div>
  );
}

export function PersonDrawer({ row, onClose }: { row: OffboardingPersonRow | null; onClose: () => void }) {
  const bodyRef = useRef<HTMLDivElement>(null);
  return (
    <Dialog open={row !== null} onOpenChange={(open) => { if (!open) onClose(); }}>
      <DialogContent initialFocus={bodyRef} className={SHEET}>
        <DialogHeader className="shrink-0 gap-1 border-b px-5 py-4 pr-12">
          <DialogTitle className="text-[15px] font-semibold tracking-tight">{row?.signals.displayName ?? ""}</DialogTitle>
          <DialogDescription className="text-xs">The evidence behind the score. Nothing here changes Wise.</DialogDescription>
        </DialogHeader>
        <div ref={bodyRef} tabIndex={-1} className="min-h-0 flex-1 overflow-y-auto overscroll-contain px-5 py-4 outline-none">
          {row ? <PersonDetail row={row} /> : null}
        </div>
      </DialogContent>
    </Dialog>
  );
}
```

- [ ] **Step 6: Write the dialog, rail, grants panel and history table**

Create `src/components/tutor-offboarding/still-with-us-dialog.tsx`:

```tsx
"use client";

import { useState } from "react";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Textarea } from "@/components/ui/textarea";
import type { OffboardingPersonRow } from "@/lib/tutor-offboarding/types";

const SNOOZES = [{ days: 90, label: "90 days" }, { days: 365, label: "1 year" }] as const;

function errorMessage(body: unknown, fallback: string): string {
  const error = (body as { error?: unknown } | null)?.error;
  return typeof error === "string" ? error : fallback;
}

function StillWithUsForm({ row, onClose, onSaved }: { row: OffboardingPersonRow; onClose: () => void; onSaved: () => Promise<void> }) {
  const [note, setNote] = useState("");
  const [snoozeDays, setSnoozeDays] = useState<90 | 365>(90);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function save() {
    setSaving(true);
    setError(null);
    try {
      const response = await fetch("/api/tutor-offboarding/decisions", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ canonicalKey: row.signals.canonicalKey, note: note.trim() || null, snoozeDays }),
      });
      if (!response.ok) {
        setError(errorMessage(await response.json().catch(() => null), "The decision could not be saved."));
        return;
      }
      await onSaved();
      onClose();
    } catch {
      setError("The decision could not be saved.");
    } finally {
      setSaving(false);
    }
  }

  return (
    <>
      <DialogHeader>
        <DialogTitle>{row.signals.displayName} is still with us</DialogTitle>
        <DialogDescription>Hide them from the review list. They come back if they are still idle when this ends.</DialogDescription>
      </DialogHeader>
      <fieldset className="space-y-2">
        <legend className="text-xs font-medium">Hide for</legend>
        <div className="flex gap-2">
          {SNOOZES.map((option) => (
            <Button key={option.days} type="button" size="sm" variant={snoozeDays === option.days ? "default" : "outline"}
              aria-pressed={snoozeDays === option.days} onClick={() => setSnoozeDays(option.days)}>
              {option.label}
            </Button>
          ))}
        </div>
      </fieldset>
      <label className="block space-y-1.5 text-xs font-medium">
        Note (optional)
        <Textarea value={note} maxLength={1_000} onChange={(event) => setNote(event.target.value)} placeholder="e.g. On a term break, back in January" />
      </label>
      {error ? <p role="alert" className="text-xs text-conflict">{error}</p> : null}
      <DialogFooter>
        <Button type="button" variant="outline" onClick={onClose} disabled={saving}>Cancel</Button>
        <Button type="button" onClick={() => void save()} disabled={saving}>{saving ? "Saving…" : "Save"}</Button>
      </DialogFooter>
    </>
  );
}

export function StillWithUsDialog({ row, onClose, onSaved }: { row: OffboardingPersonRow | null; onClose: () => void; onSaved: () => Promise<void> }) {
  return (
    <Dialog open={row !== null} onOpenChange={(open) => { if (!open) onClose(); }}>
      <DialogContent className="sm:max-w-md">
        {row ? <StillWithUsForm key={row.signals.canonicalKey} row={row} onClose={onClose} onSaved={onSaved} /> : null}
      </DialogContent>
    </Dialog>
  );
}
```

Create `src/components/tutor-offboarding/rail.tsx`:

```tsx
"use client";

import { Button } from "@/components/ui/button";
import type { CalibrationCurve } from "@/lib/tutor-offboarding/calibration";
import type { FreshnessReport, OffboardingPersonRow } from "@/lib/tutor-offboarding/types";
import { CountChip, Disclosure, Panel, Upper } from "./atoms";
import { curveSentence, formatDay, formatDayYear } from "./format";

/** OFF-07: names every stale feed. */
export function FreshnessBanner({ report }: { report: FreshnessReport }) {
  const stale = report.feeds.filter((feed) => !feed.fresh);
  return (
    <div role="status" className="mt-4 rounded-[10px] border border-amber-300 bg-amber-50 px-4 py-3 text-sm text-amber-900 dark:border-amber-900 dark:bg-amber-950 dark:text-amber-100">
      <strong className="font-semibold">Scores are provisional: some data is out of date.</strong>
      {` ${stale.map((feed) => `${feed.label} (${feed.lastSuccessAt ? `last updated ${formatDayYear(feed.lastSuccessAt)}` : "never updated"})`).join("; ")}.`}
    </div>
  );
}

export function HowScoreWorks({ curve }: { curve: CalibrationCurve }) {
  return (
    <Panel className="px-5 py-4">
      <Upper>How the score works</Upper>
      <p className="mt-2 text-[13px] font-medium">{curveSentence(curve)}</p>
      <table className="mt-3 w-full text-xs">
        <thead className="text-muted-foreground">
          <tr>
            <th className="text-left font-medium">Idle for</th>
            <th className="text-right font-medium">Came back</th>
            <th className="text-right font-medium">Still idle</th>
            <th className="text-right font-medium">Likely gone</th>
          </tr>
        </thead>
        <tbody>
          {curve.points.map((point) => (
            <tr key={point.thresholdDays} className="border-t">
              <td className="py-1">{`${point.thresholdDays}+ days`}</td>
              <td className="py-1 text-right tabular-nums">{point.returned}</td>
              <td className="py-1 text-right tabular-nums">{point.stillIdle}</td>
              <td className="py-1 text-right tabular-nums">{`${Math.round(point.goneProbability * 100)}%${point.usedDefault ? "*" : ""}`}</td>
            </tr>
          ))}
        </tbody>
      </table>
      {curve.points.some((point) => point.usedDefault) ? <p className="mt-1 text-[11px] text-muted-foreground">* Default estimate until there is enough history.</p> : null}
      <p className="mt-3 text-xs text-muted-foreground">
        Raises the score: no working hours, no Wise courses, never logged in. Lowers it: used Wise in the last 30 days, on leave. Unknown data never counts.
      </p>
    </Panel>
  );
}

/** OFF-03: Wise admin accounts, read only. */
export function StaffAccounts({ rows, onOpen }: { rows: OffboardingPersonRow[]; onOpen: (key: string) => void }) {
  return (
    <Panel className="px-5 py-4">
      <div className="flex items-center gap-2"><Upper>Staff accounts</Upper><CountChip>{rows.length}</CountChip></div>
      <p className="mt-1 text-xs text-muted-foreground">Wise admin accounts. Read only: remove departed staff by hand in Wise.</p>
      <ul className="mt-3 space-y-2">
        {rows.map((row) => (
          <li key={row.signals.canonicalKey}>
            <button type="button" onClick={() => onOpen(row.signals.canonicalKey)}
              className="w-full rounded-md text-left text-xs outline-none hover:bg-muted/40 focus-visible:ring-2 focus-visible:ring-ring/50">
              <span className="font-medium">{row.signals.displayName}</span>
              <span className="block text-muted-foreground">
                {`${row.signals.lastAdminActionAt ? `Last admin action ${formatDay(row.signals.lastAdminActionAt)}` : "No admin activity on record"}${
                  row.signals.lastTaughtAt ? ` · last class ${formatDay(row.signals.lastTaughtAt)}` : ""}`}
              </span>
            </button>
          </li>
        ))}
      </ul>
    </Panel>
  );
}

export function ExcludedList({ rows, onOpen, onUndo }: { rows: OffboardingPersonRow[]; onOpen: (key: string) => void; onUndo: (decisionId: string) => void }) {
  const teaching = rows.filter((row) => row.score.exclusion?.code === "teaching").length;
  const others = rows.filter((row) => row.score.exclusion?.code !== "teaching");
  return (
    <Disclosure title="Excluded" count={rows.length}>
      <p className="px-5 pt-3 text-xs text-muted-foreground">{`${teaching} teaching (have upcoming classes).`}</p>
      <ul className="space-y-2 px-5 py-3">
        {others.map((row) => (
          <li key={row.signals.canonicalKey} className="text-xs">
            <button type="button" onClick={() => onOpen(row.signals.canonicalKey)} className="font-medium hover:underline">{row.signals.displayName}</button>
            <span className="text-muted-foreground"> · {row.score.exclusion?.text}</span>
            {row.openDecision ? (
              <div className="mt-1 flex items-center gap-2 text-muted-foreground">
                <span>
                  by {row.openDecision.decidedByEmail}, until {formatDay(row.openDecision.snoozeUntil)}
                  {row.openDecision.note ? ` · “${row.openDecision.note}”` : ""}
                </span>
                <Button type="button" size="xs" variant="ghost" onClick={() => onUndo(row.openDecision!.id)}>Undo</Button>
              </div>
            ) : null}
          </li>
        ))}
      </ul>
    </Disclosure>
  );
}
```

Create `src/components/tutor-offboarding/grants-panel.tsx`:

```tsx
"use client";

import { useState } from "react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import type { GrantRecord } from "@/lib/tutor-offboarding/types";
import { Panel, Upper } from "./atoms";
import { formatDay } from "./format";

/** OFF-11: the owner chooses which admins may remove tutors from Wise (used by PR 2's Remove button). */
export function GrantsPanel({ grants, onChanged }: { grants: GrantRecord[]; onChanged: (next: GrantRecord[]) => void }) {
  const [email, setEmail] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function change(action: "grant" | "revoke", target: string) {
    setBusy(true);
    setError(null);
    try {
      const response = await fetch("/api/tutor-offboarding/grants", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ action, email: target }),
      });
      const body = (await response.json().catch(() => null)) as { error?: unknown; grants?: GrantRecord[] } | null;
      if (!response.ok || !body?.grants) {
        setError(typeof body?.error === "string" ? body.error : "The removal access could not be changed.");
        return;
      }
      onChanged(body.grants);
      if (action === "grant") setEmail("");
    } catch {
      setError("The removal access could not be changed.");
    } finally {
      setBusy(false);
    }
  }

  return (
    <Panel className="px-5 py-4">
      <Upper>Who can remove</Upper>
      <p className="mt-1 text-xs text-muted-foreground">Admins allowed to remove departed tutors from Wise. Only you can change this.</p>
      <ul className="mt-3 space-y-1.5">
        {grants.length === 0 ? <li className="text-xs text-muted-foreground">Nobody yet.</li> : null}
        {grants.map((grant) => (
          <li key={grant.email} className="flex items-center justify-between gap-2 text-xs">
            <span>{grant.email} <span className="text-muted-foreground">· since {formatDay(grant.grantedAt)}</span></span>
            <Button type="button" size="xs" variant="ghost" disabled={busy} onClick={() => void change("revoke", grant.email)}>Remove</Button>
          </li>
        ))}
      </ul>
      <form className="mt-3 flex gap-2" onSubmit={(event) => { event.preventDefault(); if (email.trim()) void change("grant", email.trim()); }}>
        <Input type="email" value={email} onChange={(event) => setEmail(event.target.value)} placeholder="admin@email" aria-label="Admin email" />
        <Button type="submit" size="sm" disabled={busy || !email.trim()}>Allow</Button>
      </form>
      {error ? <p role="alert" className="mt-2 text-xs text-conflict">{error}</p> : null}
    </Panel>
  );
}
```

Create `src/components/tutor-offboarding/history-table.tsx`:

```tsx
import type { DecisionView } from "@/lib/tutor-offboarding/types";
import { Panel } from "./atoms";
import { BAND_LABEL, formatDayYear } from "./format";

/** The decision log. Removal runs join it in PR 2. */
export function HistoryTable({ decisions }: { decisions: DecisionView[] }) {
  if (decisions.length === 0) return <Panel className="mt-4 px-5 py-6 text-sm text-muted-foreground">No decisions yet.</Panel>;
  return (
    <Panel className="mt-4">
      <table className="w-full text-xs">
        <thead className="border-b text-muted-foreground">
          <tr>{["Tutor", "Decision", "Score then", "By", "When", "Note"].map((heading) => <th key={heading} className="px-4 py-2 text-left font-medium">{heading}</th>)}</tr>
        </thead>
        <tbody>
          {decisions.map((decision) => (
            <tr key={decision.id} className="border-t">
              <td className="px-4 py-2 font-medium">{decision.displayName}</td>
              <td className="px-4 py-2">
                {decision.revokedAt ? `Still with us · undone ${formatDayYear(decision.revokedAt)}` : `Still with us · until ${formatDayYear(decision.snoozeUntil)}`}
              </td>
              <td className="px-4 py-2 tabular-nums">{decision.likelihoodAtDecision}% · {BAND_LABEL[decision.bandAtDecision]}</td>
              <td className="px-4 py-2">{decision.decidedByEmail}</td>
              <td className="px-4 py-2">{formatDayYear(decision.decidedAt)}</td>
              <td className="px-4 py-2 text-muted-foreground">{decision.note ?? ""}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </Panel>
  );
}
```

- [ ] **Step 7: Run the tests to verify they pass**

Run: `npx vitest run --project unit src/components/tutor-offboarding`
Expected: PASS (format 4, person-detail 2, rail 4). If a fixture-derived string differs (for example the band a fixture person lands in), fix the fixture so the stated scenario holds — do not loosen the assertion.

- [ ] **Step 8: Commit**

```bash
git add src/components/tutor-offboarding
git commit -m "$(cat <<'EOF'
Tutor Offboarding: inbox, detail drawer, rail panels, grants and history UI

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>
EOF
)"
```

---

### Task 9: Workspace, page and navigation

**Files:**
- Create: `src/components/tutor-offboarding/tutor-offboarding-workspace.tsx`
- Create: `src/app/(app)/tutor-offboarding/page.tsx`
- Modify: `src/lib/navigation/tools.ts` (NavToolId union; NAV_TOOLS after `tutor-profiles`)
- Test: `src/components/tutor-offboarding/__tests__/workspace.test.tsx`
- Modify test: `src/lib/navigation/__tests__/tools.test.ts`

**Interfaces:**
- Consumes: every component of Task 8; `viewerForEmail` (Task 5); `loadTutorOffboardingDashboard` (Task 6); `auth`.
- Produces: `TutorOffboardingWorkspace({ initial: OffboardingDashboard })`; route `/tutor-offboarding`; nav tool id `"tutor-offboarding"`.

- [ ] **Step 1: Write the failing tests**

Create `src/components/tutor-offboarding/__tests__/workspace.test.tsx`:

```tsx
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { topLineSentence } from "../format";
import { TutorOffboardingWorkspace } from "../tutor-offboarding-workspace";
import { ADMIN, dashboardFixture, emptyDashboardFixture, notSetUpFixture, staleDashboardFixture } from "./fixtures";

function render(initial: Parameters<typeof TutorOffboardingWorkspace>[0]["initial"]) {
  return renderToStaticMarkup(<TutorOffboardingWorkspace initial={initial} />);
}

describe("TutorOffboardingWorkspace", () => {
  it("opens on the top line, the bands in order, and each person's reasons", () => {
    const data = dashboardFixture();
    const html = render({ available: true, ...data });
    expect(html).toContain(`${topLineSentence(data.summary)} · data 12 min old`);
    expect(html.indexOf(">Very likely gone<")).toBeGreaterThan(-1);
    expect(html.indexOf(">Very likely gone<")).toBeLessThan(html.indexOf(">Likely gone<"));
    for (const row of data.inbox) expect(html).toContain(row.signals.displayName);
    expect(html).toContain("No working hours set in Wise");
    expect(html).toContain("Still with us");
    expect(html).toContain("Who can remove");
    expect(html).not.toContain("Scores are provisional");
  });

  it("shows other admins everything except the owner's grant panel", () => {
    const html = render({ available: true, ...dashboardFixture(ADMIN) });
    expect(html).toContain("Staff accounts");
    expect(html).not.toContain("Who can remove");
  });

  it("warns when scores are provisional and says when nobody needs review", () => {
    expect(render({ available: true, ...staleDashboardFixture() })).toContain("Scores are provisional");
    expect(render({ available: true, ...emptyDashboardFixture() })).toContain("Nobody to review.");
  });

  it("explains a page that is not set up yet", () => {
    expect(render(notSetUpFixture())).toContain("Tutor Offboarding is not set up yet: its database migration has not been applied.");
  });
});
```

In `src/lib/navigation/__tests__/tools.test.ts`, inside the test `"groups tools by business function in the chosen section order"`, after the line

```ts
    expect(sections[0].tools.map((tool) => tool.href)).toContain("/onsite-foot-traffic");
```

add:

```ts
    expect(sections[0].tools.map((tool) => tool.href)).toContain("/tutor-offboarding");
```

- [ ] **Step 2: Run them to verify they fail**

Run: `npx vitest run --project unit src/components/tutor-offboarding/__tests__/workspace.test.tsx src/lib/navigation/__tests__/tools.test.ts`
Expected: FAIL — workspace import unresolved; tools test fails on `/tutor-offboarding`.

- [ ] **Step 3: Write the workspace**

Create `src/components/tutor-offboarding/tutor-offboarding-workspace.tsx`:

```tsx
"use client";

import { useCallback, useState } from "react";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import type { OffboardingDashboard, OffboardingUnavailableReason } from "@/lib/tutor-offboarding/types";
import { Panel } from "./atoms";
import { formatAge, topLineSentence } from "./format";
import { GrantsPanel } from "./grants-panel";
import { HistoryTable } from "./history-table";
import { Inbox } from "./inbox";
import { PersonDrawer } from "./person-detail";
import { ExcludedList, FreshnessBanner, HowScoreWorks, StaffAccounts } from "./rail";
import { StillWithUsDialog } from "./still-with-us-dialog";

const UNAVAILABLE: Record<OffboardingUnavailableReason, string> = {
  not_set_up: "Tutor Offboarding is not set up yet: its database migration has not been applied.",
  no_snapshot: "No Wise snapshot is active yet, so there is nobody to score.",
  load_failed: "The page could not load. Try again in a minute; if it keeps failing, check Data Health.",
};

export function TutorOffboardingWorkspace({ initial }: { initial: OffboardingDashboard }) {
  const [dashboard, setDashboard] = useState(initial);
  const [openKey, setOpenKey] = useState<string | null>(null);
  const [keepKey, setKeepKey] = useState<string | null>(null);

  const reload = useCallback(async () => {
    const response = await fetch("/api/tutor-offboarding", { cache: "no-store" });
    if (response.ok) setDashboard((await response.json()) as OffboardingDashboard);
  }, []);

  if (!dashboard.available) {
    return (
      <div className="mx-auto w-full max-w-[1440px] pb-10 lg:px-6">
        <h1 className="border-b pt-1.5 pb-4 text-[22px] font-semibold tracking-tight">Tutor Offboarding</h1>
        <Panel className="mt-5 px-5 py-6 text-sm">{UNAVAILABLE[dashboard.reason]}</Panel>
      </div>
    );
  }

  const everyone = [...dashboard.inbox, ...dashboard.excluded, ...dashboard.staff];
  const openRow = everyone.find((row) => row.signals.canonicalKey === openKey) ?? null;
  const keepRow = dashboard.inbox.find((row) => row.signals.canonicalKey === keepKey) ?? null;

  async function undo(decisionId: string) {
    await fetch(`/api/tutor-offboarding/decisions/${decisionId}`, { method: "DELETE" });
    await reload();
  }

  return (
    <div className="flex min-h-0 flex-1 flex-col overflow-auto">
      <div className="mx-auto w-full max-w-[1440px] pb-10 lg:px-6">
        <header className="border-b pt-1.5 pb-4">
          <h1 className="text-[22px] font-semibold tracking-tight">Tutor Offboarding</h1>
          {/* One string: React SSR separates adjacent text nodes with comments. */}
          <p className="mt-1 text-sm text-muted-foreground">
            {`${topLineSentence(dashboard.summary)} · data ${formatAge(dashboard.snapshotCreatedAt, new Date(dashboard.servedAt))}`}
          </p>
        </header>
        {dashboard.freshness.ok ? null : <FreshnessBanner report={dashboard.freshness} />}
        <Tabs defaultValue="review" className="mt-5">
          <TabsList>
            <TabsTrigger value="review">To review</TabsTrigger>
            <TabsTrigger value="history">History</TabsTrigger>
          </TabsList>
          <TabsContent value="review">
            <div className="mt-4 grid gap-5 lg:grid-cols-3">
              <div className="lg:col-span-2">
                <Inbox rows={dashboard.inbox} onOpen={setOpenKey} onKeep={setKeepKey} />
              </div>
              <aside className="space-y-4">
                <HowScoreWorks curve={dashboard.curve} />
                <StaffAccounts rows={dashboard.staff} onOpen={setOpenKey} />
                <ExcludedList rows={dashboard.excluded} onOpen={setOpenKey} onUndo={(id) => void undo(id)} />
                {dashboard.viewer.isOwner && dashboard.grants ? (
                  <GrantsPanel grants={dashboard.grants} onChanged={(grants) => setDashboard({ ...dashboard, grants })} />
                ) : null}
              </aside>
            </div>
          </TabsContent>
          <TabsContent value="history">
            <HistoryTable decisions={dashboard.decisions} />
          </TabsContent>
        </Tabs>
      </div>
      <PersonDrawer row={openRow} onClose={() => setOpenKey(null)} />
      <StillWithUsDialog row={keepRow} onClose={() => setKeepKey(null)} onSaved={reload} />
    </div>
  );
}
```

- [ ] **Step 4: Write the page**

Create `src/app/(app)/tutor-offboarding/page.tsx`:

```tsx
import { Suspense } from "react";
import { redirect } from "next/navigation";
import { TutorOffboardingWorkspace } from "@/components/tutor-offboarding/tutor-offboarding-workspace";
import { auth } from "@/lib/auth";
import { viewerForEmail } from "@/lib/tutor-offboarding/access";
import { loadTutorOffboardingDashboard } from "@/lib/tutor-offboarding/service";
import type { OffboardingDashboard } from "@/lib/tutor-offboarding/types";

export const metadata = { title: "Tutor Offboarding | BeGifted Ops" };

/** Next's own signal that a render was abandoned: passed on, never turned into an "unavailable" payload. */
function isHangingPromiseRejection(error: unknown): boolean {
  return typeof error === "object" && error !== null && (error as { digest?: unknown }).digest === "HANGING_PROMISE_REJECTION";
}

async function TutorOffboardingBody() {
  const session = await auth();
  if (!session?.user?.email) redirect("/login");
  if (session.user.role !== "admin") redirect("/");
  const email = session.user.email.trim().toLowerCase();
  let initial: OffboardingDashboard;
  try {
    initial = await loadTutorOffboardingDashboard(await viewerForEmail(email));
  } catch (error) {
    if (isHangingPromiseRejection(error)) throw error;
    console.error("[tutor-offboarding] page could not load", { errorName: error instanceof Error ? error.name : "UnknownError" });
    initial = { available: false, reason: "load_failed", viewer: { email, isOwner: false, canRemove: false } };
  }
  return <TutorOffboardingWorkspace initial={initial} />;
}

/** The page's outline while it loads: title line, the review list beside the rail. */
function TutorOffboardingSkeleton() {
  return (
    <div className="flex min-h-0 flex-1 flex-col overflow-hidden" role="status" aria-label="Loading tutor offboarding">
      <div className="mx-auto w-full max-w-[1440px] pb-10 lg:px-6">
        <div className="border-b pt-1.5 pb-4">
          <div className="h-[30px] w-56 animate-pulse rounded-lg bg-muted" />
          <div className="mt-2 h-4 w-3/4 animate-pulse rounded bg-muted" />
        </div>
        <div className="mt-5 h-8 w-48 animate-pulse rounded-md bg-muted" />
        <div className="mt-4 grid gap-5 lg:grid-cols-3">
          <div className="h-[560px] animate-pulse rounded-[10px] bg-muted lg:col-span-2" />
          <div className="h-[560px] animate-pulse rounded-[10px] bg-muted" />
        </div>
      </div>
    </div>
  );
}

export default function TutorOffboardingPage() {
  return (
    <Suspense fallback={<TutorOffboardingSkeleton />}>
      <TutorOffboardingBody />
    </Suspense>
  );
}
```

- [ ] **Step 5: Add the nav entry**

In `src/lib/navigation/tools.ts`, in the `NavToolId` union replace

```ts
  | "tutor-profiles"
```

with

```ts
  | "tutor-profiles"
  | "tutor-offboarding"
```

and in `NAV_TOOLS`, directly after the `tutor-profiles` entry (the object ending `section: "scheduling-tutors",\n  },` whose `id` is `"tutor-profiles"`), insert:

```ts
  {
    id: "tutor-offboarding",
    href: "/tutor-offboarding",
    label: "Tutor Offboarding",
    description: "Find tutors who have likely left and clean up their Wise accounts.",
    section: "scheduling-tutors",
  },
```

- [ ] **Step 6: Run the tests to verify they pass**

Run: `npx vitest run --project unit src/components/tutor-offboarding src/lib/navigation`
Expected: PASS.

- [ ] **Step 7: Lint, typecheck, and the whole unit suite**

Run: `npx eslint src/components/tutor-offboarding "src/app/(app)/tutor-offboarding" src/lib/navigation && npm run typecheck && npm test`
Expected: no lint or type errors; the full unit project passes.

- [ ] **Step 8: Commit**

```bash
git add src/components/tutor-offboarding/tutor-offboarding-workspace.tsx src/components/tutor-offboarding/__tests__/workspace.test.tsx \
  "src/app/(app)/tutor-offboarding/page.tsx" src/lib/navigation/tools.ts src/lib/navigation/__tests__/tools.test.ts
git commit -m "$(cat <<'EOF'
Tutor Offboarding: workspace, page and navigation entry

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>
EOF
)"
```

---

### Task 10: Fixture render to PNG for the owner

**Files:**
- Create: `scripts/dev/render-tutor-offboarding.mjs` (copied from `scripts/dev/render-autowriter-dashboard.mjs`, then edited)
- Modify: `.gitignore`

**Interfaces:**
- Consumes: `TutorOffboardingWorkspace` (Task 9), fixtures (Task 8).
- Produces: `.tutor-offboarding/preview/index.html`, `dashboard-{owner,admin,stale,empty,not-set-up,details}.png`, `drawer-very_likely_gone.png`.

- [ ] **Step 1: Ignore the preview folder**

In `.gitignore`, directly after the line `.feedback-autowriter/`, add:

```
.tutor-offboarding/
```

- [ ] **Step 2: Copy the render script**

```bash
cp scripts/dev/render-autowriter-dashboard.mjs scripts/dev/render-tutor-offboarding.mjs
```

- [ ] **Step 3: Replace the header comment**

In `scripts/dev/render-tutor-offboarding.mjs`, replace everything from the first `// Visual check of the Feedback Autowriter dashboard` line down to (not including) the first `import` line with:

```js
// Visual check of the Tutor Offboarding page with made-up fixtures, for the owner's review before merge. Dev only:
// not an app route, no server, no database, nothing but src/components/tutor-offboarding/__tests__/fixtures.ts.
//
//   node scripts/dev/render-tutor-offboarding.mjs            build the preview and take the screenshots
//   node scripts/dev/render-tutor-offboarding.mjs --no-shot  build the preview only (open index.html yourself)
//
// Writes one self-contained index.html to the git-ignored .tutor-offboarding/preview/ and screenshots each view
// (`index.html?view=owner|admin|stale|empty|not-set-up`), the owner's view with every collapsed section open
// (`&details=open`), and the drawer on the first "Very likely gone" person (`&open=very_likely_gone`).
// `&theme=dark` shows any of them in the dark theme. Chrome is taken from CHROME_BIN, or the usual macOS location.
```

- [ ] **Step 4: Point the constants at this page**

Replace

```js
const OUT = path.join(ROOT, ".feedback-autowriter", "preview");
```

with

```js
const OUT = path.join(ROOT, ".tutor-offboarding", "preview");
```

Replace

```js
const VIEWS = ["owner", "admin", "empty", "review-failed"];
const DRAWERS = ["review", "hold", "incident", "failed_post"];
```

with

```js
const VIEWS = ["owner", "admin", "stale", "empty", "not-set-up"];
const DRAWERS = ["very_likely_gone"];
```

- [ ] **Step 5: Replace the browser entry**

Replace the whole `const ENTRY = \`...\`;` template literal with:

```js
const ENTRY = `
import { createRoot } from "react-dom/client";
import { TutorOffboardingWorkspace } from "@/components/tutor-offboarding/tutor-offboarding-workspace";
import {
  ADMIN,
  dashboardFixture,
  emptyDashboardFixture,
  notSetUpFixture,
  staleDashboardFixture,
} from "@/components/tutor-offboarding/__tests__/fixtures";

const VIEWS = {
  owner: () => ({ available: true, ...dashboardFixture() }),
  admin: () => ({ available: true, ...dashboardFixture(ADMIN) }),
  stale: () => ({ available: true, ...staleDashboardFixture() }),
  empty: () => ({ available: true, ...emptyDashboardFixture() }),
  "not-set-up": () => notSetUpFixture(),
};

// A preview has no server: a request the page makes (a click) waits forever instead of failing.
window.fetch = () => new Promise(() => undefined);

const params = new URLSearchParams(window.location.search);
if (params.get("theme") === "dark") document.documentElement.classList.add("dark");
const name = params.get("view") ?? "owner";
createRoot(document.getElementById("root")).render(<TutorOffboardingWorkspace initial={(VIEWS[name] ?? VIEWS.owner)()} />);
// ?open=<band>: the drawer on that band's first person, as a click on the row opens it.
const open = params.get("open");
if (open) window.setTimeout(() => document.querySelector('[data-band="' + open + '"] li button')?.click(), 500);
// ?details=open: every collapsed section opened.
if (params.get("details") === "open") {
  window.setTimeout(() => document.querySelectorAll("details").forEach((section) => { section.open = true; }), 500);
}
window.setTimeout(() => {
  document.documentElement.dataset.pageHeight = String(document.documentElement.scrollHeight);
  document.documentElement.dataset.viewportHeight = String(window.innerHeight);
}, 1500);
`;
```

- [ ] **Step 6: Rename the remaining autowriter strings**

Replace `<title>Feedback Autowriter · preview with made-up data</title>` with `<title>Tutor Offboarding · preview with made-up data</title>`.
Replace `sourcefile: "autowriter-preview-entry.tsx"` with `sourcefile: "tutor-offboarding-preview-entry.tsx"`.
Replace `path.join(os.tmpdir(), "autowriter-preview-")` with `path.join(os.tmpdir(), "tutor-offboarding-preview-")`.

Then confirm nothing autowriter-specific is left:

```bash
grep -n -i "autowriter" scripts/dev/render-tutor-offboarding.mjs
```

Expected: no output.

- [ ] **Step 7: Render**

```bash
node scripts/dev/render-tutor-offboarding.mjs
```

Expected: `Preview written to .tutor-offboarding/preview/` and seven PNG lines (`dashboard-owner.png` … `drawer-very_likely_gone.png`).

- [ ] **Step 8: Look at every PNG yourself**

Open each PNG (Read tool) and check: the top line reads naturally; bands are in order; the rail shows the curve table, staff panel, collapsed Excluded and (owner only) Who can remove; the stale view shows the amber banner; the drawer shows reasons, sources and accounts; no text overflows at 1440 px. Fix what is wrong and re-render. Then send `dashboard-owner.png` and `drawer-very_likely_gone.png` to the owner (SendUserFile) and wait for their OK before merge.

- [ ] **Step 9: Commit**

```bash
git add scripts/dev/render-tutor-offboarding.mjs .gitignore
git commit -m "$(cat <<'EOF'
Tutor Offboarding: fixture render script for owner review

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>
EOF
)"
```

---

### Task 11: Documentation

**Files:**
- Create: `docs/features/tutor-offboarding.md`
- Create: `docs/reference/api/tutor-offboarding.md`
- Modify: `docs/reference/api/index.md` (one paragraph after the Feedback Autowriter paragraph)
- Modify: `docs/reference/database/index.md` (append a section)
- Modify: `docs/reference/wise-api.md` (Teachers section)

**Interfaces:** none (docs only).

- [ ] **Step 1: Write the feature page**

Create `docs/features/tutor-offboarding.md`:

````markdown
# Tutor Offboarding

**Status: building (PR 1 read-only, 2026-10-01).** Removal from Wise arrives in PR 2 behind
`WISE_TEACHER_REMOVAL_VERIFIED`. Design: [spec](../superpowers/specs/2026-10-01-tutor-offboarding-design.md).

## Purpose

Admins rarely remove the Wise accounts of tutors who have left, so former tutors keep a working Wise login and
clutter Wise and BGScheduler. `/tutor-offboarding` ranks every person on the Wise roster by how likely they are no
longer with BeGifted, explains each score, and (PR 2) lets a granted admin remove them from the Wise institute.

## How the score works

1. **Unit (OFF-01):** a person is an identity group's `canonicalKey`; their online and onsite accounts are scored together.
2. **Calibration** (`src/lib/tutor-offboarding/calibration.ts`): from every tutor's taught days since 2026-03-01
   (attendance ledger `ENDED`, blocking past session blocks, post-class sessions `ENDED`), each idle gap either ended
   with the tutor teaching again or is still open. For 21/30/45/60/90 days, `P(gone) = 1 − (returned + 0.5) / (returned + stillIdle + 1)`,
   with a default when a threshold has fewer than 5 observations, forced non-decreasing.
3. **Score** (`score.ts`): base log-odds plus evidence — no working hours +0.8, no Wise courses +0.8, never activated
   login +0.5, a teacher action in Wise within 30 days −2.0, on leave −1.5 — capped at 99%. Bands: ≥90 very likely
   gone, 70–89 likely, 40–69 unclear, under 40 active.
4. **Unknown never counts (OFF-02):** a null roster column or a failed availability fetch adds nothing.

## Exclusions (never in the review list)

Wise ADMIN account (OFF-03, shown read-only under Staff accounts) · any upcoming class (OFF-04) · full-time tutor ·
identity conflict · never taught with an unknown joined date · new account under 60 days (OFF-05) · "Still with us"
until its snooze ends. Removal additionally needs the last class 45+ days ago (OFF-06) and fresh data (OFF-07).

## Data

- **Roster extras:** the snapshot sync writes `wise_relation`, `wise_joined_on`, `wise_course_count`, `wise_activated`
  onto `tutor_wise_accounts` after each promotion, best effort (`src/lib/tutor-onboarding/roster-facts.ts`; result in
  `sync_runs.metadata.rosterFacts`).
- **Reads:** Postgres only; signals cached per snapshot (`"use cache"`, tag `snapshot`); decisions, grants and
  freshness read fresh.
- **Freshness (OFF-07):** active snapshot ≤ 2 h old (judged by `snapshots.created_at`, because promoted runs are
  recorded `failed` whenever contact warnings exist); progress-test, post-class, Wise-activity and leave-request syncs
  ≤ 3 days since their last success.
- **Tables:** `tutor_offboarding_decisions`, `tutor_offboarding_access_grants`, `tutor_offboarding_access_audit_log`
  (migration 0102).

## Page and access

Nav: Scheduling & Tutors → Tutor Offboarding. Admins with the page in `allowedPages` see the review list, the drawer,
Still with us, staff accounts, exclusions and history. The owner (`SUPER_ADMIN_EMAILS`) also manages who may remove
tutors (OFF-11). API: [reference](../reference/api/tutor-offboarding.md).

## Open items

- PR 2: preview → confirm → apply removal via `POST /institutes/{id}/removeParticipant`, manual mode until verified.
- `removeParticipant` is documented for students only; a labelled dummy-teacher probe must pass first.
````

- [ ] **Step 2: Write the API page**

Create `docs/reference/api/tutor-offboarding.md`:

````markdown
# Tutor Offboarding API

Five method/path endpoints (PR 1). All require a signed-in `admin` session (checked in the handler) and follow
`allowedPages` for `/api/tutor-offboarding`. Errors use the Shape B mapper `tutorOffboardingErrorResponse`
(`src/lib/tutor-offboarding/api.ts`): own refusals keep their status and message; validation → 400; a missing
migration (SQLSTATE 42P01/42703) → 503; anything else → 500 with a generic message (name and SQLSTATE logged only).

| Method | Path | Gate | Purpose |
|---|---|---|---|
| GET | `/api/tutor-offboarding` | admin | Dashboard payload (`OffboardingDashboard`); `{ available: false, reason }` when not set up, no snapshot |
| POST | `/api/tutor-offboarding/decisions` | admin | Still with us: `{ canonicalKey, note?, snoozeDays: 90 \| 365 }` (strict). The score stored with it is computed by the server. 404 if the person is not on the page; 409 if already marked |
| DELETE | `/api/tutor-offboarding/decisions/{decisionId}` | admin | Undo a decision; 404 if unknown or already undone |
| GET | `/api/tutor-offboarding/grants` | owner | `{ grants }` — who may remove tutors |
| POST | `/api/tutor-offboarding/grants` | owner | `{ action: "grant" \| "revoke", email }`; 422 unless an enabled admin; 409 duplicate; 404 revoking a non-grant |

Owner = `requireSuperAdmin()` (`SUPER_ADMIN_EMAILS` + enabled, current admin row). Source: `src/app/api/tutor-offboarding/`.
````

- [ ] **Step 3: Add the API index paragraph**

In `docs/reference/api/index.md`, directly after the paragraph that begins `The [Feedback Autowriter reference](./feedback-autowriter.md) (2026-09-29)`, add a blank line and:

```markdown
The [Tutor Offboarding reference](./tutor-offboarding.md) (2026-10-01) adds five method/path endpoints: the admin `GET /api/tutor-offboarding` dashboard read, the admin `POST /api/tutor-offboarding/decisions` and `DELETE /api/tutor-offboarding/decisions/{decisionId}` ("Still with us" and undo), and the owner-only `GET` and `POST /api/tutor-offboarding/grants` (who may remove tutors from Wise).
```

- [ ] **Step 4: Add the database index section**

Append to the end of `docs/reference/database/index.md`:

```markdown

## Tutor Offboarding — migration 0102

| SQL table | Drizzle export | Grain |
|---|---|---|
| `tutor_offboarding_decisions` | `tutorOffboardingDecisions` | One "Still with us" decision: snooze end, the likelihood/band/reasons it overrode, who decided, optional undo |
| `tutor_offboarding_access_grants` | `tutorOffboardingAccessGrants` | One admin email allowed to remove tutors from Wise (OFF-11); owner-managed |
| `tutor_offboarding_access_audit_log` | `tutorOffboardingAccessAuditLog` | Immutable grant/revoke history |

The same migration adds four nullable roster columns to `tutor_wise_accounts`: `wise_relation`, `wise_joined_on`,
`wise_course_count`, `wise_activated` (null = unknown), written best-effort by the snapshot sync after promotion.
```

- [ ] **Step 5: Document the roster extras in the Wise reference**

In `docs/reference/wise-api.md`, after the paragraph that begins `A \`WiseTeacher\` ([\`types.ts:9-15\`]`, add a blank line and:

```markdown
**Roster extras (2026-10-01).** The live roster rows also carry `joinedOn`, `relation` (`TEACHER` or `ADMIN`; 11 of
164 rows were `ADMIN` on 1 Oct), `status` (all `ACCEPTED`), `updatedAt`, `classes[] { _id, name, subject }`, and
`userId.{ activated, phoneNumber, profilePicture }`. `WiseTeacher` declares them as optional fields. The snapshot sync
persists `relation`, `joinedOn`, the `classes` count and `userId.activated` onto `tutor_wise_accounts` for Tutor
Offboarding, after promotion and best effort (`src/lib/tutor-onboarding/roster-facts.ts`). No extra Wise call is made.
```

- [ ] **Step 6: Check the docs**

Run: `git diff --check && grep -c "OFF-0" docs/features/tutor-offboarding.md`
Expected: no whitespace errors; a count of at least 6.

- [ ] **Step 7: Commit**

```bash
git add docs/features/tutor-offboarding.md docs/reference/api/tutor-offboarding.md docs/reference/api/index.md \
  docs/reference/database/index.md docs/reference/wise-api.md
git commit -m "$(cat <<'EOF'
Tutor Offboarding: feature, API, database and Wise roster docs

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>
EOF
)"
```

---

### Task 12: Full verification and draft PR

**Files:** none new.

- [ ] **Step 1: Run every check**

```bash
npm run typecheck
npm run lint
npm test
npx vitest run --project integration src/lib/tutor-offboarding src/lib/tutor-onboarding src/lib/sync
git diff --check origin/main...HEAD
npm run guard:production-route-surface
```

Expected: every command exits 0. The route-surface guard only fails when routes disappear; new routes pass without `--update`.

- [ ] **Step 2: Scan for unfinished work**

```bash
git diff origin/main...HEAD | grep -n -E "^\+.*(TODO|FIXME|HACK|\.only\(|\.skip\()" || echo "clean"
```

Expected: `clean`.

- [ ] **Step 3: Independent review**

Dispatch a reviewer (code-reviewer agent, not the author) on `git diff origin/main...HEAD` with the spec. Fix every HIGH/MEDIUM finding with a new commit; re-run Step 1.

- [ ] **Step 4: Ask the owner before pushing**

Ask Kevin to approve pushing `feat/tutor-offboarding` and opening a **draft** PR. Do not push without that answer.

- [ ] **Step 5: Push and open the draft PR**

```bash
git push -u origin feat/tutor-offboarding
gh pr create --draft --base main --title "Tutor Offboarding PR 1: read-only departed-tutor dashboard" --body "$(cat <<'EOF'
## Summary
- New `/tutor-offboarding` page: every tutor on the Wise roster scored by how likely they have left, with plain-language reasons, a detail drawer, "Still with us" snoozes, a read-only staff-accounts panel, and an owner-managed list of who may remove tutors (removal itself is PR 2).
- Likelihood is calibrated on BeGifted's own teaching history (return rate by idle gap, Jeffreys-smoothed) plus fixed evidence weights; unknown data never counts (OFF-02).
- The snapshot sync now persists four Wise roster details (relation, joined date, course count, login activated) best-effort after promotion.
- Migration 0102 (additive): 4 nullable columns on `tutor_wise_accounts` + 3 new tables. Needs the owner's word before it is applied to production.

Spec: `docs/superpowers/specs/2026-10-01-tutor-offboarding-design.md` · Plan: `docs/superpowers/plans/2026-10-01-tutor-offboarding-pr1-dashboard.md`

## Test plan
- [ ] Owner applied migration 0102 to production BEFORE merge (the snapshot sync reads the new columns)
- [ ] `npm run typecheck`, `npm run lint`, `npm test`
- [ ] Integration: `npx vitest run --project integration src/lib/tutor-offboarding src/lib/tutor-onboarding src/lib/sync`
- [ ] Fixture renders reviewed by the owner (`node scripts/dev/render-tutor-offboarding.mjs`)
- [ ] After migration 0102 on production: page loads, top line matches the 1 Oct prototype (≈23 very likely gone), staff panel lists the Wise ADMIN accounts

🤖 Generated with [Claude Code](https://claude.com/claude-code)
EOF
)"
```

- [ ] **Step 6: Bind the PR and report**

Call `mcp__ccd_pr__get_status`; if it does not report the new PR, bind it with `mcp__ccd_pr__bind_pr`. Report the PR link, CI state and the open owner gates (fixture review, migration 0102 on production, merge).
