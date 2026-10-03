"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { upload } from "@vercel/blob/client";
import { ArrowLeft, ArrowRight, CalendarDays, Check, CheckCheck, ChevronRight, Clipboard, ExternalLink, FileUp, ImagePlus, Loader2, LockKeyhole, Mic, RefreshCw, ShieldCheck, Sparkles, Trash2, WifiOff } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import { formatBangkokDateTime } from "@/lib/bangkok-time";
import { MAX_AUDIO_BYTES, type CaptureAsset, type CaptureSession, type CaptureView, type DraftFields } from "@/lib/class-capture/model";
import { LocalRecovery, type RecoveryRecord } from "@/lib/class-capture/local-recovery";
import { AssetCard } from "./asset-card";
import { WorksheetGallery } from "./worksheet-gallery";
import { RecordingPanel } from "./recording-panel";
import { bangkokDay, watchTodaySessions } from "./today-sessions";
import { canonicalMime, captureRequest, CaptureRequestError, clearCapturePointer, DRAFT_LABELS, EMPTY_DRAFT, feedbackText, loadCapturePointer, saveCapturePointer, prepareLocalFile, validateLocalFile, type CaptureAvailability, type LocalMedia } from "./client-helpers";

type SessionData = { sessions: CaptureSession[]; availability: CaptureAvailability };
const UNAVAILABLE: CaptureAvailability = { enabled: false, storage: false, transcription: false, drafting: false };

function sessionTime(session: CaptureSession) {
  return `${formatBangkokDateTime(session.startTime, { hour: "2-digit", minute: "2-digit" })}–${formatBangkokDateTime(session.endTime, { hour: "2-digit", minute: "2-digit" })}`;
}

export function ClassCaptureWorkspace({ ownerEmail, enabled, initialData, initialCapture }: {
  ownerEmail: string;
  enabled: boolean;
  initialData?: SessionData;
  initialCapture?: CaptureView;
}) {
  const [today, setToday] = useState(() => bangkokDay());
  const [data, setData] = useState<SessionData>(initialData ?? { sessions: [], availability: { ...UNAVAILABLE, enabled } });
  const [loading, setLoading] = useState(!initialData && enabled);
  const [sessionError, setSessionError] = useState<string | null>(null);
  const listRefresh = useRef<(() => void) | null>(null);
  const [selected, setSelected] = useState<CaptureSession | null>(null);
  const [capture, setCapture] = useState<CaptureView | null>(initialCapture ?? null);
  const currentCapture = useRef<CaptureView | null>(initialCapture ?? null);
  const [topic, setTopic] = useState(initialCapture?.topic ?? "");
  const [notes, setNotes] = useState(initialCapture?.tutorNotes ?? "");
  const [manualDraft, setManualDraft] = useState(false);
  const [fields, setFields] = useState<DraftFields>(initialCapture?.draft ?? EMPTY_DRAFT);
  const [participants, setParticipants] = useState(false);
  const [guardian, setGuardian] = useState<"" | "confirmed" | "not_required">("");
  const [processing, setProcessing] = useState(false);
  const [worksheetPermission, setWorksheetPermission] = useState(false);
  const [reviewConfirmed, setReviewConfirmed] = useState(initialCapture?.reviewed ?? false);
  const [localFiles, setLocalFiles] = useState<LocalMedia[]>([]);
  const [recoverable, setRecoverable] = useState<RecoveryRecord[]>([]);
  const [busy, setBusy] = useState<string | null>(null);
  const busyRef = useRef(false);
  const [recording, setRecording] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [offline, setOffline] = useState(false);
  const [progress, setProgress] = useState<{ id: string; value: number } | null>(null);
  const [photoErrors, setPhotoErrors] = useState<Record<string, string>>({});
  const [photoBatch, setPhotoBatch] = useState(false);
  const cancelPhotos = useRef(false);
  const [discarding, setDiscarding] = useState(false);
  const recovery = useRef<LocalRecovery | null>(null);
  const controller = useRef<AbortController | null>(null);
  const createAttempt = useRef<string | null>(null);
  const booted = useRef(false);
  const audioInput = useRef<HTMLInputElement>(null);
  const photoInput = useRef<HTMLInputElement>(null);
  const active = enabled && data.availability.enabled;
  const locked = Boolean(busy) || recording;

  const applyCapture = useCallback((value: CaptureView, adoptEdits = false) => {
    currentCapture.current = value;
    setCapture(value);
    saveCapturePointer(ownerEmail, value.id, value.expiresAt);
    if (adoptEdits) {
      setTopic(value.topic); setNotes(value.tutorNotes); setFields(value.draft ?? EMPTY_DRAFT); setReviewConfirmed(value.reviewed);
    }
  }, [ownerEmail]);

  const run = useCallback(async (label: string, action: () => Promise<void>) => {
    if (busyRef.current) return;
    busyRef.current = true;
    setBusy(label); setError(null); setNotice(null);
    try { await action(); } catch (problem) { setError(problem instanceof Error ? problem.message : "This action could not be completed. Please retry."); }
    finally { setBusy(null); busyRef.current = false; }
  }, []);

  async function recoverCapture(id: string) {
    // Reauthorize the capture before reading any local media, including on a different login.
    const result = await captureRequest<{ capture: CaptureView }>(`/${id}`);
    const store = recovery.current ??= new LocalRecovery();
    const records = await store.list(ownerEmail).catch(() => []);
    const files: LocalMedia[] = [];
    for (const record of records.filter((entry) => entry.captureId === id && entry.size > 0)) {
      const restored = await store.load(ownerEmail, record.assetId);
      if (restored) files.push({ id: record.assetId, kind: record.kind, name: record.name, blob: restored.blob, incomplete: !record.complete });
    }
    applyCapture(result.capture, true);
    setLocalFiles(files);
    setRecoverable(records.filter((entry) => entry.captureId !== id));
    setNotice("Capture reopened. Recording never resumes automatically. Check recovered audio for missing sections.");
  }

  useEffect(() => {
    if (!enabled) return;
    const watcher = watchTodaySessions({
      request: () => captureRequest<SessionData>(""),
      focus: window,
      visibility: document,
      onRefresh: (day) => {
        setToday(day); setLoading(true); setSessionError(null);
        setData((previous) => ({ ...previous, sessions: [] }));
        if (!currentCapture.current) {
          setSelected(null); setParticipants(false); setGuardian(""); setProcessing(false);
          createAttempt.current = null;
        }
      },
      onResult: (result) => { setData(result); setLoading(false); },
      onError: (problem) => {
        setSessionError(problem instanceof Error ? problem.message : "Today's classes could not be refreshed.");
        setLoading(false);
      },
    });
    listRefresh.current = watcher.refresh;
    return () => { watcher.stop(); listRefresh.current = null; };
  }, [enabled]);

  useEffect(() => {
    if (booted.current || initialCapture) return;
    booted.current = true;
    const store = recovery.current ??= new LocalRecovery();
    void store.list(ownerEmail).then((records) => setRecoverable(records.filter((record) => record.size > 0))).catch(() => undefined);
    const id = loadCapturePointer(ownerEmail);
    if (enabled && id) void run("Reopening capture", () => recoverCapture(id));
    // Recovery only runs once after mount; further reopening is an explicit user action.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [enabled, initialCapture, ownerEmail, run]);

  useEffect(() => {
    const update = () => setOffline(!navigator.onLine);
    update();
    window.addEventListener("online", update); window.addEventListener("offline", update);
    return () => { window.removeEventListener("online", update); window.removeEventListener("offline", update); cancelPhotos.current = true; controller.current?.abort(); };
  }, []);

  async function createCapture() {
    if (today !== bangkokDay()) { listRefresh.current?.(); return; }
    if (loading || sessionError) return;
    if (!selected || !participants || !guardian || !processing || !topic.trim()) return;
    await run("Preparing capture", async () => {
      createAttempt.current ??= crypto.randomUUID();
      const result = await captureRequest<{ capture: CaptureView }>("", "POST", { id: createAttempt.current, sessionId: selected.sessionId, studentId: selected.studentId, topic: topic.trim(), consent: { participants: true, guardian, processing: true } });
      applyCapture(result.capture, true);
      setNotice("Consent saved. Start recording when everyone is ready.");
    });
  }

  const addRecording = useCallback((file: LocalMedia) => { setLocalFiles((files) => [...files.filter((item) => item.id !== file.id), file]); setNotice("Audio saved on this device. Listen, then choose Upload privately when ready."); }, []);

  async function addFiles(files: FileList | null, kind: "recording" | "worksheet") {
    if (!files?.length || !capture) return;
    if (kind === "worksheet" && !worksheetPermission) { setError("Confirm worksheet permission before selecting photos."); return; }
    const chosen = Array.from(files);
    await run(kind === "worksheet" ? "Uploading worksheet photos" : "Saving files on this device", async () => {
      if (kind === "worksheet") cancelPhotos.current = false;
      const existing = new Map<string, { kind: CaptureAsset["kind"]; size: number }>([
        ...capture.assets.map((asset) => [asset.id, { kind: asset.kind, size: asset.size }] as const),
        ...localFiles.map((file) => [file.id, { kind: file.kind, size: file.blob.size }] as const),
      ]);
      const current = [...existing.values()].filter((asset) => asset.kind === kind);
      if (kind === "recording" && current.length + chosen.length > 8) throw new Error("Use up to eight audio sections per capture.");
      if (kind === "recording" && current.reduce((sum, file) => sum + file.size, 0) + chosen.reduce((sum, file) => sum + file.size, 0) > MAX_AUDIO_BYTES) throw new Error("Class audio must total 100 MB or less.");
      const prepared = await Promise.all(chosen.map(file => prepareLocalFile(file, kind)));
      const store = recovery.current ??= new LocalRecovery();
      const added: LocalMedia[] = [];
      for (const [index, file] of chosen.entries()) {
        const blob = prepared[index];
        const id = crypto.randomUUID();
        try {
          await store.create(ownerEmail, { captureId: capture.id, assetId: id, kind, name: file.name, mime: blob.type });
          await store.append(ownerEmail, id, blob); await store.finish(ownerEmail, id);
        } catch { setNotice("Browser recovery is unavailable. Keep this page open and upload the selected files before leaving."); }
        added.push({ id, kind, name: file.name, blob });
      }
      setLocalFiles((previous) => [...previous, ...added]);
      if (kind === "worksheet") {
        setPhotoBatch(true);
        let uploaded = 0;
        try {
          for (const file of added) {
            if (cancelPhotos.current) break;
            try { await uploadFile(file, true); uploaded++; }
            catch (problem) { setPhotoErrors(errors => ({ ...errors, [file.id]: problem instanceof Error ? problem.message : "Upload failed. Retry this photo." })); }
          }
          setNotice(`${uploaded} of ${added.length} photos uploaded. ${uploaded < added.length ? "Remaining photos are kept on this device; use Retry upload." : "Tap a thumbnail to view it."}`);
        } finally { setPhotoBatch(false); }
      }
    });
  }

  async function uploadFile(file: LocalMedia, withinBatch = false) {
    const action = async () => {
      if (file.kind === "worksheet" && !worksheetPermission) throw new Error("Confirm worksheet permission before uploading photos.");
      if (!data.availability.storage) throw new Error("Private upload storage is unavailable. Retry when it is restored.");
      const invalid = validateLocalFile(file.blob, file.kind);
      if (invalid) throw new Error(invalid);
      setPhotoErrors(errors => { const next = { ...errors }; delete next[file.id]; return next; });
      const current = currentCapture.current!;
      // Recover a finished upload before retrying: a dropped response must not create a second object.
      const refreshed = await captureRequest<{ capture: CaptureView }>(`/${current.id}`);
      applyCapture(refreshed.capture);
      let asset = refreshed.capture.assets.find((item) => item.id === file.id);
      if (asset && asset.status !== "pending") { setNotice("This file is already uploaded."); return; }
      if (!asset) ({ asset } = await captureRequest<{ asset: CaptureAsset }>(`/${current.id}/assets`, "POST", { id: file.id, kind: file.kind, mime: canonicalMime(file.blob.type), size: file.blob.size, ...(file.kind === "worksheet" ? { worksheetPermission: true } : {}) }));
      // An upload may have completed but its finalize response was lost. Try finalizing before sending bytes again.
      if (refreshed.capture.assets.some((item) => item.id === file.id)) {
        try {
          const recovered = await captureRequest<{ capture: CaptureView }>(`/${current.id}/assets/${file.id}`, "POST", {});
          applyCapture(recovered.capture);
          await recovery.current?.remove(ownerEmail, file.id);
          setNotice("The uploaded file was recovered."); return;
        } catch (problem) {
          if (!(problem instanceof CaptureRequestError) || ![404, 409].includes(problem.status)) throw problem;
        }
      }
      if (withinBatch && cancelPhotos.current) throw new Error("Photo upload cancelled. Your file is still on this device.");
      controller.current = new AbortController();
      setProgress({ id: file.id, value: 0 });
      try {
        await upload(asset.pathname, file.blob, { access: "private", contentType: canonicalMime(file.blob.type), handleUploadUrl: "/api/class-capture/uploads", clientPayload: asset.id, multipart: true, abortSignal: controller.current.signal, onUploadProgress: ({ percentage }) => setProgress({ id: file.id, value: percentage }) });
        const result = await captureRequest<{ capture: CaptureView }>(`/${current.id}/assets/${file.id}`, "POST", {});
        applyCapture(result.capture);
        await recovery.current?.remove(ownerEmail, file.id).catch(() => undefined);
        setNotice("Uploaded privately. Transcription only starts when you choose Transcribe audio.");
      } catch (problem) {
        if (controller.current.signal.aborted) throw new Error("Upload cancelled. Your file is still on this device. Retry will check for an upload that already finished.");
        throw problem;
      } finally { setProgress(null); controller.current = null; }
    };
    if (withinBatch) await action();
    else await run("Uploading privately", action);
  }

  async function removeItem(id: string) {
    await run("Removing photo", async () => {
      const current = currentCapture.current!;
      if (current.assets.some(asset => asset.id === id)) {
        await captureRequest(`/${current.id}/assets/${id}`, "DELETE");
        applyCapture((await captureRequest<{ capture: CaptureView }>(`/${current.id}`)).capture);
      }
      await recovery.current?.remove(ownerEmail, id);
      setLocalFiles(files => files.filter(file => file.id !== id));
    });
  }

  async function saveEdits(reviewed = false, resetDraft = false) {
    const current = currentCapture.current!;
    const result = await captureRequest<{ capture: CaptureView }>(`/${current.id}`, "PATCH", { version: current.version, topic: topic.trim(), tutorNotes: notes, ...(resetDraft ? { resetDraft: true } : { ...((current.draft || manualDraft) ? { fields } : {}), reviewed }) });
    applyCapture(result.capture);
    return result.capture;
  }

  async function transcribeAsset(captureId: string, assetId: string) {
    await run("Requesting transcription", async () => {
      try {
        const result = await captureRequest<{ capture: CaptureView }>(`/${captureId}/transcribe`, "POST", { assetId });
        applyCapture(result.capture);
        setNotice(result.capture.assets.find((asset) => asset.id === assetId)?.status === "transcribed" ? "Transcript ready. Read it for errors before creating a draft." : "Transcription requested. Use Check transcript to see the result.");
      } catch (problem) {
        // A provider failure can still have changed its durable status. Recover that status without repeating the paid request.
        try { applyCapture((await captureRequest<{ capture: CaptureView }>(`/${captureId}`)).capture); } catch { /* Keep the original error and available local evidence. */ }
        throw problem;
      }
    });
  }

  const items = new Map<string, { local?: LocalMedia; remote?: CaptureAsset }>();
  for (const asset of capture?.assets ?? []) items.set(asset.id, { remote: asset });
  for (const file of localFiles) items.set(file.id, { ...items.get(file.id), local: file });
  const allItems = [...items.values()];
  const audioCount = allItems.filter(item => (item.remote?.kind ?? item.local?.kind) !== "worksheet").length;
  const audio = allItems.filter((item) => (item.remote?.kind ?? item.local?.kind) === "recording");
  const debriefExists = allItems.some((item) => (item.remote?.kind ?? item.local?.kind) === "debrief");
  const remainingRecordingBytes = Math.max(0, MAX_AUDIO_BYTES - audio.reduce((sum, item) => sum + (item.remote?.size ?? item.local?.blob.size ?? 0), 0));
  const recordingLimitReached = audio.length >= 8 || remainingRecordingBytes === 0;
  const savedReview = Boolean(capture?.reviewed && reviewConfirmed && JSON.stringify(fields) === JSON.stringify(capture.draft) && topic === capture.topic && notes === capture.tutorNotes);
  const step = (capture?.draft || manualDraft) ? 3 : capture ? 2 : 1;
  const recoveryIds = [...new Set(recoverable.filter((record) => record.captureId !== capture?.id).map((record) => record.captureId))];

  return (
    <div className="min-h-0 flex-1 overflow-y-auto" data-class-capture>
      <div className="mx-auto w-full max-w-5xl pb-16 pt-2 sm:pt-4">
        <header className="flex flex-wrap items-start justify-between gap-4 border-b pb-5">
          <div><p className="mb-2 flex items-center gap-2 text-xs font-semibold tracking-widest text-primary uppercase"><Mic className="size-4" />BeGifted · In-person teaching</p><h1 className="text-3xl font-semibold tracking-tight sm:text-4xl">Class capture</h1><p className="mt-2 max-w-xl text-sm leading-6 text-muted-foreground">Be present for the lesson. Leave with feedback you can stand behind.</p></div>
          <span className="inline-flex items-center gap-1.5 rounded-full border border-sky-200 bg-sky-50 px-3 py-1.5 text-xs font-medium text-sky-800 dark:bg-sky-950 dark:text-sky-200"><LockKeyhole className="size-3.5" />Private · Tutor reviewed</span>
        </header>
        <ol aria-label="Capture progress" className="my-6 grid grid-cols-3 gap-2 sm:gap-4">{["Choose class", "Capture & reflect", "Review & finish"].map((label, index) => <li key={label} aria-current={step === index + 1 ? "step" : undefined} className={`flex items-center gap-2 border-t-2 pt-3 text-xs font-medium sm:text-sm ${step >= index + 1 ? "border-primary text-primary" : "border-border text-muted-foreground"}`}><span className={`flex size-6 shrink-0 items-center justify-center rounded-full text-xs ${step > index + 1 ? "bg-primary text-primary-foreground" : "bg-muted"}`}>{step > index + 1 ? <Check className="size-3.5" /> : index + 1}</span><span>{label}</span></li>)}</ol>
        {offline && <div role="status" className="mb-4 flex gap-2 rounded-xl border border-amber-200 bg-amber-50 p-4 text-sm text-amber-900"><WifiOff className="size-5 shrink-0" /><p>You’re offline. You can keep recording with this page open. Reconnect before uploading or saving draft edits.</p></div>}
        {error && <div role="alert" className="mb-4 rounded-xl border border-red-200 bg-red-50 p-4 text-sm leading-6 text-red-900">{error}{capture && !locked && <Button variant="ghost" className="mt-2 min-h-11" onClick={() => void run("Reloading capture", () => recoverCapture(capture.id))}><RefreshCw />Reload saved capture</Button>}</div>}
        {sessionError && <div role="alert" className="mb-4 rounded-xl border border-amber-200 bg-amber-50 p-4 text-sm leading-6 text-amber-900"><p>Today’s classes could not be refreshed. {sessionError}</p>{capture && <p className="mt-1 text-xs">Your current capture and edits are unchanged.</p>}<Button variant="outline" className="mt-2 min-h-11" disabled={loading} onClick={() => listRefresh.current?.()}><RefreshCw />Retry today’s classes</Button></div>}
        {notice && <p role="status" className="mb-4 rounded-xl border border-sky-200 bg-sky-50 p-4 text-sm leading-6 text-sky-900 dark:bg-sky-950 dark:text-sky-100">{notice}</p>}
        {!active ? <section className="rounded-2xl border bg-card p-6 sm:p-10"><div className="mb-4 flex size-12 items-center justify-center rounded-xl bg-muted"><Mic className="size-6 text-muted-foreground" /></div><h2 className="text-xl font-semibold">Class capture is paused</h2><p className="mt-2 max-w-xl text-sm leading-6 text-muted-foreground">Recording and AI drafting are not enabled for this workspace yet. Continue writing and submitting feedback through your usual Wise class page.</p><a href="/post-class-feedback" className="mt-5 inline-flex min-h-11 items-center gap-2 text-sm font-medium text-primary">Open Class Feedback<ArrowRight className="size-4" /></a>{recoverable.length > 0 && <div className="mt-4 border-t pt-4"><p className="text-xs leading-5 text-muted-foreground">This device has saved media from an earlier capture. You can remove those local recovery copies while capture is paused.</p><Button variant="outline" className="mt-3 min-h-11" disabled={Boolean(busy)} onClick={() => void run("Removing local recovery", async () => { const store = recovery.current ??= new LocalRecovery(); for (const record of recoverable) await store.remove(ownerEmail, record.assetId); clearCapturePointer(); setRecoverable([]); setNotice("Local recovery copies removed. Cloud retention and cleanup are unchanged."); })}>Delete local recovery copies</Button></div>}</section> : <>
          {recoveryIds.length > 0 && <section className="mb-5 rounded-xl border border-amber-200 bg-amber-50/60 p-4"><h2 className="text-sm font-semibold">There’s audio to recover on this device</h2><p className="mt-1 text-xs leading-5 text-muted-foreground">Reopening checks your class access first. Local copies expire after 24 hours and may be incomplete.</p><div className="mt-3 flex flex-wrap gap-2">{recoveryIds.map((id, index) => <Button key={id} variant="outline" className="min-h-11" disabled={locked} onClick={() => void run("Recovering capture", () => recoverCapture(id))}>Recover capture {index + 1}</Button>)}<Button variant="ghost" className="min-h-11" disabled={locked} onClick={() => void run("Removing local recovery", async () => { for (const id of recoveryIds) await recovery.current?.deleteCapture(ownerEmail, id); setRecoverable([]); setNotice("Local recovery copies removed."); })}>Delete local recovery copies</Button></div></section>}
          {!capture ? <div className="grid items-start gap-5 lg:grid-cols-[minmax(0,1fr)_minmax(0,1fr)]">
            <section className="rounded-2xl border bg-card p-5 sm:p-6"><div className="flex flex-wrap items-center justify-between gap-2"><h2 className="text-xl font-semibold">Your classes today</h2><Button variant="ghost" className="min-h-11" aria-label="Refresh today’s classes" disabled={loading} onClick={() => listRefresh.current?.()}><RefreshCw className={loading ? "animate-spin" : undefined} />Refresh</Button></div><p className="mt-2 text-sm leading-6 text-muted-foreground">Your own ongoing, upcoming and completed classes appear. Choose the student and session you’re teaching today.</p><div className="mt-4 flex flex-wrap items-center gap-x-3 gap-y-1 rounded-lg bg-sky-50 px-3 py-2 text-xs text-sky-900 dark:bg-sky-950 dark:text-sky-100"><span className="inline-flex items-center gap-1.5 font-semibold"><CalendarDays className="size-4" />Today · Bangkok</span><time dateTime={today}>{formatBangkokDateTime(`${today}T12:00:00+07:00`, { day: "numeric", month: "short", year: "numeric" })}</time></div>
              <div className="mt-4 space-y-2">{loading ? <p role="status" className="py-8 text-center text-sm text-muted-foreground">Loading your classes…</p> : data.sessions.length ? data.sessions.map((session) => <button key={`${session.sessionId}:${session.studentId}`} className={`flex min-h-24 w-full items-center gap-3 rounded-xl border p-4 text-left transition-colors ${selected?.sessionId === session.sessionId && selected.studentId === session.studentId ? "border-primary bg-sky-50 ring-1 ring-primary dark:bg-sky-950" : "bg-background hover:border-sky-300"}`} disabled={locked} aria-pressed={selected?.sessionId === session.sessionId && selected.studentId === session.studentId} onClick={() => { setSelected(session); createAttempt.current = null; setParticipants(false); setGuardian(""); setProcessing(false); }}><span className="min-w-0 flex-1"><span className="block text-xs font-medium text-primary">{sessionTime(session)}{new Date(session.endTime).getTime() <= Date.now() ? " · After class · Add feedback" : " · Capture class"}</span><span className="mt-1 block font-semibold">{session.studentName}</span><span className="mt-1 block break-words text-xs leading-5 text-muted-foreground">{session.title} · {session.teacherName}</span></span><ChevronRight className="size-5 shrink-0 text-muted-foreground" /></button>) : <p className="rounded-xl bg-muted/50 p-5 text-sm leading-6 text-muted-foreground">No eligible classes were found for today. Only your own in-person classes with one student appear. Completed classes can take a few minutes to sync; use Refresh classes to check again.</p>}</div>
            </section>
            <section className="rounded-2xl border border-sky-200 bg-sky-50/40 p-5 sm:p-6"><div className="mb-4 flex size-11 items-center justify-center rounded-full bg-sky-100 text-primary"><ShieldCheck className="size-5" /></div><h2 className="text-xl font-semibold">Permission comes first.</h2><p className="mt-2 text-sm leading-6 text-muted-foreground">Explain what you’re recording and why. Everyone can decline or ask you to stop. Use your usual notes if anyone is uncomfortable.</p>
              <label htmlFor="lesson-topic" className="mt-5 block text-sm font-medium">Today’s lesson topic</label><Input id="lesson-topic" value={topic} maxLength={500} disabled={locked} onChange={(event) => setTopic(event.target.value)} placeholder="e.g. Equivalent fractions" className="mt-2 min-h-11 bg-background text-base" />
              <label className="mt-5 flex min-h-11 cursor-pointer items-start gap-3 text-sm leading-6"><input type="checkbox" checked={participants} disabled={locked} onChange={(event) => setParticipants(event.target.checked)} className="mt-1 size-5 shrink-0 accent-sky-700" /><span>I have explained this recording and every participant agrees.</span></label>
              <label htmlFor="guardian-consent" className="mt-4 block text-sm font-medium">Guardian permission</label><select id="guardian-consent" value={guardian} disabled={locked} onChange={(event) => setGuardian(event.target.value as typeof guardian)} className="mt-2 min-h-11 w-full rounded-lg border bg-background px-3 text-base"><option value="">Select the applicable confirmation</option><option value="confirmed">Required guardian permission is confirmed</option><option value="not_required">All participants are adults; guardian permission is not required</option></select>
              <label className="mt-5 flex min-h-11 cursor-pointer items-start gap-3 text-sm leading-6"><input type="checkbox" checked={processing} disabled={locked} onChange={(event) => setProcessing(event.target.checked)} className="mt-1 size-5 shrink-0 accent-sky-700" /><span>I have permission to use private Vercel Blob storage, Soniox transcription and the OpenRouter drafting model for this class’s evidence.</span></label>
              <p className="mt-4 text-xs leading-5 text-muted-foreground">Cloud captures expire after 24 hours. You can delete them earlier. Copies downloaded to your device need to be deleted separately.</p>
              <Button className="mt-5 min-h-12 w-full text-base" disabled={locked || loading || Boolean(sessionError) || offline || !selected || !topic.trim() || !participants || !guardian || !processing} onClick={() => void createCapture()}>{busy ? <Loader2 className="animate-spin" /> : <ArrowRight />}Prepare class capture</Button>
            </section>
          </div> : <>
            <section className="mb-5 flex flex-wrap items-center justify-between gap-4 rounded-xl border bg-card p-4 sm:px-5"><div className="min-w-0"><p className="text-xs font-medium text-primary">{formatBangkokDateTime(capture.session.startTime, { day: "numeric", month: "short" })} · {sessionTime(capture.session)} · Bangkok</p><h2 className="mt-1 text-lg font-semibold">{capture.session.studentName}<span className="ml-2 text-sm font-normal text-muted-foreground">{capture.session.title}</span></h2><p className="mt-1 text-xs text-muted-foreground">{capture.session.teacherName} · Consent confirmed</p></div><span className="inline-flex items-center gap-1.5 rounded-full bg-amber-50 px-3 py-1.5 text-xs font-medium text-amber-800"><span className="size-1.5 rounded-full bg-amber-500" />{savedReview ? "Reviewed draft" : "Draft only"}</span></section>
            <div className="grid items-start gap-5 lg:grid-cols-[minmax(0,1.1fr)_minmax(0,0.9fr)]">
              <div className="space-y-5">
                <section className="rounded-2xl border bg-card p-5 sm:p-6" aria-labelledby="after-class-heading">
                  <h2 id="after-class-heading" className="text-xl font-semibold">Add feedback after class</h2>
                  <p className="mt-2 text-sm leading-6 text-muted-foreground">Upload a recording you already have, or write your feedback from your own observations.</p>
                  <p className="mt-2 text-sm leading-6 text-muted-foreground">For iPhone recording with the screen locked, use Voice Memos. Save or share the recording to Files, then choose the M4A file here.</p>
                  <div className="mt-4 flex flex-wrap gap-2">
                    <Button className="min-h-12" disabled={locked || recordingLimitReached} onClick={() => audioInput.current?.click()}><FileUp />Upload saved audio</Button>
                    <Button variant="outline" className="min-h-12" disabled={locked} onClick={() => { setManualDraft(true); requestAnimationFrame(() => document.getElementById("draft-heading")?.scrollIntoView({ behavior: "smooth", block: "start" })); }}>Write feedback myself</Button>
                  </div>
                </section>
                <RecordingPanel captureId={capture.id} ownerEmail={ownerEmail} disabled={!active || Boolean(busy)} recordingLimitReached={recordingLimitReached} remainingRecordingBytes={remainingRecordingBytes} debriefExists={debriefExists} onFile={addRecording} onActiveChange={setRecording} />
                <section className="rounded-2xl border bg-card p-5 sm:p-6">
                  <div className="flex items-center justify-between gap-3"><h2 className="text-xl font-semibold">Worksheet photos</h2><ImagePlus className="size-5 text-primary" /></div>
                  <label className="mt-3 flex min-h-11 cursor-pointer items-start gap-3 text-sm leading-6"><input type="checkbox" checked={worksheetPermission} disabled={locked} onChange={(event) => setWorksheetPermission(event.target.checked)} className="mt-1 size-5 shrink-0 accent-sky-700" /><span>I have permission to upload these worksheets. They contain no faces, unrelated children or unrelated personal details.</span></label>
                  <Button className="mt-3 min-h-11 w-full" disabled={locked || !worksheetPermission || offline || !data.availability.storage} onClick={() => photoInput.current?.click()}><ImagePlus />Add worksheet photos</Button>
                  <p className="mt-2 text-xs leading-5 text-muted-foreground">Photos upload automatically. No count limit; JPG/PNG up to 8 MB each. Tap to preview. Photos are for your review; the draft uses your transcript.</p>
                  {photoBatch && <Button variant="outline" className="mt-2 min-h-11" onClick={() => { cancelPhotos.current = true; controller.current?.abort(); }}>Cancel remaining uploads</Button>}
                  <WorksheetGallery captureId={capture.id} items={[...items.entries()].filter(([, item]) => (item.remote?.kind ?? item.local?.kind) === "worksheet")} busy={locked || offline} errors={photoErrors} progress={progress} uploadAllowed={worksheetPermission && data.availability.storage} onUpload={file => void uploadFile(file)} onRemove={id => void removeItem(id)} />
                </section>
              </div>
              <div className="space-y-5">
                <section className="rounded-2xl border bg-card p-5 sm:p-6"><div className="flex flex-wrap items-center justify-between gap-2"><h2 className="text-lg font-semibold">Your class evidence</h2><span className="text-xs text-muted-foreground">{audioCount} audio {audioCount === 1 ? "file" : "files"}</span></div><p className="mt-2 text-xs leading-5 text-muted-foreground">Uploads are private. Start transcription explicitly for each audio file. English, Thai and mixed language are supported by the configured service.</p>
                  {!data.availability.storage && <p role="status" className="mt-3 rounded-lg bg-amber-50 p-3 text-xs leading-5 text-amber-900">Private upload storage is not configured. Download your audio to keep it beyond this browser’s recovery window.</p>}
                  {!data.availability.transcription && <p role="status" className="mt-3 rounded-lg bg-amber-50 p-3 text-xs leading-5 text-amber-900">Transcription is unavailable until the approved provider is configured. No transcript will be invented.</p>}
                  <div className="mt-4 space-y-3">{[...items.entries()].filter(([, item]) => (item.remote?.kind ?? item.local?.kind) !== "worksheet").map(([id, item]) => <AssetCard key={id} captureId={capture.id} id={id} {...item} busy={locked || offline} progress={progress?.id === id ? progress.value : undefined} uploadAllowed={data.availability.storage && ((item.remote?.kind ?? item.local?.kind) !== "worksheet" || worksheetPermission)} transcriptionAvailable={data.availability.transcription} onUpload={() => { if (item.local && data.availability.storage) void uploadFile(item.local); else setError("Private upload storage is not configured."); }} onTranscribe={() => void transcribeAsset(capture.id, id)} onRemove={() => void run("Removing evidence", async () => { if (item.remote) { await captureRequest(`/${capture.id}/assets/${id}`, "DELETE"); const result = await captureRequest<{ capture: CaptureView }>(`/${capture.id}`); applyCapture(result.capture); } await recovery.current?.remove(ownerEmail, id); setLocalFiles((files) => files.filter((file) => file.id !== id)); setNotice("Evidence and its local recovery copy removed."); })} onCancel={() => controller.current?.abort()} />)}{!audioCount && <div className="rounded-xl border border-dashed p-5 text-center"><FileUp className="mx-auto mb-2 size-6 text-muted-foreground" /><p className="text-sm text-muted-foreground">Record above, or add existing audio.</p></div>}</div>
                  <Button variant="outline" className="mt-4 min-h-11 w-full" disabled={locked || recordingLimitReached} onClick={() => audioInput.current?.click()}><FileUp />Choose an audio file</Button><p className="mt-2 text-xs leading-5 text-muted-foreground">WebM, MP4/M4A, Ogg or WAV. Up to 100 MB of class audio across 8 sections. Keep the original file until your upload succeeds.</p>
                </section>
                <section className="rounded-2xl border border-sky-200 bg-sky-50/40 p-5 sm:p-6"><Sparkles className="mb-3 size-5 text-primary" /><h2 className="text-lg font-semibold">Bring the lesson together.</h2><p className="mt-2 text-sm leading-6 text-muted-foreground">The draft uses your lesson topic, the class transcript, any voice debrief and authorized prior feedback. Prior feedback is context, not proof of today’s understanding.</p><p className="mt-3 text-xs leading-5 text-muted-foreground">Generating a draft sends this text to the approved AI provider. Read the transcript and check the generated feedback before submitting it.</p>{!data.availability.drafting && <p className="mt-3 text-xs leading-5 text-amber-800">AI drafting is unavailable until the approved provider is configured.</p>}<Button className="mt-5 min-h-12 w-full" disabled={locked || offline || !topic.trim() || !data.availability.drafting || (!notes.trim() && !capture.assets.some((asset) => Boolean(asset.transcript)))} onClick={() => void run("Preparing your draft", async () => { await saveEdits(false, Boolean(currentCapture.current?.draft)); const result = await captureRequest<{ capture: CaptureView }>(`/${capture.id}/draft`, "POST", {}); applyCapture(result.capture, true); setReviewConfirmed(false); setNotice("Draft ready for your review. Nothing has been submitted to Wise or sent to parents."); })}><Sparkles />{capture.draft ? "Regenerate draft" : "Create feedback draft"}</Button>{capture.draft && <p className="mt-2 text-xs text-muted-foreground">Regenerating replaces the current draft.</p>}</section>
              </div>
            </div>
            {(capture.draft || manualDraft) && <section className="mt-6 rounded-2xl border bg-card p-5 sm:p-7" aria-labelledby="draft-heading"><p className="mb-1 text-xs font-semibold tracking-widest text-primary uppercase">03 · Review & finish</p><div className="flex flex-wrap items-center justify-between gap-3"><h2 id="draft-heading" className="text-2xl font-semibold">Your judgment. Your feedback.</h2><span className="rounded-full bg-amber-50 px-3 py-1 text-xs font-medium text-amber-800">{savedReview ? "Reviewed · not submitted" : "Needs tutor review"}</span></div><p className="mt-2 max-w-2xl text-sm leading-6 text-muted-foreground">Write or edit the feedback below. Check names, examples and homework, and include only what the class evidence or your own observations support.</p><div className="mt-6 grid gap-5 sm:grid-cols-2">{(Object.entries(DRAFT_LABELS) as [keyof DraftFields, string][]).map(([key, label]) => <div key={key}><label htmlFor={`draft-${key}`} className="text-sm font-semibold">{label}</label><Textarea id={`draft-${key}`} rows={6} value={fields[key]} maxLength={8000} className="mt-2 text-base leading-6" disabled={locked} onChange={(event) => { setFields((value) => ({ ...value, [key]: event.target.value })); setReviewConfirmed(false); }} /></div>)}</div><label className="mt-6 flex min-h-11 cursor-pointer items-start gap-3 rounded-xl bg-muted/50 p-4 text-sm leading-6"><input type="checkbox" checked={reviewConfirmed} disabled={locked} onChange={(event) => setReviewConfirmed(event.target.checked)} className="mt-0.5 size-5 shrink-0 accent-sky-700" /><span>I reviewed the evidence and edited this draft. Claims about understanding are supported; transcript evidence and my observations are accurately represented.</span></label><div className="mt-4 flex flex-col flex-wrap gap-2 sm:flex-row"><Button className="min-h-12" disabled={locked || offline || !reviewConfirmed || !topic.trim()} onClick={() => void run("Saving reviewed draft", async () => { await saveEdits(true); setNotice("Reviewed draft saved. Copy it into your Wise class feedback form and submit there when ready."); })}><CheckCheck />Save reviewed draft</Button><Button variant="outline" className="min-h-12" disabled={locked || !savedReview} onClick={() => void run("Copying reviewed feedback", async () => { try { await navigator.clipboard.writeText(feedbackText(fields)); } catch { throw new Error("Clipboard access was blocked. Select and copy the reviewed fields manually."); } setNotice("Reviewed feedback copied. Open Wise, paste into the class feedback form, and explicitly submit there."); })}><Clipboard />Copy reviewed feedback</Button>{savedReview ? <a className="inline-flex min-h-12 items-center justify-center gap-2 rounded-lg border px-4 text-sm font-medium hover:bg-muted" href={capture.session.wiseUrl} target="_blank" rel="noopener noreferrer">Open Wise to submit<ExternalLink className="size-4" /></a> : <Button variant="outline" className="min-h-12" disabled>Open Wise to submit<ExternalLink /></Button>}</div><p className="mt-4 flex items-start gap-2 text-xs leading-5 text-muted-foreground"><LockKeyhole className="mt-0.5 size-4 shrink-0" /><span>This workspace saves a draft only. Final submission happens in Wise. Existing feedback deadlines and payroll policies still apply.</span></p></section>}
            <footer className="mt-6 rounded-xl border border-dashed p-4"><div className="flex flex-wrap items-start justify-between gap-3"><p className="max-w-xl text-xs leading-5 text-muted-foreground">Capture expires {formatBangkokDateTime(capture.expiresAt)} Bangkok time. Private media, transcripts and drafts are temporary. Save your final feedback in Wise before expiry. Local copies are purged on the next visit after 24 hours.</p><Button variant="ghost" className="min-h-11 text-muted-foreground" disabled={locked} onClick={() => setDiscarding(true)}><Trash2 />Delete capture</Button></div>{discarding && <div className="mt-4 rounded-lg border border-red-200 bg-red-50 p-4"><p className="text-sm leading-6 text-red-900">Delete this capture, its private uploads, transcripts, draft and local recovery copies? Feedback already submitted in Wise is separate.</p><div className="mt-3 flex gap-2"><Button variant="destructive" className="min-h-11" disabled={locked || offline} onClick={() => void run("Deleting capture", async () => { const removed = await captureRequest<{ deleted: boolean; cleanupPending?: boolean }>(`/${capture.id}`, "DELETE"); await recovery.current?.deleteCapture(ownerEmail, capture.id).catch(() => undefined); clearCapturePointer(); currentCapture.current = null; setCapture(null); setManualDraft(false); setLocalFiles([]); setSelected(null); setFields(EMPTY_DRAFT); setTopic(""); setNotes(""); setParticipants(false); setGuardian(""); setProcessing(false); setDiscarding(false); setWorksheetPermission(false); createAttempt.current = null; setNotice(removed.cleanupPending ? "Capture removed from this workspace. Some private copies are queued for deletion; operations can check cleanup. Delete any downloaded files separately." : "Capture deleted. Delete any files you downloaded separately."); })}>Delete capture</Button><Button variant="outline" className="min-h-11" onClick={() => setDiscarding(false)}>Keep capture</Button></div></div>}</footer>
          </>}
        </>}
        <input ref={audioInput} type="file" className="hidden" accept="audio/webm,audio/mp4,audio/x-m4a,audio/m4a,audio/ogg,audio/wav,.m4a,.mp4,.webm,.ogg,.wav" aria-label="Choose existing class audio" onChange={(event) => { void addFiles(event.target.files, "recording"); event.target.value = ""; }} />
        <input ref={photoInput} type="file" className="hidden" accept="image/jpeg,image/png" multiple aria-label="Choose worksheet photos" onChange={(event) => { void addFiles(event.target.files, "worksheet"); event.target.value = ""; }} />
        {busy && <div role="status" className="fixed right-4 bottom-4 left-4 z-30 mx-auto flex max-w-sm items-center justify-center gap-2 rounded-full border bg-background px-4 py-3 text-sm shadow-lg"><Loader2 className="size-4 animate-spin" />{busy}…</div>}
        {!capture && <a href="/post-class-feedback" className="mt-6 inline-flex min-h-11 items-center gap-2 text-sm text-muted-foreground hover:text-primary"><ArrowLeft className="size-4" />Back to Class Feedback</a>}
      </div>
    </div>
  );
}
