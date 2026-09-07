import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { NextRequest, NextResponse } from "next/server";

const { rawAuth, dbLookup, runSync, state } = vi.hoisted(() => ({
  rawAuth: vi.fn(),
  dbLookup: vi.fn(),
  runSync: vi.fn(),
  state: { disabled: false, accessVersion: 0, allowedPages: null },
}));

vi.mock("next-auth", () => ({ default: () => ({ auth: rawAuth, handlers: {}, signIn: vi.fn(), signOut: vi.fn() }) }));
vi.mock("next-auth/providers/google", () => ({ default: () => ({ id: "google" }) }));
vi.mock("@/lib/auth-access", () => ({ resolveUserAccess: vi.fn() }));
vi.mock("@/lib/db", () => ({ getDb: dbLookup }));
vi.mock("@/lib/sync/run-wise-sync", () => ({ runWiseSyncRequest: runSync }));
vi.mock("@/lib/data-health/cron-audit", () => ({ withCronInvocationAudit: (_options: unknown, callback: () => unknown) => callback() }));

import { GET, POST } from "@/app/api/internal/sync-wise/route";

describe("manual cron fallback with the real server session guard", () => {
  beforeEach(() => {
    vi.resetAllMocks();
    vi.stubEnv("CRON_SECRET", "test-cron-secret");
    state.disabled = false;
    state.accessVersion = 0;
    rawAuth.mockResolvedValue({ user: { email: "aoeng@example.com", role: "admin", adminAccessVersion: 0 }, expires: "2099-01-01" });
    const builder: Record<string, unknown> = {};
    for (const method of ["from", "where", "limit"]) builder[method] = () => builder;
    builder.then = (resolve: (rows: unknown[]) => unknown) => Promise.resolve([{ ...state }]).then(resolve);
    dbLookup.mockReturnValue({ select: () => builder });
    runSync.mockImplementation(async () => NextResponse.json({ ok: true }));
  });
  afterEach(() => vi.unstubAllEnvs());

  it("stops a disabled/re-enabled admin's manual run without invoking the sync", async () => {
    const request = () => new NextRequest("http://localhost/api/internal/sync-wise", { method: "POST" });
    expect((await POST(request())).status).toBe(200);
    runSync.mockClear();
    state.disabled = true;
    state.accessVersion = 1;
    expect((await POST(request())).status).toBe(401);
    state.disabled = false;
    state.accessVersion = 2;
    expect((await POST(request())).status).toBe(401);
    expect(runSync).not.toHaveBeenCalled();
    rawAuth.mockResolvedValue({ user: { email: "aoeng@example.com", role: "admin", adminAccessVersion: 2 }, expires: "2099-01-01" });
    expect((await POST(request())).status).toBe(200);
  });

  it("never reads sessions or account tables for a valid cron secret", async () => {
    const request = new NextRequest("http://localhost/api/internal/sync-wise", { headers: { authorization: "Bearer test-cron-secret" } });
    expect((await GET(request)).status).toBe(200);
    expect(rawAuth).not.toHaveBeenCalled();
    expect(dbLookup).not.toHaveBeenCalled();
    expect(runSync).toHaveBeenCalledOnce();
  });
});
