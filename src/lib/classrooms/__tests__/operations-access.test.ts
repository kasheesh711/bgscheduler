import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { NextRequest, NextResponse } from "next/server";

vi.mock("server-only", () => ({}));
vi.mock("@/lib/auth", () => ({ auth: vi.fn() }));
vi.mock("@/lib/db", () => ({ getDb: vi.fn() }));
vi.mock("@/lib/classrooms/data", () => ({
  runClassroomAssignment: vi.fn(), createClassroomPublishJob: vi.fn(), runClassroomPublishJob: vi.fn(),
  StaleClassroomAssignmentSnapshotError: class extends Error {},
}));
vi.mock("@/lib/sync/run-wise-sync", () => ({ runWiseSyncRequest: vi.fn() }));
// Isolates this file to authorization only -- decision logic is covered by
// manual-wise-sync.test.ts and the sync-wise route's own test.
vi.mock("@/lib/sync/manual-wise-sync", () => ({
  decideManualWiseSync: vi.fn(() => ({ action: "start" })),
  getLatestSuccessfulSyncFinishedAt: vi.fn(),
  getRunningSyncStartedAt: vi.fn(),
  getTypicalSyncDurationMs: vi.fn(),
}));
vi.mock("@/lib/data-health/run-job", () => ({ runDataHealthJob: vi.fn() }));
vi.mock("@/lib/data-health/cron-audit", () => ({ withCronInvocationAudit: (_input: unknown, fn: () => unknown) => fn() }));
vi.mock("@/lib/post-class-feedback/access", () => ({ getPostClassCapabilities: vi.fn() }));
vi.mock("next/server", async importOriginal => ({ ...await importOriginal<typeof import("next/server")>(), after: vi.fn() }));

import { auth } from "@/lib/auth";
import { getDb } from "@/lib/db";
import { runClassroomAssignment, createClassroomPublishJob, runClassroomPublishJob } from "../data";
import { runWiseSyncRequest } from "@/lib/sync/run-wise-sync";
import { runDataHealthJob } from "@/lib/data-health/run-job";
import { POST as sync } from "@/app/api/admin/sync-wise/route";
import { POST as internalSync } from "@/app/api/internal/sync-wise/route";
import { POST as run } from "@/app/api/class-assignments/run/route";
import { POST as publish } from "@/app/api/class-assignments/runs/[runId]/publish/route";
import { POST as syncWiseGuard } from "@/app/api/class-assignments/sync-wise/route";
import { POST as dataHealth } from "@/app/api/data-health/jobs/[jobKey]/run/route";
import { CLASSROOM_OPERATIONS_OWNER, WISE_CLASSROOM_JOBS } from "../operations-policy";

const ownerSession = { user: { email: CLASSROOM_OPERATIONS_OWNER, role: "admin", adminAccessVersion: 3 } };
const request = () => new NextRequest("https://example.test/api/action", { method: "POST", body: JSON.stringify({ date: "2099-01-01", confirmed: true }) });
const forceReassignRequest = () => new NextRequest("https://example.test/api/action", { method: "POST", body: JSON.stringify({ date: "2099-01-01", forceReassign: true }) });

// Owner-only surfaces: unchanged by this plan -- Force reassign, /api/admin/sync-wise, the
// internal cron's session fallback, and the 5 Data Health classroom job triggers.
const endpoints = [
  ["manual sync", () => sync()],
  ["internal session fallback", () => internalSync(request())],
  ...WISE_CLASSROOM_JOBS.map(jobKey => [`Data Health ${jobKey}`, () => dataHealth(request(), { params: Promise.resolve({ jobKey }) })] as const),
] as const;

// Now admin-accessible: any current admin (not just Kevin) may run, publish, or sync-wise.
const adminEndpoints = [
  ["assignment run", () => run(request())],
  ["publication", () => publish(request(), { params: Promise.resolve({ runId: "run-1" }) })],
  ["sync-wise guard", () => syncWiseGuard()],
] as const;

const adminEndpointCalled: Record<string, () => void> = {
  "assignment run": () => expect(runClassroomAssignment).toHaveBeenCalled(),
  "publication": () => expect(createClassroomPublishJob).toHaveBeenCalled(),
  "sync-wise guard": () => expect(runWiseSyncRequest).toHaveBeenCalled(),
};

function account(rows: unknown[]) {
  const b: Record<string, unknown> = {};
  for (const method of ["from", "where", "limit"]) b[method] = () => b;
  b.then = (resolve: (rows: unknown[]) => unknown) => Promise.resolve(rows).then(resolve);
  vi.mocked(getDb).mockReturnValue({ select: () => b } as never);
}

beforeEach(() => {
  vi.resetAllMocks();
  vi.stubEnv("SUPER_ADMIN_EMAILS", `${CLASSROOM_OPERATIONS_OWNER},second-owner@example.com`);
  vi.stubEnv("WISE_CLASSROOM_AUTOMATION_ENABLED", "false");
  vi.stubEnv("CRON_SECRET", "test-secret");
  vi.mocked(auth).mockResolvedValue(ownerSession as never);
  account([{ disabled: false, accessVersion: 3 }]);
  vi.mocked(runClassroomAssignment).mockResolvedValue({ run: { id: "run-1" } } as never);
  vi.mocked(createClassroomPublishJob).mockResolvedValue({ jobId: "job-1", status: "pending" } as never);
  vi.mocked(runWiseSyncRequest).mockImplementation(async () => NextResponse.json({ ok: true }) as never);
  vi.mocked(runDataHealthJob).mockImplementation(async () => NextResponse.json({ ok: true }));
});
afterEach(() => vi.unstubAllEnvs());

describe.each(endpoints)("%s owner enforcement", (_label, invoke) => {
  it.each([
    ["no session", null, 401],
    ["ordinary admin", { user: { email: "admin@example.com", role: "admin", adminAccessVersion: 3 } }, 403],
    ["second configured owner", { user: { email: "second-owner@example.com", role: "admin", adminAccessVersion: 3 } }, 403],
    ["restricted teacher", { user: { email: CLASSROOM_OPERATIONS_OWNER, role: "teacher", allowedPages: ["/class-assignments"] } }, 403],
  ])("rejects %s before doing work", async (_case, session, status) => {
    vi.mocked(auth).mockResolvedValue(session as never);
    expect((await invoke()).status).toBe(status);
    expect(runClassroomAssignment).not.toHaveBeenCalled();
    expect(createClassroomPublishJob).not.toHaveBeenCalled();
    expect(runClassroomPublishJob).not.toHaveBeenCalled();
    expect(runWiseSyncRequest).not.toHaveBeenCalled();
    expect(runDataHealthJob).not.toHaveBeenCalled();
  });
  it.each([[true, 3], [false, 4]])("rejects revoked or stale owner sessions", async (disabled, accessVersion) => {
    account([{ disabled, accessVersion }]);
    expect((await invoke()).status).toBe(403);
    expect(runWiseSyncRequest).not.toHaveBeenCalled();
    expect(runClassroomAssignment).not.toHaveBeenCalled();
    expect(createClassroomPublishJob).not.toHaveBeenCalled();
    expect(runDataHealthJob).not.toHaveBeenCalled();
  });
  it("keeps current Kevin access and normalizes identity", async () => {
    vi.mocked(auth).mockResolvedValue({ user: { ...ownerSession.user, email: " KEVHSH7@GMAIL.COM " } } as never);
    expect([200, 202]).toContain((await invoke()).status);
  });
});

describe.each(adminEndpoints)("%s admin access", (label, invoke) => {
  it.each([
    ["no session", null, 401],
    ["restricted teacher, even Kevin's own email", { user: { email: CLASSROOM_OPERATIONS_OWNER, role: "teacher", allowedPages: ["/class-assignments"] } }, 403],
  ] as const)("rejects %s", async (_case, session, status) => {
    vi.mocked(auth).mockResolvedValue(session as never);
    expect((await invoke()).status).toBe(status);
  });

  it("allows an ordinary admin through and performs the operation", async () => {
    vi.mocked(auth).mockResolvedValue({ user: { email: "admin@example.com", role: "admin", adminAccessVersion: 3 } } as never);
    expect([200, 202]).toContain((await invoke()).status);
    adminEndpointCalled[label]();
  });
});

describe("force reassign stays owner-only even though run is now admin-accessible", () => {
  it("blocks an ordinary admin's forceReassign before running the assignment", async () => {
    vi.mocked(auth).mockResolvedValue({ user: { email: "admin@example.com", role: "admin", adminAccessVersion: 3 } } as never);

    const response = await run(forceReassignRequest());

    expect(response.status).toBe(403);
    expect(runClassroomAssignment).not.toHaveBeenCalled();
  });

  it("allows the owner's forceReassign", async () => {
    vi.mocked(auth).mockResolvedValue(ownerSession as never);

    const response = await run(forceReassignRequest());

    expect(response.status).toBe(200);
    expect(runClassroomAssignment).toHaveBeenCalled();
  });
});
