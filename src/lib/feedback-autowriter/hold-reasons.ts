import { dataQualityReason } from "./quality";

/**
 * Hold reasons in plain words (dashboard redesign, section 4.3). Pure: safe to import from client components.
 *
 * A class is held (`feedback_autowriter_sessions.state = 'held'`) with a reason code written by `job.ts`. The category
 * groups the codes for the trends chart; the label is the sentence the owner reads in the to-do list. A label never
 * repeats what a code carries after its name: the judge's quotes are lesson text, an error's message can hold query
 * parameters, and a provider's words are not ours.
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

/** The categories in display order. */
export const HOLD_REASON_CATEGORIES: readonly HoldReasonCategory[] = [
  "data_quality", "judge", "validation", "billing_or_form", "error", "other",
];

export const HOLD_REASON_CATEGORY_LABELS: Record<HoldReasonCategory, string> = {
  data_quality: "Data quality",
  judge: "Judge",
  validation: "Validation",
  billing_or_form: "Billing or form",
  error: "Error",
  other: "Other",
};

const NO_REASON = "No reason recorded";
const JUDGE_LABEL = "The judge found a claim the record does not support";
const REJECTED_PREFIX = "The drafts were rejected: ";
const UNUSABLE_REPLY = "a reply that could not be used";
/** Distinct problems named in a rejected draft's label; the rest are counted. */
const MAX_DRAFT_PROBLEMS = 3;

/** A pipeline hold (`pipeline.ts`): one part per writer arm and reason, "; "-joined — `sol:markdown:topics; luna:…`. */
const ARM_PREFIX = /^(?:sol|luna|glm):/u;

/** What stopped a writer's draft, by the code after the arm (`validate.ts`, and a reply that failed for its content). */
const DRAFT_PROBLEMS: ReadonlyArray<{ match: RegExp; label: string }> = [
  { match: /^output_not_json$/u, label: "a reply that is not JSON" },
  { match: /^output_schema_mismatch$/u, label: "a reply that does not fit the form" },
  { match: /^model_reports_student_not_attended$/u, label: "the writer says the student did not attend" },
  { match: /^model_reports_no_lesson$/u, label: "the writer says no lesson took place" },
  { match: /^placeholder_token:/u, label: "a name placeholder left in the text" },
  { match: /^thai_text:/u, label: "Thai text" },
  { match: /^too_long:/u, label: "a field too long for Wise" },
  { match: /^markdown:/u, label: "Markdown formatting" },
  { match: /^placeholder_text:/u, label: "a required field that is only a placeholder" },
  { match: /^policy:/u, label: "a draft that does not meet the feedback policy" },
  { match: /^field:/u, label: "a field that does not meet the feedback policy" },
  { match: /^attendance_wording:/u, label: "wording that reads as an absence or a cancelled class" },
  { match: /^ai_suspect:/u, label: "text the Class Feedback checks would flag" },
  { match: /^finish_reason_length$/u, label: "a reply that was cut off" },
  { match: /^finish_reason_content_filter$/u, label: "a reply blocked by a content filter" },
  { match: /^finish_reason_/u, label: "a reply that did not finish" },
  { match: /^empty_content$/u, label: "an empty reply" },
];

/** Every other hold reason the code writes (`job.ts`, the gates of `session.ts`, the POST prechecks of `submit.ts`). */
const HOLD_REASONS: ReadonlyArray<{
  match: RegExp;
  category: Exclude<HoldReasonCategory, "data_quality" | "judge" | "other">;
  label: string | ((match: RegExpExecArray) => string);
}> = [
  // Back on the summary after a transcript-first fallback, and the summary is mostly Thai.
  { match: /^thai_summary_no_transcript$/u, category: "validation", label: "The summary is mostly Thai and there is no transcript to write from" },

  // Billing (`billing.ts`), the most specific first.
  { match: /^billing:auto_status_missing$/u, category: "billing_or_form", label: "Wise's auto-submission has no class status" },
  { match: /^billing:auto_status_(.+)$/u, category: "billing_or_form", label: ([, status]) => `Wise recorded the class as ${status}, not as completed` },
  { match: /^billing:auto_credits_missing$/u, category: "billing_or_form", label: "Wise's auto-submission charged no credits" },
  {
    match: /^billing:auto_credits_(.+)_vs_scheduled_(.+)$/u,
    category: "billing_or_form",
    label: ([, charged, scheduled]) => `The credits Wise charged (${charged}) do not match the class length (${scheduled})`,
  },
  { match: /^billing:insufficient_student_credits$/u, category: "billing_or_form", label: "The student does not have enough credits" },
  { match: /^billing:/u, category: "billing_or_form", label: "Billing for the class in Wise is not as expected" },
  { match: /^billing_plan_not_reuse$/u, category: "billing_or_form", label: "The post would change the credits Wise already charged" },
  { match: /^billing_differs_from_current_submission$/u, category: "billing_or_form", label: "Status or credits in Wise changed before the post" },
  { match: /^credit_baseline:/u, category: "billing_or_form", label: "The student's credit entries for the class are not as expected" },

  // The feedback form (`planFeedbackForm`) and the answers already in Wise.
  { match: /^feedback_form_missing_or_disabled$/u, category: "billing_or_form", label: "The feedback form is missing or switched off" },
  { match: /^feedback_form_question_without_text$/u, category: "billing_or_form", label: "A feedback form question has no text" },
  { match: /^feedback_form_duplicate_field$/u, category: "billing_or_form", label: "Two feedback form questions map to the same field" },
  { match: /^feedback_form_/u, category: "billing_or_form", label: "The feedback form's questions could not be matched to our fields" },
  { match: /^form_lacks_field:/u, category: "billing_or_form", label: "The feedback form lacks a field the draft fills" },
  { match: /^existing_answers_not_in_form_order$/u, category: "billing_or_form", label: "The answers already in Wise do not line up with the form" },

  // The submission in Wise (the gates, and the POST's fresh read).
  { match: /^submission_ambiguous:/u, category: "billing_or_form", label: "The teacher submission in Wise is ambiguous" },
  { match: /^non_teacher_submission_with_billing$/u, category: "billing_or_form", label: "A student's submission in Wise carries billing fields" },
  { match: /^expected_.+_not_supported$/u, category: "billing_or_form", label: "The submission in Wise is not the blank auto-submission" },
  { match: /^submission_changed_to_/u, category: "billing_or_form", label: "The submission in Wise changed before the post" },
  { match: /^detail_id_mismatch$/u, category: "billing_or_form", label: "Wise returned a different class than the one asked for" },
  { match: /^teacher_missing$/u, category: "billing_or_form", label: "Wise shows no teacher for the class" },

  // Our pipeline.
  { match: /^error:/u, category: "error", label: "An unexpected error kept stopping the class" },
  { match: /^soniox_timeout$/u, category: "error", label: "Transcription timed out" },
  { match: /^soniox_job_missing$/u, category: "error", label: "The transcription job was lost" },
  { match: /^soniox_(?:create|status|error|fetch):/u, category: "error", label: "Transcription failed" },
  { match: /^transcript_pass_unavailable$/u, category: "error", label: "The transcript pass is switched off" },
  { match: /^missing_student_or_tutor$/u, category: "error", label: "The student or the tutor could not be identified" },
  { match: /^missing_summary_student_or_tutor$/u, category: "error", label: "The summary, the student or the tutor is missing" },
];

/** The problems of a pipeline hold's drafts, each named once, in the order they appear. */
function draftProblems(reason: string): string[] {
  const labels = reason.split("; ").flatMap((part) => {
    const code = part.replace(ARM_PREFIX, "");
    const known = DRAFT_PROBLEMS.find((entry) => entry.match.test(code));
    return known ? [known.label] : [];
  });
  return [...new Set(labels)];
}

/**
 * A guest who did not stand in for an absent Wise account (`session.ts` `guest_stand_in_*`): usually the student who
 * joined by Zoom link instead of their account. The label says what to check.
 */
function guestStandInLabel(code: string): string | null {
  const account = "the student's account was under the attendance minimum";
  const percent = /^guest_stand_in_(\d+)pct$/u.exec(code);
  if (percent) return `A guest attended ${percent[1]}% while ${account}: check whether the guest is the student`;
  if (code === "guest_stand_in_unknown") return `A guest joined while ${account}, but the guest's attendance is unknown`;
  if (code === "guest_stand_in_tutor_absent") return `A guest may be the student (${account}), but the tutor attended too little for a stand-in`;
  return null;
}

function describeHoldReason(reason: string | null): { category: HoldReasonCategory; label: string } {
  const code = reason?.trim() ?? "";
  if (!code) return { category: "other", label: NO_REASON };

  // D-03: exactly the holds coverage leaves out. The hand-back of a switched-off tutor is a skip, never a hold.
  const dataQuality = dataQualityReason(code);
  if (dataQuality?.coverage === "excluded_data_quality") {
    const attendance = /^attendance_(\d+)pct$/u.exec(code);
    if (attendance) return { category: "data_quality", label: `The student's attendance shows ${attendance[1]}%` };
    const guest = guestStandInLabel(code);
    return { category: "data_quality", label: guest ?? dataQuality.label };
  }

  if (ARM_PREFIX.test(code)) {
    // A draft the judge rejected decides the category, whatever stopped the other writer.
    if (code.includes(":unfaithful")) return { category: "judge", label: JUDGE_LABEL };
    const problems = draftProblems(code);
    const named = problems.slice(0, MAX_DRAFT_PROBLEMS);
    const more = problems.length - named.length;
    return {
      category: "validation",
      label: REJECTED_PREFIX + (named.length > 0 ? [...named, ...(more > 0 ? [`and ${more} more`] : [])].join("; ") : UNUSABLE_REPLY),
    };
  }

  for (const entry of HOLD_REASONS) {
    const match = entry.match.exec(code);
    if (match) return { category: entry.category, label: typeof entry.label === "string" ? entry.label : entry.label(match) };
  }
  return { category: "other", label: code };
}

/** The category of a hold reason; an unknown or missing reason is `other`. */
export function holdReasonCategory(reason: string | null): HoldReasonCategory {
  return describeHoldReason(reason).category;
}

/** A hold reason as a short plain sentence; an unknown reason is shown as it is. */
export function holdReasonLabel(reason: string | null): string {
  return describeHoldReason(reason).label;
}
