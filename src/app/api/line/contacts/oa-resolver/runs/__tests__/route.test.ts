import { beforeEach, describe, expect, it, vi, type Mock } from "vitest";
import { NextRequest } from "next/server";

vi.mock("@/lib/auth", () => ({ auth: vi.fn() }));
vi.mock("@/lib/db", () => ({ getDb: vi.fn(() => ({ db: true })) }));
vi.mock("@/lib/line/oa-resolver", () => ({
  createLineOaResolverRun: vi.fn(async () => ({ run: { id: "run-1" }, token: "token-1" })),
  getLatestLineOaResolverRun: vi.fn(async () => ({ id: "run-latest" })),
}));

import { auth } from "@/lib/auth";
import { createLineOaResolverRun, getLatestLineOaResolverRun } from "@/lib/line/oa-resolver";
import { GET, POST } from "@/app/api/line/contacts/oa-resolver/runs/route";

const authMock = auth as unknown as Mock;

describe("LINE OA resolver runs route", () => {
  beforeEach(() => {
    vi.resetAllMocks();
    authMock.mockResolvedValue({ user: { email: "admin@example.com", name: "Admin" } });
    vi.mocked(createLineOaResolverRun).mockResolvedValue({ run: { id: "run-1" } as never, token: "token-1" });
    vi.mocked(getLatestLineOaResolverRun).mockResolvedValue({ id: "run-latest" } as never);
  });

  it("requires auth for creation", async () => {
    authMock.mockResolvedValue(null);

    const response = await POST();

    expect(response.status).toBe(401);
    expect(createLineOaResolverRun).not.toHaveBeenCalled();
  });

  it("creates a resolver run for the signed-in admin", async () => {
    const response = await POST();

    expect(response.status).toBe(201);
    expect(createLineOaResolverRun).toHaveBeenCalledWith({ db: true }, {
      email: "admin@example.com",
      name: "Admin",
    });
    await expect(response.json()).resolves.toEqual({
      run: { id: "run-1" },
      token: "token-1",
    });
  });

  it("returns the latest run when requested", async () => {
    const request = new NextRequest("http://test.local/api/line/contacts/oa-resolver/runs?latest=true");

    const response = await GET(request);

    expect(response.status).toBe(200);
    expect(getLatestLineOaResolverRun).toHaveBeenCalledWith({ db: true }, {
      email: "admin@example.com",
      name: "Admin",
    });
  });
});
