import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));
vi.mock("@/lib/db", () => ({ getDb: vi.fn(() => ({ db: true })) }));
vi.mock("@/lib/tutor-offboarding/access", () => ({ requireTutorOffboardingAdmin: vi.fn() }));
vi.mock("@/lib/tutor-offboarding/workforce/source-db", () => ({ loadWorkforceEvidence: vi.fn() }));
vi.mock("@/lib/tutor-offboarding/workforce/subject-mappings", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/tutor-offboarding/workforce/subject-mappings")>();
  return { ...actual, saveSubjectMapping: vi.fn() };
});

import { getDb } from "@/lib/db";
import { requireTutorOffboardingAdmin } from "@/lib/tutor-offboarding/access";
import { loadWorkforceEvidence } from "@/lib/tutor-offboarding/workforce/source-db";
import { saveSubjectMapping } from "@/lib/tutor-offboarding/workforce/subject-mappings";
import { TutorOffboardingError } from "@/lib/tutor-offboarding/errors";
import { GET, POST } from "../route";

const mapping = { id: "d1487fa4-468e-4b3c-a72e-2837231135e5", classId: "class-1", sourceValue: "In-Person Session - Physics", subject: "Physics", curriculum: "IGCSE", level: null, revision: 1, reviewedBy: "reviewer@example.test", reviewedAt: "2026-10-01T00:00:00.000Z" };
const session = (id: string, classId: string, classTitle: string, startAt: string, tutor: string) => ({
  wiseSessionId: id, wiseClassId: classId, classTitle, startAt, endAt: null, scheduledMinutes: 60,
  canonicalTutorKeys: [tutor], wiseTeacherIds: [], wiseUserIds: [], historicalBookedStudentIds: ["student-1"],
  participantCompleteness: "partial" as const, completeness: "complete" as const,
  meetingStatus: "ENDED", attendanceStatus: null, modality: "onsite" as const,
  subject: null, curriculum: null, level: null, reasonCodes: [],
});
const evidence = {
  revision: "source-r1", people: [{ canonicalKey: "p1", displayName: "Tutor", role: "tutor" as const, rosterState: "active" as const, joinedAt: null, accounts: [], firstObservedAt: null, lastObservedAt: null, identityCompleteness: "complete" as const, reasonCodes: [] }],
  observations: [], tutorFacts: [], sessions: [session("s1", "class-1", "In-Person Session - Physics", "2026-09-10T03:00:00Z", "p1"), session("s2", "class-2", "Trial Session - Biology", "2026-09-11T03:00:00Z", "p1")],
  historicalBookedParticipants: [], studentCredits: [], subjectMappings: [mapping], terminationMarks: [], sourceCoverage: [],
};
const url = (params = "") => new Request(`https://example.test/api/mappings?from=2026-09-01&to=2026-09-30&viewMonth=2026-09${params}`);

beforeEach(() => {
  vi.clearAllMocks();
  vi.mocked(requireTutorOffboardingAdmin).mockResolvedValue({ email: "admin@example.test", isOwner: false, canRemove: false });
  vi.mocked(loadWorkforceEvidence).mockResolvedValue(evidence as never);
  vi.mocked(saveSubjectMapping).mockResolvedValue(mapping);
});

describe("workforce subject mapping route", () => {
  it("authorizes before reading mappings and returns no-store headers", async () => {
    vi.mocked(requireTutorOffboardingAdmin).mockRejectedValue(new TutorOffboardingError("Unauthorized", 401));
    const response = await GET(url());
    expect(response.status).toBe(401);
    expect(response.headers.get("cache-control")).toBe("private, no-store");
    expect(loadWorkforceEvidence).not.toHaveBeenCalled();
    expect(getDb).not.toHaveBeenCalled();
  });

  it("returns reviewed mappings and source labels for unmapped booked classes", async () => {
    const response = await GET(url());
    expect(response.status).toBe(200);
    expect(response.headers.get("cache-control")).toBe("private, no-store");
    expect(await response.json()).toEqual({ mappings: [mapping], unmappedClasses: [{ classId: "class-2", sourceValue: "Trial Session - Biology", bookedHours: 1, sessionsCount: 1 }] });
  });

  it("derives the reviewer from the server session and rejects stale edits", async () => {
    const payload = { id: mapping.id, classId: mapping.classId, sourceValue: mapping.sourceValue, subject: "Physics", curriculum: "IGCSE", level: null, expectedRevision: 1 };
    const response = await POST(new Request("https://example.test/api/mappings", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(payload) }));
    expect(response.status).toBe(200);
    expect(saveSubjectMapping).toHaveBeenCalledWith(getDb(), payload, "admin@example.test");
    vi.mocked(saveSubjectMapping).mockRejectedValueOnce(new TutorOffboardingError("This subject mapping changed.", 409));
    const stale = await POST(new Request("https://example.test/api/mappings", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(payload) }));
    expect(stale.status).toBe(409);
    expect(stale.headers.get("cache-control")).toBe("private, no-store");
  });

  it("rejects malformed edits before writing", async () => {
    const response = await POST(new Request("https://example.test/api/mappings", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ expectedRevision: -1 }) }));
    expect(response.status).toBe(400);
    expect(saveSubjectMapping).not.toHaveBeenCalled();
  });
});
