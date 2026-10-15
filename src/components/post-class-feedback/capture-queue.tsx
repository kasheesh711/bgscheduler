"use client";
import { useEffect, useState } from "react";
import Link from "next/link";
import { Input } from "@/components/ui/input";
import { CaptureEvidencePanel } from "./capture-evidence-panel";
import type { CaptureBinding } from "@/lib/post-class-feedback/capture-model";

export function CaptureQueue({ canUpload, initialDate, sessionId }: { canUpload: boolean; initialDate: string; sessionId: string | null }) {
  const [date, setDate] = useState(initialDate);
  const [classes, setClasses] = useState<Array<{ id: string; startAt: string; endAt: string; sourceStatus: string; contentStatus: string; wiseUrl: string; binding: CaptureBinding }>>([]);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(!sessionId);
  const [complete, setComplete] = useState(false);
  const [dueCount, setDueCount] = useState(0);
  const [unresolvedCount, setUnresolvedCount] = useState(0);
  useEffect(() => {
    if (sessionId) return;
    const controller = new AbortController();
    fetch(`/api/post-class-feedback/captures?date=${encodeURIComponent(date)}`, { signal: controller.signal, cache: "no-store" })
      .then(async response => { const payload = await response.json(); if (!response.ok) throw new Error(payload.error ?? "Queue could not be loaded."); setClasses(payload.classes); setComplete(payload.complete); setDueCount(payload.dueClassCount); setUnresolvedCount(payload.unresolvedClassCount); })
      .catch(cause => { if (!controller.signal.aborted) setError(cause.message); }).finally(() => { if (!controller.signal.aborted) setLoading(false); });
    return () => controller.abort();
  }, [date, sessionId]);
  return <main className="mx-auto max-w-5xl space-y-5 p-4 sm:p-6">
    <Link className="text-sm underline" href="/post-class-feedback">Class Feedback</Link>
    <h1 className="text-2xl font-semibold">Wise feedback evidence</h1>
    <p>Open only the listed deduction candidates in Wise. Check fresh feedback after the deadline. The capture window ends at 00:15 Bangkok.</p>
    {sessionId ? <CaptureEvidencePanel sessionId={sessionId} canUpload={canUpload} /> : <>
      <label htmlFor="capture-date">Deadline date (Bangkok)</label><Input id="capture-date" type="date" value={date} onChange={event => { setLoading(true); setError(null); setDate(event.target.value); }} />
      {loading && <p>Loading due classes…</p>}{error && <p role="alert">{error}</p>}
      {!loading && !error && <p>{classes.length} classes need deduction evidence, from {dueCount} classes with this deadline. {unresolvedCount} classes need source review. Compliant, waived, and reversed classes are excluded.</p>}
      {!loading && !error && !complete && <p role="alert">Incomplete source coverage. Check the listed classes, but do not treat this queue as a complete Wise check.</p>}
      {classes.map(row => <section key={row.id} className="space-y-3 rounded border p-4">
        <h2 className="font-medium">{row.binding.tutorName} — {row.binding.students.join(", ")} — {row.binding.subject}</h2>
        <p className="text-sm">Wise session: {row.binding.wiseSessionId}. Start: {new Date(row.startAt).toLocaleString("en-GB", { timeZone: "Asia/Bangkok" })}. End: {new Date(row.endAt).toLocaleString("en-GB", { timeZone: "Asia/Bangkok" })}. Source: {row.sourceStatus}.</p>
        <a className="text-sm underline" href={row.wiseUrl} target="_blank" rel="noreferrer">Open this class in Wise</a>
        <CaptureEvidencePanel sessionId={row.id} canUpload={canUpload} />
      </section>)}
    </>}
  </main>;
}
