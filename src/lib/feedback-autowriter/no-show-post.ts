import { eq } from "drizzle-orm";
import type { Database } from "@/lib/db";
import * as schema from "@/lib/db/schema";
import type { FeedbackFieldMapping } from "@/lib/post-class-feedback/types";
import { resolveBilling } from "./billing";
import { detectNoShow, readNoShow } from "./no-show";
import { AUTOWRITER_TEACHER_ALLOWLIST } from "./roster";
import { classifyTeacherSubmission, parseAutowriterSessionDetail, scheduledWindow, studentParticipants } from "./session";
import { heldNoShowSubmitStore } from "./store";
import { fieldsHash, submitFeedbackGuarded, type SubmitOutcome, type WiseFeedbackOps } from "./submit";

const S = schema.feedbackAutowriterSessions;
const ATTENDANCE_GATE = /^attendance_\d+pct$/u;

export type NoShowPostResult =
  | { ok: true; outcome: "verified" | "awaiting_event" }
  | { ok: false; status: 404 | 409 | 502; reason: string };

/**
 * The owner's one click on a held no-show class: post the standard note (`metadata.noShow`) through the autowriter's
 * own guarded POST (`submitFeedbackGuarded`), so every rule of an autowriter post holds:
 * - credit baseline, fresh read, every gate before attendance (allowlist, scheduled one-to-one, ended, deadline
 *   margin, no person's submission, one Wise student), Wise's blank auto-submission still there, billing re-sent
 *   unchanged;
 * - the note recomputed from the fresh read must be the one the owner saw (else `no_longer_a_no_show`);
 * - the claim is atomic (`held → posting`: live, not halted, tutor on, no other POST unsettled);
 * - a save by anyone else in the POST window, an unclear outcome or a failed read-back halts the autowriter before the
 *   lock opens; a row left `posting`/`awaiting_event` is reconciled by the sweep.
 * A verified note is an autowriter post like any other (first shot, review, coverage). Nothing posts without the click.
 */
export async function postNoShowNote(db: Database, input: {
  wiseSessionId: string;
  actor: string;
  apiActorId: string;
  ops: WiseFeedbackOps;
  loadMappings: (db: Database) => Promise<readonly FeedbackFieldMapping[]>;
  remainingMs: () => number;
  sleep?: (ms: number) => Promise<void>;
  eventWaitMs?: number;
}): Promise<NoShowPostResult> {
  const [row] = await db.select().from(S).where(eq(S.wiseSessionId, input.wiseSessionId)).limit(1);
  if (!row) return { ok: false, status: 404, reason: "no_such_class" };
  const shown = readNoShow(row.metadata);
  if (row.state !== "held" || !shown || !row.reason || !ATTENDANCE_GATE.test(row.reason)) {
    return { ok: false, status: 409, reason: "not_a_held_no_show" };
  }
  if (!row.wiseClassId) return { ok: false, status: 409, reason: "class_id_missing" };

  let detail;
  try {
    detail = parseAutowriterSessionDetail(await input.ops.getSessionDetail(row.wiseClassId, row.wiseSessionId));
  } catch (error) {
    return { ok: false, status: 502, reason: `detail_read_failed:${error instanceof Error ? error.name : "Error"}` };
  }
  const submission = classifyTeacherSubmission(detail);
  // Anyone's text (the tutor's, an admin's) wins: the note only ever completes Wise's blank auto-submission.
  if (submission.kind !== "auto_blank") return { ok: false, status: 409, reason: `submission_${submission.kind}` };
  const billing = resolveBilling({ submission, scheduledMinutes: scheduledWindow(detail).minutes });
  if (!billing.ok) return { ok: false, status: 409, reason: `billing:${billing.reason}` };
  const student = studentParticipants(detail).find((participant) => participant.wiseUserId)?.wiseUserId ?? null;
  const sameNote = (fresh: typeof detail) => {
    const facts = detectNoShow(fresh, row.reason);
    return !!facts && fieldsHash(facts.note) === fieldsHash(shown.note);
  };
  if (!sameNote(detail)) return { ok: false, status: 409, reason: "no_longer_a_no_show" };

  const outcome = await submitFeedbackGuarded({
    ops: input.ops,
    store: heldNoShowSubmitStore(db, row.wiseSessionId, {
      expected: submission, studentWiseUserId: student, noShowPost: { actor: input.actor, at: new Date().toISOString() },
    }, { reason: row.reason }),
    // `arm` is never stored for this claim (no model wrote the note).
    plan: { sessionId: row.wiseSessionId, classId: row.wiseClassId, arm: "sol", fields: shown.note, billing: billing.plan,
      expected: submission, mappings: await input.loadMappings(db) },
    gateInput: { now: new Date(), allowlist: AUTOWRITER_TEACHER_ALLOWLIST, requireSummary: false },
    acceptGateReason: (reason) => ATTENDANCE_GATE.test(reason),
    validateEvidence: async (fresh) => sameNote(fresh),
    evidenceChangedReason: "no_longer_a_no_show",
    apiActorId: input.apiActorId,
    remainingMs: input.remainingMs,
    sleep: input.sleep,
    eventWaitMs: input.eventWaitMs,
  });
  return noShowResult(outcome);
}

function noShowResult(outcome: SubmitOutcome): NoShowPostResult {
  switch (outcome.status) {
    case "verified":
    case "awaiting_event":
      return { ok: true, outcome: outcome.status };
    case "aborted_precheck":
      return { ok: false, status: 409, reason: outcome.reason };
    case "not_claimed":
      return { ok: false, status: 409, reason: outcome.reason === "post_in_flight" ? "post_in_flight" : "autowriter_not_live_halted_or_tutor_off" };
    case "rate_limited":
      return { ok: false, status: 502, reason: "wise_rate_limited_not_sent" };
    case "preflight_ok":
      return { ok: false, status: 409, reason: "dry_run" };
    // Sent or maybe sent: the autowriter is halted (or the sweep reconciles a read that failed).
    default:
      return { ok: false, status: 502, reason: outcome.status };
  }
}
