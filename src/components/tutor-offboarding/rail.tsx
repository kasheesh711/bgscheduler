"use client";

import { Button } from "@/components/ui/button";
import type { CalibrationCurve } from "@/lib/tutor-offboarding/calibration";
import type { FreshnessReport, OffboardingPersonRow } from "@/lib/tutor-offboarding/types";
import { CountChip, Disclosure, Panel, Upper } from "./atoms";
import { curveSentence, formatDay, formatDayYear } from "./format";
import { TerminationBadge } from "./termination-evidence";

/** OFF-07: names every stale feed. */
export function FreshnessBanner({ report }: { report: FreshnessReport }) {
  const stale = report.feeds.filter((feed) => !feed.fresh);
  return (
    <div role="status" className="mt-4 rounded-[10px] border border-amber-300 bg-amber-50 px-4 py-3 text-sm text-amber-900 dark:border-amber-900 dark:bg-amber-950 dark:text-amber-100">
      <strong className="font-semibold">Scores are provisional: some data is out of date.</strong>
      {` ${stale.map((feed) => `${feed.label} (${feed.lastSuccessAt ? `last updated ${formatDayYear(feed.lastSuccessAt)}` : "never updated"})`).join("; ")}.`}
    </div>
  );
}

export function HowScoreWorks({ curve }: { curve: CalibrationCurve }) {
  return (
    <Panel className="px-5 py-4">
      <Upper>How the score works</Upper>
      <p className="mt-2 text-[13px] font-medium">{curveSentence(curve)}</p>
      <table className="mt-3 w-full text-xs">
        <thead className="text-muted-foreground">
          <tr>
            <th className="text-left font-medium">Idle for</th>
            <th className="text-right font-medium">Came back</th>
            <th className="text-right font-medium">Still idle</th>
            <th className="text-right font-medium">Likely gone</th>
          </tr>
        </thead>
        <tbody>
          {curve.points.map((point) => (
            <tr key={point.thresholdDays} className="border-t">
              <td className="py-1">{`${point.thresholdDays}+ days`}</td>
              <td className="py-1 text-right tabular-nums">{point.returned}</td>
              <td className="py-1 text-right tabular-nums">{point.stillIdle}</td>
              <td className="py-1 text-right tabular-nums">{`${Math.round(point.goneProbability * 100)}%${point.usedDefault ? "*" : ""}`}</td>
            </tr>
          ))}
        </tbody>
      </table>
      {curve.points.some((point) => point.usedDefault) ? <p className="mt-1 text-[11px] text-muted-foreground">* Default estimate until there is enough history.</p> : null}
      <p className="mt-3 text-xs text-muted-foreground">
        Raises the score: no working hours, no Wise courses, never logged in. Lowers it: used Wise in the last 30 days, on leave. Unknown data never counts.
      </p>
    </Panel>
  );
}

/** OFF-03: Wise admin accounts, read only. */
export function StaffAccounts({ rows, onOpen }: { rows: OffboardingPersonRow[]; onOpen: (key: string) => void }) {
  return (
    <Panel className="px-5 py-4">
      <div className="flex items-center gap-2"><Upper>Staff accounts</Upper><CountChip>{rows.length}</CountChip></div>
      <p className="mt-1 text-xs text-muted-foreground">Wise admin accounts. Read only. Remove departed staff by hand in Wise.</p>
      <ul className="mt-3 space-y-2">
        {rows.map((row) => (
          <li key={row.signals.canonicalKey}>
            <button type="button" onClick={() => onOpen(row.signals.canonicalKey)}
              className="w-full rounded-md text-left text-xs outline-none hover:bg-muted/40 focus-visible:ring-2 focus-visible:ring-ring/50">
              <span className="flex flex-wrap items-center gap-2"><span className="font-medium">{row.signals.displayName}</span><TerminationBadge row={row} /></span>
              <span className="block text-muted-foreground">
                {`${row.signals.lastAdminActionAt ? `Last admin action ${formatDay(row.signals.lastAdminActionAt)}` : "No admin activity on record"}${
                  row.signals.lastTaughtAt ? ` · last class ${formatDay(row.signals.lastTaughtAt)}` : ""}`}
              </span>
            </button>
          </li>
        ))}
      </ul>
    </Panel>
  );
}

export function ExcludedList({ rows, onOpen, onUndo }: { rows: OffboardingPersonRow[]; onOpen: (key: string) => void; onUndo: (decisionId: string) => void }) {
  const confirmed = rows.filter((row) => row.termination);
  const remaining = rows.filter((row) => !row.termination);
  const teaching = remaining.filter((row) => row.score.exclusion?.code === "teaching").length;
  const others = remaining.filter((row) => row.score.exclusion?.code !== "teaching");
  return (
    <>
      {confirmed.length ? (
        <Panel className="px-5 py-4">
          <Upper>Marked departures with exclusions</Upper>
          <ul className="mt-3 space-y-3 text-xs">
            {confirmed.map((row) => (
              <li key={row.signals.canonicalKey}>
                <button type="button" onClick={() => onOpen(row.signals.canonicalKey)} className="flex flex-wrap items-center gap-2 rounded text-left outline-none focus-visible:ring-2 focus-visible:ring-ring/50">
                  <span className="font-medium">{row.signals.displayName}</span><TerminationBadge row={row} />
                </button>
                <p className="mt-1 text-muted-foreground">{row.signals.upcomingSessions > 0 ? `Pending departure: ${row.signals.upcomingSessions} upcoming classes` : row.score.exclusion?.text}</p>
                {row.openDecision ? <Button type="button" size="xs" variant="ghost" onClick={() => onUndo(row.openDecision!.id)}>Undo still with us</Button> : null}
              </li>
            ))}
          </ul>
        </Panel>
      ) : null}
    <Disclosure title="Excluded" count={remaining.length}>
      <p className="px-5 pt-3 text-xs text-muted-foreground">{`${teaching} teaching (have upcoming classes).`}</p>
      <ul className="space-y-2 px-5 py-3">
        {others.map((row) => (
          <li key={row.signals.canonicalKey} className="text-xs">
            <button type="button" onClick={() => onOpen(row.signals.canonicalKey)} className="font-medium hover:underline">{row.signals.displayName}</button>
            <span className="text-muted-foreground"> · {row.score.exclusion?.text}</span>
            {row.openDecision ? (
              <div className="mt-1 flex items-center gap-2 text-muted-foreground">
                <span>
                  by {row.openDecision.decidedByEmail}, until {formatDay(row.openDecision.snoozeUntil)}
                  {row.openDecision.note ? ` · “${row.openDecision.note}”` : ""}
                </span>
                <Button type="button" size="xs" variant="ghost" onClick={() => onUndo(row.openDecision!.id)}>Undo</Button>
              </div>
            ) : null}
          </li>
        ))}
      </ul>
    </Disclosure>
    </>
  );
}
