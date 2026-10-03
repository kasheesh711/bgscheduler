import { afterEach, beforeEach, describe, expect, it, vi, type MockInstance } from "vitest";
import { NextRequest } from "next/server";

vi.mock("server-only", () => ({}));
vi.mock("@/lib/post-class-feedback/access", () => ({
  PostClassAccessError: class PostClassAccessError extends Error {
    constructor(message: string, readonly status: number) {
      super(message);
      this.name = "PostClassAccessError";
    }
  },
  requirePostClassCapability: vi.fn(),
}));
vi.mock("@/lib/post-class-feedback/collection-tick", () => ({ runPostClassCollectionTick: vi.fn() }));
vi.mock("@/lib/post-class-feedback/reassess", () => ({ reassessPostClassSessions: vi.fn() }));
// The page's own error mapper (api.ts) stays real: this route keeps it rather than the cron's mapping.

import { PostClassAccessError, requirePostClassCapability } from "@/lib/post-class-feedback/access";
import { runPostClassCollectionTick } from "@/lib/post-class-feedback/collection-tick";
import { reassessPostClassSessions } from "@/lib/post-class-feedback/reassess";
import { POST } from "../route";

const ACTOR = { email: "manager@example.com", name: "Manager", role: "admin", capabilities: ["access_manager"] };
const TICK = {
  ok: true,
  result: { runId: "pc-run-1" },
  ai: { processed: 1, failed: 0, skipped: 2 },
  retries: { failed: true },
  hygiene: { reopened: 0, reopenFailed: 0, waived: 1, waiveFailed: 0 },
};

function request(body?: unknown): NextRequest {
  return new NextRequest("http://test.local/api/post-class-feedback/sync", {
    method: "POST",
    headers: { "content-type": "application/json" },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
}

describe("POST /api/post-class-feedback/sync", () => {
  let consoleError: MockInstance<typeof console.error>;

  beforeEach(() => {
    vi.resetAllMocks();
    vi.mocked(requirePostClassCapability).mockResolvedValue(ACTOR as never);
    vi.mocked(runPostClassCollectionTick).mockResolvedValue(TICK as never);
    consoleError = vi.spyOn(console, "error").mockImplementation(() => undefined);
  });

  afterEach(() => {
    consoleError.mockRestore();
  });

  it.each([
    ["an empty body", {}],
    ["no body", undefined],
  ])("runs the shared collection tick as the actor's manual collect for %s, returning its result verbatim", async (_label, body) => {
    const response = await POST(request(body));

    expect(requirePostClassCapability).toHaveBeenCalledWith("access_manager");
    expect(runPostClassCollectionTick).toHaveBeenCalledTimes(1);
    expect(runPostClassCollectionTick).toHaveBeenCalledWith({ triggerType: "manual", actorEmail: ACTOR.email });
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual(TICK);
    expect(reassessPostClassSessions).not.toHaveBeenCalled();
  });

  it("passes the Settings Backfill dialog's range and detail cap through to the tick", async () => {
    const response = await POST(request({ startDate: "2026-09-01", endDate: "2026-09-04", detailCap: 25 }));

    expect(response.status).toBe(200);
    expect(runPostClassCollectionTick).toHaveBeenCalledWith({
      triggerType: "manual",
      actorEmail: ACTOR.email,
      detailCap: 25,
      startDate: "2026-09-01",
      endDate: "2026-09-04",
    });
  });

  it.each([
    ["a start date without an end date", { startDate: "2026-09-01" }],
    ["a range that ends before it starts", { startDate: "2026-09-04", endDate: "2026-09-01" }],
    ["a detail cap above 400", { detailCap: 401 }],
    ["an unknown field", { maxBatches: 2 }],
  ])("rejects %s with 400 before running the tick", async (_label, body) => {
    const response = await POST(request(body));

    expect(response.status).toBe(400);
    expect(runPostClassCollectionTick).not.toHaveBeenCalled();
  });

  it("maps a tick failure through the page's own error mapper, without the thrown text", async () => {
    vi.mocked(runPostClassCollectionTick).mockRejectedValueOnce(new Error("sensitive driver detail"));

    const response = await POST(request({}));

    expect(response.status).toBe(500);
    expect(await response.json()).toEqual({ error: "Could not sync post-class feedback." });
    expect(consoleError.mock.calls).toEqual([["POST /api/post-class-feedback/sync", { errorName: "Error" }]]);
  });

  it("stops at the capability check: an access error keeps its status and nothing runs", async () => {
    vi.mocked(requirePostClassCapability).mockRejectedValueOnce(new PostClassAccessError("Forbidden", 403));

    const response = await POST(request({}));

    expect(response.status).toBe(403);
    expect(await response.json()).toEqual({ error: "Forbidden" });
    expect(runPostClassCollectionTick).not.toHaveBeenCalled();
    expect(reassessPostClassSessions).not.toHaveBeenCalled();
  });

  it("reassesses stored verdicts without running the collection tick", async () => {
    const result = { scanned: 3, changed: 1, deductionsWaived: 1, failed: 0, outcomes: [] };
    vi.mocked(reassessPostClassSessions).mockResolvedValueOnce(result);

    const response = await POST(request({ mode: "reassess", apply: true, timingStatuses: ["late"], limit: 5 }));

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ ok: true, mode: "reassess", applied: true, result });
    expect(reassessPostClassSessions).toHaveBeenCalledWith({
      apply: true,
      timingStatuses: ["late"],
      wiseSessionIds: undefined,
      limit: 5,
    });
    expect(runPostClassCollectionTick).not.toHaveBeenCalled();
    expect(consoleError).toHaveBeenCalledTimes(1);
    expect(consoleError.mock.calls[0][0]).toBe("[post-class-reassess]");
  });
});
