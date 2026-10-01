import { describe, expect, it } from "vitest";
import { atomModelEvidence, atomSubject, bangkokDate, buildAtomLessonEvidence, evidenceHash } from "../atom/evidence";
import { type AtomActivity, type AtomLesson, type AtomStudentLink, AtomActivitySchema } from "../atom/types";

const lesson: AtomLesson = { sessionId: "lesson", studentId: "wise1", teacherId: "teacher", subject: "maths", start: "2026-10-01T09:00:00Z", end: "2026-10-01T10:00:00Z" };
const link: AtomStudentLink = { id: "link", revision: 1, wiseStudentId: "wise1", atomStudentId: "atom1", approvedBy: "owner", approvedAt: "2026-10-01T08:00:00Z", active: true };
const activity: AtomActivity = { id: "activity1", studentId: "atom1", kind: "test", name: "ISEB Mathematics Test 7", subject: "maths", sourceUrl: "https://app.atomlearning.com/tutor/transcript/activity1", completedAt: "2026-10-01T10:00:00Z", purpose: "unknown", wiseTeacherUserId: null, totalQuestions: 5, sas: 109, modelledTopicEstimates: [{ topic: "Fractions", percent: 72 }], answers: [
  { questionId: "q1", answeredAt: "2026-10-01T09:15:00Z", correct: true, seconds: 30, assisted: false },
  { questionId: "q2", answeredAt: "2026-10-01T09:30:00Z", correct: false, seconds: 60, assisted: true },
] };
function build(overrides: Partial<Parameters<typeof buildAtomLessonEvidence>[0]> = {}, activities = [activity]) {
  return buildAtomLessonEvidence({ lesson, link, snapshot: { id: "snap", studentId: "atom1", collectedAt: "2026-10-01T10:00:00Z", sourceHash: evidenceHash(activities), activities }, now: new Date("2026-10-01T10:05:00Z"), otherLessons: [lesson], lessonRecord: "We practised fractions.", ...overrides });
}
describe("Atom lesson ownership and statistics", () => {
  it("keeps correct, attempted, total, time, SAS and estimates distinct, with assistance", () => {
    expect(build().activities[0]).toMatchObject({ correctAnswers: 1, attemptedQuestions: 2, totalQuestions: 5, seconds: 90, sas: 109, assistance: "assisted", modelledTopicEstimates: [{ percent: 72 }] });
  });
  it("never links by a name, even when names match", () => { expect(build({ link: null }).omissions[0].reason).toBe("student_unmapped"); });
  it("holds wrong-student mappings and source contradictions", () => {
    expect(build({ link: { ...link, wiseStudentId: "wrong" } }).status).toBe("contradiction");
    expect(build({}, [{ ...activity, studentId: "wrong" }]).activities).toHaveLength(0);
    expect(build({}, [{ ...activity, studentId: "wrong" }]).status).toBe("contradiction");
  });
  it("omits stale or inaccessible data, without inventing zeros", () => {
    expect(build({ now: new Date("2026-10-01T11:00:00Z") }).omissions[0].reason).toBe("stale_data");
    expect(build({ snapshot: null }).omissions[0].reason).toBe("collection_failed");
    expect(build({ unavailableReason: "authentication_failed" }).activities).toEqual([]);
  });
  it("requires a complete timetable before ruling out overlaps", () => { expect(build({ otherLessons: null }).omissions[0].reason).toBe("lesson_roster_unavailable"); });
  it("excludes overlapping lessons even for another subject or tutor", () => {
    expect(build({ otherLessons: [lesson, { ...lesson, sessionId: "other", teacherId: "other", subject: "english" }] }).omissions[0].reason).toBe("ambiguous_overlap");
  });
  it.each(["homework", "other_tutor"] as const)("excludes %s", reason => {
    const changed = reason === "homework" ? { purpose: "homework" as const } : { wiseTeacherUserId: "other" };
    expect(build({}, [{ ...activity, ...changed }]).omissions[0].reason).toBe(reason);
  });
  it("reports only the matched portion, excluding whole-activity SAS and estimates", () => {
    const earlier = { ...activity.answers[0], answeredAt: "2026-10-01T08:55:00Z" };
    expect(build({}, [{ ...activity, answers: [earlier, activity.answers[1]] }]).activities[0]).toMatchObject({ portion: "matched_portion", correctAnswers: 0, attemptedQuestions: 1, totalQuestions: 5, sas: null, seconds: 60, modelledTopicEstimates: [] });
  });
  it("uses half-open lesson windows across Bangkok midnight", () => {
    const midnight = { ...lesson, start: "2026-09-30T16:30:00Z", end: "2026-09-30T17:30:00Z" };
    expect(bangkokDate(midnight.start)).toBe("2026-09-30");
    expect(bangkokDate(midnight.end)).toBe("2026-10-01");
    const answers = [{ ...activity.answers[0], answeredAt: midnight.start }, { ...activity.answers[1], answeredAt: midnight.end }];
    expect(build({ lesson: midnight, otherLessons: [midnight] }, [{ ...activity, answers }]).activities[0].attemptedQuestions).toBe(1);
  });
  it("accepts an explicit current-lesson reference outside the window on the same date", () => {
    const outside = { ...activity, answers: activity.answers.map(a => ({ ...a, answeredAt: "2026-10-01T08:00:00Z" })) };
    expect(build({ lessonRecord: "During the lesson we reviewed ISEB Mathematics Test 7." }, [outside]).activities[0].match).toBe("explicit_reference");
    expect(build({ lessonRecord: "During the lesson we reviewed ISEB Mathematics Test 7." }, [outside, { ...outside, id: "activity2" }]).activities).toEqual([]);
  });
  it.each(["Homework: ISEB Mathematics Test 7.", "Today we assigned ISEB Mathematics Test 7.", "Last lesson we reviewed ISEB Mathematics Test 7.", "ISEB Mathematics Test 7."])("does not turn a mention into in-class work: %s", lessonRecord => {
    const outside = { ...activity, answers: activity.answers.map(a => ({ ...a, answeredAt: "2026-10-01T08:00:00Z" })) };
    expect(build({ lessonRecord }, [outside]).activities).toEqual([]);
  });
  it("an explicit reference cannot override the wrong subject or date", () => {
    const record = { lessonRecord: "Today we completed ISEB Mathematics Test 7." };
    expect(build(record, [{ ...activity, subject: "english" }]).activities).toEqual([]);
    expect(build(record, [{ ...activity, answers: activity.answers.map(a => ({ ...a, answeredAt: "2026-09-30T09:10:00Z" })) }]).activities).toEqual([]);
  });
  it("changes the evidence hash on a new mapping revision and removes identifiers from model input", () => {
    expect(build({ link: { ...link, revision: 2 } }).hash).not.toBe(build().hash);
    expect(atomModelEvidence(build())).not.toMatch(/atom1|wise1|activity1|https:/u);
  });
  it("refuses duplicate answer identities and impossible timestamps", () => {
    expect(AtomActivitySchema.safeParse({ ...activity, answers: [activity.answers[0], activity.answers[0]] }).success).toBe(false);
    expect(AtomActivitySchema.safeParse({ ...activity, completedAt: "2026-10-01T08:00:00Z" }).success).toBe(false);
  });
  it("resolves NVR before VR and leaves unknown subjects unresolved", () => {
    expect(atomSubject("Online 13+ NVR")).toBe("non_verbal_reasoning"); expect(atomSubject("French")).toBe(null);
  });
});
