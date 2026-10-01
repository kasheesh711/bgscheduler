"use client";

import { useCallback, useEffect, useState } from "react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogDescription, DialogFooter } from "@/components/ui/dialog";
import type { feedbackMailboxStatus } from "@/lib/post-class-feedback/gmail-credentials";
import type { reminderLineStatus } from "@/lib/post-class-feedback/reminder-line";
import { formatBangkokDate } from "./feedback-ui";

type Connections = { mailbox: Awaited<ReturnType<typeof feedbackMailboxStatus>>; line: Awaited<ReturnType<typeof reminderLineStatus>> };
export function ReminderConnection({ disabled, live }: { disabled: boolean; live: boolean }) {
  const [connection, setConnection] = useState<Connections | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [message, setMessage] = useState<string | null>(null);
  const [resolving, setResolving] = useState<{ id: string; attempts: number } | null>(null);
  const [outcome, setOutcome] = useState<"accepted" | "not_sent">("accepted");
  const [receipt, setReceipt] = useState("");
  const [note, setNote] = useState("");
  const [emailCode, setEmailCode] = useState("");
  const [lineCode, setLineCode] = useState("");
  const load = useCallback(async () => {
    const response = await fetch("/api/post-class-feedback/email", { cache: "no-store" });
    const data = await response.json();
    if (!response.ok) throw new Error(data.error ?? "Could not load the reminder connection.");
    setConnection(data);
  }, []);
  useEffect(() => { void load().catch(e => setError(e.message)); }, [load]);
  async function action(action: string, code?: string, extra?: Record<string, unknown>) {
    setBusy(true); setError(null); setMessage(null);
    try {
      const response = await fetch("/api/post-class-feedback/email", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ action, code, ...extra }) });
      const data = await response.json();
      if (!response.ok) throw new Error(data.error ?? "Could not complete the connection action.");
      if (data.url) { window.location.assign(data.url); return; }
      setMessage(data.message ?? (data.confirmed ? "Receipt confirmed." : data.resolved ? "Alert reconciled. Later alerts can resume." : "Gmail authorization renewed."));
      if (action === "confirm") setEmailCode("");
      if (action === "line_confirm") setLineCode("");
      await load();
    } catch (e) { setError(e instanceof Error ? e.message : "Connection failed."); await load().catch(() => undefined); }
    finally { setBusy(false); }
  }
  const lock = disabled || busy;
  const mailbox = connection?.mailbox;
  const line = connection?.line;
  return <section aria-label="Reminder delivery connections" className="space-y-3 rounded-lg border p-3 text-sm">
    <div><h3 className="font-semibold">Reminder sender · admin@begiftededucation.com</h3>
      <p className="text-xs text-muted-foreground">{mailbox?.connected ? "Gmail connected" : "Gmail connection required"}. {mailbox?.refreshedAt ? `Last token renewal: ${formatBangkokDate(mailbox.refreshedAt, true)}.` : "Token renewal has not been verified."}</p>
      {mailbox && (!mailbox.configured || !mailbox.trusted) && <p className="mt-1 text-xs">Set up the dedicated Gmail client and have a Workspace administrator mark it Trusted before connecting.</p>}
      {mailbox?.lastError && <p role="alert" className="text-red-700">{mailbox.lastError}</p>}
    </div>
    {live && <p className="text-xs text-muted-foreground">Pause reminders before reconnecting or sending new connection tests.</p>}
    <div className="flex flex-wrap gap-2">
      <Button size="sm" variant="outline" disabled={lock || live || !mailbox?.configured || !mailbox.trusted || !mailbox.available} onClick={() => void action("connect")}>{mailbox?.connected ? "Reconnect Gmail" : "Connect Gmail"}</Button>
      <Button size="sm" variant="outline" disabled={lock || !mailbox?.connected} onClick={() => void action("renew")}>Verify token renewal</Button>
      <Button size="sm" variant="outline" disabled={lock || live || !mailbox?.connected} onClick={() => void action("test")}>Send test email to me</Button>
    </div>
    <div className="flex flex-wrap items-end gap-2">
      <label className="text-xs">Code from your receiving inbox<Input aria-label="Email receipt code" value={emailCode} onChange={e => setEmailCode(e.target.value)} autoComplete="off" className="mt-1 w-56" /></label>
      <Button size="sm" disabled={lock || !emailCode.trim()} onClick={() => void action("confirm", emailCode)}>Confirm email receipt</Button>
    </div>
    <p className="text-xs text-muted-foreground">{mailbox?.testConfirmedAt ? `Email receipt confirmed ${formatBangkokDate(mailbox.testConfirmedAt, true)}.` : mailbox?.testAcceptedAt ? "Google accepted the test; inbox receipt still needs confirmation." : "Send a test, then enter the code from your inbox."}</p>
    <div className="border-t pt-3"><h3 className="font-semibold">Private LINE alerts to Kevin</h3>
      <p className="text-xs text-muted-foreground">{line?.verified ? "Private destination verified." : "Confirm a generic test before enabling alerts."} {line?.pending ? `${line.pending} alerts await acceptance.` : ""}</p></div>
    <div className="flex flex-wrap items-end gap-2">
      <Button size="sm" variant="outline" disabled={lock || live || !line?.configured} onClick={() => void action("line_test")}>Send private LINE test</Button>
      <label className="text-xs">Code from Kevin’s private chat<Input aria-label="LINE receipt code" value={lineCode} onChange={e => setLineCode(e.target.value)} autoComplete="off" className="mt-1 w-56" /></label>
      <Button size="sm" disabled={lock || !lineCode.trim()} onClick={() => void action("line_confirm", lineCode)}>Confirm LINE receipt</Button>
    </div>
    {line?.alertError && <p role="alert" className="text-red-700">{line.alertError}</p>}
    {line?.blockedAlerts.map(alert => <div key={alert.id} className="flex flex-wrap items-center gap-2 text-xs">
      <span>Blocked {alert.kind} alert · {formatBangkokDate(alert.createdAt, true)}</span>
      <Button size="xs" variant="outline" onClick={() => { setResolving(alert); setReceipt(""); setNote(""); }}>Reconcile alert</Button>
    </div>)}
    <Dialog open={Boolean(resolving)} onOpenChange={open => { if (!open) setResolving(null); }}><DialogContent>
      <DialogHeader><DialogTitle>Reconcile private LINE alert</DialogTitle><DialogDescription>Check Kevin’s private chat first. This closes the blocked alert and lets later alerts proceed. A closed alert is not resent.</DialogDescription></DialogHeader>
      <label className="grid gap-1 text-sm">Verified outcome<select className="rounded border p-2" value={outcome} onChange={e => setOutcome(e.target.value as typeof outcome)}><option value="accepted">Alert was received</option><option value="not_sent">Verified that it did not arrive</option></select></label>
      {outcome === "accepted" && <label className="grid gap-1 text-sm">Message reference<Input value={receipt} onChange={e => setReceipt(e.target.value)} /></label>}
      <label className="grid gap-1 text-sm">Evidence checked<Textarea value={note} onChange={e => setNote(e.target.value)} /></label>
      <DialogFooter><Button variant="outline" onClick={() => setResolving(null)}>Cancel</Button><Button disabled={lock || note.trim().length < 10 || (outcome === "accepted" && !receipt.trim())} onClick={() => { if (resolving) void action("line_resolve", undefined, { id: resolving.id, expectedAttempts: resolving.attempts, outcome, receipt, note }); setResolving(null); }}>Record outcome</Button></DialogFooter>
    </DialogContent></Dialog>
    {message && <p role="status">{message}</p>}
    {error && <p role="alert" className="text-red-700">{error}</p>}
  </section>;
}
