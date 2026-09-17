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
import { POST as dataHealth } from "@/app/api/data-health/jobs/[jobKey]/run/route";
import { CLASSROOM_OPERATIONS_OWNER, WISE_CLASSROOM_JOBS } from "../operations-policy";

const ownerSession = { user: { email: CLASSROOM_OPERATIONS_OWNER, role: "admin", adminAccessVersion: 3 } };
const request = () => new NextRequest("https://example.test/api/action", { method: "POST", body: JSON.stringify({ date: "2099-01-01", confirmed: true }) });
const endpoints = [
  ["manual sync", () => sync()],
  ["internal session fallback", () => internalSync(request())],
  ["assignment run", () => run(request())],
  ["publication", () => publish(request(), { params: Promise.resolve({ runId: "run-1" }) })],
  ...WISE_CLASSROOM_JOBS.map(jobKey => [`Data Health ${jobKey}`, () => dataHealth(request(), { params: Promise.resolve({ jobKey }) })] as const),
] as const;

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
