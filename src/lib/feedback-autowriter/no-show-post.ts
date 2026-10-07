import { and, eq, sql } from "drizzle-orm";
import type { Database } from "@/lib/db";
import * as schema from "@/lib/db/schema";
import type { FeedbackFieldMapping } from "@/lib/post-class-feedback/types";
import { resolveBilling } from "./billing";
import { isUniqueViolationError } from "./db-errors";
import { detectNoShow, readNoShow } from "./no-show";
import {
  buildFeedbackPostBody, classifyTeacherSubmission, existingAnswersMatchForm, parseAutowriterSessionDetail,
  planFeedbackForm, scheduledWindow, storedTeacherFields, studentParticipants, teacherSubmissionSnapshot,
} from "./session";
import { readControl } from "./store";
import { feedbackBodyHash, fieldsHash, type WiseFeedbackOps } from "./submit";

const S = schema.feedbackAutowriterSessions;
const P = schema.feedbackAutowriterPosts;

export type NoShowPostResult =
  | { ok: true; state: "skipped_human" }
  | { ok: false; status: 404 | 409 | 502; reason: string };

/**
 * The owner's one click on a held no-show class: post the standard note (`metadata.noShow`) to Wise. Every guard is
 * re-checked on a fresh read first — the student still never joined and the tutor still waited, nobody has written
 * feedback (Wise holds only its blank auto-submission), and the billing Wise already charged is re-sent unchanged.
 * The claim takes the institution-wide POST lock (`posting`, one at a time). Afterwards the read-back must show the
 * note with the same submission, billing and credits; the row ends `skipped_human` / `no_show_note_posted`, and a
 * `policy` post row records the save so the review job does not raise it as an unexplained API write.
 */
export async function postNoShowNote(db: Database, input: {
  wiseSessionId: string;
  actor: string;
  ops: WiseFeedbackOps;
  loadMappings: (db: Database) => Promise<readonly FeedbackFieldMapping[]>;
}): Promise<NoShowPostResult> {
  const [row] = await db.select().from(S).where(eq(S.wiseSessionId, input.wiseSessionId)).limit(1);
  if (!row) return { ok: false, status: 404, reason: "no_such_class" };
  if (row.state !== "held" || !readNoShow(row.metadata)) return { ok: false, status: 409, reason: "not_a_held_no_show" };
  if (!row.wiseClassId) return { ok: false, status: 409, reason: "class_id_missing" };
  const control = await readControl(db);
  if (control.haltedAt) return { ok: false, status: 409, reason: "autowriter_halted" };

  const read = async () => parseAutowriterSessionDetail(await input.ops.getSessionDetail(row.wiseClassId!, row.wiseSessionId));
  const detail = await read();
  const facts = detectNoShow(detail, row.reason);
  if (!facts) return { ok: false, status: 409, reason: "no_longer_a_no_show" };
  const submission = classifyTeacherSubmission(detail);
  // Anyone's text (the tutor's, an admin's) wins: the note only ever completes Wise's blank auto-submission.
  if (submission.kind !== "auto_blank") return { ok: false, status: 409, reason: `submission_${submission.kind}` };
  const billing = resolveBilling({ submission, scheduledMinutes: scheduledWindow(detail).minutes });
  if (!billing.ok) return { ok: false, status: 409, reason: `billing:${billing.reason}` };
  const form = planFeedbackForm(detail, await input.loadMappings(db));
  if (!form.ok) return { ok: false, status: 409, reason: form.reason };
  if (!existingAnswersMatchForm(detail)) return { ok: false, status: 409, reason: "answers_do_not_match_form" };
  const studentId = studentParticipants(detail).find((student) => student.wiseUserId)?.wiseUserId ?? null;
  if (!studentId) return { ok: false, status: 409, reason: "student_unknown" };

  const fields = facts.note;
  const plan = { sessionStatus: billing.plan.sessionStatus, creditsConsumed: billing.plan.creditsConsumed };
  const body = buildFeedbackPostBody(form.plan, fields, plan);
  const before = teacherSubmissionSnapshot(detail);
  const creditsBefore = await input.ops.getSessionCreditEntries(row.wiseClassId, studentId, row.wiseSessionId);

  let claimed: Array<{ id: string }>;
  try {
    claimed = await db.update(S).set({
      state: "posting", postStartedAt: sql`now()`, bodyHash: feedbackBodyHash(body), fieldsSha256: fieldsHash(fields),
      fields: fields as unknown as Record<string, string>, billing: billing.plan as unknown as Record<string, unknown>,
      metadata: sql`${S.metadata} || ${JSON.stringify({ noShowPost: { actor: input.actor, claimedAt: new Date().toISOString() } })}::jsonb`,
      updatedAt: sql`now()`,
    }).where(and(eq(S.wiseSessionId, row.wiseSessionId), eq(S.state, "held"),
      sql`not exists (select 1 from feedback_autowriter_sessions p where p.state in ('posting', 'awaiting_event'))`))
      .returning({ id: S.id });
  } catch (error) {
    if (isUniqueViolationError(error)) return { ok: false, status: 409, reason: "post_in_flight" };
    throw error;
  }
  if (!claimed.length) return { ok: false, status: 409, reason: "post_in_flight_or_changed" };

  const startedAt = new Date();
  const result = await input.ops.postFeedback(row.wiseClassId, row.wiseSessionId, body);
  const finishedAt = new Date();
  let verification: Record<string, unknown> = { post: result.kind };
  let state: "skipped_human" | "held" | "unknown_outcome" | "verify_failed";
  if (result.kind === "sent") {
    const after = await read().catch(() => null);
    const snapshot = after ? teacherSubmissionSnapshot(after) : null;
    const stored = after ? storedTeacherFields(after) : null;
    const creditsAfter = await input.ops.getSessionCreditEntries(row.wiseClassId, studentId, row.wiseSessionId).catch(() => null);
    verification = {
      ...verification,
      textMatches: !!stored && fieldsHash(stored) === fieldsHash(fields),
      sameSubmission: !!snapshot && snapshot.count === 1 && snapshot.submissionId === before.submissionId,
      billingUnchanged: !!snapshot && snapshot.sessionStatus === before.sessionStatus && snapshot.creditsConsumed === before.creditsConsumed,
      creditsUnchanged: creditsAfter !== null && JSON.stringify(creditsAfter) === JSON.stringify(creditsBefore),
    };
    state = Object.values(verification).every((value) => value === true || value === "sent") ? "skipped_human" : "verify_failed";
  } else {
    // Not sent (rejected / rate limited) goes back to the hold; a request whose fate is unknown never does.
    state = result.kind === "unknown" ? "unknown_outcome" : "held";
  }
  const alertKind = state === "verify_failed" || state === "unknown_outcome" ? state : null;
  await db.update(S).set({
    state,
    reason: state === "skipped_human" ? "no_show_note_posted" : state === "held" ? row.reason : state,
    metadata: sql`${S.metadata} || ${JSON.stringify({ noShowPost: { actor: input.actor, verification, at: finishedAt.toISOString() }, ...(alertKind ? { alertKind } : {}) })}::jsonb`,
    updatedAt: sql`now()`,
  }).where(and(eq(S.wiseSessionId, row.wiseSessionId), eq(S.state, "posting")));
  if (result.kind !== "rejected" && result.kind !== "rate_limited") {
    await db.insert(P).values({
      wiseSessionId: row.wiseSessionId, wiseClassId: row.wiseClassId, wiseTeacherUserId: row.wiseTeacherUserId, kind: "policy",
      fields: fields as unknown as Record<string, string>, fieldsSha256: fieldsHash(fields), bodyHash: feedbackBodyHash(body),
      billing: billing.plan as unknown as Record<string, unknown>, actorKind: "owner", actor: input.actor,
      reason: "no-show note (owner one-click)", postStartedAt: startedAt, postFinishedAt: finishedAt,
      outcome: state === "skipped_human" ? "verified" : state === "unknown_outcome" ? "unknown_outcome" : "verify_failed",
      verification, provenance: "live", dedupeKey: `no-show:${row.wiseSessionId}`,
    }).onConflictDoNothing();
  }
  if (state === "skipped_human") return { ok: true, state };
  return { ok: false, status: 502, reason: state === "held" ? `not_sent:${result.kind}` : state };
}
