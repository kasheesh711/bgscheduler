import { describe, expect, it } from "vitest";
import { assertCompleteRoster, accountFingerprint, removalMode, personUnsafeReason } from "../removal-safety";
import type { WiseTeacher } from "@/lib/wise/types";

const teacher: WiseTeacher = { _id: "teacher-1", userId: { _id: "user-1", name: "Aria", email: "aria@example.com" }, relation: "TEACHER", classes: [], tags: [] };
describe("removal safety", () => {
  it("requires both production and verified contract for live mode", () => {
    expect(removalMode({ VERCEL_ENV: "preview", WISE_TEACHER_REMOVAL_VERIFIED: "true" })).toBe("manual");
    expect(removalMode({ VERCEL_ENV: "production" })).toBe("manual");
    expect(removalMode({ VERCEL_ENV: "production", WISE_TEACHER_REMOVAL_VERIFIED: "true" })).toBe("live");
  });
  it("does not use an empty or duplicate roster as absence evidence", () => {
    expect(() => assertCompleteRoster([])).toThrow();
    expect(() => assertCompleteRoster([teacher, teacher])).toThrow();
    expect(() => assertCompleteRoster([{ ...teacher, userId: undefined }])).toThrow();
    expect(() => assertCompleteRoster([null as unknown as WiseTeacher])).toThrow("incomplete");
  });
  it("detects relevant account drift and ignores incidental timestamps", () => {
    expect(accountFingerprint(teacher)).toBe(accountFingerprint({ ...teacher, updatedAt: "tomorrow" }));
    expect(accountFingerprint(teacher)).not.toBe(accountFingerprint({ ...teacher, relation: "ADMIN" }));
  });
  it("blocks the whole person for new variants, staff or ongoing sessions", () => {
    const input = { expected: [teacher], current: [teacher], sessions: [], now: new Date("2026-10-01T05:00:00Z"), blocked: false };
    expect(personUnsafeReason(input)).toBeNull();
    expect(personUnsafeReason({ ...input, current: [teacher, { ...teacher, _id: "teacher-2", userId: "user-2" }] })).toMatch(/changed/);
    expect(personUnsafeReason({ ...input, current: [{ ...teacher, relation: "ADMIN" }] })).toBeTruthy();
    expect(personUnsafeReason({ ...input, current: [{ ...teacher, classes: ["class"] }] })).toBeTruthy();
    expect(personUnsafeReason({ ...input, sessions: [{ _id: "session", userId: "user-1", scheduledStartTime: "2026-10-01T04:30:00Z", scheduledEndTime: "2026-10-01T05:30:00Z" }] })).toMatch(/class/);
    expect(personUnsafeReason({ ...input, blocked: true })).toMatch(/identity/);
    expect(personUnsafeReason({ ...input, sessions: [{ _id: "session", userId: "someone-else", teacherId: "teacher-1", scheduledStartTime: "2026-10-01T04:30:00Z", scheduledEndTime: "2026-10-01T05:30:00Z" }] })).toMatch(/class/);
    const retained = { ...teacher, classes: ["historical-course"] };
    expect(personUnsafeReason({ ...input, expected: [retained], current: [retained] })).toBeNull();
    expect(personUnsafeReason({ ...input, sessions: [{ _id: "broken", userId: "u1", scheduledStartTime: "broken", scheduledEndTime: "broken" }] })).toMatch(/incomplete/);
  });
});
