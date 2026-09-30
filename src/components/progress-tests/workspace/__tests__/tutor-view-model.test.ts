import { describe, expect, it } from "vitest";
import { hasUploadIssue, initialAssessmentStep, milestoneSession, publicationLabel, taskKind, tutorRows, type TutorAssessment } from "../tutor-view-model";

function assessment(patch: Partial<TutorAssessment> = {}): TutorAssessment {
  return { id: "a", cycle: 1, stage: "prepare", position: 6, overdue: false, dueClass: 8, publicationStatus: "not_ready", preparationPublication: null,
    series: { studentName: "Maya", courseName: "Mathematics", count: 6, upcomingSessions: [{ id: "class-7", date: "2026-10-01T03:00:00Z" }, { id: "class-8", date: "2026-10-08T03:00:00Z" }] }, ...patch } as TutorAssessment;
}
describe("tutor task queue", () => {
  it("starts preparation at six attended classes and includes ready, submission and review work", () => {
    expect(taskKind(assessment({ position: 5 }))).toBeNull();
    expect(taskKind(assessment())).toBe("preparation");
    expect(taskKind(assessment({ stage: "ready", position: 7 }))).toBe("preparation");
    expect(taskKind(assessment({ stage: "awaiting_submission" }))).toBe("submission");
    expect(taskKind(assessment({ stage: "tutor_review" }))).toBe("review");
  });
  it("shows an assessment once even when overdue, awaiting review and an upload has failed", () => {
    const row = assessment({ stage: "tutor_review", overdue: true, publicationStatus: "failed" });
    expect(tutorRows([row], "tasks")).toEqual([row]);
    expect(tutorRows([row], "tasks", "", "upload")).toEqual([row]);
    expect(tutorRows([row], "tasks", "", "review")).toEqual([]);
  });
  it.each(["queued", "blocked", "published"] as const)("does not turn %s publication into a failure", status => {
    const row = assessment({ stage: "approved", publicationStatus: status });
    expect(hasUploadIssue(row)).toBe(false);
    expect(tutorRows([row], "tasks")).toHaveLength(0);
    expect(tutorRows([row], "history")).toEqual([row]);
  });
  it.each(["failed", "uncertain", "needs_review"] as const)("brings %s publication into upload issues", status => {
    expect(taskKind(assessment({ stage: "approved", publicationStatus: status }))).toBe("upload");
  });
  it("keeps paused paper uploads separate without removing preparation or submission tasks", () => {
    const row = assessment({ stage: "awaiting_submission", preparationPublication: { status: "queued" } as NonNullable<TutorAssessment["preparationPublication"]> });
    expect(taskKind(row)).toBe("submission");
    expect(publicationLabel(row, false)).toBe("Paper upload paused");
    expect(publicationLabel(row, true)).toBe("Paper upload queued");
  });
  it("sorts overdue work first, then retains distinct cycles in a stable student order", () => {
    const later = assessment({ id: "cycle2", cycle: 2 });
    const overdue = assessment({ id: "overdue", overdue: true, series: { ...assessment().series, studentName: "Zoe" } });
    const input = [later, assessment(), overdue];
    expect(tutorRows(input, "tasks").map(a => a.id)).toEqual(["overdue", "a", "cycle2"]);
    expect(input[0].id).toBe("cycle2");
  });
  it("shows the complete overview while filtering history to approved assessments", () => {
    const early = assessment({ id: "early", position: 2 });
    const approved = assessment({ id: "approved", stage: "approved" });
    expect(tutorRows([early, approved], "students")).toHaveLength(2);
    expect(tutorRows([early, approved], "history")).toEqual([approved]);
    expect(tutorRows([early], "students", " CHEMISTRY ")).toEqual([]);
    expect(tutorRows([early], "students", " maya ")).toEqual([early]);
    expect(tutorRows([], "tasks")).toEqual([]);
  });
  it("uses the eighth class date and never invents dates for overdue or missing sessions", () => {
    expect(milestoneSession(assessment())).toBe("2026-10-08T03:00:00Z");
    expect(milestoneSession(assessment({ series: { ...assessment().series, count: 9 } }))).toBeUndefined();
    expect(milestoneSession(assessment({ series: { ...assessment().series, upcomingSessions: [] } }))).toBeUndefined();
  });
  it("opens the relevant assessment step", () => {
    expect(["prepare", "ready", "awaiting_submission", "tutor_review", "approved"].map(stage => initialAssessmentStep(stage as TutorAssessment["stage"]))).toEqual([0, 0, 1, 2, 3]);
  });
});
