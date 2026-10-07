import { GATE_THRESHOLDS, addDays, floorPercent } from "./quality";
import type { AutowriterReview } from "./review-data";

/**
 * The accuracy gate as one sentence for the health rail's gate card (dashboard redesign, section 3.4). Pure and free
 * of server-only imports: safe to import from client components. The criteria that are not met are listed below the
 * sentence from `gate.reasons`; the sentence names what blocks a blocked gate, and otherwise the one criterion that
 * decides the status.
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
/** "a, b and c". */
const listed = (items: readonly string[]) => items.length > 1 ? `${items.slice(0, -1).join(", ")} and ${items.at(-1)}` : items.join("");

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
 *
 * A date is given only when critical verdicts are all that block the gate: an unresolved critical flag or an API save
 * nobody acknowledged blocks it until someone acts, whatever the date. Then the sentence leads with those and gives
 * the verdict's date after them: "Gate blocked: 1 unacknowledged API save and a critical verdict (29 Sep)."
 */
export function gateSentence(gate: AutowriterReview["gate"]): string {
  switch (gate.status) {
    case "blocked_critical": {
      const criticalOn = gate.blockedUntil ? dayMonth(addDays(gate.blockedUntil, -GATE_THRESHOLDS.windowDays)) : null;
      const dateless = [
        ...(gate.unresolvedCriticalFlags > 0 ? [`${count(gate.unresolvedCriticalFlags, "critical flag")} to be judged`] : []),
        ...(gate.unexplainedApiWrites > 0 ? [count(gate.unexplainedApiWrites, "unacknowledged API save")] : []),
      ];
      if (dateless.length === 0) {
        if (gate.blockedUntil) return `Gate blocked until ${dayMonth(gate.blockedUntil)}: critical on ${criticalOn}.`;
        if (gate.criticalVerdicts > 0) return `Gate blocked: ${count(gate.criticalVerdicts, "critical verdict")} in the window.`;
        return "Gate blocked by a critical error.";
      }
      if (gate.criticalVerdicts === 0) return `Gate blocked: ${listed(dateless)}.`;
      const verdicts = gate.criticalVerdicts === 1 ? "a critical verdict" : `${gate.criticalVerdicts} critical verdicts`;
      const date = criticalOn ? ` (${gate.criticalVerdicts === 1 ? "" : "latest "}${criticalOn})` : "";
      return `Gate blocked: ${listed([...dateless, `${verdicts}${date}`])}.`;
    }
    case "insufficient_data":
      return "Not enough reviews yet.";
    case "below_head_start":
      return `Below head start: lower bound ${measured(gate.wilsonLower)}, needs ${bar(gate.thresholds.headStartLowerBound)}.`;
    case "head_start":
      return gate.wilsonLower < gate.thresholds.passLowerBound
        ? `Head start: lower bound ${measured(gate.wilsonLower)}, needs ${bar(gate.thresholds.passLowerBound)}.`
        : `Head start: lower bound ${measured(gate.wilsonLower)}; the gate still waits for ${waitingFor(gate)}.`;
    case "pass":
      return gate.uncoveredTutors && gate.uncoveredTutors.length > 0
        ? `Gate passed; ${count(gate.uncoveredTutors.length, "online tutor")} not on the roster yet.`
        : "Gate passed.";
  }
}
