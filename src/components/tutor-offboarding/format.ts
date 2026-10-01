import type { CalibrationCurve } from "@/lib/tutor-offboarding/calibration";
import { bangkokDayLabel } from "@/lib/tutor-offboarding/day-label";
import type { OffboardingBand, OffboardingSummary } from "@/lib/tutor-offboarding/types";

/** "3 Jun" on the Bangkok calendar (fixed month names: server and browser render the same text). */
export function formatDay(iso: string): string {
  return bangkokDayLabel(iso);
}

/** "3 Jun 2026" on the Bangkok calendar. */
export function formatDayYear(iso: string): string {
  return bangkokDayLabel(iso, true);
}

/** "12 min old", "4 h old", "3 days old". */
export function formatAge(fromIso: string, now: Date): string {
  const minutes = Math.max(0, Math.floor((now.getTime() - Date.parse(fromIso)) / 60_000));
  if (minutes < 60) return `${minutes} min old`;
  const hours = Math.floor(minutes / 60);
  if (hours < 48) return `${hours} h old`;
  return `${Math.floor(hours / 24)} days old`;
}

export const BAND_LABEL: Record<OffboardingBand, string> = {
  very_likely_gone: "Very likely gone",
  likely_gone: "Likely gone",
  unclear: "Unclear",
  active: "Active",
};

export const INBOX_BANDS: OffboardingBand[] = ["very_likely_gone", "likely_gone", "unclear"];

export function topLineSentence(summary: OffboardingSummary, confirmedToReview = 0, confirmedOnRoster = confirmedToReview): string {
  const { veryLikely, veryLikelyAccounts, likely, unclear } = summary;
  if (veryLikely + likely + unclear === 0) {
    if (confirmedToReview > 0) return `${confirmedToReview} ${confirmedToReview === 1 ? "tutor marked for termination needs" : "tutors marked for termination need"} review.`;
    if (confirmedOnRoster > 0) return `${confirmedOnRoster} ${confirmedOnRoster === 1 ? "tutor marked for termination is" : "tutors marked for termination are"} on the roster; review their exclusions or staff accounts.`;
    return "No tutors look like they have left. Nothing to review.";
  }
  const head = veryLikely > 0
    ? `${veryLikely} ${veryLikely === 1 ? "tutor" : "tutors"} (${veryLikelyAccounts} Wise ${veryLikelyAccounts === 1 ? "account" : "accounts"}) ${veryLikely === 1 ? "is" : "are"} very likely no longer with us`
    : "No tutor is very likely gone";
  const rest = [likely ? `${likely} likely` : null, unclear ? `${unclear} unclear` : null].filter(Boolean).join(", ");
  return rest ? `${head}; ${rest}.` : `${head}.`;
}

/** The calibration in one sentence, at the 60-day threshold. */
export function curveSentence(curve: CalibrationCurve): string {
  const point = curve.points.find((candidate) => candidate.thresholdDays === 60) ?? curve.points[curve.points.length - 1];
  const percent = Math.round(point.goneProbability * 100);
  const basis = point.usedDefault
    ? "default estimate until there is enough history"
    : `based on ${curve.tutorsObserved} tutors since ${formatDay(curve.historyStart)}`;
  return `Idle ${point.thresholdDays}+ days → ${percent}% never came back · ${basis}`;
}
