"use client";

import { useCallback, useEffect, useState } from "react";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogDescription, DialogFooter } from "@/components/ui/dialog";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import type { FeedbackNightlyHistoryRow, PostClassFeedbackPayload } from "@/types/post-class-feedback";
import type { SettingsRequest } from "./settings-tab";
import { formatBangkokDate } from "./feedback-ui";
import { ReminderConnection } from "./reminder-connection";

type HistoryRow = FeedbackNightlyHistoryRow;
interface Preview { tutorKey: string; classes: number; html: string; recipient: { email: string | null } }

export function NightlyRemindersPanel({ payload, submitting, onRequest }: {
  payload: PostClassFeedbackPayload; submitting: boolean; onRequest: SettingsRequest;
}) {
  const [history, setHistory] = useState<HistoryRow[]>([]);
  const [previews, setPreviews] = useState<Preview[]>([]);
  const [preview, setPreview] = useState<Preview | null>(null);
  const [tutorKey, setTutorKey] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [activate, setActivate] = useState(false);
  const [legacyDisabled, setLegacyDisabled] = useState(false);
  const [resolving, setResolving] = useState<HistoryRow | null>(null);
  const [outcome, setOutcome] = useState<"accepted" | "not_sent">("accepted");
  const [receipt, setReceipt] = useState("");
  const [note, setNote] = useState("");
  const health = payload.nightlyReminders;
  const canManage = payload.capabilities.accessManager;
  const load = useCallback(async () => {
    try {
      const params = new URLSearchParams({ preview: String(canManage) });
      if (tutorKey) params.set("tutorKey", tutorKey);
      const response = await fetch(`/api/post-class-feedback/reminders?${params}`);
      const data = await response.json();
      if (!response.ok) throw new Error(data.error ?? "Could not load reminder history.");
      setHistory(data.history); setPreviews(data.previews); setError(null);
    } catch (e) { setError(e instanceof Error ? e.message : "Could not load reminder history."); }
  }, [canManage, tutorKey]);
  useEffect(() => { void load(); }, [load, payload.settings.version, health?.runId, submitting]);
  async function mode(reminderMode: "off" | "shadow" | "live") {
    await onRequest("/api/post-class-feedback/settings", "PATCH", { reminderMode,
      ...(reminderMode === "live" ? { legacyReminderDisabled: legacyDisabled || Boolean(health?.legacyDisabledAt) } : {}),
      expectedVersion: payload.settings.version });
    setActivate(false);
  }
  async function resolve() {
    if (!resolving?.deliveryId || !resolving.attemptCount) return;
    await onRequest("/api/post-class-feedback/reminders", "POST", { action: "resolve", deliveryId: resolving.deliveryId,
      expectedAttempt: resolving.attemptCount, outcome, receipt, note });
    setResolving(null); setNote(""); setReceipt(""); await load();
  }
  return <Card className="gap-4 rounded-xl p-4 shadow-sm">
    <div className="flex flex-wrap items-start justify-between gap-3">
      <div><h2 className="font-heading text-sm font-semibold">Nightly feedback reminders</h2>
        <p className="mt-1 text-xs text-muted-foreground">One grouped email per tutor at 22:00 Bangkok. Recovery checks run every 30 minutes.</p></div>
      <Badge variant="outline">{health?.mode ?? "off"} · {health?.status ?? "loading"}</Badge>
    </div>
    <p className="text-sm" role="status">{health?.detail ?? "Loading reminder coverage…"}</p>
    {health && <dl className="grid grid-cols-2 gap-3 text-sm sm:grid-cols-4">
      {[["Classes checked", health.counts.considered], ["Notified", health.counts.sent], ["Pending", health.counts.pending + health.counts.ready],
        ["Source blocked", health.counts.blockedSource], ["Email missing", health.counts.blockedRecipient], ["Uncertain deliveries", health.unresolvedDeliveries],
        ["Missed deadline", health.counts.expired], ["Coverage gaps", health.coverageGaps], ["Accepted emails", health.acceptedEmails], ["Excluded", health.counts.excluded], ["Failed", health.counts.failed]].map(([label, value]) =>
        <div key={label} className="rounded-lg bg-muted/40 p-2"><dt className="text-xs text-muted-foreground">{label}</dt><dd className="mt-1 font-semibold tabular-nums">{value}</dd></div>)}
    </dl>}
    {health?.alertDeliveryError && <p role="alert" className="text-sm text-red-700">{health.alertDeliveryError}</p>}
    {health?.sourceCheckedAt && <p className="text-xs text-muted-foreground">Source verified {formatBangkokDate(health.sourceCheckedAt, true)}. Accepted messages have a sending-service receipt; this does not confirm inbox delivery.</p>}
    {canManage && <ReminderConnection disabled={submitting} live={health?.mode === "live"} />}
    {health?.lastCompletedBatch && <p className="text-xs text-muted-foreground">Last completed live batch: {formatBangkokDate(health.lastCompletedBatch, true)}.</p>}
    {canManage && <div className="flex flex-wrap gap-2">
      <Button size="sm" variant="outline" disabled={submitting || health?.mode === "off"} onClick={() => void mode("off")}>Pause reminders</Button>
      <Button size="sm" variant="outline" disabled={submitting || health?.mode === "shadow"} onClick={() => void mode("shadow")}>Shadow mode</Button>
      <Button size="sm" disabled={submitting || health?.mode === "live"} onClick={() => setActivate(true)}>Enable live reminders</Button>
      {health?.mode === "shadow" && <Button size="sm" variant="outline" disabled={submitting} onClick={() => void onRequest("/api/post-class-feedback/reminders", "POST", { action: "shadow_preview" })}>Build shadow preview</Button>}
      <Button size="sm" variant="outline" disabled={submitting || health?.mode === "off"} onClick={() => void onRequest("/api/post-class-feedback/reminders", "POST", { action: "retry" })}>Process due reminders</Button>
    </div>}
    <p className="text-xs text-muted-foreground">Reminder controls operate independently of deductions.</p>
    {previews.length > 0 && <div className="flex flex-wrap gap-2">{previews.map((item) =>
      <Button key={item.tutorKey} size="sm" variant="outline" onClick={() => setPreview(item)}>Preview {item.tutorKey} · {item.classes} classes</Button>)}</div>}
    <div className="flex flex-wrap items-center gap-3"><h3 className="text-sm font-semibold">Reminder history</h3>
      <label className="text-xs">Tutor <Input className="mt-1 w-48" value={tutorKey} onChange={(e) => setTutorKey(e.target.value)} placeholder="Exact tutor name, e.g. Buzz" /></label>
      <Button size="sm" variant="ghost" onClick={() => void load()}>Refresh</Button></div>
    {error && <p role="alert" className="text-sm text-red-700">{error}</p>}
    <div className="max-h-80 overflow-auto"><Table><TableHeader><TableRow><TableHead>Night</TableHead><TableHead>Tutor / class</TableHead><TableHead>Outcome</TableHead><TableHead>Evidence</TableHead><TableHead>Action</TableHead></TableRow></TableHeader>
      <TableBody>{history.map((row) => <TableRow key={row.id}><TableCell className="whitespace-nowrap">{row.date}<div className="text-xs text-muted-foreground">{row.mode}</div></TableCell>
        <TableCell>{row.tutorKey ?? "Unresolved"}<div className="text-xs">{row.className ?? row.wiseSessionId}</div><div className="text-xs text-muted-foreground">{formatBangkokDate(row.scheduledEndAt, true)}</div></TableCell><TableCell>{row.status.replaceAll("_", " ")}</TableCell>
        <TableCell className="max-w-sm whitespace-normal text-xs">{row.reason}{row.sentAt && <div>{formatBangkokDate(row.sentAt, true)}</div>}{row.receipt && <div className="break-all">Receipt: {row.receipt}</div>}</TableCell>
        <TableCell>{canManage && row.status === "unknown" && row.deliveryId && <Button size="xs" variant="outline" onClick={() => { setResolving(row); setReceipt(""); setNote(""); }}>Resolve</Button>}</TableCell></TableRow>)}</TableBody></Table></div>
    <Dialog open={activate} onOpenChange={setActivate}><DialogContent><DialogHeader><DialogTitle>Enable nightly reminders</DialogTitle><DialogDescription>Complete a current shadow batch, verify Gmail token renewal, and confirm the email and private LINE test receipts. Activation starts at the next 22:00 Bangkok checkpoint.</DialogDescription></DialogHeader>
      <label className="flex items-start gap-2 text-sm"><input type="checkbox" checked={legacyDisabled || Boolean(health?.legacyDisabledAt)} onChange={(e) => setLegacyDisabled(e.target.checked)} />Only sendMissingCommentsReminders has been disabled and checked. The other four legacy triggers remain active.</label>
      <DialogFooter><Button variant="outline" onClick={() => setActivate(false)}>Cancel</Button><Button disabled={submitting || !(legacyDisabled || health?.legacyDisabledAt)} onClick={() => void mode("live")}>Enable reminders</Button></DialogFooter></DialogContent></Dialog>
    <Dialog open={Boolean(resolving)} onOpenChange={(open) => { if (!open) setResolving(null); }}><DialogContent><DialogHeader><DialogTitle>Resolve uncertain email</DialogTitle><DialogDescription>Check the sending mailbox. This decision is recorded with your evidence and name.</DialogDescription></DialogHeader>
      <label className="grid gap-1 text-sm">Verified outcome<select className="rounded border p-2" value={outcome} onChange={(e) => setOutcome(e.target.value as typeof outcome)}><option value="accepted">Message was sent</option><option value="not_sent">Verified that it was not sent</option></select></label>
      {outcome === "accepted" && <label className="grid gap-1 text-sm">Message receipt or mailbox reference<Input value={receipt} onChange={(e) => setReceipt(e.target.value)} /></label>}
      <label className="grid gap-1 text-sm">Evidence checked<Textarea value={note} onChange={(e) => setNote(e.target.value)} /></label>
      <DialogFooter><Button variant="outline" onClick={() => setResolving(null)}>Cancel</Button><Button disabled={submitting || note.trim().length < 10 || (outcome === "accepted" && !receipt.trim())} onClick={() => void resolve()}>Record outcome</Button></DialogFooter></DialogContent></Dialog>
    <Dialog open={Boolean(preview)} onOpenChange={(open) => { if (!open) setPreview(null); }}><DialogContent className="max-w-3xl"><DialogHeader><DialogTitle>Email preview · {preview?.tutorKey}</DialogTitle><DialogDescription>{preview?.recipient.email}</DialogDescription></DialogHeader>
      {preview && <iframe title="Nightly reminder email preview" sandbox="" srcDoc={preview.html} className="h-[65vh] w-full rounded border" />}</DialogContent></Dialog>
  </Card>;
}
