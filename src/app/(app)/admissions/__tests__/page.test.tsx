import { renderToStaticMarkup } from "react-dom/server";
import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  auth: vi.fn(),
  requireCounselorOrAdmin: vi.fn(),
  getCaseIdForParentEmail: vi.fn(),
  getCaseIdForStudentEmail: vi.fn(),
  getCaseloadForUser: vi.fn(),
  listCohorts: vi.fn(),
  listCounselors: vi.fn(),
  listResources: vi.fn(),
}));

vi.mock("next/navigation", () => ({ redirect: vi.fn() }));
vi.mock("@/lib/auth", () => ({ auth: mocks.auth }));
vi.mock("@/lib/admissions/access", () => ({
  requireCounselorOrAdmin: mocks.requireCounselorOrAdmin,
}));
vi.mock("@/lib/admissions/cases", () => ({
  getCaseIdForParentEmail: mocks.getCaseIdForParentEmail,
  getCaseIdForStudentEmail: mocks.getCaseIdForStudentEmail,
  getCaseloadForUser: mocks.getCaseloadForUser,
}));
vi.mock("@/lib/admissions/cohorts", () => ({ listCohorts: mocks.listCohorts }));
vi.mock("@/lib/admissions/counselors", () => ({ listCounselors: mocks.listCounselors }));
vi.mock("@/lib/admissions/resources", () => ({ listResources: mocks.listResources }));
vi.mock("@/components/admissions/caseload-shell", () => ({
  CaseloadShell: ({ viewerRole }: { viewerRole: string }) => (
    <div data-testid="caseload">{viewerRole}</div>
  ),
  CaseloadSkeleton: () => null,
}));

import { AdmissionsBody } from "../page";

beforeEach(() => {
  vi.clearAllMocks();
  mocks.auth.mockResolvedValue({
    user: { email: "staff@example.com", role: "counselor" },
  });
  mocks.getCaseloadForUser.mockResolvedValue([]);
  mocks.listCohorts.mockResolvedValue([]);
  mocks.listCounselors.mockResolvedValue([]);
  mocks.listResources.mockResolvedValue([]);
});

describe("admissions landing-page staff authorization", () => {
  it("fails closed for a counselor whose stale session outlives registry revocation", async () => {
    mocks.requireCounselorOrAdmin.mockRejectedValue(new Error("Forbidden"));

    const html = renderToStaticMarkup(await AdmissionsBody());

    expect(html).toContain("No access");
    expect(mocks.getCaseloadForUser).not.toHaveBeenCalled();
    expect(mocks.listCohorts).not.toHaveBeenCalled();
  });

  it("uses the current database-resolved role for the staff workspace", async () => {
    mocks.auth.mockResolvedValue({
      user: { email: "staff@example.com", role: null },
    });
    mocks.requireCounselorOrAdmin.mockResolvedValue({
      email: "staff@example.com",
      role: "counselor",
      isAdmin: false,
    });

    const html = renderToStaticMarkup(await AdmissionsBody());

    expect(html).toContain("counselor");
    expect(mocks.requireCounselorOrAdmin).toHaveBeenCalledWith("staff@example.com");
    expect(mocks.getCaseloadForUser).toHaveBeenCalledWith("staff@example.com");
  });
});
