"use client";

import {
  cloneElement,
  isValidElement,
  useId,
  useCallback,
  useEffect,
  useRef,
  useState,
  type FormEvent,
  type ReactNode,
} from "react";
import { formatInTimeZone } from "date-fns-tz";
import {
  Clock3,
  Download,
  RefreshCw,
  Wifi,
  WifiOff,
  CheckCircle2,
} from "lucide-react";
import { Button, buttonVariants } from "@/components/ui/button";
import type {
  AttendanceOverview,
  AttendanceSettings,
} from "@/lib/tutor-attendance/data";
import {
  ATTENDANCE_ZONE,
  applicableSchedule,
  DEFAULT_WEEK,
  localDate,
  type Week,
} from "@/lib/tutor-attendance/model";
import css from "./workspace.module.css";

type Day = AttendanceOverview["rows"][number];
type Settings = AttendanceSettings & { detectedAddress: string | null };
type Tab = "Today" | "History" | "Corrections" | "Setup";
type Save = (
  url: string,
  body: unknown,
  message: string,
  method?: string,
) => Promise<boolean>;
const api = "/api/tutor-attendance";
const clock = (date: string | null, seconds = false) =>
  date
    ? formatInTimeZone(
        new Date(date),
        ATTENDANCE_ZONE,
        seconds ? "HH:mm:ss" : "HH:mm",
      )
    : "—";
const displayDate = (date: string) =>
  new Date(`${date}T12:00:00Z`).toLocaleDateString("en-GB", {
    day: "numeric",
    month: "short",
    year: "numeric",
    timeZone: ATTENDANCE_ZONE,
  });
const span = (minutes: number | null) =>
  minutes === null ? "—" : `${Math.floor(minutes / 60)}h ${minutes % 60}m`;
const labels: Record<string, string> = {
  expected: "Expected",
  awaiting_arrival: "Awaiting arrival",
  clocked_in: "Clocked in",
  complete: "Complete",
  missing: "No record",
  missing_in: "Missing arrival",
  missing_out: "Missing departure",
  excused: "Excused",
  unscheduled: "Unscheduled",
};
async function read<T>(url: string): Promise<T> {
  const response = await fetch(url, { cache: "no-store" });
  if (
    response.redirected ||
    !response.headers.get("content-type")?.includes("application/json")
  )
    throw new Error("Your session expired. Sign in again to continue.");
  const body = await response.json();
  if (!response.ok) throw new Error(body.error || "Could not load attendance.");
  return body;
}
function Field({ label, children }: { label: string; children: ReactNode }) {
  const id = useId();
  return (
    <div className={css.field}>
      <label htmlFor={id}>{label}</label>
      {isValidElement<{ id?: string }>(children)
        ? cloneElement(children, { id })
        : children}
    </div>
  );
}
function RequirementLabel({ row }: { row?: Day }) {
  if (!row) return <>Enrollment is not active for today</>;
  return (
    <>
      {row.requirement && "start" in row.requirement
        ? `${row.requirement.start}–${row.requirement.end}`
        : row.requirement && "excused" in row.requirement
          ? `Excused · ${row.requirement.reason}`
          : "No required office hours"}
    </>
  );
}
function Status({ row }: { row: Day }) {
  return (
    <div>
      <span
        className={`${css.pill} ${["complete", "clocked_in"].includes(row.status) ? css.good : row.status.startsWith("missing") || row.status === "awaiting_arrival" ? css.attention : ""}`}
      >
        {labels[row.status]}
      </span>
      <div className={css.flags}>
        {row.lateMinutes > 0 && (
          <span className={`${css.pill} ${css.attention}`}>
            {row.lateMinutes}m late
          </span>
        )}
        {row.earlyMinutes > 0 && (
          <span className={`${css.pill} ${css.attention}`}>
            {row.earlyMinutes}m early departure
          </span>
        )}
        {row.corrected && <span className={css.pill}>Corrected</span>}
        {!row.requirement && (row.clockIn || row.clockOut) && (
          <span className={css.pill}>Unscheduled</span>
        )}
      </div>
    </div>
  );
}
function AttendanceTable({
  rows,
  history,
  correct,
}: {
  rows: Day[];
  history?: boolean;
  correct?: (row: Day) => void;
}) {
  return rows.length ? (
    <div className={css.tableWrap}>
      <table className={css.table}>
        <thead>
          <tr>
            {history && <th>Date</th>}
            <th>Tutor</th>
            <th>Required</th>
            <th>Arrival</th>
            <th>Departure</th>
            <th>Span</th>
            <th>Status</th>
            {correct && (
              <th>
                <span className="sr-only">Actions</span>
              </th>
            )}
          </tr>
        </thead>
        <tbody>
          {rows.map((row) => (
            <tr key={`${row.canonicalKey}:${row.date}`}>
              {history && <td className={css.mono}>{displayDate(row.date)}</td>}
              <td>
                <strong>{row.name}</strong>
              </td>
              <td className={css.mono}>
                <RequirementLabel row={row} />
              </td>
              <td className={css.mono}>
                {clock(row.clockIn, true)}
                {row.corrected && (
                  <div className={css.muted}>
                    Recorded: {clock(row.recordedIn, true)}
                  </div>
                )}
              </td>
              <td className={css.mono}>
                {clock(row.clockOut, true)}
                {row.corrected && (
                  <div className={css.muted}>
                    Recorded: {clock(row.recordedOut, true)}
                  </div>
                )}
              </td>
              <td className={css.mono}>{span(row.spanMinutes)}</td>
              <td>
                <Status row={row} />
              </td>
              {correct && (
                <td>
                  <Button
                    variant="ghost"
                    size="sm"
                    onClick={() => correct(row)}
                  >
                    Correct
                  </Button>
                </td>
              )}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  ) : (
    <p className={css.empty}>No attendance records in this view.</p>
  );
}

export function AttendanceWorkspace() {
  const [tab, setTab] = useState<Tab>("Today");
  const [payload, setPayload] = useState<AttendanceOverview | null>(null);
  const [settings, setSettings] = useState<Settings | null>(null);
  const [start, setStart] = useState(() => `${localDate().slice(0, 8)}01`);
  const [end, setEnd] = useState(() => localDate());
  const [tutor, setTutor] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const [correctionDay, setCorrectionDay] = useState<Day | null>(null);
  const requestNumber = useRef(0);
  const invalidateRequests = useCallback(() => {
    requestNumber.current += 1;
  }, []);
  const punchKeys = useRef<Record<string, string>>({});
  const query = new URLSearchParams(
    tab === "History"
      ? { start, end, ...(tutor ? { tutor } : {}) }
      : { start: localDate(), end: localDate() },
  ).toString();
  const load = useCallback(async () => {
    const id = ++requestNumber.current;
    try {
      const data = await read<AttendanceOverview>(`${api}?${query}`);
      if (id !== requestNumber.current) return;
      setPayload(data);
      setError("");
      if (tab === "Setup" && data.access.admin) {
        const nextSettings = await read<Settings>(`${api}/settings`);
        if (id === requestNumber.current) setSettings(nextSettings);
      }
    } catch (e) {
      if (id === requestNumber.current)
        setError(e instanceof Error ? e.message : "Could not load attendance.");
    }
  }, [query, tab]);
  useEffect(() => {
    void load();
    const refresh = () => {
      if (document.visibilityState === "visible") void load();
    };
    const timer = window.setInterval(refresh, 30000);
    window.addEventListener("focus", refresh);
    document.addEventListener("visibilitychange", refresh);
    return () => {
      invalidateRequests();
      clearInterval(timer);
      window.removeEventListener("focus", refresh);
      document.removeEventListener("visibilitychange", refresh);
    };
  }, [load, invalidateRequests]);
  const save: Save = async (url, body, message, method = "POST") => {
    if (busy) return false;
    setBusy(true);
    setError("");
    setNotice("");
    try {
      const response = await fetch(url, {
        method,
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
      });
      if (
        response.redirected ||
        !response.headers.get("content-type")?.includes("application/json")
      )
        throw new Error("Your session expired. Sign in again before retrying.");
      const result = await response.json();
      if (!response.ok)
        throw new Error(result.error || "Could not save this change.");
      setNotice(message);
      await load();
      return true;
    } catch (e) {
      setError(
        e instanceof Error ? e.message : "Could not save. Please retry.",
      );
      return false;
    } finally {
      setBusy(false);
    }
  };
  const punch = async (kind: "in" | "out") => {
    const date = payload?.today ?? localDate();
    const key = `${date}:${kind}`;
    punchKeys.current[key] ??= crypto.randomUUID();
    await save(
      `${api}/punch`,
      { kind, date, idempotencyKey: punchKeys.current[key] },
      kind === "in" ? "Arrival recorded." : "Departure recorded.",
    );
  };
  const rows = payload?.rows ?? [];
  const todayRows = rows.filter(
    (r) =>
      r.date === payload?.today && (r.requirement || r.clockIn || r.clockOut),
  );
  const mine = rows.find(
    (r) =>
      r.date === payload?.today &&
      r.canonicalKey === payload.access.canonicalKey,
  );
  const openCorrection = (row: Day) => {
    setCorrectionDay(row);
    setNotice("");
    window.setTimeout(
      () =>
        document
          .getElementById("attendance-correction")
          ?.scrollIntoView({ behavior: "smooth", block: "center" }),
      50,
    );
  };
  const pending =
    payload?.corrections.filter((c) => c.status === "pending").length ?? 0;
  return (
    <div className={css.workspace}>
      <div className={css.inner}>
        <header className={css.header}>
          <div>
            <p className={css.eyebrow}>BeGifted · Tutor operations</p>
            <h1 className={css.title}>Office Attendance</h1>
            <p className={css.muted}>
              {payload?.access.admin
                ? "A clear view of office hours, arrivals, and the records that need attention."
                : "Your office hours, in one place. Connect to office Wi-Fi when you arrive and leave."}
            </p>
          </div>
          <Button variant="outline" onClick={() => void load()} disabled={busy}>
            <RefreshCw size={15} />
            Refresh
          </Button>
        </header>
        {error && (
          <div role="alert" className={`${css.banner} ${css.error}`}>
            {error}
            {error.includes("Sign in") && (
              <a
                className="ml-2 underline"
                href="/login?callbackUrl=%2Ftutor-attendance"
              >
                Sign in
              </a>
            )}
          </div>
        )}
        {notice && (
          <div role="status" className={`${css.banner} ${css.success}`}>
            {notice}
          </div>
        )}
        {!payload ? (
          <p role="status" className={css.empty}>
            Loading attendance…
          </p>
        ) : (
          <>
            {!payload.enabled && (
              <div className={css.banner}>
                <strong>Clocking is not enabled yet.</strong>{" "}
                {payload.access.admin
                  ? "Confirm tutor accounts, schedules, and office connections in Setup before launch."
                  : "Your administrator is preparing attendance. History and correction requests are available."}
              </div>
            )}
            <div
              className={css.tabs}
              role="tablist"
              aria-label="Attendance views"
              onKeyDown={(event) => {
                if (
                  !["ArrowLeft", "ArrowRight", "Home", "End"].includes(
                    event.key,
                  )
                )
                  return;
                event.preventDefault();
                const buttons = Array.from(
                  event.currentTarget.querySelectorAll<HTMLButtonElement>(
                    '[role="tab"]',
                  ),
                );
                const current = buttons.findIndex(
                  (button) => button === document.activeElement,
                );
                const next =
                  event.key === "Home"
                    ? 0
                    : event.key === "End"
                      ? buttons.length - 1
                      : (current +
                          (event.key === "ArrowRight" ? 1 : -1) +
                          buttons.length) %
                        buttons.length;
                buttons[next]?.focus();
                buttons[next]?.click();
              }}
            >
              {(
                [
                  "Today",
                  "History",
                  "Corrections",
                  ...(payload.access.admin ? ["Setup"] : []),
                ] as Tab[]
              ).map((item) => (
                <button
                  type="button"
                  role="tab"
                  aria-selected={tab === item}
                  tabIndex={tab === item ? 0 : -1}
                  className={css.tab}
                  key={item}
                  onClick={() => {
                    setTab(item);
                    setCorrectionDay(null);
                    setNotice("");
                  }}
                >
                  {item}
                  {item === "Corrections" && pending > 0 ? ` (${pending})` : ""}
                </button>
              ))}
            </div>
            {tab === "Today" && (
              <>
                {payload.access.canonicalKey && (
                  <section className={`${css.panel} ${css.clock}`}>
                    <div>
                      <div className={css.row}>
                        <span className={css.eyebrow}>
                          My day · {displayDate(payload.today)}
                        </span>
                        {mine && <Status row={mine} />}
                      </div>
                      <h2 className="mt-3">
                        {mine?.name ?? "Your office attendance"}
                      </h2>
                      <div className={css.clockTime}>
                        <RequirementLabel row={mine} />
                      </div>
                      <p className={css.muted}>
                        Asia/Bangkok · arrival and final departure · breaks
                        included
                      </p>
                      <div className={css.times}>
                        <div>
                          <p className={css.muted}>Arrival</p>
                          <p className={css.timeValue}>
                            {clock(mine?.clockIn ?? null, true)}
                          </p>
                        </div>
                        <div>
                          <p className={css.muted}>Departure</p>
                          <p className={css.timeValue}>
                            {clock(mine?.clockOut ?? null, true)}
                          </p>
                        </div>
                        <div>
                          <p className={css.muted}>Completed span</p>
                          <p className={css.timeValue}>
                            {span(mine?.spanMinutes ?? null)}
                          </p>
                        </div>
                      </div>
                    </div>
                    <div className={css.clockAction}>
                      <div className={css.row}>
                        {payload.network.approved ? (
                          <Wifi size={18} />
                        ) : (
                          <WifiOff size={18} />
                        )}
                        <span className={css.muted}>
                          {payload.network.approved
                            ? `Office connection recognized${payload.network.label ? ` · ${payload.network.label}` : ""}`
                            : "Connect to approved office Wi-Fi"}
                        </span>
                      </div>
                      {mine?.clockOut ? (
                        <Button disabled>
                          <CheckCircle2 size={18} />
                          Departure recorded
                        </Button>
                      ) : (
                        <Button
                          disabled={
                            busy ||
                            !payload.enabled ||
                            !payload.network.approved ||
                            !mine
                          }
                          onClick={() =>
                            void punch(mine?.clockIn ? "out" : "in")
                          }
                        >
                          <Clock3 size={18} />
                          {busy
                            ? "Saving…"
                            : mine?.clockIn
                              ? "Clock out"
                              : "Clock in"}
                        </Button>
                      )}
                      {mine && (
                        <Button
                          variant="outline"
                          disabled={busy}
                          onClick={() => openCorrection(mine)}
                        >
                          Forgot or need to correct a time?
                        </Button>
                      )}
                      {mine && !mine.clockIn && !mine.clockOut && (
                        <Button
                          variant="ghost"
                          size="sm"
                          disabled={
                            busy ||
                            !payload.enabled ||
                            !payload.network.approved
                          }
                          onClick={() => void punch("out")}
                        >
                          Leaving with a missing arrival? Record departure
                        </Button>
                      )}
                    </div>
                  </section>
                )}
                {payload.access.admin && (
                  <>
                    <div className={css.stats}>
                      {[
                        [
                          "Required today",
                          todayRows.filter(
                            (r) => r.requirement && "start" in r.requirement,
                          ).length,
                        ],
                        [
                          "Clocked in",
                          todayRows.filter((r) => r.status === "clocked_in")
                            .length,
                        ],
                        [
                          "Completed",
                          todayRows.filter((r) => r.status === "complete")
                            .length,
                        ],
                        [
                          "Need attention",
                          todayRows.filter(
                            (r) =>
                              r.lateMinutes ||
                              r.earlyMinutes ||
                              [
                                "missing",
                                "missing_in",
                                "missing_out",
                                "awaiting_arrival",
                              ].includes(r.status),
                          ).length,
                        ],
                      ].map(([label, value]) => (
                        <div className={css.stat} key={label}>
                          <p className={css.muted}>{label}</p>
                          <p className={css.number}>{value}</p>
                        </div>
                      ))}
                    </div>
                    <section className={css.panel}>
                      <div className={css.sectionHead}>
                        <div>
                          <h2>Today’s office roster</h2>
                          <p className={css.muted}>
                            {displayDate(payload.today)} · Asia/Bangkok
                          </p>
                        </div>
                        <span className={css.pill}>
                          Refreshes every 30 seconds
                        </span>
                      </div>
                      <AttendanceTable rows={todayRows} />
                      {!payload.tutors.length && (
                        <Button
                          variant="outline"
                          onClick={() => setTab("Setup")}
                        >
                          Set up the first tutors
                        </Button>
                      )}
                    </section>
                  </>
                )}
                <p className={css.muted}>
                  Clocking records use of the office connection at each tap.
                  Attendance spans include normal breaks.
                </p>
              </>
            )}
            {tab === "History" && (
              <section className={css.panel}>
                <div className={css.sectionHead}>
                  <div>
                    <h2>Attendance history</h2>
                    <p className={css.muted}>
                      Complete spans include breaks. Incomplete records are
                      excluded from the total.
                    </p>
                  </div>
                  {payload.access.admin && (
                    <a
                      className={buttonVariants({ variant: "outline" })}
                      href={`${api}/export?${query}`}
                    >
                      <Download size={15} />
                      Export CSV
                    </a>
                  )}
                </div>
                <div className={`${css.filters} mt-5`}>
                  <Field label="From">
                    <input
                      className={css.input}
                      type="date"
                      value={start}
                      onChange={(e) => setStart(e.target.value)}
                    />
                  </Field>
                  <Field label="Through">
                    <input
                      className={css.input}
                      type="date"
                      value={end}
                      onChange={(e) => setEnd(e.target.value)}
                    />
                  </Field>
                  {payload.access.admin && (
                    <Field label="Tutor">
                      <select
                        className={css.input}
                        value={tutor}
                        onChange={(e) => setTutor(e.target.value)}
                      >
                        <option value="">All tutors</option>
                        {payload.tutors.map((t) => (
                          <option key={t.canonicalKey} value={t.canonicalKey}>
                            {t.name}
                          </option>
                        ))}
                      </select>
                    </Field>
                  )}
                  <div className={css.grow} />
                  <div>
                    <p className={css.muted}>Completed attendance span</p>
                    <p className={css.timeValue}>
                      {span(
                        rows.reduce(
                          (total, row) => total + (row.spanMinutes ?? 0),
                          0,
                        ),
                      )}
                    </p>
                  </div>
                </div>
                <AttendanceTable
                  rows={rows}
                  history
                  correct={!payload.access.admin ? openCorrection : undefined}
                />
              </section>
            )}
            {correctionDay && (
              <CorrectionForm
                key={`${correctionDay.date}:${correctionDay.revision}`}
                row={correctionDay}
                busy={busy}
                save={save}
                close={() => setCorrectionDay(null)}
              />
            )}
            {tab === "Corrections" && (
              <section className={css.panel}>
                <h2>
                  {payload.access.admin
                    ? "Review corrections"
                    : "Your correction requests"}
                </h2>
                <p className={css.muted}>
                  Original punches remain in the record. Approved times are
                  shown separately.
                </p>
                <div className={`${css.list} mt-5`}>
                  {payload.corrections.map((c) => (
                    <CorrectionReview
                      key={c.id}
                      request={c}
                      name={
                        payload.tutors.find(
                          (t) => t.canonicalKey === c.canonicalKey,
                        )?.name ?? c.canonicalKey
                      }
                      canReview={
                        payload.access.admin &&
                        c.requestedBy !== payload.access.email
                      }
                      busy={busy}
                      save={save}
                    />
                  ))}
                  {!payload.corrections.length && (
                    <p className={css.empty}>No correction requests.</p>
                  )}
                </div>
              </section>
            )}
            {tab === "Setup" &&
              payload.access.admin &&
              (settings ? (
                <Setup
                  key={settings.config.revision}
                  settings={settings}
                  busy={busy}
                  save={save}
                  today={payload.today}
                />
              ) : (
                <p role="status">Loading setup…</p>
              ))}
          </>
        )}
      </div>
    </div>
  );
}

function CorrectionForm({
  row,
  busy,
  save,
  close,
}: {
  row: Day;
  busy: boolean;
  save: Save;
  close: () => void;
}) {
  const [arrival, setArrival] = useState(row.clockIn ? clock(row.clockIn) : "");
  const [departure, setDeparture] = useState(
    row.clockOut ? clock(row.clockOut) : "",
  );
  const [reason, setReason] = useState("");
  const requestKey = useRef(crypto.randomUUID());
  async function submit(e: FormEvent) {
    e.preventDefault();
    if (
      await save(
        `${api}/corrections`,
        {
          date: row.date,
          proposedIn: arrival || null,
          proposedOut: departure || null,
          reason,
          expectedRevision: row.revision,
          idempotencyKey: requestKey.current,
        },
        "Correction submitted for administrator review.",
      )
    )
      close();
  }
  return (
    <section className={css.panel} id="attendance-correction">
      <h2>Request a correction · {displayDate(row.date)}</h2>
      <p className={css.muted}>
        Enter the arrival and departure times that should appear in your record.
        Leave a time empty if it is still unknown.
      </p>
      <form className={css.form} onSubmit={submit}>
        <div className={css.formRow}>
          <Field label="Arrival (Bangkok)">
            <input
              type="time"
              className={css.input}
              value={arrival}
              onChange={(e) => setArrival(e.target.value)}
            />
          </Field>
          <Field label="Departure (Bangkok)">
            <input
              type="time"
              className={css.input}
              value={departure}
              onChange={(e) => setDeparture(e.target.value)}
            />
          </Field>
        </div>
        <Field label="Reason">
          <textarea
            className={css.input}
            required
            minLength={3}
            maxLength={1000}
            rows={3}
            value={reason}
            onChange={(e) => setReason(e.target.value)}
            placeholder="Explain what happened and the correct times."
          />
        </Field>
        <div className={css.actions}>
          <Button disabled={busy || (!arrival && !departure)} type="submit">
            Submit for approval
          </Button>
          <Button variant="ghost" type="button" onClick={close}>
            Cancel
          </Button>
        </div>
      </form>
    </section>
  );
}
function CorrectionReview({
  request,
  name,
  canReview,
  busy,
  save,
}: {
  request: AttendanceOverview["corrections"][number];
  name: string;
  canReview: boolean;
  busy: boolean;
  save: Save;
}) {
  const [reason, setReason] = useState("");
  const stale = request.expectedRevision !== request.currentRevision;
  return (
    <article className={css.request}>
      <div className={css.requestHead}>
        <div>
          <h3>{name}</h3>
          <span className={css.muted}>
            {displayDate(request.date)} · proposed {clock(request.proposedIn)}–
            {clock(request.proposedOut)}
          </span>
        </div>
        <span
          className={`${css.pill} ${request.status === "approved" ? css.good : ""}`}
        >
          {request.status}
        </span>
      </div>
      <p className={css.muted}>
        Recorded: {clock(request.recordedIn, true)}–
        {clock(request.recordedOut, true)}
        {" · "}Current: {clock(request.currentIn, true)}–
        {clock(request.currentOut, true)}
      </p>
      <p className={css.muted}>{request.reason}</p>
      {request.status === "pending" && canReview && (
        <div className={css.divider}>
          {stale && (
            <p className={`${css.muted} mb-3`}>
              The attendance record changed after this request. Reject this
              request so the tutor can submit a current correction.
            </p>
          )}
          <Field label="Review reason">
            <input
              className={css.input}
              value={reason}
              minLength={3}
              maxLength={1000}
              onChange={(e) => setReason(e.target.value)}
            />
          </Field>
          <div className={`${css.actions} mt-3`}>
            <Button
              disabled={busy || reason.trim().length < 3 || stale}
              onClick={() =>
                void save(
                  `${api}/corrections/${request.id}`,
                  {
                    decision: "approved",
                    reason,
                    expectedRevision: request.currentRevision,
                  },
                  "Correction approved.",
                  "PATCH",
                )
              }
            >
              Approve times
            </Button>
            <Button
              variant="outline"
              disabled={busy || reason.trim().length < 3}
              onClick={() =>
                void save(
                  `${api}/corrections/${request.id}`,
                  {
                    decision: "rejected",
                    reason,
                    expectedRevision: request.currentRevision,
                  },
                  "Correction rejected.",
                  "PATCH",
                )
              }
            >
              Reject
            </Button>
          </div>
        </div>
      )}
      {request.reviewedAt && (
        <p className={css.muted}>
          {request.status === "approved" ? "Approved" : "Rejected"} by{" "}
          {request.reviewedBy} · {request.reviewReason}
        </p>
      )}
    </article>
  );
}

function Setup({
  settings,
  busy,
  save,
  today,
}: {
  settings: Settings;
  busy: boolean;
  save: Save;
  today: string;
}) {
  const [key, setKey] = useState("");
  const [email, setEmail] = useState("");
  const [from, setFrom] = useState(today);
  const [until, setUntil] = useState("");
  const [active, setActive] = useState(true);
  const [verified, setVerified] = useState(false);
  const [enrollmentReason, setEnrollmentReason] = useState("");
  const [scheduleKey, setScheduleKey] = useState("");
  const [effectiveFrom, setEffectiveFrom] = useState(today);
  const [week, setWeek] = useState<Week>(Array(7).fill(null));
  const [scheduleReason, setScheduleReason] = useState("");
  const [scheduleConfirmed, setScheduleConfirmed] = useState(false);
  const [exceptionKey, setExceptionKey] = useState("");
  const [exceptionDate, setExceptionDate] = useState(today);
  const [kind, setKind] = useState("excused");
  const [exceptionStart, setExceptionStart] = useState("10:00");
  const [exceptionEnd, setExceptionEnd] = useState("16:00");
  const [exceptionReason, setExceptionReason] = useState("");
  const [networks, setNetworks] = useState(settings.config.networks);
  const [networkVerified, setNetworkVerified] = useState(false);
  const [networkReason, setNetworkReason] = useState("");
  const name = (canonicalKey: string) =>
    settings.tutors.find((t) => t.canonicalKey === canonicalKey)?.displayName ??
    canonicalKey;
  const configSave = (body: Record<string, unknown>, message: string) =>
    save(
      `${api}/settings`,
      { ...body, expectedRevision: settings.config.revision },
      message,
      "PUT",
    );
  function chooseTutor(canonicalKey: string) {
    setKey(canonicalKey);
    const enrollment = settings.enrollments.find(
      (e) => e.canonicalKey === canonicalKey,
    );
    const tutor = settings.tutors.find((t) => t.canonicalKey === canonicalKey);
    setEmail(
      enrollment?.loginEmail ?? tutor?.onsiteEmail ?? tutor?.onlineEmail ?? "",
    );
    setFrom(enrollment?.startDate ?? today);
    setUntil(enrollment?.endDate ?? "");
    setActive(enrollment?.active ?? true);
    setVerified(false);
  }
  function chooseSchedule(canonicalKey: string) {
    setScheduleKey(canonicalKey);
    const current = applicableSchedule(
      effectiveFrom,
      canonicalKey,
      settings.schedules,
    );
    setWeek(current?.week ?? Array(7).fill(null));
    setScheduleConfirmed(false);
  }
  function updateWeek(index: number, field: "start" | "end", value: string) {
    setWeek((old) =>
      old.map((w, i) =>
        i === index
          ? { ...(w ?? { start: "10:00", end: "16:00" }), [field]: value }
          : w,
      ),
    );
    setScheduleConfirmed(false);
  }
  const enrollmentOptions = (
    <>
      <option value="">Select an enrolled tutor</option>
      {settings.enrollments.map((e) => (
        <option value={e.canonicalKey} key={e.canonicalKey}>
          {name(e.canonicalKey)}
          {!e.active ? " (inactive)" : ""}
        </option>
      ))}
    </>
  );
  return (
    <>
      <div className={css.banner}>
        <strong>Initial rollout: Tito, Ek, and Peat.</strong> Select each
        tutor’s verified profile and Google account, then confirm their
        individual schedule. The Monday–Thursday template is a starting point.
      </div>
      <div className={css.grid}>
        <section className={css.panel}>
          <h2>1. Enroll a full-time tutor</h2>
          <p className={css.muted}>
            Access is explicit. A separate approved Google email can be used
            without changing the tutor’s delivery addresses.
          </p>
          <form
            className={css.form}
            onSubmit={(e) => {
              e.preventDefault();
              void configSave(
                {
                  action: "enrollment",
                  canonicalKey: key,
                  loginEmail: email,
                  startDate: from,
                  endDate: until || null,
                  active,
                  reason: enrollmentReason,
                },
                "Enrollment saved.",
              );
            }}
          >
            <Field label="Tutor identity">
              <select
                className={css.input}
                required
                value={key}
                onChange={(e) => chooseTutor(e.target.value)}
              >
                <option value="">Select a verified tutor profile</option>
                {settings.tutors
                  .filter(
                    (t) =>
                      t.active ||
                      settings.enrollments.some(
                        (e) => e.canonicalKey === t.canonicalKey,
                      ),
                  )
                  .sort((a, b) => a.displayName.localeCompare(b.displayName))
                  .map((t) => (
                    <option key={t.canonicalKey} value={t.canonicalKey}>
                      {t.displayName}
                    </option>
                  ))}
              </select>
            </Field>
            <Field label="Approved Google sign-in email">
              <input
                className={css.input}
                type="email"
                required
                value={email}
                onChange={(e) => {
                  setEmail(e.target.value);
                  setVerified(false);
                }}
              />
            </Field>
            <div className={css.formRow}>
              <Field label="Enrollment starts">
                <input
                  type="date"
                  className={css.input}
                  value={from}
                  required
                  onChange={(e) => setFrom(e.target.value)}
                />
              </Field>
              <Field label="Enrollment ends (optional)">
                <input
                  type="date"
                  className={css.input}
                  value={until}
                  min={from}
                  onChange={(e) => setUntil(e.target.value)}
                />
              </Field>
            </div>
            <label className={css.check}>
              <input
                type="checkbox"
                checked={active}
                onChange={(e) => setActive(e.target.checked)}
              />
              Attendance access active
            </label>
            <label className={css.check}>
              <input
                type="checkbox"
                checked={verified}
                onChange={(e) => setVerified(e.target.checked)}
                required
              />
              I verified this tutor identity and their Google sign-in email.
            </label>
            <Field label="Reason for enrollment change">
              <input
                className={css.input}
                required
                minLength={3}
                maxLength={1000}
                value={enrollmentReason}
                onChange={(e) => setEnrollmentReason(e.target.value)}
              />
            </Field>
            <Button type="submit" disabled={busy || !key || !verified}>
              Save enrollment
            </Button>
          </form>
          {settings.enrollments.length > 0 && (
            <div className={css.divider}>
              <h3>Enrolled tutors</h3>
              {settings.enrollments.map((e) => (
                <div key={e.canonicalKey} className={`${css.row} mt-3`}>
                  <span className={css.grow}>{name(e.canonicalKey)}</span>
                  <span className={css.pill}>
                    {e.active ? "Active" : "Inactive"}
                  </span>
                  <Button
                    size="sm"
                    variant="ghost"
                    onClick={() => chooseTutor(e.canonicalKey)}
                  >
                    Edit
                  </Button>
                </div>
              ))}
            </div>
          )}
        </section>
        <section className={css.panel}>
          <h2>2. Set individual office hours</h2>
          <p className={css.muted}>
            Changes take effect on the selected date. Earlier schedule versions
            remain in history.
          </p>
          <form
            className={css.form}
            onSubmit={(e) => {
              e.preventDefault();
              void configSave(
                {
                  action: "schedule",
                  canonicalKey: scheduleKey,
                  effectiveFrom,
                  week,
                  reason: scheduleReason,
                },
                "Weekly schedule saved.",
              );
            }}
          >
            <Field label="Schedule for">
              <select
                className={css.input}
                required
                value={scheduleKey}
                onChange={(e) => chooseSchedule(e.target.value)}
              >
                {enrollmentOptions}
              </select>
            </Field>
            <Field label="Effective from">
              <input
                className={css.input}
                required
                type="date"
                min={today}
                value={effectiveFrom}
                onChange={(e) => {
                  setEffectiveFrom(e.target.value);
                  setScheduleConfirmed(false);
                }}
              />
            </Field>
            <Button
              variant="outline"
              type="button"
              onClick={() => {
                setWeek(DEFAULT_WEEK.map((w) => (w ? { ...w } : null)));
                setScheduleConfirmed(false);
              }}
            >
              Use Mon–Thu, 10:00–16:00 template
            </Button>
            <div className={css.list}>
              {["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"].map(
                (day, i) => (
                  <div className={css.weekRow} key={day}>
                    <label className={css.check}>
                      <input
                        type="checkbox"
                        checked={!!week[i]}
                        onChange={(e) => {
                          setWeek((old) =>
                            old.map((w, j) =>
                              j === i
                                ? e.target.checked
                                  ? { start: "10:00", end: "16:00" }
                                  : null
                                : w,
                            ),
                          );
                          setScheduleConfirmed(false);
                        }}
                      />
                      {day}
                    </label>
                    <input
                      className={css.input}
                      type="time"
                      aria-label={`${day} start`}
                      disabled={!week[i]}
                      value={week[i]?.start ?? "10:00"}
                      onChange={(e) => updateWeek(i, "start", e.target.value)}
                    />
                    <input
                      className={css.input}
                      type="time"
                      aria-label={`${day} end`}
                      disabled={!week[i]}
                      value={week[i]?.end ?? "16:00"}
                      onChange={(e) => updateWeek(i, "end", e.target.value)}
                    />
                  </div>
                ),
              )}
            </div>
            <label className={css.check}>
              <input
                type="checkbox"
                required
                checked={scheduleConfirmed}
                onChange={(e) => setScheduleConfirmed(e.target.checked)}
              />
              I confirm these are this tutor’s required office hours.
            </label>
            <Field label="Reason for schedule change">
              <input
                className={css.input}
                required
                minLength={3}
                maxLength={1000}
                value={scheduleReason}
                onChange={(e) => setScheduleReason(e.target.value)}
              />
            </Field>
            <Button
              type="submit"
              disabled={busy || !scheduleKey || !scheduleConfirmed}
            >
              Save weekly schedule
            </Button>
          </form>
        </section>
        <section className={css.panel}>
          <h2>3. Dates and exceptions</h2>
          <p className={css.muted}>
            Replace hours, excuse an absence, or close the office. An office
            closure applies to every enrolled tutor.
          </p>
          <form
            className={css.form}
            onSubmit={(e) => {
              e.preventDefault();
              void configSave(
                {
                  action: "exception",
                  canonicalKey: exceptionKey || null,
                  date: exceptionDate,
                  kind,
                  start: kind === "hours" ? exceptionStart : null,
                  end: kind === "hours" ? exceptionEnd : null,
                  reason: exceptionReason,
                },
                "Date exception saved.",
              );
            }}
          >
            <Field label="Applies to">
              <select
                className={css.input}
                value={exceptionKey}
                onChange={(e) => {
                  setExceptionKey(e.target.value);
                  setKind("excused");
                }}
              >
                <option value="">Whole office</option>
                {settings.enrollments.map((e) => (
                  <option value={e.canonicalKey} key={e.canonicalKey}>
                    {name(e.canonicalKey)}
                  </option>
                ))}
              </select>
            </Field>
            <div className={css.formRow}>
              <Field label="Date">
                <input
                  className={css.input}
                  required
                  type="date"
                  value={exceptionDate}
                  onChange={(e) => setExceptionDate(e.target.value)}
                />
              </Field>
              <Field label="Exception">
                <select
                  className={css.input}
                  value={kind}
                  onChange={(e) => setKind(e.target.value)}
                >
                  <option value="excused">
                    {exceptionKey ? "Excused absence" : "Office closed"}
                  </option>
                  {exceptionKey && (
                    <option value="hours">Replacement / extra hours</option>
                  )}
                  <option value="reset">Remove date exception</option>
                </select>
              </Field>
            </div>
            {kind === "hours" && (
              <div className={css.formRow}>
                <Field label="Required start">
                  <input
                    type="time"
                    className={css.input}
                    value={exceptionStart}
                    onChange={(e) => setExceptionStart(e.target.value)}
                  />
                </Field>
                <Field label="Required end">
                  <input
                    type="time"
                    className={css.input}
                    value={exceptionEnd}
                    onChange={(e) => setExceptionEnd(e.target.value)}
                  />
                </Field>
              </div>
            )}
            <Field label="Reason (saved in the audit history)">
              <textarea
                className={css.input}
                required
                minLength={3}
                maxLength={1000}
                rows={2}
                value={exceptionReason}
                onChange={(e) => setExceptionReason(e.target.value)}
              />
            </Field>
            <Button type="submit" disabled={busy}>
              Save date exception
            </Button>
          </form>
          <details className={css.divider}>
            <summary className="cursor-pointer text-sm">
              Exception history ({settings.exceptions.length})
            </summary>
            <div className={`${css.list} mt-3`}>
              {settings.exceptions.map((e) => (
                <p className={css.muted} key={e.id}>
                  {displayDate(e.date)} ·{" "}
                  {e.canonicalKey ? name(e.canonicalKey) : "Whole office"} ·{" "}
                  {e.kind === "hours" ? `${e.start}–${e.end}` : e.kind} ·{" "}
                  {e.reason}
                </p>
              ))}
            </div>
          </details>
        </section>
        <section className={css.panel}>
          <h2>4. Approved office connections</h2>
          <p className={css.muted}>
            Register public office internet addresses. Check office Wi-Fi
            acceptance and mobile-data rejection before launch. A changing
            address must be registered again.
          </p>
          <div className={`${css.banner} mt-4`}>
            Current public address:{" "}
            <strong>
              {settings.detectedAddress ?? "Unavailable outside Vercel"}
            </strong>
          </div>
          <form
            className={css.form}
            onSubmit={(e) => {
              e.preventDefault();
              void configSave(
                {
                  action: "networks",
                  networks,
                  verifiedOfficeConnection: true,
                  reason: networkReason,
                },
                "Approved office connections saved.",
              );
            }}
          >
            {networks.map((n, i) => (
              <div key={i} className={css.networkRow}>
                <Field label={`Connection ${i + 1} name`}>
                  <input
                    className={css.input}
                    value={n.label}
                    required
                    onChange={(e) => {
                      setNetworks((old) =>
                        old.map((v, j) =>
                          j === i ? { ...v, label: e.target.value } : v,
                        ),
                      );
                      setNetworkVerified(false);
                    }}
                  />
                </Field>
                <Field label="Public IP or network prefix">
                  <input
                    className={css.input}
                    value={n.cidr}
                    required
                    onChange={(e) => {
                      setNetworks((old) =>
                        old.map((v, j) =>
                          j === i ? { ...v, cidr: e.target.value } : v,
                        ),
                      );
                      setNetworkVerified(false);
                    }}
                  />
                </Field>
                <Button
                  variant="ghost"
                  type="button"
                  size="sm"
                  aria-label={`Remove connection ${i + 1}`}
                  onClick={() => {
                    setNetworks((old) => old.filter((_, j) => j !== i));
                    setNetworkVerified(false);
                  }}
                >
                  Remove
                </Button>
              </div>
            ))}
            <div className={css.actions}>
              <Button
                type="button"
                variant="outline"
                disabled={networks.length >= 12}
                onClick={() => {
                  setNetworks((old) => [
                    ...old,
                    { label: "Office Wi-Fi", cidr: "" },
                  ]);
                  setNetworkVerified(false);
                }}
              >
                Add connection
              </Button>
              {settings.detectedAddress && (
                <Button
                  type="button"
                  variant="outline"
                  disabled={networks.length >= 12}
                  onClick={() => {
                    setNetworks((old) => [
                      ...old,
                      {
                        label: "Office Wi-Fi",
                        cidr: settings.detectedAddress!,
                      },
                    ]);
                    setNetworkVerified(false);
                  }}
                >
                  Use this connection
                </Button>
              )}
            </div>
            <label className={css.check}>
              <input
                type="checkbox"
                required
                checked={networkVerified}
                onChange={(e) => setNetworkVerified(e.target.checked)}
              />
              I verified that every listed address belongs to our office
              connection.
            </label>
            <Field label="Reason for connection change">
              <input
                className={css.input}
                required
                minLength={3}
                maxLength={1000}
                value={networkReason}
                onChange={(e) => setNetworkReason(e.target.value)}
              />
            </Field>
            <Button type="submit" disabled={busy || !networkVerified}>
              Save approved connections
            </Button>
          </form>
        </section>
      </div>
    </>
  );
}
