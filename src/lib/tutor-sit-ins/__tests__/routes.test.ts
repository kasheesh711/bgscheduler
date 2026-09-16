import { beforeEach, describe, expect, it, vi } from "vitest";
import { GET } from "@/app/api/tutor-sit-ins/route";
import { PUT } from "@/app/api/tutor-sit-ins/reports/[reportId]/route";
import { requireSitInAccess } from "../access";
import { overview, saveReport } from "../service";
import { SitInError } from "../model";
import { EMPTY_REPORT } from "../rubric";
import { sitInError } from "../http";
vi.mock("../access", () => ({ requireSitInAccess: vi.fn() }));
vi.mock("../service", () => ({ overview: vi.fn(), saveReport: vi.fn() }));
const access = {
  email: "head@example.test",
  role: "observer" as const,
  departments: ["physics" as const],
  canonicalKey: "head",
};
const reportId = "aaaaaaaa-aaaa-4aaa-aaaa-aaaaaaaaaaaa";
const context = { params: Promise.resolve({ reportId }) };
beforeEach(() => {
  vi.resetAllMocks();
  vi.mocked(requireSitInAccess).mockResolvedValue(access);
});
describe("Tutor Sit-ins HTTP boundaries", () => {
  it.each([401, 403, 503])(
    "denies reads before fetching dashboard data (%s)",
    async (status) => {
      vi.mocked(requireSitInAccess).mockRejectedValue(
        new SitInError(status, "Access unavailable"),
      );
      const response = await GET(
        new Request("https://app.test/api/tutor-sit-ins"),
      );
      expect(response.status).toBe(status);
      expect(overview).not.toHaveBeenCalled();
      expect(response.headers.get("cache-control")).toBe("private, no-store");
    },
  );
  it("rejects an invalid quarter and never caches private data", async () => {
    expect(
      (
        await GET(
          new Request("https://app.test/api/tutor-sit-ins?quarter=2026-Q3"),
        )
      ).status,
    ).toBe(400);
    vi.mocked(overview).mockResolvedValue({ quarter: "2026-Q4" } as Awaited<
      ReturnType<typeof overview>
    >);
    const response = await GET(
      new Request("https://app.test/api/tutor-sit-ins?quarter=2026-Q4"),
    );
    expect(response.headers.get("cache-control")).toBe("private, no-store");
    expect(overview).toHaveBeenCalledWith(access, "2026-Q4");
  });
  it.each([undefined, "https://untrusted.test"])(
    "denies a mutation without its same-origin evidence (%s)",
    async (origin) => {
      const response = await PUT(
        new Request("https://app.test/api/tutor-sit-ins/reports/" + reportId, {
          method: "PUT",
          headers: origin ? { origin } : undefined,
          body: JSON.stringify({
            expectedRevision: 0,
            submit: false,
            data: EMPTY_REPORT,
          }),
        }),
        context,
      );
      expect(response.status).toBe(403);
      expect(saveReport).not.toHaveBeenCalled();
    },
  );
  it("returns a conflict without disclosing a database constraint or query", async () => {
    const response = sitInError({
      cause: { code: "23505", detail: "private database details" },
    });
    expect(response.status).toBe(409);
    expect(JSON.stringify(await response.json())).not.toContain(
      "private database details",
    );
  });
});
