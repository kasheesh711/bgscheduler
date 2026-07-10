import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";

vi.mock("next/navigation", () => ({
  useRouter: vi.fn(() => ({ replace: vi.fn(), push: vi.fn(), refresh: vi.fn() })),
}));

import {
  AnnouncementsPanel,
  EMPTY_ANNOUNCEMENT_FORM,
  buildAnnouncementPayload,
  canComposeAnnouncement,
  type AnnouncementFormValues,
} from "../announcements-panel";
import type { AdmissionsAnnouncementDto } from "@/lib/admissions/announcements";
import type { CaseRole } from "@/lib/admissions/types";

// ── Fixtures ────────────────────────────────────────────────────────────

const CASE_ID = "6a1f4c1e-2222-4444-8888-aaaaaaaaaaaa";
const COHORT_ID = "22222222-2222-4222-8222-222222222222";

const COHORT_ANNOUNCEMENT: AdmissionsAnnouncementDto = {
  id: "11111111-aaaa-4aaa-8aaa-111111111111",
  cohortId: COHORT_ID,
  caseId: null,
  title: "Common App opens Friday",
  body: "Everyone should create an account this week.",
  authorEmail: "counselor.may@example.com",
  createdAt: "2026-07-05T03:00:00.000Z",
  updatedAt: "2026-07-05T03:00:00.000Z",
};

const CASE_ANNOUNCEMENT: AdmissionsAnnouncementDto = {
  id: "22222222-bbbb-4bbb-8bbb-222222222222",
  cohortId: null,
  caseId: CASE_ID,
  title: "Interview scheduled",
  body: "Mock interview booked for next Tuesday.",
  authorEmail: "counselor.may@example.com",
  createdAt: "2026-07-04T03:00:00.000Z",
  updatedAt: "2026-07-04T03:00:00.000Z",
};

function renderPanel(overrides: {
  viewerRole?: CaseRole;
  announcements?: AdmissionsAnnouncementDto[];
} = {}): string {
  return renderToStaticMarkup(
    <AnnouncementsPanel
      caseId={CASE_ID}
      cohortId={COHORT_ID}
      cohortName="Class of 2027"
      announcements={overrides.announcements ?? [COHORT_ANNOUNCEMENT, CASE_ANNOUNCEMENT]}
      viewerRole={overrides.viewerRole ?? "counselor"}
    />,
  );
}

// ── Pure helpers ────────────────────────────────────────────────────────

describe("canComposeAnnouncement", () => {
  it("allows counselors and admins only (design §2.2)", () => {
    expect(canComposeAnnouncement("admin")).toBe(true);
    expect(canComposeAnnouncement("counselor")).toBe(true);
    expect(canComposeAnnouncement("student")).toBe(false);
    expect(canComposeAnnouncement("parent")).toBe(false);
  });
});

describe("buildAnnouncementPayload", () => {
  const VALID: AnnouncementFormValues = {
    title: "Deadline moved",
    body: "The ED deadline moved to Nov 15.",
    scope: "case",
  };

  it("rejects a blank title", () => {
    const result = buildAnnouncementPayload({ ...VALID, title: "  " }, CASE_ID, COHORT_ID);
    expect(result).toEqual({ ok: false, error: "Announcement title is required." });
  });

  it("rejects a blank body", () => {
    const result = buildAnnouncementPayload({ ...VALID, body: "" }, CASE_ID, COHORT_ID);
    expect(result).toEqual({ ok: false, error: "Announcement body is required." });
  });

  it("rejects a missing scope choice (no default — explicit pick required)", () => {
    const result = buildAnnouncementPayload({ ...VALID, scope: null }, CASE_ID, COHORT_ID);
    expect(result.ok).toBe(false);
    expect(EMPTY_ANNOUNCEMENT_FORM.scope).toBeNull();
  });

  it("builds a case-scoped body carrying ONLY caseId", () => {
    const result = buildAnnouncementPayload(VALID, CASE_ID, COHORT_ID);
    expect(result).toEqual({
      ok: true,
      body: { caseId: CASE_ID, title: "Deadline moved", body: "The ED deadline moved to Nov 15." },
    });
    if (result.ok) {
      expect("cohortId" in result.body).toBe(false);
    }
  });

  it("builds a cohort-scoped body carrying ONLY cohortId", () => {
    const result = buildAnnouncementPayload({ ...VALID, scope: "cohort" }, CASE_ID, COHORT_ID);
    expect(result).toEqual({
      ok: true,
      body: { cohortId: COHORT_ID, title: "Deadline moved", body: "The ED deadline moved to Nov 15." },
    });
    if (result.ok) {
      expect("caseId" in result.body).toBe(false);
    }
  });

  it("trims title and body before sending", () => {
    const result = buildAnnouncementPayload(
      { title: "  Hi  ", body: "  There  ", scope: "case" },
      CASE_ID,
      COHORT_ID,
    );
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.body.title).toBe("Hi");
      expect(result.body.body).toBe("There");
    }
  });
});

// ── Rendering ───────────────────────────────────────────────────────────

describe("AnnouncementsPanel composer", () => {
  it("shows the composer with a scope radio for counselors", () => {
    const html = renderPanel({ viewerRole: "counselor" });
    expect(html).toContain('data-testid="announcement-submit"');
    expect(html).toContain("This case only");
    expect(html).toContain("Whole cohort (Class of 2027)");
    expect(html).toContain('name="announcement-scope"');
    // No scope is preselected — the author must choose explicitly.
    expect(html).not.toContain('checked=""');
  });

  it("disables submit until title, body, and scope are provided", () => {
    const html = renderPanel({ viewerRole: "admin" });
    const submit = html.match(/<button[^>]*data-testid="announcement-submit"[^>]*>/);
    expect(submit).not.toBeNull();
    expect(submit![0]).toContain("disabled");
  });

  it("hides the composer from students and parents but keeps the list", () => {
    for (const viewerRole of ["student", "parent"] as const) {
      const html = renderPanel({ viewerRole });
      expect(html).not.toContain('data-testid="announcement-submit"');
      expect(html).not.toContain('name="announcement-scope"');
      expect(html).toContain("Common App opens Friday");
      expect(html).toContain("Interview scheduled");
    }
  });
});

describe("AnnouncementsPanel list", () => {
  it("renders announcements with scope badges, author, and body", () => {
    const html = renderPanel();
    const items = html.match(/data-testid="announcement-item"/g) ?? [];
    expect(items).toHaveLength(2);
    expect(html).toContain("Cohort broadcast");
    expect(html).toContain("This case</span>");
    expect(html).toContain("Everyone should create an account this week.");
    expect(html).toContain("counselor.may@example.com");
  });

  it("renders role-appropriate empty states", () => {
    expect(renderPanel({ announcements: [] })).toContain(
      "No announcements yet. Post the first one above.",
    );
    expect(renderPanel({ announcements: [], viewerRole: "parent" })).toContain(
      "No announcements yet.",
    );
  });
});
