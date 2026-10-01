"use client";
import { useState } from "react";
import type {
  WorkforceDrilldown,
  WorkforceUtilizationMetrics,
} from "@/lib/tutor-offboarding/workforce/types";
import {
  Dialog,
  DialogContent,
  DialogTitle,
  DialogDescription,
} from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { LinesChart, INK } from "./charts";
import { SharedPoolDiagram, GroupCreditDiagram } from "./overview";
import { Panel, Tag } from "../atoms";
import {
  formatMetric,
  metricReason,
  monthLabel,
  bangkokTime,
  RATE_LABELS,
  rateFormula,
} from "./presentation";
export function DetailMetrics({ row }: { row: WorkforceUtilizationMetrics }) {
  return (
    <div className="space-y-3">
      <div className="grid grid-cols-3 gap-2">
        {(
          [
            ["Gross offered", row.offeredHours],
            ["Approved leave", row.leaveHours],
            ["Usable", row.usableHours],
          ] as const
        ).map(([label, metric]) => (
          <Panel className="p-3" key={label}>
            <p className="text-xs text-muted-foreground">{label}</p>
            <p
              className="mt-1 text-lg font-semibold"
              title={metricReason(metric)}
            >
              {formatMetric(metric, "h")}
            </p>
          </Panel>
        ))}
      </div>
      {Object.entries(RATE_LABELS).map(([key, label]) => (
        <div key={key} className="rounded-md border p-3">
          <p className="font-medium">
            {label}: {formatMetric(row[key as keyof typeof RATE_LABELS], "%")}
          </p>
          <p className="mt-1 text-xs text-muted-foreground">
            {rateFormula(row, key as keyof typeof RATE_LABELS)}
          </p>
        </div>
      ))}
      <p className="text-xs text-muted-foreground">
        Full-range totals: {formatMetric(row.bookedHours, "h")} booked ·{" "}
        {formatMetric(row.creditConsumedHours, "h")} credit-consumed ·{" "}
        {formatMetric(row.recordedTeachingHours, "h")} recorded teaching. Totals
        may include dates without capacity history; they are not substituted
        into the rate formulas.
      </p>
    </div>
  );
}
export function DetailContent({
  detail,
  onLoadMore,
  busy = false,
}: {
  detail: WorkforceDrilldown;
  onLoadMore?: () => void;
  busy?: boolean;
}) {
  const person =
    detail.kind === "person"
      ? detail.people.find((p) => p.canonicalKey === detail.key)
      : undefined;
  const [week, setWeek] = useState(`${detail.query.viewMonth}-01`);
  const start = new Date(`${week}T00:00:00+07:00`).getTime();
  const end = start + 7 * 86400000;
  const sessions = detail.sessions.filter(
    (session) =>
      new Date(session.startAt).getTime() >= start &&
      new Date(session.startAt).getTime() < end,
  );
  return (
    <div className="space-y-5">
      {person ? (
        <>
          <div className="flex flex-wrap items-center gap-2">
            <Tag>
              {person.role === "teaching_admin" ? "Teaching admin" : "Tutor"}
            </Tag>
            {person.pendingDeparture ? (
              <Tag tone="amber">
                Pending departure · classes remain or completion unverified
              </Tag>
            ) : null}
          </div>
          <p className="text-xs text-muted-foreground">
            Wise join:{" "}
            {person.joinedAt ? bangkokTime(person.joinedAt) : "Unavailable"} ·
            Departure:{" "}
            {person.departedAt
              ? bangkokTime(person.departedAt)
              : person.pendingDeparture
                ? "Pending"
                : "No completed sheet-marked departure"}
          </p>
          <DetailMetrics row={person} />
          <h4 className="font-semibold">Monthly utilization</h4>
          <LinesChart
            label="Monthly reserved, credit-consumed and recorded teaching utilization percentages"
            unit="%"
            rows={person.months.map((m) => ({
              month: m.month,
              reserved: m.reservedUtilizationPercent,
              credit: m.consumedUtilizationPercent,
              actual: m.recordedTeachingUtilizationPercent,
            }))}
            series={[
              { key: "reserved", label: "Reserved", color: INK.supply },
              { key: "credit", label: "Credit-consumed", color: INK.credit },
              { key: "actual", label: "Recorded teaching", color: INK.actual },
            ]}
          />
          <div className="overflow-x-auto">
            <table className="w-full text-left text-xs">
              <thead>
                <tr>
                  <th className="p-2">Month</th>
                  {Object.values(RATE_LABELS).map((label) => (
                    <th className="min-w-28 p-2" key={label}>
                      {label}
                    </th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {person.months.map((month) => (
                  <tr className="border-t" key={month.month}>
                    <th className="p-2">{monthLabel(month.month)}</th>
                    {Object.keys(RATE_LABELS).map((key) => (
                      <td
                        className="p-2"
                        title={rateFormula(
                          month,
                          key as keyof typeof RATE_LABELS,
                        )}
                        key={key}
                      >
                        {formatMetric(
                          month[key as keyof typeof RATE_LABELS],
                          "%",
                        )}
                      </td>
                    ))}
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </>
      ) : (
        <div className="space-y-2">
          <h4 className="font-semibold">
            People contributing to this selection
          </h4>
          {detail.people.map((person) => (
            <p key={person.canonicalKey}>
              {person.displayName} ·{" "}
              {person.role === "teaching_admin" ? "Teaching admin" : "Tutor"}
              {person.pendingDeparture ? " · Pending departure" : ""}
            </p>
          ))}
          {detail.people.length === 0 ? (
            <p className="text-muted-foreground">
              No contributor names were returned.
            </p>
          ) : null}
        </div>
      )}
      <GroupCreditDiagram />
      <SharedPoolDiagram />
      <div className="flex flex-wrap items-center justify-between gap-3">
        <h4 className="font-semibold">Selected-week schedule</h4>
        <label className="text-xs">
          Week starting
          <input
            aria-label="Detail week starting"
            type="date"
            value={week}
            onChange={(e) => setWeek(e.target.value)}
            className="ml-2 rounded border bg-background p-2"
          />
        </label>
      </div>
      <p className="text-xs text-muted-foreground">
        Read-only class evidence · Bangkok time · Current page{" "}
        {detail.sessions.length} classes. Load more for further evidence.
      </p>
      <div className="space-y-2">
        {sessions.map((session) => (
          <Panel className="p-3" key={session.wiseSessionId}>
            <h5 className="font-medium [overflow-wrap:anywhere]">
              {session.classTitle ?? "Class label unavailable"}
            </h5>
            <p className="mt-1 text-xs text-muted-foreground">
              {bangkokTime(session.startAt)} ·{" "}
              {session.scheduledMinutes === null
                ? "Duration unavailable"
                : `${session.scheduledMinutes} minutes`}{" "}
              · {session.subject ?? "Academic subject not reviewed"} ·{" "}
              {session.modality ?? "Mode unavailable"}
            </p>
            <p className="mt-1 text-xs">
              {session.historicalBookedStudentIds?.length ?? "Unknown"} student
              bookings · {session.meetingStatus ?? "Meeting status unavailable"}{" "}
              · {session.attendanceStatus ?? "Attendance unavailable"}
            </p>
            {session.reasonCodes.length ? (
              <p className="mt-1 text-xs text-amber-700 dark:text-amber-300">
                {session.reasonCodes.join(" · ")}
              </p>
            ) : null}
          </Panel>
        ))}
        {sessions.length === 0 ? (
          <p className="text-sm text-muted-foreground">
            No returned class evidence falls in this week. This does not
            establish available hours.
          </p>
        ) : null}
      </div>
      {detail.nextCursor ? (
        <Button variant="outline" onClick={onLoadMore} disabled={busy}>
          {busy ? "Loading…" : "Load more evidence"}
        </Button>
      ) : null}
      <details className="rounded border p-3">
        <summary className="cursor-pointer font-medium focus-visible:outline-2">
          Retained availability evidence ({detail.observations.length})
        </summary>
        <div className="mt-3 space-y-3">
          {detail.observations.map((observation) => (
            <div key={observation.id} className="border-t pt-2 text-xs">
              <p>
                Observed {bangkokTime(observation.observedAt)} ·{" "}
                {observation.source}
              </p>
              <p>
                {observation.offeredWindows.length} recurring windows ·{" "}
                {
                  observation.leaves.filter(
                    (leave) => leave.status === "approved",
                  ).length
                }{" "}
                approved leave periods · {observation.availabilityCompleteness}{" "}
                support
              </p>
            </div>
          ))}
          {detail.observations.length === 0 ? (
            <p className="text-xs text-muted-foreground">
              No availability observations were returned.
            </p>
          ) : null}
        </div>
      </details>
      {detail.exceptions.length ? (
        <div
          role="status"
          className="space-y-2 rounded border border-amber-200 p-3 text-xs"
        >
          {detail.exceptions.map((exception, i) => (
            <p key={i}>{exception.message}</p>
          ))}
        </div>
      ) : null}
    </div>
  );
}
export function WorkforceDetailDrawer({
  open,
  title,
  detail,
  error,
  busy,
  onClose,
  onLoadMore,
}: {
  open: boolean;
  title: string;
  detail: WorkforceDrilldown | null;
  error: string | null;
  busy: boolean;
  onClose: () => void;
  onLoadMore?: () => void;
}) {
  return (
    <Dialog
      open={open}
      onOpenChange={(value) => {
        if (!value) onClose();
      }}
    >
      <DialogContent className="top-0 right-0 left-auto flex h-dvh w-full max-w-none translate-x-0 translate-y-0 flex-col gap-0 rounded-none border-l p-0 data-open:zoom-in-100 data-closed:zoom-out-100 sm:max-w-[620px]">
        <div className="border-b p-5 pr-12">
          <DialogTitle>{title}</DialogTitle>
          <DialogDescription className="mt-2">
            People, class evidence and supported capacity for the current
            filtered report.
          </DialogDescription>
        </div>
        <div className="min-h-0 flex-1 space-y-4 overflow-y-auto p-5">
          {error ? (
            <p role="alert" className="text-sm text-conflict">
              {error}
            </p>
          ) : null}
          {busy && !detail ? (
            <p role="status">Loading contributor evidence…</p>
          ) : null}
          {detail ? (
            <DetailContent
              detail={detail}
              busy={busy}
              onLoadMore={onLoadMore}
            />
          ) : null}
        </div>
      </DialogContent>
    </Dialog>
  );
}
