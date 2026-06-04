import type {
  CandidateSession,
  IntentType,
  ProposedWiseAction,
  Review,
  StudentLink,
  WritebackStatus,
} from "./types";

export const STATUS_LABELS: Record<WritebackStatus, string> = {
  not_applicable: "No Wise action",
  dry_run: "Dry run logged",
  manual_required: "Manual Wise action",
  ready: "Ready to confirm",
  confirmed: "Confirmed",
  failed: "Failed",
};

export const INTENT_LABELS: Record<Exclude<IntentType, "all">, string> = {
  new_request: "New",
  cancel_one_off: "Cancel",
  pause_until: "Pause",
  resume: "Resume",
  reschedule: "Reschedule",
  unclear_change: "Unclear",
};

export function asString(value: unknown): string | null {
  return typeof value === "string" && value.trim() ? value : null;
}

export function asStringArray(value: unknown): string[] {
  return Array.isArray(value) ? value.filter((item): item is string => typeof item === "string") : [];
}

function asNumber(value: unknown): number {
  return typeof value === "number" && Number.isFinite(value) ? value : 0;
}

export function issueList(review: Review | null): string[] {
  if (!review) return [];
  return asStringArray(review.intentPayload.issues);
}

export function intentLabel(intent: Exclude<IntentType, "all">): string {
  return INTENT_LABELS[intent] ?? intent;
}

export function formatPercent(value: number | null | undefined): string {
  if (value === null || value === undefined || Number.isNaN(value)) return "n/a";
  return `${Math.round(value * 100)}%`;
}

export function formatDateTime(value: string): string {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return value;
  return new Intl.DateTimeFormat("en-GB", {
    timeZone: "Asia/Bangkok",
    day: "2-digit",
    month: "short",
    hour: "2-digit",
    minute: "2-digit",
    hour12: false,
  }).format(date);
}

export async function jsonFetch<T>(input: RequestInfo | URL, init?: RequestInit): Promise<T> {
  const response = await fetch(input, init);
  const payload = await response.json().catch(() => ({}));
  if (!response.ok) {
    const message = typeof payload.error === "string" ? payload.error : "Request failed";
    throw new Error(message);
  }
  return payload as T;
}

export function toCandidate(value: Record<string, unknown>): CandidateSession {
  return {
    wiseSessionId: asString(value.wiseSessionId) ?? "",
    wiseClassId: asString(value.wiseClassId) ?? "",
    studentKey: asString(value.studentKey) ?? "",
    studentName: asString(value.studentName) ?? "",
    subject: asString(value.subject) ?? "",
    packageName: asString(value.packageName) ?? "",
    startLocalDate: asString(value.startLocalDate) ?? "",
    startLocalTime: asString(value.startLocalTime) ?? "",
    endLocalTime: asString(value.endLocalTime),
    teacherName: asString(value.teacherName),
    location: asString(value.location),
    score: asNumber(value.score),
    reasons: asStringArray(value.reasons),
  };
}

export function toAction(value: Record<string, unknown>): ProposedWiseAction {
  return {
    id: asString(value.id) ?? "",
    type: asString(value.type) ?? "unknown",
    label: asString(value.label) ?? "Wise action",
    wiseSessionIds: asStringArray(value.wiseSessionIds),
    wiseClassIds: asStringArray(value.wiseClassIds),
    endpointVerified: Boolean(value.endpointVerified),
    dryRun: Boolean(value.dryRun),
    disabledReason: asString(value.disabledReason),
    payload: value.payload && typeof value.payload === "object" && !Array.isArray(value.payload)
      ? value.payload as Record<string, unknown>
      : {},
  };
}

export function verifiedLinks(links: StudentLink[]): StudentLink[] {
  return links.filter((link) => link.status === "verified");
}

export function studentLinkVisibilityForReview({
  review,
  activeLinks,
  isSelected,
}: {
  review: Review;
  activeLinks: StudentLink[];
  isSelected: boolean;
}): { label: string; variant: "default" | "outline" | "destructive" } {
  const verifiedCount = isSelected
    ? verifiedLinks(activeLinks).length
    : Math.max(review.matchedStudentKeys.length, review.verifiedStudentKeys.length);
  const suggestedCount = isSelected
    ? activeLinks.filter((link) => link.status === "suggested").length
    : 0;

  if (verifiedCount > 1) return { label: "Multi-child verified", variant: "default" };
  if (verifiedCount === 1) return { label: "Verified student", variant: "default" };
  if (suggestedCount > 0) return { label: "Verify suggested link", variant: "outline" };
  return { label: "No verified student", variant: "destructive" };
}
