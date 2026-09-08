import { randomUUID } from "node:crypto";
import { beforeEach, describe, expect, it, vi, type Mock } from "vitest";
import { NextRequest } from "next/server";

vi.mock("@/lib/auth", () => ({ auth: vi.fn() }));
vi.mock("@/lib/db", () => ({ getDb: vi.fn(() => ({ mocked: true })) }));
vi.mock("@/lib/leave-requests/work-data", async (original) => ({
  ...await original<typeof import("@/lib/leave-requests/work-data")>(),
  assertLeaveAdmin: vi.fn(), getLeaveBoard: vi.fn(), mutateLeaveWork: vi.fn(),
}));

import { auth } from "@/lib/auth";
import { assertLeaveAdmin, getLeaveBoard, LeaveWorkConflict, mutateLeaveWork } from "@/lib/leave-requests/work-data";
import { GET } from "../route";
import { PATCH } from "../../assignments/[assignmentId]/route";

const authMock = auth as unknown as Mock;
const assignmentId = randomUUID();
const context = { params: Promise.resolve({ assignmentId }) };
const update = () => new NextRequest(`http://test.local/api/leave-requests/assignments/${assignmentId}`, {
  method: "PATCH", headers: { "Content-Type": "application/json" },
  body: JSON.stringify({ kind: "family", entityId: randomUUID(), expectedVersion: 3, checked: true, mutationKey: randomUUID(), actorEmail: "forged@example.com" }),
});

beforeEach(() => {
  vi.resetAllMocks();
  authMock.mockResolvedValue({ user: { email: "Care@example.com", name: "Care" } });
  vi.mocked(getLeaveBoard).mockResolvedValue({ assignments: [] } as never);
});

describe("daily leave API boundaries", () => {
  it("requires a session for the board and checkoffs", async () => {
    authMock.mockResolvedValue(null);
    expect((await GET(new NextRequest("http://test.local/api/leave-requests/board"))).status).toBe(401);
    expect((await PATCH(update(), context)).status).toBe(401);
    expect(mutateLeaveWork).not.toHaveBeenCalled();
  });

  it("checks fresh page access for both reads and writes", async () => {
    vi.mocked(assertLeaveAdmin).mockRejectedValue(new Error("Access revoked"));
    expect((await GET(new NextRequest("http://test.local/api/leave-requests/board"))).status).toBe(403);
    expect((await PATCH(update(), context)).status).toBe(403);
    expect(getLeaveBoard).not.toHaveBeenCalled();
    expect(mutateLeaveWork).not.toHaveBeenCalled();
  });

  it("rejects impossible dates and prevents caching another admin's board", async () => {
    expect((await GET(new NextRequest("http://test.local/api/leave-requests/board?date=2026-02-31"))).status).toBe(400);
    const response = await GET(new NextRequest("http://test.local/api/leave-requests/board?date=2026-09-08"));
    expect(response.headers.get("Cache-Control")).toBe("private, no-store");
    expect(getLeaveBoard).toHaveBeenCalledWith({ mocked: true }, expect.objectContaining({ email: "care@example.com", date: "2026-09-08" }));
  });

  it("records the authenticated actor and exposes optimistic conflicts as 409", async () => {
    vi.mocked(mutateLeaveWork).mockRejectedValue(new LeaveWorkConflict());
    expect((await PATCH(update(), context)).status).toBe(409);
    expect(mutateLeaveWork).toHaveBeenCalledWith({ mocked: true }, assignmentId, expect.not.objectContaining({ actorEmail: "forged@example.com" }), { email: "care@example.com", name: "Care" });
  });
});
