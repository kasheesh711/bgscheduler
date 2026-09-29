import type { BillingPlan, SubmissionState } from "./types";

/**
 * Wise's scheduled-duration credit rule (web app `Ens`): minutes rounded up to
 * a 15-minute block, times credits per hour. BeGifted bills 1 credit per hour.
 */
export function scheduledDurationCredits(scheduledMinutes: number, creditsPerHour = 1): number {
  return (Math.ceil(scheduledMinutes / 15) * 15 / 60) * creditsPerHour;
}

export interface PriorSubmissionEvidence {
  sessionStatus: string | null;
  creditsConsumed: number | null;
  scheduledMinutes: number;
}

export interface StudentCreditEvidence {
  available: number;
  /** True when Wise's credit history already lists this session. */
  sessionAlreadyCharged: boolean;
}

/**
 * Decide the sessionStatus/creditsConsumed to send. Fail closed: any
 * disagreement between the auto-submission, the schedule, the student's past
 * submissions or the credit balance leaves the session for the tutor.
 */
export function resolveBilling(input: {
  submission: SubmissionState;
  scheduledMinutes: number;
  priors?: readonly PriorSubmissionEvidence[];
  studentCredits?: StudentCreditEvidence | null;
}): { ok: true; plan: BillingPlan } | { ok: false; reason: string } {
  const expected = scheduledDurationCredits(input.scheduledMinutes);

  if (input.submission.kind === "auto_blank") {
    const { sessionStatus, creditsConsumed } = input.submission;
    if (sessionStatus !== "COMPLETED") return { ok: false, reason: `auto_status_${sessionStatus ?? "missing"}` };
    if (creditsConsumed === null || !(creditsConsumed > 0)) return { ok: false, reason: "auto_credits_missing" };
    if (creditsConsumed !== expected) return { ok: false, reason: `auto_credits_${creditsConsumed}_vs_scheduled_${expected}` };
    // Re-send exactly what Wise already charged; the edit must not move credits.
    return {
      ok: true,
      plan: { sessionStatus, creditsConsumed, source: "auto_blank_reuse", expectedConsumedDelta: 0 },
    };
  }

  if (input.submission.kind !== "none") return { ok: false, reason: `submission_${input.submission.kind}` };

  const priors = (input.priors ?? []).filter((prior) => prior.scheduledMinutes === input.scheduledMinutes);
  if (priors.length < 2) return { ok: false, reason: "too_few_prior_submissions" };
  if (priors.some((prior) => prior.sessionStatus !== "COMPLETED")) return { ok: false, reason: "prior_status_disagrees" };
  if (priors.some((prior) => prior.creditsConsumed !== expected)) return { ok: false, reason: "prior_credits_disagree" };
  if (!input.studentCredits) return { ok: false, reason: "student_credits_unknown" };
  if (input.studentCredits.sessionAlreadyCharged) return { ok: false, reason: "session_already_charged" };
  if (input.studentCredits.available < expected) return { ok: false, reason: "insufficient_student_credits" };
  return {
    ok: true,
    plan: { sessionStatus: "COMPLETED", creditsConsumed: expected, source: "prior_submissions", expectedConsumedDelta: expected },
  };
}
