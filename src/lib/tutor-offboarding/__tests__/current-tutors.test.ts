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
      '﻿"name","email","reason"\r\n"Ana ""A"" Lee","ana@example.com","upcoming"\r\n"\'=SUM(1)","sum@example.com","recent"',
    );
  });
});
