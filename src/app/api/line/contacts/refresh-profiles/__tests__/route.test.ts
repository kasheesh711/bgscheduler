import { beforeEach, describe, expect, it, vi, type Mock } from "vitest";

vi.mock("@/lib/auth", () => ({ auth: vi.fn() }));
vi.mock("@/lib/db", () => ({ getDb: vi.fn(() => ({ db: true })) }));
vi.mock("@/lib/line/contact-aliases", () => ({
  refreshAllLineContactProfiles: vi.fn(async () => ({
    total: 0,
    refreshed: 0,
    missing: 0,
    failed: [],
  })),
}));

import { auth } from "@/lib/auth";
import { refreshAllLineContactProfiles } from "@/lib/line/contact-aliases";
import { POST } from "@/app/api/line/contacts/refresh-profiles/route";

const authMock = auth as unknown as Mock;

describe("POST /api/line/contacts/refresh-profiles", () => {
  beforeEach(() => {
    vi.resetAllMocks();
    authMock.mockResolvedValue({ user: { email: "admin@example.com", name: "Admin" } });
    vi.mocked(refreshAllLineContactProfiles).mockResolvedValue({
      total: 2,
      refreshed: 1,
      missing: 1,
      failed: [],
    });
  });

  it("requires auth", async () => {
    authMock.mockResolvedValue(null);

    const response = await POST();

    expect(response.status).toBe(401);
    expect(refreshAllLineContactProfiles).not.toHaveBeenCalled();
  });

  it("runs the profile refresh service", async () => {
    const response = await POST();

    expect(response.status).toBe(200);
    expect(refreshAllLineContactProfiles).toHaveBeenCalledWith({ db: { db: true } });
    await expect(response.json()).resolves.toEqual({
      result: {
        total: 2,
        refreshed: 1,
        missing: 1,
        failed: [],
      },
    });
  });
});
