import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";

vi.mock("next/navigation", () => ({
  useRouter: vi.fn(() => ({ replace: vi.fn(), push: vi.fn(), refresh: vi.fn() })),
}));

import {
  INITIAL_MANAGE_TAB,
  MANAGE_TABS,
  ManagePanel,
  openTemplateForCohort,
  resolveManageTab,
} from "../manage-panel";
import type { ManageTab } from "../manage-panel";
import type { AdmissionsCohortDto, AdmissionsCounselorDto } from "@/lib/admissions/types";

// ── Fixtures ────────────────────────────────────────────────────────────

const COHORT_2027: AdmissionsCohortDto = {
  id: "11111111-aaaa-4aaa-8aaa-111111111111",
  name: "Class of 2027",
  graduationYear: 2027,
};

const COHORT_2028: AdmissionsCohortDto = {
  id: "22222222-bbbb-4bbb-8bbb-222222222222",
  name: "Class of 2028",
  graduationYear: 2028,
};

const ACTIVE_COUNSELOR: AdmissionsCounselorDto = {
  id: "33333333-cccc-4ccc-8ccc-333333333333",
  email: "mint@bg.com",
  name: "Mint",
  active: true,
  createdAt: "2026-07-01T00:00:00.000Z",
  updatedAt: "2026-07-01T00:00:00.000Z",
};

const INACTIVE_COUNSELOR: AdmissionsCounselorDto = {
  id: "44444444-dddd-4ddd-8ddd-444444444444",
  email: "gone@bg.com",
  name: "Gone",
  active: false,
  createdAt: "2026-07-01T00:00:00.000Z",
  updatedAt: "2026-07-01T00:00:00.000Z",
};

function renderPanel(overrides: { initialTab?: ManageTab; initialCohortId?: string | null } = {}) {
  return renderToStaticMarkup(
    <ManagePanel
      counselors={[ACTIVE_COUNSELOR, INACTIVE_COUNSELOR]}
      cohorts={[COHORT_2027, COHORT_2028]}
      initialTab={overrides.initialTab}
      initialCohortId={overrides.initialCohortId}
    />,
  );
}

// ── Pure helpers ────────────────────────────────────────────────────────

describe("resolveManageTab", () => {
  it("passes every known tab key through", () => {
    for (const tab of MANAGE_TABS) {
      expect(resolveManageTab(tab.key)).toBe(tab.key);
    }
  });

  it("falls back to the initial tab for unknown values (fail-closed)", () => {
    expect(resolveManageTab("nonsense")).toBe(INITIAL_MANAGE_TAB);
    expect(resolveManageTab(null)).toBe(INITIAL_MANAGE_TAB);
    expect(resolveManageTab(undefined)).toBe(INITIAL_MANAGE_TAB);
    expect(resolveManageTab(42)).toBe(INITIAL_MANAGE_TAB);
  });
});

describe("openTemplateForCohort", () => {
  it("jumps to the Templates tab with the cohort preselected", () => {
    expect(openTemplateForCohort(COHORT_2027.id)).toEqual({
      activeTab: "templates",
      selectedCohortId: COHORT_2027.id,
    });
  });
});

// ── Tab hosting ─────────────────────────────────────────────────────────

describe("ManagePanel", () => {
  it("renders all three tab triggers", () => {
    const html = renderPanel();
    expect(html).toContain('data-testid="manage-panel"');
    expect(html).toContain('data-testid="manage-tab-counselors"');
    expect(html).toContain('data-testid="manage-tab-cohorts"');
    expect(html).toContain('data-testid="manage-tab-templates"');
    expect(html).toContain("Counselors");
    expect(html).toContain("Cohorts");
    expect(html).toContain("Templates");
  });

  it("opens on the Counselors tab and mounts only that manager", () => {
    const html = renderPanel();
    expect(html).toContain('data-testid="counselors-manager"');
    expect(html).toContain(`data-testid="counselor-row-${ACTIVE_COUNSELOR.id}"`);
    expect(html).toContain(`data-testid="counselor-row-${INACTIVE_COUNSELOR.id}"`);
    expect(html).not.toContain('data-testid="cohorts-manager"');
    expect(html).not.toContain('data-testid="template-editor"');
  });

  it("mounts the cohorts manager with the edit-template hand-off on the Cohorts tab", () => {
    const html = renderPanel({ initialTab: "cohorts" });
    expect(html).toContain('data-testid="cohorts-manager"');
    expect(html).toContain(`data-testid="cohort-row-${COHORT_2027.id}"`);
    expect(html).toContain(`data-testid="cohort-edit-template-${COHORT_2027.id}"`);
    expect(html).toContain(`data-testid="cohort-edit-template-${COHORT_2028.id}"`);
    expect(html).not.toContain('data-testid="counselors-manager"');
    expect(html).not.toContain('data-testid="template-editor"');
  });

  it("mounts the template editor with the cohort picker on the Templates tab", () => {
    const html = renderPanel({ initialTab: "templates" });
    expect(html).toContain('data-testid="template-editor"');
    expect(html).toContain('data-testid="template-cohort-select"');
    expect(html).toContain("Choose a cohort to view and edit its checklist template.");
    expect(html).not.toContain('data-testid="counselors-manager"');
    expect(html).not.toContain('data-testid="cohorts-manager"');
  });

  it("preselects the jump cohort in the Templates tab (onEditTemplate landing state)", () => {
    // The stateful jump applies openTemplateForCohort verbatim; rendering the
    // panel with that state proves the editor receives the preselected cohort.
    const jump = openTemplateForCohort(COHORT_2028.id);
    const html = renderPanel({
      initialTab: jump.activeTab,
      initialCohortId: jump.selectedCohortId,
    });
    expect(html).toContain('data-testid="template-editor"');
    const optionTag = new RegExp(`<option[^>]*value="${COHORT_2028.id}"[^>]*>`).exec(html)?.[0];
    expect(optionTag).toBeDefined();
    expect(optionTag).toContain("selected");
    expect(html).not.toContain("Choose a cohort to view and edit its checklist template.");
  });
});
