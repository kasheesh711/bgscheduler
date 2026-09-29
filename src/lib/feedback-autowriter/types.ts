import type { FeedbackFieldAnswers } from "@/lib/post-class-feedback/types";

/**
 * Feedback autowriter. Drafts a tutor's post-class feedback from Wise's AI
 * meeting summary and completes Wise's own blank auto-submission through the
 * same endpoint the Wise web app uses. It lives outside post-class-feedback on
 * purpose: that subsystem is read-only toward Wise and never generates
 * feedback. Roster: `roster.ts`; models and flags: `config.ts`.
 */

/** Wise rejects feedback answers longer than this (web app constant `HV`). */
export const WISE_FEEDBACK_ANSWER_MAX_CHARACTERS = 5_000;

/** Feedback must land at least this long before the post-class deadline. */
export const AUTOWRITER_DEADLINE_MARGIN_MS = 30 * 60 * 1000;

/** Minimum share of the scheduled time the student must have been in the meeting. */
export const AUTOWRITER_MIN_ATTENDANCE_PERCENT = 50;
/**
 * A guest (no Wise account) stands in for an absent Wise account only when they
 * — and the tutor — stayed at least this share of the class (owner rule, 29 Sep:
 * a class that runs its full length with one guest was taught to the student).
 */
export const AUTOWRITER_GUEST_STUDENT_MIN_PERCENT = 80;

/**
 * Wise may still be computing participants and attendance when the meeting
 * ends (the webhook fires within seconds). Until this long after the class
 * end, "no student" or "low attendance" means "retry", not "hold".
 */
export const AUTOWRITER_ATTENDANCE_SETTLE_MINUTES = 60;

/** A summary shorter than this is not enough evidence to write from. */
export const AUTOWRITER_MIN_SUMMARY_CHARACTERS = 200;

export type ModelArm = "glm" | "luna";

export interface OpenRouterProviderPreferences {
  order?: string[];
  allow_fallbacks?: boolean;
  data_collection?: "allow" | "deny";
  require_parameters?: boolean;
  zdr?: boolean;
}

export type SubmissionState =
  | { kind: "none" }
  | {
    kind: "auto_blank";
    submissionId: string;
    sessionStatus: string | null;
    creditsConsumed: number | null;
  }
  | { kind: "human"; submissionId: string | null; blank: boolean }
  | { kind: "ambiguous"; reason: string };

export interface AutowriterStudent {
  wiseUserId: string | null;
  name: string;
  inMeetingSeconds: number | null;
  absolutePercentAttendance: number | null;
  /** Set when the student attended through a Zoom guest join under this name (see `studentParticipants`). */
  joinedAsGuest?: string | null;
}

export interface AiSummary {
  /** Overview plus labelled detail paragraphs, in Wise order. */
  text: string;
  meetingUUIDs: string[];
}

export interface GateInput {
  now: Date;
  allowlist: ReadonlySet<string>;
  /** False for the transcript second pass (it does not write from the summary). Default true. */
  requireSummary?: boolean;
}

export type GateResult = { ok: true } | { ok: false; reason: string };

export interface BillingPlan {
  sessionStatus: string;
  creditsConsumed: number;
  source: "auto_blank_reuse" | "prior_submissions";
  /** Credit balance delta expected from the POST (0 when Wise already charged). */
  expectedConsumedDelta: number;
}

export interface GeneratedFields extends FeedbackFieldAnswers {
  studentAttended: boolean;
  lessonHappened: boolean;
}

export interface WiseFeedbackPostBody {
  answers: Array<{ answer: string }>;
  sessionStatus: string;
  creditsConsumed: number;
}
