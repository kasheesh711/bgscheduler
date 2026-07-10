import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";

vi.mock("next/navigation", () => ({
  useRouter: vi.fn(() => ({ replace: vi.fn(), push: vi.fn(), refresh: vi.fn() })),
  usePathname: vi.fn(() => "/admissions/6a1f4c1e-2222-4444-8888-aaaaaaaaaaaa"),
  useSearchParams: vi.fn(() => null),
}));

import {
  SECTION_STATE_LABELS,
  SectionForm,
  buildAutosavePayload,
  canSubmitSection,
  computeSectionCompletion,
} from "../section-form";
import {
  SECTION_DEFINITIONS,
  getSectionDefinition,
  type AdmissionsSectionField,
  type AdmissionsSectionStateDto,
  type AdmissionsSubmissionState,
} from "@/lib/admissions/sections";
import type { CaseRole } from "@/lib/admissions/types";

// ── Fixtures ────────────────────────────────────────────────────────────

const CASE_ID = "6a1f4c1e-2222-4444-8888-aaaaaaaaaaaa";

// The real About You definition (2 steps: basics + interests).
const ABOUT_YOU = getSectionDefinition("about_you")!;

const TEXT_FIELD: AdmissionsSectionField = {
  key: "preferred_name",
  label: "Preferred name",
  type: "text",
  maxLength: 50,
  helper: "What you like to be called day to day.",
  example: "Mint",
};

const MULTI_FIELD: AdmissionsSectionField = {
  key: "favorite_subjects",
  label: "Favorite subjects",
  type: "multiselect",
  options: ["Math", "Physics", "Music"],
  helper: "Pick every subject you genuinely enjoy.",
};

function makeSection(
  overrides: Partial<AdmissionsSectionStateDto> = {},
): AdmissionsSectionStateDto {
  return {
    caseId: CASE_ID,
    sectionKey: "about_you",
    definition: ABOUT_YOU,
    payload: {},
    state: "draft",
    submittedAt: null,
    reviewedByEmail: null,
    updatedAt: null,
    ...overrides,
  };
}

function renderForm(overrides: {
  section?: AdmissionsSectionStateDto;
  viewerRole?: CaseRole;
  variant?: "staff" | "student";
  onClose?: () => void;
} = {}): string {
  return renderToStaticMarkup(
    <SectionForm
      caseId={CASE_ID}
      section={overrides.section ?? makeSection()}
      viewerRole={overrides.viewerRole ?? "student"}
      variant={overrides.variant ?? "student"}
      onClose={overrides.onClose}
    />,
  );
}

// ── Autosave payload builder (the blur handler's decision, CM-121) ──────

describe("buildAutosavePayload (autosave fires on blur)", () => {
  it("fires with the single changed key when the blurred value differs", () => {
    expect(buildAutosavePayload(TEXT_FIELD, "Mint", undefined)).toEqual({
      preferred_name: "Mint",
    });
    expect(buildAutosavePayload(TEXT_FIELD, "Mai", "Mint")).toEqual({
      preferred_name: "Mai",
    });
  });

  it("does NOT fire when the value is unchanged (blur replays are no-ops)", () => {
    expect(buildAutosavePayload(TEXT_FIELD, "Mint", "Mint")).toBeNull();
    expect(buildAutosavePayload(TEXT_FIELD, "", undefined)).toBeNull();
  });

  it("trims before comparing and saving", () => {
    expect(buildAutosavePayload(TEXT_FIELD, "  Mint  ", "Mint")).toBeNull();
    expect(buildAutosavePayload(TEXT_FIELD, "  Mai  ", "Mint")).toEqual({
      preferred_name: "Mai",
    });
  });

  it("clears an emptied field with null", () => {
    expect(buildAutosavePayload(TEXT_FIELD, "", "Mint")).toEqual({
      preferred_name: null,
    });
    expect(buildAutosavePayload(TEXT_FIELD, "   ", "Mint")).toEqual({
      preferred_name: null,
    });
  });

  it("sends the deduped multiselect array only when membership changed", () => {
    expect(buildAutosavePayload(MULTI_FIELD, ["Math", "Music"], ["Math"])).toEqual({
      favorite_subjects: ["Math", "Music"],
    });
    expect(buildAutosavePayload(MULTI_FIELD, ["Math"], ["Math"])).toBeNull();
    expect(buildAutosavePayload(MULTI_FIELD, ["Math", "Math"], ["Math"])).toBeNull();
  });

  it("clears a multiselect with an empty array", () => {
    expect(buildAutosavePayload(MULTI_FIELD, [], ["Math"])).toEqual({
      favorite_subjects: [],
    });
    expect(buildAutosavePayload(MULTI_FIELD, [], undefined)).toBeNull();
  });
});

// ── Completion + submit gate ────────────────────────────────────────────

describe("computeSectionCompletion", () => {
  it("counts non-empty strings and non-empty arrays across all steps", () => {
    expect(computeSectionCompletion(ABOUT_YOU, {})).toEqual({
      answered: 0,
      total: 31,
      percent: 0,
    });
    expect(
      computeSectionCompletion(ABOUT_YOU, {
        preferred_name: "Mint",
        favorite_subjects: ["Math"],
        hometown: "   ",
        languages: [],
        unknown_key: "never counted",
      }),
    ).toEqual({ answered: 2, total: 31, percent: 6 });
  });
});

describe("canSubmitSection", () => {
  it("allows only a saved draft (CM-121 — a virtual draft would 409)", () => {
    expect(canSubmitSection("draft", "2026-07-01T03:00:00.000Z")).toBe(true);
    expect(canSubmitSection("draft", null)).toBe(false);
    expect(canSubmitSection("submitted", "2026-07-01T03:00:00.000Z")).toBe(false);
    expect(canSubmitSection("reviewed", "2026-07-01T03:00:00.000Z")).toBe(false);
  });
});

// ── Guided-form rendering (design §5.2) ─────────────────────────────────

describe("SectionForm steps and fields", () => {
  it("renders one dot per step and only the current step's fields", () => {
    const html = renderForm();
    expect(ABOUT_YOU.steps).toHaveLength(5);
    expect(html).toContain('data-testid="step-dot-0"');
    expect(html).toContain('data-testid="step-dot-1"');
    expect(html).toContain('data-testid="step-dot-4"');
    expect(html).toContain("Step 1 of 5: The basics");
    // Step-1 field present; step-2 field absent until Next.
    expect(html).toContain('data-testid="field-preferred_name"');
    expect(html).not.toContain('data-testid="field-favorite_subjects"');
    const currentDot = html.match(/<button[^>]*data-testid="step-dot-0"[^>]*>/);
    expect(currentDot![0]).toContain('aria-current="step"');
  });

  it("renders step dots as ≥44px step navigation, not a broken tabs pattern", () => {
    const html = renderForm();
    // No tab roles: the dots never implemented the full tablist contract
    // (aria-selected / arrow keys / tabpanels), so they must not claim it.
    expect(html).not.toContain('role="tablist"');
    expect(html).not.toContain('role="tab"');
    // Each dot button carries the §5.2 minimum touch target; the visible
    // 12px dot is an aria-hidden span inside.
    const dot = html.match(/<button[^>]*data-testid="step-dot-0"[^>]*>/);
    expect(dot![0]).toContain("min-h-11");
    expect(dot![0]).toContain("min-w-11");
  });

  it("wraps multiselect options in a ≥44px label so the option text is tappable", () => {
    // Render step 2 by making the definition single-step? Simpler: the
    // multiselect lives on step 2 — assert against the full second step via
    // the sections-list host is out of scope, so assert the label classes on
    // the first render of a section whose step 1 has the multiselect.
    const definition = {
      ...ABOUT_YOU,
      steps: [ABOUT_YOU.steps[4]],
    };
    const html = renderForm({
      section: makeSection({ definition }),
    });
    const checkbox = html.match(/<input[^>]*data-testid="field-favorite_subjects-[^"]*"[^>]*>/);
    expect(checkbox).not.toBeNull();
    // The wrapping label owns the hit area.
    const labelBlock = html.match(/<label[^>]*class="[^"]*min-h-11[^"]*"[^>]*>/);
    expect(labelBlock).not.toBeNull();
  });

  it("renders helper microcopy, example placeholders, and live char counters", () => {
    const html = renderForm({
      section: makeSection({ payload: { preferred_name: "Mint" } }),
    });
    expect(html).toContain("What you like to be called day to day.");
    expect(html).toContain('placeholder="e.g. Mint"');
    const counter = html.match(
      /<p[^>]*data-testid="char-counter-preferred_name"[^>]*>([\s\S]*?)<\/p>/,
    );
    expect(counter).not.toBeNull();
    expect(counter![1].replace(/<!-- -->/g, "")).toBe("4/50");
    // The hard stop: the input carries the definition's maxLength.
    const input = html.match(/<input[^>]*data-testid="field-preferred_name"[^>]*>/);
    expect(input![0]).toMatch(/maxlength="50"/i);
    expect(input![0]).toContain('value="Mint"');
  });
});

describe("SectionForm submit state chip flow (CM-121)", () => {
  it("shows Draft with submit disabled until the first save materializes the row", () => {
    const html = renderForm();
    expect(html).toContain(SECTION_STATE_LABELS.draft);
    const submit = html.match(/<button[^>]*data-testid="section-submit"[^>]*>/);
    expect(submit).not.toBeNull();
    expect(submit![0]).toContain('disabled=""');
    expect(html).toContain("Save at least one answer before submitting for review.");
  });

  it("enables submit on a saved draft", () => {
    const html = renderForm({
      section: makeSection({
        payload: { preferred_name: "Mint" },
        updatedAt: "2026-07-01T03:00:00.000Z",
      }),
    });
    const submit = html.match(/<button[^>]*data-testid="section-submit"[^>]*>/);
    expect(submit![0]).not.toContain('disabled=""');
  });

  it.each<AdmissionsSubmissionState>(["submitted", "reviewed"])(
    "chips a %s section and warns that editing returns it to draft",
    (state) => {
      const html = renderForm({
        section: makeSection({
          state,
          payload: { preferred_name: "Mint" },
          submittedAt: "2026-07-01T03:00:00.000Z",
          updatedAt: "2026-07-01T03:00:00.000Z",
        }),
      });
      const chip = html.match(
        /<span[^>]*data-testid="section-state-chip"[^>]*>([\s\S]*?)<\/span>/,
      );
      expect(chip).not.toBeNull();
      expect(chip![1]).toContain(SECTION_STATE_LABELS[state]);
      expect(html).toContain('data-testid="submitted-edit-warning"');
      expect(html).toContain("returns it to Draft");
      // Submit is spent until an edit reverts the state.
      const submit = html.match(/<button[^>]*data-testid="section-submit"[^>]*>/);
      expect(submit![0]).toContain('disabled=""');
    },
  );

  it("shows no revert warning on a plain draft", () => {
    const html = renderForm({
      section: makeSection({ updatedAt: "2026-07-01T03:00:00.000Z" }),
    });
    expect(html).not.toContain('data-testid="submitted-edit-warning"');
  });
});

describe("SectionForm review action (staff variant only)", () => {
  const SUBMITTED = makeSection({
    state: "submitted",
    payload: { preferred_name: "Mint" },
    submittedAt: "2026-07-01T03:00:00.000Z",
    updatedAt: "2026-07-01T03:00:00.000Z",
  });

  it("offers Mark reviewed to a counselor on the staff variant", () => {
    const html = renderForm({
      section: SUBMITTED,
      viewerRole: "counselor",
      variant: "staff",
    });
    expect(html).toContain('data-testid="section-review"');
    expect(html).toContain("Mark reviewed");
  });

  it("never offers review on the student variant, even to a counselor", () => {
    const html = renderForm({
      section: SUBMITTED,
      viewerRole: "counselor",
      variant: "student",
    });
    expect(html).not.toContain('data-testid="section-review"');
  });

  it("never offers review to a student on the staff variant (fail-closed)", () => {
    const html = renderForm({
      section: SUBMITTED,
      viewerRole: "student",
      variant: "staff",
    });
    expect(html).not.toContain('data-testid="section-review"');
  });

  it("hides review once the section is reviewed", () => {
    const html = renderForm({
      section: makeSection({
        state: "reviewed",
        payload: { preferred_name: "Mint" },
        updatedAt: "2026-07-01T03:00:00.000Z",
        reviewedByEmail: "counselor.may@example.com",
      }),
      viewerRole: "counselor",
      variant: "staff",
    });
    expect(html).not.toContain('data-testid="section-review"');
  });
});

describe("SectionForm parent read-only render", () => {
  it("disables every input and hides submit and the edit warning", () => {
    const html = renderForm({
      section: makeSection({
        state: "submitted",
        payload: { preferred_name: "Mint" },
        updatedAt: "2026-07-01T03:00:00.000Z",
      }),
      viewerRole: "parent",
      variant: "student",
    });
    const input = html.match(/<input[^>]*data-testid="field-preferred_name"[^>]*>/);
    expect(input![0]).toContain("disabled");
    expect(html).not.toContain('data-testid="section-submit"');
    expect(html).not.toContain('data-testid="submitted-edit-warning"');
  });
});

describe("SectionForm back affordance", () => {
  it("renders the back button only when onClose is provided", () => {
    expect(renderForm({ onClose: () => undefined })).toContain(
      'data-testid="section-form-back"',
    );
    expect(renderForm()).not.toContain('data-testid="section-form-back"');
  });
});

// Sanity: the real definitions stay compatible with the form contract.
describe("SECTION_DEFINITIONS form contract", () => {
  it("keeps 5–10 fields per step (design §5.2)", () => {
    for (const definition of SECTION_DEFINITIONS) {
      for (const step of definition.steps) {
        expect(step.fields.length).toBeGreaterThanOrEqual(5);
        expect(step.fields.length).toBeLessThanOrEqual(10);
      }
    }
  });
});
