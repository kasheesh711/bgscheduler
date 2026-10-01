"use client";

import { useCallback, useEffect, useState } from "react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import type { feedbackMailboxStatus } from "@/lib/post-class-feedback/gmail-credentials";
import type { reminderLineStatus } from "@/lib/post-class-feedback/reminder-line";
import { formatBangkokDate } from "./feedback-ui";

type Connections = { mailbox: Awaited<ReturnType<typeof feedbackMailboxStatus>>; line: Awaited<ReturnType<typeof reminderLineStatus>> };
export function ReminderConnection({ disabled }: { disabled: boolean }) {
  const [connection, setConnection] = useState<Connections | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [message, setMessage] = useState<string | null>(null);
  const [emailCode, setEmailCode] = useState("");
  const [lineCode, setLineCode] = useState("");
  const load = useCallback(async () => {
    const response = await fetch("/api/post-class-feedback/email", { cache: "no-store" });
    const data = await response.json();
    if (!response.ok) throw new Error(data.error ?? "Could not load the reminder connection.");
    setConnection(data);
  }, []);
  useEffect(() => { void load().catch(e => setError(e.message)); }, [load]);
  async function action(action: string, code?: string) {
    setBusy(true); setError(null); setMessage(null);
    try {
      const response = await fetch("/api/post-class-feedback/email", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ action, code }) });
      const data = await response.json();
      if (!response.ok) throw new Error(data.error ?? "Could not complete the connection action.");
      if (data.url) { window.location.assign(data.url); return; }
      setMessage(data.message ?? (data.confirmed ? "Receipt confirmed." : "Gmail authorization renewed."));
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
    <div className="flex flex-wrap gap-2">
      <Button size="sm" variant="outline" disabled={lock || !mailbox?.configured || !mailbox.trusted || !mailbox.available} onClick={() => void action("connect")}>{mailbox?.connected ? "Reconnect Gmail" : "Connect Gmail"}</Button>
      <Button size="sm" variant="outline" disabled={lock || !mailbox?.connected} onClick={() => void action("renew")}>Verify token renewal</Button>
      <Button size="sm" variant="outline" disabled={lock || !mailbox?.connected} onClick={() => void action("test")}>Send test email to me</Button>
    </div>
    <div className="flex flex-wrap items-end gap-2">
      <label className="text-xs">Code from your receiving inbox<Input aria-label="Email receipt code" value={emailCode} onChange={e => setEmailCode(e.target.value)} autoComplete="off" className="mt-1 w-56" /></label>
      <Button size="sm" disabled={lock || !emailCode.trim()} onClick={() => void action("confirm", emailCode)}>Confirm email receipt</Button>
    </div>
    <p className="text-xs text-muted-foreground">{mailbox?.testConfirmedAt ? `Email receipt confirmed ${formatBangkokDate(mailbox.testConfirmedAt, true)}.` : mailbox?.testAcceptedAt ? "Google accepted the test; inbox receipt still needs confirmation." : "Send a test, then enter the code from your inbox."}</p>
    <div className="border-t pt-3"><h3 className="font-semibold">Private LINE alerts to Kevin</h3>
      <p className="text-xs text-muted-foreground">{line?.verified ? "Private destination verified." : "Confirm a generic test before enabling alerts."} {line?.pending ? `${line.pending} alerts await acceptance.` : ""}</p></div>
    <div className="flex flex-wrap items-end gap-2">
      <Button size="sm" variant="outline" disabled={lock || !line?.configured} onClick={() => void action("line_test")}>Send private LINE test</Button>
      <label className="text-xs">Code from Kevin’s private chat<Input aria-label="LINE receipt code" value={lineCode} onChange={e => setLineCode(e.target.value)} autoComplete="off" className="mt-1 w-56" /></label>
      <Button size="sm" disabled={lock || !lineCode.trim()} onClick={() => void action("line_confirm", lineCode)}>Confirm LINE receipt</Button>
    </div>
    {line?.alertError && <p role="alert" className="text-red-700">{line.alertError}</p>}
    {message && <p role="status">{message}</p>}
    {error && <p role="alert" className="text-red-700">{error}</p>}
  </section>;
}
