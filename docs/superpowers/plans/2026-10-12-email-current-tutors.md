# Email Current Tutors Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Let BeGifted staff run a Claude Code skill that drafts a BeGifted-branded Gmail message to every tutor who is teaching now, with the tutors in BCC, never sending it.

**Architecture:** A read-only admin endpoint, `GET /api/tutor-offboarding/current-tutors`, derives the list from the existing Tutor Offboarding dashboard rows plus `tutor_contacts`. The pure function `buildCurrentTutorList` holds the rule and has unit tests. A committed project skill, `.claude/skills/email-current-tutors/`, reads that list through the sender's signed-in browser or a downloaded CSV. It renders the email with a bundled copy of the zero-dependency BeGifted v3 company-email renderer, then creates a Gmail draft through the claude.ai Gmail connector.

**Tech Stack:** Next.js 16 route handler, Drizzle (neon-http), Vitest 4, plain Node ESM (`node:test`) for the skill script.

**Spec:** `docs/superpowers/specs/2026-10-12-email-current-tutors-design.md`

## Global Constraints

- Current = `upcomingSessions > 0` (reason `"upcoming"`) or `lastTaughtAt` ≥ now − 30 × 24 h (reason `"recent"`); `"upcoming"` wins.
- A row with `termination` evidence (matched sheet strike-through) is excluded even while teaching.
- Email resolution reuses `resolvePostClassTutorRecipient` from `src/lib/post-class-feedback/notifications.ts`; conflicts and gaps are never guessed.
- Endpoint: admin session (`requireTutorOffboardingAdmin`), Shape B errors (`tutorOffboardingErrorResponse`), `Cache-Control: private, no-store` on every response, only `?format=csv` accepted, no Wise or Sheets call.
- No migration, env var, cron or Wise write.
- Skill: never sends; tutors in BCC only; stop at more than 450 recipients; recipient list never committed or uploaded; English copy; supplied facts only.
- Logo URL exactly `https://bgscheduler.vercel.app/brand/email/v3/logo-horizontal.png`.
- Skill scripts use only Node built-ins and run on Node 20+ (team machines use Node 24; do not use `import.meta.main`).
- Repo conventions: tests in a sibling `__tests__/` dir, double quotes, semicolons in `src/lib`/`src/app`, made-up names and `@example.com` addresses in fixtures.
- Worktree: `.claude/worktrees/slot-c`, branch `feat/email-current-tutors`. Run every command from that directory.

## Review Focus

1. **The sender is not signed in to BGScheduler in the browser Claude uses.** The page is a login screen, not JSON. The skill must notice this and ask the sender to sign in. This is pinned in SKILL.md step 1 and exercised in Task 5's dry run.
2. **Claude miscopies one of roughly 60 BCC addresses into `create_draft`.** The skill must read the draft back and compare it with the confirmed list. This is pinned in SKILL.md step 5 and exercised in Task 5.
3. **The CSV fallback brings a BOM and an apostrophe-prefixed name** (`'=…`). The skill must strip both. This is pinned in SKILL.md step 1. Task 2's route test asserts the exact bytes.
4. **The list is unavailable or empty**: no snapshot, a migration still pending, or nobody teaching. The skill must stop with the reason rather than create an empty draft. JSON passthrough is pinned in a Task 2 route test, and the stop is pinned in SKILL.md step 2.
5. **A person has two onsite Wise accounts with different emails.** The resolver sees only one onsite and one online email, so the first onsite account's address is used. A Task 1 test pins this behavior.

---

### Task 1: Current-tutor list builder and CSV

**Files:**
- Create: `src/lib/tutor-offboarding/current-tutors.ts`
- Modify: `src/lib/tutor-offboarding/workforce/csv.ts:18` (export `cell`)
- Test: `src/lib/tutor-offboarding/__tests__/current-tutors.test.ts`

**Interfaces:**
- Consumes: `OffboardingDashboardData`, `OffboardingPersonRow`, `OffboardingAccount`, `PersonSignals`, `OffboardingUnavailableReason` from `src/lib/tutor-offboarding/types.ts`; `resolvePostClassTutorRecipient(input: { primaryEmail?: string | null; onsiteEmail?: string | null; onlineEmail?: string | null }): { email: string | null; source: "primary" | "wise_fallback" | "missing" | "conflict" }`; `cell(value: unknown): string` from `./workforce/csv`.
- Produces:
  - `RECENT_TEACHING_DAYS = 30`
  - `interface TutorContactEmails { canonicalKey: string; primaryEmail: string | null; onsiteEmail: string | null; onlineEmail: string | null }`
  - `interface CurrentTutorRecipient { name: string; email: string; reason: "upcoming" | "recent" }`
  - `interface CurrentTutorList { generatedAt: string; snapshotCreatedAt: string; stale: boolean; recipients: CurrentTutorRecipient[]; needsEmail: Array<{ name: string; candidates: string[] }>; excludedConfirmed: Array<{ name: string }>; unmatchedSheetRows: number }`
  - `type CurrentTutorListResponse = ({ available: true } & CurrentTutorList) | { available: false; reason: OffboardingUnavailableReason }`
  - `buildCurrentTutorList(input: { dashboard: Pick<OffboardingDashboardData, "inbox" | "excluded" | "staff" | "freshness" | "snapshotCreatedAt" | "terminationSource">; contacts: TutorContactEmails[]; now: Date }): CurrentTutorList`
  - `currentTutorsCsv(list: CurrentTutorList): string`

- [ ] **Step 0: Prepare the worktree's dependencies**

The slot's `node_modules` may predate this branch's lockfile. From the main checkout:

Run: `cd /Users/kevinhsieh/Developer/Scheduling && scripts/dev/worktrees.sh deps slot-c`
Expected: it ends without an error (a copy-on-write clone, or `npm ci` when no checkout has this lockfile).

- [ ] **Step 1: Write the failing test**

Create `src/lib/tutor-offboarding/__tests__/current-tutors.test.ts`:

```ts
import { describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));
vi.mock("@/lib/db", () => ({ getDb: vi.fn() }));

import { buildCurrentTutorList, currentTutorsCsv, type TutorContactEmails } from "../current-tutors";
import type { OffboardingAccount, OffboardingPersonRow, PersonSignals } from "../types";

// Made-up people and @example.com addresses only: never real tutors.

const NOW = new Date("2026-10-12T05:00:00.000Z");
const DAY = 86_400_000;
const ago = (ms: number) => new Date(NOW.getTime() - ms).toISOString();

function account(key: string, overrides: Partial<OffboardingAccount> = {}): OffboardingAccount {
  return {
    wiseTeacherId: `t-${key}`, wiseUserId: `u-${key}`, displayName: key, isOnlineVariant: false,
    email: `${key.toLowerCase()}@example.com`, status: "active", relation: "TEACHER", joinedOn: null,
    courseCount: 1, activated: true, availabilityKnown: true, workingHourWindows: 1, ...overrides,
  };
}

function row(key: string, signals: Partial<PersonSignals> = {}, extra: Partial<OffboardingPersonRow> = {}): OffboardingPersonRow {
  return {
    signals: {
      canonicalKey: key, displayName: key, accounts: [account(key)], lastTaughtAt: null,
      lastTaughtBySource: { ledger: null, pastBlocks: null, postClass: null }, upcomingSessions: 0, nextSessionAt: null,
      upcomingLeaveUntil: null, lastTeacherActionAt: null, lastAdminActionAt: null, fullTime: false, ...signals,
    },
    score: {} as OffboardingPersonRow["score"],
    openDecision: null,
    ...extra,
  };
}

type Dashboard = Parameters<typeof buildCurrentTutorList>[0]["dashboard"];

function build(dashboard: Partial<Dashboard>, contacts: TutorContactEmails[] = []) {
  return buildCurrentTutorList({
    dashboard: {
      inbox: [], excluded: [], staff: [], snapshotCreatedAt: "2026-10-12T04:30:00.000Z",
      freshness: { ok: true, feeds: [] }, ...dashboard,
    },
    contacts,
    now: NOW,
  });
}

function contact(canonicalKey: string, emails: Partial<TutorContactEmails> = {}): TutorContactEmails {
  return { canonicalKey, primaryEmail: null, onsiteEmail: null, onlineEmail: null, ...emails };
}

describe("buildCurrentTutorList", () => {
  it("keeps people with an upcoming class or a class in the last 30 days", () => {
    const list = build({
      excluded: [row("Ana", { upcomingSessions: 2 })],
      inbox: [
        row("Ben", { lastTaughtAt: ago(30 * DAY) }),
        row("Cai", { lastTaughtAt: ago(30 * DAY + 1) }),
        row("Dee"),
      ],
    });
    expect(list.recipients).toEqual([
      { name: "Ana", email: "ana@example.com", reason: "upcoming" },
      { name: "Ben", email: "ben@example.com", reason: "recent" },
    ]);
    expect(list.needsEmail).toEqual([]);
    expect(list.excludedConfirmed).toEqual([]);
  });

  it("prefers the upcoming reason when both apply", () => {
    const list = build({ excluded: [row("Ana", { upcomingSessions: 1, lastTaughtAt: ago(DAY) })] });
    expect(list.recipients).toEqual([{ name: "Ana", email: "ana@example.com", reason: "upcoming" }]);
  });

  it("leaves out a confirmed departure even while they still teach", () => {
    const termination = { sourceRow: 4, sourceName: "Eve", checkedAt: ago(DAY), sourceUrl: "https://example.com/sheet", match: "email" as const };
    const list = build({ inbox: [row("Eve", { upcomingSessions: 3 }, { termination })] });
    expect(list.recipients).toEqual([]);
    expect(list.excludedConfirmed).toEqual([{ name: "Eve" }]);
  });

  it("uses the primary override, then one shared Wise email", () => {
    const list = build({
      excluded: [
        row("Fay", { upcomingSessions: 1 }),
        row("Gus", {
          upcomingSessions: 1,
          accounts: [account("Gus", { email: "gus@example.com" }), account("Gus-on", { isOnlineVariant: true, email: "GUS@example.com" })],
        }),
      ],
    }, [contact("Fay", { primaryEmail: " Fay.Primary@Example.com ", onsiteEmail: "fay@example.com" })]);
    expect(list.recipients).toEqual([
      { name: "Fay", email: "fay.primary@example.com", reason: "upcoming" },
      { name: "Gus", email: "gus@example.com", reason: "upcoming" },
    ]);
  });

  it("never guesses between two different Wise emails or a missing one", () => {
    const list = build({
      excluded: [
        row("Hal", {
          upcomingSessions: 1,
          accounts: [account("Hal", { email: "hal@example.com" }), account("Hal-on", { isOnlineVariant: true, email: "hal.online@example.com" })],
        }),
        row("Ivy", { upcomingSessions: 1, accounts: [account("Ivy", { email: null })] }),
      ],
    });
    expect(list.recipients).toEqual([]);
    expect(list.needsEmail).toEqual([
      { name: "Hal", candidates: ["hal@example.com", "hal.online@example.com"] },
      { name: "Ivy", candidates: [] },
    ]);
  });

  it("falls back to account emails when the contact row has none", () => {
    const list = build({ excluded: [row("Jon", { upcomingSessions: 1 })] }, [contact("Jon")]);
    expect(list.recipients).toEqual([{ name: "Jon", email: "jon@example.com", reason: "upcoming" }]);
  });

  it("uses the first onsite account when a person has two onsite emails", () => {
    const list = build({
      excluded: [row("Kai", {
        upcomingSessions: 1,
        accounts: [account("Kai", { email: "kai.first@example.com" }), account("Kai-2", { email: "kai.second@example.com" })],
      })],
    });
    expect(list.recipients).toEqual([{ name: "Kai", email: "kai.first@example.com", reason: "upcoming" }]);
  });

  it("keeps one recipient per address and sorts by name", () => {
    const list = build({
      inbox: [row("Zed", { lastTaughtAt: ago(DAY), accounts: [account("Zed", { email: "shared@example.com" })] })],
      excluded: [
        row("Amy", { upcomingSessions: 1, accounts: [account("Amy", { email: "shared@example.com" })] }),
        row("Bob", { upcomingSessions: 1 }),
      ],
    });
    expect(list.recipients).toEqual([
      { name: "Bob", email: "bob@example.com", reason: "upcoming" },
      { name: "Zed", email: "shared@example.com", reason: "recent" },
    ]);
  });

  it("counts a person once across the review list, exclusions and staff, including teaching staff", () => {
    const list = build({
      excluded: [row("Lia", { upcomingSessions: 1 })],
      staff: [row("Lia", { upcomingSessions: 1 }), row("Max", { lastTaughtAt: ago(2 * DAY) })],
    });
    expect(list.recipients.map((r) => r.name)).toEqual(["Lia", "Max"]);
  });

  it("reports freshness, sheet review counts and timestamps", () => {
    const list = build({
      freshness: { ok: false, feeds: [] },
      terminationSource: {
        status: "ready", checkedAt: ago(DAY), sourceUrl: "https://example.com/sheet", confirmedRows: 5, matchedPeople: 2,
        unmatched: [1, 2, 3].map((n) => ({ sourceRow: n, sourceName: `Row ${n}`, reason: "no_match" })),
      },
    });
    expect(list).toMatchObject({
      generatedAt: "2026-10-12T05:00:00.000Z",
      snapshotCreatedAt: "2026-10-12T04:30:00.000Z",
      stale: true,
      unmatchedSheetRows: 3,
    });
    expect(build({}).unmatchedSheetRows).toBe(0);
  });
});

describe("currentTutorsCsv", () => {
  it("writes recipients only, with a BOM, escaped quotes and defused formulas", () => {
    const csv = currentTutorsCsv({
      generatedAt: "2026-10-12T05:00:00.000Z", snapshotCreatedAt: "2026-10-12T04:30:00.000Z", stale: false,
      recipients: [
        { name: 'Ana "A" Lee', email: "ana@example.com", reason: "upcoming" },
        { name: "=SUM(1)", email: "sum@example.com", reason: "recent" },
      ],
      needsEmail: [{ name: "Hal", candidates: [] }], excludedConfirmed: [{ name: "Eve" }], unmatchedSheetRows: 0,
    });
    expect(csv).toBe(
      '\uFEFF"name","email","reason"\r\n"Ana ""A"" Lee","ana@example.com","upcoming"\r\n"\'=SUM(1)","sum@example.com","recent"',
    );
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `npx vitest run --project unit src/lib/tutor-offboarding/__tests__/current-tutors.test.ts`
Expected: FAIL. The module `../current-tutors` cannot be resolved.

- [ ] **Step 3: Export the shared CSV cell helper**

In `src/lib/tutor-offboarding/workforce/csv.ts`, replace line 18:

```ts
function cell(value: unknown): string {
```

with:

```ts
/** Quotes one CSV cell and defuses formula-leading text. Shared with the current-tutor export. */
export function cell(value: unknown): string {
```

- [ ] **Step 4: Write the implementation**

Create `src/lib/tutor-offboarding/current-tutors.ts`:

```ts
import { resolvePostClassTutorRecipient } from "@/lib/post-class-feedback/notifications";
import { cell } from "./workforce/csv";
import type { OffboardingDashboardData, OffboardingUnavailableReason } from "./types";

// ----------------------------------------------------------------------------
// Current tutors: everyone teaching now, for the email-current-tutors team skill. Read-only; the skill only
// drafts a Gmail message and a person sends it.
// ----------------------------------------------------------------------------

/** A taught class within this many days counts as teaching now (owner decision 2026-10-12). */
export const RECENT_TEACHING_DAYS = 30;

export interface TutorContactEmails {
  canonicalKey: string;
  primaryEmail: string | null;
  onsiteEmail: string | null;
  onlineEmail: string | null;
}

export interface CurrentTutorRecipient {
  name: string;
  email: string;
  reason: "upcoming" | "recent";
}

export interface CurrentTutorList {
  generatedAt: string;
  snapshotCreatedAt: string;
  stale: boolean;
  recipients: CurrentTutorRecipient[];
  needsEmail: Array<{ name: string; candidates: string[] }>;
  excludedConfirmed: Array<{ name: string }>;
  unmatchedSheetRows: number;
}

export type CurrentTutorListResponse =
  | ({ available: true } & CurrentTutorList)
  | { available: false; reason: OffboardingUnavailableReason };

type DashboardInput = Pick<
  OffboardingDashboardData,
  "inbox" | "excluded" | "staff" | "freshness" | "snapshotCreatedAt" | "terminationSource"
>;

const byName = (a: { name: string }, b: { name: string }) => a.name.localeCompare(b.name);

function validEmail(value: string | null | undefined): string | null {
  const email = value?.trim().toLowerCase() ?? "";
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email) ? email : null;
}

/**
 * The tutors teaching now:
 * 1. Each person (canonicalKey) once, across the review list, exclusions and staff accounts.
 * 2. A matched strike-through sheet row (OFF-15) leaves the person out, even while they still teach.
 * 3. Current = an upcoming class, or a taught class in the last RECENT_TEACHING_DAYS ("upcoming" wins).
 * 4. Email = the post-class rule: the primary override, else one distinct Wise email (contact row first, then the
 *    first onsite/online account). A conflict or a gap goes to needsEmail, never guessed.
 * 5. One recipient per address (the first person wins), sorted by name.
 */
export function buildCurrentTutorList(input: {
  dashboard: DashboardInput;
  contacts: TutorContactEmails[];
  now: Date;
}): CurrentTutorList {
  const { dashboard, now } = input;
  const contacts = new Map(input.contacts.map((contact) => [contact.canonicalKey, contact]));
  const recentSince = now.getTime() - RECENT_TEACHING_DAYS * 86_400_000;
  const seenPeople = new Set<string>();
  const seenEmails = new Set<string>();
  const recipients: CurrentTutorRecipient[] = [];
  const needsEmail: CurrentTutorList["needsEmail"] = [];
  const excludedConfirmed: CurrentTutorList["excludedConfirmed"] = [];

  for (const row of [...dashboard.inbox, ...dashboard.excluded, ...dashboard.staff]) {
    const { canonicalKey, displayName: name, accounts, upcomingSessions, lastTaughtAt } = row.signals;
    if (seenPeople.has(canonicalKey)) continue;
    seenPeople.add(canonicalKey);
    if (row.termination) {
      excludedConfirmed.push({ name });
      continue;
    }
    const reason = upcomingSessions > 0 ? "upcoming"
      : lastTaughtAt !== null && Date.parse(lastTaughtAt) >= recentSince ? "recent"
        : null;
    if (!reason) continue;

    const contact = contacts.get(canonicalKey);
    const onsiteEmail = validEmail(contact?.onsiteEmail)
      ?? validEmail(accounts.find((account) => !account.isOnlineVariant && validEmail(account.email))?.email);
    const onlineEmail = validEmail(contact?.onlineEmail)
      ?? validEmail(accounts.find((account) => account.isOnlineVariant && validEmail(account.email))?.email);
    const { email } = resolvePostClassTutorRecipient({ primaryEmail: contact?.primaryEmail, onsiteEmail, onlineEmail });
    if (!email) {
      const candidates = [onsiteEmail, onlineEmail, ...accounts.map((account) => validEmail(account.email))]
        .filter((value): value is string => value !== null);
      needsEmail.push({ name, candidates: [...new Set(candidates)] });
      continue;
    }
    if (seenEmails.has(email)) continue;
    seenEmails.add(email);
    recipients.push({ name, email, reason });
  }

  return {
    generatedAt: now.toISOString(),
    snapshotCreatedAt: dashboard.snapshotCreatedAt,
    stale: !dashboard.freshness.ok,
    recipients: recipients.sort(byName),
    needsEmail: needsEmail.sort(byName),
    excludedConfirmed: excludedConfirmed.sort(byName),
    unmatchedSheetRows: dashboard.terminationSource?.unmatched.length ?? 0,
  };
}

/** Recipients only, as UTF-8 with a BOM; formula-leading text is defused by the workforce export's `cell`. */
export function currentTutorsCsv(list: CurrentTutorList): string {
  const rows = [["name", "email", "reason"], ...list.recipients.map((r) => [r.name, r.email, r.reason])];
  return `\uFEFF${rows.map((values) => values.map(cell).join(",")).join("\r\n")}`;
}
```

Check the Hal case against this implementation: Hal has onsite `hal@example.com` and online `hal.online@example.com`, so the resolver returns a conflict. The candidates are `[hal@, hal.online@, hal@, hal.online@]`, deduped to `["hal@example.com", "hal.online@example.com"]`, which matches the test.

- [ ] **Step 5: Run the tests to verify they pass**

Run: `npx vitest run --project unit src/lib/tutor-offboarding/__tests__/current-tutors.test.ts src/lib/tutor-offboarding/workforce`
Expected: PASS for every test in the new file. The existing workforce tests still pass with `cell` now exported.

- [ ] **Step 6: Commit**

```bash
git add src/lib/tutor-offboarding/current-tutors.ts src/lib/tutor-offboarding/__tests__/current-tutors.test.ts src/lib/tutor-offboarding/workforce/csv.ts
git commit -m "feat(tutor-offboarding): build the list of tutors teaching now

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 2: Loader and `GET /api/tutor-offboarding/current-tutors`

**Files:**
- Modify: `src/lib/tutor-offboarding/service.ts` (imports and a new `loadCurrentTutorList`)
- Create: `src/app/api/tutor-offboarding/current-tutors/route.ts`
- Test: `src/lib/tutor-offboarding/__tests__/service.test.ts` (append a `describe`)
- Test: `src/app/api/tutor-offboarding/current-tutors/__tests__/route.test.ts`

**Interfaces:**
- Consumes: `buildCurrentTutorList`, `currentTutorsCsv`, `CurrentTutorListResponse` (Task 1); `loadTutorOffboardingDashboard(viewer: TutorOffboardingViewer): Promise<OffboardingDashboard>`; `requireTutorOffboardingAdmin(): Promise<TutorOffboardingViewer>`; `tutorOffboardingErrorResponse(route: string, error: unknown, fallback: string): NextResponse`; `TutorOffboardingError(message: string, status: number)`; `bangkokDateKey(date: Date): string` from `@/lib/room-capacity/dates`.
- Produces: `loadCurrentTutorList(viewer: TutorOffboardingViewer, now?: Date, db?: Database): Promise<CurrentTutorListResponse>`; the HTTP route `GET /api/tutor-offboarding/current-tutors[?format=csv]`.

- [ ] **Step 1: Write the failing service test**

Append to `src/lib/tutor-offboarding/__tests__/service.test.ts`. Keep its existing mocks and `beforeEach`. Change the import line `import { loadTutorOffboardingDashboard } from "../service";` to:

```ts
import { loadCurrentTutorList, loadTutorOffboardingDashboard } from "../service";
```

Then add at the end of the file:

```ts
describe("loadCurrentTutorList", () => {
  it("passes unavailability through without reading contacts", async () => {
    vi.mocked(loadFeedTimestamps).mockResolvedValue({ tutorSnapshot: null, progressTests: NOW, postClass: NOW, wiseActivity: NOW, leaveRequests: NOW });
    const select = vi.fn();
    expect(await loadCurrentTutorList(viewer, new Date(NOW), { select } as never)).toEqual({ available: false, reason: "no_snapshot" });
    expect(select).not.toHaveBeenCalled();
  });

  it("builds the list from the dashboard rows and tutor contacts", async () => {
    vi.mocked(loadOffboardingSignals).mockResolvedValue({
      ...signals(),
      people: [{
        canonicalKey: "Ana", displayName: "Ana",
        accounts: [{
          wiseTeacherId: "t-ana", wiseUserId: "u-ana", displayName: "Ana", isOnlineVariant: false, email: "ana@example.com",
          status: "active", relation: "TEACHER", joinedOn: "2026-01-20T00:00:00.000Z", courseCount: 1, activated: true,
          availabilityKnown: true, workingHourWindows: 2,
        }],
        lastTaughtAt: "2026-09-29T05:00:00.000Z",
        lastTaughtBySource: { ledger: "2026-09-29T05:00:00.000Z", pastBlocks: null, postClass: null },
        upcomingSessions: 2, nextSessionAt: "2026-10-03T05:00:00.000Z", upcomingLeaveUntil: null,
        lastTeacherActionAt: null, lastAdminActionAt: null, fullTime: false,
      }],
    });
    const from = vi.fn().mockResolvedValue([{ canonicalKey: "Ana", primaryEmail: "ana.primary@example.com", onsiteEmail: null, onlineEmail: null }]);
    const result = await loadCurrentTutorList(viewer, new Date(NOW), { select: vi.fn(() => ({ from })) } as never);
    expect(result).toMatchObject({
      available: true,
      recipients: [{ name: "Ana", email: "ana.primary@example.com", reason: "upcoming" }],
      needsEmail: [],
      excludedConfirmed: [],
    });
  });
});
```

- [ ] **Step 2: Run it to verify it fails**

Run: `npx vitest run --project unit src/lib/tutor-offboarding/__tests__/service.test.ts`
Expected: FAIL. `loadCurrentTutorList` is not exported (`is not a function`).

- [ ] **Step 3: Implement the loader**

In `src/lib/tutor-offboarding/service.ts`:

Replace `import { getDb } from "@/lib/db";` with:

```ts
import { getDb, type Database } from "@/lib/db";
import * as schema from "@/lib/db/schema";
```

Add next to the other `./` imports:

```ts
import { buildCurrentTutorList, type CurrentTutorListResponse } from "./current-tutors";
```

Append at the end of the file:

```ts
/** Tutors teaching now (an upcoming class or a class in the last 30 days), for the email-current-tutors skill. Read-only. */
export async function loadCurrentTutorList(
  viewer: TutorOffboardingViewer,
  now: Date = new Date(),
  db: Database = getDb(),
): Promise<CurrentTutorListResponse> {
  // The owner-only grant list is not needed here.
  const dashboard = await loadTutorOffboardingDashboard({ ...viewer, isOwner: false });
  if (!dashboard.available) return { available: false, reason: dashboard.reason };
  const contacts = await db.select({
    canonicalKey: schema.tutorContacts.canonicalKey,
    primaryEmail: schema.tutorContacts.primaryEmail,
    onsiteEmail: schema.tutorContacts.onsiteEmail,
    onlineEmail: schema.tutorContacts.onlineEmail,
  }).from(schema.tutorContacts);
  return { available: true, ...buildCurrentTutorList({ dashboard, contacts, now }) };
}
```

- [ ] **Step 4: Run the service tests to verify they pass**

Run: `npx vitest run --project unit src/lib/tutor-offboarding/__tests__/service.test.ts`
Expected: PASS for all tests, both the existing ones and the two new ones.

- [ ] **Step 5: Write the failing route test**

Create `src/app/api/tutor-offboarding/current-tutors/__tests__/route.test.ts`:

```ts
import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));
vi.mock("@/lib/auth", () => ({ auth: vi.fn() }));
vi.mock("@/lib/db", () => ({ getDb: vi.fn(() => ({})) }));
vi.mock("@/lib/tutor-offboarding/grants", async (importOriginal) => ({
  ...await importOriginal<typeof import("@/lib/tutor-offboarding/grants")>(),
  hasRemovalGrant: vi.fn(async () => false),
}));
vi.mock("@/lib/tutor-offboarding/service", () => ({ loadCurrentTutorList: vi.fn() }));

import { auth } from "@/lib/auth";
import { loadCurrentTutorList } from "@/lib/tutor-offboarding/service";
import { GET } from "../route";

// Made-up people and @example.com addresses only: never real tutors.

const authMock = vi.mocked(auth as unknown as () => Promise<unknown>);
const listMock = vi.mocked(loadCurrentTutorList);
const BASE = "http://localhost/api/tutor-offboarding/current-tutors";
const LIST = {
  available: true as const,
  generatedAt: "2026-10-12T05:00:00.000Z",
  snapshotCreatedAt: "2026-10-12T04:30:00.000Z",
  stale: false,
  recipients: [
    { name: 'Ana "A" Lee', email: "ana@example.com", reason: "upcoming" as const },
    { name: "=SUM(1)", email: "sum@example.com", reason: "recent" as const },
  ],
  needsEmail: [],
  excludedConfirmed: [],
  unmatchedSheetRows: 0,
};

async function bytes(response: Response): Promise<string> {
  // Response.text() strips a leading BOM; decode the raw bytes to see exactly what is downloaded.
  return new TextDecoder("utf-8", { ignoreBOM: true }).decode(await response.arrayBuffer());
}

beforeEach(() => {
  vi.clearAllMocks();
  authMock.mockResolvedValue({ user: { email: "admin@example.com", role: "admin" } });
  listMock.mockResolvedValue(LIST);
});

describe("GET /api/tutor-offboarding/current-tutors", () => {
  it("requires an admin session", async () => {
    authMock.mockResolvedValueOnce(null);
    expect((await GET(new Request(BASE))).status).toBe(401);
    authMock.mockResolvedValueOnce({ user: { email: "parent@example.com", role: "parent" } });
    const forbidden = await GET(new Request(BASE));
    expect(forbidden.status).toBe(403);
    expect(forbidden.headers.get("Cache-Control")).toBe("private, no-store");
    expect(listMock).not.toHaveBeenCalled();
  });

  it("returns the JSON list, never cached", async () => {
    const response = await GET(new Request(BASE));
    expect(response.status).toBe(200);
    expect(response.headers.get("Cache-Control")).toBe("private, no-store");
    expect(await response.json()).toEqual(LIST);
    expect(listMock).toHaveBeenCalledWith(expect.objectContaining({ email: "admin@example.com" }));
  });

  it("passes an unavailable list through as JSON", async () => {
    listMock.mockResolvedValueOnce({ available: false, reason: "no_snapshot" });
    const response = await GET(new Request(BASE));
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ available: false, reason: "no_snapshot" });
  });

  it("downloads recipients as an escaped CSV named for the Bangkok date", async () => {
    const response = await GET(new Request(`${BASE}?format=csv`));
    expect(response.status).toBe(200);
    expect(response.headers.get("Content-Type")).toBe("text/csv; charset=utf-8");
    expect(response.headers.get("Content-Disposition")).toBe('attachment; filename="current-tutors-2026-10-12.csv"');
    expect(response.headers.get("Cache-Control")).toBe("private, no-store");
    expect(await bytes(response)).toBe(
      '\uFEFF"name","email","reason"\r\n"Ana ""A"" Lee","ana@example.com","upcoming"\r\n"\'=SUM(1)","sum@example.com","recent"',
    );
  });

  it("refuses a CSV when the list is unavailable", async () => {
    listMock.mockResolvedValueOnce({ available: false, reason: "not_set_up" });
    const response = await GET(new Request(`${BASE}?format=csv`));
    expect(response.status).toBe(503);
    expect(await response.json()).toEqual({ error: "The tutor list is unavailable (not_set_up)." });
  });

  it("rejects any other query", async () => {
    for (const query of ["?format=json", "?format=csv&format=csv", "?x=1"]) {
      const response = await GET(new Request(`${BASE}${query}`));
      expect(response.status).toBe(400);
      expect(response.headers.get("Cache-Control")).toBe("private, no-store");
    }
    expect(listMock).not.toHaveBeenCalled();
  });

  it("never serializes an unexpected error", async () => {
    listMock.mockRejectedValueOnce(new Error("select … ana@example.com"));
    const log = vi.spyOn(console, "error").mockImplementation(() => undefined);
    const response = await GET(new Request(BASE));
    expect(response.status).toBe(500);
    expect(await response.json()).toEqual({ error: "The current tutor list could not load." });
    log.mockRestore();
  });
});
```

- [ ] **Step 6: Run it to verify it fails**

Run: `npx vitest run --project unit src/app/api/tutor-offboarding/current-tutors`
Expected: FAIL. `../route` cannot be resolved.

- [ ] **Step 7: Write the route**

Create `src/app/api/tutor-offboarding/current-tutors/route.ts`:

```ts
import { NextResponse } from "next/server";
import { bangkokDateKey } from "@/lib/room-capacity/dates";
import { requireTutorOffboardingAdmin } from "@/lib/tutor-offboarding/access";
import { tutorOffboardingErrorResponse } from "@/lib/tutor-offboarding/api";
import { currentTutorsCsv } from "@/lib/tutor-offboarding/current-tutors";
import { TutorOffboardingError } from "@/lib/tutor-offboarding/errors";
import { loadCurrentTutorList } from "@/lib/tutor-offboarding/service";

/** Read-only list of tutors teaching now, for the email-current-tutors team skill; `?format=csv` downloads recipients. */
export async function GET(request: Request) {
  let response: Response;
  try {
    const viewer = await requireTutorOffboardingAdmin();
    const query = new URL(request.url).searchParams.toString();
    const csv = query === "format=csv";
    if (query && !csv) throw new TutorOffboardingError("The only supported query is ?format=csv.", 400);
    const list = await loadCurrentTutorList(viewer);
    if (!csv) {
      response = NextResponse.json(list);
    } else if (!list.available) {
      throw new TutorOffboardingError(`The tutor list is unavailable (${list.reason}).`, 503);
    } else {
      response = new Response(currentTutorsCsv(list), {
        headers: {
          "Content-Type": "text/csv; charset=utf-8",
          "Content-Disposition": `attachment; filename="current-tutors-${bangkokDateKey(new Date(list.generatedAt))}.csv"`,
          "X-Content-Type-Options": "nosniff",
        },
      });
    }
  } catch (error) {
    response = tutorOffboardingErrorResponse("[tutor-offboarding] current tutors failed", error, "The current tutor list could not load.");
  }
  response.headers.set("Cache-Control", "private, no-store");
  return response;
}
```

- [ ] **Step 8: Run the route, service and offboarding tests, then typecheck**

Run: `npx vitest run --project unit src/app/api/tutor-offboarding src/lib/tutor-offboarding`
Expected: PASS (the new route tests plus every existing offboarding test).

Run: `npm run typecheck`
Expected: exits 0.

- [ ] **Step 9: Commit**

```bash
git add src/lib/tutor-offboarding/service.ts src/lib/tutor-offboarding/__tests__/service.test.ts src/app/api/tutor-offboarding/current-tutors
git commit -m "feat(tutor-offboarding): read-only current tutors endpoint with CSV download

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 3: Bundled renderer and `build-email.mjs`

**Files:**
- Create (verbatim copies): `.claude/skills/email-current-tutors/renderer/company.mjs`, `renderer/company-render.mjs`, `renderer/render.mjs`, `renderer/LICENSE-colorlib-MIT.txt`
- Create: `.claude/skills/email-current-tutors/renderer/NOTICE.md`
- Create: `.claude/skills/email-current-tutors/build-email.mjs`
- Test: `.claude/skills/email-current-tutors/build-email.test.mjs`

**Interfaces:**
- Consumes: `buildCompanyEmail(input)` from `renderer/company.mjs`. It returns `{ subject, html, text }` and throws `"<field> is required"`, `"eventDetails is required"` or `"Email links must use HTTP or HTTPS"`.
- Produces: the CLI `node .claude/skills/email-current-tutors/build-email.mjs <spec.json> --out <dir>`. It writes `<dir>/email.html`, `email.txt` and `subject.txt`. It exits 0 on success, 1 with `Could not build the email: <reason>` on stderr for a bad spec, and 2 with the usage text for bad arguments.

- [ ] **Step 1: Copy the renderer and licence verbatim**

```bash
SRC=~/.claude/skills/begifted-design
DEST=.claude/skills/email-current-tutors/renderer
mkdir -p "$DEST"
cp "$SRC/emails/runtime/company.mjs" "$SRC/emails/runtime/company-render.mjs" "$SRC/emails/runtime/render.mjs" "$DEST/"
cp "$SRC/assets/notices/colorlib-email-templates/LICENSE-MIT" "$DEST/LICENSE-colorlib-MIT.txt"
grep -h "^import" "$DEST"/*.mjs
```

Expected: the only import line printed is `import { escapeEmailHtml } from "./render.mjs";` plus `import { renderCompanyEmail, companyEmailUrl } from "./company-render.mjs";`, so there are no external dependencies.

- [ ] **Step 2: Write `renderer/NOTICE.md`**

```markdown
# Bundled BeGifted email renderer

`company.mjs`, `company-render.mjs` and `render.mjs` are unmodified copies of the `begifted-design` skill's
`emails/runtime/` modules, release **3.2.0** (`assets/release.json`). Do not edit them here. To upgrade, copy the
three files again from a newer `begifted-design` release and rerun `node --test .claude/skills/email-current-tutors/build-email.test.mjs`.

The company templates adapt layouts from Colorlib's email templates. Their licence is reproduced in
`LICENSE-colorlib-MIT.txt`. No upstream images, fonts or copy are bundled.
```

- [ ] **Step 3: Write the failing test**

Create `.claude/skills/email-current-tutors/build-email.test.mjs`:

```js
// Self-check for build-email.mjs. Run: node --test .claude/skills/email-current-tutors/build-email.test.mjs
import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const SCRIPT = fileURLToPath(new URL("./build-email.mjs", import.meta.url));
const BASE = {
  template: "newsletter",
  subject: "[BeGifted] Term dates",
  preheader: "Key dates for next term",
  title: "Next term at a glance",
  paragraphs: ["Classes resume on <b>3 Nov</b>."],
};

function run(spec, args) {
  const dir = mkdtempSync(path.join(tmpdir(), "email-current-tutors-test-"));
  const specPath = path.join(dir, "spec.json");
  writeFileSync(specPath, JSON.stringify(spec));
  const out = path.join(dir, "out");
  const result = spawnSync(process.execPath, [SCRIPT, ...(args ?? [specPath, "--out", out])], { encoding: "utf8" });
  return { ...result, out };
}

test("renders the branded HTML, plain text and subject", () => {
  const result = run(BASE);
  assert.equal(result.status, 0, result.stderr);
  const html = readFileSync(path.join(result.out, "email.html"), "utf8");
  assert.match(html, /https:\/\/bgscheduler\.vercel\.app\/brand\/email\/v3\/logo-horizontal\.png/);
  assert.match(html, /Next term at a glance/);
  assert.match(html, /&lt;b&gt;3 Nov&lt;\/b&gt;/, "supplied text is escaped, never raw HTML");
  assert.match(readFileSync(path.join(result.out, "email.txt"), "utf8"), /Classes resume on <b>3 Nov<\/b>\./);
  assert.equal(readFileSync(path.join(result.out, "subject.txt"), "utf8"), "[BeGifted] Term dates");
});

test("renders an event with its details", () => {
  const result = run({ ...BASE, template: "event", eventDetails: [{ label: "Date", value: "Sat 8 Nov, 10:00" }] });
  assert.equal(result.status, 0, result.stderr);
  assert.match(readFileSync(path.join(result.out, "email.txt"), "utf8"), /Sat 8 Nov, 10:00/);
});

test("rejects specs the skill must not send", () => {
  const cases = [
    [{ ...BASE, photo: { url: "https://example.com/a.png" } }, /Unknown spec keys: photo/],
    [{ ...BASE, template: "receipt" }, /template must be one of: newsletter, programme, event/],
    [{ ...BASE, paragraphs: [] }, /paragraphs must be a non-empty list of text/],
    [{ ...BASE, preheader: "" }, /preheader is required/],
    [{ ...BASE, template: "event" }, /eventDetails is required/],
    [{ ...BASE, action: { label: "Go", url: "javascript:alert(1)" } }, /Email links must use HTTP or HTTPS/],
  ];
  for (const [spec, message] of cases) {
    const result = run(spec);
    assert.equal(result.status, 1, `expected a failure for ${JSON.stringify(spec)}`);
    assert.match(result.stderr, /^Could not build the email: /);
    assert.match(result.stderr, message);
  }
});

test("prints usage for bad arguments", () => {
  const result = run(BASE, ["only-one-arg.json"]);
  assert.equal(result.status, 2);
  assert.match(result.stderr, /Usage: node build-email\.mjs <spec\.json> --out <dir>/);
});
```

- [ ] **Step 4: Run it to verify it fails**

Run: `node --test .claude/skills/email-current-tutors/build-email.test.mjs`
Expected: FAIL. Every test fails because `build-email.mjs` does not exist (`Cannot find module` in stderr, non-zero status).

- [ ] **Step 5: Write `build-email.mjs`**

Create `.claude/skills/email-current-tutors/build-email.mjs`:

```js
#!/usr/bin/env node
// Renders a BeGifted v3 company email from a JSON spec for the email-current-tutors skill.
// Usage: node build-email.mjs <spec.json> --out <dir>   → <dir>/email.html, email.txt, subject.txt
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { buildCompanyEmail } from "./renderer/company.mjs";

const LOGO_URL = "https://bgscheduler.vercel.app/brand/email/v3/logo-horizontal.png";
const TEMPLATES = ["newsletter", "programme", "event"];
const KEYS = new Set([
  "template", "subject", "preheader", "title", "subtitle", "greeting", "paragraphs",
  "sections", "action", "eventDetails", "programmeDetails",
]);

function render(spec) {
  if (!spec || typeof spec !== "object" || Array.isArray(spec)) throw new Error("The spec must be a JSON object.");
  const unknown = Object.keys(spec).filter((key) => !KEYS.has(key));
  if (unknown.length) throw new Error(`Unknown spec keys: ${unknown.join(", ")}`);
  if (!TEMPLATES.includes(spec.template)) throw new Error(`template must be one of: ${TEMPLATES.join(", ")}`);
  if (!Array.isArray(spec.paragraphs) || !spec.paragraphs.length
    || spec.paragraphs.some((paragraph) => typeof paragraph !== "string" || !paragraph.trim())) {
    throw new Error("paragraphs must be a non-empty list of text.");
  }
  // The renderer escapes every string, checks the logo and links, and supplies the standard BeGifted footer.
  return buildCompanyEmail({ ...spec, logoUrl: LOGO_URL });
}

const [specPath, flag, outDir] = process.argv.slice(2);
if (!specPath || flag !== "--out" || !outDir) {
  console.error("Usage: node build-email.mjs <spec.json> --out <dir>");
  process.exit(2);
}
try {
  const email = render(JSON.parse(readFileSync(specPath, "utf8")));
  mkdirSync(outDir, { recursive: true });
  writeFileSync(path.join(outDir, "email.html"), email.html);
  writeFileSync(path.join(outDir, "email.txt"), email.text);
  writeFileSync(path.join(outDir, "subject.txt"), email.subject);
  console.log(`Wrote email.html, email.txt and subject.txt to ${path.resolve(outDir)}`);
} catch (error) {
  console.error(`Could not build the email: ${error instanceof Error ? error.message : String(error)}`);
  process.exit(1);
}
```

- [ ] **Step 6: Run the tests to verify they pass**

Run: `node --test .claude/skills/email-current-tutors/build-email.test.mjs`
Expected: PASS, 4 tests, 0 failures.

Confirm that Vitest and ESLint ignore the folder's `.test.mjs`. The unit project globs `src/**`. ESLint may lint it as plain JS, so run it:

Run: `npx eslint .claude/skills/email-current-tutors`
Expected: no errors. If ESLint reports rules on the verbatim renderer copies (for example `no-unused-vars` in generated code), do not edit those files. Add the folder `".claude/skills/email-current-tutors/renderer/**"` to `globalIgnores` in `eslint.config.mjs` instead.

- [ ] **Step 7: Commit**

```bash
git add .claude/skills/email-current-tutors/renderer .claude/skills/email-current-tutors/build-email.mjs .claude/skills/email-current-tutors/build-email.test.mjs
git commit -m "feat(skills): bundled BeGifted email renderer and build script for email-current-tutors

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

(Also `git add eslint.config.mjs` if Step 6 needed the ignore.)

---

### Task 4: `SKILL.md` and documentation

**Files:**
- Create: `.claude/skills/email-current-tutors/SKILL.md`
- Modify: `docs/reference/api/tutor-offboarding.md` (endpoint table)
- Modify: `docs/features/tutor-offboarding.md` (new section before `## Page and access`)

**Interfaces:**
- Consumes: the endpoint contract (Task 2) and the CLI contract (Task 3).
- Produces: the `/email-current-tutors` skill.

- [ ] **Step 1: Write `SKILL.md`**

Create `.claude/skills/email-current-tutors/SKILL.md` with exactly this content:

````markdown
---
name: email-current-tutors
description: Draft a BeGifted-branded email to every tutor who is teaching now (an upcoming class, or a class in the last 30 days) as a Gmail draft with the tutors in BCC. Use when staff ask to email, announce or send an update to all current tutors or teachers. Only drafts; a person sends it from Gmail.
---

# Email current tutors

Build a BeGifted email (v3 company design) for every tutor who is teaching now and leave it as a **draft** in the
sender's Gmail. You never send it: the sender reviews the draft in Gmail and presses Send.

This folder (`.claude/skills/email-current-tutors/`) holds `build-email.mjs` and the bundled `renderer/`. Run
commands from the repository root.

## Hard rules

- Never call a tool that sends email (`send_message`, `reply`, `forward` or similar). Only create or update drafts.
- Tutors go in **BCC only**, never To or CC.
- Stop if there are more than 450 recipients (Gmail allows 500 per message).
- Keep the recipient list out of the repository, commits, uploads and other chats. Put working files in a new
  folder under the OS temp directory (`node -e "console.log(require('os').tmpdir())"`).
- Use only facts the sender gives you. Ask for any missing date, time, link or policy detail; never invent one.
- Write the email in English.

## 1. Get the list

The list comes from BGScheduler: `https://bgscheduler.vercel.app/api/tutor-offboarding/current-tutors`. The
sender must be signed in to BGScheduler with access to Tutor Offboarding.

- **A browser tool is available** (the desktop app's built-in browser, or Claude in Chrome): open that URL and read
  the page text. It is JSON. If you see a sign-in page or any HTML instead, ask the sender to sign in to
  BGScheduler in that browser, then reload.
- **No browser tool**: ask the sender to open
  `https://bgscheduler.vercel.app/api/tutor-offboarding/current-tutors?format=csv` in their own browser and tell
  you the downloaded file's path. The file is UTF-8 with a BOM and has the columns `name,email,reason`. Drop the
  BOM. A name that starts with `'` had that apostrophe added to defuse spreadsheet formulas, so drop it too. The
  CSV holds recipients only; if the sender wants the review lists below, they can open the JSON URL.

JSON fields:
- `recipients`: `name`, `email`, `reason` (`upcoming` = has a future class; `recent` = taught in the last 30 days).
- `needsEmail`: people teaching now whose address is unknown or ambiguous, with `candidates`.
- `excludedConfirmed`: crossed out in the tutor sheet, left out on purpose.
- `stale`, `unmatchedSheetRows`, `snapshotCreatedAt`.

`{ "available": false, "reason": … }` means BGScheduler has no list right now. Stop and tell the sender the reason.

## 2. Confirm the recipients

Show the sender, in this order:
1. "N tutors will be BCC'd", with their names in a compact list.
2. Each `needsEmail` person with the candidate addresses. The sender picks one, types one, or skips the person.
3. The `excludedConfirmed` names: "crossed out in the tutor sheet, not included".
4. Warnings:
   - `stale: true`: "BGScheduler's data is older than usual (snapshot at <snapshotCreatedAt>)."
   - `unmatchedSheetRows > 0`: "N crossed-out rows in the tutor sheet could not be matched to a tutor. Check
     Tutor Offboarding if one of them might still be on this list."

The sender may add or remove addresses. **Wait for an explicit yes.** If there are zero recipients, stop.

## 3. Write the email

Agree the content with the sender, then choose a template:
- `event`: a dated event. Needs `eventDetails`, a list of `{ "label": …, "value": … }` (date, time, place).
- `programme`: an announcement with details and one main action. Optional `programmeDetails` (same shape).
- `newsletter`: anything else.

Save the spec as `spec.json` in the temp folder:

```json
{
  "template": "newsletter",
  "subject": "[BeGifted] …",
  "preheader": "One-line inbox preview",
  "title": "Headline",
  "greeting": "Dear tutors,",
  "paragraphs": ["First paragraph.", "Second paragraph."],
  "sections": [{ "heading": "What to do", "paragraphs": ["…"], "bullets": ["…"] }],
  "action": { "label": "Open the form", "url": "https://…" }
}
```

Required fields: `template`, `subject`, `preheader`, `title`, `paragraphs`. Optional: `subtitle`, `greeting`,
`sections`, `action`, `eventDetails`, `programmeDetails`. Every value is plain text, never HTML. Links must be
full `https://` addresses.

## 4. Render and preview

```bash
node .claude/skills/email-current-tutors/build-email.mjs <temp-folder>/spec.json --out <temp-folder>/out
```

The script writes `email.html`, `email.txt` and `subject.txt`. If it prints `Could not build the email: …`, fix
the spec and run it again. Show the sender `email.txt`. If a browser tool is available, open `email.html` so they
can see the design. Revise until the sender approves the content.

## 5. Create the Gmail draft

Use the Gmail connector's `create_draft` tool. If it is deferred, load it with ToolSearch (query
`gmail create_draft`). Ask which address the draft should go To; normally that is the sender's own address. Call:
- `to`: [the sender's address]
- `bcc`: every confirmed recipient address, exactly as confirmed
- `subject`: the contents of `subject.txt`
- `htmlBody`: the contents of `email.html`
- `body`: the contents of `email.txt`

Then read the draft back with the connector's `get_draft` and compare its BCC addresses with the confirmed list.
They must match exactly, with the same count and the same addresses. If they differ, correct the draft with
`update_draft` and check again.

If there is no Gmail connector, tell the sender: "Connect Gmail in claude.ai → Settings → Connectors, then run
this again." Meanwhile offer the manual fallback: the path of `email.html`, and the BCC list as one
comma-separated line to paste into Gmail's BCC field.

## 6. Hand back

Give the sender the draft's `viewUrl` and the count, for example: "Draft ready with 58 tutors in BCC: <viewUrl>.
Review it in Gmail and press Send." Do not send it.
````

- [ ] **Step 2: Add the API reference row**

In `docs/reference/api/tutor-offboarding.md`, insert this row in the endpoint table directly after the
`| GET | `/api/tutor-offboarding` | admin | …` row:

```markdown
| GET | `/api/tutor-offboarding/current-tutors` | admin | Tutors teaching now (an upcoming class or a class in the last 30 days) with one email each, plus `needsEmail` and sheet-confirmed `excludedConfirmed`; `{ available: false, reason }` when not set up. `?format=csv` downloads recipients only (503 when unavailable); any other query → 400. `Cache-Control: private, no-store`. Read-only; used by the `email-current-tutors` skill |
```

- [ ] **Step 3: Add the feature section**

In `docs/features/tutor-offboarding.md`, insert before `## Page and access`:

```markdown
## Current tutor list and the email skill

`GET /api/tutor-offboarding/current-tutors` lists everyone teaching now: an upcoming class, or a taught class in
the last 30 days (owner decision, 12 October 2026). A person crossed out in the tutor sheet is left out even
while still teaching. Each person gets one address through the post-class rule: the primary override, else one
distinct Wise email. Two different Wise emails, or none, are listed under `needsEmail` and never guessed.
Teaching admins count when they teach. The route reads Postgres only; `?format=csv` downloads the recipients.
`buildCurrentTutorList` (`src/lib/tutor-offboarding/current-tutors.ts`) holds the rule.

The committed Claude Code skill `.claude/skills/email-current-tutors/` (`/email-current-tutors`) uses this list.
It confirms recipients with the sender, renders a BeGifted v3 company email with a bundled copy of the
`begifted-design` 3.2.0 renderer, and creates a **Gmail draft** with every tutor in BCC through the sender's
claude.ai Gmail connector. It never sends; the sender reviews the draft and presses Send. Each sender connects
Gmail once in claude.ai → Settings → Connectors.
```

- [ ] **Step 4: Check whitespace and commit**

Run: `git diff --check`
Expected: no output.

```bash
git add .claude/skills/email-current-tutors/SKILL.md docs/reference/api/tutor-offboarding.md docs/features/tutor-offboarding.md
git commit -m "feat(skills): email-current-tutors skill and docs

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 5: Branch verification, draft PR, post-deploy dry run

**Files:** none new.

- [ ] **Step 1: Run the full local gate**

Run: `npm run typecheck && npm test && node --test .claude/skills/email-current-tutors/build-email.test.mjs && npx eslint src/lib/tutor-offboarding src/app/api/tutor-offboarding .claude/skills/email-current-tutors && git diff --check origin/main...HEAD`
Expected: every command exits 0. The full unit suite passes.

Do not run `npm run build` locally; CI runs it (worktree policy).

- [ ] **Step 2: Scan for fake completion**

Run: `git diff origin/main...HEAD | grep -n -E "TODO|FIXME|\.only\(|\.skip\(|it\.todo" || echo clean`
Expected: `clean`.

- [ ] **Step 3: Push and open a DRAFT PR (ask the owner first)**

Pushing is outward-facing, so confirm with Kevin first. Then:

```bash
git push -u origin feat/email-current-tutors
gh pr create --draft --title "Email current tutors: read-only list endpoint + team skill" --body-file - <<'EOF'
## What
- `GET /api/tutor-offboarding/current-tutors` (admin, read-only, `?format=csv`): tutors teaching now — an upcoming class or a class in the last 30 days — minus sheet-confirmed departures, one email each via the post-class recipient rule; conflicts/gaps listed under `needsEmail`, never guessed.
- `.claude/skills/email-current-tutors/`: team skill that confirms recipients, renders a BeGifted v3 company email (bundled `begifted-design` 3.2.0 renderer, MIT notice) and creates a Gmail draft with tutors in BCC. Never sends.

Spec: `docs/superpowers/specs/2026-10-12-email-current-tutors-design.md` · Plan: `docs/superpowers/plans/2026-10-12-email-current-tutors.md`

## Checks run
- `npm run typecheck`, `npm test`, `node --test .claude/skills/email-current-tutors/build-email.test.mjs`, eslint on changed paths, `git diff --check`

## Not included
No migration, env var, cron or Wise write. Post-deploy dry run (plan Task 5 Step 4) still to do.

🤖 Generated with [Claude Code](https://claude.com/claude-code)
EOF
```

The PR stays a draft until a reviewer reports CLEAR (see the draft-PR rule). No migration or env var gate applies.

- [ ] **Step 4: Post-deploy dry run (owner, after merge and Vercel deploy)**

Run `/email-current-tutors` once as Kevin, signed in, and check each Review Focus item:
1. Sign out in the browser tool, run step 1, and confirm the skill asks you to sign in rather than parsing HTML.
2. Use the CSV path once: download it, open it in a text editor, and confirm the BOM and the `'`-prefix stripping
   in the skill's recipient list.
3. Create the draft with To = yourself. Confirm that `get_draft` exposes the BCC list and that the comparison
   ran. If the connector does not return BCC, record that here and change SKILL.md step 5 to compare the draft's
   BCC count shown in Gmail.
4. Confirm the email renders in Gmail web and on mobile.
5. Delete the dry-run draft yourself in Gmail. Do not send it.
