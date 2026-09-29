import { beforeEach, describe, expect, it, vi } from "vitest";
import { NextRequest } from "next/server";

vi.mock("server-only", () => ({}));
vi.mock("@/lib/auth", () => ({ auth: vi.fn() }));
vi.mock("@/lib/db", () => ({ getDb: vi.fn(() => ({})) }));
vi.mock("@/lib/feedback-autowriter/dashboard", () => ({
  DASHBOARD_WINDOWS: [1, 7, 30],
  loadAutowriterDashboard: vi.fn(async (_db: unknown, input: { windowDays: number }) => ({ windowDays: input.windowDays, totals: {} })),
}));
vi.mock("@/lib/classrooms/operations-access", () => ({ requireClassroomOperationsOwner: vi.fn() }));
vi.mock("@/lib/feedback-autowriter/store", () => ({
  readControl: vi.fn(async () => ({ mode: "live", haltedAt: null, haltReason: null, disabledTutors: [] })),
  updateControl: vi.fn(async () => undefined),
  haltAutowriter: vi.fn(async () => undefined),
  requeueShadowDrafts: vi.fn(async () => 2),
}));

import { auth } from "@/lib/auth";
import { AdminUsersAccessError } from "@/lib/admin-users/types";
import { requireClassroomOperationsOwner } from "@/lib/classrooms/operations-access";
import { loadAutowriterDashboard } from "@/lib/feedback-autowriter/dashboard";
import { haltAutowriter, requeueShadowDrafts, updateControl } from "@/lib/feedback-autowriter/store";
import { GET } from "../route";
import { POST } from "../control/route";

const authMock = vi.mocked(auth as unknown as () => Promise<unknown>);
const ownerMock = vi.mocked(requireClassroomOperationsOwner);

function post(body: unknown) {
  return new NextRequest("http://localhost/api/feedback-autowriter/control", {
    method: "POST",
    body: typeof body === "string" ? body : JSON.stringify(body),
    headers: { "Content-Type": "application/json" },
  });
}

beforeEach(() => {
  vi.clearAllMocks();
});

describe("GET /api/feedback-autowriter", () => {
  it("requires a session", async () => {
    authMock.mockResolvedValue(null);
    expect((await GET(new NextRequest("http://localhost/api/feedback-autowriter"))).status).toBe(401);
  });

  it("is admin-only: the payload carries written feedback", async () => {
    authMock.mockResolvedValue({ user: { email: "parent@x.com", role: "parent" } });
    expect((await GET(new NextRequest("http://localhost/api/feedback-autowriter"))).status).toBe(403);
    expect(loadAutowriterDashboard).not.toHaveBeenCalled();
  });

  it("serves the requested window, defaulting unknown values to 7 days", async () => {
    authMock.mockResolvedValue({ user: { email: "a@x.com", role: "admin" } });
    await GET(new NextRequest("http://localhost/api/feedback-autowriter?days=30"));
    await GET(new NextRequest("http://localhost/api/feedback-autowriter?days=999"));
    expect(vi.mocked(loadAutowriterDashboard).mock.calls.map((call) => call[1].windowDays)).toEqual([30, 7]);
  });
});

describe("POST /api/feedback-autowriter/control", () => {
  it("is owner-only", async () => {
    ownerMock.mockRejectedValue(new AdminUsersAccessError("nope", 403));
    const response = await POST(post({ action: "resume" }));
    expect(response.status).toBe(403);
    expect(await response.json()).toEqual({ error: "Only Kevin can change the feedback autowriter." });
    expect(updateControl).not.toHaveBeenCalled();
  });

  it("validates the body", async () => {
    ownerMock.mockResolvedValue({ email: "kevhsh7@gmail.com", accessVersion: 1 } as never);
    expect((await POST(post("not json"))).status).toBe(400);
    expect((await POST(post({ action: "mode", mode: "turbo" }))).status).toBe(400);
    expect((await POST(post({ action: "tutor", wiseUserIds: ["../x"], enabled: true }))).status).toBe(400);
    expect((await POST(post({ action: "tutor", wiseUserIds: [], enabled: true }))).status).toBe(400);
    // The old single-account body is no longer accepted.
    expect((await POST(post({ action: "tutor", wiseUserId: "696e2c4343579bbada2340ed", enabled: true }))).status).toBe(400);
  });

  it("switches to live and re-queues shadow drafts", async () => {
    ownerMock.mockResolvedValue({ email: "kevhsh7@gmail.com", accessVersion: 1 } as never);
    const response = await POST(post({ action: "mode", mode: "live" }));
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({ ok: true, requeued: 2 });
    expect(updateControl).toHaveBeenCalledWith(expect.anything(), { mode: "live" }, "kevhsh7@gmail.com");
    expect(requeueShadowDrafts).toHaveBeenCalledTimes(1);
  });

  it("pauses by adding to the halt reason, never replacing an automatic one", async () => {
    ownerMock.mockResolvedValue({ email: "kevhsh7@gmail.com", accessVersion: 1 } as never);
    expect((await POST(post({ action: "pause", reason: "checking a class" }))).status).toBe(200);
    expect(haltAutowriter).toHaveBeenCalledWith(expect.anything(), "paused by kevhsh7@gmail.com: checking a class", "kevhsh7@gmail.com");
    expect(updateControl).not.toHaveBeenCalled();
  });

  it("refuses to toggle an account that is not on the roster, even alongside roster ones", async () => {
    ownerMock.mockResolvedValue({ email: "kevhsh7@gmail.com", accessVersion: 1 } as never);
    expect((await POST(post({ action: "tutor", wiseUserIds: ["6a0000000000000000000009"], enabled: false }))).status).toBe(400);
    expect((await POST(post({ action: "tutor", wiseUserIds: ["696e2c4343579bbada2340ed", "6a0000000000000000000009"], enabled: false }))).status).toBe(400);
    expect(updateControl).not.toHaveBeenCalled();
  });

  it("switches a tutor off and on across both of their Wise accounts", async () => {
    ownerMock.mockResolvedValue({ email: "kevhsh7@gmail.com", accessVersion: 1 } as never);
    const kevin = ["696e2c4343579bbada2340ed", "695369c028118f629edcb986"];
    expect((await POST(post({ action: "tutor", wiseUserIds: kevin, enabled: false }))).status).toBe(200);
    expect(updateControl).toHaveBeenLastCalledWith(expect.anything(), { disabledTutors: kevin }, "kevhsh7@gmail.com");
    expect((await POST(post({ action: "tutor", wiseUserIds: kevin, enabled: true }))).status).toBe(200);
    expect(updateControl).toHaveBeenLastCalledWith(expect.anything(), { disabledTutors: [] }, "kevhsh7@gmail.com");
  });
});
