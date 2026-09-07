import Link from "next/link";
import type { AssignmentDetail } from "./types";

export function SyncReviewNotice({ detail }: { detail: AssignmentDetail | null }) {
  if (!detail) return null;
  const activeSummary = detail.activeSnapshotMeta?.syncErrorSummary;
  const savedSummary = detail.run?.changeSummary?.syncErrorSummary;
  const runSummary = typeof savedSummary === "string" ? savedSummary : detail.snapshotMeta.syncErrorSummary;
  const rawCount = detail.run?.changeSummary?.unmanagedWiseSessionCount;
  const excludedCount = typeof rawCount === "number" && Number.isInteger(rawCount) && rawCount >= 0 ? rawCount : null;
  if (!activeSummary && !runSummary && !excludedCount) return null;

  return (
    <section role="status" aria-label="Wise sync review" className="space-y-2 rounded-lg border border-amber-300 bg-amber-50 px-3 py-3 text-sm text-amber-950 dark:border-amber-700 dark:bg-amber-950 dark:text-amber-100">
      <h2 className="font-semibold">Wise data refreshed with issues</h2>
      {activeSummary && <p><span className="font-medium">Latest refresh · whole upcoming schedule: </span>{activeSummary}</p>}
      {runSummary && runSummary !== activeSummary && (
        <p><span className="font-medium">Issues recorded with this day’s assignments: </span>{runSummary}</p>
      )}
      {detail.run ? (
        <p>
          <span className="font-medium">Excluded from the saved assignments for {detail.run.assignmentDate}: </span>
          {excludedCount === null ? "Count unavailable for this saved run." : `${excludedCount} session${excludedCount === 1 ? "" : "s"}.`}
          {excludedCount !== null && excludedCount > 0 && " These sessions need review and have not been assigned."}
        </p>
      ) : <p>Generate assignments to see this day’s excluded-session count.</p>}
      <p>Teacher identity and recipient checks still apply. Affected email deliveries remain blocked.</p>
      <div className="flex flex-wrap gap-x-4 gap-y-1 font-medium">
        <Link href="/data-health" className="underline underline-offset-2">Review in Data Health</Link>
        <Link href="/tutor-profiles" className="underline underline-offset-2">Review Tutor Profiles</Link>
      </div>
    </section>
  );
}
