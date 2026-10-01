import type { DecisionView } from "@/lib/tutor-offboarding/types";
import { Panel } from "./atoms";
import { BAND_LABEL, formatDayYear } from "./format";

/** The decision log. Removal runs join it in PR 2. */
export function HistoryTable({ decisions }: { decisions: DecisionView[] }) {
  if (decisions.length === 0) return <Panel className="mt-4 px-5 py-6 text-sm text-muted-foreground">No decisions yet.</Panel>;
  return (
    <Panel className="mt-4">
      <div className="overflow-x-auto">
      <table className="w-full min-w-[640px] table-fixed text-xs">
        <thead className="border-b text-muted-foreground">
          <tr>{["Tutor", "Decision", "Score then", "By", "When", "Note"].map((heading) => <th key={heading} className="px-4 py-2 text-left font-medium">{heading}</th>)}</tr>
        </thead>
        <tbody>
          {decisions.map((decision) => (
            <tr key={decision.id} className="border-t">
              <td className="px-4 py-2 font-medium">{decision.displayName}</td>
              <td className="px-4 py-2">
                {decision.revokedAt ? `Still with us · undone ${formatDayYear(decision.revokedAt)}` : `Still with us · until ${formatDayYear(decision.snoozeUntil)}`}
              </td>
              <td className="px-4 py-2 tabular-nums">{decision.likelihoodAtDecision}% · {BAND_LABEL[decision.bandAtDecision]}</td>
              <td className="px-4 py-2 [overflow-wrap:anywhere]">{decision.decidedByEmail}</td>
              <td className="px-4 py-2">{formatDayYear(decision.decidedAt)}</td>
              <td className="px-4 py-2 text-muted-foreground [overflow-wrap:anywhere]">{decision.note ?? ""}</td>
            </tr>
          ))}
        </tbody>
      </table>
      </div>
    </Panel>
  );
}
