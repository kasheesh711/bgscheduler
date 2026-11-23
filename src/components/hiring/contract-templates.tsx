"use client";

import { useCallback, useEffect, useState } from "react";
import type { ContractTemplate } from "@/lib/hiring/contract-templates";
import { OFFER_LETTERS, type OfferType } from "@/lib/hiring/offer-letters";
import css from "./dashboard.module.css";
import r from "./role-screens.module.css";

const URL = "/api/hiring/contracts";
const FORMATS = [["pdf", "PDF"], ["docx", "Word"]] as const;

/** The blank contract of each type: staff download it for a signing, and upload a new one to replace it. */
export function ContractTemplates() {
  const [templates, setTemplates] = useState<ContractTemplate[]>();
  const [busy, setBusy] = useState<OfferType>();
  const [message, setMessage] = useState("");

  const load = useCallback(async () => {
    const response = await fetch(URL, { cache: "no-store" });
    const data = await response.json().catch(() => null);
    if (!response.ok) throw new Error(data?.error ?? "Could not load the contract templates.");
    setTemplates(data.templates);
  }, []);
  useEffect(() => {
    load().catch((error: Error) => setMessage(error.message));
  }, [load]);

  async function upload(type: OfferType, file: File | undefined) {
    if (!file) return;
    setBusy(type);
    setMessage("");
    try {
      const body = new FormData();
      body.set("type", type);
      body.set("file", file);
      const response = await fetch(URL, { method: "POST", body });
      if (!response.ok) throw new Error((await response.json().catch(() => null))?.error ?? "The upload failed.");
      await load();
      setMessage(`Saved the ${OFFER_LETTERS[type].label.toLowerCase()} contract.`);
    } catch (error) {
      setMessage(error instanceof Error ? error.message : "The upload failed.");
    } finally {
      setBusy(undefined);
    }
  }

  return (
    <div className={r.cards}>
      {(Object.keys(OFFER_LETTERS) as OfferType[]).map((type) => {
        const label = OFFER_LETTERS[type].label;
        const files = FORMATS.flatMap(([format, name]) => {
          const file = templates?.find((template) => template.type === type && template.format === format);
          return file ? [{ format, name, file }] : [];
        });
        return (
          <article key={type} className={r.card}>
            <div className={r.cardMain}>
              <p className={r.name}>{label} contract</p>
              <p className={r.meta}>{!templates ? "Loading…" : files.length
                ? `Updated ${new Date(Math.max(...files.map(({ file }) => Date.parse(file.uploadedAt)))).toLocaleDateString("en-GB", { timeZone: "Asia/Bangkok", dateStyle: "medium" })}`
                : "No template uploaded."}</p>
            </div>
            <div className={r.actions}>
              {files.map(({ format, name }) => (
                <a key={format} className={css.secondary} href={`${URL}?type=${type}&format=${format}`} download>Download {name}</a>
              ))}
              <label className={css.secondary}>
                {busy === type ? "Uploading…" : files.length ? "Replace" : "Upload"}
                <input className="sr-only" type="file" disabled={!!busy} aria-label={`Upload the ${label.toLowerCase()} contract (PDF or Word)`}
                  accept=".pdf,.docx,application/pdf,application/vnd.openxmlformats-officedocument.wordprocessingml.document"
                  onChange={(event) => { void upload(type, event.target.files?.[0]); event.target.value = ""; }} />
              </label>
            </div>
          </article>
        );
      })}
      <p className={r.quiet} role="status">{message || "A PDF or a Word file of up to 4 MB. An upload replaces the file of the same kind."}</p>
    </div>
  );
}
