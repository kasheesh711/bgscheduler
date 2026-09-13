"use client";
import { createContext, useContext, useState, type ButtonHTMLAttributes } from "react";
import { upload } from "@vercel/blob/client";
import { ArrowDown, ArrowUp, FileUp, LoaderCircle, X } from "lucide-react";
import type { Command } from "@/lib/progress-tests/workspace/commands";
import type { PageRef } from "@/lib/progress-tests/workspace/model";
import css from "./workspace.module.css";

export type Serialized<T> = T extends Date ? string : T extends Array<infer U> ? Serialized<U>[] : T extends object ? { [K in keyof T]: Serialized<T[K]> } : T;
export const API = "/api/progress-tests/workspace";
export const fileUrl = (id: string) => `${API}/files/${id}`;
export async function readApi<T>(url: string, init?: RequestInit): Promise<T> {
  const response = await fetch(url, { ...init, cache: "no-store" });
  const body = await response.json();
  if (!response.ok) throw new Error(body.error || "The request failed. Please try again.");
  return body;
}
export async function command(c: Command) { return readApi<{ id?: string; revision?: number; jobId?: string; pathname?: string }>(API, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(c) }); }
export type WorkspaceTransport = {command:typeof command;fileUrl:typeof fileUrl;sampleUpload?:(purpose:"paper"|"key"|"work")=>Uploaded[]};
export const WorkspaceTransportContext=createContext<WorkspaceTransport>({command,fileUrl});
export const useWorkspaceTransport=()=>useContext(WorkspaceTransportContext);
export function Button({ variant = "secondary", className = "", ...props }: ButtonHTMLAttributes<HTMLButtonElement> & { variant?: "primary" | "secondary" | "quiet" }) {
  return <button {...props} type={props.type || "button"} className={`${css.button} ${css[variant]} ${className}`} />;
}
export function Field({ label, children }: { label: string; children: React.ReactNode }) { return <label className={css.field}><span>{label}</span>{children}</label>; }
export function Empty({ title, children }: { title: string; children: React.ReactNode }) { return <div className={css.empty}><div className={css.emptyGlyph}><FileUp size={24} /></div><h3>{title}</h3><p>{children}</p></div>; }
export const formatDate = (value: string | null | undefined) => value ? new Date(value).toLocaleDateString("en-GB", { day: "numeric", month: "short", year: "numeric", timeZone: "Asia/Bangkok" }) : "To be scheduled";
export type Uploaded = { id: string; name: string; mime: string; pageCount: number };
export function UploadField({ ownerKey, purpose, onUploaded, disabled = false }: { ownerKey: string; purpose: "paper" | "key" | "work"; onUploaded: (files: Uploaded[]) => void; disabled?: boolean }) {
  const transport=useWorkspaceTransport();
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState("");
  const accept = purpose === "work" ? ".pdf,.jpg,.jpeg,.png" : ".pdf,.docx";
  if(transport.sampleUpload)return <div className={css.uploadBox}><Button disabled={disabled} onClick={()=>onUploaded(transport.sampleUpload!(purpose))}><FileUp size={16}/>Use sample {purpose=== "work" ? "student work" : purpose=== "key" ? "marking key" : "paper"}</Button><p>Practice file · no upload is sent</p></div>;
  return <div className={css.uploadBox}>
    <label className={css.uploadLabel}><FileUp size={21} /><span>{busy ? "Uploading and checking pages…" : purpose === "work" ? "Choose student work" : purpose === "key" ? "Choose marking key (optional)" : "Choose a test paper"}<small>{purpose === "work" ? "PDF, JPG or PNG · 25 MB per file" : "PDF or DOCX · 25 MB per file"}</small></span>
      <input aria-label={purpose === "work" ? "Upload student work" : purpose === "key" ? "Upload marking key" : "Upload test paper"} type="file" accept={accept} multiple={purpose === "work"} disabled={busy || disabled || !ownerKey} onChange={async event => {
        const files = Array.from(event.target.files || []); event.target.value = "";
        if (!files.length) return;
        setBusy(true); setMessage("");
        const completed: Uploaded[] = [];
        try {
          for (const file of files) {
            if (file.size > 25 * 1024 * 1024) throw new Error("Choose files smaller than 25 MB each.");
            const extension = file.name.split(".").at(-1)?.toLowerCase();
            const mime = ({ pdf: "application/pdf", docx: "application/vnd.openxmlformats-officedocument.wordprocessingml.document", jpg: "image/jpeg", jpeg: "image/jpeg", png: "image/png" } as const)[extension as "pdf" | "docx" | "jpg" | "jpeg" | "png"];
            if (!mime) throw new Error("Unsupported file type.");
            const intent = await command({ action: "upload-intent", ownerKey, name: file.name, mime, size: file.size, purpose });
            await upload(intent.pathname!, file, { access: "private", handleUploadUrl: `${API}/uploads`, clientPayload: intent.id!, contentType: mime, multipart: true });
            const ready = await readApi<{ pageCount: number | null }>(fileUrl(intent.id!), { method: "PATCH", headers: { "Content-Type": "application/json" }, body: "{}" });
            completed.push({ id: intent.id!, name: file.name, mime, pageCount: ready.pageCount ?? 1 });
          }
          setMessage(`${completed.length} file${completed.length === 1 ? "" : "s"} ready to preview.`);
        } catch (error) { setMessage(error instanceof Error ? error.message : "Upload failed."); }
        finally { if (completed.length) onUploaded(completed); setBusy(false); }
      }} />
    </label><p role="status">{busy && <LoaderCircle className={css.spinner} size={14} />}{message}</p>
  </div>;
}
export function PageOrder({ files, order, onOrder, onRemove }: { files: Uploaded[]; order: PageRef[]; onOrder: (order: PageRef[]) => void; onRemove: (id: string) => void }) {
  const {fileUrl}=useWorkspaceTransport();
  const [selected, setSelected] = useState<PageRef | null>(null);
  const move = (index: number, delta: number) => { const next = [...order]; [next[index], next[index + delta]] = [next[index + delta], next[index]]; onOrder(next); };
  return <div className={css.pageOrdering}><p className={css.hint}>Check every page and its order before submitting. All uploaded pages are retained.</p>
    <ol className={css.pageList}>{order.map((page,i) => <li key={`${page.fileId}:${page.page}`}><button type="button" className={css.pageLink} onClick={() => setSelected(page)}>{i + 1}. {files.find(f => f.id === page.fileId)?.name} · page {page.page}</button><button type="button" aria-label={`Move page ${i+1} up`} disabled={!i} onClick={() => move(i,-1)}><ArrowUp size={15}/></button><button type="button" aria-label={`Move page ${i+1} down`} disabled={i === order.length-1} onClick={() => move(i,1)}><ArrowDown size={15}/></button></li>)}</ol>
    <div className={css.actions}>{files.map(file => <Button variant="quiet" key={file.id} onClick={() => { onRemove(file.id); setSelected(null); }}><X size={13}/>Remove {file.name}</Button>)}</div>
    {selected && <iframe className={css.pdfPreview} title="Uploaded page preview" src={`${fileUrl(selected.fileId)}#page=${selected.page}`} />}
  </div>;
}
