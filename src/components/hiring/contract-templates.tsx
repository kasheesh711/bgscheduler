"use client";

import { useCallback, useEffect, useState } from "react";
import { upload } from "@vercel/blob/client";
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
    // A larger body never reaches the server, so its message would not show.
    if (file.size > 4 * 1024 * 1024) return setMessage("Choose a file smaller than 4 MB.");
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
                // One date for each file: a new PDF does not make an old Word file current.
                ? files.map(({ name, file }) => `${name}: ${new Date(file.uploadedAt).toLocaleDateString("en-GB", { timeZone: "Asia/Bangkok", dateStyle: "medium" })}`).join(" · ")
                : "No template uploaded."}</p>
            </div>
            <div className={r.actions}>
              {files.map(({ format, name }) => (
                <a key={format} className={css.secondary} href={`${URL}?type=${type}&format=${format}`}>Download {name}</a>
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

const SIGNED = "/api/hiring/contracts/signed";

/** The signed contract of one hired tutor: staff upload the scan after the signing and can download it again. */
export function SignedContract({ candidateId, name }: { candidateId: string; name: string }) {
  const [uploadedAt, setUploadedAt] = useState<string | null>();
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState("");
  const info = `${SIGNED}?candidateId=${candidateId}`;

  const load = useCallback(async () => {
    const response = await fetch(info, { cache: "no-store" });
    const data = await response.json().catch(() => null);
    if (!response.ok) throw new Error(data?.error ?? "Could not check the signed contract.");
    setUploadedAt(data.uploadedAt);
  }, [info]);
  useEffect(() => {
    load().catch((error: Error) => setMessage(error.message));
  }, [load]);

  async function choose(file: File | undefined) {
    if (!file) return;
    if (file.size > 25 * 1024 * 1024) return setMessage("Choose a PDF smaller than 25 MB.");
    if (file.type && file.type !== "application/pdf") return setMessage("Only a PDF can be used here.");
    setBusy(true);
    setMessage("");
    try {
      // Browser to private storage, because a function request body is limited to 4.5 MB.
      await upload(`hiring-signed-contracts/${candidateId}.pdf`, file, { access: "private", handleUploadUrl: SIGNED, clientPayload: candidateId, contentType: "application/pdf" });
      await load();
      setMessage("Saved.");
    } catch (error) {
      setMessage(error instanceof Error ? error.message : "The upload failed.");
    } finally {
      setBusy(false);
    }
  }

  return (
    <>
      {uploadedAt && <a className={css.secondary} href={`${info}&file=1`}>Signed contract ({new Date(uploadedAt).toLocaleDateString("en-GB", { timeZone: "Asia/Bangkok", day: "numeric", month: "short" })})</a>}
      <label className={css.secondary}>
        {busy ? "Uploading…" : uploadedAt ? "Replace signed contract" : "Upload signed contract"}
        <input className="sr-only" type="file" accept="application/pdf" disabled={busy} aria-label={`Upload the signed contract of ${name} (PDF)`}
          onChange={(event) => { void choose(event.target.files?.[0]); event.target.value = ""; }} />
      </label>
      {message && <p className={r.quiet} role="status">{message}</p>}
    </>
  );
}
