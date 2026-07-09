import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";

vi.mock("next/navigation", () => ({
  useRouter: vi.fn(() => ({ replace: vi.fn(), push: vi.fn(), refresh: vi.fn() })),
  usePathname: vi.fn(() => "/admissions/6a1f4c1e-2222-4444-8888-aaaaaaaaaaaa"),
  useSearchParams: vi.fn(() => null),
}));

import { SectionsList } from "../sections-list";
import { SECTION_STATE_LABELS } from "../section-form";
import {
  getSectionDefinition,
  type AdmissionsSectionStateDto,
} from "@/lib/admissions/sections";
import type { CaseRole } from "@/lib/admissions/types";

// ── Fixtures ────────────────────────────────────────────────────────────

const CASE_ID = "6a1f4c1e-2222-4444-8888-aaaaaaaaaaaa";

function makeSection(
  sectionKey: "about_you" | "personality",
  overrides: Partial<AdmissionsSectionStateDto> = {},
): AdmissionsSectionStateDto {
  return {
    caseId: CASE_ID,
    sectionKey,
    definition: getSectionDefinition(sectionKey)!,
    payload: {},
    state: "draft",
    submittedAt: null,
    reviewedByEmail: null,
    updatedAt: null,
    ...overrides,
  };
}

// About You: 10 fields, 2 answered. Personality: 7 fields, submitted.
const ABOUT_YOU = makeSection("about_you", {
  payload: { preferred_name: "Mint", favorite_subjects: ["Math"] },
  updatedAt: "2026-07-01T03:00:00.000Z",
});
const PERSONALITY = makeSection("personality", {
  state: "submitted",
  submittedAt: "2026-07-02T03:00:00.000Z",
  updatedAt: "2026-07-02T03:00:00.000Z",
});

function renderList(overrides: {
  sections?: AdmissionsSectionStateDto[];
  viewerRole?: CaseRole;
  variant?: "staff" | "student";
} = {}): string {
  return renderToStaticMarkup(
    <SectionsList
      caseId={CASE_ID}
      sections={overrides.sections ?? [ABOUT_YOU, PERSONALITY]}
      viewerRole={overrides.viewerRole ?? "student"}
      variant={overrides.variant ?? "student"}
    />,
  );
}

// ── Rendering ───────────────────────────────────────────────────────────

describe("SectionsList", () => {
  it("renders a card per section with title, state chip, and completion", () => {
    const html = renderList();
    expect(html).toContain('data-testid="section-card-about_you"');
    expect(html).toContain('data-testid="section-card-personality"');
    expect(html).toContain("About You");
    expect(html).toContain("Personality");
    expect(html).toContain(SECTION_STATE_LABELS.draft);
    expect(html).toContain(SECTION_STATE_LABELS.submitted);
    const aboutYou = html.match(
      /<span[^>]*data-testid="section-completion-about_you"[^>]*>([\s\S]*?)<\/span>/,
    );
    expect(aboutYou).not.toBeNull();
    expect(aboutYou![1].replace(/<!-- -->/g, "")).toBe("2/10 answered");
    const personality = html.match(
      /<span[^>]*data-testid="section-completion-personality"[^>]*>([\s\S]*?)<\/span>/,
    );
    expect(personality![1].replace(/<!-- -->/g, "")).toBe("0/7 answered");
  });

  it("does not render any section form until a card is opened", () => {
    const html = renderList();
    expect(html).toContain('data-testid="sections-list"');
    expect(html).not.toContain('data-testid="section-form-about_you"');
    expect(html).not.toContain('data-testid="field-preferred_name"');
  });

  it("shows an empty state without sections", () => {
    expect(renderList({ sections: [] })).toContain("No sections available.");
  });
});
