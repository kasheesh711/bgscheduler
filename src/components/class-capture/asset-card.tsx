"use client";

import { useEffect, useState } from "react";
import { Check, Download, FileImage, FileAudio, Loader2, Upload, X } from "lucide-react";
import { Button } from "@/components/ui/button";
import type { CaptureAsset } from "@/lib/class-capture/model";
import { formatBytes, type LocalMedia } from "./client-helpers";

export function useBlobUrl(blob: Blob | undefined) {
  const [url, setUrl] = useState<string | null>(null);
  useEffect(() => {
    if (!blob) return;
    const objectUrl = URL.createObjectURL(blob);
    // This effect owns the browser resource; release it when the file changes or the card unmounts.
    // eslint-disable-next-line react-hooks/set-state-in-effect
    setUrl(objectUrl);
    return () => URL.revokeObjectURL(objectUrl);
  }, [blob]);
  return url;
}

export function AssetCard({ captureId, id, local, remote, busy, progress, uploadAllowed, transcriptionAvailable, onUpload, onTranscribe, onRemove, onCancel }: {
  captureId: string; id: string; local?: LocalMedia; remote?: CaptureAsset; busy: boolean; progress?: number;
  uploadAllowed: boolean;
  transcriptionAvailable: boolean; onUpload: () => void; onTranscribe: () => void; onRemove: () => void; onCancel: () => void;
}) {
  const blobUrl = useBlobUrl(local?.blob);
  const kind = remote?.kind ?? local?.kind ?? "recording";
  const uploaded = remote && remote.status !== "pending";
  const previewUrl = blobUrl ?? (uploaded ? `/api/class-capture/${captureId}/assets/${id}` : null);
  const label = kind === "recording" ? "Class recording" : kind === "debrief" ? "Tutor voice debrief" : "Worksheet photo";
  return (
    <article className="min-w-0 rounded-xl border bg-background p-4">
      <div className="flex items-start gap-3">
        <span className="flex size-10 shrink-0 items-center justify-center rounded-lg bg-muted text-primary">{kind === "worksheet" ? <FileImage className="size-5" /> : <FileAudio className="size-5" />}</span>
        <div className="min-w-0 flex-1"><h3 className="text-sm font-semibold">{label}</h3><p className="mt-0.5 truncate text-xs text-muted-foreground">{formatBytes(local?.blob.size ?? remote?.size ?? 0)} · {uploaded ? "Private upload" : "Only on this device"}</p></div>
        {uploaded && <span className="flex size-7 items-center justify-center rounded-full bg-emerald-100 text-emerald-700" aria-label="Uploaded"><Check className="size-4" /></span>}
      </div>
      {local?.incomplete && <p className="mt-3 text-xs leading-5 text-amber-800 dark:text-amber-300">Recovered after an interruption. The end may be missing; listen before using it.</p>}
      {previewUrl && (kind === "worksheet" ? (
        <details className="mt-3"><summary className="flex min-h-11 cursor-pointer items-center text-sm font-medium text-primary">View worksheet photo</summary>
          {/* A blob or authenticated same-origin media response cannot use the public Next image optimizer. */}
          {/* eslint-disable-next-line @next/next/no-img-element */}
          <img src={previewUrl} alt="Worksheet supplied by the tutor for manual review" className="mt-2 max-h-96 w-full rounded-lg object-contain" />
        </details>
      ) : <audio className="mt-3 h-11 w-full max-w-full" aria-label={`Listen to ${label.toLowerCase()}`} controls preload="none" src={previewUrl} />)}
      {progress !== undefined ? (
        <div className="mt-3"><div role="progressbar" aria-label="Upload progress" aria-valuenow={Math.round(progress)} aria-valuemin={0} aria-valuemax={100} className="h-1.5 overflow-hidden rounded-full bg-muted"><div className="h-full bg-primary transition-all" style={{ width: `${progress}%` }} /></div><div className="mt-2 flex items-center justify-between text-xs text-muted-foreground"><span>Uploading {Math.round(progress)}%</span><Button variant="ghost" className="min-h-11" onClick={onCancel}><X />Cancel upload</Button></div></div>
      ) : <div className="mt-3 flex flex-wrap gap-2">
        {local && !uploaded && <Button className="min-h-11" disabled={busy || !uploadAllowed} onClick={onUpload}><Upload />{remote ? "Retry upload" : "Upload privately"}</Button>}
        {uploaded && kind !== "worksheet" && remote.status !== "transcribed" && remote.status !== "failed" && <Button variant="outline" className="min-h-11" disabled={busy || !transcriptionAvailable} onClick={onTranscribe}>{remote.status === "transcribing" ? <><Loader2 className="size-4" />Check transcript</> : "Transcribe audio"}</Button>}
        {blobUrl && <a className="inline-flex min-h-11 items-center gap-2 rounded-lg border px-3 text-sm font-medium hover:bg-muted" href={blobUrl} download={`${kind}.${kind === "worksheet" ? local?.blob.type === "image/png" ? "png" : "jpg" : local?.blob.type.includes("mp4") ? "m4a" : local?.blob.type.includes("ogg") ? "ogg" : local?.blob.type.includes("wav") ? "wav" : "webm"}`}><Download className="size-4" />Download</a>}
        <Button variant="ghost" className="min-h-11 text-muted-foreground" disabled={busy} onClick={onRemove}>{remote ? "Remove evidence" : "Remove"}</Button>
      </div>}
      {remote?.error && <p className="mt-3 text-xs leading-5 text-amber-800 dark:text-amber-300" role="alert">{remote.error}</p>}
      {remote?.status === "failed" && <p className="mt-3 text-xs leading-5 text-muted-foreground">The processing outcome needs review. Remove this evidence to continue from your tutor observations. An uncertain provider job is not retried automatically.</p>}
      {kind === "worksheet" && <p className="mt-3 text-xs leading-5 text-muted-foreground">For tutor review only. This photo is not read by the drafting model.</p>}
      {remote?.status === "transcribing" && <p className="mt-3 text-xs leading-5 text-muted-foreground">Transcription is processing. Check again in a moment; you can leave and reopen this capture.</p>}
      {remote?.transcript && <details className="mt-3 border-t pt-1"><summary className="flex min-h-11 cursor-pointer items-center text-sm font-medium text-primary">{kind === "debrief" ? "Tutor debrief transcript · your observations" : "Class transcript · audible evidence"}</summary><p className="max-h-64 overflow-y-auto whitespace-pre-wrap text-sm leading-6 text-muted-foreground">{remote.transcript}</p></details>}
    </article>
  );
}
