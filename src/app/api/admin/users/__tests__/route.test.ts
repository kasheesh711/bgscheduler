import { beforeEach, describe, expect, it, vi } from "vitest";
import { NextRequest } from "next/server";

vi.mock("@/lib/admin-users/access", () => ({ requireSuperAdmin: vi.fn() }));
vi.mock("@/lib/admin-users/data", () => ({ listAdminUsers: vi.fn(), updateAdminUserAccess: vi.fn() }));

import { requireSuperAdmin } from "@/lib/admin-users/access";
import { listAdminUsers, updateAdminUserAccess } from "@/lib/admin-users/data";
import { AdminUsersAccessError } from "@/lib/admin-users/types";
import { GET, PATCH } from "../route";

const row = { email: "aoeng@example.com", name: "Aoeng", disabled: false, accessVersion: 0, isOwner: false };
const request = (body: unknown) => new NextRequest("http://localhost/api/admin/users", { method: "PATCH", body: JSON.stringify(body), headers: { "Content-Type": "application/json" } });

describe("owner users API", () => {
  beforeEach(() => {
    vi.resetAllMocks();
    vi.mocked(requireSuperAdmin).mockResolvedValue({ email: "kevin@example.com", accessVersion: 2 });
    vi.mocked(listAdminUsers).mockResolvedValue([row]);
    vi.mocked(updateAdminUserAccess).mockResolvedValue({ ...row, disabled: true, accessVersion: 1 });
  });

  it("returns the current list with private no-store caching", async () => {
    const response = await GET();
    expect(response.status).toBe(200);
    expect(response.headers.get("cache-control")).toContain("no-store");
    expect(await response.json()).toEqual({ rows: [row] });
  });

  it.each([401, 403] as const)("denies GET and PATCH before reading or writing for status %s", async (status) => {
    vi.mocked(requireSuperAdmin).mockRejectedValue(new AdminUsersAccessError("Denied", status));
    expect((await GET()).status).toBe(status);
    expect((await PATCH(request({ email: row.email, disabled: true, expectedVersion: 0 }))).status).toBe(status);
    expect(listAdminUsers).not.toHaveBeenCalled();
    expect(updateAdminUserAccess).not.toHaveBeenCalled();
  });

  it("takes the actor from authenticated authority and returns the updated row", async () => {
    const response = await PATCH(request({ email: row.email, disabled: true, expectedVersion: 0 }));
    expect(response.status).toBe(200);
    expect(updateAdminUserAccess).toHaveBeenCalledWith({ email: row.email, disabled: true, expectedVersion: 0, actorEmail: "kevin@example.com", actorAccessVersion: 2 });
    expect(await response.json()).toEqual({ row: { ...row, disabled: true, accessVersion: 1 } });
  });

  it.each([
    { email: "bad-email", disabled: true, expectedVersion: 0 },
    { email: row.email, disabled: "true", expectedVersion: 0 },
    { email: row.email, disabled: true, expectedVersion: -1 },
    { email: row.email, disabled: true, expectedVersion: 0, actorEmail: "forged@example.com" },
  ])("rejects malformed or forged requests %j", async (body) => {
    expect((await PATCH(request(body))).status).toBe(400);
    expect(updateAdminUserAccess).not.toHaveBeenCalled();
  });

  it.each([403, 404, 409] as const)("preserves access mutation status %s", async (status) => {
    vi.mocked(updateAdminUserAccess).mockRejectedValue(new AdminUsersAccessError("Denied", status));
    expect((await PATCH(request({ email: row.email, disabled: true, expectedVersion: 0 }))).status).toBe(status);
  });

  it("denies on database failure without exposing internals", async () => {
    const log = vi.spyOn(console, "error").mockImplementation(() => undefined);
    vi.mocked(listAdminUsers).mockRejectedValue(new Error("private database details"));
    const response = await GET();
    expect(response.status).toBe(500);
    expect(await response.text()).not.toContain("private database details");
    log.mockRestore();
  });
});
