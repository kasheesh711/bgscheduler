"use client";

import Link from "next/link";
import { formatInTimeZone } from "date-fns-tz";
import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import { ANSWER_LABELS, isDecided, ZONE } from "@/lib/hiring/model";
import { preScreenQueue, sentBetween } from "@/lib/hiring/prescreen-view";
import { workRightsText } from "@/lib/hiring/seek-view";
import { holdNote, preScreenNote, type CandidateExtras } from "@/lib/hiring/status";
import { AnswerText } from "./answer-text";
import { AssessmentBlock, ONSITE_STAGES, ProfileScoreBreakdown, ResumePeek } from "./candidate-inspector";
import type { Command, HiringData } from "./dashboard";
import { useMinute } from "./use-minute";
import css from "./dashboard.module.css";
import p from "./prescreen-screen.module.css";

const round = (n: number) => Math.round(n * 10) / 10;
const FILTERS = [
  ["decision", "Needs decision"], ["waiting", "Waiting"], ["overdue", "Waiting 3+ days"],
  ["invited", "Invited/booked"], ["aside", "Set aside"], ["held", "Held"], ["stopped", "Stopped"], ["all", "All"],
] as const;
type Filter = (typeof FILTERS)[number][0];
const EMPTY: Record<Filter, string> = {
  decision: "No replies need a decision.",
  overdue: "No replies overdue.",
  waiting: "No replies pending.",
  aside: "No candidates set aside.",
  invited: "No invitations or bookings.",
  held: "No candidates held.",
  stopped: "No candidates stopped.",
  all: "No forms sent.",
};
const RESULTS = {
  invite_onsite: "Visit invite queued",
  send_new_link: "New link queued",
  stop: "Stopped",
  pre_screen_score: "Score changed",
};
type Action = "bring_back" | keyof typeof RESULTS;
type ActionStatus = { message: string; resetEdit?: boolean };
const REVISION_CONFLICT = "This candidate changed. Refresh the page.";

function queueFor(data: HiringData, now: Date) {
  const jobs = new Map<string, HiringData["inviteOutbox"]>();
  for (const job of data.inviteOutbox) {
    if (!job.candidateId) continue;
    const rows = jobs.get(job.candidateId);
    if (rows) rows.push(job);
    else jobs.set(job.candidateId, [job]);
  }
  const booked = new Set(data.bookings.filter((booking) => booking.status === "confirmed").map((booking) => booking.candidateId));
  return preScreenQueue(data.candidates.map((candidate) => ({
    candidate, outbox: jobs.get(candidate.id) ?? [], booked: booked.has(candidate.id),
  })), now, data.config.preScreenThreshold, data.holds);
}
type QueueRow = ReturnType<typeof queueFor>["all"][number];

function PreScreenPanel({
  row, extra, data, busy, error, status, refreshLabel, onAction, onRefresh, onClose, onOpenEmailLog,
}: {
  row: QueueRow;
  extra?: CandidateExtras;
  data: HiringData;
  busy: boolean;
  error: string;
  status: ActionStatus | null;
  refreshLabel: string | null;
  onAction: (action: Action, label: string, reason: string, score: number) => Promise<void>;
  onRefresh: () => Promise<boolean | "failed">;
  onClose: () => void;
  onOpenEmailLog: (key: string) => void;
}) {
  const dialog = useRef<HTMLDialogElement>(null);
  const body = useRef<HTMLDivElement>(null);
  const footer = useRef<HTMLElement>(null);
  const heading = useRef<HTMLHeadingElement>(null);
  const actionButton = useRef<HTMLButtonElement>(null);
  const refreshButton = useRef<HTMLButtonElement>(null);
  const [reason, setReason] = useState("");
  const [score, setScore] = useState("");
  const [announcement, setAnnouncement] = useState("");
  const [refreshFailed, setRefreshFailed] = useState(false);
  const { candidate, email, form } = row;
  const formFailed = form?.status === "failed";
  const waiting = row.group === "waiting";
  const bookedWithoutReply = row.group === "invited" && row.booked && !candidate.preScreen && !candidate.preScreenRepliedAt;
  const formNote = extra && preScreenNote({
    ...extra.pre,
    sentAt: form?.status === "sent" && form.sentAt ? new Date(form.sentAt) : null,
    remindedAt: waiting ? null : extra.pre.remindedAt,
  }, true);
  let visitLabel = "Visit email";
  let visitValue = row.hasVisitEmail ? email.label : "Not sent";
  if (bookedWithoutReply && !row.hasVisitEmail) {
    const visit = extra?.visit ?? data.bookings.find((booking) => booking.candidateId === candidate.id && booking.status === "confirmed");
    visitLabel = "Visit";
    visitValue = visit ? `Booked ${formatInTimeZone(new Date(visit.startTime), ZONE, "d MMM, HH:mm")}` : "Booked";
  }
  let currentStatus = row.fact;
  if (row.group === "invited" && (email.tone === "bad" || row.fact === "Invite queued")) {
    currentStatus = candidate.stage === "no_booking" ? "No booking" : row.booked ? "Visit booked" : "Invited";
  }
  const { config } = data;
  const goodCall = candidate.callReview?.good;
  const hold = row.group === "held" ? holdNote(candidate, data.holds[candidate.id], config) : null;
  const activeVisit = data.bookings.some((booking) => booking.candidateId === candidate.id
    && booking.status === "confirmed" && new Date(booking.endTime) > new Date());
  const hasReason = reason.trim().length >= 5;
  const scoreValue = Number(score);
  const scoreValid = score.trim() !== "" && scoreValue >= 0 && scoreValue <= 100;
  const scoreError = !row.pendingVisitEmail && score !== "" && !scoreValid;
  const buttons: { action: Action; label: string; allowed: boolean }[] = [
    { action: "bring_back", label: "Bring back", allowed: row.group === "aside" },
    { action: "invite_onsite", label: row.below ? "Invite anyway" : "Invite to visit",
      allowed: !!candidate.preScreen && !!candidate.preScreenAssessment && row.group !== "invited" && row.group !== "held" && ONSITE_STAGES.includes(candidate.stage)
        && (candidate.stage !== "stopped" || (row.canInviteAfterStop && !!candidate.email && !activeVisit)) },
    { action: "send_new_link", label: "Resend link", allowed: candidate.stage === "no_booking" || (candidate.stage === "onsite_invited" && config.deliveryEnabled) },
    { action: "pre_screen_score", label: "Change score", allowed: !!candidate.preScreen && !!candidate.preScreenAssessment },
    { action: "stop", label: "Stop", allowed: !activeVisit && !isDecided(candidate.stage) && candidate.stage !== "stopped" },
  ];
  const actions = buttons.filter((button) => button.allowed);
  const canScore = actions.some(({ action }) => action === "pre_screen_score");
  useEffect(() => {
    if (!status) return;
    const frame = window.requestAnimationFrame(() => {
      setAnnouncement(status.message);
      if (status.resetEdit) {
        setReason("");
        setScore("");
        heading.current?.focus();
      }
    });
    return () => window.cancelAnimationFrame(frame);
  }, [status]);
  const revealFocus = useCallback(() => {
    const scroll = body.current;
    const focused = document.activeElement;
    const actionBar = footer.current;
    if (!scroll || !focused || !scroll.contains(focused) || actionBar?.contains(focused)) return;
    const bounds = scroll.getBoundingClientRect();
    const box = focused.getBoundingClientRect();
    const bottom = actionBar && getComputedStyle(actionBar).position === "sticky"
      ? Math.min(bounds.bottom, actionBar.getBoundingClientRect().top) : bounds.bottom;
    const ring = 4; // The 2 px outline has a 2 px offset.
    if (box.bottom + ring > bottom) scroll.scrollTop += Math.ceil(box.bottom + ring - bottom);
    else if (box.top - ring < bounds.top) scroll.scrollTop -= Math.ceil(bounds.top - box.top + ring);
  }, []);
  useLayoutEffect(() => {
    const sheet = dialog.current!;
    sheet.showModal();
    heading.current?.focus();
    const viewport = window.visualViewport;
    let frame = 0;
    function fitSheet() {
      if (viewport && window.innerWidth < 720) {
        sheet.style.setProperty("--sheet-height", `${viewport.height}px`);
        sheet.style.setProperty("--sheet-top", `${viewport.offsetTop}px`);
      }
      window.cancelAnimationFrame(frame);
      frame = window.requestAnimationFrame(revealFocus);
    }
    window.addEventListener("resize", fitSheet);
    viewport?.addEventListener("resize", fitSheet);
    viewport?.addEventListener("scroll", fitSheet);
    fitSheet();
    return () => {
      window.cancelAnimationFrame(frame);
      window.removeEventListener("resize", fitSheet);
      viewport?.removeEventListener("resize", fitSheet);
      viewport?.removeEventListener("scroll", fitSheet);
      sheet.close();
    };
  }, [revealFocus]);
  useLayoutEffect(() => {
    if (busy) return;
    if (refreshLabel) refreshButton.current?.focus();
    else if (error) actionButton.current?.focus();
  }, [busy, error, refreshLabel]);

  return (
    <dialog ref={dialog} className={p.sheet} aria-labelledby="prescreen-name" onCancel={(event) => {
      event.preventDefault();
      onClose();
    }}>
      <header className={css.inspectorHead}>
        <div>
          <h2 ref={heading} id="prescreen-name" tabIndex={-1} className={css.inspectorName}>{candidate.name}</h2>
          <p className={p.note}>{candidate.subjects.join(", ") || "Subject missing"}</p>
        </div>
        <button type="button" className={p.control} onClick={onClose}>Close</button>
      </header>
      <div ref={body} className={p.body}>
        <div className={p.content} onFocus={() => window.requestAnimationFrame(revealFocus)}>
          <p role="status" className={p.status}>{announcement}</p>
          <p className={p.summary}>
            <strong>{row.score === null ? "Not scored" : `${round(row.score)}/100`}</strong>
            {config.preScreenThreshold !== null && <span className={p.note}>Pass score {config.preScreenThreshold}</span>}
          </p>
          {candidate.preScreenOverride && <p className={p.note}>
            {candidate.preScreenScore === null
              ? <>Staff set the score to {round(candidate.preScreenOverride.score)}.<br /></>
              : <>{candidate.preScreenOverride.by} changed the AI score of {candidate.preScreenScore}. </>}
            {candidate.preScreenOverride.reason}
          </p>}
          {candidate.preScreen && candidate.preScreenHash && !candidate.preScreenAssessment &&
            <p className={p.note}>AI could not score this reply.</p>}
          <dl className={css.facts}>
            <div><dt>Current status</dt><dd>{currentStatus}</dd></div>
            <div><dt>Email</dt><dd>{candidate.email ?? "Email missing"}</dd></div>
            <div><dt>{visitLabel}</dt><dd>{visitValue}</dd></div>
            {(bookedWithoutReply || extra) && <div><dt>Form</dt><dd>
              {bookedWithoutReply ? "Awaiting reply" : formFailed ? "Failed" : formNote || extra?.pre.status}
            </dd></div>}
            {row.group !== "closed" && extra?.visitFacts.map(([label, value]) => <div key={label}><dt>{label}</dt><dd>{value}</dd></div>)}
          </dl>
          {hold?.long.map((line) => <p key={line} className={p.note}>{line}</p>)}
          {row.emailLogKey && <Link href="?view=setup#messages" className={p.control} onClick={(event) => {
            if (event.metaKey || event.ctrlKey || event.shiftKey || event.altKey) return;
            event.preventDefault();
            onOpenEmailLog(row.emailLogKey!);
          }}>Open email log</Link>}
          {actions.length > 0 && <div className={p.fields}>
            <div className={p.field}>
              <label htmlFor="prescreen-reason">Reason</label>
              <textarea id="prescreen-reason" rows={2} value={reason} maxLength={2000} aria-describedby={!hasReason ? "prescreen-reason-help" : undefined}
                onChange={(event) => setReason(event.target.value)} />
            </div>
            {!hasReason && <p className={p.note} id="prescreen-reason-help">Add a reason (5+ characters).</p>}
            {canScore && <label className={p.field}>
              New score
              <input type="number" min={0} max={100} value={score} disabled={row.pendingVisitEmail}
                aria-invalid={scoreError || undefined}
                aria-describedby={row.pendingVisitEmail ? "prescreen-score-lock" : scoreError ? "prescreen-score-error" : undefined}
                onChange={(event) => setScore(event.target.value)} />
            </label>}
            {canScore && row.pendingVisitEmail && <p id="prescreen-score-lock" className={p.note}>Score changes are locked.</p>}
            {canScore && scoreError && <p id="prescreen-score-error" role="alert" className={p.failure}>Enter a score from 0 to 100.</p>}
          </div>}
          {candidate.preScreen && <section className={p.evidence}>
            <h3>Form answers</h3>
            <dl className={css.answers}>
              {ANSWER_LABELS.map(([key, label]) => <div key={key}>
                <dt>{label}</dt>
                <dd>{candidate.preScreen?.[key] ? <AnswerText text={candidate.preScreen[key]!} /> : "No answer"}</dd>
              </div>)}
            </dl>
          </section>}
          <section className={p.evidence}>
            <h3>Résumé</h3>
            <ResumePeek candidate={candidate} months={config.resumeRetentionMonths} />
          </section>
          {candidate.preScreenAssessment && <details className={p.evidence}>
            <summary>Form score details</summary>
            <AssessmentBlock title="AI assessment" score={candidate.preScreenScore} assessment={candidate.preScreenAssessment}
              weights={config.preScreenWeights} points={candidate.preScreenParts ?? undefined} />
          </details>}
          <details className={p.evidence}>
            <summary>SEEK score details</summary>
            {!candidate.profileAssessment && <p className={p.note}>Not scored</p>}
            <ProfileScoreBreakdown candidate={candidate} weights={config.profileWeights} />
            <dl className={css.facts}>
              <div><dt>Profile minimum</dt><dd>{config.profileThreshold}/100</dd></div>
              <div><dt>HR call minimum</dt><dd>{config.callThreshold === null ? "Calls off" : `${config.callThreshold}/100`}</dd></div>
              <div><dt>Work rights</dt><dd>{workRightsText(candidate)}{candidate.workRightsAnswer && (candidate.workRightsAccepted ? " · Accepted" : " · Not accepted")}</dd></div>
              {goodCall && <div><dt>HR call</dt><dd>{goodCall.manual ? "Manual pre-screen invitation" : "Good call recorded"}</dd></div>}
            </dl>
          </details>
        </div>
        {(actions.length > 0 || error) && <footer ref={footer} className={p.footer}>
          {error && <p role="alert" className={p.failure}>
            {refreshFailed && refreshLabel === "Refresh" ? "Could not refresh. Try again." : error}
          </p>}
          <div className={p.actions}>
            {refreshLabel ? <button ref={refreshButton} type="button" className={p.control} data-primary disabled={busy} onClick={async () => {
              const result = await onRefresh();
              setRefreshFailed(result === "failed");
              if (result === true) heading.current?.focus();
            }}>{refreshLabel}</button>
              : actions.map(({ action, label }, index) => <button key={action} type="button" className={p.control}
                data-primary={index === 0 ? "" : undefined}
                disabled={busy || !hasReason || (action === "pre_screen_score" && (!scoreValid || row.pendingVisitEmail))}
                onClick={(event) => {
                  actionButton.current = event.currentTarget;
                  setAnnouncement("");
                  void onAction(action, label, reason, scoreValue);
                }}>{label}</button>)}
          </div>
        </footer>}
      </div>
    </dialog>
  );
}

export function PreScreenScreen({ data, extras, command, busy, reload, onOpenEmailLog, onOpenOverview }: {
  data: HiringData;
  extras: Map<string, CandidateExtras>;
  command: Command;
  busy: boolean;
  reload: () => Promise<HiringData>;
  onOpenEmailLog: (key: string) => void;
  onOpenOverview: () => void;
}) {
  const [filter, setFilter] = useState<Filter>("decision");
  const [query, setQuery] = useState("");
  const [sentFrom, setSentFrom] = useState("");
  const [sentTo, setSentTo] = useState("");
  const [selected, setSelected] = useState<string | null>(null);
  const [status, setStatus] = useState<ActionStatus | null>(null);
  const [saved, setSaved] = useState<{ id: string; action: Action; message: string; fromDecision: boolean } | null>(null);
  const [retrying, setRetrying] = useState(false);
  const [actionError, setActionError] = useState("");
  const [conflicts, setConflicts] = useState(new Map<string, number>());
  const currentFilter = useRef<Filter>(filter);
  const section = useRef<HTMLElement>(null);
  const search = useRef<HTMLInputElement>(null);
  const refreshListButton = useRef<HTMLButtonElement>(null);
  const focusAfterClose = useRef<string | null>(null);
  const minute = useMinute();
  const queue = useMemo(() => {
    void minute;
    return queueFor(data, new Date());
  }, [data, minute]);
  const overdue = queue.waiting.filter((row) => row.overdue);
  const groups = { ...queue, overdue };
  const needle = query.trim().toLowerCase();
  const filtered = Boolean(needle || sentFrom || sentTo);
  const invalidRange = Boolean(sentFrom && sentTo && sentFrom > sentTo);
  const rows = groups[filter].filter(({ candidate, email }) =>
    sentBetween(email, sentFrom, sentTo) && `${candidate.name} ${candidate.email ?? ""}`.toLowerCase().includes(needle));
  const open = queue.all.find((row) => row.candidate.id === selected);
  const conflictRevision = open && conflicts.get(open.candidate.id);
  const conflict = open && conflictRevision !== undefined && open.candidate.revision <= conflictRevision;

  useLayoutEffect(() => {
    if (selected) return;
    if (saved) {
      if (!retrying) refreshListButton.current?.focus();
      return;
    }
    if (focusAfterClose.current === null) return;
    const id = focusAfterClose.current;
    focusAfterClose.current = null;
    const sectionNode = section.current;
    (sectionNode?.querySelector<HTMLButtonElement>(`[data-review-id="${CSS.escape(id)}"]`)
      ?? sectionNode?.querySelector<HTMLElement>("[data-queue-empty]")
      ?? sectionNode)?.focus();
  }, [selected, saved, retrying]);

  function finishAction(latest: HiringData, result: NonNullable<typeof saved>) {
    setSaved(null);
    setActionError("");
    if (!result.fromDecision || currentFilter.current !== "decision") {
      setStatus({ message: result.message, resetEdit: true });
      return;
    }
    const current = queue.decision.findIndex(({ candidate }) => candidate.id === result.id);
    const remaining = queueFor(latest, new Date()).decision;
    if (result.action === "pre_screen_score" && remaining.some(({ candidate }) => candidate.id === result.id)) {
      setStatus({ message: result.message + " Decision still needed.", resetEdit: true });
      return;
    }
    const later = new Set(queue.decision.slice(current + 1).map(({ candidate }) => candidate.id));
    const next = remaining.find(({ candidate }) => candidate.id !== result.id && later.has(candidate.id))
      ?? remaining.find(({ candidate }) => candidate.id !== result.id)
      ?? remaining[0];
    setQuery("");
    setSentFrom("");
    setSentTo("");
    setStatus({
      message: next ? `${result.message} Next: ${next.candidate.name}.` : result.message,
      resetEdit: next?.candidate.id === result.id,
    });
    focusAfterClose.current = next ? null : "";
    setSelected(next?.candidate.id ?? null);
  }

  const noForms = !queue.all.length;
  const empty = invalidRange ? "End date must be on or after start date."
    : filtered ? "No match." : noForms ? EMPTY.all : EMPTY[filter];

  return (
    <section id="prescreen-queue" className={p.screen} ref={section} tabIndex={-1} aria-label="Pre-screen responses">
      <div className={p.filters} role="group" aria-label="Filter pre-screen responses">
        {FILTERS.filter(([key]) => key === filter || (key !== "held" && key !== "stopped") || groups[key].length > 0)
          .map(([key, name]) => <button key={key} type="button" className={p.control}
            aria-pressed={key === filter}
            onClick={() => {
              if (key === filter) return;
              currentFilter.current = key;
              setFilter(key);
              setStatus(null);
            }}>{name}{key === "decision" && ` (${queue.decision.length})`}</button>)}
      </div>
      <div className={p.tools}>
        <input ref={search} type="search" aria-label="Search pre-screen responses" placeholder="Search name or email" value={query}
          onChange={(event) => setQuery(event.target.value)} />
        <details className={p.more}>
          <summary className={p.control}>More filters{(sentFrom || sentTo) && " •"}</summary>
          <div className={p.dates}>
            <label className={p.field}>Visit email sent from
              <input type="date" value={sentFrom} onChange={(event) => setSentFrom(event.target.value)} />
            </label>
            <label className={p.field}>Visit email sent to
              <input type="date" value={sentTo} aria-invalid={invalidRange || undefined}
                aria-describedby={invalidRange ? "prescreen-date-error" : undefined} onChange={(event) => setSentTo(event.target.value)} />
            </label>
            {(sentFrom || sentTo) && <button type="button" className={p.control} onClick={() => {
              setSentFrom("");
              setSentTo("");
            }}>Clear dates</button>}
          </div>
        </details>
      </div>
      <p role="status" className="sr-only">
        <span key={`${filter}:${needle}:${sentFrom}:${sentTo}`}>{rows.length} {rows.length === 1 ? "result" : "results"}</span>
      </p>
      <p role="status" aria-live={open ? "off" : "polite"} className={p.status}>{!open && status?.message}</p>
      {!open && saved && <div className={p.tools}>
        <p role="alert" className={p.failure}>Saved. Could not refresh the list.</p>
        <button ref={refreshListButton} type="button" className={p.control} data-primary disabled={retrying}
          onClick={() => void refresh()}>Refresh list</button>
      </div>}
      {rows.length ? <table className={p.table} role="table" aria-label="Pre-screen candidates">
        <thead className={p.tableHead}>
          <tr><th scope="col">Candidate</th><th scope="col">Score</th><th scope="col">Status</th><th scope="col"><span className="sr-only">Action</span></th></tr>
        </thead>
        <tbody role="rowgroup">
          {rows.map(({ candidate, score, fact, overdue, group, emailLogKey, replyDays }) => <tr className={p.row} key={candidate.id} role="row">
            <th scope="row" role="rowheader" className={p.person}>
              <span className={p.name}>{candidate.name}</span>
              <span className={p.note}>{candidate.subjects.join(", ") || "Subject missing"}</span>
            </th>
            <td role="cell" className={p.score}>
              {score === null ? <span className={p.note}>Not scored</span> : <span>{round(score)}<span className="sr-only"> out of 100</span></span>}
              {candidate.preScreenOverride && <span className={p.changed}>Changed</span>}
            </td>
            <td role="cell" className={p.fact} data-urgent={(group === "waiting" && overdue) || emailLogKey ? "" : undefined}>
              {fact !== "Below pass score" ? fact
                : group === "aside" ? "Set aside"
                  : filter === "all" ? "Below pass score · in review"
                    : replyDays === null ? fact
                      : replyDays === 0 ? "Below pass · replied today"
                        : `Below pass · replied ${replyDays} ${replyDays === 1 ? "day" : "days"} ago`}
            </td>
            <td role="cell" className={p.review}><button className={p.control} data-primary type="button"
              data-review-id={candidate.id} aria-label={`Review ${candidate.name}`} disabled={!!saved}
              onClick={() => { setSelected(candidate.id); setStatus(null); setActionError(""); }}>Review</button></td>
          </tr>)}
        </tbody>
      </table> : <div className={p.empty}>
        {invalidRange ? <p role="alert" id="prescreen-date-error" className={p.failure}>{empty}</p>
          : <h2 data-queue-empty tabIndex={-1}>{empty}</h2>}
        {filtered ? <button type="button" className={p.control} onClick={() => {
          setQuery("");
          setSentFrom("");
          setSentTo("");
          search.current?.focus();
        }}>Clear filters</button> : noForms ? <Link href="?view=overview" className={p.control} onClick={(event) => {
          if (event.metaKey || event.ctrlKey || event.shiftKey || event.altKey) return;
          event.preventDefault();
          onOpenOverview();
        }}>Open overview</Link> : null}
      </div>}
      {open && <PreScreenPanel key={open.candidate.id} row={open} extra={extras.get(open.candidate.id)}
        data={data} busy={busy || retrying} status={status}
        error={conflict ? "This record changed. Refresh to see it." : saved ? "Saved. Could not refresh the list." : actionError}
        refreshLabel={conflict ? "Refresh" : saved ? "Refresh list" : null}
        onOpenEmailLog={onOpenEmailLog} onRefresh={refresh}
        onClose={() => { focusAfterClose.current = open.candidate.id; setSelected(null); }}
        onAction={async (action, label, reason, score) => {
          const { id, revision, subjects, name } = open.candidate;
          const body = { action, id, revision, reason };
          setActionError("");
          await command(action === "pre_screen_score" ? { ...body, score } : { ...body, subjects }, (latest) => {
            const message = action === "bring_back" ? `${name} is back in review. Decision needed.` : `${RESULTS[action]} for ${name}.`;
            const result = { id, action, message,
              fromDecision: open.group === "decision" && filter === "decision" };
            if (latest) finishAction(latest, result);
            else setSaved(result);
          }, (message, httpStatus) => {
            if (httpStatus === 409 && message === REVISION_CONFLICT) setConflicts((current) => new Map(current).set(id, revision));
            else {
              const detail = message || `Could not ${label.toLowerCase()}.`;
              const transient = httpStatus === undefined || httpStatus === 429 || httpStatus >= 500;
              setActionError(transient && !/try again/i.test(detail) ? `${detail} Try again.` : detail);
            }
          });
        }} />}
    </section>
  );

  async function refresh() {
    if (retrying) return false;
    setRetrying(true);
    try {
      const latest = await reload();
      if (saved) finishAction(latest, saved);
      else if (conflict) return latest.candidates.some(({ id, revision }) => id === open.candidate.id && revision > conflictRevision);
      else setActionError("");
      return true;
    } catch {
      return "failed" as const;
    } finally {
      setRetrying(false);
    }
  }
}
