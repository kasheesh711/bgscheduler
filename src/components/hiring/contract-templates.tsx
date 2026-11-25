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
      <p className={r.offerTaskNote} role="status">{busy ? "Opening PDF…" : message}</p>
    </>
  );
}

export function ContractTemplates({ templates, reload, showLoadError, retrying, onRetry }: ReturnType<typeof useContractTemplates> & {
  showLoadError: boolean;
  retrying: boolean;
  onRetry: (button: HTMLButtonElement) => void;
}) {
  const [busy, setBusy] = useState<OfferType>();
  const [replacing, setReplacing] = useState<OfferType>();
  const [message, setMessage] = useState("");
  const replacement = useRef<HTMLInputElement>(null);
  useLayoutEffect(() => {
    if (replacing) replacement.current?.focus();
  }, [replacing]);

  if (templates === undefined) return <p className={r.offerTaskNote} role="status">Loading templates…</p>;
  if (templates === null) return (
    <div>
      {showLoadError && <p className={retrying ? r.offerTaskNote : r.offerNote} role="status">{retrying ? "Loading templates…" : "Could not load templates."}</p>}
      <button type="button" className={r.offerControl} aria-disabled={retrying || undefined} onClick={(event) => {
        if (!retrying) onRetry(event.currentTarget);
      }}>Retry</button>
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

export function SignedContract({ candidateId, name, fileAction, pdf, form, onUnverified, onVerified, children }: {
  candidateId: string;
  name: string;
  fileAction: "Upload signed PDF" | "Upload PDF" | "Replace PDF";
  pdf: ReactNode;
  form: ReactNode;
  onUnverified: () => void;
  onVerified: (date: string, refresh: boolean) => Promise<void>;
  children: ReactNode;
}) {
  const id = useId();
  const [phase, setPhase] = useState<"preflight" | "existing" | "uploading" | "verifying" | "checking" | "unverified" | "saved">();
  const [error, setError] = useState("");
  const alert = useRef<HTMLParagraphElement>(null);
  const input = useRef<HTMLInputElement>(null);
  const check = useRef<HTMLButtonElement>(null);
  const restoreFocus = useRef(false);
  const busy = phase === "preflight" || phase === "uploading" || phase === "verifying" || phase === "checking";

  useLayoutEffect(() => {
    const active = document.activeElement;
    if (!restoreFocus.current || (active !== document.body && active !== input.current && active !== check.current)) return;
    if (phase === "unverified") check.current?.focus();
  }, [phase]);

  useLayoutEffect(() => {
    if (error) alert.current?.closest("tr")?.scrollIntoView({ block: "nearest" });
  }, [error]);

  async function filedDate() {
    const response = await fetch(`${SIGNED}?candidateId=${candidateId}`, { cache: "no-store" });
    if (!response.ok) throw new Error();
    const { uploadedAt } = await response.json();
    if (uploadedAt === null) return null;
    if (typeof uploadedAt !== "string" || !Number.isFinite(Date.parse(uploadedAt))) throw new Error();
    return uploadedAt;
  }

  async function verify(recheck = false) {
    setPhase(recheck ? "checking" : "verifying");
    try {
      const uploadedAt = await filedDate();
      if (!uploadedAt) throw new Error();
      setPhase("saved");
      await onVerified(uploadedAt, true);
      // WebKit can lose focus when the refreshed list moves this row.
      const focusNext = () => {
        const section = document.getElementById("approved-offers");
        const active = document.activeElement;
        if (restoreFocus.current && (active === document.body || active === section || active === input.current)) {
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
    setPhase(undefined);
    if (!file.size) return setError("Choose a PDF with content.");
    if (file.size > 25 * 1024 * 1024) return setError("Choose a PDF of 25 MB or less.");
    if (file.type ? file.type !== "application/pdf" : !/\.pdf$/i.test(file.name)) return setError("Choose a PDF.");
    const replace = fileAction === "Replace PDF";
    if (!replace) {
      setPhase("preflight");
      let uploadedAt;
      try {
        uploadedAt = await filedDate();
      } catch {
        setError("Could not check for a filed PDF. Try again.");
        setPhase(undefined);
        return;
      }
      if (uploadedAt) {
        await onVerified(uploadedAt, false);
        setPhase("existing");
        return;
      }
    }
    restoreFocus.current = true;
    setPhase("uploading");
    try {
      await upload(`hiring-signed-contracts/${candidateId}.pdf`, file, {
        access: "private", handleUploadUrl: SIGNED, clientPayload: JSON.stringify({ candidateId, replace }), contentType: "application/pdf",
      });
    } catch {
      if (!replace) {
        const uploadedAt = await filedDate().catch(() => null);
        if (uploadedAt) {
          await onVerified(uploadedAt, false);
          setPhase("existing");
          return;
        }
      }
      setError("Upload failed. Try again.");
      setPhase(undefined);
      return;
    }
    await verify();
  }

  const primary = fileAction === "Upload signed PDF";
  const controlClass = primary ? r.offerControl : `${r.offerControl} ${r.offerQuietControl}`;
  const fileControl = phase === "unverified" || phase === "checking" ? (
    <button ref={check} type="button" className={controlClass} aria-disabled={phase === "checking" || undefined}
      onClick={() => {
        if (phase === "checking") return;
        restoreFocus.current = true;
        void verify(true);
      }}>Check file</button>
  ) : (
    <label className={controlClass} data-primary={primary ? "" : undefined} onClick={busy ? (event) => event.preventDefault() : undefined}>
      {fileAction}
      <input ref={input} className="sr-only" type="file" accept=".pdf,application/pdf" aria-disabled={busy || undefined}
        aria-label={`${fileAction} for ${name}`} aria-describedby={error ? id : undefined} aria-invalid={!!error || undefined}
        onChange={(event) => { void choose(event.target.files?.[0]); event.target.value = ""; }} />
    </label>
  );

  const fileActions = (
    <>
      {fileControl}
      {error && <p ref={alert} id={id} className={r.offerTaskNote} role="alert">{error}</p>}
    </>
  );
  const status = phase === "uploading" ? "Uploading PDF…" : busy ? "Checking the file…"
    : phase === "existing" ? "Existing PDF found. Your file was not uploaded."
    : phase === "saved" ? `${name}'s PDF filed.`
    : phase === "unverified" ? `Could not confirm the signed PDF for ${name}.`
    : null;
  return (
    <>
      <td className={r.offerNext} role="cell">
        {primary ? <>{fileActions}<p className={r.offerTaskNote} role="status">{busy ? status : null}</p></> : children}
      </td>
      <td className={r.offerPdf} role="cell">
        {pdf}
        {!primary && <div>{fileActions}</div>}
        <p className={phase === "saved" || phase === "unverified" ? "sr-only" : r.offerTaskNote} role="status">
          {!primary || phase === "unverified" ? status : null}
        </p>
      </td>
      {form}
    </>
  );
}
