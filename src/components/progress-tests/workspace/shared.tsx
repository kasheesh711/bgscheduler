"use client";
import { useState, type Dispatch, type SetStateAction, type ButtonHTMLAttributes } from "react";
import { upload } from "@vercel/blob/client";
import { ArrowDown, ArrowUp, FileUp, LoaderCircle, X } from "lucide-react";
import type { Command } from "@/lib/progress-tests/workspace/commands";
import { sameJsonValue, type PageRef } from "@/lib/progress-tests/workspace/model";
import css from "./workspace.module.css";
import { PdfViewer } from "./pdf-viewer";

export type Serialized<T> = T extends Date ? string : T extends Array<infer U> ? Serialized<U>[] : T extends object ? { [K in keyof T]: Serialized<T[K]> } : T;
export const API = "/api/progress-tests/workspace";
export const fileUrl = (id: string) => `${API}/files/${id}`;
export async function readApi<T>(url: string, init?: RequestInit): Promise<T> {
  const response = await fetch(url, { ...init, cache: "no-store" });
  const body = await response.json();
  if (!response.ok) throw new Error(body.error || "The request failed. Please try again.");
  return body;
}
export async function command(c: Command) { return readApi<{ id?: string; revision?: number; jobId?: string; versionId?: string; pathname?: string }>(API, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(c) }); }
/** Accept refreshed server values only while that field still matches its last saved value. */
export function useSavedDraft<T>(saved: T): [T, Dispatch<SetStateAction<T>>] {
  const [state, setState] = useState({ saved, value: saved });
  if (!sameJsonValue(state.saved, saved)) setState({ saved, value: sameJsonValue(state.value, state.saved) ? saved : state.value });
  return [state.value, next => setState(current => ({ ...current, value: typeof next === "function" ? (next as (value: T) => T)(current.value) : next }))];
}
export function Button({ variant = "secondary", className = "", ...props }: ButtonHTMLAttributes<HTMLButtonElement> & { variant?: "primary" | "secondary" | "quiet" }) {
  return <button {...props} type={props.type || "button"} className={`${css.button} ${css[variant]} ${className}`} />;
}
export function Field({ label, children }: { label: string; children: React.ReactNode }) { return <label className={css.field}><span>{label}</span>{children}</label>; }
export function Empty({ title, children }: { title: string; children: React.ReactNode }) { return <div className={css.empty}><div className={css.emptyGlyph}><FileUp size={24} /></div><h3>{title}</h3><p>{children}</p></div>; }
export const formatDate = (value: string | null | undefined) => value ? new Date(value).toLocaleDateString("en-GB", { day: "numeric", month: "short", year: "numeric", timeZone: "Asia/Bangkok" }) : "To be scheduled";
export type Uploaded = { id: string; name: string; mime: string; pageCount: number };
export function UploadField({ ownerKey, assessmentId, purpose, onUploaded, onBusy, disabled = false }: { ownerKey: string; assessmentId?: string; onBusy?: (busy: boolean) => void; purpose: "paper" | "key" | "work" | "marked"; onUploaded: (files: Uploaded[]) => void; disabled?: boolean }) {
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState("");
  const [progress, setProgress] = useState(0);
  const accept = purpose === "marked" ? ".pdf" : purpose === "work" ? ".pdf,.jpg,.jpeg,.png" : ".pdf,.docx";
  return <div className={css.uploadBox}>
    <label className={css.uploadLabel}><FileUp size={21} /><span>{busy ? "Uploading and checking pages…" : purpose === "marked" ? "Choose tutor-marked test" : purpose === "work" ? "Choose student work" : purpose === "key" ? "Choose marking key (optional)" : "Choose a test paper"}<small>{purpose === "marked" ? "PDF · 25 MB" : purpose === "work" ? "PDF, JPG or PNG · 25 MB per file" : "PDF or DOCX · 25 MB per file"}</small></span>
      <input aria-label={purpose === "marked" ? "Upload marked test" : purpose === "work" ? "Upload student work" : purpose === "key" ? "Upload marking key" : "Upload test paper"} type="file" accept={accept} multiple={purpose === "work"} disabled={busy || disabled || !ownerKey} onChange={async event => {
        const files = Array.from(event.target.files || []); event.target.value = "";
        if (!files.length) return;
        setBusy(true); onBusy?.(true); setProgress(0); setMessage("");
        const completed: Uploaded[] = [];
        try {
          for (const file of files) {
            if (file.size > 25 * 1024 * 1024) throw new Error("Choose files smaller than 25 MB each.");
            const extension = file.name.split(".").at(-1)?.toLowerCase();
            const mime = ({ pdf: "application/pdf", docx: "application/vnd.openxmlformats-officedocument.wordprocessingml.document", jpg: "image/jpeg", jpeg: "image/jpeg", png: "image/png" } as const)[extension as "pdf" | "docx" | "jpg" | "jpeg" | "png"];
            if (!mime) throw new Error("Unsupported file type.");
            const intent = await command({ action: "upload-intent", ownerKey, assessmentId, name: file.name, mime, size: file.size, purpose });
            await upload(intent.pathname!, file, { access: "private", handleUploadUrl: `${API}/uploads`, clientPayload: intent.id!, contentType: mime, multipart: true, onUploadProgress: ({ percentage }) => setProgress(percentage) });
            const ready = await readApi<{ pageCount: number | null }>(fileUrl(intent.id!), { method: "PATCH", headers: { "Content-Type": "application/json" }, body: "{}" });
            completed.push({ id: intent.id!, name: file.name, mime, pageCount: ready.pageCount ?? 1 });
          }
          setMessage(`${completed.length} file${completed.length === 1 ? "" : "s"} ready to preview.`);
        } catch (error) { setMessage(error instanceof Error ? error.message : "Upload failed."); }
        finally { if (completed.length) onUploaded(completed); setBusy(false); onBusy?.(false); }
      }} />
    </label>{busy && <div className={css.uploadProgress}><progress max={100} value={progress} aria-label="File upload progress"/><span>{Math.round(progress)}% uploaded{progress === 100 ? " · checking pages…" : ""}</span></div>}<p role="status">{busy && <LoaderCircle className={css.spinner} size={14} />}{message}</p>
  </div>;
}
export function PageOrder({ files, order, onOrder, onRemove }: { files: Uploaded[]; order: PageRef[]; onOrder: (order: PageRef[]) => void; onRemove: (id: string) => void }) {
  const [selected, setSelected] = useState<PageRef | null>(null);
  const move = (index: number, delta: number) => { const next = [...order]; [next[index], next[index + delta]] = [next[index + delta], next[index]]; onOrder(next); };
  return <div className={css.pageOrdering}><p className={css.hint}>Check every page and its order before submitting. All uploaded pages are retained.</p>
    <ol className={css.pageList}>{order.map((page,i) => <li key={`${page.fileId}:${page.page}`}><button type="button" className={css.pageLink} onClick={() => setSelected(page)}>{i + 1}. {files.find(f => f.id === page.fileId)?.name} · page {page.page}</button><button type="button" aria-label={`Move page ${i+1} up`} disabled={!i} onClick={() => move(i,-1)}><ArrowUp size={15}/></button><button type="button" aria-label={`Move page ${i+1} down`} disabled={i === order.length-1} onClick={() => move(i,1)}><ArrowDown size={15}/></button></li>)}</ol>
    <div className={css.actions}>{files.map(file => <Button variant="quiet" key={file.id} onClick={() => { onRemove(file.id); setSelected(null); }}><X size={13}/>Remove {file.name}</Button>)}</div>
    {selected && <PdfViewer fileId={selected.fileId} initialPage={selected.page} title="Uploaded page preview"/>}
  </div>;
}
