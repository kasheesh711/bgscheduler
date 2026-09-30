/**
 * Hold reasons in plain words (dashboard redesign, section 4.3). Pure: safe to import from client components.
 *
 * A class is held (`feedback_autowriter_sessions.state = 'held'`) with a reason code written by `job.ts`. The category
 * groups the codes for the trends chart; the label is the sentence the owner reads in the to-do list.
 */

/**
 * - `data_quality`: the class's own data made a faithful write-up impossible (`DATA_QUALITY_REASONS`, D-03).
 * - `judge`: the judge found a draft unfaithful.
 * - `validation`: the validator rejected the drafts (format, language, policy), or a writer's reply was unusable.
 * - `billing_or_form`: the feedback form, the submission or billing in Wise is not as the POST needs it.
 * - `error`: our pipeline failed (an unexpected error, Soniox, the transcript pass unavailable).
 * - `other`: a reason nobody listed; its label is the raw reason.
 */
export type HoldReasonCategory = "data_quality" | "judge" | "validation" | "billing_or_form" | "error" | "other";

/** The category of a hold reason; an unknown or missing reason is `other`. */
export function holdReasonCategory(reason: string | null): HoldReasonCategory {
  void reason;
  throw new Error("not implemented");
}

/** A hold reason as a short plain sentence; an unknown reason is shown as it is. */
export function holdReasonLabel(reason: string | null): string {
  void reason;
  throw new Error("not implemented");
}
