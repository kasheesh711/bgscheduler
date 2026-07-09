import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";

vi.mock("next/navigation", () => ({
  useRouter: vi.fn(() => ({ replace: vi.fn(), push: vi.fn(), refresh: vi.fn() })),
}));

import {
  AddEssayFormFields,
  EMPTY_ADD_ESSAY_FORM,
  ESSAY_STALENESS_AMBER_DAYS,
  ESSAY_STATUS_LABELS,
  EssayStalenessBadge,
  EssaysView,
  buildAddEssayPayload,
  canSubmitAddEssay,
  formatStalenessLabel,
  isEssayOverdue,
  isStalenessAmber,
  type EssayCollegeOption,
} from "../essays-view";
import type { AdmissionsEssayListRowDto } from "@/lib/admissions/essays";
import type { CaseRole } from "@/lib/admissions/types";

// ── Fixtures ────────────────────────────────────────────────────────────

const CASE_ID = "6a1f4c1e-2222-4444-8888-aaaaaaaaaaaa";

const COLLEGE_OPTIONS: EssayCollegeOption[] = [
  { id: "11111111-aaaa-4aaa-8aaa-111111111111", instName: "Harvard University" },
  { id: "22222222-bbbb-4bbb-8bbb-222222222222", instName: "University of Tokyo" },
];

function makeEssay(
  overrides: Partial<AdmissionsEssayListRowDto> & { id: string },
): AdmissionsEssayListRowDto {
  return {
    caseId: CASE_ID,
    listItemId: null,
    prompt: "Essay prompt",
    status: "drafting",
    counselorStage: null,
    deadline: null,
    driveUrl: null,
    lastStudentUpdateAt: "2026-07-01T03:00:00.000Z",
    createdAt: "2026-06-01T03:00:00.000Z",
    updatedAt: "2026-07-01T03:00:00.000Z",
    stalenessDays: 3,
    effectiveStage: "drafting",
    ...overrides,
  };
}

// Overdue, never-student-updated row linked to a live college.
const OVERDUE_ROW = makeEssay({
  id: "33333333-cccc-4ccc-8ccc-333333333333",
  listItemId: COLLEGE_OPTIONS[0].id,
  prompt: "Why Harvard supplement",
  deadline: "2020-01-15",
  stalenessDays: null,
  lastStudentUpdateAt: null,
});

// Fresh row with a counselor-confirmed stage and a Drive link.
const CONFIRMED_ROW = makeEssay({
  id: "44444444-dddd-4ddd-8ddd-444444444444",
  prompt: "Common App personal statement",
  status: "feedback",
  counselorStage: "drafting",
  effectiveStage: "drafting",
  driveUrl: "https://docs.google.com/document/d/abc",
  stalenessDays: 0,
});

// Stale-but-not-overdue undated row.
const STALE_ROW = makeEssay({
  id: "55555555-eeee-4eee-8eee-555555555555",
  prompt: "Leadership short answer",
  stalenessDays: 21,
});

function renderView(overrides: {
  essays?: AdmissionsEssayListRowDto[];
  viewerRole?: CaseRole;
  variant?: "student" | "staff";
} = {}): string {
  return renderToStaticMarkup(
    <EssaysView
      caseId={CASE_ID}
      essays={overrides.essays ?? [OVERDUE_ROW, CONFIRMED_ROW, STALE_ROW]}
      collegeOptions={COLLEGE_OPTIONS}
      viewerRole={overrides.viewerRole ?? "student"}
      variant={overrides.variant ?? "student"}
    />,
  );
}

// ── Staleness helpers (CM-61 thresholds) ────────────────────────────────

describe("formatStalenessLabel", () => {
  it("labels never-updated, today, singular, and plural day counts", () => {
    expect(formatStalenessLabel(null)).toBe("Never updated");
    expect(formatStalenessLabel(0)).toBe("Updated today");
    expect(formatStalenessLabel(1)).toBe("Updated 1 day ago");
    expect(formatStalenessLabel(14)).toBe("Updated 14 days ago");
  });
});

describe("isStalenessAmber", () => {
  it("turns amber exactly at the 14-day threshold", () => {
    expect(ESSAY_STALENESS_AMBER_DAYS).toBe(14);
    expect(isStalenessAmber(13)).toBe(false);
    expect(isStalenessAmber(14)).toBe(true);
    expect(isStalenessAmber(21)).toBe(true);
  });

  it("treats never-updated (null) as amber and fresh rows as calm", () => {
    expect(isStalenessAmber(null)).toBe(true);
    expect(isStalenessAmber(0)).toBe(false);
  });
});

describe("EssayStalenessBadge", () => {
  it("renders the label with data-amber reflecting the threshold", () => {
    const amber = renderToStaticMarkup(<EssayStalenessBadge stalenessDays={14} />);
    expect(amber).toContain("Updated 14 days ago");
    expect(amber).toContain('data-amber="true"');

    const calm = renderToStaticMarkup(<EssayStalenessBadge stalenessDays={2} />);
    expect(calm).toContain("Updated 2 days ago");
    expect(calm).toContain('data-amber="false"');

    const never = renderToStaticMarkup(<EssayStalenessBadge stalenessDays={null} />);
    expect(never).toContain("Never updated");
    expect(never).toContain('data-amber="true"');
  });
});

// ── Overdue chip helper ─────────────────────────────────────────────────

describe("isEssayOverdue", () => {
  const today = "2026-07-09";

  it("is overdue only for past-dated rows that are not final", () => {
    expect(isEssayOverdue({ deadline: "2026-07-08", effectiveStage: "drafting" }, today)).toBe(true);
    expect(isEssayOverdue({ deadline: "2026-07-09", effectiveStage: "drafting" }, today)).toBe(false);
    expect(isEssayOverdue({ deadline: null, effectiveStage: "drafting" }, today)).toBe(false);
    expect(isEssayOverdue({ deadline: "2026-07-08", effectiveStage: "final" }, today)).toBe(false);
  });
});

// ── Add-form validation (CM-60) ─────────────────────────────────────────

describe("canSubmitAddEssay", () => {
  it("requires a non-blank prompt", () => {
    expect(canSubmitAddEssay(EMPTY_ADD_ESSAY_FORM)).toBe(false);
    expect(canSubmitAddEssay({ ...EMPTY_ADD_ESSAY_FORM, prompt: "   " })).toBe(false);
    expect(canSubmitAddEssay({ ...EMPTY_ADD_ESSAY_FORM, prompt: "Why us?" })).toBe(true);
  });
});

describe("buildAddEssayPayload", () => {
  it("trims the prompt and collapses empty optional fields to null", () => {
    expect(
      buildAddEssayPayload(
        { prompt: "  Why us? ", listItemId: "", deadline: "", driveUrl: " " },
        false,
      ),
    ).toEqual({ prompt: "Why us?", listItemId: null, driveUrl: null });
  });

  it("includes the deadline for staff only (§2.4 counselor+ field)", () => {
    const values = {
      prompt: "Why us?",
      listItemId: COLLEGE_OPTIONS[0].id,
      deadline: "2026-11-01",
      driveUrl: "https://docs.google.com/document/d/abc",
    };
    expect(buildAddEssayPayload(values, true)).toEqual({
      prompt: "Why us?",
      listItemId: COLLEGE_OPTIONS[0].id,
      driveUrl: "https://docs.google.com/document/d/abc",
      deadline: "2026-11-01",
    });
    // A student payload NEVER carries a deadline, even if form state has one.
    expect(buildAddEssayPayload(values, false)).toEqual({
      prompt: "Why us?",
      listItemId: COLLEGE_OPTIONS[0].id,
      driveUrl: "https://docs.google.com/document/d/abc",
    });
  });

  it("sends an empty staff deadline as an explicit null", () => {
    expect(
      buildAddEssayPayload({ ...EMPTY_ADD_ESSAY_FORM, prompt: "Why us?" }, true),
    ).toEqual({ prompt: "Why us?", listItemId: null, driveUrl: null, deadline: null });
  });
});

describe("AddEssayFormFields", () => {
  const noop = () => undefined;

  it("hides the deadline field from non-staff (§2.4)", () => {
    const html = renderToStaticMarkup(
      <AddEssayFormFields
        values={EMPTY_ADD_ESSAY_FORM}
        collegeOptions={COLLEGE_OPTIONS}
        showDeadline={false}
        onChange={noop}
      />,
    );
    expect(html).not.toContain('data-testid="add-essay-deadline"');
    expect(html).not.toContain('type="date"');
  });

  it("shows the deadline field and the case's college options for staff", () => {
    const html = renderToStaticMarkup(
      <AddEssayFormFields
        values={EMPTY_ADD_ESSAY_FORM}
        collegeOptions={COLLEGE_OPTIONS}
        showDeadline={true}
        onChange={noop}
      />,
    );
    expect(html).toContain('data-testid="add-essay-deadline"');
    expect(html).toContain("No college (personal statement)");
    expect(html).toContain("Harvard University");
    expect(html).toContain("University of Tokyo");
  });
});

// ── Role-aware rendering (§2.4 write split) ─────────────────────────────

describe("EssaysView role gates", () => {
  it("gives students the status select but never counselor-stage or deadline controls", () => {
    const html = renderView({ viewerRole: "student", variant: "student" });
    expect(html).toContain(`aria-label="Status for ${OVERDUE_ROW.prompt}"`);
    expect(html).not.toContain("Counselor stage for");
    expect(html).not.toContain('type="date"');
  });

  it("keeps counselor-stage read-only even when a student gets the staff layout (fail-closed)", () => {
    const html = renderView({ viewerRole: "student", variant: "staff" });
    expect(html).toContain(`aria-label="Status for ${CONFIRMED_ROW.prompt}"`);
    expect(html).not.toContain("Counselor stage for");
  });

  it("shows students the counselor-stage badge only when set", () => {
    const html = renderView({ viewerRole: "student" });
    const occurrences = html.split('data-testid="counselor-stage-badge"').length - 1;
    expect(occurrences).toBe(1);
    expect(html).toContain(`Counselor: ${ESSAY_STATUS_LABELS.drafting}`);
  });

  it("gives counselors the editable counselor-stage select with a clear option", () => {
    const html = renderView({ viewerRole: "counselor", variant: "staff" });
    expect(html).toContain(`aria-label="Counselor stage for ${CONFIRMED_ROW.prompt}"`);
    expect(html).toContain("No override");
    expect(html).not.toContain('data-testid="counselor-stage-badge"');
  });

  it("renders parents fully read-only: no selects, no add button", () => {
    const html = renderView({ viewerRole: "parent" });
    expect(html).not.toContain("<select");
    expect(html).not.toContain('data-testid="add-essay"');
    expect(html).toContain(ESSAY_STATUS_LABELS.feedback);
  });

  it("offers the add-essay button to students and staff alike (self-report surface)", () => {
    expect(renderView({ viewerRole: "student" })).toContain('data-testid="add-essay"');
    expect(renderView({ viewerRole: "counselor", variant: "staff" })).toContain(
      'data-testid="add-essay"',
    );
  });
});

// ── List rendering ──────────────────────────────────────────────────────

describe("EssaysView list", () => {
  it("respects the lib's CM-63 order without re-sorting", () => {
    // Deliberately NOT deadline-ascending: the component must trust the lib.
    const essays = [STALE_ROW, OVERDUE_ROW, CONFIRMED_ROW];
    const html = renderView({ essays });
    const positions = essays.map((row) => html.indexOf(row.prompt));
    expect(positions.every((index) => index >= 0)).toBe(true);
    expect(positions[0]).toBeLessThan(positions[1]);
    expect(positions[1]).toBeLessThan(positions[2]);
  });

  it("renders the deadline chip with overdue styling for past open essays", () => {
    const html = renderView();
    expect(html).toContain('data-testid="essay-deadline"');
    expect(html).toContain("Due 15/1/2020");
    expect(html).toContain("Overdue");
  });

  it("does not mark a final essay's past deadline overdue", () => {
    const finalRow = makeEssay({
      id: "66666666-ffff-4fff-8fff-666666666666",
      prompt: "Finished supplement",
      status: "final",
      effectiveStage: "final",
      deadline: "2020-01-15",
    });
    const html = renderView({ essays: [finalRow] });
    expect(html).toContain("Due 15/1/2020");
    expect(html).not.toContain("Overdue");
  });

  it("links the Drive button for http(s) URLs only", () => {
    const html = renderView();
    expect(html).toContain('data-testid="essay-drive-link"');
    expect(html).toContain('href="https://docs.google.com/document/d/abc"');
    const noLink = renderView({
      essays: [makeEssay({ id: OVERDUE_ROW.id, driveUrl: "not a url" })],
    });
    expect(noLink).not.toContain('data-testid="essay-drive-link"');
  });

  it("resolves linked college names and flags removed list items", () => {
    const html = renderView();
    expect(html).toContain("Harvard University");
    const removed = renderView({
      essays: [
        makeEssay({
          id: OVERDUE_ROW.id,
          listItemId: "99999999-9999-4999-8999-999999999999",
        }),
      ],
    });
    expect(removed).toContain("College no longer on the list");
  });

  it("renders the staff variant as a table and the student variant as cards", () => {
    const staff = renderView({ viewerRole: "counselor", variant: "staff" });
    expect(staff).toContain("<table");
    expect(staff).toContain("Counselor stage");
    expect(staff).toContain("Last update");
    const student = renderView({ viewerRole: "student", variant: "student" });
    expect(student).not.toContain("<table");
  });

  it("shows role-appropriate empty states", () => {
    expect(renderView({ essays: [] })).toContain(
      "No essays yet — add your first prompt to start tracking.",
    );
    expect(renderView({ essays: [], viewerRole: "parent" })).toContain(
      "No essays tracked yet.",
    );
  });
});
