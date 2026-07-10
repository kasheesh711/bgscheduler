import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";

// Deterministic "today" (Wednesday 8 July 2026, Bangkok) so week grouping in
// the rendered dashboard is stable regardless of when the suite runs.
vi.mock("@/lib/room-capacity/dates", () => ({
  todayBangkok: vi.fn(() => "2026-07-08"),
}));

import {
  PARENT_SECTION_TEST_IDS,
  ParentDashboardView,
  groupParentDeadlinesByWeek,
} from "../parent-dashboard";
import {
  PARENT_APP_STATUS_STRINGS,
  PARENT_CASE_STATUS_STRINGS,
  PARENT_DEADLINE_SOURCE_STRINGS,
  PARENT_LOCALE_STORAGE_KEY,
  PARENT_STRINGS,
  PARENT_TEST_TYPE_STRINGS,
  formatParentString,
  pickParentString,
  readStoredParentLocale,
  resolveParentLocale,
  writeStoredParentLocale,
  type ParentBilingualString,
} from "../strings";
import type {
  ParentDashboard,
  ParentDeadline,
} from "@/lib/admissions/parent-projection";

// ── Fixtures ────────────────────────────────────────────────────────────

const DASHBOARD: ParentDashboard = {
  studentName: "Ploy Srisuwan",
  cohortName: "Class of 2027",
  caseStatus: "active",
  progress: { done: 3, total: 8, percent: 38 },
  phaseProgress: [
    { phase: "about_you", label: "About You", done: 2, total: 4, percent: 50 },
    { phase: "essays", label: "Essays", done: 0, total: 6, percent: 0 },
  ],
  collegeList: [
    {
      instName: "Harvard University",
      round: "rea",
      roundLabel: "REA",
      appStatus: "researching",
      deadline: "2026-11-01",
      category: "reach",
    },
    {
      instName: "University of Michigan",
      round: "rd",
      roundLabel: "RD",
      appStatus: "applying",
      deadline: null,
      category: "match",
    },
  ],
  upcomingDeadlines: [
    {
      source: "task",
      title: "Submit the transcript request",
      date: "2026-07-01",
      overdue: true,
    },
    {
      source: "essay",
      title: "Update essay: Personal statement",
      date: "2026-07-09",
      overdue: false,
    },
    {
      source: "application",
      title: "Harvard University — REA deadline",
      date: "2026-07-13",
      overdue: false,
    },
    {
      source: "testing",
      title: "SAT registration closes",
      date: "2026-07-21",
      overdue: false,
    },
  ],
  announcements: [
    {
      title: "Common App opens August 1",
      body: "Get your account ready before the season starts.",
      createdAt: "2026-07-01T03:00:00.000Z",
    },
  ],
  testingMilestones: [
    {
      testType: "sat",
      testDate: "2026-06-06",
      registered: true,
      taken: true,
      scoreReceived: true,
      score: 1450,
    },
    {
      testType: "ielts",
      testDate: "2026-10-03",
      registered: false,
      taken: false,
      scoreReceived: false,
    },
  ],
  sharedNotes: [
    {
      body: "Ploy is making great progress on her essays.",
      createdAt: "2026-07-05T03:00:00.000Z",
    },
  ],
};

const EMPTY_DASHBOARD: ParentDashboard = {
  ...DASHBOARD,
  progress: { done: 0, total: 0, percent: 0 },
  phaseProgress: [],
  collegeList: [],
  upcomingDeadlines: [],
  announcements: [],
  testingMilestones: [],
  sharedNotes: [],
};

function renderDashboard(overrides: {
  dashboard?: ParentDashboard;
  initialLocale?: "th" | "en";
} = {}): string {
  return renderToStaticMarkup(
    <ParentDashboardView
      dashboard={overrides.dashboard ?? DASHBOARD}
      initialLocale={overrides.initialLocale}
    />,
  );
}

function countOccurrences(html: string, needle: string): number {
  return html.split(needle).length - 1;
}

/** Fake storage capturing writes; optionally throws on every access. */
function fakeStorage(initial: Record<string, string> = {}, throwing = false) {
  const store = new Map(Object.entries(initial));
  return {
    store,
    getItem: (key: string): string | null => {
      if (throwing) throw new Error("storage unavailable");
      return store.get(key) ?? null;
    },
    setItem: (key: string, value: string): void => {
      if (throwing) throw new Error("storage unavailable");
      store.set(key, value);
    },
  };
}

// ── Locale helpers (CM-131: Thai-first, persisted toggle) ───────────────

describe("resolveParentLocale", () => {
  it("returns en only for the exact string \"en\"", () => {
    expect(resolveParentLocale("en")).toBe("en");
  });

  it("falls back to th for anything else (fail-closed Thai-first)", () => {
    expect(resolveParentLocale(null)).toBe("th");
    expect(resolveParentLocale("")).toBe("th");
    expect(resolveParentLocale("EN")).toBe("th");
    expect(resolveParentLocale("english")).toBe("th");
  });
});

describe("readStoredParentLocale", () => {
  it("reads a persisted en choice from the storage key", () => {
    const storage = fakeStorage({ [PARENT_LOCALE_STORAGE_KEY]: "en" });
    expect(readStoredParentLocale(storage)).toBe("en");
  });

  it("defaults to th for missing storage, missing key, or garbage", () => {
    expect(readStoredParentLocale(null)).toBe("th");
    expect(readStoredParentLocale(undefined)).toBe("th");
    expect(readStoredParentLocale(fakeStorage())).toBe("th");
    expect(
      readStoredParentLocale(fakeStorage({ [PARENT_LOCALE_STORAGE_KEY]: "xx" })),
    ).toBe("th");
  });

  it("defaults to th when storage throws (private mode)", () => {
    expect(readStoredParentLocale(fakeStorage({}, true))).toBe("th");
  });
});

describe("writeStoredParentLocale", () => {
  it("persists the choice under the storage key (round-trips)", () => {
    const storage = fakeStorage();
    writeStoredParentLocale(storage, "en");
    expect(storage.store.get(PARENT_LOCALE_STORAGE_KEY)).toBe("en");
    expect(readStoredParentLocale(storage)).toBe("en");
    writeStoredParentLocale(storage, "th");
    expect(readStoredParentLocale(storage)).toBe("th");
  });

  it("is a silent no-op for missing or throwing storage", () => {
    expect(() => writeStoredParentLocale(null, "en")).not.toThrow();
    expect(() => writeStoredParentLocale(fakeStorage({}, true), "en")).not.toThrow();
  });
});

describe("bilingual string tables", () => {
  it("every static string has non-empty th and en variants", () => {
    const tables: Record<string, ParentBilingualString>[] = [
      PARENT_STRINGS,
      PARENT_CASE_STATUS_STRINGS,
      PARENT_APP_STATUS_STRINGS,
      PARENT_DEADLINE_SOURCE_STRINGS,
      PARENT_TEST_TYPE_STRINGS,
    ];
    for (const table of tables) {
      for (const [key, entry] of Object.entries(table)) {
        expect(entry.th.trim(), `${key}.th`).not.toBe("");
        expect(entry.en.trim(), `${key}.en`).not.toBe("");
      }
    }
  });

  it("pickParentString and formatParentString honor locale and vars", () => {
    expect(pickParentString(PARENT_STRINGS.deadlinesTitle, "th")).toBe(
      "กำหนดการที่ใกล้ถึง",
    );
    expect(pickParentString(PARENT_STRINGS.deadlinesTitle, "en")).toBe(
      "Upcoming deadlines",
    );
    expect(
      formatParentString(PARENT_STRINGS.progressDoneOfTotal, "en", {
        done: "3",
        total: "8",
      }),
    ).toBe("3 of 8 tasks done");
    // Unknown placeholders stay verbatim (fail-closed — never drop text).
    expect(
      formatParentString(PARENT_STRINGS.deadlinesGroupWeekOf, "en", {}),
    ).toBe("Week of {date}");
  });
});

// ── Week grouping ───────────────────────────────────────────────────────

describe("groupParentDeadlinesByWeek", () => {
  const TODAY = "2026-07-08"; // Wednesday; week runs Mon 6 Jul – Sun 12 Jul.

  it("groups overdue first, then this week, next week, and later weeks", () => {
    const groups = groupParentDeadlinesByWeek(DASHBOARD.upcomingDeadlines, TODAY);
    expect(groups.map((group) => group.key)).toEqual([
      "overdue",
      "week-0",
      "week-1",
      "week-2",
    ]);
    expect(groups.map((group) => group.kind)).toEqual([
      "overdue",
      "thisWeek",
      "nextWeek",
      "laterWeek",
    ]);
    expect(groups[1].items[0].title).toBe("Update essay: Personal statement");
    expect(groups[2].items[0].title).toBe("Harvard University — REA deadline");
    // Later weeks carry their Monday for the "Week of {date}" heading.
    expect(groups[3].weekStart).toBe("2026-07-20");
  });

  it("keeps Sunday inside the current Monday-started week", () => {
    const sunday: ParentDeadline = {
      source: "task",
      title: "Sunday item",
      date: "2026-07-12",
      overdue: false,
    };
    const groups = groupParentDeadlinesByWeek([sunday], TODAY);
    expect(groups).toHaveLength(1);
    expect(groups[0].kind).toBe("thisWeek");
  });

  it("sorts items by date inside each group", () => {
    const items: ParentDeadline[] = [
      { source: "task", title: "Later overdue", date: "2026-07-05", overdue: true },
      { source: "task", title: "Older overdue", date: "2026-07-01", overdue: true },
    ];
    const groups = groupParentDeadlinesByWeek(items, TODAY);
    expect(groups[0].items.map((item) => item.title)).toEqual([
      "Older overdue",
      "Later overdue",
    ]);
  });

  it("routes unparsable dates to a trailing week-unknown group (never dropped)", () => {
    const items: ParentDeadline[] = [
      { source: "task", title: "Good", date: "2026-07-09", overdue: false },
      { source: "task", title: "Bad", date: "soon", overdue: false },
    ];
    const groups = groupParentDeadlinesByWeek(items, TODAY);
    expect(groups.map((group) => group.key)).toEqual(["week-0", "week-unknown"]);
    expect(groups[1].items[0].title).toBe("Bad");
  });

  it("returns no groups for an empty list", () => {
    expect(groupParentDeadlinesByWeek([], TODAY)).toEqual([]);
  });
});

// ── Section order (design §5.3) ─────────────────────────────────────────

describe("ParentDashboardView section order", () => {
  it("renders all §5.3 sections in the mandated order", () => {
    const html = renderDashboard();
    expect(PARENT_SECTION_TEST_IDS).toEqual([
      "parent-header",
      "parent-progress",
      "parent-deadlines",
      "parent-colleges",
      "parent-announcements",
      "parent-testing",
      "parent-notes",
    ]);
    let previousIndex = -1;
    for (const testId of PARENT_SECTION_TEST_IDS) {
      const index = html.indexOf(`data-testid="${testId}"`);
      expect(index, testId).toBeGreaterThan(previousIndex);
      previousIndex = index;
    }
  });

  it("renders the child header with name, cohort, and status chip", () => {
    const html = renderDashboard();
    expect(html).toContain("Ploy Srisuwan");
    expect(html).toContain("Class of 2027");
    expect(html).toContain(PARENT_CASE_STATUS_STRINGS.active.th);
  });
});

// ── Bilingual rendering (CM-131) ────────────────────────────────────────

describe("ParentDashboardView bilingual statics", () => {
  it("renders Thai-first by default with the th toggle pressed", () => {
    const html = renderDashboard();
    expect(html).toContain(PARENT_STRINGS.progressTitle.th);
    expect(html).toContain(PARENT_STRINGS.deadlinesTitle.th);
    expect(html).toContain(PARENT_STRINGS.collegesTitle.th);
    expect(html).toContain(PARENT_STRINGS.announcementsTitle.th);
    expect(html).toContain(PARENT_STRINGS.testingTitle.th);
    expect(html).toContain(PARENT_STRINGS.notesTitle.th);
    // No English statics leak into the Thai render.
    expect(html).not.toContain("Upcoming deadlines");
    expect(html).not.toContain("College list");
    expect(html).not.toContain("Announcements");
    expect(html).not.toContain("Testing milestones");
    expect(html).not.toContain("Notes from your counselor");
    expect(html).not.toContain("Overdue");

    const thToggle = html.match(
      /<button[^>]*data-testid="parent-locale-th"[^>]*>/,
    );
    const enToggle = html.match(
      /<button[^>]*data-testid="parent-locale-en"[^>]*>/,
    );
    expect(thToggle![0]).toContain('aria-pressed="true"');
    expect(enToggle![0]).toContain('aria-pressed="false"');
  });

  it("renders English statics when the locale is en", () => {
    const html = renderDashboard({ initialLocale: "en" });
    expect(html).toContain("Upcoming deadlines");
    expect(html).toContain("College list");
    expect(html).toContain("Notes from your counselor");
    expect(html).not.toContain(PARENT_STRINGS.deadlinesTitle.th);
    const enToggle = html.match(
      /<button[^>]*data-testid="parent-locale-en"[^>]*>/,
    );
    expect(enToggle![0]).toContain('aria-pressed="true"');
  });

  it("renders data values verbatim in both locales", () => {
    for (const initialLocale of ["th", "en"] as const) {
      const html = renderDashboard({ initialLocale });
      expect(html).toContain("Ploy Srisuwan");
      expect(html).toContain("Class of 2027");
      expect(html).toContain("Harvard University");
      expect(html).toContain("REA"); // server-provided round label, untranslated
      expect(html).toContain("Common App opens August 1");
      expect(html).toContain("Ploy is making great progress on her essays.");
    }
  });
});

// ── Read-only guarantees (design §5.3: zero mutation affordances) ───────

describe("ParentDashboardView read-only surface", () => {
  it("has no mutation affordances and no links to staff surfaces", () => {
    for (const initialLocale of ["th", "en"] as const) {
      const html = renderDashboard({ initialLocale });
      expect(html).not.toContain("<form");
      expect(html).not.toContain("<input");
      expect(html).not.toContain("<select");
      expect(html).not.toContain("<textarea");
      // No anchors at all — no staff surfaces, no navigation.
      expect(html).not.toContain("<a ");
      expect(html).not.toContain("href=");
      // The ONLY buttons are the two language toggles.
      expect(countOccurrences(html, "<button")).toBe(2);
      expect(html).toContain('data-testid="parent-locale-th"');
      expect(html).toContain('data-testid="parent-locale-en"');
    }
  });

  it("never renders staff affordance strings on any locale", () => {
    for (const initialLocale of ["th", "en"] as const) {
      const html = renderDashboard({ initialLocale });
      expect(html).not.toContain("Add a note");
      expect(html).not.toContain("Log meeting");
      expect(html).not.toContain("Invite");
      expect(html).not.toContain("Revoke");
      expect(html).not.toContain("Verify");
      expect(html).not.toContain("Staff only");
    }
  });
});

// ── Testing milestones (CM-83) ──────────────────────────────────────────

describe("ParentDashboardView testing milestones", () => {
  it("shows the score only for milestones that carry a score key", () => {
    const html = renderDashboard();
    expect(countOccurrences(html, 'data-testid="parent-milestone-row"')).toBe(2);
    expect(countOccurrences(html, 'data-testid="parent-milestone-score"')).toBe(1);
    expect(html).toContain("1450");
  });

  it("renders no score row when every score is withheld", () => {
    const withheld: ParentDashboard = {
      ...DASHBOARD,
      testingMilestones: [
        {
          testType: "sat",
          testDate: "2026-06-06",
          registered: true,
          taken: true,
          scoreReceived: true,
          // No `score` key: unreleased (CM-83) — the DTO omits it entirely.
        },
      ],
    };
    const html = renderDashboard({ dashboard: withheld });
    expect(countOccurrences(html, 'data-testid="parent-milestone-row"')).toBe(1);
    expect(html).not.toContain('data-testid="parent-milestone-score"');
    expect(html).not.toContain("1450");
  });
});

// ── Deadlines (grouped by week, overdue red) ────────────────────────────

describe("ParentDashboardView deadlines", () => {
  it("groups deadlines by week with the overdue group first", () => {
    const html = renderDashboard();
    const overdueIndex = html.indexOf('data-testid="parent-deadline-group-overdue"');
    const thisWeekIndex = html.indexOf('data-testid="parent-deadline-group-week-0"');
    const nextWeekIndex = html.indexOf('data-testid="parent-deadline-group-week-1"');
    const laterIndex = html.indexOf('data-testid="parent-deadline-group-week-2"');
    expect(overdueIndex).toBeGreaterThan(-1);
    expect(thisWeekIndex).toBeGreaterThan(overdueIndex);
    expect(nextWeekIndex).toBeGreaterThan(thisWeekIndex);
    expect(laterIndex).toBeGreaterThan(nextWeekIndex);
    expect(html).toContain(PARENT_STRINGS.deadlinesGroupThisWeek.th);
    expect(html).toContain(PARENT_STRINGS.deadlinesGroupNextWeek.th);
    // Later weeks are titled by their Monday, D/M format.
    expect(html).toContain("สัปดาห์วันที่ 20/7/2026");
  });

  it("styles overdue deadlines red with the overdue marker", () => {
    const html = renderDashboard();
    expect(html).toContain("text-conflict");
    expect(html).toContain(`1/7/2026 · ${PARENT_STRINGS.overdueMarker.th}`);
  });

  it("renders D/M dates and bilingual source badges", () => {
    const html = renderDashboard();
    expect(html).toContain("9/7/2026");
    expect(html).toContain(PARENT_DEADLINE_SOURCE_STRINGS.task.th);
    expect(html).toContain(PARENT_DEADLINE_SOURCE_STRINGS.essay.th);
  });
});

// ── Empty states ────────────────────────────────────────────────────────

describe("ParentDashboardView empty states", () => {
  it("renders a Thai empty state for every empty section", () => {
    const html = renderDashboard({ dashboard: EMPTY_DASHBOARD });
    expect(html).toContain(PARENT_STRINGS.deadlinesEmpty.th);
    expect(html).toContain(PARENT_STRINGS.collegesEmpty.th);
    expect(html).toContain(PARENT_STRINGS.announcementsEmpty.th);
    expect(html).toContain(PARENT_STRINGS.testingEmpty.th);
    expect(html).toContain(PARENT_STRINGS.notesEmpty.th);
    expect(countOccurrences(html, 'data-testid="parent-phase-ring"')).toBe(0);
    // Sections stay present (and ordered) even when empty.
    for (const testId of PARENT_SECTION_TEST_IDS) {
      expect(html).toContain(`data-testid="${testId}"`);
    }
  });
});
