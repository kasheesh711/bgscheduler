import type { Database } from "@/lib/db";
import type { FeedbackFieldAnswers, FeedbackFieldMapping } from "@/lib/post-class-feedback/types";
import { resolveBilling } from "./billing";
import { detectNoShow } from "./no-show";
import { chooseStudentDisplayName, classSubject } from "./prompt";
import { AUTOWRITER_TEACHER_ALLOWLIST } from "./roster";
import {
  classifyGateReason, classifyTeacherSubmission, parseAutowriterSessionDetail, scheduledWindow, studentParticipants,
  type AutowriterSessionDetail,
} from "./session";
import { heldFallbackSubmitStore, recordDeadlineFallback, type AutowriterSessionRow } from "./store";
import { fieldsHash, submitFeedbackGuarded, type WiseFeedbackOps } from "./submit";
import { AUTOWRITER_DEADLINE_MARGIN_MS } from "./types";

/**
 * Owner rule (25 Oct 2026): feedback is published within 48 h of the class; a hold may not wait for ever. Once the
 * fallback window of a `held` class opens (`listFallbackRows`), the sweep posts one of two notes through the guarded
 * POST of the owner's no-show note (`no-show-post.ts`), so every rule of an autowriter post holds — Wise's blank
 * auto-submission must still be there (anyone's text wins), billing is re-sent unchanged, one POST at a time, live and
 * not halted, tutor on, read back and verified:
 * - the standard no-show note, when the fresh read still shows a no-show (`detectNoShow`);
 * - otherwise the fact-only note (`factOnlyNote`): no AI text the checks did not pass (owner decision, 25 Oct).
 * A class the POST can never be made for (billing, the form, no Wise student) stays held with one `fallback_failed`
 * alert. A class still not posted in its last hour of tries raises the same alert and keeps being tried. Money-path
 * holds never post.
 */

const ATTENDANCE_GATE = /^attendance_\d+pct$/u;
/**
 * Aborts that may clear by the next sweep: a failed read, the function's time, the note changing between reads, a
 * person saving between reads (the next try tells written from blank).
 */
const RETRY_ABORT = /^(?:detail_read_failed:|credits_read_failed:|function_budget_too_small_for_post$|fallback_note_changed$|submission_changed_to_human$)/u;
/** A class still failing this close to its deadline raises `fallback_failed`, so a person still has time to write it. */
const LAST_TRIES_MS = 60 * 60 * 1000;

const CLASS_DATE = new Intl.DateTimeFormat("en-GB", { timeZone: "Asia/Bangkok", weekday: "long", day: "numeric", month: "long" });

/**
 * What Wise records about the class — subject, length, date — and nothing about the lesson, its attendance or its
 * homework. Long enough for the content policy (`assessFeedbackContent`) and the Class Feedback AI-suspect check.
 */
export function factOnlyNote(detail: AutowriterSessionDetail): FeedbackFieldAnswers {
  const window = scheduledWindow(detail);
  const subject = classSubject(detail.title);
  const studentName = studentParticipants(detail)[0]?.name;
  const name = studentName ? chooseStudentDisplayName(studentName) : "the student";
  const scheduled = `${window.minutes}-minute online class scheduled for ${CLASS_DATE.format(window.start)}`;
  return {
    topics: `1. ${subject ? `${subject}: the ${scheduled}` : `The ${scheduled}`}`,
    performance: `This is a short record of ${name}'s class. The detailed write-up for this class could not be completed within 48 hours, so this note keeps the class record complete. Please contact BeGifted if you would like more detail about this lesson.`,
    improvement: `1. We will agree the next steps with ${name} at the start of the next lesson.`,
    homework: "",
  };
}

export interface DeadlineFallbackOutcome {
  /** `posted`: verified or awaiting its event; `unsettled`: sent or maybe sent, the session store settled it. */
  result: "posted" | "retry" | "stopped" | "unsettled";
  reason: string;
}

/** Post the fallback note of one held class from `listFallbackRows`. */
export async function postDeadlineFallback(db: Database, input: {
  row: AutowriterSessionRow;
  ops: WiseFeedbackOps;
  apiActorId: string;
  mappings: readonly FeedbackFieldMapping[];
  now: Date;
  remainingMs: () => number;
  sleep?: (ms: number) => Promise<void>;
  eventWaitMs?: number;
}): Promise<DeadlineFallbackOutcome> {
  const { row } = input;
  const holdReason = row.reason ?? "";
  const stop = async (reason: string, alert = true): Promise<DeadlineFallbackOutcome> => {
    await recordDeadlineFallback(db, row.wiseSessionId, { reason, stopped: true, alert });
    return { result: "stopped", reason };
  };
  const lastTries = !row.deadlineAt ||
    row.deadlineAt.getTime() - input.now.getTime() <= AUTOWRITER_DEADLINE_MARGIN_MS + LAST_TRIES_MS;
  const retry = async (reason: string): Promise<DeadlineFallbackOutcome> => {
    await recordDeadlineFallback(db, row.wiseSessionId, { reason, stopped: false, alert: lastTries });
    return { result: "retry", reason };
  };
  if (!row.wiseClassId) return stop("class_id_missing");

  let detail: AutowriterSessionDetail;
  try {
    detail = parseAutowriterSessionDetail(await input.ops.getSessionDetail(row.wiseClassId, row.wiseSessionId));
  } catch (error) {
    return retry(`detail_read_failed:${error instanceof Error ? error.name : "Error"}`);
  }
  const submission = classifyTeacherSubmission(detail);
  // A person's text wins and needs nothing more; a blank a person saved still needs someone to write it.
  if (submission.kind === "human") return stop(submission.blank ? "human_blank_submission" : "human_submission", submission.blank);
  // Wise has not made its auto-submission yet: it may still come.
  if (submission.kind === "none") return retry("submission_none");
  if (submission.kind !== "auto_blank") return stop(`submission_${submission.kind}`);
  const billing = resolveBilling({ submission, scheduledMinutes: scheduledWindow(detail).minutes });
  if (!billing.ok) return stop(`billing:${billing.reason}`);

  const noteFor = (fresh: AutowriterSessionDetail) => detectNoShow(fresh, holdReason)?.note ?? factOnlyNote(fresh);
  const kind = detectNoShow(detail, holdReason) ? "no_show" : "fact_only";
  const note = noteFor(detail);
  const student = studentParticipants(detail).find((participant) => participant.wiseUserId)?.wiseUserId ?? null;
  const outcome = await submitFeedbackGuarded({
    ops: input.ops,
    store: heldFallbackSubmitStore(db, row.wiseSessionId, {
      expected: submission, studentWiseUserId: student, deadlineFallback: { kind, at: input.now.toISOString() },
    }, { reason: holdReason }),
    // `arm` is never stored for this claim (no model wrote the note).
    plan: { sessionId: row.wiseSessionId, classId: row.wiseClassId, arm: "sol", fields: note, billing: billing.plan,
      expected: submission, mappings: input.mappings },
    gateInput: { now: input.now, allowlist: AUTOWRITER_TEACHER_ALLOWLIST, requireSummary: false },
    // Low attendance is why most of these classes were held; the note says nothing about the lesson.
    acceptGateReason: (reason) => ATTENDANCE_GATE.test(reason),
    validateEvidence: async (fresh) => fieldsHash(noteFor(fresh)) === fieldsHash(note),
    evidenceChangedReason: "fallback_note_changed",
    apiActorId: input.apiActorId,
    remainingMs: input.remainingMs,
    sleep: input.sleep,
    eventWaitMs: input.eventWaitMs,
  });

  switch (outcome.status) {
    case "verified":
    case "awaiting_event":
      return { result: "posted", reason: kind };
    case "aborted_precheck": {
      const { reason } = outcome;
      if (outcome.gate) {
        const disposition = classifyGateReason(reason);
        if (disposition === "retry") return retry(reason);
        if (disposition === "human") return stop(reason, reason === "human_blank_submission");
        return stop(reason);
      }
      return RETRY_ABORT.test(reason) ? retry(reason) : stop(reason);
    }
    case "not_claimed":
      return retry(outcome.reason);
    case "rate_limited":
    case "preflight_ok":
      return retry(outcome.status);
    // Sent or maybe sent: the session store's `finish` and `halt` have settled the row (and alerted where needed).
    default:
      return { result: "unsettled", reason: outcome.status };
  }
}
