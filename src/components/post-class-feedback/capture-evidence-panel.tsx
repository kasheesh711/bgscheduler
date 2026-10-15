"use client";
import { useCallback, useEffect, useId, useState } from "react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import type { CaptureBinding } from "@/lib/post-class-feedback/capture-model";

type CaptureRow = { id: string; state: string; timing: string; mode: string; capturedAt: string; observedAt: string; uploadStatus: string; uploadError: string | null; imageUrl: string | null; conflict: boolean; duringCapture: boolean; currentDeadline: boolean; currentClass: boolean; note: string };
type Evidence = { binding: CaptureBinding; captures: CaptureRow[] };
function bangkokInput(at = new Date()) { return new Date(at.getTime() + 7 * 60 * 60_000).toISOString().slice(0, 19); }
const showTime = (at: string) => new Intl.DateTimeFormat("en-GB", { timeZone: "Asia/Bangkok", dateStyle: "medium", timeStyle: "medium" }).format(new Date(at));

export function CaptureEvidencePanel({ sessionId, canUpload }: { sessionId: string; canUpload: boolean }) {
  const prefix = useId();
  const [evidence, setEvidence] = useState<Evidence | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const [mode, setMode] = useState("current");
  const [state, setState] = useState("uncheckable");
  const [observed, setObserved] = useState(bangkokInput);
  const [captured, setCaptured] = useState(bangkokInput);
  const [note, setNote] = useState("");
  const [image, setImage] = useState<File | null>(null);
  const load = useCallback(async () => {
    const response = await fetch(`/api/post-class-feedback/captures?sessionId=${encodeURIComponent(sessionId)}`, { cache: "no-store" });
    const payload = await response.json();
    if (!response.ok) throw new Error(payload.error ?? "Could not load evidence.");
    setEvidence(payload);
  }, [sessionId]);
  useEffect(() => { load().catch(cause => setError(cause.message)); }, [load]);
  async function submit(event: React.FormEvent) {
    event.preventDefault();
    if (!evidence) return;
    setSaving(true); setError(null);
    try {
      const metadata = { ...evidence.binding, mode, state, note, observedAt: new Date(`${observed}+07:00`).toISOString(), capturedAt: new Date(`${captured}+07:00`).toISOString() };
      const form = new FormData(); form.set("sessionId", sessionId); form.set("metadata", JSON.stringify(metadata)); if (image) form.set("image", image);
      const response = await fetch("/api/post-class-feedback/captures", { method: "POST", body: form });
      const result = await response.json();
      await load();
      if (!response.ok) throw new Error(result.uploadError ?? result.error ?? "Evidence save failed.");
    } catch (cause) { setError(cause instanceof Error ? cause.message : "Evidence save failed."); }
    finally { setSaving(false); }
  }
  return <section className="space-y-3 rounded-lg border bg-card p-4" aria-label="Wise screenshot evidence">
    <h3 className="font-medium">Wise screenshot evidence</h3>
    <p className="text-xs text-muted-foreground">Times are in Bangkok. Images show the state at the recorded capture time. Evidence does not change deductions.</p>
    {error && <p role="alert" className="text-sm text-destructive">{error}</p>}
    {!evidence ? <p className="text-sm">Loading evidence…</p> : <>
      {!evidence.captures.some(row => row.currentDeadline && row.currentClass && row.mode === "deadline" && row.uploadStatus === "ready") && <p className="text-sm">Missing deadline screenshot evidence.</p>}
      {evidence.captures.map(row => <div key={row.id} className="space-y-1 rounded border p-3 text-sm">
        <p>{row.state} · {row.timing.replaceAll("_", " ")} · {row.uploadStatus}</p>
        <p>Observed: {showTime(row.observedAt)}. Captured: {showTime(row.capturedAt)}.</p>
        {row.conflict && <p role="alert" className="text-destructive">Staff submission event conflicts with this missing-feedback observation. Review both records.</p>}
        {row.duringCapture && <p role="alert" className="text-destructive">Staff feedback was submitted between observation and capture. The image can show an earlier page state.</p>}
        {!row.currentDeadline && <p>The class deadline changed. This image belongs to the earlier deadline.</p>}
        {!row.currentClass && row.currentDeadline && <p>The class identity changed. This image belongs to the earlier tutor, student, or subject.</p>}
        {row.note && <p>{row.note}</p>}{row.uploadError && <p role="alert">{row.uploadError}</p>}
        {row.imageUrl && <details><summary className="cursor-pointer">Open screenshot</summary>
          {/* Tool screenshots must retain their original pixels. */}
          {/* eslint-disable-next-line @next/next/no-img-element */}
          <img src={row.imageUrl} alt={`Wise class feedback: ${row.state}, captured ${showTime(row.capturedAt)}`} className="mt-2 max-w-full rounded" loading="lazy" />
        </details>}
      </div>)}
      {canUpload && <details><summary className="cursor-pointer text-sm font-medium">Add screenshot or failed-check result</summary>
        <form onSubmit={submit} className="mt-3 space-y-3">
          <p className="text-sm">{evidence.binding.tutorName} — {evidence.binding.students.join(", ")} — {evidence.binding.subject}<br />Deadline: {showTime(evidence.binding.deadlineAt)}</p>
          <fieldset className="flex flex-wrap gap-3 text-sm"><legend>Check type</legend>{[["deadline", "Deadline capture"], ["current", "Later check"]].map(([value, label]) => <label key={value}><input type="radio" name={`${prefix}-mode`} checked={mode === value} onChange={() => setMode(value)} /> {label}</label>)}</fieldset>
          <fieldset className="flex flex-wrap gap-3 text-sm"><legend>Tutor feedback state</legend>{[["missing", "Missing"], ["present", "Present"], ["uncheckable", "Cannot check"]].map(([value, label]) => <label key={value}><input type="radio" name={`${prefix}-state`} checked={state === value} onChange={() => setState(value)} /> {label}</label>)}</fieldset>
          <label className="block text-sm" htmlFor={`${prefix}-observed`}>Observation time (Bangkok)</label><Input id={`${prefix}-observed`} type="datetime-local" step="1" required value={observed} onChange={event => setObserved(event.target.value)} />
          <label className="block text-sm" htmlFor={`${prefix}-captured`}>Capture time (Bangkok)</label><Input id={`${prefix}-captured`} type="datetime-local" step="1" required value={captured} onChange={event => setCaptured(event.target.value)} />
          <label className="block text-sm" htmlFor={`${prefix}-image`}>Screenshot (PNG or JPEG, maximum 4 MB)</label><Input id={`${prefix}-image`} type="file" accept="image/png,image/jpeg" onChange={event => setImage(event.target.files?.[0] ?? null)} />
          <label className="block text-sm" htmlFor={`${prefix}-note`}>Note or check failure</label><Textarea id={`${prefix}-note`} maxLength={2000} value={note} onChange={event => setNote(event.target.value)} />
          <Button type="submit" disabled={saving}>{saving ? "Saving…" : "Save evidence"}</Button>
        </form>
      </details>}
    </>}
  </section>;
}
