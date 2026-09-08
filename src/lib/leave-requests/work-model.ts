import { addBangkokDays, bangkokDateKey } from "@/lib/room-capacity/dates";
import type { CoverageRevision, FamilyWork, LeaveWindow, WorkAssignment } from "./work-types";

export function validDate(value: string): boolean {
  return /^\d{4}-\d{2}-\d{2}$/.test(value) && Number.isFinite(Date.parse(`${value}T00:00:00Z`))
    && new Date(`${value}T00:00:00Z`).toISOString().slice(0, 10) === value;
}

export function processingDate(classDate: string): string { return addBangkokDays(classDate, -7); }

export function bangkokMinute(date: Date): number {
  const parts = new Intl.DateTimeFormat("en-GB", { timeZone: "Asia/Bangkok", hour: "2-digit", minute: "2-digit", hourCycle: "h23" }).formatToParts(date);
  return Number(parts.find((p) => p.type === "hour")!.value) * 60 + Number(parts.find((p) => p.type === "minute")!.value);
}

export function sessionOverlapsLeave(start: Date, end: Date, windows: LeaveWindow[]): boolean {
  // Compare real instants, never the scheduler's shifted wall-clock Date objects.
  const date = bangkokDateKey(start);
  return windows.some((window) => {
    if (date < window.startDate || date > window.endDate) return false;
    const midnight = new Date(`${date}T00:00:00+07:00`).getTime();
    return start.getTime() < midnight + window.endMinute * 60_000
      && end.getTime() > midnight + window.startMinute * 60_000;
  });
}

export function sameCoverage(left: CoverageRevision[], right: CoverageRevision[]): boolean {
  const serialize = (items: CoverageRevision[]) => items.map((item) => `${item.sessionId}:${item.revision}`).sort().join("|");
  return serialize(left) === serialize(right);
}

export function familyComplete(family: Pick<FamilyWork, "informed" | "coverage" | "informedCoverage">): boolean {
  return Boolean(family.informed) && sameCoverage(family.coverage, family.informedCoverage);
}

export function assignmentComplete(assignment: Pick<WorkAssignment, "classes" | "families" | "issue">): boolean {
  const classes = assignment.classes.filter((item) => item.active);
  return !assignment.issue && classes.length > 0 && classes.every((item) => !!item.cancelled)
    && assignment.families.filter((item) => item.active).every(familyComplete);
}

export function formatWorkDate(value: string): string {
  return new Intl.DateTimeFormat("en-GB", { timeZone: "Asia/Bangkok", weekday: "short", day: "numeric", month: "short" }).format(new Date(`${value}T12:00:00+07:00`)).replace("Sept", "Sep");
}

export function formatWorkTime(value: string): string {
  return new Intl.DateTimeFormat("en-GB", { timeZone: "Asia/Bangkok", hour: "2-digit", minute: "2-digit", hourCycle: "h23" }).format(new Date(value));
}

export function sortAssignments(items: WorkAssignment[], date: string): WorkAssignment[] {
  const rank = (item: WorkAssignment) => item.done ? 2 : item.dueDate < date ? 0 : 1;
  return [...items].sort((a, b) => rank(a) - rank(b) || a.dueDate.localeCompare(b.dueDate) || a.classDate.localeCompare(b.classDate) || a.teacherName.localeCompare(b.teacherName));
}
