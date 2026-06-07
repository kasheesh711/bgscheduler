import { beforeEach, describe, expect, it, vi, type Mock } from "vitest";

vi.mock("@/lib/auth", () => ({ auth: vi.fn() }));
vi.mock("@/lib/db", () => ({ getDb: vi.fn(() => ({ db: true })) }));
vi.mock("@/lib/line/student-links", () => ({
  runLineFollowersReanchor: vi.fn(),
}));

import { auth } from "@/lib/auth";
import { runLineFollowersReanchor } from "@/lib/line/student-links";
import { POST } from "@/app/api/line/contacts/followers-reanchor/route";

const authMock = auth as unknown as Mock;

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
  });

  it("returns 401 without auth", async () => {
    authMock.mockResolvedValue(null);
    const res = await POST();
    expect(res.status).toBe(401);
    expect(runLineFollowersReanchor).not.toHaveBeenCalled();
  });

  it("calls runLineFollowersReanchor and returns result", async () => {
    const res = await POST();
    expect(res.status).toBe(200);
    expect(runLineFollowersReanchor).toHaveBeenCalledWith({ db: { db: true } });
    const body = await res.json();
    expect(body.result.followerCount).toBe(5);
    expect(body.result.upsertedContacts).toBe(3);
    expect(body.result.suggestionsCreated).toBe(2);
  });

  it("returns 500 on service error", async () => {
    vi.mocked(runLineFollowersReanchor).mockRejectedValue(new Error("LINE API failed"));
    const res = await POST();
    expect(res.status).toBe(500);
    const body = await res.json();
    expect(body.error).toContain("LINE API failed");
  });
});
