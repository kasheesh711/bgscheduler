import { NextRequest, NextResponse } from "next/server";
import { and, desc, eq, sql } from "drizzle-orm";
import { z } from "zod";
import { auth } from "@/lib/auth";
import { getDb } from "@/lib/db";
import * as s from "@/lib/db/schema";
import { requireClassroomOperationsOwner } from "@/lib/classrooms/operations-access";
import { AutowriterReviewError, feedbackAutowriterErrorResponse } from "@/lib/feedback-autowriter/api";
import { approveAtomLink } from "@/lib/feedback-autowriter/atom/data";
import { isebMonitoringProgress } from "@/lib/feedback-autowriter/iseb-review";
import { evidenceHash } from "@/lib/feedback-autowriter/atom/evidence";
import { JudgeOutputSchema } from "@/lib/feedback-autowriter/judge";
import { hasAtomProof, hasIsebApproval, readIsebRollout } from "@/lib/feedback-autowriter/iseb-rollout";

export async function GET(request: NextRequest) {
  try {
    const session = await auth();
    if (!session?.user?.email) throw new AutowriterReviewError("Unauthorized", 401);
    if (session.user.role !== "admin") throw new AutowriterReviewError("Forbidden", 403);
    const db = getDb();
    const sessionId = request.nextUrl.searchParams.get("sessionId");
    if (sessionId) {
      if (!/^[0-9a-f]{24}$/iu.test(sessionId)) throw new AutowriterReviewError("Invalid class id.", 400);
      const [row] = await db.select().from(s.feedbackAutowriterSessions).where(eq(s.feedbackAutowriterSessions.wiseSessionId, sessionId)).limit(1);
      if (!row) throw new AutowriterReviewError("Class not found.", 404);
      const [post] = await db.select().from(s.feedbackAutowriterPosts).where(and(
        eq(s.feedbackAutowriterPosts.wiseSessionId, sessionId), eq(s.feedbackAutowriterPosts.kind, "first_shot"),
      )).limit(1);
      const pipeline = post?.pipeline ?? row.metadata.pipeline as Record<string, unknown> | undefined;
      const hash = pipeline?.lessonEvidenceHash ?? row.metadata.isebEvidenceHash;
      const [evidence] = hash ? await db.select().from(s.feedbackIsebEvidence).where(and(
        eq(s.feedbackIsebEvidence.wiseSessionId, sessionId), eq(s.feedbackIsebEvidence.evidenceHash, String(hash)),
      )).limit(1) : [];
      const reviews = post ? await db.select().from(s.feedbackIsebStyleReviews).where(eq(s.feedbackIsebStyleReviews.postId, post.id))
        .orderBy(desc(s.feedbackIsebStyleReviews.createdAt)).limit(10) : [];
      const calls = evidence ? await db.select().from(s.feedbackAutowriterCalls).where(and(
        eq(s.feedbackAutowriterCalls.wiseSessionId, sessionId), eq(s.feedbackAutowriterCalls.role, "judge"),
        sql`${s.feedbackAutowriterCalls.result}->>'lessonRecordHash' = ${evidenceHash(evidence.lessonRecord)}`,
      )).orderBy(desc(s.feedbackAutowriterCalls.createdAt)).limit(12) : [];
      const generation = calls[0]?.result?.judgedGeneration;
      const levels: Record<string, unknown> = {};
      for (const call of calls.filter(call => call.result?.judgedGeneration === generation)) {
        const result = call.result ?? {};
        const parsed = JudgeOutputSchema.safeParse({ faithful: result.faithful, unsupported: result.unsupported,
          misattributed: result.misattributed, homeworkNotSet: result.homeworkNotSet });
        if (parsed.success && (result.effort === "medium" || result.effort === "high") && !levels[result.effort]) levels[result.effort] = parsed.data;
      }
      return NextResponse.json({ pipeline: pipeline ?? null, evidence: evidence ?? null, reviews,
        factualVerdicts: pipeline?.factualVerdicts ?? (Object.keys(levels).length ? { levels } : row.metadata.judge ?? null),
        unavailableReason: evidence ? null : "No retained lesson evidence for this version." });
    }
    const [latest] = await db.select().from(s.feedbackAtomSyncRuns).orderBy(desc(s.feedbackAtomSyncRuns.startedAt)).limit(1);
    const [lastCatalog] = await db.select().from(s.feedbackAtomSyncRuns)
      .where(sql`jsonb_array_length(coalesce(${s.feedbackAtomSyncRuns.counts}->'catalog','[]'::jsonb)) > 0`)
      .orderBy(desc(s.feedbackAtomSyncRuns.startedAt)).limit(1);
    const links = await db.selectDistinctOn([s.feedbackAtomLinks.wiseStudentId]).from(s.feedbackAtomLinks)
      .orderBy(s.feedbackAtomLinks.wiseStudentId, desc(s.feedbackAtomLinks.revision));
    const q = request.nextUrl.searchParams.get("q")?.trim().slice(0, 80);
    const candidates = q && q.length >= 2 ? await db.selectDistinct({
      id: s.creditControlStudents.wiseStudentId, name: s.creditControlStudents.studentName,
    }).from(s.creditControlStudents).innerJoin(s.creditControlSnapshots, eq(s.creditControlStudents.snapshotId, s.creditControlSnapshots.id))
      .where(and(eq(s.creditControlSnapshots.active, true),
        sql`position(lower(${q}) in lower(${s.creditControlStudents.studentName})) > 0`)).limit(50) : [];
    const rollout = await readIsebRollout(db);
    return NextResponse.json({ links, catalog: lastCatalog?.counts.catalog ?? [], candidates, rollout,
      sync: latest ? { id: latest.id, status: latest.status, startedAt: latest.startedAt, finishedAt: latest.finishedAt,
        errorCode: latest.errorCode, snapshots: latest.counts.snapshots, activities: latest.counts.activities } : null,
      monitoring: await isebMonitoringProgress(db),
      enabled: { collection: process.env.FEEDBACK_ATOM_COLLECTOR_ENABLED === "true",
        format: process.env.FEEDBACK_AUTOWRITER_ISEB_FORMAT_ENABLED === "true" && hasIsebApproval(rollout), enrichment: process.env.FEEDBACK_ATOM_ENRICHMENT_ENABLED === "true" && hasAtomProof(rollout) },
    });
  } catch (error) {
    return feedbackAutowriterErrorResponse("[feedback-autowriter] Atom view failed", error, "Atom evidence could not load.");
  }
}

const LinkBody = z.object({
  wiseStudentId: z.string().regex(/^[0-9a-f]{24}$/iu), atomStudentId: z.string().regex(/^_[0-9]+$/u),
  expectedRevision: z.number().int().nonnegative(), active: z.boolean(),
  note: z.string().trim().min(1).max(1000),
}).strict();

export async function POST(request: NextRequest) {
  try {
    const actor = await requireClassroomOperationsOwner();
    const input = LinkBody.parse(await request.json());
    const db = getDb();
    if (!input.active) {
      const [prior] = await db.select().from(s.feedbackAtomLinks).where(eq(s.feedbackAtomLinks.wiseStudentId, input.wiseStudentId))
        .orderBy(desc(s.feedbackAtomLinks.revision)).limit(1);
      if (!prior || prior.atomStudentId !== input.atomStudentId) throw new AutowriterReviewError("Reload this student's current link before revoking it.", 409);
      const link = await approveAtomLink(db, { ...input, actor: actor.email, wiseName: prior.wiseName, atomName: prior.atomName });
      return NextResponse.json({ ok: true, link });
    }
    const [catalog] = await db.select().from(s.feedbackAtomSyncRuns)
      .where(sql`jsonb_array_length(coalesce(${s.feedbackAtomSyncRuns.counts}->'catalog','[]'::jsonb)) > 0`)
      .orderBy(desc(s.feedbackAtomSyncRuns.startedAt)).limit(1);
    const entries = z.array(z.object({ id: z.string(), name: z.string() })).parse(catalog?.counts.catalog ?? []);
    const atom = entries.find(entry => entry.id === input.atomStudentId);
    const [wise] = await db.select({ name: s.creditControlStudents.studentName }).from(s.creditControlStudents)
      .innerJoin(s.creditControlSnapshots, eq(s.creditControlStudents.snapshotId, s.creditControlSnapshots.id))
      .where(and(eq(s.creditControlSnapshots.active, true), eq(s.creditControlStudents.wiseStudentId, input.wiseStudentId))).limit(1);
    if (!atom || !wise) throw new AutowriterReviewError("Choose a student identity present in both source lists.", 400);
    if (!catalog || Date.now() - catalog.startedAt.getTime() > 24 * 60 * 60 * 1000) throw new AutowriterReviewError("Refresh the Atom catalog before approving this link.", 409);
    const link = await approveAtomLink(db, { ...input, actor: actor.email, wiseName: wise.name, atomName: atom.name });
    return NextResponse.json({ ok: true, link });
  } catch (error) {
    return feedbackAutowriterErrorResponse("[feedback-autowriter] Atom link failed", error, "The student link could not be saved.");
  }
}
