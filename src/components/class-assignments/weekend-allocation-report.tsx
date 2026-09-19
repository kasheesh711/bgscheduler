import { formatBangkokShortDateTime } from "@/lib/bangkok-time";
import type { WeekendReport } from "@/lib/classrooms/weekend-readiness";
import { OverflowPlanSection } from "./overflow-plan";

export function WeekendAllocationReport({ report }: { report: WeekendReport }) {
  if (report.version !== 2) return null;
  const labels = { saved: "Allocation saved", reused: "Saved allocation recovered on retry", not_requested: "Fresh preview",
    failed: "Allocation failed", blocked: "Allocation withheld" };
  return <div className="space-y-3" aria-label="Weekend allocation report">
    <p className="text-xs text-muted-foreground">Wednesday saves the weekend allocations. Daily publishing remains separate; student switches need agreement and fresh Wise confirmation.</p>
    {report.days.map(day => <details key={day.date} className="min-w-0 rounded-lg border p-3">
      <summary className="cursor-pointer text-sm font-semibold">
        {day.date} · {labels[day.allocation ?? "not_requested"]}
        {day.allocation !== "failed" && day.allocation !== "blocked" && !day.allocationError && <span className="mt-1 block text-xs font-normal text-muted-foreground">
          {day.liveSessions} classes · {day.noRoomCount} without rooms · {day.overflowPlan?.proposedSwitches ?? 0} proposed student switches
        </span>}
      </summary>
      <div className="mt-3 min-w-0 space-y-3">
        {day.allocationError && <p className="break-words text-sm text-amber-800 dark:text-amber-300">{day.allocationError}</p>}
        {day.runId && <p className="break-all text-xs text-muted-foreground">Allocation run: {day.runId}</p>}
        {day.allocationCreatedAt && <p className="text-xs text-muted-foreground">Saved {formatBangkokShortDateTime(day.allocationCreatedAt)} Bangkok.</p>}
        {day.sourceCheckedAt && <p className="text-xs text-muted-foreground">Wise checked {formatBangkokShortDateTime(day.sourceCheckedAt)} Bangkok.</p>}
        {day.publication && <p className="text-sm">Wise publication: {day.publication.verified} confirmed by live read-back, {day.publication.pending} pending, {day.publication.failed} failed.</p>}
        {day.overflowPlan ? <OverflowPlanSection plan={day.overflowPlan} headingId={`weekend-overflow-${day.date}`} />
          : day.allocation !== "blocked" && day.allocation !== "failed" && !day.allocationError && <p className="text-sm">No additional student switches suggested.</p>}
      </div>
    </details>)}
  </div>;
}
