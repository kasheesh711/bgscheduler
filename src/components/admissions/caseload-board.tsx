"use client";

// ----------------------------------------------------------------------------
// Admissions caseload — kanban board view (design §5.1). One column per case
// status in canonical lifecycle order; cards show student + cohort, the
// committed college when set, the live checklist-progress bar (CM-24), the
// next deadline relative to today's Bangkok date (overdue in --conflict red,
// CM-101/102), and days-since-touch. Grouping is a pure exported helper for
// unit tests; progress/deadline formatting is shared with the table view.
// ----------------------------------------------------------------------------

import { useMemo } from "react";
import Link from "next/link";
import { GraduationCap } from "lucide-react";
import { cn } from "@/lib/utils";
import { Badge } from "@/components/ui/badge";
import { todayBangkok } from "@/lib/room-capacity/dates";
import type { AdmissionsCaseStatus, AdmissionsCaseSummary } from "@/lib/admissions/types";
import {
  CASE_STATUS_BADGE_CLASSES,
  CASE_STATUS_LABELS,
  CASE_STATUS_ORDER,
} from "./case-status";
import {
  CaseloadProgress,
  formatDaysSinceTouch,
  formatNextDeadline,
} from "./caseload-table";

/**
 * Buckets caseload rows by status (pure). Every status key is always present
 * — empty statuses map to empty arrays — and input order is preserved within
 * each bucket.
 */
export function groupCaseloadByStatus(
  rows: AdmissionsCaseSummary[],
): Record<AdmissionsCaseStatus, AdmissionsCaseSummary[]> {
  const groups: Record<AdmissionsCaseStatus, AdmissionsCaseSummary[]> = {
    active: [],
    committed: [],
    completed: [],
    withdrawn: [],
    archived: [],
  };
  for (const row of rows) groups[row.status].push(row);
  return groups;
}

function BoardCard({ row, todayIso }: { row: AdmissionsCaseSummary; todayIso: string }) {
  const deadline = formatNextDeadline(row.nextDeadline, todayIso);
  return (
    <Link
      href={`/admissions/${row.caseId}`}
      aria-label={`Open ${row.studentName}'s admissions case`}
      className="flex flex-col gap-1.5 rounded-lg bg-card p-3 text-sm ring-1 ring-foreground/10 outline-none transition-colors hover:bg-accent/40 focus-visible:ring-2 focus-visible:ring-ring"
    >
      <div>
        <span className="font-medium">{row.studentName}</span>
        {row.preferredName ? (
          <span className="ml-1.5 text-muted-foreground">({row.preferredName})</span>
        ) : null}
      </div>
      <div className="text-xs text-muted-foreground">
        {row.cohortName} · Class of {row.graduationYear}
      </div>
      {row.committedCollegeName ? (
        <div className="flex items-center gap-1.5 text-xs text-primary">
          <GraduationCap aria-hidden className="size-3.5" />
          {row.committedCollegeName}
        </div>
      ) : null}
      <CaseloadProgress percent={row.progressPercent} studentName={row.studentName} />
      <div className="flex items-center justify-between text-xs">
        <span
          className={cn(
            "tabular-nums",
            deadline.overdue ? "font-medium text-conflict" : "text-muted-foreground",
          )}
        >
          {deadline.label}
        </span>
        <span className="tabular-nums text-muted-foreground">
          {formatDaysSinceTouch(row.daysSinceLastTouch)}
        </span>
      </div>
    </Link>
  );
}

export interface CaseloadBoardProps {
  rows: AdmissionsCaseSummary[];
}

/** Kanban board of cases, one column per lifecycle status. */
export function CaseloadBoard({ rows }: CaseloadBoardProps) {
  const groups = groupCaseloadByStatus(rows);
  const todayIso = useMemo(() => todayBangkok(), []);
  return (
    <div className="grid grid-cols-1 gap-3 sm:grid-cols-2 lg:grid-cols-5">
      {CASE_STATUS_ORDER.map((status) => {
        const cases = groups[status];
        return (
          <section
            key={status}
            aria-label={`${CASE_STATUS_LABELS[status]} cases`}
            className="flex flex-col gap-2 rounded-xl bg-muted/50 p-2"
          >
            <header className="flex items-center justify-between px-1 pt-1">
              <Badge className={CASE_STATUS_BADGE_CLASSES[status]}>
                {CASE_STATUS_LABELS[status]}
              </Badge>
              <span className="text-xs tabular-nums text-muted-foreground">{cases.length}</span>
            </header>
            {cases.length === 0 ? (
              <p className="px-1 pb-2 text-xs text-muted-foreground">No cases</p>
            ) : (
              cases.map((row) => (
                <BoardCard key={row.caseId} row={row} todayIso={todayIso} />
              ))
            )}
          </section>
        );
      })}
    </div>
  );
}
