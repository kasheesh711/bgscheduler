import { beforeEach, describe, expect, it, vi } from "vitest";
import { NextRequest } from "next/server";

vi.mock("@/lib/db", () => ({ getDb: vi.fn(() => ({})) }));
vi.mock("@/lib/igcse-roster/load", async () => {
  const actual = await vi.importActual<typeof import("@/lib/igcse-roster/load")>("@/lib/igcse-roster/load");
  return { ...actual, loadIgcseRosterInput: vi.fn() };
});

import { loadIgcseRosterInput, NoActiveSnapshotError } from "@/lib/igcse-roster/load";
import { GET } from "../route";

function request(authorization?: string) {
  return new NextRequest("http://test.local/api/internal/igcse-roster", {
    headers: authorization ? { authorization } : {},
  });
}

const emptyInput = {
  snapshotGeneratedAt: new Date("2026-10-06T00:00:00.000Z"),
  packages: [], students: [], sessions: [], accounts: [], contacts: [], mappings: [], qualifications: [],
};

describe("GET /api/internal/igcse-roster", () => {
  beforeEach(() => {
    vi.resetAllMocks();
    process.env.ROSTER_EXPORT_SECRET = "roster-test-secret";
    vi.mocked(loadIgcseRosterInput).mockResolvedValue(emptyInput);
  });

  it("returns 503 when the secret is not configured", async () => {
    delete process.env.ROSTER_EXPORT_SECRET;
    const res = await GET(request("Bearer anything"));
    expect(res.status).toBe(503);
    expect(loadIgcseRosterInput).not.toHaveBeenCalled();
  });

  it("returns 401 for a missing, wrong, or CRON_SECRET bearer", async () => {
    process.env.CRON_SECRET = "cron-test-secret";
    for (const header of [undefined, "Bearer wrong", "Bearer roster-test-secret-extra", "roster-test-secret", "Bearer cron-test-secret"]) {
      const res = await GET(request(header));
      expect(res.status, String(header)).toBe(401);
    }
    expect(loadIgcseRosterInput).not.toHaveBeenCalled();
  });

  it("returns the roster for a valid bearer", async () => {
    const res = await GET(request("Bearer roster-test-secret"));
    expect(res.status).toBe(200);
    expect(res.headers.get("cache-control")).toBe("no-store");
    expect(await res.json()).toMatchObject({
      tutors: [], students: [], links: [], unmapped: [], snapshotGeneratedAt: "2026-10-06T00:00:00.000Z",
    });
  });

  it("returns 503 when there is no active snapshot and 500 on other failures", async () => {
    vi.mocked(loadIgcseRosterInput).mockRejectedValueOnce(new NoActiveSnapshotError());
    expect((await GET(request("Bearer roster-test-secret"))).status).toBe(503);

    vi.spyOn(console, "error").mockImplementation(() => {});
    vi.mocked(loadIgcseRosterInput).mockRejectedValueOnce(new Error("db down"));
    const res = await GET(request("Bearer roster-test-secret"));
    expect(res.status).toBe(500);
    expect(JSON.stringify(await res.json())).not.toContain("db down");
  });
});
