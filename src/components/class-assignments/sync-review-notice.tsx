import Link from "next/link";
import type { AssignmentDetail } from "./types";
import { getSyncReview } from "./readiness-summary";

export function SyncReviewNotice({ detail }: { detail: AssignmentDetail | null }) {
  if (!detail) return null;
  const { activeSummary, runSummary, excludedCount, needsReview } = getSyncReview(detail);
  if (!needsReview) return null;

  return (
    <div className="space-y-2 text-sm text-muted-foreground">
      <p className="font-medium text-foreground">Wise data refreshed with issues</p>
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
    </div>
  );
}
