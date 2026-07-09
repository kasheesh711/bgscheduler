import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, describe, expect, it, vi } from "vitest";

vi.mock("next/navigation", () => ({
  useRouter: vi.fn(() => ({ replace: vi.fn(), push: vi.fn(), refresh: vi.fn() })),
  usePathname: vi.fn(() => "/admissions/6a1f4c1e-2222-4444-8888-aaaaaaaaaaaa"),
  useSearchParams: vi.fn(() => null),
}));

import {
  ActivitiesView,
  ActivityEditor,
  CharCounter,
  EMPTY_ACTIVITY_DRAFT,
  buildActivityPayload,
  canEditActivities,
  clampToLimit,
  compareActivityRows,
  copyTextToClipboard,
  deriveRankedIds,
  isCounterWarning,
  makeActivityDraft,
  mergeActivityOverrides,
  moveRankedId,
  moveRankedIdToIndex,
  toggleGradeSelection,
  toggleRankedId,
  type ActivityDraft,
} from "../activities-view";
import {
  COMMON_APP_DESCRIPTION_MAX_CHARS,
  COMMON_APP_ORGANIZATION_MAX_CHARS,
  COMMON_APP_POSITION_MAX_CHARS,
  MAX_ACTIVE_ACTIVITIES_PER_CASE,
  MAX_COMMON_APP_RANKED_ACTIVITIES,
  UC_DESCRIPTION_MAX_CHARS,
  type AdmissionsActivityDto,
} from "@/lib/admissions/activities";
import type { CaseRole } from "@/lib/admissions/types";

// ── Fixtures ────────────────────────────────────────────────────────────

const CASE_ID = "6a1f4c1e-2222-4444-8888-aaaaaaaaaaaa";

function makeActivity(
  overrides: Partial<AdmissionsActivityDto> & { id: string },
): AdmissionsActivityDto {
  return {
    caseId: CASE_ID,
    name: "Robotics Club",
    fullDescription: null,
    commonApp: null,
    uc: null,
    commonAppRank: null,
    sortOrder: 0,
    createdAt: "2026-07-01T03:00:00.000Z",
    updatedAt: "2026-07-01T03:00:00.000Z",
    ...overrides,
  };
}

const RANKED_ACTIVITY = makeActivity({
  id: "11111111-aaaa-4aaa-8aaa-111111111111",
  name: "Debate Team",
  fullDescription: "Captained the varsity debate team for two years.",
  commonApp: { position: "Captain", organization: "BG Debate" },
  commonAppRank: 2,
  sortOrder: 1,
});

const UNRANKED_ACTIVITY = makeActivity({
  id: "22222222-bbbb-4bbb-8bbb-222222222222",
  name: "Hospital Volunteering",
  uc: { description: "Weekend volunteer.", category: "volunteering_community_service" },
  sortOrder: 0,
});

function makeFullDraft(overrides: Partial<ActivityDraft> = {}): ActivityDraft {
  return {
    name: "Robotics Club",
    fullDescription: "Founded the club.",
    caPosition: "Founder & President",
    caOrganization: "BG Robotics",
    caDescription: "Led 20 students to nationals.",
    caHrsWeek: "7.5",
    caWeeksYear: "40",
    caGrades: ["10", "11", "12"],
    caTiming: "school_year",
    ucDescription: "Started the school's first robotics team.",
    ucCategory: "extracurricular_activity",
    ...overrides,
  };
}

function renderView(overrides: {
  activities?: AdmissionsActivityDto[];
  viewerRole?: CaseRole;
  variant?: "tab" | "portal";
} = {}): string {
  return renderToStaticMarkup(
    <ActivitiesView
      caseId={CASE_ID}
      activities={overrides.activities ?? [RANKED_ACTIVITY, UNRANKED_ACTIVITY]}
      viewerRole={overrides.viewerRole ?? "student"}
      variant={overrides.variant ?? "tab"}
    />,
  );
}

function renderEditor(draft: ActivityDraft): string {
  return renderToStaticMarkup(
    <ActivityEditor
      heading="Edit activity"
      draft={draft}
      busy={false}
      errorMessage={null}
      submitLabel="Save changes"
      onDraftChange={() => undefined}
      onSubmit={() => undefined}
      onCancel={() => undefined}
    />,
  );
}

afterEach(() => {
  vi.unstubAllGlobals();
});

// ── Counter hard-stop (CM-70 hard limits) ───────────────────────────────

describe("clampToLimit", () => {
  it("blocks typing past the limit (hard stop)", () => {
    const overflow = "a".repeat(COMMON_APP_DESCRIPTION_MAX_CHARS + 25);
    const clamped = clampToLimit(overflow, COMMON_APP_DESCRIPTION_MAX_CHARS);
    expect(clamped).toHaveLength(COMMON_APP_DESCRIPTION_MAX_CHARS);
    expect(clamped).toBe("a".repeat(COMMON_APP_DESCRIPTION_MAX_CHARS));
  });

  it("returns values at or below the limit unchanged", () => {
    expect(clampToLimit("abc", 3)).toBe("abc");
    expect(clampToLimit("ab", 3)).toBe("ab");
    expect(clampToLimit("", 3)).toBe("");
  });

  it("hard-stops at every platform limit (50/100/150/350 mirror)", () => {
    for (const limit of [
      COMMON_APP_POSITION_MAX_CHARS,
      COMMON_APP_ORGANIZATION_MAX_CHARS,
      COMMON_APP_DESCRIPTION_MAX_CHARS,
      UC_DESCRIPTION_MAX_CHARS,
    ]) {
      expect(clampToLimit("x".repeat(limit + 1), limit)).toHaveLength(limit);
      expect(clampToLimit("x".repeat(limit), limit)).toHaveLength(limit);
    }
  });
});

// ── Red-at-90% counters ─────────────────────────────────────────────────

describe("isCounterWarning", () => {
  it("turns red at exactly 90% of the limit", () => {
    expect(isCounterWarning(45, 50)).toBe(true);
    expect(isCounterWarning(44, 50)).toBe(false);
    expect(isCounterWarning(135, 150)).toBe(true);
    expect(isCounterWarning(134, 150)).toBe(false);
    expect(isCounterWarning(315, 350)).toBe(true);
    expect(isCounterWarning(314, 350)).toBe(false);
  });

  it("stays red at the hard limit itself", () => {
    expect(isCounterWarning(50, 50)).toBe(true);
    expect(isCounterWarning(350, 350)).toBe(true);
  });

  it("never warns for a zero or negative limit", () => {
    expect(isCounterWarning(5, 0)).toBe(false);
    expect(isCounterWarning(5, -1)).toBe(false);
  });
});

describe("CharCounter markup", () => {
  it("renders n/limit and the destructive class at 90%", () => {
    const html = renderToStaticMarkup(
      <CharCounter length={135} limit={150} testId="counter-test" />,
    );
    expect(html).toContain("135/150");
    expect(html).toContain("text-destructive");
  });

  it("renders muted below 90%", () => {
    const html = renderToStaticMarkup(
      <CharCounter length={10} limit={150} testId="counter-test" />,
    );
    expect(html).toContain("10/150");
    expect(html).not.toContain("text-destructive");
    expect(html).toContain("text-muted-foreground");
  });
});

// ── Rank selection: max-10 enforcement (CM-71) ──────────────────────────

describe("toggleRankedId", () => {
  const TEN_IDS = Array.from({ length: 10 }, (_, index) => `id-${index}`);

  it("adds an unselected activity when under the cap", () => {
    expect(toggleRankedId(["a"], "b")).toEqual(["a", "b"]);
  });

  it("allows adding the 10th activity", () => {
    const nine = TEN_IDS.slice(0, MAX_COMMON_APP_RANKED_ACTIVITIES - 1);
    expect(toggleRankedId(nine, "id-9")).toHaveLength(
      MAX_COMMON_APP_RANKED_ACTIVITIES,
    );
  });

  it("rejects the 11th with null (max-10 enforcement)", () => {
    expect(toggleRankedId(TEN_IDS, "id-extra")).toBeNull();
  });

  it("removes a selected activity even when the list is full", () => {
    expect(toggleRankedId(TEN_IDS, "id-3")).toEqual(
      TEN_IDS.filter((id) => id !== "id-3"),
    );
  });
});

// ── Buttons-based reorder ───────────────────────────────────────────────

describe("moveRankedId", () => {
  it("moves an id up one position", () => {
    expect(moveRankedId(["a", "b", "c"], 2, "up")).toEqual(["a", "c", "b"]);
  });

  it("moves an id down one position", () => {
    expect(moveRankedId(["a", "b", "c"], 0, "down")).toEqual(["b", "a", "c"]);
  });

  it("keeps the order at the boundaries (first up, last down)", () => {
    expect(moveRankedId(["a", "b"], 0, "up")).toEqual(["a", "b"]);
    expect(moveRankedId(["a", "b"], 1, "down")).toEqual(["a", "b"]);
  });

  it("ignores out-of-range indices", () => {
    expect(moveRankedId(["a", "b"], 5, "up")).toEqual(["a", "b"]);
    expect(moveRankedId(["a", "b"], -1, "down")).toEqual(["a", "b"]);
  });
});

describe("moveRankedIdToIndex (drag-and-drop)", () => {
  it("moves an id to a later index preserving the rest", () => {
    expect(moveRankedIdToIndex(["a", "b", "c", "d"], 0, 2)).toEqual([
      "b",
      "c",
      "a",
      "d",
    ]);
  });

  it("moves an id to an earlier index preserving the rest", () => {
    expect(moveRankedIdToIndex(["a", "b", "c", "d"], 3, 1)).toEqual([
      "a",
      "d",
      "b",
      "c",
    ]);
  });

  it("ignores invalid indices", () => {
    expect(moveRankedIdToIndex(["a", "b"], 0, 9)).toEqual(["a", "b"]);
    expect(moveRankedIdToIndex(["a", "b"], -1, 0)).toEqual(["a", "b"]);
  });
});

describe("deriveRankedIds", () => {
  it("returns ranked ids in ascending rank order, skipping unranked rows", () => {
    const ids = deriveRankedIds([
      makeActivity({ id: "c", commonAppRank: 3 }),
      makeActivity({ id: "a", commonAppRank: 1 }),
      makeActivity({ id: "x", commonAppRank: null }),
      makeActivity({ id: "b", commonAppRank: 2 }),
    ]);
    expect(ids).toEqual(["a", "b", "c"]);
  });

  it("returns an empty list when nothing is ranked", () => {
    expect(deriveRankedIds([makeActivity({ id: "x" })])).toEqual([]);
  });
});

// ── Grade multiselect ───────────────────────────────────────────────────

describe("toggleGradeSelection", () => {
  it("adds a grade keeping canonical 9→post order", () => {
    expect(toggleGradeSelection(["11"], "9")).toEqual(["9", "11"]);
    expect(toggleGradeSelection(["9", "10"], "post")).toEqual(["9", "10", "post"]);
  });

  it("removes an already-selected grade", () => {
    expect(toggleGradeSelection(["9", "10", "11"], "10")).toEqual(["9", "11"]);
  });
});

// ── Draft <-> payload mapping ───────────────────────────────────────────

describe("makeActivityDraft", () => {
  it("returns the empty draft for null (create mode)", () => {
    expect(makeActivityDraft(null)).toEqual(EMPTY_ACTIVITY_DRAFT);
  });

  it("maps an activity's blocks into input strings", () => {
    const draft = makeActivityDraft(
      makeActivity({
        id: "a",
        name: "Debate",
        fullDescription: "Long write-up",
        commonApp: {
          position: "Captain",
          hrsWeek: 7.5,
          weeksYear: 40,
          grades: ["11", "12"],
          timing: "all_year",
        },
        uc: { description: "UC text", category: "work_experience" },
      }),
    );
    expect(draft.name).toBe("Debate");
    expect(draft.fullDescription).toBe("Long write-up");
    expect(draft.caPosition).toBe("Captain");
    expect(draft.caOrganization).toBe("");
    expect(draft.caHrsWeek).toBe("7.5");
    expect(draft.caWeeksYear).toBe("40");
    expect(draft.caGrades).toEqual(["11", "12"]);
    expect(draft.caTiming).toBe("all_year");
    expect(draft.ucDescription).toBe("UC text");
    expect(draft.ucCategory).toBe("work_experience");
  });
});

describe("buildActivityPayload", () => {
  it("rejects a blank name", () => {
    const result = buildActivityPayload({ ...EMPTY_ACTIVITY_DRAFT, name: "   " });
    expect(result).toEqual({ ok: false, error: "Activity name is required." });
  });

  it("collapses untouched platform blocks to null", () => {
    const result = buildActivityPayload({ ...EMPTY_ACTIVITY_DRAFT, name: "Chess" });
    expect(result).toEqual({
      ok: true,
      payload: { name: "Chess", fullDescription: null, commonApp: null, uc: null },
    });
  });

  it("builds full Common App and UC blocks with parsed numbers", () => {
    const result = buildActivityPayload(makeFullDraft({ name: "  Robotics Club  " }));
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.payload.name).toBe("Robotics Club");
    expect(result.payload.fullDescription).toBe("Founded the club.");
    expect(result.payload.commonApp).toEqual({
      position: "Founder & President",
      organization: "BG Robotics",
      description: "Led 20 students to nationals.",
      hrsWeek: 7.5,
      weeksYear: 40,
      grades: ["10", "11", "12"],
      timing: "school_year",
    });
    expect(result.payload.uc).toEqual({
      description: "Started the school's first robotics team.",
      category: "extracurricular_activity",
    });
  });

  it("rejects out-of-range or non-numeric hours per week", () => {
    for (const caHrsWeek of ["169", "-1", "abc"]) {
      const result = buildActivityPayload(makeFullDraft({ caHrsWeek }));
      expect(result.ok).toBe(false);
    }
  });

  it("rejects fractional or out-of-range weeks per year", () => {
    for (const caWeeksYear of ["1.5", "53", "-2"]) {
      const result = buildActivityPayload(makeFullDraft({ caWeeksYear }));
      expect(result.ok).toBe(false);
    }
  });

  it("fails closed on char overflow even if the clamp was bypassed", () => {
    const result = buildActivityPayload(
      makeFullDraft({ ucDescription: "x".repeat(UC_DESCRIPTION_MAX_CHARS + 1) }),
    );
    expect(result).toEqual({
      ok: false,
      error: `UC description exceeds ${UC_DESCRIPTION_MAX_CHARS} characters.`,
    });
  });
});

// ── Copy button clipboard call (CM-72) ──────────────────────────────────

describe("copyTextToClipboard", () => {
  it("writes the text through navigator.clipboard and reports success", async () => {
    const writeText = vi.fn().mockResolvedValue(undefined);
    vi.stubGlobal("navigator", { clipboard: { writeText } });

    await expect(copyTextToClipboard("Founder & President")).resolves.toBe(true);
    expect(writeText).toHaveBeenCalledTimes(1);
    expect(writeText).toHaveBeenCalledWith("Founder & President");
  });

  it("reports failure when the clipboard write is rejected", async () => {
    const writeText = vi.fn().mockRejectedValue(new Error("denied"));
    vi.stubGlobal("navigator", { clipboard: { writeText } });

    await expect(copyTextToClipboard("text")).resolves.toBe(false);
  });

  it("reports failure when the clipboard API is unavailable", async () => {
    vi.stubGlobal("navigator", {});
    await expect(copyTextToClipboard("text")).resolves.toBe(false);
  });
});

// ── Role gate + merge/sort helpers ──────────────────────────────────────

describe("canEditActivities", () => {
  it("blocks parents and allows student/counselor/admin (design §2.4)", () => {
    expect(canEditActivities("parent")).toBe(false);
    expect(canEditActivities("student")).toBe(true);
    expect(canEditActivities("counselor")).toBe(true);
    expect(canEditActivities("admin")).toBe(true);
  });
});

describe("mergeActivityOverrides", () => {
  it("replaces a base row when the override is at least as fresh", () => {
    const override = { ...UNRANKED_ACTIVITY, name: "Renamed" };
    const merged = mergeActivityOverrides([UNRANKED_ACTIVITY], {
      [UNRANKED_ACTIVITY.id]: override,
    });
    expect(merged).toEqual([override]);
  });

  it("keeps the base row when the server row is fresher than the override", () => {
    const staleOverride = {
      ...UNRANKED_ACTIVITY,
      name: "Stale",
      updatedAt: "2026-06-01T00:00:00.000Z",
    };
    const freshBase = { ...UNRANKED_ACTIVITY, updatedAt: "2026-07-08T00:00:00.000Z" };
    const merged = mergeActivityOverrides([freshBase], {
      [UNRANKED_ACTIVITY.id]: staleOverride,
    });
    expect(merged).toEqual([freshBase]);
  });

  it("hides null overrides and appends unseen ones", () => {
    const merged = mergeActivityOverrides([RANKED_ACTIVITY], {
      [RANKED_ACTIVITY.id]: null,
      [UNRANKED_ACTIVITY.id]: UNRANKED_ACTIVITY,
    });
    expect(merged).toEqual([UNRANKED_ACTIVITY]);
  });
});

describe("compareActivityRows", () => {
  it("orders ranked rows first by ascending rank, then the rest by sortOrder", () => {
    const rows = [
      makeActivity({ id: "d", sortOrder: 0 }),
      makeActivity({ id: "b", commonAppRank: 2, sortOrder: 5 }),
      makeActivity({ id: "a", commonAppRank: 1, sortOrder: 9 }),
      makeActivity({ id: "c", sortOrder: 3 }),
    ].sort(compareActivityRows);
    expect(rows.map((row) => row.id)).toEqual(["a", "b", "d", "c"]);
  });
});

// ── Master list markup ──────────────────────────────────────────────────

describe("ActivitiesView markup", () => {
  it("renders names, the full description, and the Common App rank badge", () => {
    const html = renderView();
    expect(html).toContain("Debate Team");
    expect(html).toContain("Hospital Volunteering");
    expect(html).toContain("Captained the varsity debate team for two years.");
    expect(html).toContain(`rank-badge-${RANKED_ACTIVITY.id}`);
    expect(html).toContain("Common App #2");
  });

  it("shows the CM-70 cap counter (n of 20)", () => {
    const html = renderView();
    expect(html).toContain(`2 of ${MAX_ACTIVE_ACTIVITIES_PER_CASE} activities`);
  });

  it("shows edit affordances (add, rank mode, per-card edit) for students", () => {
    const html = renderView({ viewerRole: "student" });
    expect(html).toContain('data-testid="activities-add"');
    expect(html).toContain('data-testid="rank-mode-toggle"');
    expect(html).toContain(`data-testid="activity-edit-${RANKED_ACTIVITY.id}"`);
  });

  it("hides every write affordance from parents (read-only, design §2.4)", () => {
    const html = renderView({ viewerRole: "parent" });
    expect(html).not.toContain('data-testid="activities-add"');
    expect(html).not.toContain('data-testid="rank-mode-toggle"');
    expect(html).not.toContain("activity-edit-");
    expect(html).toContain("Debate Team");
  });

  it("disables Add and shows the cap warning at 20 live activities", () => {
    const twenty = Array.from({ length: MAX_ACTIVE_ACTIVITIES_PER_CASE }, (_, index) =>
      makeActivity({
        id: `00000000-0000-4000-8000-${String(index).padStart(12, "0")}`,
        name: `Activity ${index}`,
        sortOrder: index,
      }),
    );
    const html = renderView({ activities: twenty });
    expect(html).toContain('data-testid="cap-warning"');
    const addButton = html.match(/<button[^>]*data-testid="activities-add"[^>]*>/);
    expect(addButton).not.toBeNull();
    expect(addButton![0]).toContain("disabled");
  });
});

// ── Editor markup: hard-stop wiring + counters + copy buttons ───────────

describe("ActivityEditor markup", () => {
  it("renders live n/limit counters for all four hard-capped fields", () => {
    const html = renderEditor(makeFullDraft());
    expect(html).toContain('data-testid="counter-ca-position"');
    expect(html).toContain(
      `${"Founder & President".length}/${COMMON_APP_POSITION_MAX_CHARS}`,
    );
    expect(html).toContain('data-testid="counter-ca-organization"');
    expect(html).toContain('data-testid="counter-ca-description"');
    expect(html).toContain('data-testid="counter-uc-description"');
  });

  it("wires the hard stop via maxLength on every counted field", () => {
    // React's static renderer emits the attribute as `maxLength="n"`.
    const html = renderEditor(makeFullDraft()).toLowerCase();
    expect(html).toContain(`maxlength="${COMMON_APP_POSITION_MAX_CHARS}"`);
    expect(html).toContain(`maxlength="${COMMON_APP_ORGANIZATION_MAX_CHARS}"`);
    expect(html).toContain(`maxlength="${COMMON_APP_DESCRIPTION_MAX_CHARS}"`);
    expect(html).toContain(`maxlength="${UC_DESCRIPTION_MAX_CHARS}"`);
  });

  it("turns a counter red once the field reaches 90% of its limit", () => {
    const html = renderEditor(
      makeFullDraft({ caPosition: "p".repeat(COMMON_APP_POSITION_MAX_CHARS - 5) }),
    );
    const counter = html.match(
      /<span[^>]*data-testid="counter-ca-position"[^>]*>/,
    );
    expect(counter).not.toBeNull();
    expect(counter![0]).toContain("text-destructive");
  });

  it("renders a copy button per platform field", () => {
    const html = renderEditor(makeFullDraft());
    expect(html).toContain('aria-label="Copy position"');
    expect(html).toContain('aria-label="Copy organization"');
    expect(html).toContain('aria-label="Copy Common App description"');
    expect(html).toContain('aria-label="Copy UC description"');
  });

  it("disables a copy button while its field is empty", () => {
    const html = renderEditor(makeFullDraft({ ucDescription: "" }));
    const copyButton = html.match(
      /<button[^>]*aria-label="Copy UC description"[^>]*>/,
    );
    expect(copyButton).not.toBeNull();
    expect(copyButton![0]).toContain("disabled");
  });
});
