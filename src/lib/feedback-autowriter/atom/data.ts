import { and, desc, eq, sql } from "drizzle-orm";
import { z } from "zod";
import type { Database } from "@/lib/db";
import * as s from "@/lib/db/schema";
import { withDatabaseTransaction } from "@/lib/db/transaction";
import { AutowriterReviewError } from "../api";
import { isIsebClass } from "../format";
import { describeClass, type EvidenceKind } from "../prompt";
import { detailTeacherId, type AutowriterSessionDetail } from "../session";
import { rosterTutor } from "../roster";
import { hasAtomProof, hasIsebApproval, readIsebRollout } from "../iseb-rollout";
import { atomSubject, bangkokDate, buildAtomLessonEvidence, evidenceHash } from "./evidence";
import { ATOM_MAX_AGE_MS, AtomActivitySchema, type AtomLessonEvidence, type AtomStudentLink } from "./types";

const L = s.feedbackAtomLinks;
const S = s.feedbackAtomSnapshots;
const E = s.feedbackIsebEvidence;

export function eligibleForIseb(detail: AutowriterSessionDetail): boolean {
  return detail.type?.toUpperCase() !== "OFFLINE" && isIsebClass(
    rosterTutor(detailTeacherId(detail))?.canonicalKey,
    describeClass({ programme: detail.classSubject, title: detail.title }),
  );
}

/** Approval is an explicit ID-to-ID operation. Duplicate names never enter this function's decision. */
export async function approveAtomLink(db: Database, input: {
  wiseStudentId: string; atomStudentId: string; wiseName: string; atomName: string;
  expectedRevision: number; actor: string; note: string; active: boolean;
}) {
  return withDatabaseTransaction(db, async tx => {
    // Serialise all edits to the same Wise identity, including its first link.
    await tx.execute(sql`select pg_advisory_xact_lock(hashtext(${"atom-link:" + input.wiseStudentId}))`);
    await tx.execute(sql`select pg_advisory_xact_lock(hashtext(${"atom-target:" + input.atomStudentId}))`);
    const [prior] = await tx.select().from(L).where(eq(L.wiseStudentId, input.wiseStudentId)).orderBy(desc(L.revision)).limit(1);
    if ((prior?.revision ?? 0) !== input.expectedRevision) throw new AutowriterReviewError("The student link changed. Reload before saving.", 409);
    await tx.update(L).set({ active: false }).where(and(eq(L.wiseStudentId, input.wiseStudentId), eq(L.active, true)));
    if (input.active) {
      const [occupied] = await tx.select({ id: L.id }).from(L).where(and(eq(L.atomStudentId, input.atomStudentId), eq(L.active, true))).limit(1);
      if (occupied) throw new AutowriterReviewError("This Atom student is already linked to another Wise student.", 409);
    }
    const [created] = await tx.insert(L).values({
      wiseStudentId: input.wiseStudentId, atomStudentId: input.atomStudentId, wiseName: input.wiseName,
      atomName: input.atomName, revision: input.expectedRevision + 1, active: input.active,
      approvedBy: input.actor, note: input.note,
    }).returning();
    return created;
  });
}

const SkippedRecords = z.array(z.object({ id: z.string(), startedAt: z.string(), completedAt: z.string() }).passthrough());

/** `counts.skipped[atomStudentId]` of a collector run; anything unreadable counts as none. */
export function skippedRecordsOf(counts: unknown, atomStudentId: string): { id: string; startedAt: string; completedAt: string }[] {
  const all = counts && typeof counts === "object" ? (counts as { skipped?: unknown }).skipped : undefined;
  const mine = all && typeof all === "object" ? (all as Record<string, unknown>)[atomStudentId] : undefined;
  const parsed = SkippedRecords.safeParse(mine ?? []);
  return parsed.success ? parsed.data.map(({ id, startedAt, completedAt }) => ({ id, startedAt, completedAt })) : [];
}

export async function loadAtomLessonEvidence(db: Database, input: {
  detail: AutowriterSessionDetail; studentId: string | null; lessonRecord: string; now?: Date;
  /** Read-only comparison generation can request evidence before activation. */
  preview?: boolean;
}): Promise<AtomLessonEvidence | null> {
  const { detail } = input;
  if (!eligibleForIseb(detail)) return null;
  if (!input.preview && process.env.FEEDBACK_ATOM_ENRICHMENT_ENABLED !== "true" &&
    process.env.FEEDBACK_AUTOWRITER_ISEB_FORMAT_ENABLED !== "true") return null;
  const lesson = { sessionId: detail._id, studentId: input.studentId ?? "", teacherId: detailTeacherId(detail) ?? "",
    subject: atomSubject(detail.title ?? ""), start: detail.scheduledStartTime, end: detail.scheduledEndTime };
  const base = { lesson, now: input.now ?? new Date(), lessonRecord: input.lessonRecord };
  const omitted = (reason: "disabled" | "rollout_not_approved" | "student_unmapped" | "collection_failed" | "authentication_failed" | "response_changed") =>
    buildAtomLessonEvidence({ ...base, link: null, snapshot: null, otherLessons: null, unavailableReason: reason });
  try {
    if (!input.preview) {
      const rollout = await readIsebRollout(db);
      if (!hasIsebApproval(rollout)) return null;
      if (process.env.FEEDBACK_ATOM_ENRICHMENT_ENABLED !== "true") return omitted("disabled");
      if (!hasAtomProof(rollout)) return process.env.FEEDBACK_AUTOWRITER_ISEB_FORMAT_ENABLED === "true" ? omitted("rollout_not_approved") : null;
    }
    if (!input.studentId) return omitted("student_unmapped");
    const [link] = await db.select().from(L).where(and(eq(L.wiseStudentId, input.studentId), eq(L.active, true))).limit(1);
    if (!link) return omitted("student_unmapped");
    const R = s.feedbackAtomSyncRuns;
    const [latestRun] = await db.select().from(R).where(sql`${R.status} <> 'running'`)
      .orderBy(desc(s.feedbackAtomSyncRuns.startedAt)).limit(1);
    const [snapshot] = await db.select().from(S).where(eq(S.atomStudentId, link.atomStudentId)).orderBy(desc(S.collectedAt)).limit(1);
    const [studentRun] = await db.select().from(R).where(sql`${R.status} <> 'running' and ${R.counts}->'studentResults' ? ${link.atomStudentId}`)
      .orderBy(desc(R.startedAt)).limit(1);
    const studentCode = (studentRun?.counts.studentResults as Record<string, string> | undefined)?.[link.atomStudentId];
    // Owner decision (7 Oct): a student whose Atom data contradicts itself is written lesson-only, like any other
    // collection failure below — the writer gets no Atom data, the class is not held, and the collector's critical
    // incident still asks for the Atom data to be fixed. (One student's every class was held from 5 Oct.)
    if (studentCode && studentCode !== "succeeded" && (!snapshot || studentRun!.finishedAt! >= snapshot.collectedAt)) {
      return omitted(studentCode === "authentication_failed" || studentCode === "response_changed" ? studentCode : "collection_failed");
    }
    // A run which failed before visiting this student invalidates an earlier snapshot too.
    if (latestRun?.status === "failed" && (!snapshot || latestRun.startedAt >= snapshot.collectedAt) &&
      !(latestRun.counts.studentResults as Record<string, string> | undefined)?.[link.atomStudentId]) {
      return omitted(latestRun.errorCode === "authentication_failed" || latestRun.errorCode === "response_changed" ? latestRun.errorCode : "collection_failed");
    }
    const [timetable] = await db.select().from(s.feedbackAtomTimetables)
      .where(eq(s.feedbackAtomTimetables.bangkokDate, bangkokDate(lesson.start)))
      .orderBy(desc(s.feedbackAtomTimetables.observedAt)).limit(1);
    const parsed = snapshot ? AtomActivitySchema.array().safeParse(snapshot.activities) : null;
    if (parsed && !parsed.success) return omitted("response_changed");
    if (snapshot && evidenceHash(snapshot.activities) !== snapshot.sourceHash) {
      const broken = buildAtomLessonEvidence({ ...base, link: null, snapshot: null, otherLessons: null, unavailableReason: "response_changed" });
      const { hash: _hash, ...body } = broken; void _hash;
      return { ...body, status: "contradiction", contradictions: ["snapshot_hash_conflict"],
        hash: evidenceHash({ ...body, status: "contradiction", contradictions: ["snapshot_hash_conflict"] }) };
    }
    // The run that produced this snapshot lists the records it skipped for the student (their counts disagree).
    const skipped = snapshot && studentRun && studentCode === "succeeded" && studentRun.id === snapshot.runId
      ? skippedRecordsOf(studentRun.counts, link.atomStudentId) : [];
    return buildAtomLessonEvidence({
      ...base,
      skipped,
      link: { ...link, approvedAt: link.approvedAt.toISOString() } satisfies AtomStudentLink,
      snapshot: snapshot && parsed?.success ? { id: snapshot.id, studentId: snapshot.atomStudentId,
        sourceHash: snapshot.sourceHash, collectedAt: snapshot.collectedAt.toISOString(), activities: parsed.data } : null,
      otherLessons: timetable && base.now.getTime() - timetable.observedAt.getTime() <= ATOM_MAX_AGE_MS ? timetable.lessons : null,
    });
  } catch {
    // Atom failure cannot block a sound lesson-only draft. Do not log the query, credentials or student record.
    return omitted("collection_failed");
  }
}

export async function retainIsebEvidence(db: Database, input: {
  wiseSessionId: string; atom: AtomLessonEvidence | null; lessonRecord: string; evidenceKind: EvidenceKind;
}): Promise<string> {
  const hash = evidenceHash(input);
  await db.insert(E).values({ ...input, evidenceHash: hash }).onConflictDoNothing();
  return hash;
}

/** Recompute against today's mapping and snapshot before reusing or posting an enriched draft. */
export async function storedIsebEvidenceMatches(db: Database, detail: AutowriterSessionDetail, studentId: string | null,
  pipeline: Record<string, unknown>): Promise<boolean> {
  if (!pipeline.lessonEvidenceHash) return !pipeline.atomEvidenceHash;
  const [retained] = await db.select().from(E).where(and(eq(E.wiseSessionId, detail._id), eq(E.evidenceHash, String(pipeline.lessonEvidenceHash)))).limit(1);
  if (!retained) return false;
  if (evidenceHash({ wiseSessionId: retained.wiseSessionId, atom: retained.atom,
    lessonRecord: retained.lessonRecord, evidenceKind: retained.evidenceKind }) !== retained.evidenceHash) return false;
  const current = await loadAtomLessonEvidence(db, { detail, studentId, lessonRecord: retained.lessonRecord });
  return (current?.hash ?? null) === (pipeline.atomEvidenceHash ?? null) &&
    current?.status !== "contradiction";
}
