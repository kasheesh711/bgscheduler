import type { Overview } from "@/lib/progress-tests/workspace/data";
import type { Serialized } from "./shared";

export type TutorAssessment = Serialized<Overview>["assessments"][number];
export type TaskKind = "preparation" | "submission" | "review" | "upload";
export type TutorView = "tasks" | "students" | "library" | "history";

/** Queued and blocked publication are waiting states, never failed work. */
export function hasUploadIssue(a: TutorAssessment) {
  return ["failed", "uncertain", "needs_review"].includes(a.publicationStatus)
    || ["failed", "needs_review"].includes(a.preparationPublication?.status ?? "");
}
export function taskKind(a: TutorAssessment): TaskKind | null {
  if (hasUploadIssue(a)) return "upload";
  if (a.stage === "awaiting_submission") return "submission";
  if (a.stage === "tutor_review") return "review";
  if ((a.stage === "prepare" || a.stage === "ready") && a.position >= 6) return "preparation";
  return null;
}
export function tutorRows(rows: TutorAssessment[], view: TutorView, query = "", filter: TaskKind | "all" = "all") {
  const search = query.trim().toLocaleLowerCase();
  return rows.filter(a => {
    const kind = taskKind(a);
    return (view !== "tasks" || kind !== null && (filter === "all" || kind === filter))
      && (view !== "history" || a.stage === "approved")
      && `${a.series.studentName} ${a.series.courseName}`.toLocaleLowerCase().includes(search);
  }).sort((a, b) => Number(b.overdue) - Number(a.overdue)
    || a.series.studentName.localeCompare(b.series.studentName)
    || a.series.courseName.localeCompare(b.series.courseName) || a.cycle - b.cycle || a.id.localeCompare(b.id));
}
export function publicationLabel(a: TutorAssessment, ready: boolean) {
  if (["failed", "uncertain", "needs_review"].includes(a.publicationStatus)) return "Report upload needs attention";
  const prep = a.preparationPublication;
  if (prep && ["failed", "needs_review"].includes(prep.status)) return "Paper upload needs attention";
  if (a.stage === "approved") return a.publicationStatus === "published" ? "Published to Wise" : ready ? "Publication queued" : "Publication paused";
  if (!prep || ["removed", "cancelled"].includes(prep.status)) return "";
  if (prep.status === "published") return "Paper in Wise";
  return ready ? "Paper upload queued" : "Paper upload paused";
}
export function initialAssessmentStep(stage: TutorAssessment["stage"]) {
  return stage === "approved" ? 3 : stage === "tutor_review" ? 2 : stage === "awaiting_submission" ? 1 : 0;
}
export function milestoneSession(a: TutorAssessment) {
  // Upcoming sessions start after the attended count. Never substitute a future date for overdue work.
  return a.series.count < a.dueClass ? a.series.upcomingSessions[a.dueClass - a.series.count - 1]?.date : undefined;
}
