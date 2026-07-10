"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { BellRingIcon, SendIcon } from "lucide-react";

import { SELECT_FIELD_CLASSES } from "@/components/admissions/field-classes";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import type { NotificationPreferencesDto } from "@/lib/admissions/communications";
import type { AdmissionsMemberDto } from "@/lib/admissions/types";

type PreferenceValue = "default" | "digest" | "off";

const PREFERENCE_LABELS: Record<PreferenceValue, string> = {
  default: "As they happen",
  digest: "Weekly digest",
  off: "Off",
};

function readError(payload: unknown, fallback: string): string {
  return payload && typeof payload === "object" && "error" in payload && typeof (payload as { error?: unknown }).error === "string"
    ? (payload as { error: string }).error
    : fallback;
}

export function NotificationPreferencesPanel({ caseId, compact = false }: { caseId: string; compact?: boolean }) {
  const [preferences, setPreferences] = useState<NotificationPreferencesDto | null>(null);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [saved, setSaved] = useState(false);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const response = await fetch(`/api/admissions/notification-preferences?caseId=${caseId}`);
      const payload: unknown = await response.json().catch(() => null);
      if (!response.ok) throw new Error(readError(payload, "Notification preferences could not be loaded."));
      if (payload && typeof payload === "object" && "preferences" in payload) {
        setPreferences((payload as { preferences: NotificationPreferencesDto }).preferences);
      }
    } catch (loadError) {
      setError(loadError instanceof Error ? loadError.message : "Notification preferences could not be loaded.");
    } finally {
      setLoading(false);
    }
  }, [caseId]);

  useEffect(() => { void load(); }, [load]);

  const save = async () => {
    if (!preferences) return;
    setSaving(true);
    setError(null);
    setSaved(false);
    try {
      const response = await fetch("/api/admissions/notification-preferences", {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          caseId,
          announcements: preferences.announcements,
          tasks: preferences.tasks,
          comments: preferences.comments,
        }),
      });
      const payload: unknown = await response.json().catch(() => null);
      if (!response.ok) throw new Error(readError(payload, "Notification preferences could not be saved."));
      setPreferences((payload as { preferences: NotificationPreferencesDto }).preferences);
      setSaved(true);
    } catch (saveError) {
      setError(saveError instanceof Error ? saveError.message : "Notification preferences could not be saved.");
    } finally {
      setSaving(false);
    }
  };

  return (
    <Card data-testid="notification-preferences">
      <CardHeader>
        <CardTitle className="flex items-center gap-2"><BellRingIcon aria-hidden className="size-4" /> Notifications</CardTitle>
        {!compact ? <CardDescription>Choose how routine updates reach you for this case.</CardDescription> : null}
      </CardHeader>
      <CardContent className="space-y-3">
        {loading ? <p className="text-sm text-muted-foreground">Loading preferences…</p> : null}
        {preferences ? (
          <>
            <div className="grid gap-3 sm:grid-cols-3">
              {(["announcements", "tasks", "comments"] as const).map((key) => (
                <label key={key} className="space-y-1 text-xs font-medium capitalize">
                  {key}
                  <select
                    className={SELECT_FIELD_CLASSES}
                    value={preferences[key]}
                    onChange={(event) => {
                      setSaved(false);
                      setPreferences((current) => current ? { ...current, [key]: event.target.value as PreferenceValue } : current);
                    }}
                  >
                    {Object.entries(PREFERENCE_LABELS).map(([value, label]) => <option key={value} value={value}>{label}</option>)}
                  </select>
                </label>
              ))}
            </div>
            <div className="flex flex-wrap items-center justify-between gap-2 rounded-lg border border-primary/20 bg-primary/5 p-3">
              <div><p className="text-sm font-medium">Deadline reminders</p><p className="text-xs text-muted-foreground">T-7 day and T-48 hour reminders cannot be disabled.</p></div>
              <Badge>Mandatory</Badge>
            </div>
            <div className="flex items-center gap-2"><Button size="sm" onClick={() => void save()} disabled={saving}>{saving ? "Saving…" : "Save preferences"}</Button>{saved ? <span role="status" className="text-xs text-available">Saved</span> : null}</div>
          </>
        ) : null}
        {error ? <p role="alert" className="text-sm text-destructive">{error}</p> : null}
      </CardContent>
    </Card>
  );
}

export function DirectMessageComposer({
  caseId,
  members,
  viewerEmail,
}: {
  caseId: string;
  members: AdmissionsMemberDto[];
  viewerEmail: string;
}) {
  const recipients = useMemo(
    () => members.filter((member) =>
      member.status === "active" && member.email.toLowerCase() !== viewerEmail.toLowerCase()),
    [members, viewerEmail],
  );
  const [recipientMemberId, setRecipientMemberId] = useState("");
  const [subject, setSubject] = useState("");
  const [body, setBody] = useState("");
  const [sending, setSending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [deliveryNotice, setDeliveryNotice] = useState<string | null>(null);
  const idempotencyKeyRef = useRef<string | null>(null);

  const draftChanged = () => {
    if (!sending) idempotencyKeyRef.current = null;
    setDeliveryNotice(null);
  };

  const send = async (event: React.FormEvent) => {
    event.preventDefault();
    setSending(true);
    setError(null);
    setDeliveryNotice(null);
    const idempotencyKey = idempotencyKeyRef.current ?? crypto.randomUUID();
    idempotencyKeyRef.current = idempotencyKey;
    try {
      const response = await fetch(`/api/admissions/cases/${caseId}/messages`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ recipientMemberId, idempotencyKey, subject, body }),
      });
      const payload: unknown = await response.json().catch(() => null);
      if (!response.ok) throw new Error(readError(payload, "Message could not be sent."));
      const queued = payload && typeof payload === "object" && "queued" in payload &&
        (payload as { queued?: unknown }).queued === true;
      const superseded = payload && typeof payload === "object" && "superseded" in payload &&
        (payload as { superseded?: unknown }).superseded === true;
      setSubject("");
      setBody("");
      idempotencyKeyRef.current = null;
      setDeliveryNotice(
        queued
          ? "Message queued for automatic retry."
          : superseded
            ? "Message was not delivered because the recipient is no longer eligible."
            : "Message sent.",
      );
    } catch (sendError) {
      setError(sendError instanceof Error ? sendError.message : "Message could not be sent.");
    } finally {
      setSending(false);
    }
  };

  return (
    <Card data-testid="direct-message-composer">
      <CardHeader><CardTitle className="flex items-center gap-2"><SendIcon aria-hidden className="size-4" /> Direct message</CardTitle><CardDescription>Send an email to an active case member. It is queued and audited before delivery, with automatic retry if the provider is unavailable.</CardDescription></CardHeader>
      <CardContent>
        {recipients.length === 0 ? <p className="text-sm text-muted-foreground">There are no other active members to message.</p> : (
          <form onSubmit={send} className="space-y-3">
            <label className="block space-y-1 text-xs font-medium">Recipient<select className={SELECT_FIELD_CLASSES} required value={recipientMemberId} onChange={(event) => { draftChanged(); setRecipientMemberId(event.target.value); }}><option value="">Choose a member</option>{recipients.map((member) => <option key={member.id} value={member.id}>{member.email} · {member.role}</option>)}</select></label>
            <label className="block space-y-1 text-xs font-medium">Subject<Input required maxLength={300} value={subject} onChange={(event) => { draftChanged(); setSubject(event.target.value); }} /></label>
            <label className="block space-y-1 text-xs font-medium">Message<Textarea required maxLength={20_000} value={body} onChange={(event) => { draftChanged(); setBody(event.target.value); }} /></label>
            <div className="flex items-center gap-2"><Button type="submit" size="sm" disabled={sending || !recipientMemberId || !subject.trim() || !body.trim()}>{sending ? "Sending…" : "Send message"}</Button>{deliveryNotice ? <span role="status" className="text-xs text-available">{deliveryNotice}</span> : null}</div>
            {error ? <p role="alert" className="text-sm text-destructive">{error}</p> : null}
          </form>
        )}
      </CardContent>
    </Card>
  );
}
