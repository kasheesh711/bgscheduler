"use client";

import { useEffect, useRef, useState } from "react";
import { Check, Loader2, RotateCcw, Trash2, X } from "lucide-react";
import { Button } from "@/components/ui/button";
import type { CaptureAsset } from "@/lib/class-capture/model";
import type { LocalMedia } from "./client-helpers";
import { useBlobUrl } from "./asset-card";

type Photo = { local?: LocalMedia; remote?: CaptureAsset };
type Props = {
  captureId: string; items: Array<[string, Photo]>; busy: boolean;
  errors: Record<string, string>; progress: { id: string; value: number } | null;
  uploadAllowed: boolean; onUpload: (file: LocalMedia) => void; onRemove: (id: string) => void;
};

function PhotoTile({ id, photo, index, captureId, busy, error, progress, uploadAllowed, onUpload, onRemove, onPreview }: {
  id: string; photo: Photo; index: number; captureId: string; busy: boolean; error?: string; progress?: number;
  uploadAllowed: boolean; onUpload: Props["onUpload"]; onRemove: Props["onRemove"]; onPreview: (url: string) => void;
}) {
  const localUrl = useBlobUrl(photo.local?.blob);
  const uploaded = Boolean(photo.remote && photo.remote.status !== "pending");
  const url = localUrl ?? (uploaded ? `/api/class-capture/${captureId}/assets/${id}` : null);
  return <article className="min-w-0 overflow-hidden rounded-lg border bg-background" aria-label={`Worksheet photo ${index + 1}`}>
    <button type="button" className="relative block aspect-square min-h-11 w-full bg-muted" disabled={!url} onClick={() => { if (url) onPreview(url); }} aria-label={`Preview worksheet photo ${index + 1}`}>
      {/* Private media uses authenticated URLs, not the public image optimizer. */}
      {/* eslint-disable-next-line @next/next/no-img-element */}
      {url && <img src={url} alt={`Worksheet photo ${index + 1}`} loading="lazy" decoding="async" className="size-full object-cover" />}
      <span className="absolute right-1 bottom-1 rounded bg-background/95 p-1 text-xs" aria-label={uploaded ? "Uploaded" : progress !== undefined ? `Uploading ${Math.round(progress)}%` : "Waiting to upload"}>
        {uploaded ? <Check className="size-4 text-emerald-700" /> : progress !== undefined ? <Loader2 className="size-4 animate-spin" /> : "Pending"}
      </span>
    </button>
    <div className="flex items-center justify-center">
      {!uploaded && photo.local && <Button size="icon" variant="ghost" className="min-h-11 min-w-11" disabled={busy || !uploadAllowed} onClick={() => onUpload(photo.local!)} aria-label={`Retry upload photo ${index + 1}`}><RotateCcw className="size-4" /></Button>}
      <Button size="icon" variant="ghost" className="min-h-11 min-w-11" disabled={busy} onClick={() => onRemove(id)} aria-label={`Remove photo ${index + 1}`}><Trash2 className="size-4" /></Button>
    </div>
    {error && !uploaded && <p className="px-2 pb-2 text-xs text-red-700" role="alert">Upload failed. Tap retry.</p>}
  </article>;
}

export function WorksheetGallery({ items, ...props }: Props) {
  const [preview, setPreview] = useState<string | null>(null);
  const dialog = useRef<HTMLDialogElement>(null);
  useEffect(() => { if (preview) dialog.current?.showModal(); }, [preview]);
  if (!items.length) return <p className="mt-3 text-sm text-muted-foreground">No worksheet photos yet.</p>;
  return <>
    <details open className="mt-3">
      <summary className="flex min-h-11 cursor-pointer items-center text-sm font-medium">{items.length} worksheet photos · show / hide</summary>
      <div className="grid max-h-80 grid-cols-3 gap-2 overflow-y-auto overscroll-contain pr-1" aria-label="Worksheet photo gallery" tabIndex={0}>
        {items.map(([id, photo], index) => <PhotoTile key={id} id={id} photo={photo} index={index} {...props} error={props.errors[id]} progress={props.progress?.id === id ? props.progress.value : undefined} onPreview={setPreview} />)}
      </div>
    </details>
    <dialog ref={dialog} onClose={() => setPreview(null)} className="fixed inset-0 m-auto max-h-[95dvh] w-[95vw] max-w-3xl rounded-xl bg-background p-3 backdrop:bg-black/70" aria-label="Worksheet photo preview">
      <div className="mb-2 flex justify-end"><Button variant="outline" className="min-h-11" onClick={() => dialog.current?.close()}><X />Close preview</Button></div>
      {/* eslint-disable-next-line @next/next/no-img-element */}
      {preview && <img src={preview} alt="Full worksheet photo" className="max-h-[80dvh] w-full object-contain" />}
    </dialog>
  </>;
}
