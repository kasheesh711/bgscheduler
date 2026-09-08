import { and, eq, gte, inArray, sql } from "drizzle-orm";
import type { Database } from "@/lib/db";
import * as s from "@/lib/db/schema";
import { withDatabaseTransaction } from "@/lib/db/transaction";
import { bangkokDateKey, bangkokDateStartUtc, todayBangkok } from "@/lib/room-capacity/dates";
import { trustedLineChatUrlFromEvidence } from "./data";
import { digest } from "./normalization";
import { assignmentComplete, familyComplete, processingDate, sessionOverlapsLeave } from "./work-model";
import { eligibleLeaveAdmins, hydrateAssignments, recordSystemEvent, serializeClass, setWorkState } from "./work-data";
import type { ClassWork, CompletionEvidence, CoverageRevision, WorkStudent } from "./work-types";

type Source = { request: typeof s.leaveRequests.$inferSelect; normalization: typeof s.leaveNormalizations.$inferSelect };
export interface MatchedClass {
  wiseSessionId: string; wiseClassId: string; teacherKey: string; teacherName: string;
  start: Date; end: Date; subject: string; title: string; status: string; students: WorkStudent[];
}

export function classRevision(item: MatchedClass): string {
  return digest({ teacherKey: item.teacherKey, start: item.start.toISOString(), end: item.end.toISOString(), subject: item.subject, title: item.title, students: item.students.map((st) => st.studentKey).sort() });
}

export function buildFamilyWork(classes: ClassWork[]) {
  const students = new Map<string, WorkStudent>();
  for (const c of classes.filter((c) => c.active)) for (const st of c.students) students.set(st.studentKey, st);
  const roots = new Map([...students.keys()].map((key) => [key, key]));
  const root = (key: string): string => { while (roots.get(key) !== key) key = roots.get(key)!; return key; };
  const relationships = new Map<string, string>();
  for (const st of students.values()) {
    const keys = [st.parentName?.trim() ? `parent:${st.parentName.trim().toLowerCase()}` : null, ...st.contacts.map((c) => `contact:${c.id}`)].filter((key): key is string => !!key);
    for (const key of keys) {
      const prior = relationships.get(key);
      if (prior) roots.set(root(st.studentKey), root(prior));
      else relationships.set(key, st.studentKey);
    }
  }
  const groups = new Map<string, WorkStudent[]>();
  for (const st of students.values()) { const key = root(st.studentKey); groups.set(key, [...(groups.get(key) ?? []), st]); }
  return [...groups.values()].map((familyStudents) => {
    familyStudents.sort((a, b) => a.studentKey.localeCompare(b.studentKey));
    const parent = familyStudents.map((st) => st.parentName?.trim()).filter(Boolean).sort()[0];
    const contact = familyStudents.flatMap((st) => st.contacts.map((c) => c.id)).sort()[0];
    const familyKey = parent ? `parent:${parent.toLowerCase()}` : contact ? `contact:${contact}` : `student:${familyStudents[0].studentKey}`;
    const keys = new Set(familyStudents.map((st) => st.studentKey));
    const coverage: CoverageRevision[] = classes.filter((c) => c.active && c.students.some((st) => keys.has(st.studentKey))).map((c) => ({
      sessionId: c.wiseSessionId,
      // A new pupil in another family does not change what THIS family was told.
      revision: digest({ start: c.startTime, end: c.endTime, subject: c.subject, title: c.title, students: c.students.filter((st) => keys.has(st.studentKey)).map((st) => st.studentKey).sort() }),
    })).sort((a, b) => a.sessionId.localeCompare(b.sessionId));
    return { familyKey, label: parent || familyStudents.map((st) => st.name).join(" & "), students: familyStudents, coverage };
  });
}

export function importedEvidence(sources: Source[], date: string, action: "parentsInformed" | "classesCancelled", now: Date, consumed: string[] = []): CompletionEvidence | null {
  for (const source of sources) {
    if (source.normalization.evidenceAppliedAt || consumed.includes(source.normalization.id)) continue;
    const proof = source.normalization.result?.completion.find((c) => c[action] && (!c.dates.length || c.dates.includes(date)));
    if (proof) return { source: "sheet", actorEmail: null, actorName: proof.actorLabel, completedAt: null, recordedAt: now.toISOString(), note: proof.evidence, normalizationId: source.normalization.id };
  }
  return null;
}

export async function loadCurrentClasses(db: Database, today: string): Promise<{ classes: MatchedClass[]; snapshotTime: string; unmatchedSessionIds: Set<string> }> {
  const [[snapshot], [credit]] = await Promise.all([
    db.select().from(s.snapshots).where(eq(s.snapshots.active, true)).limit(1),
    db.select().from(s.creditControlSnapshots).where(eq(s.creditControlSnapshots.active, true)).limit(1),
  ]);
  if (!snapshot || !credit) throw new Error("The active Wise / Credit Control snapshot is unavailable. Existing work is retained.");
  const [sessions, members, groups, identitySessions, students, links] = await Promise.all([
    db.select().from(s.creditControlSessions).where(and(eq(s.creditControlSessions.snapshotId, credit.id), gte(s.creditControlSessions.scheduledStartTime, bangkokDateStartUtc(today)))),
    db.select().from(s.tutorIdentityGroupMembers).where(eq(s.tutorIdentityGroupMembers.snapshotId, snapshot.id)),
    db.select().from(s.tutorIdentityGroups).where(eq(s.tutorIdentityGroups.snapshotId, snapshot.id)),
    db.select({ sessionId: s.futureSessionBlocks.wiseSessionId, groupId: s.futureSessionBlocks.groupId }).from(s.futureSessionBlocks).where(eq(s.futureSessionBlocks.snapshotId, snapshot.id)),
    db.select().from(s.creditControlStudents).where(eq(s.creditControlStudents.snapshotId, credit.id)),
    db.select({ studentKey: s.lineContactStudentLinks.studentKey, evidence: s.lineContactStudentLinks.evidence, contact: s.lineContacts }).from(s.lineContactStudentLinks).innerJoin(s.lineContacts, eq(s.lineContacts.id, s.lineContactStudentLinks.contactId)).where(eq(s.lineContactStudentLinks.status, "verified")),
  ]);
  const groupById = new Map(groups.map((g) => [g.id, g]));
  const byTeacherId = new Map(members.map((m) => [m.wiseTeacherId, m.groupId]));
  const byTeacherUserId = new Map(members.filter((m) => m.wiseUserId).map((m) => [m.wiseUserId!, m.groupId]));
  const sessionGroup = new Map(identitySessions.map((ss) => [ss.sessionId, ss.groupId]));
  const studentById = new Map(students.map((st) => [st.wiseStudentId, st]));
  const linksByStudent = new Map<string, typeof links>();
  for (const link of links) linksByStudent.set(link.studentKey, [...(linksByStudent.get(link.studentKey) ?? []), link]);
  const bySession = new Map<string, MatchedClass>();
  const unmatchedSessionIds = new Set<string>();
  for (const session of sessions) {
    const groupId = (session.wiseTeacherId && byTeacherId.get(session.wiseTeacherId)) || (session.wiseTeacherUserId && byTeacherUserId.get(session.wiseTeacherUserId)) || sessionGroup.get(session.wiseSessionId);
    const group = groupId ? groupById.get(groupId) : null;
    if (!group || !session.scheduledEndTime || session.scheduledEndTime <= session.scheduledStartTime) { unmatchedSessionIds.add(session.wiseSessionId); continue; }
    const st = studentById.get(session.wiseStudentId);
    const student: WorkStudent = { studentKey: session.studentKey || session.wiseStudentId, wiseStudentId: session.wiseStudentId, name: st?.studentName || session.studentName, parentName: st?.parentName?.trim() || null, contacts: (linksByStudent.get(session.studentKey) ?? []).map((link) => ({ id: link.contact.id, name: link.contact.displayName, url: trustedLineChatUrlFromEvidence(link.evidence, link.contact.lineUserId) })) };
    const item = bySession.get(session.wiseSessionId);
    if (item) {
      // Disagreement among group-class participant records cannot prove cancellation.
      if (item.start.getTime() !== session.scheduledStartTime.getTime() || item.end.getTime() !== session.scheduledEndTime.getTime() || item.teacherKey !== group.canonicalKey) { unmatchedSessionIds.add(session.wiseSessionId); continue; }
      if (item.status !== session.meetingStatus) item.status = "CONFLICTING_WISE_STATUS";
      if (!item.students.some((st) => st.studentKey === student.studentKey)) item.students.push(student);
    } else bySession.set(session.wiseSessionId, { wiseSessionId: session.wiseSessionId, wiseClassId: session.wiseClassId, teacherKey: group.canonicalKey, teacherName: group.displayName, start: session.scheduledStartTime, end: session.scheduledEndTime, subject: session.subject, title: session.title, status: session.meetingStatus, students: [student] });
  }
  return { classes: [...bySession.values()].filter((ss) => !unmatchedSessionIds.has(ss.wiseSessionId)), snapshotTime: credit.createdAt.toISOString(), unmatchedSessionIds };
}

export async function reconcileLeaveWork(db: Database, today = todayBangkok(), options: { budgetMs?: number } = {}) {
  const started = Date.now();
  const current = await loadCurrentClasses(db, today);
  const [sources, allRequests, priorAssignments, priorClasses, stateRows] = await Promise.all([
    db.select({ request: s.leaveRequests, normalization: s.leaveNormalizations }).from(s.leaveRequests).innerJoin(s.leaveNormalizations, and(eq(s.leaveRequests.id, s.leaveNormalizations.requestId), eq(s.leaveRequests.currentNormalizationKey, s.leaveNormalizations.inputKey), eq(s.leaveNormalizations.status, "ok"))),
    db.select().from(s.leaveRequests), db.select().from(s.leaveAssignments), db.select().from(s.leaveClassTasks), db.select().from(s.leaveWorkState),
  ]);
  const ready = new Map(sources.filter((s) => s.request.tutorCanonicalKey).map((s) => [s.request.id, s]));
  const pending = new Set(allRequests.filter((r) => !ready.has(r.id)).map((r) => r.id));
  const byTeacher = new Map<string, Source[]>();
  for (const source of ready.values()) {
    if (source.normalization.result?.disposition !== "active") continue;
    const key = source.request.tutorCanonicalKey!;
    byTeacher.set(key, [...(byTeacher.get(key) ?? []), source]);
  }
  const wanted = new Map<string, { item: MatchedClass; sources: Source[] }>();
  for (const item of current.classes) {
    const matching = (byTeacher.get(item.teacherKey) ?? []).filter((source) => sessionOverlapsLeave(item.start, item.end, source.normalization.result!.windows));
    if (matching.length) wanted.set(item.wiseSessionId, { item, sources: matching });
  }
  const existingSessions = new Set(current.classes.map((c) => c.wiseSessionId));
  // Keep a disappeared session and its evidence; absence is not cancellation.
  const grouped = new Map<string, Array<{ item: MatchedClass; sources: Source[] }>>();
  for (const value of wanted.values()) {
    const key = `${value.item.teacherKey}|${bangkokDateKey(value.item.start)}`;
    grouped.set(key, [...(grouped.get(key) ?? []), value]);
  }
  // Also visit old bundles to retire explicitly changed/withdrawn source windows,
  // and to mark missing sessions or unresolved source revisions visibly.
  for (const row of priorAssignments.filter((a) => a.classDate >= today)) if (!grouped.has(`${row.teacherKey}|${row.classDate}`)) grouped.set(`${row.teacherKey}|${row.classDate}`, []);
  const priorBySession = new Map(priorClasses.map((c) => [c.wiseSessionId, c]));
  const bundleHashes = new Map(stateRows.map((row) => [row.key, row.value.fingerprint]));
  let changed = 0;
  let remaining = 0;
  let visited = 0;
  for (const [key, items] of grouped) {
    if (Date.now() - started > (options.budgetMs ?? 180_000)) { remaining = grouped.size - visited; break; }
    visited++;
    const [teacherKey, classDate] = key.split("|");
    const oldAssignment = priorAssignments.find((a) => a.teacherKey === teacherKey && a.classDate === classDate);
    const fingerprint = digest({
      items: items.map(({ item, sources }) => ({ ...item, sources: sources.map((source) => [source.request.id, source.normalization.id]) })).sort((a, b) => a.wiseSessionId.localeCompare(b.wiseSessionId)),
      previous: priorClasses.filter((c) => c.assignmentId === oldAssignment?.id && !wanted.has(c.wiseSessionId)).map((c) => ({ id: c.wiseSessionId, exists: existingSessions.has(c.wiseSessionId), pending: c.sourceRequestIds.filter((id) => pending.has(id)) })),
    });
    if (bundleHashes.get(`bundle:${key}`) === fingerprint) continue;
    await withDatabaseTransaction(db, async (tx) => {
      // Same lock order as checkoffs/takeovers; the normalizer never holds this lock.
      await tx.insert(s.leaveAssignments).values({ teacherKey, teacherName: items[0]?.item.teacherName || priorAssignments.find((a) => a.teacherKey === teacherKey)?.teacherName || teacherKey, classDate, dueDate: processingDate(classDate) }).onConflictDoNothing();
      const [assignment] = await tx.select().from(s.leaveAssignments).where(and(eq(s.leaveAssignments.teacherKey, teacherKey), eq(s.leaveAssignments.classDate, classDate))).for("update");
      let modified = false;
      for (const { item, sources: matches } of items) {
        const old = priorBySession.get(item.wiseSessionId);
        // Existing owner stays with a moved class; never silently assign its replacement.
        if (old && old.assignmentId !== assignment.id && !assignment.ownerEmail) {
          const priorOwner = priorAssignments.find((a) => a.id === old.assignmentId);
          if (priorOwner?.ownerEmail) await tx.update(s.leaveAssignments).set({ ownerEmail: priorOwner.ownerEmail, ownerName: priorOwner.ownerName, assignedDate: priorOwner.assignedDate }).where(eq(s.leaveAssignments.id, assignment.id));
        }
        const revision = classRevision(item);
        const requestIds = matches.map((s) => s.request.id).sort();
        // Re-read inside the lock so a just-completed checkbox is never overwritten.
        const [task] = await tx.select().from(s.leaveClassTasks).where(eq(s.leaveClassTasks.wiseSessionId, item.wiseSessionId));
        const cancelledInWise = /^(CANCELLED|CANCELED)$/i.test(item.status);
        const now = new Date();
        let cancelled = task?.cancelled ?? null;
        if (task && task.revision !== revision) cancelled = null;
        if (cancelledInWise) cancelled = cancelled ?? { source: "wise", actorEmail: null, actorName: null, completedAt: null, recordedAt: now.toISOString(), note: "Explicit cancelled status in Wise." };
        else if (cancelled?.source === "wise") cancelled = null;
        cancelled ??= importedEvidence(matches, classDate, "classesCancelled", now, task?.importedNormalizationIds);
        const importedNormalizationIds = [...new Set([...(task?.importedNormalizationIds ?? []), ...(cancelled?.normalizationId ? [cancelled.normalizationId] : [])])];
        const values = { assignmentId: assignment.id, wiseSessionId: item.wiseSessionId, wiseClassId: item.wiseClassId, startTime: item.start, endTime: item.end, subject: item.subject, title: item.title, students: item.students.sort((a, b) => a.studentKey.localeCompare(b.studentKey)), revision, sourceRequestIds: requestIds, wiseStatus: item.status, issue: item.status === "CONFLICTING_WISE_STATUS" ? "Wise participant records disagree about this class's status." : null, active: true, cancelled, importedNormalizationIds };
        if (!task) { await tx.insert(s.leaveClassTasks).values(values); modified = true; }
        else if (digest({ ...values, startTime: item.start.toISOString(), endTime: item.end.toISOString() }) !== digest(Object.fromEntries(Object.keys(values).map((k) => [k, k === "startTime" ? task.startTime.toISOString() : k === "endTime" ? task.endTime.toISOString() : task[k as keyof typeof task]])))) {
          await tx.update(s.leaveClassTasks).set({ ...values, version: task.version + 1, lastSeenAt: now }).where(eq(s.leaveClassTasks.id, task.id));
          modified = true;
        }
      }
      const tasks = await tx.select().from(s.leaveClassTasks).where(eq(s.leaveClassTasks.assignmentId, assignment.id));
      for (const task of tasks) {
        if (wanted.has(task.wiseSessionId)) continue;
        const unresolved = task.sourceRequestIds.some((id) => pending.has(id));
        const missing = !existingSessions.has(task.wiseSessionId);
        const issue = unresolved ? "Source request changed; interpretation or teacher matching is still processing." : missing && !task.cancelled ? "Class is missing from the current snapshot. Verify in Wise; unfinished work is retained." : null;
        const active = unresolved || missing;
        if (task.issue !== issue || task.active !== active) {
          await tx.update(s.leaveClassTasks).set({ issue, active, version: task.version + 1 }).where(eq(s.leaveClassTasks.id, task.id));
          modified = true;
        }
      }
      const refreshed = await tx.select().from(s.leaveClassTasks).where(eq(s.leaveClassTasks.assignmentId, assignment.id));
      const oldFamilies = await tx.select().from(s.leaveFamilyTasks).where(eq(s.leaveFamilyTasks.assignmentId, assignment.id));
      const families = buildFamilyWork(refreshed.map(serializeClass));
      for (const family of families) {
        const old = oldFamilies.find((f) => f.familyKey === family.familyKey);
        let informed = old?.informed ?? null;
        let informedCoverage = old?.informedCoverage ?? [];
        if (!old) {
          const inherited = oldFamilies.filter((f) => familyComplete(f) && f.students.every((st) => family.students.some((next) => next.studentKey === st.studentKey)));
          const covered = inherited.flatMap((f) => f.informedCoverage);
          if (family.coverage.every((c) => covered.some((done) => done.sessionId === c.sessionId && done.revision === c.revision))) { informed = inherited[0]?.informed ?? null; informedCoverage = family.coverage; }
        }
        if (!informed) {
          // Every affected class must have explicit notification evidence.
          const proofs = family.coverage.map((c) => importedEvidence(wanted.get(c.sessionId)?.sources ?? [], classDate, "parentsInformed", new Date(), old?.importedNormalizationIds));
          if (proofs.length && proofs.every(Boolean)) { informed = proofs[0]; informedCoverage = family.coverage; }
        }
        const importedNormalizationIds = [...new Set([...(old?.importedNormalizationIds ?? []), ...(informed?.normalizationId ? [informed.normalizationId] : [])])];
        const values = { assignmentId: assignment.id, ...family, active: true, informed, informedCoverage, importedNormalizationIds };
        if (!old) { await tx.insert(s.leaveFamilyTasks).values(values); modified = true; }
        else if (digest(values) !== digest(Object.fromEntries(Object.keys(values).map((key) => [key, old[key as keyof typeof old]])))) { await tx.update(s.leaveFamilyTasks).set({ ...values, version: old.version + 1 }).where(eq(s.leaveFamilyTasks.id, old.id)); modified = true; }
      }
      for (const old of oldFamilies) if (old.active && !families.some((f) => f.familyKey === old.familyKey)) { await tx.update(s.leaveFamilyTasks).set({ active: false, version: old.version + 1 }).where(eq(s.leaveFamilyTasks.id, old.id)); modified = true; }
      const sourceRequestIds = [...new Set(refreshed.filter((c) => c.active).flatMap((c) => c.sourceRequestIds))].sort();
      const issue = refreshed.filter((c) => c.active).map((c) => c.issue).filter(Boolean).join(" ") || null;
      const [hydrated] = await hydrateAssignments(tx, [{ ...assignment, issue }]);
      const done = assignmentComplete(hydrated);
      if (modified || assignment.done !== done || assignment.issue !== issue || digest(assignment.sourceRequestIds) !== digest(sourceRequestIds)) {
        await tx.update(s.leaveAssignments).set({ sourceRequestIds, issue, done, version: assignment.version + 1, updatedAt: new Date() }).where(eq(s.leaveAssignments.id, assignment.id));
        await recordSystemEvent(tx, assignment.id, "classes_reconciled", { sourceRequestIds, classCount: refreshed.filter((c) => c.active).length, issue });
        const dirtyRequests = [...new Set([...sourceRequestIds, ...assignment.sourceRequestIds])];
        if (dirtyRequests.length) await tx.update(s.leaveRequests).set({ sheetWriteStatus: "pending", updatedAt: new Date() }).where(inArray(s.leaveRequests.id, dirtyRequests));
        changed++;
      }
      await setWorkState(tx, `bundle:${key}`, { fingerprint });
    });
  }
  // Consume source completion evidence once. Later classes must not inherit an old 'Done'.
  const appliedIds = remaining ? [] : sources.filter((source) => source.request.tutorCanonicalKey && !source.normalization.evidenceAppliedAt).map((source) => source.normalization.id);
  if (appliedIds.length) await db.update(s.leaveNormalizations).set({ evidenceAppliedAt: new Date() }).where(inArray(s.leaveNormalizations.id, appliedIds));
  await setWorkState(db, "classes", { readAt: current.snapshotTime, error: null, unmatchedSessionCount: current.unmatchedSessionIds.size, remainingBundles: remaining });
  return { changed, matchedClasses: wanted.size, remaining };
}

export async function allocateDueLeaveWork(db: Database, today = todayBangkok()) {
  const [admins, shifts, people, rosterState] = await Promise.all([
    eligibleLeaveAdmins(db), db.select().from(s.leaveRosterShifts).where(eq(s.leaveRosterShifts.date, today)), db.select().from(s.leaveRosterPeople), db.select().from(s.leaveWorkState).where(eq(s.leaveWorkState.key, "roster")),
  ]);
  const rosterRead = String(rosterState[0]?.value.readAt ?? "");
  if (rosterState[0]?.value.error || !rosterRead || todayBangkok(new Date(rosterRead)) !== today) return 0;
  const working = shifts.filter((shift) => shift.status === "working" && todayBangkok(shift.fetchedAt) === today).flatMap((shift) => {
    const person = people.find((p) => p.key === shift.personKey);
    const admin = admins.find((a) => a.email === person?.email);
    return admin ? [admin] : [];
  });
  if (!working.length) return 0;
  return withDatabaseTransaction(db, async (tx) => {
    await tx.execute(sql`select pg_advisory_xact_lock(hashtext('leave-work-allocation'))`);
    const rows = await tx.select().from(s.leaveAssignments).where(and(eq(s.leaveAssignments.done, false), sql`${s.leaveAssignments.dueDate} <= ${today}`, gte(s.leaveAssignments.classDate, today))).orderBy(s.leaveAssignments.dueDate, s.leaveAssignments.teacherKey).for("update");
    const work = await hydrateAssignments(tx, rows);
    const load = new Map(working.map((a) => [a.email, work.filter((w) => w.ownerEmail === a.email).reduce((n, w) => n + w.families.filter((f) => f.active && !familyComplete(f)).length, 0)]));
    let count = 0;
    for (const assignment of work.filter((w) => !w.ownerEmail && w.classes.some((c) => c.active))) {
      // A deliberate manual unassignment is also an ownership decision.
      if (assignment.assignedDate) continue;
      working.sort((a, b) => load.get(a.email)! - load.get(b.email)! || a.name.localeCompare(b.name));
      const owner = working[0];
      await tx.update(s.leaveAssignments).set({ ownerEmail: owner.email, ownerName: owner.name, assignedDate: today, version: assignment.version + 1 }).where(eq(s.leaveAssignments.id, assignment.id));
      await recordSystemEvent(tx, assignment.id, "allocated", { ownerEmail: owner.email, ownerName: owner.name, processingDate: today });
      load.set(owner.email, load.get(owner.email)! + Math.max(1, assignment.families.filter((f) => f.active && !familyComplete(f)).length));
      count++;
    }
    return count;
  });
}
