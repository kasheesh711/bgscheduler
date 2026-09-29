import { beforeEach, describe, expect, it, vi } from "vitest";
import { NextRequest } from "next/server";

vi.mock("server-only", () => ({}));
vi.mock("@/lib/auth", () => ({ auth: vi.fn() }));
vi.mock("@/lib/db", () => ({ getDb: vi.fn(() => ({})) }));
vi.mock("@/lib/classrooms/operations-access", () => ({ requireClassroomOperationsOwner: vi.fn() }));
vi.mock("@/lib/feedback-autowriter/verdicts", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/feedback-autowriter/verdicts")>();
  return { ...actual, recordVerdict: vi.fn() };
});
vi.mock("@/lib/feedback-autowriter/review-data", () => ({ loadAutowriterReview: vi.fn(async () => ({ gate: {}, queue: [], daily: [] })) }));

import { auth } from "@/lib/auth";
import { AdminUsersAccessError } from "@/lib/admin-users/types";
import { requireClassroomOperationsOwner } from "@/lib/classrooms/operations-access";
import { AutowriterReviewError } from "@/lib/feedback-autowriter/api";
import { loadAutowriterReview } from "@/lib/feedback-autowriter/review-data";
import { recordVerdict } from "@/lib/feedback-autowriter/verdicts";
import { POST } from "../verdicts/route";
import { GET } from "../review/route";

const ownerMock = vi.mocked(requireClassroomOperationsOwner);
const recordMock = vi.mocked(recordVerdict);
const authMock = vi.mocked(auth as unknown as () => Promise<unknown>);

const SESSION = "6aba47d069f1f327513ac027";
const SHA = "a".repeat(64);

function post(body: unknown) {
  return new NextRequest("http://localhost/api/feedback-autowriter/verdicts", {
    method: "POST",
    body: typeof body === "string" ? body : JSON.stringify(body),
    headers: { "Content-Type": "application/json" },
  });
}

beforeEach(() => {
  vi.clearAllMocks();
  ownerMock.mockResolvedValue({ email: "kevhsh7@gmail.com", accessVersion: 1 } as never);
  recordMock.mockResolvedValue({ verdictId: "v1", supersedesId: null, resolvedFlags: 0, criticalIncident: false });
});

describe("POST /api/feedback-autowriter/verdicts", () => {
  it("is owner-only: a non-owner admin gets 403 and nothing is recorded", async () => {
    ownerMock.mockRejectedValue(new AdminUsersAccessError("nope", 403));
    const response = await POST(post({ wiseSessionId: SESSION, fieldsSha256: SHA, verdict: "approve" }));
    expect(response.status).toBe(403);
    expect(await response.json()).toEqual({ error: "Only Kevin can record autowriter verdicts." });
    expect(recordMock).not.toHaveBeenCalled();
  });

  it("validates the body and the verdict's shape", async () => {
    const cases: unknown[] = [
      "not json",
      { wiseSessionId: "../x", fieldsSha256: SHA, verdict: "approve" },
      { wiseSessionId: SESSION, fieldsSha256: "short", verdict: "approve" },
      { wiseSessionId: SESSION, fieldsSha256: SHA, verdict: "maybe" },
      { wiseSessionId: SESSION, fieldsSha256: SHA, verdict: "approve", severity: "cosmetic" },
      { wiseSessionId: SESSION, fieldsSha256: SHA, verdict: "needs_fix" },
      { wiseSessionId: SESSION, fieldsSha256: SHA, verdict: "needs_fix", severity: "critical" },
      { wiseSessionId: SESSION, fieldsSha256: SHA, verdict: "needs_fix", severity: "factual", criticalCategory: "wrong_person" },
      { wiseSessionId: SESSION, fieldsSha256: SHA, verdict: "approve", extra: true },
    ];
    for (const body of cases) expect((await POST(post(body))).status, JSON.stringify(body)).toBe(400);
    expect(recordMock).not.toHaveBeenCalled();
  });

  it("records a verdict with the owner as reviewer", async () => {
    const response = await POST(post({
      wiseSessionId: SESSION, fieldsSha256: SHA, verdict: "needs_fix", severity: "critical", criticalCategory: "wrong_person", note: "  Wrong student  ",
    }));
    expect(response.status).toBe(200);
    expect(recordMock).toHaveBeenCalledWith(expect.anything(), {
      wiseSessionId: SESSION, fieldsSha256: SHA, verdict: "needs_fix", severity: "critical", criticalCategory: "wrong_person",
      note: "Wrong student", reviewer: "kevhsh7@gmail.com", source: "dashboard",
    });
  });

  it("maps a stale pin to 409 and an unknown class to 404 without leaking other errors", async () => {
    recordMock.mockRejectedValueOnce(new AutowriterReviewError("stale", 409));
    expect((await POST(post({ wiseSessionId: SESSION, fieldsSha256: SHA, verdict: "approve" }))).status).toBe(409);
    recordMock.mockRejectedValueOnce(new AutowriterReviewError("missing", 404));
    expect((await POST(post({ wiseSessionId: SESSION, fieldsSha256: SHA, verdict: "approve" }))).status).toBe(404);
    const consoleError = vi.spyOn(console, "error").mockImplementation(() => undefined);
    recordMock.mockRejectedValueOnce(new Error("Failed query: insert … params: secret lesson text"));
    const response = await POST(post({ wiseSessionId: SESSION, fieldsSha256: SHA, verdict: "approve" }));
    expect(response.status).toBe(500);
    expect(JSON.stringify(await response.json())).not.toContain("secret");
    consoleError.mockRestore();
  });
});

describe("GET /api/feedback-autowriter/review", () => {
  it("requires an admin session", async () => {
    authMock.mockResolvedValue(null);
    expect((await GET()).status).toBe(401);
    authMock.mockResolvedValue({ user: { email: "p@x.com", role: "parent" } });
    expect((await GET()).status).toBe(403);
    expect(loadAutowriterReview).not.toHaveBeenCalled();
    authMock.mockResolvedValue({ user: { email: "a@x.com", role: "admin" } });
    expect((await GET()).status).toBe(200);
  });
});
