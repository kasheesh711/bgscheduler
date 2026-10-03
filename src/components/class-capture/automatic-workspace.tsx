"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { upload } from "@vercel/blob/client";
import { Button } from "@/components/ui/button";
import { Textarea } from "@/components/ui/textarea";
import { RecordingPanel } from "./recording-panel";
import { WorksheetGallery } from "./worksheet-gallery";
import { LocalRecovery } from "@/lib/class-capture/local-recovery";
import { MAX_AUDIO_BYTES, type CaptureAsset, type CaptureView, type DraftFields } from "@/lib/class-capture/model";
import { captureRequest, CaptureRequestError, DRAFT_LABELS, EMPTY_DRAFT, feedbackText, prepareLocalFile, validateLocalFile, clearCapturePointer, type LocalMedia } from "./client-helpers";
import { optimizeWorksheet } from "./photo-preparation";

type Props = { initialCapture: CaptureView; ownerEmail: string; initialFiles: LocalMedia[]; onDeleted: () => void };
export function AutomaticCaptureWorkspace({ initialCapture, ownerEmail, initialFiles, onDeleted }: Props) {
  const [capture, setCapture] = useState(initialCapture);
  const current = useRef(initialCapture);
  const [files, setFiles] = useState(initialFiles);
  const filesRef = useRef(initialFiles);
  const [fields, setFields] = useState<DraftFields>(initialCapture.draft ?? EMPTY_DRAFT);
  const fieldsRef = useRef(fields);
  const dirty = useRef(0);
  const saved = useRef(0);
  const saving = useRef(false);
  const editBase = useRef<CaptureView | null>(null);
  const [saveStatus, setSaveStatus] = useState("Saved");
  const [error, setError] = useState<string | null>(null);
  const [permission, setPermission] = useState(false);
  const [consent, setConsent] = useState(false);
  const [recording, setRecording] = useState(false);
  const recordingRef = useRef(false);
  const [progress, setProgress] = useState<Record<string, number>>({});
  const [failures, setFailures] = useState<Record<string, string>>({});
  const [online, setOnline] = useState(true);
  const [approving, setApproving] = useState(false);
  const [deleting, setDeleting] = useState(false);
  const audioInput = useRef<HTMLInputElement>(null);
  const photoInput = useRef<HTMLInputElement>(null);
  const recovery = useRef<LocalRecovery | null>(null);
  const controllers = useRef(new Map<string, AbortController>());
  const queue = useRef<LocalMedia[]>([]);
  const running = useRef(new Set<string>());
  const uploadRetries = useRef(new Map<string, number>());
  const mounted = useRef(true);
  const saveTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const init = useRef(false);
  const photoPreparation = useRef<Promise<unknown>>(Promise.resolve());
  const automatic = capture.automatic;

  const apply = useCallback((next: CaptureView) => {
    if (!mounted.current || next.version < current.current.version) return;
    current.current = next; setCapture(next);
    if (dirty.current === saved.current && !saving.current && next.draft) { fieldsRef.current = next.draft; setFields(next.draft); }
  }, []);
  const refresh = useCallback(async () => { const result = await captureRequest<{ capture: CaptureView }>(`/${initialCapture.id}`); apply(result.capture); return result.capture; }, [initialCapture.id, apply]);
  const process = useCallback(async (action: object) => { const result = await captureRequest<{ capture: CaptureView }>(`/${initialCapture.id}/process`, "POST", action); apply(result.capture); }, [initialCapture.id, apply]);
  function updateFiles(next: LocalMedia[]) { filesRef.current = next; setFiles(next); }
  function mergeAsset(asset: CaptureAsset) {
    const next = { ...current.current, assets: [...current.current.assets.filter(a => a.id !== asset.id), asset] };
    current.current = next; setCapture(next);
  }

  async function send(file: LocalMedia) {
    const abort = new AbortController(); controllers.current.set(file.id, abort);
    setProgress(p => ({ ...p, [file.id]: 0 })); setFailures(p => { const n = { ...p }; delete n[file.id]; return n; });
    try {
      let blob = file.blob;
      if (file.kind === "worksheet" && file.blob instanceof File) {
        const original = file.blob;
        const preparation = photoPreparation.current.then(() => optimizeWorksheet(original));
        photoPreparation.current = preparation.catch(() => undefined);
        blob = await preparation;
      }
      else if (file.blob instanceof File) blob = await prepareLocalFile(file.blob, file.kind);
      const invalid = validateLocalFile(blob, file.kind); if (invalid) throw new Error(invalid);
      const prepared = { ...file, blob }; updateFiles(filesRef.current.map(f => f.id === file.id ? prepared : f));
      const store = recovery.current ??= new LocalRecovery();
      try {
        if (!(await store.load(ownerEmail, file.id))) {
          await store.create(ownerEmail, { captureId: initialCapture.id, assetId: file.id, kind: file.kind, name: file.name, mime: blob.type });
          await store.append(ownerEmail, file.id, blob); await store.finish(ownerEmail, file.id);
        }
      } catch { setError("Local recovery is unavailable. Keep this page open until uploads finish."); }
      if (abort.signal.aborted || !mounted.current) return;
      const existing = current.current.assets.find(a => a.id === file.id);
      if (existing && existing.status !== "pending") return;
      const { asset } = await captureRequest<{ asset: CaptureAsset }>(`/${initialCapture.id}/assets`, "POST", { id: file.id, kind: file.kind, mime: blob.type.split(";")[0], size: blob.size, ...(file.kind === "worksheet" ? { worksheetPermission: true } : {}) });
      mergeAsset(asset);
      if (asset.status !== "pending") return;
      if (existing) {
        try {
          const finished = await captureRequest<{ asset: CaptureAsset }>(`/${initialCapture.id}/assets/${file.id}?automatic=1`, "POST", {});
          mergeAsset(finished.asset); await store.remove(ownerEmail, file.id); return;
        } catch (e) { if (!(e instanceof CaptureRequestError) || ![404, 409].includes(e.status)) throw e; }
      }
      if (abort.signal.aborted || !mounted.current) return;
      await upload(asset.pathname, blob, { access: "private", contentType: blob.type.split(";")[0], handleUploadUrl: "/api/class-capture/uploads", clientPayload: file.id,
        multipart: file.kind !== "worksheet" || blob.size > 4 * 1024 * 1024, abortSignal: abort.signal,
        onUploadProgress: ({ percentage }) => { if (mounted.current) setProgress(p => ({ ...p, [file.id]: percentage })); } });
      const finished = await captureRequest<{ asset: CaptureAsset }>(`/${initialCapture.id}/assets/${file.id}?automatic=1`, "POST", {});
      mergeAsset(finished.asset); await store.remove(ownerEmail, file.id).catch(() => undefined);
    } catch (e) {
      if (mounted.current && !abort.signal.aborted && !navigator.onLine) {
        queue.current.push(file);
      } else if (mounted.current && !abort.signal.aborted && (e instanceof TypeError || e instanceof CaptureRequestError && [408, 429, 500, 502, 503, 504].includes(e.status)) && (uploadRetries.current.get(file.id) ?? 0) < 2) {
        uploadRetries.current.set(file.id, (uploadRetries.current.get(file.id) ?? 0) + 1);
        setTimeout(() => { if (mounted.current && filesRef.current.some(f => f.id === file.id)) void enqueue([file]); }, 3000);
      }
      if (mounted.current) setFailures(p => ({ ...p, [file.id]: e instanceof Error ? e.message : "Upload failed. Retry this file." }));
    } finally {
      controllers.current.delete(file.id); running.current.delete(file.id);
      if (mounted.current) { setProgress(p => { const n = { ...p }; delete n[file.id]; return n; }); drain(); }
    }
  }
  function drain() {
    if (!mounted.current || !navigator.onLine) return;
    for (let i = 0; i < queue.current.length;) {
      const file = queue.current[i];
      const active = [...running.current].filter(id => filesRef.current.find(f => f.id === id)?.kind === "worksheet").length;
      const audioActive = running.current.size - active;
      if (file.kind === "worksheet" ? active >= 3 : audioActive >= 1) { i++; continue; }
      queue.current.splice(i, 1); running.current.add(file.id); void send(file);
    }
    if (!running.current.size && !queue.current.length) void refresh().catch(e => setError(e.message));
  }
  async function enqueue(added: LocalMedia[]) {
    if (!added.length) return;
    updateFiles([...filesRef.current.filter(f => !added.some(a => a.id === f.id)), ...added]);
    try {
      for (let i = 0; i < added.length; i += 100) await process({ action: "stage", assetIds: added.slice(i, i + 100).map(f => f.id) });
      queue.current.push(...added.filter(f => !running.current.has(f.id) && !queue.current.some(q => q.id === f.id))); drain();
    } catch (e) { setError(e instanceof Error ? e.message : "Could not queue files."); for (const f of added) setFailures(p => ({ ...p, [f.id]: "Could not queue upload. Tap retry." })); }
  }
  async function choose(chosen: FileList | null, kind: "recording" | "worksheet") {
    if (!chosen?.length) return;
    if (kind === "worksheet" && !permission) { setError("Confirm worksheet permission first."); return; }
    await enqueue(Array.from(chosen, file => ({ id: crypto.randomUUID(), kind, name: file.name, blob: file })));
  }
  async function remove(id: string) {
    try {
      controllers.current.get(id)?.abort(); queue.current = queue.current.filter(f => f.id !== id);
      while (running.current.has(id)) await new Promise(resolve => setTimeout(resolve, 50));
      if (current.current.assets.some(a => a.id === id)) await captureRequest(`/${initialCapture.id}/assets/${id}`, "DELETE");
      await process({ action: "forget", assetId: id });
      await recovery.current?.remove(ownerEmail, id); updateFiles(filesRef.current.filter(f => f.id !== id));
      setFailures(p => { const next = { ...p }; delete next[id]; return next; });
    } catch (e) { setError(e instanceof Error ? e.message : "Could not remove material."); }
  }
  async function save(reviewed = false): Promise<void> {
    if (saving.current) { await new Promise(resolve => setTimeout(resolve, 100)); return save(reviewed); }
    saving.current = true; const revision = dirty.current; const snapshot = { ...fieldsRef.current };
    setSaveStatus("Saving…");
    try {
      const c = editBase.current ?? current.current;
      let next: CaptureView;
      const write = (version: number) => captureRequest<{ capture: CaptureView }>(`/${c.id}`, "PATCH", { version, topic: c.topic, tutorNotes: c.tutorNotes, fields: snapshot, reviewed });
      try { next = (await write(c.version)).capture; }
      catch (problem) {
        if (!(problem instanceof CaptureRequestError) || problem.status !== 409) throw problem;
        const fresh = await refresh();
        if (JSON.stringify(fresh.draft) !== JSON.stringify(c.draft) || fresh.topic !== c.topic || fresh.tutorNotes !== c.tutorNotes) throw new Error("Feedback changed in another tab. Your edits remain here; copy them before reloading to compare.");
        next = (await write(fresh.version)).capture;
      }
      saved.current = revision; editBase.current = dirty.current > revision ? next : null; apply(next); setSaveStatus("Saved");
    } catch (e) { setSaveStatus("Not saved"); throw e; }
    finally { saving.current = false; }
  }
  function edit(key: keyof DraftFields, value: string) {
    if (dirty.current === saved.current) editBase.current = current.current;
    fieldsRef.current = { ...fieldsRef.current, [key]: value }; setFields(fieldsRef.current); dirty.current++;
    setSaveStatus("Unsaved"); if (saveTimer.current) clearTimeout(saveTimer.current);
    saveTimer.current = setTimeout(() => { void save().catch(e => setError(e.message)); }, 800);
  }
  async function approve() {
    setApproving(true); setError(null); if (saveTimer.current) clearTimeout(saveTimer.current);
    const text = feedbackText(fieldsRef.current);
    try {
      // Reserve clipboard permission within the tap on Safari, while the save completes.
      if (typeof ClipboardItem !== "undefined" && navigator.clipboard.write) {
        const content = save(true).then(() => new Blob([text], { type: "text/plain" }));
        await navigator.clipboard.write([new ClipboardItem({ "text/plain": content })]);
      } else { await save(true); await navigator.clipboard.writeText(text); }
      setSaveStatus("Approved and copied");
    } catch (e) { setError(e instanceof Error ? e.message : "Copy was unavailable. Your draft remains available to select and copy."); }
    finally { setApproving(false); }
  }

  useEffect(() => {
    mounted.current = true;
    const activeControllers = controllers.current;
    const network = () => { setOnline(navigator.onLine); if (navigator.onLine) { drain(); if (dirty.current !== saved.current) void save().catch(e => setError(e.message)); } };
    network(); window.addEventListener("online", network); window.addEventListener("offline", network);
    const warn = (event: BeforeUnloadEvent) => { if (dirty.current !== saved.current || controllers.current.size || queue.current.length) { event.preventDefault(); event.returnValue = ""; } };
    window.addEventListener("beforeunload", warn);
    const timer = setInterval(() => { if (navigator.onLine && document.visibilityState === "visible") void refresh().catch(e => setError(e.message)); }, 3000);
    return () => { mounted.current = false; clearInterval(timer); if (saveTimer.current) clearTimeout(saveTimer.current); for (const c of activeControllers.values()) c.abort(); window.removeEventListener("online", network); window.removeEventListener("offline", network); window.removeEventListener("beforeunload", warn); };
    // This queue belongs to one capture; refs hold its latest state.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [initialCapture.id, refresh]);
  useEffect(() => {
    if (init.current) return; init.current = true;
    void (async () => {
      if (!current.current.automatic && current.current.consent.automatic) await process({ action: "consent" });
      if (!current.current.automatic) return;
      // A reopened page never resumes recording; any recovered file is queued first.
      if (initialFiles.length) await enqueue(initialFiles.filter(f => !current.current.assets.some(a => a.id === f.id && a.status !== "pending")));
      if (current.current.automatic?.recording) await process({ action: "recording", active: false });
    })().catch(e => setError(e.message));
    // Initialization is intentionally one-shot per owned capture.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [process]);

  const items = new Map<string, { local?: LocalMedia; remote?: CaptureAsset }>();
  capture.assets.forEach(a => items.set(a.id, { remote: a })); files.forEach(f => items.set(f.id, { ...items.get(f.id), local: f }));
  const photos = [...items].filter(([, a]) => (a.remote?.kind ?? a.local?.kind) === "worksheet");
  const audio = [...items].filter(([, a]) => (a.remote?.kind ?? a.local?.kind) !== "worksheet");
  const uploading = Object.keys(progress).length > 0 || queue.current.length > 0;
  const stage = uploading ? "Uploading" : automatic?.status === "writing" ? "Writing feedback" : automatic?.status === "ready" ? "Ready" : automatic?.status === "attention" ? "Needs attention" : "Reading materials";
  const recordCount = audio.filter(([, a]) => (a.remote?.kind ?? a.local?.kind) === "recording").length;
  const bytes = audio.reduce((n, [, a]) => n + (a.local?.blob.size ?? a.remote?.size ?? 0), 0);
  return <main className="min-h-0 flex-1 overflow-y-auto"><div className="mx-auto w-full max-w-5xl px-4 py-5 sm:px-6">
    <header className="mb-4"><h1 className="text-2xl font-semibold">Class feedback</h1><p className="mt-1 text-sm text-muted-foreground">{capture.session.studentName} · {capture.session.title}</p></header>
    {error && <div role="alert" className="mb-3 rounded-xl border border-amber-300 p-3 text-sm">{error}<Button variant="ghost" className="min-h-11" onClick={() => setError(null)}>Dismiss</Button></div>}
    {!online && <p role="status" className="mb-3 text-sm">Offline. Keep this page open; queued uploads resume when connected.</p>}
    {!automatic ? <section className="rounded-xl border p-5"><h2 className="text-lg font-semibold">Automatic feedback</h2><label className="my-4 flex gap-3 text-sm"><input type="checkbox" checked={consent} onChange={e => setConsent(e.target.checked)} className="size-5 shrink-0" />I have permission for automatic private audio transcription, worksheet image analysis and feedback drafting for this class.</label><Button disabled={!consent} className="min-h-11" onClick={() => void process({ action: "consent" }).then(() => enqueue(filesRef.current)).catch(e => setError(e.message))}>Enable automatic feedback</Button><p className="mt-3 text-xs text-muted-foreground">Existing materials remain saved. Photos enter AI analysis only after this confirmation.</p></section> : <>
      <section aria-label="Feedback progress" role="status" className="sticky top-0 z-10 mb-4 rounded-xl border bg-background/95 p-3 shadow-sm"><p className="text-sm font-medium">{recording ? "Recording · draft follows when you stop" : stage === "Ready" ? "Ready · edits save automatically" : stage}</p>{stage !== "Ready" && <><p className="mt-1 text-xs text-muted-foreground">Uploading → Reading materials → Writing feedback → Ready</p><p className="mt-1 text-xs">{uploading ? "Keep this page open until uploads finish." : "Uploaded materials continue processing even if your phone sleeps."}</p></>}{automatic.error && <p className="mt-2 text-sm text-amber-800">{automatic.error}</p>}{automatic.status === "attention" && <Button variant="outline" className="mt-2 min-h-11" onClick={() => void process({ action: "retry" }).catch(e => setError(e.message))}>Retry processing</Button>}</section>
      <div className="grid gap-4 md:grid-cols-2"><div className="space-y-4">

        <section className="rounded-xl border p-4"><h2 className="font-semibold">Class materials</h2><div className="mt-3 flex flex-wrap gap-2"><Button className="min-h-11" disabled={recordCount >= 8} onClick={() => audioInput.current?.click()}>Add audio</Button><Button variant="outline" className="min-h-11" disabled={!permission} onClick={() => photoInput.current?.click()}>Add photos</Button></div>
          <label className="mt-3 flex gap-2 text-sm"><input type="checkbox" checked={permission} onChange={e => setPermission(e.target.checked)} className="size-5 shrink-0" />I have permission to upload and analyse these worksheets. They contain no faces or unrelated personal details.</label>
          <p className="mt-2 text-xs text-muted-foreground">Uploads and drafting happen automatically. No photo count limit.</p>
          <WorksheetGallery captureId={capture.id} items={photos} busy={false} errors={failures} progress={null} progressById={progress} uploadAllowed={online && permission} onUpload={f => void enqueue([f])} onRemove={id => void remove(id)} />
          <div className="mt-3 space-y-2">{audio.map(([id, item], index) => <div key={id} className="rounded-lg border p-3 text-sm"><p className="font-medium">{item.remote?.kind === "debrief" || item.local?.kind === "debrief" ? "Voice debrief" : `Audio ${index + 1}`}</p><p>{progress[id] !== undefined ? `Uploading ${Math.round(progress[id])}%` : item.remote?.status === "transcribed" ? "Transcript ready" : item.remote?.status === "transcribing" ? "Transcribing…" : item.remote?.status === "ready" ? "Queued for transcription" : "Waiting to upload"}</p>{(failures[id] || item.remote?.error) && <p role="alert" className="my-2 text-amber-800">{failures[id] || item.remote?.error}</p>}<div className="flex gap-2">{failures[id] && item.local && <Button className="min-h-11" variant="outline" onClick={() => void enqueue([item.local!])}>Retry file</Button>}{item.remote?.status === "failed" && <Button className="min-h-11" variant="outline" onClick={() => void process({ action: "retry", assetId: id }).catch(e => setError(e.message))}>Retry processing</Button>}<Button variant="ghost" className="min-h-11" onClick={() => void remove(id)}>Remove</Button></div></div>)}</div>
          {photos.some(([, p]) => p.remote?.error) && <details className="mt-2 text-sm"><summary>Photo processing issues</summary>{photos.filter(([, p]) => p.remote?.error).map(([id, p]) => <p key={id}>{p.remote?.error}<Button variant="outline" className="min-h-11" onClick={() => void process({ action: "retry", assetId: id }).catch(e => setError(e.message))}>Retry photo analysis</Button></p>)}</details>}
          {automatic.expectedUploads.filter(id => !items.has(id)).map(id => <p key={id} className="mt-2 text-sm">An upload was interrupted before this device saved it. Select the file again.<Button variant="ghost" className="min-h-11" onClick={() => void process({ action: "forget", assetId: id }).catch(e => setError(e.message))}>Remove missing upload</Button></p>)}
        </section>
        <details className="rounded-xl border p-3"><summary className="min-h-11 cursor-pointer text-sm font-medium">Record in this browser</summary>
        <RecordingPanel captureId={capture.id} ownerEmail={ownerEmail} automatic disabled={!online} recordingLimitReached={recordCount >= 8} remainingRecordingBytes={Math.max(0, MAX_AUDIO_BYTES - bytes)} debriefExists={audio.some(([, a]) => (a.remote?.kind ?? a.local?.kind) === "debrief")}
          beforeStart={async id => { await process({ action: "stage", assetIds: [id] }); await process({ action: "recording", active: true }); }}
          onDiscard={id => { void process({ action: "forget", assetId: id }).then(() => process({ action: "recording", active: false })).catch(e => setError(e.message)); }}
          onActiveChange={active => { if (active === recordingRef.current) return; recordingRef.current = active; setRecording(active); if (!active) void process({ action: "recording", active: false }).catch(e => setError(e.message)); }}
          onFile={file => void enqueue([file])} />
        </details>
      </div><section className="scroll-mt-20 rounded-xl border p-4" aria-label="Feedback draft"><div className="flex items-center justify-between"><h2 className="text-lg font-semibold">Feedback draft</h2><span className="text-xs text-muted-foreground" role="status">{saveStatus}</span></div>
        {!capture.draft && <p className="my-4 text-sm text-muted-foreground">Add your class materials. Your feedback will appear here automatically.</p>}
        {automatic.proposal && <section className="my-3 rounded-lg border border-sky-200 p-3"><p className="text-sm font-medium">Updated draft available. Your edits are preserved.</p><details className="mt-2 text-sm"><summary className="min-h-11 cursor-pointer">Compare proposed feedback</summary>{Object.entries(DRAFT_LABELS).map(([k, label]) => <div key={k} className="mb-3"><strong>{label}</strong><p className="whitespace-pre-wrap">{automatic.proposal!.fields[k as keyof DraftFields]}</p></div>)}</details><Button className="min-h-11" variant="outline" onClick={() => void save().then(() => process({ action: "accept", revision: automatic.proposal!.revision, version: current.current.version })).catch(e => setError(e.message))}>Use updated draft</Button></section>}
        {(capture.draft || dirty.current > 0) && <><div className="mt-4 space-y-4">{Object.entries(DRAFT_LABELS).map(([k, label]) => <div key={k}><label htmlFor={`auto-${k}`} className="text-sm font-semibold">{label}</label><Textarea id={`auto-${k}`} value={fields[k as keyof DraftFields]} rows={3} disabled={approving} maxLength={8000} className="mt-1 text-base" onChange={e => edit(k as keyof DraftFields, e.target.value)} />{!fields[k as keyof DraftFields] && <p className="mt-1 text-xs text-muted-foreground">No supported detail yet. Add your correction if needed.</p>}</div>)}</div>
          <details className="mt-4 rounded-lg bg-muted/40 p-3 text-sm"><summary className="min-h-11 cursor-pointer font-medium">Evidence and questions</summary>{automatic.evidence?.questions.map((q, i) => <p key={i} className="mb-2 text-amber-900">{q}</p>)}{automatic.evidence?.sources.map((s, i) => <p key={i} className="mb-3 break-words text-xs"><strong>{DRAFT_LABELS[s.field]}</strong> · {s.startMs === null ? s.sourceId.split(":")[0] : `${Math.floor(s.startMs / 60000)}:${String(Math.floor(s.startMs / 1000) % 60).padStart(2, "0")}`}<br />{s.quote}</p>)}</details>
          <p className="mt-4 text-xs text-muted-foreground">By approving, you confirm that you reviewed and corrected this feedback. Submission happens in Wise.</p><Button className="mt-2 min-h-12 w-full" disabled={approving || !online || recording || !Object.values(fields).some(v => v.trim())} onClick={() => void approve()}>Approve &amp; copy</Button><a href={capture.session.wiseUrl} target="_blank" rel="noopener noreferrer" className="mt-2 flex min-h-11 items-center justify-center text-sm text-primary underline">Open Wise to submit</a>
        </>}
      </section></div>
    </>}
    <footer className="mt-5 text-xs text-muted-foreground">Materials expire after 24 hours. Keep final feedback in Wise.<Button variant="ghost" className="min-h-11" onClick={() => setDeleting(true)}>Delete capture</Button>{deleting && <div className="rounded-lg border p-3"><p>Delete this capture and its saved materials?</p><Button variant="destructive" className="mt-2 min-h-11" onClick={() => void captureRequest(`/${capture.id}`, "DELETE").then(async () => { await recovery.current?.deleteCapture(ownerEmail, capture.id); clearCapturePointer(); onDeleted(); }).catch(e => setError(e.message))}>Delete capture permanently</Button><Button variant="ghost" className="min-h-11" onClick={() => setDeleting(false)}>Keep capture</Button></div>}</footer>
    <input ref={audioInput} type="file" accept="audio/*,.m4a,.mp4,.webm,.ogg,.wav" className="hidden" aria-label="Choose audio for automatic feedback" onChange={e => { void choose(e.target.files, "recording"); e.target.value = ""; }} />
    <input ref={photoInput} type="file" accept="image/jpeg,image/png" multiple className="hidden" aria-label="Choose photos for automatic feedback" onChange={e => { void choose(e.target.files, "worksheet"); e.target.value = ""; }} />
  </div></main>;
}
