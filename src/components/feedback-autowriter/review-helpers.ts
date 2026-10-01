import { downgradeOf } from "@/lib/feedback-autowriter/quality";
import type { ReviewQueueItem } from "@/lib/feedback-autowriter/review-data";

/**
 * What the review of a posted class shows and sends, without any rendering: labels, the list filters, and the verdict
 * request with its downgrade rules. Pure, so every rule is unit-tested on its own.
 */

export const REVIEW_FILTERS = [
  { key: "required", label: "Needs review" },
  { key: "flagged", label: "Flagged" },
  { key: "all", label: "All" },
] as const;
export type ReviewFilter = (typeof REVIEW_FILTERS)[number]["key"];

export const REVIEW_STATUS_LABEL: Record<ReviewQueueItem["status"], string> = {
  needs_review: "Needs review",
  flagged: "Flagged",
  reviewed: "Reviewed",
  optional: "Not sampled",
};

export const REVIEW_STATUS_TONE: Record<ReviewQueueItem["status"], string> = {
  needs_review: "border-amber-300 bg-amber-50 text-amber-800 dark:bg-amber-950 dark:text-amber-200",
  flagged: "border-red-300 bg-red-50 text-red-700 dark:bg-red-950 dark:text-red-200",
  reviewed: "border-available/30 bg-available/10 text-available",
  optional: "border-muted-foreground/30 text-muted-foreground",
};

export const ACTOR_LABEL: Record<string, string> = {
  autowriter_first: "Autowriter — first post",
  autowriter_correction: "Autowriter — correction",
  autowriter_policy: "Autowriter — policy re-post (not a fix)",
  api_actor_unmatched: "Wise API user — no recorded post",
  owner_web: "Owner (Wise web)",
  tutor: "Tutor",
  other_staff: "Other staff",
  student: "Student",
  auto: "Wise auto-submission",
};

// The stored severity "factual" is the owner's "major": a real fix, not accurate.
export const SEVERITIES = [
  { value: "cosmetic", label: "Cosmetic (still accurate)" },
  { value: "factual", label: "Major (real fix)" },
  { value: "critical", label: "Critical" },
] as const;
export type Severity = (typeof SEVERITIES)[number]["value"];

export const CATEGORIES = [
  { value: "wrong_person", label: "Wrong person" },
  { value: "billing_status", label: "Billing or status error" },
  { value: "invented_content", label: "Invented content" },
  { value: "should_not_have_posted", label: "Should not have posted" },
] as const;
export type Category = (typeof CATEGORIES)[number]["value"];

const SEVERITY_SHORT: Record<Severity, string> = { cosmetic: "cosmetic", factual: "Major (real fix)", critical: "critical" };

export const OUTCOME_LABEL: Record<string, string> = {
  verify_failed: "Landed but did not verify — Wise may differ",
  unknown_outcome: "Outcome unknown — may be in Wise",
  rejected: "Refused by Wise, but the submission changed",
};

export const DOWNGRADE_LABEL = { critical: "critical", factual: "major" } as const;

/** Measured fixes per actor, e.g. "Tutor 1, Autowriter — correction 1". */
export function measuredFixesLabel(byActor: Record<string, number>): string {
  return Object.entries(byActor).filter(([, count]) => count > 0).toSorted(([a], [b]) => a.localeCompare(b))
    .map(([kind, count]) => `${ACTOR_LABEL[kind] ?? kind} ${count}`).join(", ");
}

export function matchesFilter(item: ReviewQueueItem, filter: ReviewFilter): boolean {
  if (filter === "required") return item.required && item.currentVerdict === null;
  if (filter === "flagged") return item.openFlags.length > 0;
  return true;
}

export function verdictLabel(verdict: NonNullable<ReviewQueueItem["currentVerdict"]>): string {
  const downgraded = verdict.downgradedFrom ? ` (downgraded from ${DOWNGRADE_LABEL[verdict.downgradedFrom]})` : "";
  if (verdict.verdict === "approve") return `Approved${downgraded}`;
  const category = verdict.criticalCategory ? ` · ${CATEGORIES.find((option) => option.value === verdict.criticalCategory)?.label}` : "";
  const severity = verdict.severity ? SEVERITY_SHORT[verdict.severity] : "—";
  return `Needs fix · ${severity}${category}${downgraded}`;
}

/** What a new verdict would downgrade on this class (a harsher current verdict or a critical flag), or null. */
export function downgradeFor(
  item: Pick<ReviewQueueItem, "currentVerdict" | "openFlags">,
  verdict: "approve" | "needs_fix",
  severity: Severity | null,
): "critical" | "factual" | null {
  return downgradeOf({
    current: item.currentVerdict ? { verdict: item.currentVerdict.verdict, severity: item.currentVerdict.severity } : null,
    openCriticalFlag: item.openFlags.some((flag) => flag.suggestedSeverity === "critical"),
    next: { verdict, severity: verdict === "approve" ? null : severity ?? "cosmetic" },
  });
}

/** The class carries a major or critical judgement a milder verdict would downgrade. */
export function hasHarshJudgement(item: Pick<ReviewQueueItem, "currentVerdict" | "openFlags">): boolean {
  return downgradeFor(item, "approve", null) !== null;
}

export interface VerdictFormState {
  severity: Severity | null;
  category: Category | null;
  note: string;
  downgradeConfirmed: boolean;
}

/**
 * The verdict request for the owner's choice, pinned to what the page shows (first shot, current verdict, open
 * flags), or why it cannot be sent yet. Needs fix never defaults to a severity.
 */
export function buildVerdictRequest(
  item: Pick<ReviewQueueItem, "wiseSessionId" | "firstShot" | "currentVerdict" | "openFlags">,
  verdict: "approve" | "needs_fix",
  form: VerdictFormState,
): { ok: true; body: Record<string, unknown> } | { ok: false; error: string } {
  if (verdict === "needs_fix" && form.severity === null) return { ok: false, error: "Choose a severity." };
  if (verdict === "needs_fix" && form.severity === "critical" && form.category === null) return { ok: false, error: "Choose the critical category." };
  const severity = verdict === "needs_fix" ? form.severity : null;
  const downgrade = downgradeFor(item, verdict, severity);
  if (downgrade && !form.note.trim()) return { ok: false, error: `A downgrade from ${DOWNGRADE_LABEL[downgrade]} needs a note saying why.` };
  if (downgrade && !form.downgradeConfirmed) return { ok: false, error: `Confirm the downgrade from ${DOWNGRADE_LABEL[downgrade]}.` };
  return {
    ok: true,
    body: {
      wiseSessionId: item.wiseSessionId,
      fieldsSha256: item.firstShot.fieldsSha256,
      currentVerdictId: item.currentVerdict?.id ?? null,
      seenFlagIds: item.openFlags.map((flag) => flag.id),
      verdict,
      severity,
      criticalCategory: severity === "critical" ? form.category : null,
      note: form.note.trim() || null,
      ...(downgrade ? { confirmDowngrade: true } : {}),
    },
  };
}
