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
vi.mock("@/lib/feedback-autowriter/incidents", () => ({ acknowledgeIncident: vi.fn() }));
vi.mock("@/lib/feedback-autowriter/review-data", () => ({ loadAutowriterReview: vi.fn(async () => ({ available: true, gate: {}, queue: [], daily: [] })) }));

import { auth } from "@/lib/auth";
import { AdminUsersAccessError } from "@/lib/admin-users/types";
import { requireClassroomOperationsOwner } from "@/lib/classrooms/operations-access";
import { AutowriterReviewError } from "@/lib/feedback-autowriter/api";
import { acknowledgeIncident } from "@/lib/feedback-autowriter/incidents";
import { loadAutowriterReview } from "@/lib/feedback-autowriter/review-data";
import { recordVerdict } from "@/lib/feedback-autowriter/verdicts";
import { POST as acknowledge } from "../incidents/route";
import { POST } from "../verdicts/route";
import { GET } from "../review/route";

const ownerMock = vi.mocked(requireClassroomOperationsOwner);
const recordMock = vi.mocked(recordVerdict);
const acknowledgeMock = vi.mocked(acknowledgeIncident);
const reviewMock = vi.mocked(loadAutowriterReview);
const authMock = vi.mocked(auth as unknown as () => Promise<unknown>);

const SESSION = "6a0000000000000000000e01";
const SHA = "a".repeat(64);
const VERDICT_ID = "11111111-1111-4111-8111-111111111111";
const FLAG_ID = "22222222-2222-4222-8222-222222222222";
const INCIDENT_ID = "33333333-3333-4333-8333-333333333333";
const PINS = { currentVerdictId: null, seenFlagIds: [] as string[] };

function post(body: unknown, url = "http://localhost/api/feedback-autowriter/verdicts") {
  return new NextRequest(url, {
    method: "POST",
    body: typeof body === "string" ? body : JSON.stringify(body),
    headers: { "Content-Type": "application/json" },
  });
}

beforeEach(() => {
  vi.clearAllMocks();
  ownerMock.mockResolvedValue({ email: "owner@example.com", accessVersion: 1 } as never);
  recordMock.mockResolvedValue({ verdictId: "v1", supersedesId: null, resolvedFlags: 0, criticalIncident: false, downgradedFrom: null });
});

describe("POST /api/feedback-autowriter/verdicts", () => {
  it("is owner-only: a non-owner admin gets 403 and nothing is recorded", async () => {
    ownerMock.mockRejectedValue(new AdminUsersAccessError("nope", 403));
    const response = await POST(post({ wiseSessionId: SESSION, fieldsSha256: SHA, ...PINS, verdict: "approve" }));
    expect(response.status).toBe(403);
    expect(await response.json()).toEqual({ error: "Only Kevin can record autowriter verdicts or acknowledge incidents." });
    expect(recordMock).not.toHaveBeenCalled();
  });

  it("validates the body, the pins of what the page showed, and the verdict's shape", async () => {
    const cases: unknown[] = [
      "not json",
      { wiseSessionId: "../x", fieldsSha256: SHA, ...PINS, verdict: "approve" },
      { wiseSessionId: SESSION, fieldsSha256: "short", ...PINS, verdict: "approve" },
      { wiseSessionId: SESSION, fieldsSha256: SHA, ...PINS, verdict: "maybe" },
      // The pins are required: a verdict must say which current verdict and which open flags the page showed.
      { wiseSessionId: SESSION, fieldsSha256: SHA, verdict: "approve" },
      { wiseSessionId: SESSION, fieldsSha256: SHA, currentVerdictId: null, verdict: "approve" },
      { wiseSessionId: SESSION, fieldsSha256: SHA, currentVerdictId: "not-a-uuid", seenFlagIds: [], verdict: "approve" },
      { wiseSessionId: SESSION, fieldsSha256: SHA, currentVerdictId: null, seenFlagIds: ["x"], verdict: "approve" },
      { wiseSessionId: SESSION, fieldsSha256: SHA, ...PINS, verdict: "approve", severity: "cosmetic" },
      { wiseSessionId: SESSION, fieldsSha256: SHA, ...PINS, verdict: "needs_fix" },
      { wiseSessionId: SESSION, fieldsSha256: SHA, ...PINS, verdict: "needs_fix", severity: "critical" },
      { wiseSessionId: SESSION, fieldsSha256: SHA, ...PINS, verdict: "needs_fix", severity: "factual", criticalCategory: "wrong_person" },
      { wiseSessionId: SESSION, fieldsSha256: SHA, ...PINS, verdict: "approve", extra: true },
    ];
    for (const body of cases) expect((await POST(post(body))).status, JSON.stringify(body)).toBe(400);
    expect(recordMock).not.toHaveBeenCalled();
  });

  it("records a verdict with the owner as reviewer, the page's pins and a confirmed downgrade", async () => {
    const response = await POST(post({
      wiseSessionId: SESSION, fieldsSha256: SHA, currentVerdictId: VERDICT_ID, seenFlagIds: [FLAG_ID], verdict: "needs_fix",
      severity: "factual", note: "  Not critical: the student's own words  ", confirmDowngrade: true,
    }));
    expect(response.status).toBe(200);
    expect(recordMock).toHaveBeenCalledWith(expect.anything(), {
      wiseSessionId: SESSION, fieldsSha256: SHA, currentVerdictId: VERDICT_ID, seenFlagIds: [FLAG_ID], verdict: "needs_fix",
      severity: "factual", criticalCategory: null, note: "Not critical: the student's own words", confirmDowngrade: true,
      reviewer: "owner@example.com", source: "dashboard",
    });
  });

  it("maps a stale page to 409 and an unknown class to 404 without leaking other errors", async () => {
    recordMock.mockRejectedValueOnce(new AutowriterReviewError("stale", 409));
    expect((await POST(post({ wiseSessionId: SESSION, fieldsSha256: SHA, ...PINS, verdict: "approve" }))).status).toBe(409);
    recordMock.mockRejectedValueOnce(new AutowriterReviewError("missing", 404));
    expect((await POST(post({ wiseSessionId: SESSION, fieldsSha256: SHA, ...PINS, verdict: "approve" }))).status).toBe(404);
    const consoleError = vi.spyOn(console, "error").mockImplementation(() => undefined);
    recordMock.mockRejectedValueOnce(new Error("Failed query: insert … params: secret lesson text"));
    const response = await POST(post({ wiseSessionId: SESSION, fieldsSha256: SHA, ...PINS, verdict: "approve" }));
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

  it("answers missing review tables with a typed payload (200), and any other failure with a 500", async () => {
    authMock.mockResolvedValue({ user: { email: "a@x.com", role: "admin" } });
    reviewMock.mockResolvedValueOnce({ available: false, reason: "review_tables_missing" });
    const missing = await GET();
    expect(missing.status).toBe(200);
    expect(await missing.json()).toEqual({ available: false, reason: "review_tables_missing" });
    const consoleError = vi.spyOn(console, "error").mockImplementation(() => undefined);
    reviewMock.mockRejectedValueOnce(Object.assign(new Error("timeout"), { code: "57014" }));
    const failed = await GET();
    expect(failed.status).toBe(500);
    expect(consoleError).toHaveBeenCalledWith("[feedback-autowriter] review load failed", { errorName: "Error", sqlState: "57014" });
    consoleError.mockRestore();
  });
});

describe("POST /api/feedback-autowriter/incidents", () => {
  const url = "http://localhost/api/feedback-autowriter/incidents";

  it("lets only the owner acknowledge an incident", async () => {
    ownerMock.mockRejectedValue(new AdminUsersAccessError("nope", 403));
    expect((await acknowledge(post({ action: "acknowledge", incidentId: INCIDENT_ID }, url))).status).toBe(403);
    expect(acknowledgeMock).not.toHaveBeenCalled();
  });

  it("validates the body, answers an unknown incident with 404, and acknowledges as the owner", async () => {
    for (const body of ["x", { incidentId: INCIDENT_ID }, { action: "acknowledge", incidentId: "nope" }, { action: "acknowledge", incidentId: INCIDENT_ID, extra: 1 }]) {
      expect((await acknowledge(post(body, url))).status, JSON.stringify(body)).toBe(400);
    }
    acknowledgeMock.mockResolvedValueOnce(null);
    expect((await acknowledge(post({ action: "acknowledge", incidentId: INCIDENT_ID }, url))).status).toBe(404);
    acknowledgeMock.mockResolvedValueOnce({ id: INCIDENT_ID, acknowledgedAt: "2026-09-30T03:00:00.000Z", acknowledgedBy: "owner@example.com" });
    const response = await acknowledge(post({ action: "acknowledge", incidentId: INCIDENT_ID }, url));
    expect(response.status).toBe(200);
    expect(acknowledgeMock).toHaveBeenLastCalledWith(expect.anything(), { incidentId: INCIDENT_ID, actor: "owner@example.com" });
  });
});
