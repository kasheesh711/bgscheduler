import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";

vi.mock("next/navigation", () => ({
  useRouter: vi.fn(() => ({ replace: vi.fn(), push: vi.fn(), refresh: vi.fn() })),
}));

import type {
  AdmissionsCaseSummary,
  AdmissionsCohortDto,
  AdmissionsCounselorDto,
  CaseRole,
} from "@/lib/admissions/types";
import { CaseloadShell, computeCaseloadKpis } from "../caseload-shell";

function summary(overrides: Partial<AdmissionsCaseSummary> = {}): AdmissionsCaseSummary {
  return {
    caseId: overrides.caseId ?? "case-1",
    studentId: overrides.studentId ?? "student-1",
    studentName: overrides.studentName ?? "Ada Lovelace",
    preferredName: overrides.preferredName === undefined ? null : overrides.preferredName,
    cohortId: overrides.cohortId ?? "cohort-1",
    cohortName: overrides.cohortName ?? "Class of 2027",
    graduationYear: overrides.graduationYear ?? 2027,
    status: overrides.status ?? "active",
    counselorEmails: overrides.counselorEmails ?? ["mint@bg.com"],
    counselorNames: overrides.counselorNames ?? ["Mint"],
    progressPercent: overrides.progressPercent ?? 0,
    nextDeadline: overrides.nextDeadline ?? null,
    daysSinceLastTouch: overrides.daysSinceLastTouch === undefined ? null : overrides.daysSinceLastTouch,
    committedCollegeName: overrides.committedCollegeName ?? null,
    updatedAt: overrides.updatedAt ?? "2026-07-01T00:00:00.000Z",
  };
}

describe("computeCaseloadKpis", () => {
  it("counts totals and per-status buckets", () => {
    const kpis = computeCaseloadKpis([
      summary({ caseId: "c1", status: "active" }),
      summary({ caseId: "c2", status: "active" }),
      summary({ caseId: "c3", status: "committed" }),
      summary({ caseId: "c4", status: "archived" }),
    ]);
    expect(kpis.totalCases).toBe(4);
    expect(kpis.statusCounts).toEqual({
      active: 2,
      committed: 1,
      completed: 0,
      withdrawn: 0,
      archived: 1,
    });
  });

  it("returns zeros for an empty caseload", () => {
    const kpis = computeCaseloadKpis([]);
    expect(kpis.totalCases).toBe(0);
    expect(Object.values(kpis.statusCounts).every((count) => count === 0)).toBe(true);
  });
});

// ── Manage affordance (admin-only) ──────────────────────────────────────

const COHORTS: AdmissionsCohortDto[] = [
  { id: "11111111-aaaa-4aaa-8aaa-111111111111", name: "Class of 2027", graduationYear: 2027 },
];

const COUNSELORS: AdmissionsCounselorDto[] = [
  {
    id: "22222222-bbbb-4bbb-8bbb-222222222222",
    email: "mint@bg.com",
    name: "Mint",
    active: true,
    createdAt: "2026-07-01T00:00:00.000Z",
    updatedAt: "2026-07-01T00:00:00.000Z",
  },
];

function renderShell(viewerRole: CaseRole): string {
  return renderToStaticMarkup(
    <CaseloadShell
      caseload={[summary()]}
      cohorts={COHORTS}
      counselors={COUNSELORS}
      resourceGroups={[]}
      viewerRole={viewerRole}
    />,
  );
}

describe("CaseloadShell manage affordance", () => {
  it("shows the Manage button to admins only", () => {
    const html = renderShell("admin");
    expect(html).toContain('data-testid="open-manage"');
    expect(html).toContain("Manage");
  });

  it("hides the Manage button (and its dialog) from counselors", () => {
    const html = renderShell("counselor");
    expect(html).not.toContain('data-testid="open-manage"');
    expect(html).not.toContain('data-testid="manage-panel"');
    // Non-admin affordances stay intact.
    expect(html).toContain('data-testid="open-resources"');
    expect(html).toContain("New case");
  });

  it("keeps the manage dialog closed (unmounted) until the button is pressed", () => {
    const html = renderShell("admin");
    expect(html).not.toContain('data-testid="manage-panel"');
  });
});
