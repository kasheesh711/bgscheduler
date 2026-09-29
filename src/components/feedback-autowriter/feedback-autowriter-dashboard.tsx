"use client";

import { useCallback, useEffect, useRef, useState, type ReactNode } from "react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { formatBangkokShortDateTime } from "@/lib/bangkok-time";
import type { AutowriterDashboard } from "@/lib/feedback-autowriter/dashboard";
import { cn } from "@/lib/utils";

const WINDOWS = [
  { days: 1, label: "24 h" },
  { days: 7, label: "7 days" },
  { days: 30, label: "30 days" },
] as const;

const STATE_LABEL: Record<string, string> = {
  verified: "Posted",
  awaiting_event: "Posted · confirming",
  posting: "Posting",
  would_submit: "Shadow draft",
  held: "Held",
  skipped_human: "Tutor wrote it",
  skipped_scope: "Out of scope",
  expired: "Expired",
  rejected: "Rejected",
  unknown_outcome: "Unknown outcome",
  verify_failed: "Verify failed",
  pending: "Waiting",
  generating: "Writing",
  awaiting_recording: "Waiting for recording",
  transcribing: "Transcribing",
};

const STATE_TONE: Record<string, string> = {
  verified: "border-available/30 bg-available/10 text-available",
  awaiting_event: "border-available/30 bg-available/10 text-available",
  posting: "border-sky-300 bg-sky-50 text-sky-800 dark:bg-sky-950 dark:text-sky-200",
  would_submit: "border-sky-300 bg-sky-50 text-sky-800 dark:bg-sky-950 dark:text-sky-200",
  awaiting_recording: "border-violet-300 bg-violet-50 text-violet-800 dark:bg-violet-950 dark:text-violet-200",
  transcribing: "border-violet-300 bg-violet-50 text-violet-800 dark:bg-violet-950 dark:text-violet-200",
  held: "border-amber-300 bg-amber-50 text-amber-800 dark:bg-amber-950 dark:text-amber-200",
  expired: "border-amber-300 bg-amber-50 text-amber-800 dark:bg-amber-950 dark:text-amber-200",
  rejected: "border-red-300 bg-red-50 text-red-700 dark:bg-red-950 dark:text-red-200",
  unknown_outcome: "border-red-300 bg-red-50 text-red-700 dark:bg-red-950 dark:text-red-200",
  verify_failed: "border-red-300 bg-red-50 text-red-700 dark:bg-red-950 dark:text-red-200",
};

const FIELD_LABELS: Array<[string, string]> = [
  ["topics", "Topics covered"],
  ["performance", "How the student did in class"],
  ["improvement", "Need more work on"],
  ["homework", "Homework and due date"],
];

function isDashboard(value: unknown): value is AutowriterDashboard {
  return typeof value === "object" && value !== null && "totals" in value && "control" in value && "recent" in value;
}

function usd(value: number | null | undefined): string {
  if (value === null || value === undefined) return "—";
  return value < 0.01 && value > 0 ? `$${value.toFixed(4)}` : `$${value.toFixed(2)}`;
}

function minutes(value: number | null): string {
  if (value === null) return "—";
  return value < 60 ? `${value.toFixed(1)} min` : `${(value / 60).toFixed(1)} h`;
}

function when(value: string | null): string {
  return value ? formatBangkokShortDateTime(value) : "—";
}

function Kpi({ label, value, detail, tone = "default" }: {
  label: string;
  value: string;
  detail?: string;
  tone?: "default" | "good" | "warning" | "danger";
}) {
  return (
    <div className="rounded-lg border bg-card px-4 py-3">
      <div className="text-[10px] font-semibold uppercase tracking-wide text-muted-foreground">{label}</div>
      <div className={cn("mt-1 text-2xl font-semibold tracking-tight", {
        "text-available": tone === "good",
        "text-amber-700 dark:text-amber-400": tone === "warning",
        "text-red-700 dark:text-red-400": tone === "danger",
      })}>{value}</div>
      {detail ? <div className="mt-0.5 truncate text-[11px] text-muted-foreground">{detail}</div> : null}
    </div>
  );
}

function Section({ title, count, children, action }: { title: string; count?: number; children: ReactNode; action?: ReactNode }) {
  return (
    <section className="rounded-lg border bg-card">
      <div className="flex items-center justify-between gap-3 border-b px-4 py-3">
        <div className="flex items-center gap-2">
          <h2 className="text-sm font-semibold">{title}</h2>
          {count !== undefined ? <Badge variant="outline">{count}</Badge> : null}
        </div>
        {action}
      </div>
      <div className="overflow-auto">{children}</div>
    </section>
  );
}

function modelLabel(model: string): string {
  if (model.startsWith("z-ai/glm")) return "GLM Flash";
  if (model.startsWith("openai/gpt-6-luna")) return "GPT-6 Luna";
  if (model.startsWith("stt-async")) return "Soniox transcription";
  return model;
}

export function FeedbackAutowriterDashboard({ initialData, canControl }: {
  initialData: AutowriterDashboard;
  canControl: boolean;
}) {
  const [data, setData] = useState(initialData);
  const [windowDays, setWindowDays] = useState<number>(initialData.windowDays);
  const [refreshing, setRefreshing] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [note, setNote] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const requestSequence = useRef(0);
  const controllerRef = useRef<AbortController | null>(null);

  const load = useCallback(async (days: number) => {
    const sequence = ++requestSequence.current;
    controllerRef.current?.abort();
    const controller = new AbortController();
    controllerRef.current = controller;
    setRefreshing(true);
    try {
      const response = await fetch(`/api/feedback-autowriter?days=${days}`, { cache: "no-store", signal: controller.signal });
      const json: unknown = await response.json().catch(() => null);
      if (sequence !== requestSequence.current) return;
      if (!response.ok || !isDashboard(json)) {
        setError((json as { error?: string } | null)?.error ?? `HTTP ${response.status}`);
        return;
      }
      setData(json);
      setError(null);
    } catch (caught) {
      if (caught instanceof Error && caught.name === "AbortError") return;
      setError("Could not refresh the dashboard.");
    } finally {
      if (sequence === requestSequence.current) setRefreshing(false);
    }
  }, []);

  useEffect(() => {
    const interval = window.setInterval(() => void load(windowDays), 60_000);
    return () => window.clearInterval(interval);
  }, [load, windowDays]);

  const changeWindow = (days: number) => {
    setWindowDays(days);
    void load(days);
  };

  const sendControl = async (body: Record<string, unknown>, confirmText: string) => {
    if (!window.confirm(confirmText)) return;
    setBusy(true);
    setNote(null);
    try {
      const response = await fetch("/api/feedback-autowriter/control", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
      });
      const json = await response.json().catch(() => null) as { error?: unknown; requeued?: number } | null;
      if (!response.ok) {
        setError(typeof json?.error === "string" ? json.error : `HTTP ${response.status}`);
        return;
      }
      setNote(json?.requeued ? `Saved. ${json.requeued} shadow draft(s) queued for posting.` : "Saved.");
      await load(windowDays);
    } finally {
      setBusy(false);
    }
  };

  const pause = () => {
    const reason = window.prompt("Why pause the autowriter?");
    if (!reason?.trim()) return;
    void sendControl({ action: "pause", reason: reason.trim() }, "Pause all feedback posting now?");
  };

  const { control, totals } = data;
  const halted = Boolean(control.haltedAt);
  const modeTone = control.mode === "live"
    ? "border-available/30 bg-available/10 text-available"
    : control.mode === "shadow"
      ? "border-sky-300 bg-sky-50 text-sky-800 dark:bg-sky-950 dark:text-sky-200"
      : "border-muted-foreground/30 text-muted-foreground";

  return (
    <div className="flex min-h-0 flex-1 flex-col gap-4 overflow-auto pb-8">
      <header className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <h1 className="text-xl font-semibold tracking-tight">Feedback Autowriter</h1>
          <p className="text-sm text-muted-foreground">
            AI-written post-class feedback for roster tutors&apos; online one-to-one classes, from Wise&apos;s meeting summary
            or a transcript of the recording. In-person classes stay with the tutor and are not shown here.
          </p>
        </div>
        <div className="flex flex-wrap items-center gap-2">
          <div className="flex rounded-md border p-0.5" role="group" aria-label="Time window">
            {WINDOWS.map((option) => (
              <Button key={option.days} size="xs" variant={windowDays === option.days ? "default" : "ghost"} onClick={() => changeWindow(option.days)}>
                {option.label}
              </Button>
            ))}
          </div>
          <Button size="sm" variant="outline" onClick={() => void load(windowDays)} disabled={refreshing}>
            {refreshing ? "Refreshing…" : "Refresh"}
          </Button>
          <span className="text-xs text-muted-foreground">Updated {when(data.generatedAt)}</span>
        </div>
      </header>

      <div className="flex flex-wrap items-center gap-2 rounded-lg border bg-card px-4 py-3">
        <span className="text-sm font-medium">Mode</span>
        <Badge variant="outline" className={cn("capitalize", modeTone)}>{control.mode}</Badge>
        {halted ? <Badge variant="destructive">Halted</Badge> : null}
        <span className="text-xs text-muted-foreground">
          {control.updatedBy ? `last changed by ${control.updatedBy} · ${when(control.updatedAt)}` : null}
        </span>
        {canControl ? (
          <div className="ml-auto flex flex-wrap gap-2">
            {(["shadow", "live", "off"] as const).filter((mode) => mode !== control.mode).map((mode) => (
              <Button key={mode} size="sm" variant={mode === "live" ? "default" : "outline"} disabled={busy}
                onClick={() => void sendControl({ action: "mode", mode },
                  mode === "live"
                    ? "Switch to LIVE? The autowriter will post feedback to Wise for roster tutors."
                    : `Switch to ${mode.toUpperCase()}? No feedback will be posted to Wise.`)}>
                {mode === "live" ? "Go live" : mode === "shadow" ? "Shadow" : "Turn off"}
              </Button>
            ))}
            {halted ? (
              <Button size="sm" variant="outline" disabled={busy}
                onClick={() => void sendControl({ action: "resume" }, "Resume posting? Check the class named in the halt reason first.")}>
                Resume
              </Button>
            ) : (
              <Button size="sm" variant="destructive" disabled={busy} onClick={pause}>Pause</Button>
            )}
          </div>
        ) : null}
      </div>

      {halted ? (
        <div className="rounded-lg border border-red-300 bg-red-50 px-4 py-3 text-sm text-red-800 dark:bg-red-950 dark:text-red-200" role="alert">
          <strong>Posting is halted</strong> since {when(control.haltedAt)} — {control.haltReason ?? "no reason recorded"}
        </div>
      ) : null}
      {error || note ? (
        <div role="status" className={cn("rounded-md border px-3 py-2 text-sm", error ? "border-red-300 text-red-700" : "border-available/30 text-available")}>
          {error ?? note}
        </div>
      ) : null}

      <div className="grid grid-cols-2 gap-3 md:grid-cols-3 xl:grid-cols-9">
        <Kpi label="Posted to Wise" value={String(totals.posted)} detail={`${totals.verified} confirmed`} tone="good" />
        <Kpi label="Shadow drafts" value={String(totals.shadowDrafts)} detail="written, not posted" />
        <Kpi label="From recording" value={String(totals.awaitingRecording)}
          detail={`waiting · ${totals.fromTranscript} posted from a transcript`} />
        <Kpi label="Held for a person" value={String(totals.held)} tone={totals.held > 0 ? "warning" : "default"} />
        <Kpi label="Tutor wrote first" value={String(totals.skippedHuman)} detail={`${totals.skippedScope} out of scope`} />
        <Kpi label="Expired / failed" value={`${totals.expired} / ${totals.failed}`} tone={totals.failed > 0 ? "danger" : totals.expired > 0 ? "warning" : "default"} />
        <Kpi label="Class end → posted" value={minutes(data.latency.medianMinutes)} detail={`p90 ${minutes(data.latency.p90Minutes)} · ${data.latency.samples} posts`} />
        <Kpi label="Model cost" value={usd(data.cost.totalUsd)} detail={`${usd(data.cost.perDraftUsd)} per draft`} />
        <Kpi label="Checks" value={`${data.judgeRejections} judged unfaithful`}
          detail={data.fallbackShare === null ? "no drafts yet" : `${Math.round(data.fallbackShare * 100)}% written by Luna fallback`} />
      </div>

      <Section title="Tutors" count={data.tutors.length}>
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead>Tutor</TableHead>
              <TableHead className="text-right">Classes</TableHead>
              <TableHead className="text-right">Posted</TableHead>
              <TableHead className="text-right">Shadow</TableHead>
              <TableHead className="text-right">Held</TableHead>
              <TableHead className="text-right">Tutor wrote</TableHead>
              <TableHead className="text-right">Expired</TableHead>
              <TableHead className="text-right">Failed</TableHead>
              <TableHead className="text-right">Median to post</TableHead>
              <TableHead className="text-right">Cost</TableHead>
              <TableHead>Status</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {data.tutors.map((tutor) => (
              <TableRow key={tutor.tutorKey}>
                <TableCell className="font-medium">{tutor.displayName}</TableCell>
                <TableCell className="text-right">{tutor.seen}</TableCell>
                <TableCell className="text-right">{tutor.posted}</TableCell>
                <TableCell className="text-right">{tutor.shadowDrafts}</TableCell>
                <TableCell className="text-right">{tutor.held}</TableCell>
                <TableCell className="text-right">{tutor.skippedHuman}</TableCell>
                <TableCell className="text-right">{tutor.expired}</TableCell>
                <TableCell className="text-right">{tutor.failed}</TableCell>
                <TableCell className="text-right">{minutes(tutor.medianLatencyMinutes)}</TableCell>
                <TableCell className="text-right">{usd(tutor.costUsd)}</TableCell>
                <TableCell>
                  <div className="flex items-center gap-2">
                    <Badge variant="outline" className={tutor.enabled ? "border-available/30 text-available" : "text-muted-foreground"}>
                      {tutor.enabled ? "On" : tutor.partlyEnabled ? "Partly on" : "Off"}
                    </Badge>
                    {canControl ? (
                      <Button size="xs" variant="ghost" disabled={busy}
                        onClick={() => void sendControl({ action: "tutor", wiseUserIds: tutor.wiseUserIds, enabled: !tutor.enabled },
                          `${tutor.enabled ? "Turn off" : "Turn on"} the autowriter for ${tutor.displayName} (both Wise accounts)?`)}>
                        {tutor.enabled ? "Turn off" : "Turn on"}
                      </Button>
                    ) : null}
                  </div>
                </TableCell>
              </TableRow>
            ))}
          </TableBody>
        </Table>
      </Section>

      <Section title="Recent classes" count={data.recent.length}>
        {data.recent.length === 0 ? (
          <p className="px-4 py-8 text-center text-sm text-muted-foreground">No classes handled in this window yet.</p>
        ) : (
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>Class ended (Bangkok)</TableHead>
                <TableHead>Tutor</TableHead>
                <TableHead>Class</TableHead>
                <TableHead>Status</TableHead>
                <TableHead>Model</TableHead>
                <TableHead className="text-right">To post</TableHead>
                <TableHead className="text-right">Cost</TableHead>
                <TableHead>Detail</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {data.recent.map((row) => (
                <TableRow key={row.wiseSessionId} className="align-top">
                  <TableCell className="whitespace-nowrap">{when(row.scheduledEndAt)}</TableCell>
                  <TableCell className="whitespace-nowrap">{row.tutor.replace(/ Online$/u, "")}</TableCell>
                  <TableCell className="max-w-48 truncate" title={row.className ?? undefined}>{row.className ?? "—"}</TableCell>
                  <TableCell>
                    <Badge variant="outline" className={cn("whitespace-nowrap", STATE_TONE[row.state])}>{STATE_LABEL[row.state] ?? row.state}</Badge>
                  </TableCell>
                  <TableCell className="whitespace-nowrap">
                    {row.arm === "luna" ? "GPT-6 Luna" : row.arm === "glm" ? "GLM Flash" : "—"}
                    {row.evidence === "transcript" ? <span className="ml-1 text-[10px] uppercase text-muted-foreground">· transcript</span> : null}
                  </TableCell>
                  <TableCell className="text-right whitespace-nowrap">{minutes(row.latencyMinutes)}</TableCell>
                  <TableCell className="text-right">{usd(row.costUsd)}</TableCell>
                  <TableCell className="min-w-64">
                    <details>
                      <summary className="cursor-pointer text-xs text-muted-foreground">
                        {row.reason && !["shadow", "verified"].includes(row.reason) ? row.reason.slice(0, 80) : "View"}
                      </summary>
                      <div className="mt-2 space-y-2 text-xs">
                        {row.fields ? FIELD_LABELS.map(([key, label]) => (
                          <div key={key}>
                            <div className="font-medium">{label}</div>
                            <p className="whitespace-pre-wrap text-muted-foreground">{row.fields?.[key] || "—"}</p>
                          </div>
                        )) : <p className="text-muted-foreground">No draft stored.</p>}
                        {row.judgeUnsupported.length > 0 ? (
                          <p className="text-amber-700">Judge flagged: {row.judgeUnsupported.join(" · ")}</p>
                        ) : null}
                        {row.reason ? <p className="text-muted-foreground">Reason: {row.reason}</p> : null}
                        {row.wiseUrl ? <a className="text-primary underline" href={row.wiseUrl} target="_blank" rel="noreferrer">Open in Wise</a> : null}
                      </div>
                    </details>
                  </TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        )}
      </Section>

      <div className="grid gap-4 lg:grid-cols-3">
        <Section title="Cost by model">
          <Table>
            <TableHeader><TableRow><TableHead>Model</TableHead><TableHead>Role</TableHead><TableHead className="text-right">Calls</TableHead><TableHead className="text-right">Cost</TableHead></TableRow></TableHeader>
            <TableBody>
              {data.cost.byModel.map((entry) => (
                <TableRow key={`${entry.role}-${entry.model}`}>
                  <TableCell title={entry.model}>{modelLabel(entry.model)}</TableCell>
                  <TableCell className="capitalize">{entry.role}</TableCell>
                  <TableCell className="text-right">{entry.calls}</TableCell>
                  <TableCell className="text-right">{usd(entry.costUsd)}</TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        </Section>
        <Section title="By day (Bangkok)">
          <Table>
            <TableHeader><TableRow><TableHead>Date</TableHead><TableHead className="text-right">Drafts</TableHead><TableHead className="text-right">Posted</TableHead><TableHead className="text-right">Cost</TableHead></TableRow></TableHeader>
            <TableBody>
              {data.cost.byDay.map((entry) => (
                <TableRow key={entry.date}>
                  <TableCell>{entry.date}</TableCell>
                  <TableCell className="text-right">{entry.drafts}</TableCell>
                  <TableCell className="text-right">{entry.posted}</TableCell>
                  <TableCell className="text-right">{usd(entry.costUsd)}</TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        </Section>
        <Section title="Wise webhooks (24 h)">
          <div className="space-y-3 px-4 py-3 text-sm">
            <p className="text-muted-foreground">Last delivery: {when(data.webhooks.lastReceivedAt)}</p>
            <ul className="space-y-1">
              {data.webhooks.byEvent.map((entry) => <li key={entry.eventName} className="flex justify-between"><span>{entry.eventName}</span><span>{entry.count}</span></li>)}
            </ul>
            <div className="border-t pt-2">
              <div className="mb-1 text-[10px] font-semibold uppercase text-muted-foreground">Outcomes</div>
              <ul className="space-y-1">
                {data.webhooks.byOutcome.map((entry) => <li key={entry.outcome} className="flex justify-between"><span>{entry.outcome}</span><span>{entry.count}</span></li>)}
              </ul>
            </div>
          </div>
        </Section>
      </div>
    </div>
  );
}
