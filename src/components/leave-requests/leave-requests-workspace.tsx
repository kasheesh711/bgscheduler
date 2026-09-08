"use client";

import { useCallback, useDeferredValue, useEffect, useRef, useState } from "react";
import { AlertCircle, ArrowLeft, ArrowRight, Check, ChevronDown, ChevronRight, ExternalLink, Loader2, RefreshCw, Search, Users } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogDescription, DialogTitle } from "@/components/ui/dialog";
import { cn } from "@/lib/utils";
import { addBangkokDays, minuteToTimeLabel, todayBangkok } from "@/lib/room-capacity/dates";
import { familyComplete, formatWorkDate, formatWorkTime } from "@/lib/leave-requests/work-model";
import type { CompletionEvidence, LeaveBoard, LeaveInterpretation, WorkAssignment } from "@/lib/leave-requests/work-types";
import type { LeaveMutation } from "@/lib/leave-requests/work-data";

const control = "min-h-10 rounded-lg border border-border bg-background px-3 text-sm outline-none focus-visible:ring-2 focus-visible:ring-ring";

function evidenceLabel(evidence: CompletionEvidence | null) {
  if (!evidence) return null;
  if (evidence.source === "wise") return "Confirmed by Wise";
  const who = evidence.actorName || evidence.actorEmail || "Admin";
  if (!evidence.completedAt) return `Imported from sheet${evidence.actorName ? ` · ${who}` : ""} · time not recorded`;
  return `${who} · ${formatWorkDate(new Intl.DateTimeFormat("en-CA", { timeZone: "Asia/Bangkok", year: "numeric", month: "2-digit", day: "2-digit" }).format(new Date(evidence.completedAt)))} ${formatWorkTime(evidence.completedAt)}`;
}

function Checkoff({ checked, disabled, readOnly, label, context, evidence, onChange }: { checked: boolean; disabled: boolean; readOnly?: boolean; label: string; context: string; evidence: CompletionEvidence | null; onChange: (checked: boolean) => void }) {
  return <div className="flex shrink-0 flex-col gap-1 sm:max-w-60">
    <label className={cn("flex min-h-11 cursor-pointer items-center gap-2.5 rounded-lg border px-3 py-2 text-sm font-medium", checked ? "border-emerald-200 bg-emerald-50 text-emerald-800 dark:border-emerald-800 dark:bg-emerald-950 dark:text-emerald-200" : "border-border bg-background hover:bg-muted/50", disabled && "cursor-wait opacity-70")}>
      <input type="checkbox" className="size-4 shrink-0 accent-primary focus-visible:outline-2 focus-visible:outline-offset-4 focus-visible:outline-ring" checked={checked} disabled={disabled || readOnly} aria-label={`${label}: ${context}`} onChange={(event) => onChange(event.target.checked)} />
      {label}
      {disabled ? <Loader2 aria-label="Saving" className="ml-auto size-3.5 animate-spin" /> : null}
    </label>
    {checked ? <span className="text-xs leading-relaxed text-muted-foreground">{evidenceLabel(evidence)}{!readOnly && evidence?.source !== "wise" ? " · Uncheck to undo" : ""}</span> : null}
  </div>;
}

export function LeaveAssignmentCard({ assignment, viewerEmail, roster, admins, date, pending, expanded, onExpand, onMutate, onDetails }: {
  assignment: WorkAssignment; viewerEmail: string; roster: LeaveBoard["roster"]; admins: LeaveBoard["admins"]; date: string; pending: Set<string>; expanded: boolean;
  onExpand: () => void; onMutate: (assignment: WorkAssignment, mutation: Omit<LeaveMutation, "mutationKey">) => void; onDetails: () => void;
}) {
  const classes = assignment.classes.filter((c) => c.active);
  const families = assignment.families.filter((f) => f.active);
  const informed = families.filter(familyComplete).length;
  const cancelled = classes.filter((c) => c.cancelled).length;
  const ownerOnDuty = roster.find((p) => p.email === assignment.ownerEmail)?.status === "working";
  const needsCover = !!assignment.ownerEmail && !ownerOnDuty && !assignment.done && assignment.dueDate <= date;
  return <article className={cn("overflow-hidden rounded-xl border bg-card shadow-xs", assignment.done ? "border-border" : !assignment.ownerEmail ? "border-amber-300 dark:border-amber-800" : "border-border")}>
    <div className="flex items-stretch gap-2 p-4 sm:gap-4 sm:p-5">
      <button type="button" className="flex min-w-0 flex-1 items-start gap-3 rounded-lg text-left outline-none focus-visible:ring-2 focus-visible:ring-ring" aria-expanded={expanded} aria-controls={`assignment-${assignment.id}`} onClick={onExpand}>
        {expanded ? <ChevronDown className="mt-1 size-4 shrink-0 text-muted-foreground" /> : <ChevronRight className="mt-1 size-4 shrink-0 text-muted-foreground" />}
        <span className="grid min-w-0 flex-1 gap-3 md:grid-cols-[minmax(130px,1fr)_minmax(120px,1fr)_minmax(120px,1fr)] md:items-center md:gap-5">
          <span className="min-w-0"><span className="block text-base font-semibold leading-snug">{assignment.teacherName}</span><span className="mt-1 block text-sm text-muted-foreground">Class · <strong className="font-medium text-foreground">{formatWorkDate(assignment.classDate)}</strong></span></span>
          <span className="flex flex-wrap items-baseline gap-x-2 md:block"><span className="text-xs text-muted-foreground md:block">Process by</span><span className={cn("text-sm font-medium md:mt-1 md:block", !assignment.done && assignment.dueDate < date && "text-amber-800 dark:text-amber-300")}>{formatWorkDate(assignment.dueDate)}</span></span>
          <span className="flex flex-wrap items-center gap-2 md:block"><span className="text-xs text-muted-foreground md:block">Owner</span><span className={cn("text-sm font-semibold md:mt-1 md:block", !assignment.ownerEmail && "text-amber-800 dark:text-amber-300")}>{assignment.ownerName || "Unassigned"}{needsCover ? <span className="ml-2 rounded bg-amber-100 px-1.5 py-0.5 text-[11px] font-medium text-amber-900 dark:bg-amber-950 dark:text-amber-200">Needs cover</span> : null}</span></span>
        </span>
      </button>
      <div className="flex min-w-25 flex-col items-end justify-center gap-1.5 text-xs sm:min-w-32 sm:text-sm">
        <span className={informed === families.length && families.length ? "text-emerald-700 dark:text-emerald-400" : "text-muted-foreground"}><strong className="font-semibold tabular-nums">{informed}/{families.length}</strong> informed</span>
        <span className={cancelled === classes.length ? "text-emerald-700 dark:text-emerald-400" : "text-muted-foreground"}><strong className="font-semibold tabular-nums">{cancelled}/{classes.length}</strong> cancelled</span>
        {assignment.done ? <span className="inline-flex items-center gap-1 font-medium text-emerald-700 dark:text-emerald-400"><Check className="size-3.5" />Complete</span> : null}
      </div>
    </div>
    {expanded ? <div id={`assignment-${assignment.id}`} className="border-t border-border">
      {assignment.issue ? <div role="status" className="flex gap-2 bg-amber-50 px-5 py-3 text-sm text-amber-900 dark:bg-amber-950 dark:text-amber-200"><AlertCircle className="mt-0.5 size-4 shrink-0" />{assignment.issue}</div> : null}
      <div className="px-4 py-5 sm:px-6">
        <div className="mb-3 flex flex-wrap items-baseline justify-between gap-1"><h3 className="font-semibold">Families to inform <span className="ml-1 text-sm font-normal text-muted-foreground">{informed}/{families.length}</span></h3><p className="text-xs text-muted-foreground">Check after sending. No parent reply needed.</p></div>
        <div className="divide-y divide-border">
          {families.map((family) => {
            const covered = classes.filter((c) => family.coverage.some((item) => item.sessionId === c.wiseSessionId));
            const contacts = [...new Map(family.students.flatMap((st) => st.contacts).filter((c) => c.url).map((c) => [c.id, c])).values()];
            return <div key={family.id} className="flex flex-col justify-between gap-3 py-4 first:pt-1 sm:flex-row sm:items-start">
              <div className="min-w-0"><div className="font-medium">{family.students.map((st) => st.name).join(" & ")}</div><p className="mt-0.5 text-sm text-muted-foreground">{family.students.some((st) => st.parentName) ? `Family · ${family.label}` : "Family not linked · kept as a separate student"}</p>
                <p className="mt-1 text-sm">{covered.map((c) => `${formatWorkTime(c.startTime)}–${formatWorkTime(c.endTime)} ${c.title || c.subject}`).join(" · ")}</p>
                <div className="mt-2 flex flex-wrap gap-2">{contacts.length ? contacts.map((contact) => <a className="inline-flex min-h-8 items-center gap-1.5 rounded-md border border-border px-2.5 text-xs font-medium text-primary hover:bg-muted focus-visible:outline-2 focus-visible:outline-ring" key={contact.id} href={contact.url!} target="_blank" rel="noreferrer">Open LINE{contacts.length > 1 && contact.name ? ` · ${contact.name}` : ""}<ExternalLink className="size-3" /><span className="sr-only"> for {family.label}</span></a>) : <span className="text-xs text-amber-800 dark:text-amber-300">No verified LINE chat link · use the family’s known contact</span>}</div>
              </div>
              <Checkoff checked={familyComplete(family)} disabled={pending.has(family.id)} label="Parent informed" context={family.students.map((st) => st.name).join(" & ")} evidence={family.informed} onChange={(checked) => onMutate(assignment, { kind: "family", entityId: family.id, expectedVersion: family.version, checked })} />
            </div>;
          })}
          {!families.length ? <p className="py-3 text-sm text-amber-800">Student details are unavailable. Verify the class roster before contacting families.</p> : null}
        </div>
      </div>
      <div className="border-t border-border bg-muted/15 px-4 py-5 sm:px-6">
        <div className="mb-3 flex flex-wrap items-baseline justify-between gap-1"><h3 className="font-semibold">Classes to cancel <span className="ml-1 text-sm font-normal text-muted-foreground">{cancelled}/{classes.length}</span></h3><p className="text-xs text-muted-foreground">Cancel manually in Wise, then check off here.</p></div>
        <div className="divide-y divide-border">{classes.map((item) => <div key={item.id} className="flex flex-col justify-between gap-3 py-4 first:pt-1 sm:flex-row sm:items-start">
          <div className="min-w-0"><div className="text-sm font-semibold tabular-nums">{formatWorkTime(item.startTime)}–{formatWorkTime(item.endTime)} <span className="ml-2 font-medium">{item.title || item.subject || "Class"}</span></div><p className="mt-1 text-sm text-muted-foreground">{item.students.map((st) => st.name).join(", ")}{item.students.length > 1 ? " · Group class" : ""}</p>{item.issue ? <p className="mt-1 text-xs text-amber-800 dark:text-amber-300">{item.issue}</p> : null}</div>
          <Checkoff checked={!!item.cancelled} disabled={pending.has(item.id)} readOnly={/^(CANCELLED|CANCELED)$/i.test(item.wiseStatus)} label="Cancelled in Wise" context={`${formatWorkTime(item.startTime)} ${item.students.map((st) => st.name).join(", ")}`} evidence={item.cancelled} onChange={(checked) => onMutate(assignment, { kind: "class", entityId: item.id, expectedVersion: item.version, checked })} />
        </div>)}</div>
      </div>
      <div className="flex flex-wrap items-center justify-between gap-3 border-t border-border px-4 py-3 sm:px-6">
        <div className="flex flex-wrap items-center gap-2">
          {assignment.ownerEmail !== viewerEmail ? <Button className="min-h-10" variant="outline" disabled={pending.has(assignment.id)} onClick={() => onMutate(assignment, { kind: "owner", entityId: assignment.id, expectedVersion: assignment.version, ownerEmail: viewerEmail })}>{assignment.ownerEmail ? "Take over" : "Assign to me"}</Button> : <span className="text-xs font-medium text-primary">Assigned to you</span>}
          <select className={control} value={assignment.ownerEmail ?? ""} disabled={pending.has(assignment.id)} aria-label={`Reassign ${assignment.teacherName}, ${formatWorkDate(assignment.classDate)}`} onChange={(e) => onMutate(assignment, { kind: "owner", entityId: assignment.id, expectedVersion: assignment.version, ownerEmail: e.target.value || null })}><option value="">Unassigned</option>{admins.map((admin) => <option key={admin.email} value={admin.email}>{admin.name}</option>)}</select>
        </div>
        <Button variant="ghost" className="min-h-10 text-muted-foreground" onClick={onDetails}>Source, notes & activity<ChevronRight className="size-4" /></Button>
      </div>
    </div> : null}
  </article>;
}

interface SourceDetail { request: { id: string; tutorName: string; sourceRowNumber: number; sourceSubmittedAt: string | null; sourceSheetStatus: string | null; staffNote: string | null; makeupOptions: string | null; spreadsheetId: string; rawValues: Record<string, unknown> }; normalization: { result: LeaveInterpretation | null; model: string; promptVersion: string; status: string; error: string | null } | null }
interface DetailPayload { sources: SourceDetail[]; activity: Array<{ id: string; action: string; actorEmail: string | null; actorName: string | null; createdAt: string; payload: Record<string, unknown> }> }

function SourceDrawer({ target, onClose }: { target: { id: string; title: string; request?: boolean } | null; onClose: () => void }) {
  const [detail, setDetail] = useState<DetailPayload | null>(null);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    if (!target) return;
    const abort = new AbortController();
    fetch(target.request ? `/api/leave-requests/${target.id}` : `/api/leave-requests/assignments/${target.id}`, { signal: abort.signal, cache: "no-store" }).then(async (r) => { if (!r.ok) throw new Error("Unable to load source details."); return r.json(); }).then((body) => { setDetail(target.request ? { sources: [{ request: body.request, normalization: null }], activity: [] } : body); setError(null); }).catch((e) => { if (!abort.signal.aborted) setError(e.message); });
    return () => { abort.abort(); setDetail(null); };
  }, [target]);
  return <Dialog open={!!target} onOpenChange={(open) => { if (!open) onClose(); }}><DialogContent className="inset-y-0 right-0 left-auto h-dvh max-w-full translate-x-0 translate-y-0 overflow-y-auto rounded-none sm:max-w-xl"><DialogTitle className="pr-8 text-lg">{target?.title}</DialogTitle><DialogDescription>Original submissions and the record of this work.</DialogDescription>
    {error ? <p role="alert" className="text-destructive">{error}</p> : !detail ? <p className="text-muted-foreground">Loading details…</p> : <>
      {detail.sources.map(({ request, normalization }) => <section key={request.id} className="rounded-xl border border-border p-4">
        <div className="flex items-center justify-between"><h3 className="font-semibold">{request.tutorName} · row {request.sourceRowNumber}</h3><a href={`https://docs.google.com/spreadsheets/d/${request.spreadsheetId}/edit`} target="_blank" rel="noreferrer" className="inline-flex items-center gap-1 text-xs text-primary">Open sheet<ExternalLink className="size-3" /></a></div>
        {request.sourceSheetStatus ? <p className="mt-3 whitespace-pre-wrap text-sm"><span className="font-medium">Sheet notes: </span>{request.sourceSheetStatus}</p> : null}
        {request.staffNote ? <p className="mt-3 whitespace-pre-wrap text-sm"><span className="font-medium">Staff notes: </span>{request.staffNote}</p> : null}
        {request.makeupOptions ? <p className="mt-3 whitespace-pre-wrap text-sm"><span className="font-medium">Make-up suggestions: </span>{request.makeupOptions}</p> : null}
        {normalization ? <div className="mt-3 border-t pt-3 text-sm"><p>{normalization.result?.explanation || normalization.error || "Interpretation is processing automatically."}</p>{normalization.result?.windows.map((w, i) => <p key={i} className="mt-1 text-muted-foreground">{formatWorkDate(w.startDate)}{w.endDate !== w.startDate ? ` – ${formatWorkDate(w.endDate)}` : ""} · {w.startMinute === 0 && w.endMinute === 1440 ? "Full day" : `${minuteToTimeLabel(w.startMinute)}–${minuteToTimeLabel(w.endMinute)}`}</p>)}<p className="mt-2 text-xs text-muted-foreground">{normalization.model} · {normalization.promptVersion}</p></div> : null}
        <details className="mt-3"><summary className="cursor-pointer text-xs font-medium text-primary">All original form fields</summary><dl className="mt-3 space-y-3 break-words text-xs">{Object.entries(request.rawValues ?? {}).map(([k, v]) => <div key={k}><dt className="text-muted-foreground">{k}</dt><dd className="mt-0.5 whitespace-pre-wrap">{String(v || "—")}</dd></div>)}</dl></details>
      </section>)}
      <section><h3 className="mb-3 font-semibold">Activity</h3>{detail.activity.length ? <ol className="divide-y divide-border">{detail.activity.map((event) => <li key={event.id} className="py-3 text-sm"><p className="font-medium">{event.action.replaceAll("_", " ")}</p><p className="mt-1 text-xs text-muted-foreground">{event.actorName || event.actorEmail || "Automatic sync"} · {new Date(event.createdAt).toLocaleString("en-GB", { timeZone: "Asia/Bangkok", day: "numeric", month: "short", hour: "2-digit", minute: "2-digit" })}</p></li>)}</ol> : <p className="text-sm text-muted-foreground">Original status is preserved above.</p>}</section>
    </>}
  </DialogContent></Dialog>;
}

export function LeaveRequestsWorkspace() {
  const [date, setDate] = useState(() => todayBangkok());
  const [view, setView] = useState<"daily" | "upcoming" | "history">("daily");
  const [owner, setOwner] = useState<string | null>(null);
  const [search, setSearch] = useState("");
  const term = useDeferredValue(search);
  const [board, setBoard] = useState<LeaveBoard | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState("");
  const [syncing, setSyncing] = useState(false);
  const [pending, setPending] = useState(new Set<string>());
  const [expanded, setExpanded] = useState(new Set<string>());
  const [target, setTarget] = useState<{ id: string; title: string; request?: boolean } | null>(null);
  const sequence = useRef(0);
  const reload = useCallback(async (signal?: AbortSignal) => {
    const current = ++sequence.current;
    try {
      const params = new URLSearchParams({ date, view, ...(term ? { q: term } : {}) });
      const response = await fetch(`/api/leave-requests/board?${params}`, { signal, cache: "no-store" });
      const body = await response.json();
      if (!response.ok) throw new Error(body.error || "Unable to load the daily queue.");
      if (current === sequence.current && !signal?.aborted) { setBoard(body); setError(null); }
    } catch (e) { if (!signal?.aborted && current === sequence.current) setError(e instanceof Error ? e.message : "Unable to refresh. Your saved work is retained."); }
  }, [date, view, term]);
  useEffect(() => {
    const abort = new AbortController();
    void reload(abort.signal);
    const focus = () => void reload(abort.signal);
    const interval = window.setInterval(() => { if (document.visibilityState === "visible") void reload(abort.signal); }, 30_000);
    window.addEventListener("focus", focus);
    return () => { abort.abort(); window.clearInterval(interval); window.removeEventListener("focus", focus); };
  }, [reload]);
  const mutate = async (assignment: WorkAssignment, input: Omit<LeaveMutation, "mutationKey">) => {
    setPending((p) => new Set(p).add(input.entityId));
    const mutation = { ...input, mutationKey: crypto.randomUUID() };
    try {
      const response = await fetch(`/api/leave-requests/assignments/${assignment.id}`, { method: "PATCH", headers: { "Content-Type": "application/json" }, body: JSON.stringify(mutation) });
      const body = await response.json();
      if (!response.ok) throw new Error(body.error || "Unable to save this change.");
      setNotice(input.kind === "owner" ? "Assignment updated." : input.checked ? "Checked off and saved." : "Checkoff undone.");
      await reload();
    } catch (e) { await reload(); setError(e instanceof Error ? e.message : "Unable to save. Try again."); }
    finally { setPending((p) => { const next = new Set(p); next.delete(input.entityId); return next; }); }
  };
  const sync = async () => {
    setSyncing(true); setNotice("Importing submissions and updating assignments. You can keep working.");
    try { const response = await fetch("/api/leave-requests/sync", { method: "POST", headers: { "Content-Type": "application/json" }, body: "{}" }); const body = await response.json(); if (!response.ok && response.status !== 409) throw new Error(body.error || "Sync failed."); await reload(); setNotice(response.status === 409 ? "A sync is already running. This queue will refresh automatically." : "Queue updated. Remaining interpretations continue automatically."); }
    catch (e) { setError(e instanceof Error ? e.message : "Sync failed; saved work is retained."); }
    finally { setSyncing(false); }
  };
  const selectedOwner = owner ?? board?.defaultOwner ?? "everyone";
  const assignments = (board?.assignments ?? []).filter((a) => a.classes.some((c) => c.active) && (selectedOwner === "everyone" || selectedOwner === "unassigned" ? selectedOwner === "everyone" || !a.ownerEmail : a.ownerEmail === selectedOwner));
  const unfinished = assignments.filter((a) => !a.done).length;
  const groups = view === "daily" ? [
    { label: "Overdue", rows: assignments.filter((a) => !a.done && a.dueDate < date) },
    { label: "Due today", rows: assignments.filter((a) => !a.done && a.dueDate === date) },
    { label: "Completed", rows: assignments.filter((a) => a.done) },
  ] : [{ label: view === "upcoming" ? "Upcoming work" : "Past classes", rows: assignments }];
  return <div className="min-h-0 flex-1 overflow-y-auto overscroll-contain" data-testid="leave-work-scroll">
    <div className="mx-auto w-full max-w-6xl space-y-5 pb-12 pt-2">
      <header className="flex items-start justify-between gap-3"><div className="min-w-0 flex-1"><p className="mb-1 text-xs font-medium uppercase tracking-wider text-primary">Daily admin work</p><h1 className="text-2xl font-semibold tracking-tight">Leave Requests</h1><p className="mt-1 text-sm text-muted-foreground">Inform families and cancel classes one week before the class.</p></div><Button variant="outline" className="min-h-10" disabled={syncing || board?.freshness.running} onClick={() => void sync()}><RefreshCw className={cn("size-4", (syncing || board?.freshness.running) && "animate-spin")} />{syncing || board?.freshness.running ? "Syncing…" : "Sync now"}</Button></header>
      <div className="flex flex-wrap items-center justify-between gap-3 border-b border-border pb-4">
        <div className="flex flex-wrap items-center gap-2"><Button variant={date === board?.today && view === "daily" ? "default" : "outline"} className="min-h-10" onClick={() => { setDate(todayBangkok()); setView("daily"); }}>Today</Button><Button variant="ghost" size="icon" className="size-10" aria-label="Previous processing day" onClick={() => setDate((d) => addBangkokDays(d, -1))}><ArrowLeft /></Button><label className="sr-only" htmlFor="leave-work-date">Processing date</label><input id="leave-work-date" type="date" value={date} className={cn(control, "max-w-42")} onChange={(e) => { if (e.target.value) setDate(e.target.value); }} /><Button variant="ghost" size="icon" className="size-10" aria-label="Next processing day" onClick={() => setDate((d) => addBangkokDays(d, 1))}><ArrowRight /></Button></div>
        <div className="flex gap-1 rounded-lg bg-muted p-1" aria-label="Work views">{(["daily", "upcoming", "history"] as const).map((v) => <button key={v} type="button" className={cn("min-h-9 rounded-md px-3 text-sm font-medium outline-none focus-visible:ring-2 focus-visible:ring-ring", view === v ? "bg-background shadow-xs" : "text-muted-foreground hover:text-foreground")} aria-pressed={view === v} onClick={() => setView(v)}>{v === "daily" ? "Daily queue" : v === "upcoming" ? "Upcoming" : "History"}</button>)}</div>
      </div>
      {board ? <section aria-label="Admin roster" className="space-y-2"><div className="flex items-center justify-between gap-2"><h2 className="text-sm font-medium">Admin roster <span className="ml-1 font-normal text-muted-foreground">· {formatWorkDate(date)}</span></h2><span className="text-xs text-muted-foreground">Unfinished assignments</span></div><div className="flex gap-2 overflow-x-auto pb-1">{board.roster.map((p) => <button key={p.email} type="button" aria-pressed={selectedOwner === p.email} onClick={() => setOwner(p.email)} className={cn("min-w-28 flex-1 shrink-0 rounded-lg border p-2.5 text-left outline-none transition-colors focus-visible:ring-2 focus-visible:ring-ring sm:p-3", selectedOwner === p.email ? "border-primary bg-primary/5" : "border-border bg-card hover:border-primary/40")}><span className="flex items-center justify-between gap-2 text-sm font-semibold">{p.name}<span className={cn("rounded px-1.5 py-0.5 text-xs tabular-nums", p.unfinished ? "bg-primary/10 text-primary" : "bg-muted text-muted-foreground")}>{p.unfinished}</span></span><span className="mt-1 block text-xs text-muted-foreground">{p.status === "working" && p.startMinute !== null && p.endMinute !== null ? `${minuteToTimeLabel(p.startMinute)}–${minuteToTimeLabel(p.endMinute)}` : p.status === "sick" ? "Sick leave" : p.status === "off" ? "Day off" : p.status === "unknown" ? "Roster unavailable" : p.status === "holiday" ? "Holiday" : "On leave"}</span>{p.needsCover ? <span className="mt-1 block text-xs font-medium text-amber-800 dark:text-amber-300">{p.needsCover} need cover</span> : null}</button>)}</div></section> : null}
      {error ? <div role="alert" className="flex items-start gap-2 rounded-lg border border-destructive/25 bg-destructive/5 p-3 text-sm text-destructive"><AlertCircle className="mt-0.5 size-4 shrink-0" /><span>{error}</span><button className="ml-auto underline" onClick={() => void reload()}>Retry</button></div> : null}
      {board && (board.freshness.stale || board.freshness.errors.length || board.freshness.pendingNormalization || board.freshness.failedNormalization) ? <div role="status" className="rounded-lg border border-amber-200 bg-amber-50 p-3 text-sm text-amber-950 dark:border-amber-900 dark:bg-amber-950 dark:text-amber-200"><p className="flex items-start gap-2 font-medium"><AlertCircle className="mt-0.5 size-4 shrink-0" />{board.freshness.stale ? "Source data is stale. Saved assignments and checkoffs are retained." : board.freshness.pendingNormalization ? `${board.freshness.pendingNormalization} submissions are being interpreted automatically.` : "Some submissions could not be processed. Retries are automatic."}</p><p className="mt-1 pl-6 text-xs">Last source read: {board.freshness.sourceReadAt ? new Date(board.freshness.sourceReadAt).toLocaleString("en-GB", { timeZone: "Asia/Bangkok", day: "numeric", month: "short", hour: "2-digit", minute: "2-digit" }) : "not yet available"}{board.freshness.pendingWritebacks ? ` · ${board.freshness.pendingWritebacks} sheet summaries waiting to sync` : ""}</p>{board.freshness.errors.length ? <details className="mt-2 pl-6"><summary className="cursor-pointer text-xs font-medium">Show {board.freshness.errors.length} processing issues</summary><ul className="mt-2 list-disc space-y-1 pl-4 text-xs">{board.freshness.errors.map((message, i) => <li key={i}>{message}</li>)}</ul></details> : null}</div> : null}
      <div className="flex flex-wrap items-center justify-between gap-3"><div className="flex flex-wrap items-center gap-1"><Button variant={selectedOwner === board?.viewerEmail ? "default" : "outline"} className="min-h-10" onClick={() => setOwner(board?.viewerEmail ?? null)}>My work</Button><Button variant={selectedOwner === "everyone" ? "default" : "outline"} className="min-h-10" onClick={() => setOwner("everyone")}><Users className="size-4" />Everyone</Button><Button variant={selectedOwner === "unassigned" ? "default" : "ghost"} className="min-h-10" onClick={() => setOwner("unassigned")}>Unassigned</Button></div><label className="relative min-w-48 flex-1 sm:max-w-72"><Search className="absolute top-3 left-3 size-4 text-muted-foreground" /><input className={cn(control, "w-full pl-9")} type="search" aria-label="Search teacher, family or date" placeholder="Search teacher or family" value={search} onChange={(e) => setSearch(e.target.value)} /></label></div>
      <div className="flex flex-wrap items-baseline justify-between gap-2"><h2 className="text-base font-semibold">{selectedOwner === "everyone" ? "Everyone's work" : selectedOwner === "unassigned" ? "Unassigned work" : selectedOwner === board?.viewerEmail ? "My work" : `${board?.admins.find((a) => a.email === selectedOwner)?.name || "Admin"}'s work`}<span className="ml-2 text-sm font-normal text-muted-foreground">{unfinished} unfinished</span></h2><span className="text-xs text-muted-foreground">All times Bangkok · refreshes every 30s</span></div>
      {!board ? <div className="space-y-3" aria-label="Loading assignments">{[1, 2, 3].map((i) => <div key={i} className="h-28 animate-pulse rounded-xl border border-border bg-card" />)}</div> : null}
      {groups.filter((g) => g.rows.length).map((group) => <section key={group.label} aria-label={group.label} className="space-y-3"><h3 className={cn("flex items-center gap-2 text-xs font-semibold uppercase tracking-wide", group.label === "Overdue" ? "text-amber-800 dark:text-amber-300" : "text-muted-foreground")}>{group.label}<span className="rounded bg-muted px-1.5 py-0.5 tabular-nums">{group.rows.length}</span></h3>{group.rows.map((assignment) => <LeaveAssignmentCard key={assignment.id} assignment={assignment} viewerEmail={board!.viewerEmail} roster={board!.roster} admins={board!.admins} date={date} pending={pending} expanded={expanded.has(assignment.id)} onExpand={() => setExpanded((prior) => { const next = new Set(prior); if (next.has(assignment.id)) next.delete(assignment.id); else next.add(assignment.id); return next; })} onMutate={(a, m) => void mutate(a, m)} onDetails={() => setTarget({ id: assignment.id, title: `${assignment.teacherName} · ${formatWorkDate(assignment.classDate)}` })} />)}</section>)}
      {board && !assignments.length && view !== "history" ? <div className="rounded-xl border border-dashed border-border px-5 py-12 text-center"><div className="mx-auto mb-3 flex size-10 items-center justify-center rounded-full bg-primary/10 text-primary"><Check className="size-5" /></div><p className="font-medium">{selectedOwner === "unassigned" ? "No unassigned work for this view" : "No assignments in this view"}</p><p className="mt-1 text-sm text-muted-foreground">{view === "upcoming" ? "Future class cancellations will appear here as submissions are processed." : "Check Everyone for shared work, or Upcoming for later processing dates."}</p>{selectedOwner !== "everyone" ? <Button className="mt-4" variant="outline" onClick={() => setOwner("everyone")}>See everyone’s work</Button> : null}</div> : null}
      {view === "history" && board ? <section className="space-y-2"><h3 className="text-sm font-semibold">Original submissions · past classes</h3>{board.history.map((request) => <button type="button" key={request.id} onClick={() => setTarget({ id: request.id, title: request.teacher, request: true })} className="flex w-full items-center justify-between gap-4 rounded-lg border border-border bg-card p-4 text-left outline-none hover:bg-muted/30 focus-visible:ring-2 focus-visible:ring-ring"><span className="min-w-0"><span className="block font-medium">{request.teacher}</span><span className="mt-1 block text-sm text-muted-foreground">{request.startDate ? formatWorkDate(request.startDate) : "Date unresolved"}{request.endDate && request.endDate !== request.startDate ? ` – ${formatWorkDate(request.endDate)}` : ""}</span><span className="mt-1 block break-words text-xs text-muted-foreground">{request.status || "No source status recorded"}</span></span><ChevronRight className="size-4 shrink-0 text-muted-foreground" /></button>)}{!board.history.length && !assignments.length ? <p className="py-8 text-center text-sm text-muted-foreground">No history matches this search.</p> : null}</section> : null}
      <span className="sr-only" aria-live="polite">{notice}</span>
      <SourceDrawer target={target} onClose={() => setTarget(null)} />
    </div>
  </div>;
}
