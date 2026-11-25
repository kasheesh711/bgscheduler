"use client";

import { useCallback, useEffect, useId, useLayoutEffect, useRef, useState, type ReactNode } from "react";
import { upload } from "@vercel/blob/client";
import type { ContractTemplate } from "@/lib/hiring/contract-templates";
import { OFFER_LETTERS, OFFER_TYPES, type OfferType } from "@/lib/hiring/offer-letters";
import r from "./role-screens.module.css";

const URL = "/api/hiring/contracts";
const SIGNED = "/api/hiring/contracts/signed";
const FORMATS = [["pdf", "PDF"], ["docx", "Word"]] as const;

export function useContractTemplates(active: boolean) {
  const [templates, setTemplates] = useState<ContractTemplate[] | null>();
  const reload = useCallback(async () => {
    try {
      const response = await fetch(URL, { cache: "no-store" });
      if (!response.ok) throw new Error();
      const data = await response.json();
      if (!Array.isArray(data.templates)) throw new Error();
      setTemplates(data.templates);
      return true;
    } catch {
      setTemplates(null);
      return false;
    }
  }, []);
  useEffect(() => {
    if (active && templates === undefined) void reload();
  }, [active, reload, templates]);
  return { templates, reload };
}

export function PrintContract({ type, onMissing }: { type: OfferType; onMissing: () => void }) {
  const description = useId();
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState("");

  async function open() {
    if (busy) return;
    setMessage("");
    const tab = window.open("about:blank", "_blank");
    if (!tab) {
      setMessage("Allow pop-ups and retry.");
      return;
    }
    tab.opener = null;
    setBusy(true);
    try {
      const response = await fetch(`${URL}?type=${type}&format=pdf`, { cache: "no-store" });
      if (response.status === 404) {
        tab.close();
        onMissing();
        return;
      }
      if (!response.ok || !response.headers.get("Content-Type")?.startsWith("application/pdf")) throw new Error();
      const pdf = window.URL.createObjectURL(await response.blob());
      tab.location.replace(pdf);
      window.setTimeout(() => window.URL.revokeObjectURL(pdf), 300_000);
    } catch {
      tab.close();
      setMessage("Could not open the PDF. Try again.");
    } finally {
      setBusy(false);
    }
  }

  return (
    <>
      <button type="button" className={r.offerControl} data-primary="" onClick={() => void open()}
        aria-describedby={description} aria-disabled={busy || undefined}>
        Print contract
      </button>
      <span id={description} className={r.offerType}>{OFFER_LETTERS[type].label.replace(/ tutor$/, "")}</span>
      <p className={r.offerNote} role="status">{busy ? "Opening PDF…" : message}</p>
    </>
  );
}

export function ContractTemplates({ templates, reload, showLoadError, retrying, onRetry }: ReturnType<typeof useContractTemplates> & {
  showLoadError: boolean;
  retrying: boolean;
  onRetry: () => void;
}) {
  const [busy, setBusy] = useState<OfferType>();
  const [replacing, setReplacing] = useState<OfferType>();
  const [message, setMessage] = useState("");
  const replacement = useRef<HTMLInputElement>(null);
  useLayoutEffect(() => {
    if (replacing) replacement.current?.focus();
  }, [replacing]);

  if (templates === undefined) return <p className={r.offerNote} role="status">Loading templates…</p>;
  if (templates === null) return (
    <div>
      {showLoadError && <p className={r.offerNote} role="status">{retrying ? "Loading templates…" : "Could not load templates."}</p>}
      <button type="button" className={r.offerControl} disabled={retrying} onClick={onRetry}>Retry</button>
    </div>
  );

  async function save(type: OfferType, file: File | undefined) {
    if (!file) return;
    if (file.size > 4 * 1024 * 1024) return setMessage("Choose a file smaller than 4 MB.");
    setBusy(type);
    setMessage("");
    try {
      const body = new FormData();
      body.set("type", type);
      body.set("file", file);
      const response = await fetch(URL, { method: "POST", body });
      if (!response.ok) throw new Error((await response.json().catch(() => null))?.error ?? "The upload failed.");
      if (await reload()) setMessage("Template saved.");
      setReplacing(undefined);
    } catch (error) {
      setMessage(error instanceof Error ? error.message : "The upload failed.");
    } finally {
      setBusy(undefined);
    }
  }

  return (
    <div className={r.cards}>
      {templates.length === 0 && <p className={r.offerNote} role="status">No templates uploaded.</p>}
      {OFFER_TYPES.map((type) => {
        const label = OFFER_LETTERS[type].label;
        const files = FORMATS.flatMap(([format, name]) => {
          const file = templates.find((template) => template.type === type && template.format === format);
          return file ? [{ format, name, file }] : [];
        });
        return (
          <article key={type} className={r.card} id={`contract-template-${type}`} tabIndex={-1}>
            <div className={r.cardMain}>
              <h3 className={r.name}>{label} contract</h3>
              <p className={r.meta}>{files.length
                ? files.map(({ name, file }) => `${name} · ${new Date(file.uploadedAt).toLocaleDateString("en-GB", { timeZone: "Asia/Bangkok", dateStyle: "medium" })}`).join(" / ")
                : templates.length ? "No template uploaded." : null}</p>
              {replacing === type && <p className={r.meta}>Replaces the file of the same format.</p>}
            </div>
            <div className={r.actions}>
              {files.map(({ format, name }) => (
                <a key={format} className={r.offerControl} href={`${URL}?type=${type}&format=${format}`}>Download {name}</a>
              ))}
              {files.length > 0 && replacing !== type ? (
                <button type="button" className={r.offerControl} disabled={!!busy} onClick={() => setReplacing(type)}>Replace</button>
              ) : (
                <label className={r.offerControl}>
                  {busy === type ? "Uploading…" : "Upload"}
                  <input ref={replacing === type ? replacement : undefined} className="sr-only" type="file" disabled={!!busy} aria-label={`Upload ${label.toLowerCase()} contract`}
                    accept=".pdf,.docx,application/pdf,application/vnd.openxmlformats-officedocument.wordprocessingml.document"
                    onChange={(event) => { void save(type, event.target.files?.[0]); event.target.value = ""; }} />
                </label>
              )}
            </div>
          </article>
        );
      })}
      <p className={r.offerNote} role="status">{busy ? "Uploading template…" : message}</p>
    </div>
  );
}

export function SignedContract({ candidateId, name, canUpload, templateMissing, templateRetryNote, onUnverified, onVerified, children }: {
  candidateId: string;
  name: string;
  canUpload: boolean;
  templateMissing: boolean;
  templateRetryNote: string | null;
  onUnverified: () => void;
  onVerified: (date: string) => Promise<void>;
  children: ReactNode;
}) {
  const id = useId();
  const [phase, setPhase] = useState<"uploading" | "verifying" | "checking" | "unverified" | "saved">();
  const [error, setError] = useState("");
  const input = useRef<HTMLInputElement>(null);
  const check = useRef<HTMLButtonElement>(null);
  const restoreFocus = useRef(false);
  const busy = phase === "uploading" || phase === "verifying" || phase === "checking";

  useLayoutEffect(() => {
    const active = document.activeElement;
    if (!restoreFocus.current || (active !== document.body && active !== input.current && active !== check.current)) return;
    if (phase === "unverified") check.current?.focus();
    if (!phase) input.current?.focus();
  }, [phase]);

  async function verify(recheck = false) {
    setPhase(recheck ? "checking" : "verifying");
    try {
      const response = await fetch(`${SIGNED}?candidateId=${candidateId}`, { cache: "no-store" });
      if (!response.ok) throw new Error();
      const { uploadedAt } = await response.json();
      if (typeof uploadedAt !== "string" || !Number.isFinite(Date.parse(uploadedAt))) throw new Error();
      setPhase("saved");
      await onVerified(uploadedAt);
      // WebKit can lose focus when the refreshed list moves this row.
      const focusNext = () => {
        const section = document.getElementById("approved-offers");
        if (restoreFocus.current && (document.activeElement === document.body || document.activeElement === section)) {
          section?.querySelector<HTMLElement>(`[data-offer-next="${CSS.escape(candidateId)}"]`)?.focus();
        }
      };
      requestAnimationFrame(() => {
        focusNext();
        requestAnimationFrame(focusNext);
      });
    } catch {
      setPhase("unverified");
      onUnverified();
    }
  }

  async function choose(file: File | undefined) {
    if (!file || busy) return;
    setError("");
    if (!file.size) return setError("Choose a PDF with content.");
    if (file.size > 25 * 1024 * 1024) return setError("Choose a PDF of 25 MB or less.");
    if (file.type ? file.type !== "application/pdf" : !/\.pdf$/i.test(file.name)) return setError("Choose a PDF.");
    restoreFocus.current = true;
    setPhase("uploading");
    try {
      await upload(`hiring-signed-contracts/${candidateId}.pdf`, file, { access: "private", handleUploadUrl: SIGNED, clientPayload: candidateId, contentType: "application/pdf" });
    } catch {
      setError("Upload failed. Try again.");
      setPhase(undefined);
      return;
    }
    await verify();
  }

  return (
    <td className={r.offerNext} role="cell">
      {canUpload ? (
        phase === "unverified" || phase === "checking" ? (
          <button ref={check} type="button" className={r.offerControl} aria-disabled={phase === "checking" || undefined}
            onClick={() => {
              if (phase === "checking") return;
              restoreFocus.current = true;
              void verify(true);
            }}>Check file</button>
        ) : (
          <label className={r.offerControl} data-primary="" onClick={busy ? (event) => event.preventDefault() : undefined}>
            Upload signed PDF
            <input ref={input} className="sr-only" type="file" accept=".pdf,application/pdf" aria-disabled={busy || undefined}
              aria-label={`Upload signed PDF for ${name}`} aria-describedby={error ? id : undefined} aria-invalid={!!error || undefined}
              onChange={(event) => { void choose(event.target.files?.[0]); event.target.value = ""; }} />
          </label>
        )
      ) : children}
      <p className={phase === "saved" || phase === "unverified" || templateMissing ? "sr-only" : r.offerNote}
        role="status" data-template-retry={templateRetryNote ? "" : undefined}>
        {templateMissing ? `Template for ${name} not found.`
          : phase === "uploading" ? "Uploading PDF…" : busy ? "Checking the file…"
          : phase === "saved" ? `${name}'s PDF filed.`
          : phase === "unverified" ? `Could not confirm the signed PDF for ${name}.` : templateRetryNote}
      </p>
      {error && <p id={id} className={r.offerNote} role="alert">{error}</p>}
    </td>
  );
}
