import { beforeEach, describe, expect, it, vi, type Mock } from "vitest";

vi.mock("@/lib/auth", () => ({ auth: vi.fn() }));
vi.mock("@/lib/db", () => ({ getDb: vi.fn(() => ({ db: true })) }));
vi.mock("@/lib/line/student-links", () => ({
  runLineFollowersReanchor: vi.fn(),
}));
vi.mock("@/lib/line/backlog-recovery", () => ({
  runLineBacklogRecovery: vi.fn(),
}));

import { auth } from "@/lib/auth";
import { runLineFollowersReanchor } from "@/lib/line/student-links";
import { runLineBacklogRecovery } from "@/lib/line/backlog-recovery";
import { POST } from "@/app/api/line/contacts/followers-reanchor/route";

const authMock = auth as unknown as Mock;

function makeRequest(url = "http://localhost/api/line/contacts/followers-reanchor") {
  return new Request(url) as unknown as import("next/server").NextRequest;
}

describe("POST /api/line/contacts/followers-reanchor", () => {
  beforeEach(() => {
    vi.resetAllMocks();
    authMock.mockResolvedValue({ user: { email: "admin@example.com" } });
    vi.mocked(runLineFollowersReanchor).mockResolvedValue({
      followerCount: 5,
      upsertedContacts: 3,
      suggestionsCreated: 2,
      errors: [],
    });
    vi.mocked(runLineBacklogRecovery).mockResolvedValue({
      contactsScanned: 10,
      targetsCount: 662,
      matchedCount: 5,
      insertedCount: 5,
      dryRun: false,
    });
  });

  it("returns 401 without auth", async () => {
    authMock.mockResolvedValue(null);
    const res = await POST(makeRequest());
    expect(res.status).toBe(401);
    expect(runLineFollowersReanchor).not.toHaveBeenCalled();
    expect(runLineBacklogRecovery).not.toHaveBeenCalled();
  });

  it("calls runLineFollowersReanchor + runLineBacklogRecovery and returns combined result", async () => {
    const res = await POST(makeRequest());
    expect(res.status).toBe(200);
    expect(runLineFollowersReanchor).toHaveBeenCalledWith({ db: { db: true } });
    expect(runLineBacklogRecovery).toHaveBeenCalledWith({ db: { db: true }, dryRun: false });
    const body = await res.json();
    expect(body.reanchor.followerCount).toBe(5);
    expect(body.backlog.matchedCount).toBe(5);
  });

  it("passes dryRun=true to runLineBacklogRecovery when ?dryRun=true", async () => {
    const res = await POST(makeRequest("http://localhost/api/line/contacts/followers-reanchor?dryRun=true"));
    expect(res.status).toBe(200);
    expect(runLineBacklogRecovery).toHaveBeenCalledWith({ db: { db: true }, dryRun: true });
  });

  it("returns 500 on service error", async () => {
    vi.mocked(runLineFollowersReanchor).mockRejectedValue(new Error("LINE API failed"));
    const res = await POST(makeRequest());
    expect(res.status).toBe(500);
    const body = await res.json();
    expect(body.error).toContain("LINE API failed");
  });
});
