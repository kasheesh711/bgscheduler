import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";

import {
  CALENDAR_DAY_HEADERS,
  CalendarTab,
  MAX_VISIBLE_DAY_CHIPS,
  addMonths,
  buildMonthGrid,
  formatMonthLabel,
  getMondayKey,
  getMonthKey,
  getMonthWindow,
  groupItemsByDate,
  groupItemsByWeek,
} from "../calendar-tab";
import type { CalendarItem } from "@/lib/admissions/calendar";

// ── Fixtures ────────────────────────────────────────────────────────────

const CASE_ID = "6a1f4c1e-2222-4444-8888-aaaaaaaaaaaa";

function item(
  overrides: Partial<CalendarItem> & { id: string; date: string },
): CalendarItem {
  return {
    caseId: CASE_ID,
    source: "task",
    title: "Task",
    overdue: false,
    ownerRole: "student",
    ...overrides,
  };
}

// July 2026: the 1st is a Wednesday, so the Monday-start grid begins 2026-06-29.
const VIEW_MONTH = "2026-07";

const OVERDUE_ITEM = item({
  id: "11111111-aaaa-4aaa-8aaa-111111111111",
  title: "Submit FAFSA draft",
  date: "2026-07-02",
  overdue: true,
});

const CROWDED_DAY_ITEMS = [
  item({ id: "22222222-bbbb-4bbb-8bbb-222222222222", title: "Essay outline", date: "2026-07-10" }),
  item({ id: "33333333-cccc-4ccc-8ccc-333333333333", title: "Request transcript", date: "2026-07-10" }),
  item({ id: "44444444-dddd-4ddd-8ddd-444444444444", title: "Book counselor meeting", date: "2026-07-10" }),
];

const ALL_ITEMS = [OVERDUE_ITEM, ...CROWDED_DAY_ITEMS];

function renderCalendar(items: CalendarItem[] = ALL_ITEMS): string {
  return renderToStaticMarkup(
    <CalendarTab caseId={CASE_ID} initialMonth={VIEW_MONTH} initialItems={items} />,
  );
}

// ── Pure helpers ────────────────────────────────────────────────────────

describe("getMonthKey", () => {
  it("truncates a date key to its month", () => {
    expect(getMonthKey("2026-07-15")).toBe("2026-07");
  });

  it("passes non-dates through unchanged (never guesses)", () => {
    expect(getMonthKey("bogus")).toBe("bogus");
  });
});

describe("addMonths", () => {
  it("moves forward and backward within a year", () => {
    expect(addMonths("2026-06", 1)).toBe("2026-07");
    expect(addMonths("2026-06", -1)).toBe("2026-05");
    expect(addMonths("2026-06", 0)).toBe("2026-06");
  });

  it("crosses year boundaries in both directions", () => {
    expect(addMonths("2026-12", 1)).toBe("2027-01");
    expect(addMonths("2026-01", -1)).toBe("2025-12");
    expect(addMonths("2026-03", -15)).toBe("2024-12");
  });

  it("throws on malformed month keys", () => {
    expect(() => addMonths("2026-7", 1)).toThrow();
    expect(() => addMonths("bogus", 1)).toThrow();
  });
});

describe("formatMonthLabel", () => {
  it("formats a month key as a readable label", () => {
    expect(formatMonthLabel("2026-07")).toBe("July 2026");
    expect(formatMonthLabel("2025-12")).toBe("December 2025");
  });

  it("passes malformed keys through unchanged", () => {
    expect(formatMonthLabel("bogus")).toBe("bogus");
  });
});

describe("getMonthWindow", () => {
  it("returns the inclusive first..last-day window", () => {
    expect(getMonthWindow("2026-07")).toEqual({ from: "2026-07-01", to: "2026-07-31" });
    expect(getMonthWindow("2026-04")).toEqual({ from: "2026-04-01", to: "2026-04-30" });
  });

  it("handles leap-year February", () => {
    expect(getMonthWindow("2024-02")).toEqual({ from: "2024-02-01", to: "2024-02-29" });
    expect(getMonthWindow("2026-02")).toEqual({ from: "2026-02-01", to: "2026-02-28" });
  });

  it("throws on malformed month keys", () => {
    expect(() => getMonthWindow("2026-7")).toThrow();
  });
});

describe("getMondayKey", () => {
  it("maps any weekday to the Monday of its week", () => {
    // 2026-07-09 is a Thursday; 2026-07-12 is a Sunday.
    expect(getMondayKey("2026-07-09")).toBe("2026-07-06");
    expect(getMondayKey("2026-07-12")).toBe("2026-07-06");
  });

  it("maps a Monday to itself", () => {
    expect(getMondayKey("2026-07-06")).toBe("2026-07-06");
  });
});

describe("buildMonthGrid", () => {
  it("builds a Monday-start 6x7 grid covering the whole month", () => {
    const cells = buildMonthGrid(VIEW_MONTH);
    expect(cells).toHaveLength(42);
    // July 2026 starts on a Wednesday — the grid opens on Monday 2026-06-29.
    expect(cells[0].dateKey).toBe("2026-06-29");
    expect(cells[0].inMonth).toBe(false);
    expect(cells[41].dateKey).toBe("2026-08-09");
    expect(cells.filter((cell) => cell.inMonth)).toHaveLength(31);
    expect(cells.map((cell) => cell.dateKey)).toContain("2026-07-01");
    expect(cells.map((cell) => cell.dateKey)).toContain("2026-07-31");
  });

  it("marks out-of-month margin cells as not in the month", () => {
    const cells = buildMonthGrid(VIEW_MONTH);
    const june = cells.filter((cell) => cell.dateKey.startsWith("2026-06"));
    const august = cells.filter((cell) => cell.dateKey.startsWith("2026-08"));
    expect(june.length).toBeGreaterThan(0);
    expect(august.length).toBeGreaterThan(0);
    expect([...june, ...august].every((cell) => !cell.inMonth)).toBe(true);
  });
});

describe("groupItemsByDate", () => {
  it("buckets items per date preserving input order", () => {
    const grouped = groupItemsByDate(ALL_ITEMS);
    expect(grouped.get("2026-07-02")).toHaveLength(1);
    expect(grouped.get("2026-07-10")?.map((entry) => entry.title)).toEqual([
      "Essay outline",
      "Request transcript",
      "Book counselor meeting",
    ]);
    expect(grouped.get("2026-07-03")).toBeUndefined();
  });
});

describe("groupItemsByWeek", () => {
  it("groups items into ascending Monday-keyed weeks", () => {
    const groups = groupItemsByWeek(ALL_ITEMS);
    expect(groups.map((group) => group.weekStart)).toEqual([
      "2026-06-29",
      "2026-07-06",
    ]);
    expect(groups[0].items.map((entry) => entry.id)).toEqual([OVERDUE_ITEM.id]);
    expect(groups[1].items).toHaveLength(3);
  });

  it("skips items with malformed dates (fail-closed)", () => {
    const groups = groupItemsByWeek([
      item({ id: "55555555-eeee-4eee-8eee-555555555555", date: "not-a-date" }),
    ]);
    expect(groups).toEqual([]);
  });
});

// ── Rendering ───────────────────────────────────────────────────────────

describe("CalendarTab month grid", () => {
  it("renders deadline chips on their day cells", () => {
    const html = renderCalendar();
    expect(html).toContain('data-testid="calendar-grid"');
    expect(html).toContain('data-testid="calendar-cell-2026-07-02"');
    expect(html).toContain("Submit FAFSA draft");
    expect(html).toContain("Essay outline");
    // Overdue chips pick up the --conflict styling.
    expect(html).toContain("text-conflict");
    const chips = html.match(/data-testid="calendar-chip"/g) ?? [];
    // 1 chip on July 2 + MAX_VISIBLE_DAY_CHIPS on the crowded July 10.
    expect(chips).toHaveLength(1 + MAX_VISIBLE_DAY_CHIPS);
  });

  it("collapses crowded days into a +N more overflow", () => {
    const html = renderCalendar();
    expect(html).toContain("+1 more");
    // The third chip is hidden inside the July 10 grid cell (it still renders
    // in the list fallback, which shows every item).
    const cellStart = html.indexOf('data-testid="calendar-cell-2026-07-10"');
    const cellEnd = html.indexOf('data-testid="calendar-cell-2026-07-11"');
    expect(cellStart).toBeGreaterThan(-1);
    const cell = html.slice(cellStart, cellEnd);
    expect(cell).toContain("Essay outline");
    expect(cell).toContain("Request transcript");
    expect(cell).not.toContain("Book counselor meeting");
    expect(cell).toContain("+1 more");
  });

  it("renders the month label, arrows, Today button, and day headers", () => {
    const html = renderCalendar();
    expect(html).toContain("July 2026");
    expect(html).toContain('aria-label="Previous month"');
    expect(html).toContain('aria-label="Next month"');
    expect(html).toContain(">Today</button>");
    for (const day of CALENDAR_DAY_HEADERS) {
      expect(html).toContain(`>${day}</div>`);
    }
  });

  it("renders the week-grouped list fallback for small viewports", () => {
    const html = renderCalendar();
    expect(html).toContain('data-testid="calendar-list"');
    expect(html).toContain("Week of 29/6/2026");
    expect(html).toContain("Week of 6/7/2026");
    expect(html).toContain("2/7/2026 · Overdue");
  });

  it("renders an empty state when the month has no deadlines", () => {
    const html = renderCalendar([]);
    expect(html).toContain("No deadlines in July 2026.");
    expect(html).not.toContain('data-testid="calendar-chip"');
  });
});
