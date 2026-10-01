import { beforeEach, describe, expect, it, vi } from "vitest";
import { NextRequest } from "next/server";

vi.mock("server-only", () => ({}));
vi.mock("@/lib/auth", () => ({ auth: vi.fn() }));
vi.mock("@/lib/db", () => ({ getDb: vi.fn(() => ({})) }));
vi.mock("@/lib/admin-users/access", () => ({ requireSuperAdmin: vi.fn() }));
vi.mock("@/lib/tutor-offboarding/service", () => ({ loadTutorOffboardingDashboard: vi.fn(), findPersonRow: vi.fn() }));
vi.mock("@/lib/tutor-offboarding/decisions", () => ({ recordStillWithUs: vi.fn(), revokeDecision: vi.fn() }));
vi.mock("@/lib/tutor-offboarding/grants", async (importOriginal) => ({
  ...await importOriginal<typeof import("@/lib/tutor-offboarding/grants")>(),
  hasRemovalGrant: vi.fn(async () => false),
  listGrants: vi.fn(async () => []),
  changeGrant: vi.fn(async () => []),
}));

import { auth } from "@/lib/auth";
import { requireSuperAdmin } from "@/lib/admin-users/access";
import { AdminUsersAccessError } from "@/lib/admin-users/types";
import { recordStillWithUs, revokeDecision } from "@/lib/tutor-offboarding/decisions";
import { TutorOffboardingError } from "@/lib/tutor-offboarding/errors";
import { changeGrant } from "@/lib/tutor-offboarding/grants";
import { findPersonRow, loadTutorOffboardingDashboard } from "@/lib/tutor-offboarding/service";
import type { OffboardingPersonRow } from "@/lib/tutor-offboarding/types";
import { GET } from "../route";
import { POST as postDecision } from "../decisions/route";
import { DELETE as deleteDecision } from "../decisions/[decisionId]/route";
import { GET as getGrants, POST as postGrant } from "../grants/route";

const authMock = vi.mocked(auth as unknown as () => Promise<unknown>);
const dashboardMock = vi.mocked(loadTutorOffboardingDashboard);
const findMock = vi.mocked(findPersonRow);
const recordMock = vi.mocked(recordStillWithUs);
const revokeMock = vi.mocked(revokeDecision);
const ownerMock = vi.mocked(requireSuperAdmin);
const grantMock = vi.mocked(changeGrant);

const DECISION_ID = "11111111-1111-4111-8111-111111111111";
const ROW = {
  signals: { canonicalKey: "Aria" },
  score: { likelihood: 96, band: "very_likely_gone", reasons: [{ code: "idle_gap", direction: "toward_gone", text: "Last class 120 days ago (3 Jun)" }] },
} as unknown as OffboardingPersonRow;

function json(body: unknown, url = "http://localhost/api/tutor-offboarding/decisions", method = "POST") {
  return new NextRequest(url, { method, body: typeof body === "string" ? body : JSON.stringify(body), headers: { "Content-Type": "application/json" } });
}

function signedIn(role = "admin") {
  authMock.mockResolvedValue({ user: { email: "Admin@Example.com", role } });
}

beforeEach(() => {
  vi.clearAllMocks();
  signedIn();
  ownerMock.mockResolvedValue({ email: "owner@example.com", accessVersion: 1 });
});

describe("GET /api/tutor-offboarding", () => {
  it("requires an admin session", async () => {
    authMock.mockResolvedValue(null);
    expect((await GET()).status).toBe(401);
    signedIn("teacher");
    expect((await GET()).status).toBe(403);
    expect(dashboardMock).not.toHaveBeenCalled();
  });

  it("returns the dashboard for the signed-in admin", async () => {
    dashboardMock.mockResolvedValue({ available: false, reason: "not_set_up", viewer: { email: "admin@example.com", isOwner: false, canRemove: false } });
    const response = await GET();
    expect(response.status).toBe(200);
    expect(dashboardMock).toHaveBeenCalledWith({ email: "admin@example.com", isOwner: false, canRemove: false });
    expect(await response.json()).toMatchObject({ available: false, reason: "not_set_up" });
  });

  it("hides an unexpected failure behind a generic message", async () => {
    vi.spyOn(console, "error").mockImplementation(() => undefined);
    dashboardMock.mockRejectedValue(new Error("connection reset"));
    const response = await GET();
    expect([response.status, await response.json()]).toEqual([500, { error: "The tutor offboarding dashboard could not load." }]);
  });
});

describe("POST /api/tutor-offboarding/decisions", () => {
  it("rejects bad bodies, including a client-sent score", async () => {
    for (const body of ["not json", { canonicalKey: "Aria", snoozeDays: 30 }, { canonicalKey: "", snoozeDays: 90 }, { canonicalKey: "Aria", snoozeDays: 90, likelihood: 1 }]) {
      expect((await postDecision(json(body))).status).toBe(400);
    }
    expect(recordMock).not.toHaveBeenCalled();
  });

  it("refuses a person who is not on the page", async () => {
    findMock.mockResolvedValue(null);
    expect((await postDecision(json({ canonicalKey: "Nobody", snoozeDays: 90 }))).status).toBe(404);
  });

  it("records the decision with the score the server computed", async () => {
    findMock.mockResolvedValue(ROW);
    recordMock.mockResolvedValue({ id: DECISION_ID } as never);
    const response = await postDecision(json({ canonicalKey: "Aria", note: "  On a term break ", snoozeDays: 365 }));
    expect(response.status).toBe(200);
    expect(recordMock).toHaveBeenCalledWith({}, {
      canonicalKey: "Aria", note: "On a term break", snoozeDays: 365, actorEmail: "admin@example.com",
      score: { likelihood: 96, band: "very_likely_gone", reasons: ["Last class 120 days ago (3 Jun)"] },
    });
  });

  it("passes a conflict through as 409", async () => {
    findMock.mockResolvedValue(ROW);
    recordMock.mockRejectedValue(new TutorOffboardingError("This tutor is already marked still with us.", 409));
    const response = await postDecision(json({ canonicalKey: "Aria", snoozeDays: 90 }));
    expect([response.status, await response.json()]).toEqual([409, { error: "This tutor is already marked still with us." }]);
  });

  it("keeps Wise staff accounts read-only even when an admin submits a decision directly", async () => {
    findMock.mockResolvedValue({ ...ROW, score: { ...ROW.score, exclusion: { code: "wise_admin", text: "Wise staff account" } } });
    recordMock.mockResolvedValue({ id: DECISION_ID } as never);
    const response = await postDecision(json({ canonicalKey: "Aria", snoozeDays: 90 }));
    expect(response.status).toBe(409);
    expect(await response.json()).toEqual({ error: "Wise staff accounts are read-only." });
    expect(recordMock).not.toHaveBeenCalled();
  });
});

describe("DELETE /api/tutor-offboarding/decisions/[decisionId]", () => {
  it("undoes a decision by id and rejects anything that is not one", async () => {
    revokeMock.mockResolvedValue({ id: DECISION_ID } as never);
    const ok = await deleteDecision(json({}, `http://localhost/api/tutor-offboarding/decisions/${DECISION_ID}`, "DELETE"), { params: Promise.resolve({ decisionId: DECISION_ID }) });
    expect(ok.status).toBe(200);
    expect(revokeMock).toHaveBeenCalledWith({}, { decisionId: DECISION_ID, actorEmail: "admin@example.com" });
    const bad = await deleteDecision(json({}, "http://localhost/api/tutor-offboarding/decisions/x", "DELETE"), { params: Promise.resolve({ decisionId: "x" }) });
    expect(bad.status).toBe(404);
  });
});

describe("/api/tutor-offboarding/grants", () => {
  it("is owner-only", async () => {
    ownerMock.mockRejectedValue(new AdminUsersAccessError("Only the website owner can manage access", 403));
    const response = await getGrants();
    expect([response.status, await response.json()]).toEqual([403, { error: "Only the website owner can change who can remove tutors." }]);
    expect((await postGrant(json({ action: "grant", email: "ops@example.com" }, "http://localhost/api/tutor-offboarding/grants"))).status).toBe(403);
    expect(grantMock).not.toHaveBeenCalled();
  });

  it("validates the change and passes it to the store", async () => {
    expect((await postGrant(json({ action: "promote", email: "ops@example.com" }, "http://localhost/api/tutor-offboarding/grants"))).status).toBe(400);
    expect((await postGrant(json({ action: "grant", email: "not-an-email" }, "http://localhost/api/tutor-offboarding/grants"))).status).toBe(400);
    const response = await postGrant(json({ action: "grant", email: "ops@example.com" }, "http://localhost/api/tutor-offboarding/grants"));
    expect(response.status).toBe(200);
    expect(grantMock).toHaveBeenCalledWith({}, { action: "grant", email: "ops@example.com", actorEmail: "owner@example.com" });
  });
});
