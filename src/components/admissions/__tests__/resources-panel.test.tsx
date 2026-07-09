import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";

vi.mock("next/navigation", () => ({
  useRouter: vi.fn(() => ({ replace: vi.fn(), push: vi.fn(), refresh: vi.fn() })),
}));

import {
  EMPTY_RESOURCE_FORM,
  ResourcesPanel,
  buildResourcePayload,
  canManageResources,
} from "../resources-panel";
import type { AdmissionsResourceTopicGroup } from "@/lib/admissions/resources";
import type { CaseRole } from "@/lib/admissions/types";

// ── Fixtures ────────────────────────────────────────────────────────────

const ESSAY_RESOURCE = {
  id: "11111111-aaaa-4aaa-8aaa-111111111111",
  topic: "essays",
  title: "College Essay Guy",
  url: "https://www.collegeessayguy.com",
  sortOrder: 0,
  createdAt: "2026-07-01T03:00:00.000Z",
  updatedAt: "2026-07-01T03:00:00.000Z",
};

const GENERAL_RESOURCE = {
  id: "22222222-bbbb-4bbb-8bbb-222222222222",
  topic: "general",
  title: "Program handbook",
  url: "https://example.com/handbook",
  sortOrder: 0,
  createdAt: "2026-07-02T03:00:00.000Z",
  updatedAt: "2026-07-02T03:00:00.000Z",
};

const GROUPS: AdmissionsResourceTopicGroup[] = [
  { topic: "essays", label: "Essays", resources: [ESSAY_RESOURCE] },
  { topic: "general", label: "General", resources: [GENERAL_RESOURCE] },
];

function renderPanel(overrides: {
  viewerRole?: CaseRole;
  groups?: AdmissionsResourceTopicGroup[];
} = {}): string {
  return renderToStaticMarkup(
    <ResourcesPanel
      groups={overrides.groups ?? GROUPS}
      viewerRole={overrides.viewerRole ?? "student"}
    />,
  );
}

// ── Pure helpers ────────────────────────────────────────────────────────

describe("canManageResources", () => {
  it("allows counselors and admins only (design §4)", () => {
    expect(canManageResources("admin")).toBe(true);
    expect(canManageResources("counselor")).toBe(true);
    expect(canManageResources("student")).toBe(false);
    expect(canManageResources("parent")).toBe(false);
  });
});

describe("buildResourcePayload", () => {
  const VALID = {
    topic: "essays",
    title: "College Essay Guy",
    url: "https://www.collegeessayguy.com",
  };

  it("rejects a missing topic choice (no default — explicit pick required)", () => {
    const result = buildResourcePayload({ ...VALID, topic: "" });
    expect(result.ok).toBe(false);
    expect(EMPTY_RESOURCE_FORM.topic).toBe("");
  });

  it("rejects a blank title", () => {
    const result = buildResourcePayload({ ...VALID, title: "  " });
    expect(result).toEqual({ ok: false, error: "Resource title is required." });
  });

  it("rejects http and non-https URLs", () => {
    for (const url of ["http://insecure.example.com", "ftp://x.example.com", "", "essayguy.com"]) {
      const result = buildResourcePayload({ ...VALID, url });
      expect(result.ok).toBe(false);
    }
  });

  it("builds a trimmed body for a valid form", () => {
    const result = buildResourcePayload({
      topic: "essays",
      title: "  College Essay Guy ",
      url: " https://www.collegeessayguy.com ",
    });
    expect(result).toEqual({
      ok: true,
      body: {
        topic: "essays",
        title: "College Essay Guy",
        url: "https://www.collegeessayguy.com",
      },
    });
  });
});

// ── Read-only (student/parent) affordances ──────────────────────────────

describe("ResourcesPanel read-only variant", () => {
  it("renders topic groups with external links for a student", () => {
    const html = renderPanel({ viewerRole: "student" });
    expect(html).toContain('data-testid="resources-panel"');
    expect(html).toContain('data-testid="resource-group-essays"');
    expect(html).toContain('data-testid="resource-group-general"');
    expect(html).toContain("College Essay Guy");
    expect(html).toContain("Program handbook");
    // External links open in a new tab with the safe rel.
    expect(html).toContain('href="https://www.collegeessayguy.com"');
    expect(html).toContain('target="_blank"');
    expect(html).toContain('rel="noreferrer"');
  });

  it("shows NO manage affordances to students or parents (fail-closed)", () => {
    for (const viewerRole of ["student", "parent"] as const) {
      const html = renderPanel({ viewerRole });
      expect(html).not.toContain('data-testid="resource-add-form"');
      expect(html).not.toContain('data-testid="resource-submit"');
      expect(html).not.toContain(`data-testid="resource-edit-${ESSAY_RESOURCE.id}"`);
      expect(html).not.toContain(`data-testid="resource-delete-${ESSAY_RESOURCE.id}"`);
      expect(html).not.toContain("Add resource");
    }
  });

  it("shows the plain empty state when the library is empty", () => {
    const html = renderPanel({ viewerRole: "student", groups: [] });
    expect(html).toContain("No resources yet.");
    expect(html).not.toContain("Add the first one above");
  });
});

// ── Staff affordances ───────────────────────────────────────────────────

describe("ResourcesPanel staff variant", () => {
  it("renders the add form plus per-resource edit/delete for a counselor", () => {
    const html = renderPanel({ viewerRole: "counselor" });
    expect(html).toContain('data-testid="resource-add-form"');
    expect(html).toContain('data-testid="resource-submit"');
    expect(html).toContain(`data-testid="resource-edit-${ESSAY_RESOURCE.id}"`);
    expect(html).toContain(`data-testid="resource-delete-${ESSAY_RESOURCE.id}"`);
    expect(html).toContain(`data-testid="resource-edit-${GENERAL_RESOURCE.id}"`);
    // Topic select offers the canonical topics (10 phases + General).
    expect(html).toContain('value="about_you"');
    expect(html).toContain('value="general"');
  });

  it("keeps the same affordances for an admin viewer", () => {
    const html = renderPanel({ viewerRole: "admin" });
    expect(html).toContain('data-testid="resource-add-form"');
    expect(html).toContain(`data-testid="resource-delete-${ESSAY_RESOURCE.id}"`);
  });

  it("disables the add submit until the form validates (empty form)", () => {
    const html = renderPanel({ viewerRole: "counselor" });
    const submit = html.match(/<button[^>]*data-testid="resource-submit"[^>]*>/);
    expect(submit).not.toBeNull();
    expect(submit![0]).toContain("disabled");
  });

  it("shows the staff empty state with the add hint", () => {
    const html = renderPanel({ viewerRole: "counselor", groups: [] });
    expect(html).toContain("No resources yet. Add the first one above.");
  });

  it("keeps the delete-confirmation dialog closed until a delete is requested", () => {
    // Delete is destructive on a shared org-wide library — it must never fire
    // from the row button directly; the confirm dialog opens first and stays
    // unmounted (closed) in the initial render.
    const html = renderPanel({ viewerRole: "counselor" });
    expect(html).toContain(`data-testid="resource-delete-${ESSAY_RESOURCE.id}"`);
    expect(html).not.toContain('data-testid="resource-delete-dialog"');
    expect(html).not.toContain('data-testid="resource-delete-confirm"');
  });
});
