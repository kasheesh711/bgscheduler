"use client";

import { useEffect, useRef, useState } from "react";
import { CircleStop, Mic, ShieldCheck, Smartphone } from "lucide-react";
import { Button } from "@/components/ui/button";
import { ClassRecorder, stopReasonMessage, type RecorderSnapshot, type RecordingKind } from "@/lib/class-capture/recorder";
import { LocalRecovery } from "@/lib/class-capture/local-recovery";
import { formatBytes, formatElapsed, type LocalMedia } from "./client-helpers";

const INITIAL: RecorderSnapshot = { status: "idle", elapsedSeconds: 0, bytes: 0, blob: null, mime: "", reason: null, error: null };

export function RecordingPanel({ captureId, ownerEmail, disabled, recordingLimitReached, remainingRecordingBytes, debriefExists, onFile, onActiveChange }: {
  captureId: string;
  ownerEmail: string;
  disabled: boolean;
  recordingLimitReached: boolean;
  remainingRecordingBytes: number;
  debriefExists: boolean;
  onFile: (file: LocalMedia) => void;
  onActiveChange: (active: boolean) => void;
}) {
  const [snapshot, setSnapshot] = useState(INITIAL);
  const [kind, setKind] = useState<RecordingKind>("recording");
  const [consent, setConsent] = useState(false);
  const [recoveryWarning, setRecoveryWarning] = useState<string | null>(null);
  const recorder = useRef<ClassRecorder | null>(null);
  const recovery = useRef<LocalRecovery | null>(null);
  const mounted = useRef(true);
  const callbacks = useRef({ onFile, onActiveChange });
  useEffect(() => { callbacks.current = { onFile, onActiveChange }; }, [onFile, onActiveChange]);
  const active = ["requesting", "recording", "stopping"].includes(snapshot.status);

  useEffect(() => {
    mounted.current = true;
    const hide = () => { if (document.visibilityState === "hidden") recorder.current?.stop("background"); };
    const leave = () => recorder.current?.stop("navigation");
    const unload = (event: BeforeUnloadEvent) => {
      if (["requesting", "recording", "stopping"].includes(recorder.current?.snapshot.status ?? "")) {
        recorder.current?.stop("navigation");
        event.preventDefault();
        event.returnValue = "";
      }
    };
    document.addEventListener("visibilitychange", hide);
    window.addEventListener("pagehide", leave);
    window.addEventListener("beforeunload", unload);
    return () => {
      mounted.current = false;
      recorder.current?.stop("navigation");
      document.removeEventListener("visibilitychange", hide);
      window.removeEventListener("pagehide", leave);
      window.removeEventListener("beforeunload", unload);
    };
  }, []);

  function warn() {
    if (mounted.current) setRecoveryWarning("A recovery copy could not be saved. Keep this page open, then download or upload your audio before leaving.");
  }

  function start(nextKind: RecordingKind) {
    if (!consent || disabled || ["requesting", "recording", "stopping"].includes(recorder.current?.snapshot.status ?? "")) return;
    const id = crypto.randomUUID();
    const name = nextKind === "recording" ? "Class audio" : "Tutor voice debrief";
    const store = recovery.current ??= new LocalRecovery();
    setKind(nextKind);
    setRecoveryWarning(null);
    void store.create(ownerEmail, { captureId, assetId: id, kind: nextKind, name, mime: "" }).catch(warn);
    let delivered = false;
    const attempt = new ClassRecorder({
      kind: nextKind,
      maxBytes: nextKind === "recording" ? remainingRecordingBytes : undefined,
      onChunk: (chunk) => { void store.append(ownerEmail, id, chunk).catch(warn); },
      onChange: (next) => {
        if (mounted.current) {
          setSnapshot(next);
          callbacks.current.onActiveChange(["requesting", "recording", "stopping"].includes(next.status));
        }
        if (next.status === "error") void store.remove(ownerEmail, id).catch(warn);
        if (next.status !== "stopped" || delivered) return;
        delivered = true;
        if (mounted.current) setConsent(false);
        if (next.reason === "cancelled" || !next.blob?.size) { void store.remove(ownerEmail, id).catch(warn); return; }
        void store.finish(ownerEmail, id).catch(warn);
        if (mounted.current) callbacks.current.onFile({ id, kind: nextKind, name, blob: next.blob, incomplete: next.reason !== "user" && next.reason !== "time-limit" });
      },
    });
    recorder.current = attempt;
    void attempt.start(consent);
  }

  return (
    <section className={`rounded-2xl border p-5 sm:p-6 ${active ? "border-red-300 bg-red-50/70 dark:bg-red-950/20" : "border-sky-200 bg-sky-50/50 dark:bg-sky-950/20"}`} aria-labelledby="record-heading">
      <div className="flex items-start justify-between gap-3">
        <div><p className="mb-1 text-xs font-semibold tracking-widest text-primary uppercase">01 · Listen</p><h2 id="record-heading" className="text-xl font-semibold">A little less note-taking.</h2></div>
        <div className={`flex size-11 shrink-0 items-center justify-center rounded-full ${active ? "bg-red-100 text-red-700" : "bg-sky-100 text-primary"}`}><Mic className="size-5" aria-hidden="true" /></div>
      </div>
      <p className="mt-2 text-sm leading-6 text-muted-foreground">Capture the conversation in English, Thai or a mix. Add your own observations after class.</p>
      {active ? (
        <div className="mt-5 space-y-4">
          <div className="flex items-center gap-3" role="status">
            <span className="size-3 rounded-full bg-red-600 motion-safe:animate-pulse" aria-hidden="true" />
            <span className="font-semibold text-red-800 dark:text-red-300">{snapshot.status === "requesting" ? "Waiting for microphone permission" : snapshot.status === "stopping" ? "Saving audio…" : kind === "debrief" ? "Recording tutor debrief" : "Recording class audio"}</span>
          </div>
          <div className="font-mono text-5xl font-medium tracking-tight tabular-nums" aria-label={`${snapshot.elapsedSeconds} seconds recorded`}>{formatElapsed(snapshot.elapsedSeconds)}</div>
          <p className="text-xs text-muted-foreground">{formatBytes(snapshot.bytes)} · {kind === "debrief" ? "3 minute limit" : "2 hour limit"}</p>
          <Button className="min-h-12 w-full bg-red-700 text-white hover:bg-red-800" disabled={snapshot.status === "stopping"} onClick={() => recorder.current?.stop("user")}><CircleStop />Stop recording</Button>
          <Button variant="ghost" className="min-h-11 w-full" onClick={() => recorder.current?.stop("cancelled")}>Cancel this recording</Button>
        </div>
      ) : (
        <div className="mt-5 space-y-3">
          <label className="flex min-h-11 cursor-pointer items-start gap-3 rounded-xl border bg-background/80 p-3 text-sm leading-5">
            <input type="checkbox" className="mt-0.5 size-5 shrink-0 accent-sky-700" checked={consent} disabled={disabled} onChange={(event) => setConsent(event.target.checked)} />
            <span>All participants still agree to this recording. Required guardian permission is in place.</span>
          </label>
          <Button className="min-h-12 w-full text-base" onClick={() => start("recording")} disabled={disabled || !consent || recordingLimitReached}><Mic />Start class recording</Button>
          <Button variant="outline" className="min-h-11 w-full" onClick={() => start("debrief")} disabled={disabled || !consent || debriefExists}><Mic />Record a tutor debrief <span className="text-xs opacity-65">· 3 min</span></Button>
          <p className="text-xs leading-5 text-muted-foreground">{formatBytes(remainingRecordingBytes)} remaining across this class’s audio sections. Recording stops at the remaining limit.</p>
          {recordingLimitReached && <p className="text-xs text-muted-foreground">The class audio limit has been reached.</p>}
        </div>
      )}
      <div className="mt-5 flex gap-2 text-xs leading-5 text-muted-foreground"><Smartphone className="mt-0.5 size-4 shrink-0" aria-hidden="true" /><p>Keep this page open and your screen unlocked. Switching apps, locking the screen or a call may stop recording. Background recording is not supported.</p></div>
      <div className="mt-3 flex gap-2 text-xs leading-5 text-muted-foreground"><ShieldCheck className="mt-0.5 size-4 shrink-0" aria-hidden="true" /><p>Audio stays on this device until you choose Upload. Local recovery is best effort, on this browser and device for up to 24 hours.</p></div>
      {(snapshot.error || stopReasonMessage(snapshot.reason) || recoveryWarning) && <p role="alert" className="mt-4 rounded-lg border border-amber-200 bg-amber-50 p-3 text-sm leading-5 text-amber-900 dark:bg-amber-950 dark:text-amber-100">{snapshot.error || stopReasonMessage(snapshot.reason) || recoveryWarning}</p>}
      {recoveryWarning && (snapshot.error || stopReasonMessage(snapshot.reason)) && <p role="alert" className="mt-3 text-sm text-amber-800">{recoveryWarning}</p>}
      {active && <div className="fixed right-4 bottom-4 left-4 z-40 mx-auto flex max-w-md items-center gap-3 rounded-2xl border border-red-200 bg-background px-4 py-3 shadow-xl" aria-label="Persistent recording controls"><span className="size-2.5 shrink-0 rounded-full bg-red-600 motion-safe:animate-pulse" aria-hidden="true" /><div className="min-w-0 flex-1"><p className="text-sm font-semibold text-red-800 dark:text-red-300">{snapshot.status === "requesting" ? "Microphone permission" : snapshot.status === "stopping" ? "Saving audio" : "Recording"}</p><p className="font-mono text-xs tabular-nums text-muted-foreground">{formatElapsed(snapshot.elapsedSeconds)}</p></div><Button className="min-h-12 bg-red-700 px-4 text-white hover:bg-red-800" disabled={snapshot.status === "stopping"} onClick={() => recorder.current?.stop("user")}><CircleStop />Stop recording now</Button></div>}
    </section>
  );
}
