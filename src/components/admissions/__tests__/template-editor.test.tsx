import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";

vi.mock("next/navigation", () => ({
  useRouter: vi.fn(() => ({ replace: vi.fn(), push: vi.fn(), refresh: vi.fn() })),
}));

import {
  TemplateEditor,
  TemplateWorkspace,
  buildCreateVersionBody,
  computeItemKeys,
  makeUniqueItemKey,
  moveEditorItem,
  slugifyItemKey,
  toEditorItems,
  type TemplateEditorItem,
} from "../template-editor";
import type { AdmissionsCohortDto } from "@/lib/admissions/types";
import type {
  AdmissionsTemplateDto,
  AdmissionsTemplateVersionDto,
} from "@/lib/admissions/checklists";

// ── Fixtures ────────────────────────────────────────────────────────────

const COHORT_ID = "aaaaaaaa-1111-4111-8111-aaaaaaaaaaaa";

const COHORTS: AdmissionsCohortDto[] = [
  { id: COHORT_ID, name: "Class of 2027", graduationYear: 2027 },
  { id: "bbbbbbbb-2222-4222-8222-bbbbbbbbbbbb", name: "Class of 2028", graduationYear: 2028 },
];

const LATEST_ID = "cccccccc-3333-4333-8333-cccccccccccc";
const V1_ID = "dddddddd-4444-4444-8444-dddddddddddd";

const LATEST: AdmissionsTemplateDto = {
  id: LATEST_ID,
  cohortId: COHORT_ID,
  version: 2,
  name: "Checklist v2",
  publishedAt: null,
  items: [
    {
      id: "11111111-aaaa-4aaa-8aaa-111111111111",
      templateId: LATEST_ID,
      itemKey: "essay_first_draft",
      phase: "essays",
      title: "Essay first draft",
      description: "Common App personal statement.",
      defaultOwner: "student",
      sortOrder: 1,
    },
    {
      id: "22222222-bbbb-4bbb-8bbb-222222222222",
      templateId: LATEST_ID,
      itemKey: "about_you_survey",
      phase: "about_you",
      title: "About You survey",
      description: null,
      defaultOwner: "student",
      sortOrder: 0,
    },
  ],
  createdAt: "2026-07-01T03:00:00.000Z",
  updatedAt: "2026-07-01T03:00:00.000Z",
};

const VERSIONS: AdmissionsTemplateVersionDto[] = [
  {
    id: LATEST_ID,
    cohortId: COHORT_ID,
    version: 2,
    name: "Checklist v2",
    publishedAt: null,
    createdAt: "2026-07-01T03:00:00.000Z",
    updatedAt: "2026-07-01T03:00:00.000Z",
  },
  {
    id: V1_ID,
    cohortId: COHORT_ID,
    version: 1,
    name: "SummitEd default checklist",
    publishedAt: "2026-06-01T03:00:00.000Z",
    createdAt: "2026-06-01T03:00:00.000Z",
    updatedAt: "2026-06-01T03:00:00.000Z",
  },
];

function makeItem(overrides: Partial<TemplateEditorItem> = {}): TemplateEditorItem {
  return {
    itemKey: null,
    phase: "essays",
    title: "Essay first draft",
    description: "",
    defaultOwner: "student",
    ...overrides,
  };
}

function renderWorkspace(overrides: {
  latest?: AdmissionsTemplateDto | null;
  versions?: AdmissionsTemplateVersionDto[];
} = {}): string {
  return renderToStaticMarkup(
    <TemplateWorkspace
      cohortId={COHORT_ID}
      latest={overrides.latest === undefined ? LATEST : overrides.latest}
      versions={overrides.versions ?? VERSIONS}
      onSaved={() => undefined}
    />,
  );
}

// ── Key derivation (ITEMKEY RULE) ───────────────────────────────────────

describe("slugifyItemKey", () => {
  it("lowercases and collapses non-alphanumeric runs to underscores", () => {
    expect(slugifyItemKey("Write Common-App essay!")).toBe("write_common_app_essay");
    expect(slugifyItemKey("  FAFSA & CSS Profile  ")).toBe("fafsa_css_profile");
  });

  it("satisfies the route's ^[a-z][a-z0-9_]*$ shape on degenerate titles", () => {
    expect(slugifyItemKey("!!!")).toBe("item");
    expect(slugifyItemKey("")).toBe("item");
    expect(slugifyItemKey("3 recommendation letters")).toBe("item_3_recommendation_letters");
  });
});

describe("makeUniqueItemKey", () => {
  it("returns the base slug when free", () => {
    expect(makeUniqueItemKey("Essay draft", ["other_key"])).toBe("essay_draft");
  });

  it("appends the first free numeric suffix on collision", () => {
    expect(makeUniqueItemKey("Essay draft", ["essay_draft"])).toBe("essay_draft_2");
    expect(makeUniqueItemKey("Essay draft", ["essay_draft", "essay_draft_2"])).toBe(
      "essay_draft_3",
    );
  });
});

describe("computeItemKeys", () => {
  it("keeps prefilled itemKeys VERBATIM even when the title was edited", () => {
    const keys = computeItemKeys([
      makeItem({ itemKey: "essay_first_draft", title: "Totally renamed title" }),
      makeItem({ itemKey: "about_you_survey", title: "About You survey" }),
    ]);
    expect(keys).toEqual(["essay_first_draft", "about_you_survey"]);
  });

  it("derives new-item keys from titles with collision suffixes against ALL current keys", () => {
    const keys = computeItemKeys([
      makeItem({ itemKey: "essay_draft", title: "old" }),
      makeItem({ itemKey: null, title: "Essay draft" }),
      makeItem({ itemKey: null, title: "Essay Draft?" }),
    ]);
    expect(keys).toEqual(["essay_draft", "essay_draft_2", "essay_draft_3"]);
  });

  it("reserves prefilled keys up front so a new item never steals a later row's key", () => {
    const keys = computeItemKeys([
      makeItem({ itemKey: null, title: "About you survey" }),
      makeItem({ itemKey: "about_you_survey", title: "About You survey" }),
    ]);
    expect(keys).toEqual(["about_you_survey_2", "about_you_survey"]);
  });
});

// ── Prefill ─────────────────────────────────────────────────────────────

describe("toEditorItems", () => {
  it("prefills from the latest version keeping itemKeys verbatim, sorted by sortOrder", () => {
    const items = toEditorItems(LATEST);
    expect(items.map((item) => item.itemKey)).toEqual([
      "about_you_survey",
      "essay_first_draft",
    ]);
    expect(items[0]).toEqual({
      itemKey: "about_you_survey",
      phase: "about_you",
      title: "About You survey",
      description: "",
      defaultOwner: "student",
    });
  });

  it("returns an empty editor for a cohort with no template", () => {
    expect(toEditorItems(null)).toEqual([]);
  });
});

// ── Reorder ─────────────────────────────────────────────────────────────

describe("moveEditorItem", () => {
  const A = makeItem({ itemKey: "a", phase: "essays", title: "A" });
  const B = makeItem({ itemKey: "b", phase: "testing", title: "B" });
  const C = makeItem({ itemKey: "c", phase: "essays", title: "C" });

  it("swaps with the adjacent SAME-PHASE neighbour, skipping other phases", () => {
    const moved = moveEditorItem([A, B, C], 2, "up");
    expect(moved.map((item) => item.itemKey)).toEqual(["c", "b", "a"]);
  });

  it("moves an item down within its phase", () => {
    const moved = moveEditorItem([A, B, C], 0, "down");
    expect(moved.map((item) => item.itemKey)).toEqual(["c", "b", "a"]);
  });

  it("is a no-op at the phase-group boundary", () => {
    expect(moveEditorItem([A, B, C], 0, "up").map((item) => item.itemKey)).toEqual([
      "a",
      "b",
      "c",
    ]);
    expect(moveEditorItem([A, B, C], 2, "down").map((item) => item.itemKey)).toEqual([
      "a",
      "b",
      "c",
    ]);
  });

  it("recomputes sortOrder from the new order in the POST payload", () => {
    const moved = moveEditorItem([A, C], 1, "up");
    const result = buildCreateVersionBody(moved);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.body.items.map((item) => [item.itemKey, item.sortOrder])).toEqual([
      ["c", 0],
      ["a", 1],
    ]);
  });
});

// ── create_version POST body ────────────────────────────────────────────

describe("buildCreateVersionBody", () => {
  it("blocks an empty item list before submit", () => {
    expect(buildCreateVersionBody([])).toEqual({
      ok: false,
      error: "Add at least one checklist item before saving.",
    });
  });

  it("blocks blank titles before submit", () => {
    const result = buildCreateVersionBody([makeItem({ title: "   " })]);
    expect(result).toEqual({ ok: false, error: "Every checklist item needs a title." });
  });

  it("builds the exact create_version body: canonical phase order, sortOrder 0..n-1, verbatim + derived keys", () => {
    const result = buildCreateVersionBody(
      [
        makeItem({
          itemKey: "essay_first_draft",
          phase: "essays",
          title: "  Essay first draft ",
          description: "  Common App ",
        }),
        makeItem({ itemKey: null, phase: "about_you", title: "About You survey" }),
        makeItem({ itemKey: null, phase: "testing", title: "Register for SAT!" }),
      ],
      { name: "  Fall refresh " },
    );
    expect(result).toEqual({
      ok: true,
      body: {
        action: "create_version",
        name: "Fall refresh",
        items: [
          {
            itemKey: "about_you_survey",
            phase: "about_you",
            title: "About You survey",
            description: null,
            defaultOwner: "student",
            sortOrder: 0,
          },
          {
            itemKey: "register_for_sat",
            phase: "testing",
            title: "Register for SAT!",
            description: null,
            defaultOwner: "student",
            sortOrder: 1,
          },
          {
            itemKey: "essay_first_draft",
            phase: "essays",
            title: "Essay first draft",
            description: "Common App",
            defaultOwner: "student",
            sortOrder: 2,
          },
        ],
      },
    });
  });

  it("includes publish: true only for Save & publish", () => {
    const items = [makeItem({ itemKey: "a", title: "A" })];
    const draft = buildCreateVersionBody(items, { publish: false });
    const published = buildCreateVersionBody(items, { publish: true });
    expect(draft.ok && "publish" in draft.body).toBe(false);
    expect(published.ok && published.body.publish).toBe(true);
  });

  it("omits name when blank", () => {
    const result = buildCreateVersionBody([makeItem({ itemKey: "a", title: "A" })], {
      name: "   ",
    });
    expect(result.ok && "name" in result.body).toBe(false);
  });
});

// ── Workspace rendering ─────────────────────────────────────────────────

describe("TemplateWorkspace", () => {
  it("lists version history with Draft badge + Publish on unpublished versions only", () => {
    const html = renderWorkspace();
    expect(html).toContain('data-testid="template-version-2"');
    expect(html).toContain('data-testid="template-version-1"');
    expect(html).toContain(">Draft<");
    // Publish is offered for the v2 draft, not the published v1.
    expect(html).toContain('data-testid="template-publish-2"');
    expect(html).not.toContain('data-testid="template-publish-1"');
    expect(html).toContain("Published");
  });

  it("keeps the publish-confirmation dialog closed until Publish is requested", () => {
    // Publishing is irreversible (published versions are immutable), so it
    // must never fire from the row button directly — the confirm dialog stays
    // unmounted in the initial render.
    const html = renderWorkspace();
    expect(html).not.toContain('data-testid="template-publish-dialog"');
    expect(html).not.toContain('data-testid="template-publish-confirm"');
  });

  it("prefills the editor from the latest version with verbatim, non-editable itemKeys", () => {
    const html = renderWorkspace();
    expect(html).toContain('data-testid="template-item-about_you_survey"');
    expect(html).toContain('data-testid="template-item-essay_first_draft"');
    expect(html).toContain(">about_you_survey<");
    expect(html).toContain('value="Essay first draft"');
    // Locked keys are rendered as text, never as an input value.
    expect(html).not.toContain('value="about_you_survey"');
  });

  it("renders all 10 phase groups each with an Add item action", () => {
    const html = renderWorkspace();
    for (const phaseKey of [
      "about_you",
      "academics",
      "testing",
      "activities",
      "college_research",
      "essays",
      "recommendations",
      "applications",
      "decisions_aid",
      "transition",
    ]) {
      expect(html).toContain(`data-testid="template-phase-${phaseKey}"`);
      expect(html).toContain(`data-testid="template-add-item-${phaseKey}"`);
    }
  });

  it("shows the empty-cohort editor state when no template exists", () => {
    const html = renderWorkspace({ latest: null, versions: [] });
    expect(html).toContain("No template versions yet");
    expect(html).toContain("saving creates version 1");
    expect(html).toContain('data-testid="template-save-draft"');
    expect(html).toContain('data-testid="template-save-publish"');
  });
});

// ── Editor shell rendering ──────────────────────────────────────────────

describe("TemplateEditor", () => {
  it("renders the cohort select and a prompt before a cohort is chosen", () => {
    const html = renderToStaticMarkup(
      <TemplateEditor
        cohorts={COHORTS}
        selectedCohortId={null}
        onSelectCohort={() => undefined}
      />,
    );
    expect(html).toContain('data-testid="template-editor"');
    expect(html).toContain('data-testid="template-cohort-select"');
    expect(html).toContain(`value="${COHORT_ID}"`);
    expect(html).toContain("Class of 2027");
    expect(html).toContain("Choose a cohort to view and edit its checklist template.");
    // No workspace until the lazy fetch resolves for a selected cohort.
    expect(html).not.toContain('data-testid="template-workspace"');
  });
});
