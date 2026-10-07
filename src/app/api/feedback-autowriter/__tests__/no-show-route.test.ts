import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { NextRequest } from "next/server";

vi.mock("server-only", () => ({}));
vi.mock("@/lib/auth", () => ({ auth: vi.fn() }));
vi.mock("@/lib/db", () => ({ getDb: vi.fn(() => ({})) }));
vi.mock("@/lib/classrooms/operations-access", () => ({ requireClassroomOperationsOwner: vi.fn() }));
vi.mock("@/lib/feedback-autowriter/no-show-post", () => ({ postNoShowNote: vi.fn() }));
vi.mock("@/lib/feedback-autowriter/run", () => ({ createWiseFeedbackOps: vi.fn(() => ({})), loadFieldMappings: vi.fn() }));

import { AdminUsersAccessError } from "@/lib/admin-users/types";
import { requireClassroomOperationsOwner } from "@/lib/classrooms/operations-access";
import { postNoShowNote } from "@/lib/feedback-autowriter/no-show-post";
import { POST } from "../no-show/route";

const ownerMock = vi.mocked(requireClassroomOperationsOwner);
const postMock = vi.mocked(postNoShowNote);
const SESSION = "6a0000000000000000000e01";
const request = (body: unknown) => new NextRequest("http://localhost/api/feedback-autowriter/no-show", {
  method: "POST", body: JSON.stringify(body), headers: { "Content-Type": "application/json" },
});

beforeEach(() => {
  vi.clearAllMocks();
  ownerMock.mockResolvedValue({ email: "owner@example.com", accessVersion: 1 } as never);
  postMock.mockResolvedValue({ ok: true, outcome: "verified" });
  vi.stubEnv("FEEDBACK_AUTOWRITER_ENABLED", "true");
  vi.stubEnv("VERCEL_ENV", "production");
  vi.stubEnv("WISE_USER_ID", "69366668c05630afe5d8a2a4");
});
afterEach(() => { vi.unstubAllEnvs(); });

describe("POST /api/feedback-autowriter/no-show", () => {
  it("is owner-only", async () => {
    ownerMock.mockRejectedValue(new AdminUsersAccessError("nope", 403));
    expect((await POST(request({ action: "post_note", wiseSessionId: SESSION }))).status).toBe(403);
    expect(postMock).not.toHaveBeenCalled();
  });
  it.each([
    ["the autowriter is switched off", { FEEDBACK_AUTOWRITER_ENABLED: "false" }],
    ["it runs on a preview deployment", { VERCEL_ENV: "preview" }],
  ])("never posts when %s", async (_why, env) => {
    for (const [key, value] of Object.entries(env)) vi.stubEnv(key, value);
    expect((await POST(request({ action: "post_note", wiseSessionId: SESSION }))).status).toBe(409);
    expect(postMock).not.toHaveBeenCalled();
  });
  it("rejects a malformed body and passes a refusal's status through", async () => {
    expect((await POST(request({ action: "post_note", wiseSessionId: "nope" }))).status).toBe(400);
    postMock.mockResolvedValue({ ok: false, status: 409, reason: "submission_human" });
    const response = await POST(request({ action: "post_note", wiseSessionId: SESSION }));
    expect(response.status).toBe(409);
    expect(await response.json()).toEqual({ error: "submission_human" });
  });
  it("posts as the owner, with the time budget", async () => {
    const response = await POST(request({ action: "post_note", wiseSessionId: SESSION }));
    expect(response.status).toBe(200);
    expect(postMock.mock.calls[0][1]).toMatchObject({ wiseSessionId: SESSION, actor: "owner@example.com", apiActorId: "69366668c05630afe5d8a2a4" });
    expect(postMock.mock.calls[0][1].remainingMs()).toBeGreaterThan(270_000);
  });
});
