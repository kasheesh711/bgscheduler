import { randomUUID } from "node:crypto";
import { and, asc, desc, eq, gte, inArray, lt, lte, sql } from "drizzle-orm";
import type { Database } from "@/lib/db";
import * as s from "@/lib/db/schema";
import { withDatabaseTransaction } from "@/lib/db/transaction";
import { todayBangkok } from "@/lib/room-capacity/dates";
import { assignmentComplete, sortAssignments } from "./work-model";
import { digest } from "./normalization";
import type { ClassWork, CompletionEvidence, LeaveBoard, WorkAssignment } from "./work-types";

export class LeaveWorkConflict extends Error { constructor(message = "This work changed. Refresh and try again.") { super(message); } }
export class LeaveWorkNotFound extends Error {}

const hasActiveClasses = sql`exists (select 1 from leave_class_tasks t where t.assignment_id = ${s.leaveAssignments.id} and t.active)`;

export async function eligibleLeaveAdmins(db: Database) {
  const [admins, people] = await Promise.all([db.select().from(s.adminUsers), db.select().from(s.leaveRosterPeople)]);
  return admins.filter((a) => !a.disabled && (a.allowedPages === null || a.allowedPages.includes("/leave-requests")))
    .map((a) => ({ email: a.email.trim().toLowerCase(), name: people.find((p) => p.email.toLowerCase() === a.email.toLowerCase())?.name || a.name || a.email.split("@")[0] }));
}

export async function assertLeaveAdmin(db: Database, email: string) {
  const admin = (await eligibleLeaveAdmins(db)).find((a) => a.email === email.toLowerCase());
  if (!admin) throw new Error("Leave Requests access is required.");
  return admin;
}

export async function setWorkState(db: Database, key: string, value: Record<string, unknown>) {
  await db.insert(s.leaveWorkState).values({ key, value }).onConflictDoUpdate({ target: s.leaveWorkState.key, set: { value, updatedAt: new Date() } });
}

export const serializeClass = (row: typeof s.leaveClassTasks.$inferSelect): ClassWork => ({ ...row, startTime: row.startTime.toISOString(), endTime: row.endTime.toISOString() });

export async function hydrateAssignments(db: Database, assignments: Array<typeof s.leaveAssignments.$inferSelect>): Promise<WorkAssignment[]> {
  if (!assignments.length) return [];
  const ids = assignments.map((a) => a.id);
  const [classes, families] = await Promise.all([
    db.select().from(s.leaveClassTasks).where(inArray(s.leaveClassTasks.assignmentId, ids)).orderBy(asc(s.leaveClassTasks.startTime)),
    db.select().from(s.leaveFamilyTasks).where(inArray(s.leaveFamilyTasks.assignmentId, ids)).orderBy(asc(s.leaveFamilyTasks.label)),
  ]);
  return assignments.map((row) => ({ ...row, classes: classes.filter((c) => c.assignmentId === row.id).map(serializeClass), families: families.filter((f) => f.assignmentId === row.id) }));
}

export async function refreshAssignmentCompletion(db: Database, assignmentId: string) {
  const [row] = await db.select().from(s.leaveAssignments).where(eq(s.leaveAssignments.id, assignmentId));
  const [assignment] = await hydrateAssignments(db, [row]);
  const done = assignmentComplete(assignment);
  await db.update(s.leaveAssignments).set({ done, updatedAt: new Date() }).where(eq(s.leaveAssignments.id, assignmentId));
  return done;
}

export async function countDueLeaveAssignments(db: Database, today = todayBangkok()) {
  const [row] = await db.select({ total: sql<number>`count(*)::int`, overdue: sql<number>`count(*) filter (where ${s.leaveAssignments.dueDate} < ${today})::int` })
    .from(s.leaveAssignments).where(and(hasActiveClasses, eq(s.leaveAssignments.done, false), lte(s.leaveAssignments.dueDate, today), gte(s.leaveAssignments.classDate, today)));
  return { total: row?.total ?? 0, overdue: row?.overdue ?? 0 };
}

export async function getLeaveBoard(db: Database, input: { email: string; date: string; view?: "daily" | "upcoming" | "history"; q?: string }): Promise<LeaveBoard> {
  const today = todayBangkok();
  const date = input.date;
  const view = input.view ?? "daily";
  const scope = view === "upcoming" ? and(gte(s.leaveAssignments.classDate, today), sql`${s.leaveAssignments.dueDate} > ${date}`)
    : view === "history" ? lt(s.leaveAssignments.classDate, today)
      : and(gte(s.leaveAssignments.classDate, date < today ? date : today), lte(s.leaveAssignments.dueDate, date));
  const [rows, states, shifts, people, admins, normalizations, requests, running, dueRows] = await Promise.all([
    db.select().from(s.leaveAssignments).where(and(hasActiveClasses, scope)).orderBy(asc(s.leaveAssignments.classDate)),
    db.select().from(s.leaveWorkState),
    db.select().from(s.leaveRosterShifts).where(eq(s.leaveRosterShifts.date, date)),
    db.select().from(s.leaveRosterPeople), eligibleLeaveAdmins(db),
    db.select({ status: s.leaveNormalizations.status, error: s.leaveNormalizations.error, teacher: s.leaveRequests.tutorName, row: s.leaveRequests.sourceRowNumber })
      .from(s.leaveNormalizations).innerJoin(s.leaveRequests, and(eq(s.leaveRequests.id, s.leaveNormalizations.requestId), eq(s.leaveRequests.currentNormalizationKey, s.leaveNormalizations.inputKey))),
    db.select().from(s.leaveRequests).orderBy(desc(s.leaveRequests.sourceSubmittedAt)),
    db.select().from(s.leaveRequestSyncRuns).where(eq(s.leaveRequestSyncRuns.status, "running")).limit(1),
    db.select().from(s.leaveAssignments).where(and(hasActiveClasses, eq(s.leaveAssignments.done, false), lte(s.leaveAssignments.dueDate, date), gte(s.leaveAssignments.classDate, date))),
  ]);
  const assignments = await hydrateAssignments(db, rows);
  const state = new Map(states.map((row) => [row.key, row.value]));
  const sourceReadAt = state.get("source")?.readAt as string | undefined;
  const classesReadAt = state.get("classes")?.readAt as string | undefined;
  const rosterReadAt = state.get("roster")?.readAt as string | undefined;
  const errors = [state.get("source")?.error, state.get("classes")?.error, state.get("roster")?.error, state.get("processing")?.error].filter((e): e is string => typeof e === "string" && !!e);
  errors.push(...normalizations.filter((n) => n.status === "failed").map((n) => `${n.teacher} · row ${n.row}: ${n.error || "Interpretation failed; will retry automatically."}`));
  errors.push(...requests.filter((r) => r.matchConfidence === "unmatched" && (!r.endDate || r.endDate >= today)).map((r) => `${r.tutorName} · row ${r.sourceRowNumber}: teacher identity unresolved.`));
  if (Number(state.get("classes")?.remainingBundles) > 0) errors.push(`${state.get("classes")?.remainingBundles} class-date assignments are still being built. The next sync resumes automatically.`);
  const term = input.q?.trim().toLowerCase();
  const roster = people.filter((p) => admins.some((a) => a.email === p.email)).map((person) => {
    const shift = shifts.find((row) => row.personKey === person.key);
    const unfinished = dueRows.filter((row) => row.ownerEmail === person.email).length;
    return { ...person, status: shift?.status ?? "unknown", shift: shift?.shift ?? null, startMinute: shift?.startMinute ?? null, endMinute: shift?.endMinute ?? null, note: shift?.note ?? null, unfinished, needsCover: shift?.status === "working" ? 0 : unfinished };
  });
  return {
    date, today, viewerEmail: input.email, defaultOwner: people.some((p) => p.email === input.email) ? input.email : "everyone",
    roster, admins,
    assignments: sortAssignments(term ? assignments.filter((a) => JSON.stringify([a.teacherName, a.ownerName, a.classDate, a.families.map((f) => [f.label, f.students.map((st) => st.name)])]).toLowerCase().includes(term)) : assignments, date),
    history: view === "history" ? requests.filter((r) => r.endDate && r.endDate < today && (!term || JSON.stringify([r.tutorName, r.sourceSheetStatus, r.startDate, r.endDate]).toLowerCase().includes(term))).map((r) => ({ id: r.id, teacher: r.tutorDisplayName || r.tutorName, startDate: r.startDate, endDate: r.endDate, status: r.sourceSheetStatus || r.workflowStatus, error: r.normalizationError })) : [],
    freshness: {
      sourceReadAt: sourceReadAt ?? null, classesReadAt: classesReadAt ?? null, rosterReadAt: rosterReadAt ?? null,
      running: running.length > 0, stale: !sourceReadAt || Date.now() - Date.parse(sourceReadAt) > 60 * 60_000 || !classesReadAt || Date.now() - Date.parse(classesReadAt) > 90 * 60_000,
      errors, pendingNormalization: normalizations.filter((n) => n.status === "pending").length, failedNormalization: normalizations.filter((n) => n.status === "failed").length,
      pendingWritebacks: requests.filter((r) => r.sheetWriteStatus === "pending" || r.sheetWriteStatus === "failed").length,
    },
  };
}

export interface LeaveMutation {
  mutationKey: string;
  expectedVersion: number;
  kind: "owner" | "family" | "class";
  entityId: string;
  checked?: boolean;
  ownerEmail?: string | null;
}

export async function mutateLeaveWork(db: Database, assignmentId: string, mutation: LeaveMutation, actor: { email: string; name: string | null }) {
  await assertLeaveAdmin(db, actor.email);
  const nextOwner = mutation.kind === "owner" && mutation.ownerEmail ? await assertLeaveAdmin(db, mutation.ownerEmail) : null;
  return withDatabaseTransaction(db, async (tx) => {
    const [assignment] = await tx.select().from(s.leaveAssignments).where(eq(s.leaveAssignments.id, assignmentId)).for("update");
    if (!assignment) throw new LeaveWorkNotFound("Assignment not found.");
    const [existingEvent] = await tx.select().from(s.leaveWorkEvents).where(eq(s.leaveWorkEvents.mutationKey, mutation.mutationKey));
    if (existingEvent) {
      if (existingEvent.assignmentId !== assignmentId || existingEvent.actorEmail !== actor.email || digest(existingEvent.payload.mutation) !== digest(mutation)) throw new LeaveWorkConflict("That operation ID has already been used.");
      return { success: true, replayed: true };
    }
    const now = new Date();
    const evidence: CompletionEvidence = { source: "admin", actorEmail: actor.email, actorName: actor.name, completedAt: now.toISOString(), recordedAt: now.toISOString(), note: null };
    let before: unknown;
    if (mutation.kind === "owner") {
      if (assignment.version !== mutation.expectedVersion) throw new LeaveWorkConflict();
      before = { ownerEmail: assignment.ownerEmail, ownerName: assignment.ownerName };
      await tx.update(s.leaveAssignments).set({ ownerEmail: nextOwner?.email ?? null, ownerName: nextOwner?.name ?? null, assignedDate: todayBangkok(now), version: assignment.version + 1, updatedAt: now }).where(eq(s.leaveAssignments.id, assignmentId));
    } else if (mutation.kind === "class") {
      const [task] = await tx.select().from(s.leaveClassTasks).where(and(eq(s.leaveClassTasks.id, mutation.entityId), eq(s.leaveClassTasks.assignmentId, assignmentId))).for("update");
      if (!task) throw new LeaveWorkNotFound("Class task not found.");
      if (task.version !== mutation.expectedVersion || !task.active) throw new LeaveWorkConflict();
      if (/^(CANCELLED|CANCELED)$/i.test(task.wiseStatus) && !mutation.checked) throw new LeaveWorkConflict("Wise already reports this class cancelled. Its evidence cannot be undone here.");
      before = task.cancelled;
      await tx.update(s.leaveClassTasks).set({ cancelled: mutation.checked ? task.cancelled ?? evidence : null, version: task.version + 1 }).where(eq(s.leaveClassTasks.id, task.id));
    } else {
      const [task] = await tx.select().from(s.leaveFamilyTasks).where(and(eq(s.leaveFamilyTasks.id, mutation.entityId), eq(s.leaveFamilyTasks.assignmentId, assignmentId))).for("update");
      if (!task) throw new LeaveWorkNotFound("Family task not found.");
      if (task.version !== mutation.expectedVersion || !task.active) throw new LeaveWorkConflict();
      before = { informed: task.informed, coverage: task.informedCoverage };
      await tx.update(s.leaveFamilyTasks).set({ informed: mutation.checked ? evidence : null, informedCoverage: mutation.checked ? task.coverage : [], version: task.version + 1 }).where(eq(s.leaveFamilyTasks.id, task.id));
    }
    if (mutation.kind !== "owner") {
      await tx.update(s.leaveAssignments).set({ version: assignment.version + 1 }).where(eq(s.leaveAssignments.id, assignmentId));
      await refreshAssignmentCompletion(tx, assignmentId);
      if (assignment.sourceRequestIds.length) await tx.update(s.leaveRequests).set({ sheetWriteStatus: "pending", updatedAt: now }).where(inArray(s.leaveRequests.id, assignment.sourceRequestIds));
    }
    await tx.insert(s.leaveWorkEvents).values({ assignmentId, mutationKey: mutation.mutationKey, actorEmail: actor.email, actorName: actor.name, action: mutation.kind === "owner" ? "owner_changed" : mutation.checked ? `${mutation.kind}_completed` : `${mutation.kind}_undone`, payload: { mutation, before } });
    return { success: true, replayed: false };
  });
}

export async function recordSystemEvent(db: Database, assignmentId: string, action: string, payload: Record<string, unknown>) {
  await db.insert(s.leaveWorkEvents).values({ assignmentId, action, mutationKey: randomUUID(), payload });
}

export async function assignmentActivity(db: Database, id: string) {
  return db.select().from(s.leaveWorkEvents).where(eq(s.leaveWorkEvents.assignmentId, id)).orderBy(desc(s.leaveWorkEvents.createdAt)).limit(100);
}
