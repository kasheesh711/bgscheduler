"use client";

import { useEffect, useMemo, useState, type ReactNode } from "react";
import { ChevronRight, CircleAlert, CircleCheck, Clock3 } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle, DialogTrigger } from "@/components/ui/dialog";
import { formatBangkokShortDateTime } from "@/lib/bangkok-time";
import { minuteToTimeLabel } from "@/lib/room-capacity/dates";
import { SyncReviewNotice } from "./sync-review-notice";
import { getSyncReview, summarizeWeekendReadiness, summarizeWiseReadiness,
  type FindingGroup, type ReadinessSeverity, type ReadinessSummary, type WeekendView } from "./readiness-summary";
import type { AssignmentDetail } from "./types";

const severityColor: Record<ReadinessSeverity, string> = {
  danger: "text-red-700 dark:text-red-300",
  warning: "text-amber-800 dark:text-amber-300",
  neutral: "text-muted-foreground",
};

function StatusIndicator({ label, state }: { label: string; state: Pick<ReadinessSummary, "label" | "severity"> }) {
  const Icon = state.severity !== "neutral" ? CircleAlert : ["Fresh", "No issues"].includes(state.label) ? CircleCheck : Clock3;
  return <div role="status" aria-label={`${label}: ${state.label}`} aria-atomic="true"
    title={`${label}: ${state.label}`} className={`flex min-w-0 items-center gap-1.5 text-xs sm:text-sm ${severityColor[state.severity]}`}>
    <Icon aria-hidden="true" className="size-3.5 shrink-0" />
    <span className="shrink-0">{label}</span>
    <span className="truncate font-semibold">{state.label}</span>
  </div>;
}

export function ReadinessStatusBar({ day, weekend, wise, action }: {
  day: ReadinessSummary;
  weekend: ReadinessSummary;
  wise: Pick<ReadinessSummary, "label" | "severity">;
  action: ReactNode;
}) {
  const severity = [day, weekend, wise].some(state => state.severity === "danger") ? "danger"
    : [day, weekend, wise].some(state => state.severity === "warning") ? "warning" : "neutral";
  return <section aria-label="Classroom status" className={`grid shrink-0 grid-cols-2 items-center gap-x-3 gap-y-1.5 rounded-lg border px-3 py-2 sm:flex sm:gap-5 ${
    severity === "danger" ? "border-red-200 bg-red-50/40 dark:border-red-900 dark:bg-red-950/15"
      : severity === "warning" ? "border-amber-200 bg-amber-50/40 dark:border-amber-900 dark:bg-amber-950/15" : "bg-card"}`}>
    <StatusIndicator label="Day" state={day} />
    <StatusIndicator label="Weekend" state={weekend} />
    <StatusIndicator label="Wise" state={wise} />
    <div className="justify-self-end sm:ml-auto">{action}</div>
  </section>;
}

function timeLabel(start: number | undefined, end: number | undefined) {
  return start === undefined ? "" : `${minuteToTimeLabel(start)}–${minuteToTimeLabel(end ?? start)}`;
}

export function GroupedFindingList({ groups }: { groups: FindingGroup[] }) {
  return <ul className="divide-y divide-border">
    {groups.map(group => {
      const first = group.findings[0];
      const sameTime = group.findings.every(finding => finding.startMinute === first.startMinute && finding.endMinute === first.endMinute);
      return <li key={group.key} className="py-3 first:pt-0 last:pb-0">
        <div className="text-xs text-muted-foreground">{group.date}{sameTime && first.startMinute !== undefined && ` · ${timeLabel(first.startMinute, first.endMinute)}`}</div>
        <p className="mt-1 break-words text-sm font-semibold">{[group.tutor, group.className].filter(Boolean).join(" · ")
          || (group.wiseSessionId ? `Session ${group.wiseSessionId}` : "Coverage review")}</p>
        <ul className="mt-1.5 space-y-1.5 text-sm text-muted-foreground">
          {group.findings.map((finding, index) => <li key={index} className="break-words">
            {!sameTime && finding.startMinute !== undefined && <span className="font-medium">{timeLabel(finding.startMinute, finding.endMinute)} · </span>}
            {finding.message}
          </li>)}
        </ul>
        {first.requiredCapacity !== undefined && <p className="mt-2 text-xs text-muted-foreground">Needs {first.requiredCapacity} seat{first.requiredCapacity === 1 ? "" : "s"}{first.needsTv ? " and a TV" : ""}.</p>}
      </li>;
    })}
  </ul>;
}

export function SelectedDayDetails({ detail, date, summary, loading }: {
  detail: AssignmentDetail | null; date: string; summary: ReadinessSummary; loading: boolean;
}) {
  const current = Boolean(detail?.run && detail.run.assignmentDate === date);
  return <section aria-labelledby="classroom-selected-day-title" className="space-y-3">
    <div><h3 id="classroom-selected-day-title" className="font-semibold">Selected day</h3><p className="mt-1 text-xs text-muted-foreground">{date || "Choose a date"}</p></div>
    {loading ? <p className="text-sm text-muted-foreground">Loading this day’s assignments…</p> : !current ? <p className="text-sm text-muted-foreground">
      {detail && !detail.run ? "This day has not been checked. Generate assignments to review classroom coverage." : "This day’s assignments could not be loaded. Refresh to verify coverage."}
    </p> : <>
      <p className={`text-sm ${severityColor[summary.severity]}`}>{summary.affectedClasses > 0
        ? `${summary.affectedClasses} class${summary.affectedClasses === 1 ? " needs" : "es need"} attention in the saved assignments.`
        : summary.groups.length ? "Classroom coverage needs verification." : "No room issues found in the saved assignments."}</p>
      {summary.groups.length > 0 && <GroupedFindingList groups={summary.groups} />}
      {detail!.liveRoomBlocks.length > 0 && <div className="space-y-2 rounded-lg bg-muted/50 p-3">
        <h4 className="text-sm font-medium">Other live room reservations</h4>
        <p className="text-xs text-muted-foreground">{detail!.liveRoomBlocks.length} Wise booking{detail!.liveRoomBlocks.length === 1 ? " is" : "s are"} reserved during assignment. These are not automatically conflicts.</p>
        <ul className="space-y-2 text-xs text-muted-foreground">{detail!.liveRoomBlocks.map(block => <li key={block.wiseSessionId} className="break-words">
          <span className="font-medium text-foreground">{timeLabel(block.startMinute, block.endMinute)} · {block.location}</span><br />{block.className || block.wiseSessionId}
        </li>)}</ul>
      </div>}
    </>}
  </section>;
}

export function WeekendDetails({ view, summary }: { view: WeekendView; summary: ReadinessSummary }) {
  const report = view.check?.report;
  return <section aria-labelledby="classroom-weekend-title" className="space-y-3">
    <div><h3 id="classroom-weekend-title" className="font-semibold">Weekend</h3>
      <p className="mt-1 text-xs text-muted-foreground">{(report?.dates ?? view.dates).join(" / ")}</p></div>
    <p className="text-xs text-muted-foreground">Checks Wednesday, Thursday and Friday at 09:00 Bangkok.</p>
    {view.error && <p role="alert" className="text-sm text-amber-800 dark:text-amber-300">{view.error} Weekend coverage could not be verified.</p>}
    {report ? <>
      <p className={`text-sm ${severityColor[summary.severity]}`}>{report.readiness === "clear" ? "The saved check found no room blockers."
        : report.readiness === "unverified" ? "Weekend classroom coverage could not be fully verified." : "Weekend classrooms need attention."}</p>
      <p className="text-xs text-muted-foreground">Checked {formatBangkokShortDateTime(report.checkedAt)} Bangkok. This is a saved assessment; later booking changes may affect availability.</p>
      <div className="flex flex-wrap gap-3 text-sm">{report.dates.map(date => <a key={date} className="font-medium text-primary underline underline-offset-2" href={`/class-assignments?date=${date}&weekendCheck=${view.check!.id}`}>Review {date}</a>)}</div>
      {summary.groups.length > 0 && <GroupedFindingList groups={summary.groups} />}
    </> : !view.error && <p className="text-sm text-muted-foreground">{view.loading ? "Loading the saved weekend check…"
      : view.check?.status === "running" ? "Weekend verification is in progress." : "This weekend has not been verified yet."}</p>}
    {view.check?.status === "failed" && <p role="alert" className="text-sm text-amber-800 dark:text-amber-300">The check or its email delivery failed. <a className="underline" href="/data-health">Review Data Health</a>. {view.check.lastError}</p>}
    {view.check?.delivery && <p className="text-xs text-muted-foreground">Private notification: {view.check.delivery.status === "sent" ? "sent" : "awaiting delivery"}
      {view.check.delivery.sentAt && ` · ${formatBangkokShortDateTime(view.check.delivery.sentAt)} Bangkok`}.</p>}
  </section>;
}

function WiseDetails({ detail }: { detail: AssignmentDetail | null }) {
  const { snapshot } = getSyncReview(detail);
  return <section aria-labelledby="classroom-wise-title" className="space-y-3">
    <h3 id="classroom-wise-title" className="font-semibold">Wise data</h3>
    <div className="space-y-1 text-sm text-muted-foreground">
      <p>{snapshot?.snapshotId ? snapshot.fresh ? "Fresh Wise data" : "Stale Wise data — refresh before relying on current availability." : "Wise data has not been verified."}</p>
      <p>Last sync: {snapshot?.latestSyncFinishedAt ? `${formatBangkokShortDateTime(snapshot.latestSyncFinishedAt)} Bangkok` : "unknown"}</p>
      {snapshot?.snapshotId && <p className="font-mono text-xs">Snapshot {snapshot.snapshotId.slice(0, 8)}</p>}
    </div>
    <SyncReviewNotice detail={detail} />
  </section>;
}

export function ClassroomReadiness({ detail, date, day, loading }: {
  detail: AssignmentDetail | null; date: string; day: ReadinessSummary; loading: boolean;
}) {
  const [open, setOpen] = useState(false);
  const [weekend, setWeekend] = useState<WeekendView>({ check: null, dates: [], error: null, loading: true });
  useEffect(() => {
    const controller = new AbortController();
    const id = new URLSearchParams(window.location.search).get("weekendCheck");
    void fetch(`/api/class-assignments/weekend-readiness${id ? `?checkId=${encodeURIComponent(id)}` : ""}`, { signal: controller.signal })
      .then(async response => {
        const body = await response.json();
        if (!response.ok) throw new Error(body.error || "Unable to load weekend readiness.");
        if (!controller.signal.aborted) setWeekend({ ...body, error: null, loading: false });
      }).catch(cause => {
        if (!controller.signal.aborted) setWeekend(previous => ({ ...previous, loading: false,
          error: cause instanceof Error ? cause.message : "Unable to load weekend readiness." }));
      });
    return () => controller.abort();
  }, [detail]); // Every completed assignment refresh also refreshes the saved weekend check.
  const weekendSummary = useMemo(() => summarizeWeekendReadiness(weekend), [weekend]);
  const wise = useMemo(() => summarizeWiseReadiness(detail), [detail]);
  return <Dialog open={open} onOpenChange={setOpen}>
    <ReadinessStatusBar day={day} weekend={weekendSummary} wise={wise} action={
      <DialogTrigger render={<Button variant="outline" size="sm" className="h-8 gap-1.5 bg-background text-xs sm:text-sm" />}>
        Review issues <ChevronRight aria-hidden="true" className="size-3.5" />
      </DialogTrigger>
    } />
    <DialogContent className="top-0 right-0 left-auto flex h-dvh max-w-none translate-x-0 translate-y-0 flex-col gap-0 rounded-none border-l p-0 sm:max-w-[520px] data-open:zoom-in-100 data-closed:zoom-out-100">
      <DialogHeader className="shrink-0 border-b px-5 py-5 pr-12">
        <DialogTitle>Classroom issues</DialogTitle>
        <DialogDescription>Review room coverage and data quality.</DialogDescription>
      </DialogHeader>
      <div className="min-h-0 flex-1 divide-y divide-border overflow-y-auto overscroll-contain px-5 [&>section]:py-5">
        <SelectedDayDetails detail={detail} date={date} summary={day} loading={loading} />
        <WeekendDetails view={weekend} summary={weekendSummary} />
        <WiseDetails detail={detail} />
      </div>
    </DialogContent>
  </Dialog>;
}
