"use client";
import { useCallback, useEffect, useState } from "react";
import Link from "next/link";
import { ArrowLeft, CalendarDays, RefreshCw } from "lucide-react";
import { Button } from "@/components/ui/button";
import type {
  DetailData,
  SettingsData,
} from "@/lib/tutor-sit-ins/client-types";
import {
  scopeLabel,
  scopeOf,
  coverageScopes,
  REPORT_WINDOW_MS,
} from "@/lib/tutor-sit-ins/model";
import { ReportEditor } from "./report-editor";
import { CommunicationList } from "./communications";
import {
  api,
  calendarDeliveryLabel,
  control,
  Loading,
  Notice,
  panel,
  slot,
  Status,
  when,
} from "./shared";
export function SitInDetail({ id }: { id: string }) {
  const [data, setData] = useState<DetailData | null>(null),
    [error, setError] = useState(""),
    [busy, setBusy] = useState(false),
    [selectedSlot, setSelectedSlot] = useState(""),
    [reportId, setReportId] = useState("");
  const [action, setAction] = useState(""),
    [reason, setReason] = useState(""),
    [observer, setObserver] = useState(""),
    [grants, setGrants] = useState<SettingsData["grants"]>([]);
  const load = useCallback(async () => {
    try {
      setData(await api<DetailData>("/" + id));
    } catch (e) {
      setError((e as Error).message);
    }
  }, [id]);
  useEffect(() => {
    void load();
  }, [load]);
  useEffect(() => {
    if (data?.access.role === "manager")
      void api<SettingsData>("/settings?quarter=" + data.assignment.quarter)
        .then((s) => setGrants(s.grants))
        .catch(() => undefined);
  }, [data?.access.role, data?.assignment.quarter]);
  const observation = data?.observations.find((o) => o.current),
    assignment = data?.assignment;
  const report =
    data?.reports.find((r) => r.id === reportId) || data?.reports[0];
  const canSchedule =
    !!data &&
    (data.access.role === "manager" ||
      (data.access.role === "observer" &&
        assignment?.observerEmail === data.access.email));
  const isManager = data?.access.role === "manager";
  async function refresh() {
    if (!assignment) return;
    setBusy(true);
    setError("");
    try {
      await api("/refresh", { quarter: assignment.quarter });
      await load();
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  }
  async function book() {
    if (!assignment) return;
    setBusy(true);
    setError("");
    try {
      await api("/" + id + "/book", {
        sessionId: selectedSlot,
        expectedRevision: assignment.revision,
      });
      setSelectedSlot("");
      setReportId("");
      await load();
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  }
  async function command(e: React.FormEvent<HTMLFormElement>) {
    e.preventDefault();
    if (!assignment) return;
    setBusy(true);
    setError("");
    try {
      await api(
        "/" + id,
        {
          action,
          expectedRevision: assignment.revision,
          reason,
          ...(action === "reassign" ? { email: observer } : {}),
        },
        "PATCH",
      );
      setAction("");
      setReason("");
      setReportId("");
      await load();
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  }
  if (!data || !assignment)
    return (
      <div className="overflow-y-auto">
        {error ? <Notice error>{error}</Notice> : <Loading />}
      </div>
    );
  const chosen = assignment.suggestions.find(
    (s) => s.sessionId === selectedSlot,
  );
  return (
    <div className="min-h-0 flex-1 overflow-y-auto">
      <div className="mx-auto max-w-6xl space-y-5 pb-12">
        <Link
          href={"/tutor-sit-ins?quarter=" + assignment.quarter}
          className="inline-flex min-h-10 items-center gap-2 text-sm text-primary"
        >
          <ArrowLeft className="size-4" />
          All observations
        </Link>
        <header className="flex flex-wrap items-start justify-between gap-3">
          <div>
            <p className="text-xs font-semibold uppercase tracking-wider text-primary">
              {scopeLabel(assignment)} · {assignment.quarter}
            </p>
            <h1 className="mt-1 text-3xl font-semibold">
              {assignment.tutorName}
            </h1>
            <p className="mt-2 break-all text-sm text-muted-foreground">
              Observer:{" "}
              {assignment.observerEmail ||
                "Administrator to designate an alternate"}{" "}
              · Bangkok time
            </p>
          </div>
          <Status value={assignment.status} />
        </header>
        {error && <Notice error>{error}</Notice>}
        {assignment.reason && <Notice>{assignment.reason}</Notice>}
        <div className="grid items-start gap-5 lg:grid-cols-[1.3fr_1fr]">
          <section className={panel}>
            <h2 className="flex items-center gap-2 text-lg font-semibold">
              <CalendarDays className="size-5 text-primary" />
              Observation plan
            </h2>
            {observation ? (
              <div className="mt-4 space-y-3">
                <p className="text-lg font-medium">
                  {slot(observation.lesson.start, observation.lesson.end)}
                </p>
                <p className="text-sm">{observation.lesson.title}</p>
                <p className="text-sm text-muted-foreground">
                  {observation.lesson.location || observation.lesson.modality} ·{" "}
                  {observation.lesson.participants
                    .map((p) => p.studentName)
                    .join(", ")}
                </p>
                <p className="text-sm">
                  <strong>Report due:</strong>{" "}
                  {when(
                    new Date(
                      new Date(observation.endTime).getTime() +
                        REPORT_WINDOW_MS,
                    ).toISOString(),
                  )}
                </p>
                <p className="text-sm">
                  Calendar delivery:{" "}
                  <strong>
                    {calendarDeliveryLabel(observation.calendarStatus)}
                  </strong>
                </p>
                {!!assignment.readinessIssues?.length && (
                  <Notice error>
                    {assignment.readinessIssues
                      .map((i) => i.message + " " + i.action)
                      .join(" ")}
                  </Notice>
                )}
                {observation.calendarError && (
                  <Notice error>{observation.calendarError}</Notice>
                )}
                {observation.eventUrl && (
                  <a
                    href={observation.eventUrl}
                    target="_blank"
                    rel="noreferrer"
                    className="inline-block py-2 text-sm text-primary underline"
                  >
                    Open Calendar event
                  </a>
                )}
              </div>
            ) : (
              <div className="mt-4 space-y-3">
                <p className="text-sm text-muted-foreground">
                  {assignment.status === "exempt"
                    ? "This obligation has a recorded exemption."
                    : "Choose an entire lesson when the observer is free. Confirmation checks the live Wise lesson, teaching schedule, leave and other observations."}
                </p>
                {assignment.suggestionError && (
                  <Notice>
                    {assignment.suggestionError}
                    {assignment.readinessIssues?.map((i) => (
                      <p key={i.code} className="mt-1">
                        {i.action}
                      </p>
                    ))}
                  </Notice>
                )}
                {canSchedule &&
                  !["completed", "exempt", "superseded"].includes(
                    assignment.status,
                  ) && (
                    <>
                      <Button
                        variant="outline"
                        disabled={busy}
                        onClick={() => void refresh()}
                      >
                        <RefreshCw className="size-4" />
                        Refresh available lessons
                      </Button>
                      {!assignment.suggestions.length && (
                        <p className="text-sm text-muted-foreground">
                          No eligible openings yet. The background check looks
                          for new opportunities every ten minutes.
                        </p>
                      )}
                      {assignment.suggestions.map((s) => (
                        <label
                          key={s.sessionId}
                          className={
                            "flex cursor-pointer items-start gap-3 rounded-lg border p-3 " +
                            (selectedSlot === s.sessionId
                              ? "border-primary bg-primary/5"
                              : "")
                          }
                        >
                          <input
                            className="mt-1"
                            type="radio"
                            name="lesson"
                            disabled={busy}
                            checked={selectedSlot === s.sessionId}
                            onChange={() => setSelectedSlot(s.sessionId)}
                          />
                          <span className="text-sm">
                            <strong>{slot(s.start, s.end)}</strong>
                            <span className="mt-1 block text-muted-foreground">
                              {s.title} · {s.location || s.modality}
                            </span>
                            <span className="mt-1 block font-medium">
                              {s.verification === "wise_verified"
                                ? "Wise schedule checked"
                                : "Refresh to check the Wise schedule."}
                            </span>
                            {s.issues?.map((i) => (
                              <span
                                className="mt-1 block text-xs text-muted-foreground"
                                key={i.code}
                              >
                                {i.message} {i.action}
                              </span>
                            ))}
                          </span>
                        </label>
                      ))}
                      {chosen && (
                        <div className="space-y-3 rounded-lg border border-primary/30 bg-primary/5 p-4">
                          <p className="text-sm">
                            {chosen.verification !== "wise_verified"
                              ? "Refresh availability to check this lesson against the Wise schedule."
                              : "Confirm " +
                                slot(chosen.start, chosen.end) +
                                ". Wise will be checked again. Calendar delivery is queued separately, and operations staff can record family communication immediately."}
                          </p>
                          <Button
                            disabled={
                              busy || chosen.verification !== "wise_verified"
                            }
                            onClick={() => void book()}
                          >
                            {busy
                              ? "Verifying and confirming…"
                              : "Confirm observation"}
                          </Button>
                        </div>
                      )}
                    </>
                  )}
              </div>
            )}
            {canSchedule && (
              <div className="mt-5 flex flex-wrap gap-2 border-t pt-4">
                {observation && assignment.status !== "completed" && (
                  <Button
                    size="sm"
                    variant="outline"
                    onClick={() => setAction("cancel")}
                  >
                    Cancel / reschedule
                  </Button>
                )}
                {isManager &&
                  !["completed", "superseded"].includes(assignment.status) && (
                    <>
                      <Button
                        size="sm"
                        variant="outline"
                        onClick={() => setAction("reassign")}
                      >
                        Reassign observer
                      </Button>
                      <Button
                        size="sm"
                        variant="outline"
                        onClick={() => setAction("exempt")}
                      >
                        Record exemption
                      </Button>
                    </>
                  )}
                {isManager && assignment.status === "completed" && (
                  <Button
                    size="sm"
                    variant="outline"
                    onClick={() => setAction("reopen")}
                  >
                    Reopen as a revision
                  </Button>
                )}
              </div>
            )}
            {action && (
              <form
                className="mt-4 space-y-3 rounded-lg bg-muted/50 p-4"
                onSubmit={(e) => void command(e)}
              >
                <h3 className="text-sm font-semibold">
                  {action === "reassign"
                    ? "Designate an eligible observer"
                    : action === "reopen"
                      ? "Create an audited report revision"
                      : action === "exempt"
                        ? "Record a reasoned exemption"
                        : "Withdraw this observation"}
                </h3>
                {action === "reassign" && (
                  <label className="block text-sm">
                    Observer
                    <select
                      required
                      className={control + " mt-1"}
                      value={observer}
                      onChange={(e) => setObserver(e.target.value)}
                    >
                      <option value="">Choose an observer</option>
                      {grants
                        .filter(
                          (g) =>
                            g.active &&
                            g.role !== "coordinator" &&
                            g.canonicalKey &&
                            g.canonicalKey !== assignment.canonicalKey &&
                            coverageScopes(g).includes(scopeOf(assignment)),
                        )
                        .map((g) => (
                          <option key={g.email}>{g.email}</option>
                        ))}
                    </select>
                  </label>
                )}
                {observation && action !== "reopen" && (
                  <p className="text-sm">
                    The existing Calendar event will be withdrawn, and staff
                    will receive a cancellation task. Confirm the replacement
                    separately.
                  </p>
                )}
                <label className="block text-sm">
                  Reason
                  <textarea
                    className={control + " mt-1"}
                    required
                    minLength={3}
                    maxLength={1000}
                    value={reason}
                    onChange={(e) => setReason(e.target.value)}
                  />
                </label>
                <div className="flex gap-2">
                  <Button type="submit" disabled={busy}>
                    Save change
                  </Button>
                  <Button
                    variant="ghost"
                    type="button"
                    onClick={() => setAction("")}
                  >
                    Keep current arrangement
                  </Button>
                </div>
              </form>
            )}
          </section>
          <section className={panel}>
            <h2 className="text-lg font-semibold">Family communication</h2>
            <p className="mb-4 mt-2 text-sm text-muted-foreground">
              A new arrangement requires fresh acknowledgements.
            </p>
            <CommunicationList
              rows={data.communications.filter((c) => !c.supersededAt)}
              canAcknowledge={data.access.role !== "observer"}
              canResolve={isManager}
              onChange={() => void load()}
            />
          </section>
        </div>
        {!!data.deliveries.filter((j) => j.status === "failed").length && (
          <Notice error>
            {data.deliveries
              .filter((j) => j.status === "failed")
              .map((j) => (
                <p key={j.id}>
                  {j.kind.replaceAll("_", " ")}
                  {j.recipient ? " · " + j.recipient : ""}: {j.lastError}{" "}
                  Automatic retry pending.
                </p>
              ))}
          </Notice>
        )}
        {report && (
          <>
            <div className="flex flex-wrap items-center justify-between gap-3">
              <h2 className="text-xl font-semibold">Rubric and report</h2>
              <label className="text-xs text-muted-foreground">
                Report history
                <select
                  className={control + " mt-1"}
                  value={report.id}
                  onChange={(e) => setReportId(e.target.value)}
                >
                  {data.reports.map((r) => (
                    <option key={r.id} value={r.id}>
                      Revision {r.reportVersion} ·{" "}
                      {r.submittedAt ? "Submitted" : "Draft"}
                      {r.late ? " · Late" : ""}
                    </option>
                  ))}
                </select>
              </label>
            </div>
            <ReportEditor
              key={report.id}
              report={report}
              editable={
                report.id === data.reports[0]?.id &&
                !report.submittedAt &&
                report.authorEmail === data.access.email &&
                assignment.observerEmail === data.access.email &&
                observation?.id === report.observationId
              }
              onSubmit={load}
            />
          </>
        )}
        {!report && data.access.role !== "coordinator" && (
          <div className={panel}>
            <h2 className="font-semibold">Your report will appear here</h2>
            <p className="mt-2 text-sm text-muted-foreground">
              Confirm an observation to start its rubric. Reports are due 48
              hours after the lesson and stay attributed to {assignment.quarter}
              .
            </p>
          </div>
        )}
        <details className={panel}>
          <summary className="cursor-pointer font-semibold">
            Observation and communication history
          </summary>
          <div className="mt-4 space-y-3">
            {data.observations.map((o) => (
              <div className="rounded-lg border p-3 text-sm" key={o.id}>
                <p className="font-medium">
                  {slot(o.lesson.start, o.lesson.end)} ·{" "}
                  {o.current ? "Current" : "Previous"}
                </p>
                <p className="mt-1 break-all text-muted-foreground">
                  {o.observerEmail}
                  {o.invalidReason ? " · " + o.invalidReason : ""}
                </p>
              </div>
            ))}
            <CommunicationList
              rows={data.communications.filter((c) => !!c.supersededAt)}
              canAcknowledge={false}
              onChange={() => undefined}
            />
            {data.events.map((e) => (
              <p
                className="break-words text-xs text-muted-foreground"
                key={e.id}
              >
                {when(e.createdAt)} · {e.action.replaceAll("_", " ")} ·{" "}
                {e.actor}
                {typeof e.detail.reason === "string"
                  ? " · " + e.detail.reason
                  : ""}
              </p>
            ))}
          </div>
        </details>
      </div>
    </div>
  );
}
