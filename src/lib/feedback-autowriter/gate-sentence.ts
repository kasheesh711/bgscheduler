import { GATE_THRESHOLDS, addDays, floorPercent } from "./quality";
import type { AutowriterReview } from "./review-data";

/**
 * The expansion gate as one sentence for the health rail's gate card (dashboard redesign, section 3.4). Pure and free
 * of server-only imports: safe to import from client components. The criteria that are not met are listed below the
 * sentence from `gate.reasons`; the sentence names only the one that decides the status.
 */

type Gate = AutowriterReview["gate"];

const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"] as const;

/** A Bangkok date key ("2026-09-29") as "29 Sep" — from the key itself, so it reads the same in every runtime. */
function dayMonth(dateKey: string): string {
  const [, month, day] = dateKey.split("-").map(Number);
  const name = MONTHS[month - 1];
  return name && day ? `${day} ${name}` : dateKey;
}

/** A measured ratio, rounded down to a whole percent: 79.99% reads "79%", never the 80% it missed. */
const measured = (value: number) => floorPercent(value, 0);
/** A threshold (round by definition). */
const bar = (value: number) => `${Math.round(value * 100)}%`;
const count = (n: number, one: string, many = `${one}s`) => `${n} ${n === 1 ? one : many}`;

/** The first criterion still unmet once the accuracy has reached the pass bar. */
function waitingFor(gate: Gate): string {
  if (gate.coverage === null) return "eligible classes";
  if (gate.coverage < gate.thresholds.minCoverage) return `coverage of ${bar(gate.thresholds.minCoverage)} (now ${measured(gate.coverage)})`;
  if (gate.pendingFlaggedReviews > 0) return `${count(gate.pendingFlaggedReviews, "flagged post")} to be reviewed`;
  if (gate.requiredPending > 0) return `${count(gate.requiredPending, "required post")} to be reviewed`;
  if (gate.unrecordedPosts > 0) return `${count(gate.unrecordedPosts, "posted class", "posted classes")} to be recorded`;
  return "its other criteria";
}

/**
 * One sentence per gate status, e.g. "Gate blocked until 13 Oct: critical on 29 Sep.", "Head start: lower bound 72%,
 * needs 80%.", "Not enough reviews yet." Dates are Bangkok dates, shown as "D Mon"; measured percentages are rounded
 * down. `gate.blockedUntil` is the latest critical class's date plus the window's 14 days.
 */
export function gateSentence(gate: Gate): string {
  switch (gate.status) {
    case "blocked_critical":
      if (gate.blockedUntil) {
        return `Gate blocked until ${dayMonth(gate.blockedUntil)}: critical on ${dayMonth(addDays(gate.blockedUntil, -GATE_THRESHOLDS.windowDays))}.`;
      }
      if (gate.criticalVerdicts > 0) return `Gate blocked: ${count(gate.criticalVerdicts, "critical verdict")} in the window.`;
      if (gate.unresolvedCriticalFlags > 0) return `Gate blocked: ${count(gate.unresolvedCriticalFlags, "critical flag")} to be judged.`;
      if (gate.unexplainedApiWrites > 0) return `Gate blocked: ${count(gate.unexplainedApiWrites, "API write")} to Wise that no post explains.`;
      return "Gate blocked by a critical error.";
    case "insufficient_data":
      return "Not enough reviews yet.";
    case "below_head_start":
      return `Below head start: lower bound ${measured(gate.wilsonLower)}, needs ${bar(gate.thresholds.headStartLowerBound)}.`;
    case "head_start":
      return gate.wilsonLower < gate.thresholds.passLowerBound
        ? `Head start: lower bound ${measured(gate.wilsonLower)}, needs ${bar(gate.thresholds.passLowerBound)}.`
        : `Head start: lower bound ${measured(gate.wilsonLower)}; the gate still waits for ${waitingFor(gate)}.`;
    case "pass":
      return `Gate passed: ready to add ${count(gate.nextExpansionSize - gate.currentTutors, "tutor")}.`;
  }
}
