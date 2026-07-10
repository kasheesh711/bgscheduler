import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";

vi.mock("next/navigation", () => ({
  useRouter: vi.fn(() => ({ replace: vi.fn(), push: vi.fn(), refresh: vi.fn() })),
  usePathname: vi.fn(() => "/admissions/6a1f4c1e-2222-4444-8888-aaaaaaaaaaaa"),
  useSearchParams: vi.fn(() => null),
}));

import {
  EMPTY_SITTING_FORM,
  TestingView,
  buildSittingPatch,
  formatDeadlinePreview,
  isRegistrationOverdue,
  scoreSendStatusForSitting,
  sortSittingsChronologically,
  toSittingFormValues,
  type TestingViewCollege,
} from "../testing-view";
import type {
  AdmissionsBestScore,
  AdmissionsTestSittingDto,
} from "@/lib/admissions/testing";
import type { AdmissionsCollegeDocDto } from "@/lib/admissions/recommenders";
import type { CaseRole } from "@/lib/admissions/types";

// ── Fixtures ────────────────────────────────────────────────────────────

const CASE_ID = "6a1f4c1e-2222-4444-8888-aaaaaaaaaaaa";

const COLLEGES: TestingViewCollege[] = [
  { id: "11111111-aaaa-4aaa-8aaa-111111111111", instName: "Harvard University" },
  { id: "22222222-bbbb-4bbb-8bbb-222222222222", instName: "Tufts University" },
];
const [HARVARD, TUFTS] = COLLEGES;

function makeSitting(
  overrides: Partial<AdmissionsTestSittingDto> & { id: string },
): AdmissionsTestSittingDto {
  return {
    caseId: CASE_ID,
    testType: "sat",
    testDate: "2099-10-03",
    registrationDeadline: "2099-08-29",
    targetScore: "1500",
    actualScore: null,
    scoreReleasedToParent: false,
    accommodations: null,
    createdAt: "2026-06-01T03:00:00.000Z",
    updatedAt: "2026-06-01T03:00:00.000Z",
    ...overrides,
  };
}

// Future SAT sitting — registration still open.
const FUTURE_SAT = makeSitting({
  id: "a1111111-1111-4111-8111-111111111111",
  accommodations: "Extra time (50%)",
});

// Past IELTS sitting with a score — registration deadline long gone but the
// sitting is scored, so it must NOT flag overdue.
const SCORED_IELTS = makeSitting({
  id: "b2222222-2222-4222-8222-222222222222",
  testType: "ielts",
  testDate: "2020-03-14",
  registrationDeadline: "2020-02-29",
  targetScore: "7.5",
  actualScore: "8",
  scoreReleasedToParent: true,
});

// Past TOEFL sitting, unscored — its registration deadline IS overdue.
const OVERDUE_TOEFL = makeSitting({
  id: "c3333333-3333-4333-8333-333333333333",
  testType: "toefl",
  testDate: "2021-05-01",
  registrationDeadline: "2021-04-17",
  targetScore: "100",
});

const BEST_SCORES: AdmissionsBestScore[] = [
  {
    testType: "ielts",
    sittingId: SCORED_IELTS.id,
    testDate: SCORED_IELTS.testDate,
    actualScore: "8",
    numericScore: 8,
    scoreReleasedToParent: true,
  },
];

function makeDoc(
  overrides: Partial<AdmissionsCollegeDocDto> & { id: string },
): AdmissionsCollegeDocDto {
  return {
    listItemId: HARVARD.id,
    docType: "score_send",
    testSittingId: SCORED_IELTS.id,
    sent: false,
    sentAt: null,
    createdAt: "2026-06-01T03:00:00.000Z",
    updatedAt: "2026-06-01T03:00:00.000Z",
    ...overrides,
  };
}

const DOCS: AdmissionsCollegeDocDto[] = [
  makeDoc({
    id: "d1111111-1111-4111-8111-111111111111",
    sent: true,
    sentAt: "2026-06-02T03:00:00.000Z",
  }),
  makeDoc({ id: "d2222222-2222-4222-8222-222222222222", listItemId: TUFTS.id }),
  // Transcript row must never count as a score send.
  makeDoc({
    id: "d3333333-3333-4333-8333-333333333333",
    docType: "transcript",
    testSittingId: null,
  }),
  // Score send for a different sitting.
  makeDoc({
    id: "d4444444-4444-4444-8444-444444444444",
    testSittingId: FUTURE_SAT.id,
  }),
];

function renderView(overrides: {
  sittings?: AdmissionsTestSittingDto[];
  bestScores?: AdmissionsBestScore[];
  viewerRole?: CaseRole;
  variant?: "staff" | "student";
} = {}): string {
  return renderToStaticMarkup(
    <TestingView
      caseId={CASE_ID}
      sittings={overrides.sittings ?? [FUTURE_SAT, SCORED_IELTS, OVERDUE_TOEFL]}
      bestScores={overrides.bestScores ?? BEST_SCORES}
      collegeDocs={DOCS}
      colleges={COLLEGES}
      viewerRole={overrides.viewerRole ?? "counselor"}
      variant={overrides.variant ?? "staff"}
    />,
  );
}

// ── Pure helpers ────────────────────────────────────────────────────────

describe("sortSittingsChronologically", () => {
  it("orders by test date ascending with id tiebreak, without mutating input", () => {
    const twin = makeSitting({ id: "a0000000-0000-4000-8000-000000000000" });
    const input = [FUTURE_SAT, SCORED_IELTS, OVERDUE_TOEFL, twin];
    const sorted = sortSittingsChronologically(input);
    expect(sorted.map((sitting) => sitting.id)).toEqual([
      SCORED_IELTS.id,
      OVERDUE_TOEFL.id,
      twin.id,
      FUTURE_SAT.id,
    ]);
    expect(input[0]).toBe(FUTURE_SAT);
  });
});

describe("isRegistrationOverdue", () => {
  const TODAY = "2026-07-09";

  it("flags a past deadline on an unscored sitting", () => {
    expect(isRegistrationOverdue(OVERDUE_TOEFL, TODAY)).toBe(true);
  });

  it("never flags a scored sitting (nothing left to register)", () => {
    expect(isRegistrationOverdue(SCORED_IELTS, TODAY)).toBe(false);
  });

  it("never flags a future deadline or a missing one", () => {
    expect(isRegistrationOverdue(FUTURE_SAT, TODAY)).toBe(false);
    expect(
      isRegistrationOverdue({ registrationDeadline: null, actualScore: null }, TODAY),
    ).toBe(false);
  });
});

describe("formatDeadlinePreview (registration-deadline preview per test type)", () => {
  it("derives SAT/ACT deadlines 35 days before the sitting (CM-80)", () => {
    expect(formatDeadlinePreview("sat", "2026-10-03")).toBe(
      "Registration closes 29/8/2026.",
    );
    expect(formatDeadlinePreview("act", "2026-10-03")).toBe(
      "Registration closes 29/8/2026.",
    );
  });

  it("derives TOEFL/IELTS deadlines 14 days before the sitting", () => {
    expect(formatDeadlinePreview("toefl", "2026-10-03")).toBe(
      "Registration closes 19/9/2026.",
    );
    expect(formatDeadlinePreview("ielts", "2026-10-03")).toBe(
      "Registration closes 19/9/2026.",
    );
  });

  it("never guesses a deadline for AP/IB/other (fail-closed)", () => {
    expect(formatDeadlinePreview("ap", "2026-10-03")).toContain(
      "No auto-derived registration deadline for AP",
    );
    expect(formatDeadlinePreview("ib", "2026-10-03")).toContain(
      "No auto-derived registration deadline for IB",
    );
    expect(formatDeadlinePreview("other", "2026-10-03")).toContain(
      "No auto-derived registration deadline for Other test",
    );
  });

  it("prompts for a date while the test date is empty or malformed", () => {
    expect(formatDeadlinePreview("sat", "")).toBe(
      "Pick a test date to preview the registration deadline.",
    );
    expect(formatDeadlinePreview("sat", "03/10/2026")).toBe(
      "Pick a test date to preview the registration deadline.",
    );
  });
});

describe("scoreSendStatusForSitting", () => {
  it("returns only the sitting's score-send rows with resolved names", () => {
    expect(scoreSendStatusForSitting(DOCS, COLLEGES, SCORED_IELTS.id)).toEqual([
      { listItemId: HARVARD.id, instName: "Harvard University", sent: true },
      { listItemId: TUFTS.id, instName: "Tufts University", sent: false },
    ]);
  });

  it("ignores non-score-send docs and falls back for removed colleges", () => {
    expect(scoreSendStatusForSitting(DOCS, [], FUTURE_SAT.id)).toEqual([
      { listItemId: HARVARD.id, instName: "Removed college", sent: false },
    ]);
    expect(scoreSendStatusForSitting(DOCS, COLLEGES, OVERDUE_TOEFL.id)).toEqual([]);
  });
});

describe("toSittingFormValues", () => {
  it("maps nulls to empty strings for the controlled form", () => {
    expect(toSittingFormValues(makeSitting({ id: "e1", registrationDeadline: null }))).toEqual({
      testType: "sat",
      testDate: "2099-10-03",
      registrationDeadline: "",
      targetScore: "1500",
      actualScore: "",
      accommodations: "",
    });
  });
});

describe("buildSittingPatch", () => {
  const INITIAL = toSittingFormValues(FUTURE_SAT);

  it("returns null when nothing changed (no request fired)", () => {
    expect(buildSittingPatch(INITIAL, { ...INITIAL })).toBeNull();
    expect(buildSittingPatch(EMPTY_SITTING_FORM, { ...EMPTY_SITTING_FORM })).toBeNull();
  });

  it("includes only the changed fields", () => {
    expect(buildSittingPatch(INITIAL, { ...INITIAL, testDate: "2099-11-07" })).toEqual({
      testDate: "2099-11-07",
    });
    expect(buildSittingPatch(INITIAL, { ...INITIAL, testType: "act" })).toEqual({
      testType: "act",
    });
  });

  it("clears emptied optional fields with null and trims scores", () => {
    expect(
      buildSittingPatch(INITIAL, {
        ...INITIAL,
        registrationDeadline: "",
        actualScore: " 1450 ",
        accommodations: "  ",
        targetScore: " 1550 ",
      }),
    ).toEqual({
      registrationDeadline: null,
      actualScore: "1450",
      accommodations: null,
      targetScore: "1550",
    });
  });
});

// ── Rendering ───────────────────────────────────────────────────────────

describe("TestingView sittings list", () => {
  it("renders sittings chronologically with type badges and D/M dates", () => {
    const html = renderView();
    const ielts = html.indexOf(`data-testid="test-type-${SCORED_IELTS.id}"`);
    const toefl = html.indexOf(`data-testid="test-type-${OVERDUE_TOEFL.id}"`);
    const sat = html.indexOf(`data-testid="test-type-${FUTURE_SAT.id}"`);
    expect(ielts).toBeGreaterThan(-1);
    expect(ielts).toBeLessThan(toefl);
    expect(toefl).toBeLessThan(sat);
    expect(html).toContain("IELTS");
    expect(html).toContain("TOEFL");
    expect(html).toContain("SAT");
    expect(html).toContain("14/3/2020");
    expect(html).toContain("3/10/2099");
  });

  it("marks an overdue registration deadline red; open/scored ones stay muted", () => {
    const html = renderView();
    const overdueChip = html.match(
      new RegExp(`<span[^>]*data-testid="registration-chip-${OVERDUE_TOEFL.id}"[^>]*>`),
    );
    expect(overdueChip).not.toBeNull();
    expect(overdueChip![0]).toContain("text-conflict");
    expect(html).toContain("Register by 17/4/2021 · Overdue");

    const scoredChip = html.match(
      new RegExp(`<span[^>]*data-testid="registration-chip-${SCORED_IELTS.id}"[^>]*>`),
    );
    expect(scoredChip).not.toBeNull();
    expect(scoredChip![0]).not.toContain("text-conflict");
    const futureChip = html.match(
      new RegExp(`<span[^>]*data-testid="registration-chip-${FUTURE_SAT.id}"[^>]*>`),
    );
    expect(futureChip![0]).not.toContain("text-conflict");
  });

  it("shows target vs actual and the accommodations note", () => {
    const html = renderView();
    expect(html).toContain("Target 1500");
    expect(html).toContain("Actual —");
    expect(html).toContain("Target 7.5");
    expect(html).toContain("Actual 8");
    expect(html).toContain("Accommodations: Extra time (50%)");
  });

  it("renders per-college score-send status chips for the sitting (CM-82)", () => {
    const html = renderView();
    const sends = html.match(
      new RegExp(
        `<ul[^>]*data-testid="score-sends-${SCORED_IELTS.id}"[^>]*>[\\s\\S]*?</ul>`,
      ),
    );
    expect(sends).not.toBeNull();
    expect(sends![0]).toContain("Harvard University: Sent");
    expect(sends![0]).toContain("Tufts University: Pending");
    expect(html).not.toContain(`data-testid="score-sends-${OVERDUE_TOEFL.id}"`);
  });

  it("summarizes best scores and shows an empty note without any", () => {
    const html = renderView();
    expect(html).toContain('data-testid="best-score-ielts"');
    expect(html).toContain("IELTS 8");
    expect(renderView({ bestScores: [] })).toContain("No scores recorded yet.");
  });
});

describe("TestingView release-to-parent toggle (CM-83)", () => {
  it("renders for counselor+ on the staff variant with the released state", () => {
    const html = renderView({ variant: "staff", viewerRole: "counselor" });
    const released = html.match(
      new RegExp(`<input[^>]*data-testid="release-toggle-${SCORED_IELTS.id}"[^>]*>`),
    );
    expect(released).not.toBeNull();
    expect(released![0]).toContain("checked");
    const unreleased = html.match(
      new RegExp(`<input[^>]*data-testid="release-toggle-${FUTURE_SAT.id}"[^>]*>`),
    );
    expect(unreleased![0]).not.toContain("checked");
  });

  it("never renders on the student variant, even for a counselor", () => {
    const html = renderView({ variant: "student", viewerRole: "counselor" });
    expect(html).not.toContain('data-testid="release-toggle-');
  });

  it("never renders for a student viewer on the staff variant (fail-closed)", () => {
    const html = renderView({ variant: "staff", viewerRole: "student" });
    expect(html).not.toContain('data-testid="release-toggle-');
  });
});

describe("TestingView add/edit form", () => {
  it("shows the add form with the deadline preview prompt for writers", () => {
    const html = renderView({ variant: "student", viewerRole: "student" });
    expect(html).toContain('data-testid="sitting-form"');
    expect(html).toContain('data-testid="sitting-type-select"');
    expect(html).toContain("Add a sitting");
    const preview = html.match(
      /<p[^>]*data-testid="deadline-preview"[^>]*>([^<]*)<\/p>/,
    );
    expect(preview).not.toBeNull();
    expect(preview![1]).toBe("Pick a test date to preview the registration deadline.");
  });

  it("renders read-only for parents: no form, no edit buttons", () => {
    const html = renderView({ variant: "student", viewerRole: "parent" });
    expect(html).not.toContain('data-testid="sitting-form"');
    expect(html).not.toContain('data-testid="sitting-edit-');
    expect(html).not.toContain('data-testid="release-toggle-');
    expect(renderView({ viewerRole: "parent", sittings: [] })).toContain(
      "No test sittings recorded yet.",
    );
  });

  it("offers an edit affordance per sitting for writers", () => {
    const html = renderView({ variant: "staff", viewerRole: "counselor" });
    expect(html).toContain(`data-testid="sitting-edit-${FUTURE_SAT.id}"`);
    expect(html).toContain(`data-testid="sitting-edit-${SCORED_IELTS.id}"`);
  });
});
