"use client";
import { useCallback, useEffect, useRef, useState } from "react";
import Link from "next/link";
import {
  ArrowUpRight,
  CalendarDays,
  ClipboardCheck,
  Clock3,
  RefreshCw,
  Users,
} from "lucide-react";
import { Button } from "@/components/ui/button";
import type { SitInAccess } from "@/lib/tutor-sit-ins/access";
import {
  DEPARTMENT_INFO,
  scopeLabel,
  currentQuarter,
  FIRST_QUARTER,
} from "@/lib/tutor-sit-ins/model";
import type { DashboardData } from "@/lib/tutor-sit-ins/client-types";
import { AdminSettings } from "./admin-settings";
import { CalendarSettings } from "./calendar-settings";
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
export function SitInDashboard({
  access,
  initialQuarter,
  calendarResult,
}: {
  access: SitInAccess;
  initialQuarter: string;
  calendarResult?: string;
}) {
  const [quarter, setQuarter] = useState(initialQuarter),
    [data, setData] = useState<DashboardData | null>(null),
    [error, setError] = useState(""),
    [refreshing, setRefreshing] = useState(false);
  const [tab, setTab] = useState("observations"),
    [department, setDepartment] = useState("all"),
    [status, setStatus] = useState("all"),
    [search, setSearch] = useState("");
  const activeQuarter = useRef(initialQuarter);
  const load = useCallback(async () => {
    try {
      const result = await api<DashboardData>("?quarter=" + quarter);
      if (activeQuarter.current === quarter) setData(result);
    } catch (e) {
      setError((e as Error).message);
    }
  }, [quarter]);
  const refresh = useCallback(async () => {
    setRefreshing(true);
    setError("");
    try {
      const result = await api<DashboardData>("/refresh", { quarter });
      if (activeQuarter.current === quarter) setData(result);
    } catch (e) {
      setError((e as Error).message);
    } finally {
      if (activeQuarter.current === quarter) setRefreshing(false);
    }
  }, [quarter]);
  useEffect(() => {
    let active = true;
    void load().then(() => {
      if (active) void refresh();
    });
    return () => {
      active = false;
    };
  }, [load, refresh]);
  const rows = data?.assignments || [],
    comms =
      data?.communications.filter(
        (c) => !c.parentInformedAt || !c.studentInformedAt,
      ) || [];
  const visible = rows.filter(
    (a) =>
      (department === "all" || a.department === department) &&
      (status === "all" ||
        (status === "overdue" ? a.reportOverdue : a.status === status)) &&
      (a.tutorName + " " + (a.observerEmail || ""))
        .toLowerCase()
        .includes(search.toLowerCase()),
  );
  const year = Math.max(2026, Number(currentQuarter().slice(0, 4)));
  const quarters = Array.from(
    { length: (year - 2026 + 2) * 4 },
    (_, i) => 2026 + Math.floor(i / 4) + "-Q" + ((i % 4) + 1),
  ).filter((q) => q >= FIRST_QUARTER);
  const completed = rows.filter((a) => a.status === "completed").length,
    required = rows.filter((a) => a.status !== "exempt").length;
  return (
    <div className="min-h-0 flex-1 overflow-y-auto">
      <div className="mx-auto max-w-7xl space-y-5 pb-12">
        <header className="flex flex-wrap items-start justify-between gap-4 py-3">
          <div>
            <p className="mb-1 text-xs font-semibold uppercase tracking-widest text-primary">
              BeGifted · Quality assurance
            </p>
            <h1 className="text-3xl font-semibold tracking-tight">
              Tutor Sit-ins
            </h1>
            <p className="mt-2 text-sm text-muted-foreground">
              Better teaching, one observation at a time. All times are Bangkok.
            </p>
          </div>
          <div className="flex items-end gap-2">
            <label className="text-xs text-muted-foreground">
              Quarter
              <select
                className={control + " mt-1 w-32"}
                value={quarter}
                onChange={(e) => {
                  activeQuarter.current = e.target.value;
                  setData(null);
                  setQuarter(e.target.value);
                }}
              >
                {quarters.map((q) => (
                  <option key={q}>{q}</option>
                ))}
              </select>
            </label>
            <Button
              variant="outline"
              disabled={refreshing}
              onClick={() => void refresh()}
            >
              <RefreshCw
                className={"size-4 " + (refreshing ? "animate-spin" : "")}
              />
              {refreshing ? "Checking…" : "Refresh availability"}
            </Button>
          </div>
        </header>
        {calendarResult === "error" && (
          <Notice error>
            Calendar connection was not completed. Open Calendar setup and
            reconnect.
          </Notice>
        )}
        {calendarResult === "connected" && (
          <Notice>
            Calendar connected. Queued observation events will be added to your
            selected destination.
          </Notice>
        )}
        {error && (
          <Notice error>
            {error} Existing assignments and reports are preserved.
          </Notice>
        )}
        {data && !data.deliveryEnabled && (
          <Notice>
            Calendar and email delivery are paused. You can confirm Wise-checked
            lessons, record family communication and submit reports.
            Notifications stay queued.
          </Notice>
        )}
        {!!data?.deliveryIssues?.length && (
          <Notice error>
            <p className="font-medium">
              {data.deliveryIssues.length} delivery issue
              {data.deliveryIssues.length === 1 ? "" : "s"} awaiting retry
            </p>
            <ul className="mt-2 space-y-1">
              {data.deliveryIssues.slice(0, 5).map((issue) => (
                <li key={issue.id}>
                  {issue.recipient || "Calendar"}:{" "}
                  {issue.error || "Delivery could not complete."}
                </li>
              ))}
            </ul>
          </Notice>
        )}
        <div className="grid grid-cols-2 gap-3 lg:grid-cols-4">
          {[
            {
              label: "Quarterly coverage",
              value: completed + " / " + required,
              note: "Reports submitted",
              Icon: ClipboardCheck,
            },
            {
              label: "Upcoming observations",
              value: rows.filter(
                (a) =>
                  a.status === "scheduled" &&
                  a.observation &&
                  new Date(a.observation.endTime) > new Date(),
              ).length,
              note: "Confirmed or awaiting invitation",
              Icon: CalendarDays,
            },
            {
              label: "Overdue reports",
              value: rows.filter((a) => a.reportOverdue).length,
              note: "Due 48 hours after the lesson",
              Icon: Clock3,
            },
            {
              label: "Families to inform",
              value: comms.length,
              note: "Parent and student checklist",
              Icon: Users,
            },
          ].map((c) => (
            <div className={panel + " !p-4"} key={c.label}>
              <div className="flex items-center gap-2 text-xs text-muted-foreground">
                <c.Icon className="size-4 shrink-0" />
                {c.label}
              </div>
              <p className="mt-3 text-3xl font-semibold tabular-nums">
                {data ? c.value : "—"}
              </p>
              <p className="mt-1 text-xs text-muted-foreground">{c.note}</p>
            </div>
          ))}
        </div>
        <div
          className="flex gap-1 overflow-x-auto border-b"
          role="tablist"
          aria-label="Tutor sit-in workspaces"
        >
          {[
            ["observations", "Observations"],
            ["communication", "Family communication"],
            ...(access.role !== "coordinator"
              ? [["calendar", "Calendar setup"]]
              : []),
            ...(access.role === "manager"
              ? [["settings", "Administration"]]
              : []),
          ].map(([id, label]) => (
            <button
              type="button"
              role="tab"
              aria-selected={tab === id}
              key={id}
              onClick={() => setTab(id)}
              className={
                "min-h-11 shrink-0 border-b-2 px-4 text-sm font-medium " +
                (tab === id
                  ? "border-primary text-primary"
                  : "border-transparent text-muted-foreground hover:text-foreground")
              }
            >
              {label}
            </button>
          ))}
        </div>
        {tab === "observations" && (
          <section aria-label="Quarterly observations" className="space-y-4">
            <div className="flex flex-wrap gap-3">
              <label className="min-w-40 flex-1 text-xs text-muted-foreground">
                Find a tutor
                <input
                  className={control + " mt-1"}
                  placeholder="Tutor or observer"
                  value={search}
                  onChange={(e) => setSearch(e.target.value)}
                />
              </label>
              <label className="text-xs text-muted-foreground">
                Department
                <select
                  className={control + " mt-1"}
                  value={department}
                  onChange={(e) => setDepartment(e.target.value)}
                >
                  <option value="all">All my departments</option>
                  {DEPARTMENT_INFO.filter(
                    (h) =>
                      access.role !== "observer" ||
                      access.departments.includes(h.department),
                  ).map((h) => (
                    <option key={h.department} value={h.department}>
                      {h.label}
                    </option>
                  ))}
                </select>
              </label>
              <label className="text-xs text-muted-foreground">
                Status
                <select
                  className={control + " mt-1"}
                  value={status}
                  onChange={(e) => setStatus(e.target.value)}
                >
                  {[
                    ["all", "All statuses"],
                    ["pending", "Awaiting a slot"],
                    ["needs_rescheduling", "Needs rescheduling"],
                    ["scheduled", "Scheduled"],
                    ["overdue", "Report overdue"],
                    ["completed", "Completed"],
                    ["exempt", "Exempt"],
                  ].map(([v, label]) => (
                    <option key={v} value={v}>
                      {label}
                    </option>
                  ))}
                </select>
              </label>
            </div>
            {!data ? (
              <Loading />
            ) : !visible.length ? (
              <div className={panel + " py-12 text-center"}>
                <ClipboardCheck className="mx-auto size-8 text-primary" />
                <h2 className="mt-4 font-semibold">
                  {rows.length
                    ? "No matching observations"
                    : "Your quarterly worklist starts here"}
                </h2>
                <p className="mx-auto mt-2 max-w-lg text-sm text-muted-foreground">
                  {rows.length
                    ? "Try another filter or tutor name."
                    : "Refresh availability to create obligations from real classes in this quarter. Classes with unclear subject mappings appear in Administration for review."}
                </p>
              </div>
            ) : (
              <div className="overflow-hidden rounded-xl border bg-card">
                <div className="hidden grid-cols-[1.2fr_1fr_1.5fr_1fr_24px] gap-4 border-b bg-muted/40 px-5 py-3 text-xs font-medium text-muted-foreground lg:grid">
                  <span>Tutor / department</span>
                  <span>Status</span>
                  <span>Next action</span>
                  <span>Observer</span>
                  <span />
                </div>
                {visible.map((a) => (
                  <Link
                    key={a.id}
                    href={"/tutor-sit-ins/" + a.id}
                    className="grid gap-3 border-b px-5 py-4 last:border-b-0 hover:bg-primary/5 focus-visible:outline-2 focus-visible:outline-primary lg:grid-cols-[1.2fr_1fr_1.5fr_1fr_24px] lg:items-center lg:gap-4"
                  >
                    <div>
                      <p className="font-semibold">{a.tutorName}</p>
                      <p className="mt-1 text-xs text-muted-foreground">
                        {scopeLabel(a)} · {a.quarter}
                      </p>
                    </div>
                    <div>
                      <Status value={a.status} />
                      {a.reportOverdue && (
                        <p className="mt-1 text-xs font-medium text-destructive">
                          Report overdue
                        </p>
                      )}
                    </div>
                    <div className="text-sm">
                      {a.observation ? (
                        <>
                          <p>
                            {slot(
                              a.observation.lesson.start,
                              a.observation.lesson.end,
                            )}
                          </p>
                          <p className="mt-1 text-xs text-muted-foreground">
                            {a.status === "completed"
                              ? "Report submitted"
                              : "Report due " + when(a.reportDue)}
                          </p>
                          {
                            <p className="mt-1 text-xs text-amber-700 dark:text-amber-300">
                              {calendarDeliveryLabel(
                                a.observation.calendarStatus,
                              )}
                            </p>
                          }
                          {!!a.readinessIssues?.length && (
                            <p className="text-xs text-destructive">
                              {a.readinessIssues[0].message}
                            </p>
                          )}
                          {a.observation.calendarError && (
                            <p className="text-xs text-destructive">
                              {a.observation.calendarError}
                            </p>
                          )}
                        </>
                      ) : (
                        <>
                          <p>
                            {a.suggestions.length
                              ? a.suggestions.length + " proposed lessons"
                              : a.status === "exempt"
                                ? a.reason
                                : a.suggestionError ||
                                  "Waiting for a suitable lesson"}
                          </p>
                          {a.suggestions.some(
                            (s) => s.verification === "wise_verified",
                          ) && (
                            <p className="mt-1 text-xs font-medium text-amber-800 dark:text-amber-300">
                              Wise schedule checked.
                            </p>
                          )}
                          {!!a.readinessIssues?.length && (
                            <p className="mt-1 text-xs text-muted-foreground">
                              {a.readinessIssues[0].action}
                            </p>
                          )}
                          <p className="mt-1 text-xs text-muted-foreground">
                            {a.suggestions[0]
                              ? "Earliest: " + when(a.suggestions[0].start)
                              : a.checkedAt
                                ? "Checked " + when(a.checkedAt)
                                : "Refresh to check availability"}
                          </p>
                        </>
                      )}
                    </div>
                    <p className="break-all text-xs text-muted-foreground">
                      {a.observerEmail ||
                        "Administrator to assign an alternate"}
                    </p>
                    <ArrowUpRight className="hidden size-4 text-primary lg:block" />
                  </Link>
                ))}
              </div>
            )}
            <p className="text-xs text-muted-foreground">
              Tutors with fewer suitable lessons are prioritized. Existing
              bookings stay in place. New openings require the head’s
              confirmation and at least 24 hours’ notice.
            </p>
          </section>
        )}
        {tab === "communication" && (
          <section className={panel}>
            <h2 className="text-lg font-semibold">Keep families informed</h2>
            <p className="mb-5 mt-2 text-sm text-muted-foreground">
              Operations staff record separate parent and student
              acknowledgements. Changes and cancellations create new tasks.
            </p>
            {!comms.length && (
              <p className="text-sm text-muted-foreground">
                All current family communication tasks are complete.
              </p>
            )}
            {comms.map((c) => (
              <div key={c.id} className="mb-5">
                <Link
                  href={"/tutor-sit-ins/" + c.observation.assignmentId}
                  className="mb-2 block text-sm font-medium text-primary"
                >
                  {c.observation.lesson.tutorName} ·{" "}
                  {slot(c.observation.lesson.start, c.observation.lesson.end)} →
                </Link>
                <CommunicationList
                  rows={[c]}
                  canAcknowledge={access.role !== "observer"}
                  canResolve={access.role === "manager"}
                  onChange={() => void load()}
                />
              </div>
            ))}
          </section>
        )}
        {tab === "calendar" && (
          <div className="max-w-3xl">
            <CalendarSettings />
            <p className="mt-3 text-sm text-muted-foreground">
              Your calendar account can differ from your sign-in email. Your
              assigned access stays the same. Finish or cancel upcoming
              observations before switching accounts.
            </p>
          </div>
        )}
        {tab === "settings" && access.role === "manager" && (
          <AdminSettings quarter={quarter} onChange={() => void load()} />
        )}
      </div>
    </div>
  );
}
