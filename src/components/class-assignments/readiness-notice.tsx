"use client";

import { useEffect, useState } from "react";
import { assignmentReadinessFindings, type WeekendFinding, type WeekendReport } from "@/lib/classrooms/weekend-readiness";
import { minuteToTimeLabel } from "@/lib/room-capacity/dates";
import type { AssignmentDetail } from "./types";

function FindingList({ findings }: { findings: WeekendFinding[] }) {
  return <ul className="mt-3 grid max-h-80 gap-3 overflow-y-auto text-sm">
    {findings.map((finding, index) => <li key={index} className="border-t border-current/15 pt-2">
      <div className="font-semibold">{finding.date}{finding.startMinute !== undefined && ` · ${minuteToTimeLabel(finding.startMinute)}–${minuteToTimeLabel(finding.endMinute ?? finding.startMinute)}`}
        {finding.tutor && ` · ${finding.tutor}`}{finding.className && ` · ${finding.className}`}</div>
      <div className="break-words">{finding.message}</div>
    </li>)}
  </ul>;
}

export function AssignmentReadinessNotice({ detail }: { detail: AssignmentDetail | null }) {
  if (!detail?.run) return null;
  const findings = assignmentReadinessFindings({ date: detail.run.assignmentDate, rows: detail.rows, rooms: detail.rooms,
    externalRoomBlocks: detail.liveRoomBlocks });
  const excluded = Number(detail.run.changeSummary?.unmanagedWiseSessionCount ?? 0);
  if (excluded > 0) findings.push({ date: detail.run.assignmentDate, kind: "unverified", message: `${excluded} live class(es) are missing from this assignment plan and require review.` });
  if (!findings.length && !detail.run.noRoomCount && !detail.run.needsReviewCount && !detail.roomConflictWarnings.length) return null;
  return <section role="alert" aria-label="Classroom readiness warning" className="rounded-xl border-2 border-red-500 bg-red-50 p-4 text-red-950 dark:bg-red-950/35 dark:text-red-100">
    <h2 className="text-lg font-bold">Action required: classroom coverage is incomplete</h2>
    <p className="mt-1 text-sm">{detail.run.assignmentDate} · {detail.run.noRoomCount} classes without rooms · {detail.run.needsReviewCount} need review.</p>
    <p className="mt-1 text-sm">The assignment run finished, but the room plan is not ready. Resolve these findings before teaching.</p>
    <FindingList findings={findings} />
  </section>;
}

export interface WeekendCheckView {
  id: string;
  checkDate: string;
  status: string;
  report: WeekendReport | null;
  lastError: string | null;
  delivery: { status: string; kind: string; sentAt: string | null } | null;
}

export function WeekendReportNotice({ check, dates, error }: { check: WeekendCheckView | null; dates: string[]; error?: string | null }) {
  const report = check?.report;
  const warning = Boolean(error || check?.status === "failed" || (report && report.readiness !== "clear"));
  return <section aria-label="Weekend classroom readiness" className={`rounded-xl border p-4 ${warning
    ? "border-red-400 bg-red-50 text-red-950 dark:bg-red-950/35 dark:text-red-100" : "border-border bg-card"}`}>
    <h2 className="font-bold">{error ? "Weekend readiness could not be loaded" : report?.readiness === "attention" ? "Weekend classrooms need attention"
      : report?.readiness === "unverified" ? "Weekend classroom coverage could not be verified"
        : report ? "Last weekend check found no room blockers" : "Weekend classroom check"}</h2>
    <p className="mt-1 text-sm">{(report?.dates ?? dates).join(" / ")} · Checks Wednesday, Thursday and Friday at 09:00 Bangkok.</p>
    {error ? <p className="mt-2 text-sm" role="alert">{error}</p> : report ? <>
      <p className="mt-1 text-xs">Checked {new Date(report.checkedAt).toLocaleString("en-GB", { timeZone: "Asia/Bangkok" })} Bangkok. This is a saved assessment; later booking changes may affect availability.</p>
      <div className="mt-3 flex flex-wrap gap-4 text-sm">{report.dates.map(date => <a key={date} className="font-semibold underline" href={`/class-assignments?date=${date}&weekendCheck=${check!.id}`}>Review {date}</a>)}</div>
      {report.findings.length > 0 && <details className="mt-3"><summary className="cursor-pointer font-medium">View {report.findings.length} findings</summary><FindingList findings={report.findings} /></details>}
    </> : <p className="mt-2 text-sm">{check?.status === "running" ? "Verification is in progress." : "This weekend has not been verified yet."}</p>}
    {check?.status === "failed" && <p role="alert" className="mt-2 text-sm">The check or its email delivery failed. Review Data Health. {check.lastError}</p>}
    {check?.delivery && <p className="mt-2 text-xs">Private notification: {check.delivery.status === "sent" ? "sent" : "awaiting delivery"}.</p>}
  </section>;
}

export function WeekendReadinessPanel({ refreshKey }: { refreshKey: string }) {
  const [data, setData] = useState<{ check: WeekendCheckView | null; dates: string[] }>({ check: null, dates: [] });
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    const controller = new AbortController();
    const id = new URLSearchParams(window.location.search).get("weekendCheck");
    void fetch(`/api/class-assignments/weekend-readiness${id ? `?checkId=${encodeURIComponent(id)}` : ""}`, { signal: controller.signal })
      .then(async response => {
        const body = await response.json();
        if (!response.ok) throw new Error(body.error || "Weekend coverage has not been verified.");
        setData(body); setError(null);
      }).catch(cause => { if (!controller.signal.aborted) setError(cause instanceof Error ? cause.message : "Unable to verify weekend readiness."); });
    return () => controller.abort();
  }, [refreshKey]);
  return <WeekendReportNotice {...data} error={error} />;
}
