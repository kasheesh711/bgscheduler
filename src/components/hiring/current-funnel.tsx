"use client";
import { useEffect, useRef, useState } from "react";
import type { CurrentFunnel, FunnelPerson, FunnelStage } from "@/lib/hiring/current-funnel";
import { Button } from "@/components/ui/button";
import { FunnelChart, SubjectSankey, chartSubjects, stageColors, type ChartMode } from "./funnel-chart";
import layout from "./current-funnel.module.css";
import { phoneView } from "@/lib/hiring/phone";

type Action =
  | "paper_pass"
  | "advance"
  | "invite_onsite"
  | "waive_paper"
  | "cancel_funnel_visit"
  | "follow_up";
type Operation = { p: FunnelPerson; action: Action; ids: string[] };
const labels: Record<Action, string> = {
  paper_pass: "Invite to mock after paper pass",
  advance: "Invite to pre-screen",
  invite_onsite: "Invite to assessment",
  waive_paper: "Waive paper and move to mock",
  cancel_funnel_visit: "Cancel remaining appointments",
  follow_up: "Log call",
};
const day = 86_400_000;
const date = (s: string) => {
  const parts = new Intl.DateTimeFormat("en-GB", {
    timeZone: "Asia/Bangkok",
    day: "numeric",
    month: "short",
    hour: "2-digit",
    minute: "2-digit",
    hourCycle: "h23",
  }).formatToParts(new Date(s));
  const value = (key: string) => parts.find((p) => p.type === key)?.value;
  return [value("day"), value("month")].join(" ") + ", " + value("hour") + ":" + value("minute");
};
const button =
  "min-h-11 rounded-md border px-2.5 py-2 text-sm font-medium hover:bg-muted focus-visible:outline-2 disabled:opacity-50";
const moves = (p: FunnelPerson, full: boolean): Action[] => {
  const actions: Action[] = [];
  if (!p.answered && ["new", "review"].includes(p.rawStage)) actions.push("advance");
  if (p.answered && ["pre_screen", "review", "new"].includes(p.rawStage)) actions.push("invite_onsite");
  if (
    p.paperFinished &&
    p.answered &&
    ["onsite_booked", "paper_booked", "paper_invited"].includes(p.rawStage) &&
    p.stage === "Paper assessment"
  )
    actions.push("paper_pass");
  if (
    full &&
    !p.paperFinished &&
    p.answered &&
    ["pre_screen", "review", "onsite_invited", "onsite_booked", "paper_invited", "paper_booked"].includes(
      p.rawStage,
    )
  )
    actions.push("waive_paper");
  return actions;
};
const destinations: Partial<Record<FunnelStage, Action>> = {
  "Pre-screen": "advance",
  "Paper assessment": "invite_onsite",
  "Mock teaching": "waive_paper",
};
function destination(stage: FunnelStage, person?: FunnelPerson) {
  return stage === "Mock teaching" && person?.paperFinished ? "paper_pass" : destinations[stage];
}
export function CurrentFunnelWorkspace({
  initial,
  fullAccess,
}: {
  initial: CurrentFunnel;
  fullAccess: boolean;
}) {
  const [expanded, setExpanded] = useState(false);
  const [receipt, setReceipt] = useState<string | null>(null);
  const [delivery, setDelivery] = useState("");
  useEffect(() => {
    if (!receipt) return;
    const controller = new AbortController();
    let timer: ReturnType<typeof setTimeout>;
    async function check() {
      try {
        const r = await fetch("/api/hiring/current-funnel?receipt=" + encodeURIComponent(receipt!), {
          cache: "no-store",
          signal: controller.signal,
        });
        if (!r.ok) throw Error();
        const { status } = await r.json();
        setDelivery(status === "pending" ? "queued" : status);
        if (["pending", "processing"].includes(status)) timer = setTimeout(check, 4000);
      } catch {
        if (!controller.signal.aborted) setDelivery("status unavailable");
      }
    }
    void check();
    return () => {
      controller.abort();
      clearTimeout(timer);
    };
  }, [receipt]);
  const [report, setReport] = useState(initial),
    [stage, setStage] = useState<FunnelStage | null>(null),
    [filter, setFilter] = useState("");
  const [subject, setSubject] = useState<string | null>(null);
  const [op, setOp] = useState<Operation | null>(null),
    [reason, setReason] = useState(""),
    [outcome, setOutcome] = useState("Reached"),
    [follow, setFollow] = useState("");
  const [preview, setPreview] = useState<{
      html: string;
      subject: string;
      to: string;
    } | null>(null),
    [busy, setBusy] = useState(false),
    [notice, setNotice] = useState(""),
    [error, setError] = useState("");
  const [openerId, setOpenerId] = useState("");
  const [drag, setDrag] = useState<string | null>(null);
  const dialog = useRef<HTMLDialogElement>(null),
    opener = useRef<HTMLElement | null>(null);
  const now = Date.parse(report.now);
  const [chartMode, setChartMode] = useState<ChartMode>("Sankey");
  const [hovered, setHovered] = useState<FunnelStage | null>(null);
  function moveTo(person: FunnelPerson | undefined, stage: FunnelStage) {
    setDrag(null);
    const action = destination(stage, person);
    if (person && action && moves(person, fullAccess).includes(action)) {
      open(person, action);
      return;
    }
    if (stage === "Final review")
      setNotice("Complete mock teaching and record the head’s recommendation first.");
    else if (stage === "Offer and contract") setNotice("Complete final review and approve the offer first.");
    else if (!person?.answered && ["Paper assessment", "Mock teaching"].includes(stage))
      setNotice("The candidate must complete pre-screen first.");
    else setNotice("This move is unavailable from the candidate’s current stage.");
  }
  function dropCandidate(e: React.DragEvent, stage: FunnelStage) {
    e.preventDefault();
    moveTo(
      report.rows.find((p) => p.id === (e.dataTransfer.getData("text/plain") || drag)),
      stage,
    );
  }
  function selectChart(nextStage: FunnelStage | null, nextSubject?: string) {
    const clear = stage === nextStage && subject === (nextSubject ?? null);
    setStage(clear ? null : nextStage);
    setSubject(clear ? null : (nextSubject ?? null));
  }
  const chartProps = {
    stages: report.stages,
    highlight: hovered ?? stage,
    onHighlight: setHovered,
    onSelect: selectChart,
    onDrop: dropCandidate,
  };
  const rows = report.rows.filter(
    (p) =>
      (!stage || p.stage === stage) &&
      (!subject || chartSubjects(p).includes(subject)) &&
      p.name.toLocaleLowerCase().includes(filter.trim().toLocaleLowerCase()),
  );
  async function refresh() {
    const response = await fetch("/api/hiring/current-funnel", {
      cache: "no-store",
    });
    if (!response.ok) throw Error("Could not refresh the queue.");
    setReport(await response.json());
  }
  function open(p: FunnelPerson, action: Action, ids: string[] = []) {
    opener.current = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    setOpenerId(p.id);
    setOp({
      p,
      action,
      ids:
        action === "waive_paper"
          ? p.bookings.filter((b) => b.kind === "paper" || b.kind === "mock").map((b) => b.id)
          : ids,
    });
    setPreview(null);
    setReason("");
    setOutcome("Reached");
    setFollow("");
    setError("");
    setNotice("");
  }
  useEffect(() => {
    if (!op) return;
    dialog.current?.showModal();
    if (op.action === "follow_up") return;
    const abort = new AbortController();
    void fetch("/api/hiring/current-funnel", {
      method: "POST",
      signal: abort.signal,
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        id: op.p.id,
        revision: op.p.revision,
        action: op.action,
        subjects: op.p.subjects,
        visitBookingIds: op.ids,
        reason: "Preview requested",
        preview: true,
      }),
    })
      .then(async (r) => {
        const result = await r.json();
        if (!r.ok) throw Error(result.error);
        setPreview(result.preview);
      })
      .catch((e) => {
        if (!abort.signal.aborted) setError(e.message);
      });
    return () => abort.abort();
  }, [op]);
  function close() {
    dialog.current?.close();
    setOp(null);
    opener.current?.focus({ preventScroll: true });
  }
  async function submit() {
    if (!op || busy) return;
    setBusy(true);
    setError("");
    try {
      const body =
        op.action === "follow_up"
          ? { outcome, note: reason, followUp: follow || undefined }
          : {
              subjects: op.p.subjects,
              visitBookingIds: op.ids,
              reason,
              preview: false,
              expectedRecipient: preview?.to,
            };
      const r = await fetch("/api/hiring/current-funnel", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          id: op.p.id,
          revision: op.p.revision,
          action: op.action,
          ...body,
        }),
      });
      const res = await r.json();
      if (!r.ok) throw Error(res.error || "Action failed.");
      setReceipt(res.receipt ?? null);
      setDelivery(res.receipt ? "queued" : "");
      setNotice(
        op.p.name +
          " · " +
          (op.action === "follow_up"
            ? "Call logged."
            : op.action === "cancel_funnel_visit"
              ? "Appointments cancelled. Open the candidate record to rebook."
              : "Stage changed."),
      );
      close();
      await refresh();
    } catch (e) {
      setError(e instanceof Error ? e.message : "Action failed.");
    } finally {
      setBusy(false);
    }
  }
  return (
    <>
      <header className={layout.top}>
        <div>
          <h1>Hiring funnel</h1>
          <p>
            {report.rows.length} active candidates · Updated {date(report.now)} Bangkok
          </p>
        </div>
        <button className={button} onClick={() => void refresh().catch((e) => setError(e.message))}>
          Refresh
        </button>
      </header>
      <div className={layout.split}>
        <section className={layout.panel} data-expanded={expanded} aria-label="Current hiring funnel">
          <div className={layout.panelTitle}>
            <h2>{chartMode === "Sankey" ? "Subjects by stage" : "Candidates by stage"}</h2>
            <div className={layout.modeBar} aria-label="Chart view">
              {(["Sankey", "Funnel"] as const).map((mode) => (
                <Button
                  key={mode}
                  size="sm"
                  variant={chartMode === mode ? "secondary" : "ghost"}
                  aria-pressed={chartMode === mode}
                  onClick={() => {
                    setChartMode(mode);
                    if (mode === "Funnel") setSubject(null);
                    setHovered(null);
                  }}
                >
                  {mode}
                </Button>
              ))}
            </div>
          </div>
          {chartMode === "Funnel" ? (
            <FunnelChart {...chartProps} />
          ) : (
            <SubjectSankey {...chartProps} rows={report.rows} subject={subject} />
          )}
          <button
            type="button"
            className={layout.toggle}
            aria-expanded={expanded}
            onClick={() => setExpanded(!expanded)}
          >
            <span>Stage averages</span>
            <span aria-hidden="true">{expanded ? "−" : "+"}</span>
          </button>
          {expanded && (
            <div className={layout.stageStats}>
              <div className={layout.headings} aria-hidden="true">
                <span>Stage · active candidates</span>
                <span>Avg. wait</span>
                <span>Avg. stay</span>
              </div>
              {report.stages.map((s, i) => {
                const person = report.rows.find((p) => p.id === drag);
                const action = destination(s.stage, person);
                const eligible = !!(person && action && moves(person, fullAccess).includes(action));
                return (
                  <button
                    key={s.stage}
                    className={layout.bandRow}
                    data-selected={(hovered ?? stage) === s.stage}
                    onMouseEnter={() => setHovered(s.stage)}
                    onMouseLeave={() => setHovered(null)}
                    onFocus={() => setHovered(s.stage)}
                    onBlur={() => setHovered(null)}
                    data-drop-stage={s.stage}
                    data-eligible={eligible}
                    aria-pressed={stage === s.stage}
                    onClick={() => selectChart(s.stage)}
                    onDragOver={(e) => {
                      e.preventDefault();
                      e.dataTransfer.dropEffect = eligible ? "move" : "none";
                    }}
                    onDrop={(e) => dropCandidate(e, s.stage)}
                  >
                    <span className={layout.stageName}>
                      <i style={{ backgroundColor: stageColors[i] }} />
                      {s.stage} <b>{s.count}</b>
                    </span>
                    {(
                      [
                        ["Current wait", s.current, s.dated],
                        ["Completed stay", s.history, s.completed],
                      ] as const
                    ).map(([label, value, n]) => (
                      <span className={layout.metric} key={label}>
                        <span className={layout.mobileLabel}>{label} </span>
                        <strong>{value === null ? "—" : value.toFixed(1) + " d"}</strong>
                        <small>{n} dated</small>
                      </span>
                    ))}
                  </button>
                );
              })}
            </div>
          )}
          <footer className={layout.caption}>
            {chartMode === "Funnel"
              ? "Funnel area shows each stage’s share of active candidates."
              : "Select a subject or ribbon to see its candidates. Each person contributes one unit of width, split equally across their subjects. Labels count people."}{" "}
            Avg. stay includes exits in the past 12 weeks.
          </footer>
        </section>
        {drag && (
          <aside className={layout.dock} aria-label="Move candidate">
            {report.stages
              .filter((s) => {
                const p = report.rows.find((r) => r.id === drag);
                const a = destination(s.stage, p);
                return p && a && moves(p, fullAccess).includes(a);
              })
              .map((s) => (
                <button
                  key={s.stage}
                  data-drop-stage={s.stage}
                  className={button}
                  onDragOver={(e) => e.preventDefault()}
                  onDrop={(e) => {
                    e.preventDefault();
                    const p = report.rows.find((r) => r.id === drag);
                    setDrag(null);
                    const a = destination(s.stage, p);
                    if (p && a) open(p, a);
                  }}
                >
                  Move to {s.stage}
                </button>
              ))}
          </aside>
        )}
        <section className={layout.queue} aria-label="Candidate queue">
          <div className={layout.queueTop}>
            <h2 className="text-xl font-semibold">
              {[subject, stage].filter(Boolean).join(" · ") || "Candidates"}{" "}
              <span className={layout.count}>{rows.length}</span>
            </h2>
            {(stage || subject) && (
              <button
                className={button}
                onClick={() => {
                  setStage(null);
                  setSubject(null);
                }}
              >
                {subject ? "Clear filters" : "All stages"}
              </button>
            )}
            <input
              aria-label="Find candidate"
              placeholder="Find candidate"
              className={layout.search}
              value={filter}
              onChange={(e) => setFilter(e.target.value)}
            />
          </div>
          <p className={layout.queueCaption}>Longest wait first</p>
          <div role="status">
            {notice} {notice && delivery && "Email · " + delivery}
            {notice.includes("to rebook") && openerId && (
              <a className="ml-2 underline" href={"/hiring?view=overview&candidate=" + openerId}>
                Open record
              </a>
            )}
          </div>
          {error && !op && <p role="alert">{error}</p>}
          <ul className={layout.list} tabIndex={0} aria-label="Candidates ordered by time in stage">
            {rows.map((p) => {
              const phone = p.phone && phoneView(p.phone),
                actions = moves(p, fullAccess),
                appointments = p.bookings.filter((b) => b.kind === "paper" || b.kind === "mock");
              const visits = appointments.filter(
                (b, i) => appointments.findIndex((x) => (x.visitId ?? x.id) === (b.visitId ?? b.id)) === i,
              );
              return (
                <li
                  key={p.id}
                  className={layout.candidate}
                  draggable={actions.length > 0}
                  onDragStart={(e) => {
                    e.dataTransfer.setData("text/plain", p.id);
                    e.dataTransfer.effectAllowed = "move";
                    setDrag(p.id);
                  }}
                  onDragEnd={() => setDrag(null)}
                >
                  <div>
                    {actions.length > 0 && (
                      <span
                        className={layout.grip}
                        aria-label={"Drag " + p.name}
                        title={"Drag " + p.name + " to a stage"}
                        onPointerDown={(e) => {
                          if (e.button !== 0) return;
                          e.preventDefault();
                          e.currentTarget.setPointerCapture(e.pointerId);
                          setDrag(p.id);
                        }}
                        onPointerUp={(e) => {
                          if (!e.currentTarget.hasPointerCapture(e.pointerId)) return;
                          e.currentTarget.releasePointerCapture(e.pointerId);
                          const target = document
                            .elementFromPoint(e.clientX, e.clientY)
                            ?.closest("[data-drop-stage]")
                            ?.getAttribute("data-drop-stage");
                          if (target) moveTo(p, target as FunnelStage);
                          else setDrag(null);
                        }}
                        onPointerCancel={() => setDrag(null)}
                        onDragStart={(e) => {
                          e.preventDefault();
                          e.stopPropagation();
                        }}
                      >
                        ⠿
                      </span>
                    )}
                    <a
                      draggable={false}
                      href={"/hiring?view=overview&candidate=" + p.id}
                      target="_blank"
                      rel="noreferrer"
                      className={layout.candidateName}
                    >
                      {p.name}
                    </a>
                    <p className="text-sm">
                      {chartSubjects(p).join(", ")} · {p.stage}
                    </p>
                    <p>
                      <strong>
                        {p.since
                          ? ((now - Date.parse(p.since)) / day).toFixed(1) + " days"
                          : "Start date unknown"}
                      </strong>
                      {p.since && " · since " + date(p.since)}
                    </p>
                  </div>
                  <div className="text-sm">
                    <strong>{p.next}</strong>
                    <p>
                      {p.contact
                        ? p.contact.label +
                          " · " +
                          date(p.contact.at) +
                          " · " +
                          ((now - Date.parse(p.contact.at)) / day).toFixed(1) +
                          " days ago"
                        : "No recorded contact"}
                    </p>
                    {p.history?.length > 1 && (
                      <details>
                        <summary>Contact history ({p.history.length})</summary>
                        {p.history.map((h, i) => (
                          <p key={i}>
                            {date(h.at)} · {h.label}
                            {h.note && " · " + h.note}
                            {h.followUp && " · Follow up " + h.followUp}
                          </p>
                        ))}
                      </details>
                    )}
                    {p.contact?.note && <p>{p.contact.note}</p>}
                    {p.contact?.followUp && <p>Follow up {p.contact.followUp}</p>}
                    {p.emailStatus && <p>Email · {p.emailStatus}</p>}
                    {p.bookings[0] && (
                      <p>
                        Next {p.bookings[0].kind} · {date(p.bookings[0].start)}
                      </p>
                    )}
                  </div>
                  <div className={layout.actions}>
                    {p.resume ? (
                      <a
                        className={button}
                        target="_blank"
                        rel="noreferrer"
                        href={"/api/hiring/resume/" + p.id}
                      >
                        Résumé
                      </a>
                    ) : (
                      <span className="text-xs">Résumé unavailable</span>
                    )}
                    {phone ? (
                      <a className={button} href={phone.href} title={phone.display}>
                        Call<span className="sr-only"> {phone.display}</span>
                      </a>
                    ) : (
                      <span className="text-xs">Phone unavailable</span>
                    )}
                    <button className={button} onClick={() => open(p, "follow_up")}>
                      Log call
                    </button>
                    {actions.length > 0 && (
                      <select
                        className={button}
                        aria-label={"Move forward · " + p.name}
                        value=""
                        onChange={(e) => open(p, e.target.value as Action)}
                      >
                        <option value="" disabled>
                          Move forward
                        </option>
                        {actions.map((a) => (
                          <option key={a} value={a}>
                            {labels[a]}
                          </option>
                        ))}
                      </select>
                    )}
                    {visits.map((v) => (
                      <button
                        className={button}
                        key={v.id}
                        onClick={() =>
                          open(
                            p,
                            "cancel_funnel_visit",
                            appointments
                              .filter((b) => (b.visitId ?? b.id) === (v.visitId ?? v.id))
                              .map((b) => b.id),
                          )
                        }
                      >
                        Cancel visit
                        {visits.length > 1 ? " · " + date(v.start) : ""}
                      </button>
                    ))}
                  </div>
                </li>
              );
            })}
          </ul>
          {!rows.length && <p>No candidates match this selection.</p>}
        </section>
      </div>
      <dialog
        ref={dialog}
        className="m-auto w-[min(95vw,42rem)] max-h-[90vh] overflow-auto rounded-xl border bg-background p-5 backdrop:bg-black/40"
        onCancel={(e) => {
          if (busy) e.preventDefault();
          else close();
        }}
      >
        {op && (
          <form
            className="grid gap-3"
            onSubmit={(e) => {
              e.preventDefault();
              void submit();
            }}
          >
            <h2 className="text-xl font-semibold">
              {labels[op.action]} · {op.p.name}
            </h2>
            {op.action === "follow_up" ? (
              <>
                <label>
                  Call outcome{" "}
                  <select className={button} value={outcome} onChange={(e) => setOutcome(e.target.value)}>
                    {["Reached", "No answer", "Call back"].map((s) => (
                      <option key={s}>{s}</option>
                    ))}
                  </select>
                </label>
                <label>
                  Follow-up date{" "}
                  <input
                    className={button}
                    type="date"
                    value={follow}
                    onChange={(e) => setFollow(e.target.value)}
                  />
                </label>
              </>
            ) : (
              <>
                <p>From admin@begiftededucation.com · To {preview?.to ?? op.p.email}</p>
                {op.p.bookings
                  .filter((b) => op.ids.includes(b.id))
                  .map((b) => (
                    <p key={b.id}>
                      {op.action === "waive_paper" && b.kind === "mock" ? "Keep" : "Cancel"} {b.kind} ·{" "}
                      {date(b.start)} Bangkok
                    </p>
                  ))}
                {preview ? (
                  <>
                    <p>
                      <strong>{preview.subject}</strong>
                    </p>
                    <iframe
                      title="Candidate email preview"
                      sandbox=""
                      className="h-52 w-full rounded border"
                      srcDoc={preview.html}
                    />
                  </>
                ) : (
                  !error && <p role="status">Checking the move and preparing the email…</p>
                )}
              </>
            )}
            <label>
              {op.action === "follow_up" ? "Call note" : "Reason"}
              <textarea
                className="mt-1 block w-full rounded border p-2"
                maxLength={op.action === "follow_up" ? 1000 : 2000}
                value={reason}
                onChange={(e) => setReason(e.target.value)}
              />
            </label>
            {error && (
              <p role="alert" className="text-destructive">
                {error}
              </p>
            )}
            <div className="flex gap-2">
              <button className={button} type="button" disabled={busy} onClick={close}>
                Close
              </button>
              <button
                className={button + " bg-primary text-primary-foreground"}
                disabled={busy || (op.action !== "follow_up" && (!preview || reason.trim().length < 5))}
              >
                {busy ? "Saving…" : op.action === "follow_up" ? "Save call" : "Confirm and email"}
              </button>
            </div>
          </form>
        )}
      </dialog>
    </>
  );
}
