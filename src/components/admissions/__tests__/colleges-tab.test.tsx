import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";

vi.mock("next/navigation", () => ({
  useRouter: vi.fn(() => ({ replace: vi.fn(), push: vi.fn(), refresh: vi.fn() })),
  usePathname: vi.fn(() => "/admissions/6a1f4c1e-2222-4444-8888-aaaaaaaaaaaa"),
  useSearchParams: vi.fn(() => null),
}));

import {
  APP_STATUS_LABELS,
  ApplicationWarningBanner,
  COLLEGE_CATEGORY_LABELS,
  CollegesTab,
  EMPTY_ADD_COLLEGE_FORM,
  buildAddCollegePayload,
  canSubmitAddCollege,
  completenessItems,
  type AddCollegeFormValues,
} from "../colleges-tab";
import type {
  AdmissionsCollegeCompleteness,
  AdmissionsCollegeListRowDto,
  ApplicationWarning,
} from "@/lib/admissions/colleges";
import type { CaseRole } from "@/lib/admissions/types";

// ── Fixtures ────────────────────────────────────────────────────────────

const CASE_ID = "6a1f4c1e-2222-4444-8888-aaaaaaaaaaaa";

const COMPLETE_ROLLUP: AdmissionsCollegeCompleteness = {
  recsAgreed: 2,
  recsSubmitted: 2,
  recsTotal: 2,
  transcriptSent: true,
  schoolReportSent: true,
  scoreSendsSent: 1,
  complete: true,
};

const PARTIAL_ROLLUP: AdmissionsCollegeCompleteness = {
  recsAgreed: 1,
  recsSubmitted: 1,
  recsTotal: 2,
  transcriptSent: true,
  schoolReportSent: false,
  scoreSendsSent: 0,
  complete: false,
};

function makeCollege(
  overrides: Partial<AdmissionsCollegeListRowDto> & { id: string },
): AdmissionsCollegeListRowDto {
  return {
    caseId: CASE_ID,
    unitId: null,
    instName: "College",
    city: null,
    stateAbbr: null,
    country: "US",
    isManual: false,
    round: "rd",
    deadline: null,
    appStatus: "researching",
    category: "unset",
    firstChoiceMajor: null,
    secondChoiceMajor: null,
    admissionsUrl: null,
    portalUrl: null,
    aidOffered: null,
    aidNotes: null,
    createdAt: "2026-07-01T03:00:00.000Z",
    updatedAt: "2026-07-01T03:00:00.000Z",
    stats: null,
    stale: false,
    completeness: null,
    ...overrides,
  };
}

// IPEDS row with live stats and a partial completeness rollup.
const IPEDS_ROW = makeCollege({
  id: "11111111-aaaa-4aaa-8aaa-111111111111",
  unitId: 166027,
  instName: "Harvard University",
  city: "Cambridge",
  stateAbbr: "MA",
  round: "rea",
  deadline: "2026-11-01",
  appStatus: "applying",
  category: "reach",
  stats: {
    dataYear: "2023-24",
    acceptanceRate: 3.4,
    totalPriceInState: 82866,
    avgNetPrice: 19500,
    gradRateBach6yr: 98,
  },
  completeness: PARTIAL_ROLLUP,
});

// Manual (non-US) row — no stats, never stale.
const MANUAL_ROW = makeCollege({
  id: "22222222-bbbb-4bbb-8bbb-222222222222",
  instName: "University of Tokyo",
  country: "Japan",
  isManual: true,
  round: "other",
  aidOffered: "25000.50",
  aidNotes: "Merit scholarship pending",
  completeness: COMPLETE_ROLLUP,
});

// Stale IPEDS row — the unitId vanished from ipeds_institutions.
const STALE_ROW = makeCollege({
  id: "33333333-cccc-4ccc-8ccc-333333333333",
  unitId: 999999,
  instName: "Vanished College",
  round: "ed",
  stale: true,
});

const ALL_ROWS = [IPEDS_ROW, MANUAL_ROW, STALE_ROW];

const ED_WARNING: ApplicationWarning = {
  code: "rea_with_early_decision",
  message:
    "Restrictive Early Action alongside an Early Decision application — REA programs prohibit concurrent ED applications.",
  listItemIds: [IPEDS_ROW.id, STALE_ROW.id],
};

function renderTab(overrides: {
  colleges?: AdmissionsCollegeListRowDto[];
  warnings?: ApplicationWarning[];
  viewerRole?: CaseRole;
} = {}): string {
  return renderToStaticMarkup(
    <CollegesTab
      caseId={CASE_ID}
      colleges={overrides.colleges ?? ALL_ROWS}
      warnings={overrides.warnings ?? []}
      recommenders={[]}
      collegeDocs={[]}
      viewerRole={overrides.viewerRole ?? "counselor"}
    />,
  );
}

// ── Add-dialog validation (CM-40 mode toggle) ───────────────────────────

describe("canSubmitAddCollege", () => {
  it("blocks IPEDS mode until an institution is selected", () => {
    expect(canSubmitAddCollege(EMPTY_ADD_COLLEGE_FORM)).toBe(false);
    expect(
      canSubmitAddCollege({ ...EMPTY_ADD_COLLEGE_FORM, unitId: 166027 }),
    ).toBe(true);
  });

  it("requires BOTH name and country in manual mode", () => {
    const manual: AddCollegeFormValues = { ...EMPTY_ADD_COLLEGE_FORM, mode: "manual" };
    expect(canSubmitAddCollege(manual)).toBe(false);
    expect(canSubmitAddCollege({ ...manual, manualName: "U of Tokyo" })).toBe(false);
    expect(canSubmitAddCollege({ ...manual, manualCountry: "Japan" })).toBe(false);
    expect(canSubmitAddCollege({ ...manual, manualName: "  ", manualCountry: "Japan" })).toBe(false);
    expect(
      canSubmitAddCollege({ ...manual, manualName: "U of Tokyo", manualCountry: "Japan" }),
    ).toBe(true);
  });

  it("re-arms validation against the active mode only when toggling modes", () => {
    // A valid IPEDS selection does not satisfy manual mode…
    const withUnit: AddCollegeFormValues = { ...EMPTY_ADD_COLLEGE_FORM, unitId: 166027 };
    expect(canSubmitAddCollege({ ...withUnit, mode: "manual" })).toBe(false);
    // …and valid manual fields do not satisfy IPEDS mode.
    const withManual: AddCollegeFormValues = {
      ...EMPTY_ADD_COLLEGE_FORM,
      mode: "manual",
      manualName: "U of Tokyo",
      manualCountry: "Japan",
    };
    expect(canSubmitAddCollege({ ...withManual, mode: "ipeds" })).toBe(false);
  });
});

describe("buildAddCollegePayload", () => {
  it("builds the unitId entry with shared plan fields (empty deadline → null)", () => {
    expect(
      buildAddCollegePayload({
        ...EMPTY_ADD_COLLEGE_FORM,
        unitId: 166027,
        round: "rea",
        category: "reach",
      }),
    ).toEqual({ unitId: 166027, round: "rea", deadline: null, category: "reach" });
  });

  it("builds the manual entry with trimmed name and country", () => {
    expect(
      buildAddCollegePayload({
        ...EMPTY_ADD_COLLEGE_FORM,
        mode: "manual",
        manualName: "  University of Tokyo ",
        manualCountry: " Japan ",
        deadline: "2026-12-15",
      }),
    ).toEqual({
      manual: { instName: "University of Tokyo", country: "Japan" },
      round: "rd",
      deadline: "2026-12-15",
      category: "unset",
    });
  });
});

// ── Completeness icons (CM-46) ──────────────────────────────────────────

describe("completenessItems", () => {
  it("marks every tracker done for a complete rollup", () => {
    const items = completenessItems(COMPLETE_ROLLUP);
    expect(items.map((item) => item.key)).toEqual([
      "recs",
      "transcript",
      "school_report",
      "scores",
    ]);
    expect(items.every((item) => item.done)).toBe(true);
    expect(items[0].label).toBe("Recommendations 2/2 submitted");
  });

  it("marks pending trackers not-done for a partial rollup", () => {
    const byKey = new Map(completenessItems(PARTIAL_ROLLUP).map((item) => [item.key, item]));
    expect(byKey.get("recs")!.done).toBe(false);
    expect(byKey.get("transcript")!.done).toBe(true);
    expect(byKey.get("school_report")!.done).toBe(false);
    expect(byKey.get("scores")!.done).toBe(false);
  });

  it("treats zero linked recommenders as vacuously done (CM-46 mirror)", () => {
    const items = completenessItems({
      ...PARTIAL_ROLLUP,
      recsSubmitted: 0,
      recsTotal: 0,
    });
    expect(items.find((item) => item.key === "recs")!.done).toBe(true);
  });
});

// ── Warning banner (CM-45) ──────────────────────────────────────────────

describe("ApplicationWarningBanner", () => {
  it("renders each warning with the affected college names", () => {
    const html = renderToStaticMarkup(
      <ApplicationWarningBanner
        warnings={[ED_WARNING]}
        collegeNamesById={
          new Map([
            [IPEDS_ROW.id, IPEDS_ROW.instName],
            [STALE_ROW.id, STALE_ROW.instName],
          ])
        }
      />,
    );
    expect(html).toContain('data-testid="application-warning-banner"');
    expect(html).toContain("Application plan warnings");
    expect(html).toContain("REA programs prohibit concurrent ED applications");
    expect(html).toContain("Harvard University, Vanished College");
  });

  it("renders nothing when the plan is clean", () => {
    expect(
      renderToStaticMarkup(
        <ApplicationWarningBanner warnings={[]} collegeNamesById={new Map()} />,
      ),
    ).toBe("");
  });
});

// ── Tab rendering ───────────────────────────────────────────────────────

describe("CollegesTab", () => {
  it("shows the ED/REA warning banner when the case detail carries warnings", () => {
    const html = renderTab({ warnings: [ED_WARNING] });
    expect(html).toContain('data-testid="application-warning-banner"');
    expect(html).toContain("Harvard University, Vanished College");
  });

  it("omits the banner when there are no warnings", () => {
    expect(renderTab()).not.toContain('data-testid="application-warning-banner"');
  });

  it("links live IPEDS rows to the us-universities profile", () => {
    const html = renderTab();
    expect(html).toContain('href="/us-universities/166027"');
  });

  it("badges manual rows and stale IPEDS fallbacks (never links them)", () => {
    const html = renderTab();
    expect(html).toContain("Manual");
    expect(html).toContain(`data-testid="stale-badge-${STALE_ROW.id}"`);
    expect(html).toContain("Stale IPEDS");
    expect(html).not.toContain('href="/us-universities/999999"');
  });

  it("renders live stats formatted and em dashes for rows without stats", () => {
    const html = renderTab({ colleges: [IPEDS_ROW] });
    expect(html).toContain("3.4%");
    expect(html).toContain("$19,500");
    expect(html).toContain("98%");
    const manualHtml = renderTab({ colleges: [MANUAL_ROW] });
    expect(manualHtml).toContain("—");
  });

  it("renders the completeness icon row with done states and the complete check", () => {
    const html = renderTab();
    // Partial rollup: transcript done, school report pending, no complete check.
    expect(html).toContain(
      `data-testid="completeness-transcript-${IPEDS_ROW.id}" data-done="true"`,
    );
    expect(html).toContain(
      `data-testid="completeness-school_report-${IPEDS_ROW.id}" data-done="false"`,
    );
    expect(html).not.toContain(`data-testid="completeness-complete-${IPEDS_ROW.id}"`);
    // Complete rollup gets the trailing check icon.
    expect(html).toContain(`data-testid="completeness-complete-${MANUAL_ROW.id}"`);
    expect(html).toContain("Recommendations 1/2 submitted");
  });

  it("renders aid amounts and notes", () => {
    const html = renderTab();
    expect(html).toContain("$25,001");
    expect(html).toContain("Merit scholarship pending");
  });

  it("gives counselors the add action, inline selects, and delete buttons", () => {
    const html = renderTab({ viewerRole: "counselor" });
    expect(html).toContain('data-testid="add-college"');
    expect(html).toContain(`aria-label="Round for ${IPEDS_ROW.instName}"`);
    expect(html).toContain(`aria-label="Remove ${MANUAL_ROW.instName} from the list"`);
  });

  it("renders read-only labels for students (no add, no selects, no delete)", () => {
    const html = renderTab({ viewerRole: "student" });
    expect(html).not.toContain('data-testid="add-college"');
    expect(html).not.toContain("<select");
    expect(html).not.toContain("aria-label=\"Remove ");
    expect(html).toContain(APP_STATUS_LABELS.applying);
    expect(html).toContain(COLLEGE_CATEGORY_LABELS.reach);
    // REA round label from the read-only cell.
    expect(html).toContain("REA");
  });

  it("shows an empty state and still hosts the recommenders panel", () => {
    const html = renderTab({ colleges: [] });
    expect(html).toContain("No colleges yet");
    expect(html).toContain('data-testid="recommenders-panel"');
  });
});
