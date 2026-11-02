"use client";

import { useState } from "react";
import { upload } from "@vercel/blob/client";
import { PAPER_LEVELS, SUBJECTS, type HiringConfig, type PaperLevel, type Subject } from "@/lib/hiring/model";
import type { Command, HiringData } from "./dashboard";
import css from "./dashboard.module.css";

export type ResultKind = "paper" | "mock";
type FileKind = "question_paper" | "mark_scheme" | "paper_scan" | "mock_rubric";

const postJson = async (url: string, body: unknown) => {
  const response = await fetch(url, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });
  // A platform timeout answers with a page, not JSON.
  const value = await response.json().catch(() => null);
  if (!value) throw new Error("The server did not answer. Refresh the page and check the result before you try again.");
  if (!response.ok) throw new Error(value.error);
  return value;
};

/** Uploads a scan, links it to the result, then marks it. The upload is saved first, so a failed mark keeps it. */
export async function runMarking(kind: ResultKind, candidateId: string, subject: Subject, file: File, reload: () => Promise<void>) {
  const id = await uploadAssessmentFile({ kind: kind === "paper" ? "paper_scan" : "mock_rubric", subject, candidateId, file });
  const ready = await postJson("/api/hiring", { action: "file_ready", id });
  await markAgain(kind, ready.resultId, reload);
}

export async function markAgain(kind: ResultKind, id: string, reload: () => Promise<void>) {
  try {
    const value = await postJson("/api/hiring/marking", { kind, id });
    if (value.error) throw new Error(value.error);
  } finally {
    await reload().catch(() => undefined);
  }
}

/** Browser to private storage, because a function request body is limited to 4.5 MB. The server then checks the bytes. */
export async function uploadAssessmentFile(input: { kind: FileKind; subject: Subject | null; candidateId: string | null; file: File }) {
  if (input.file.size > 25 * 1024 * 1024) throw new Error("Choose a PDF smaller than 25 MB.");
  if (input.file.type && input.file.type !== "application/pdf") throw new Error("Only a PDF can be used here.");
  const response = await fetch("/api/hiring", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ action: "file_intent", kind: input.kind, subject: input.subject, candidateId: input.candidateId, name: input.file.name, size: input.file.size }),
  });
  const intent = await response.json();
  if (!response.ok) throw new Error(intent.error);
  await upload(intent.pathname, input.file, { access: "private", handleUploadUrl: "/api/hiring/uploads", clientPayload: intent.id, contentType: "application/pdf" });
  return intent.id as string;
}

export function PassRules({ config, setConfig }: { config: HiringConfig; setConfig: (config: HiringConfig) => void }) {
  const value = (subject: Subject, level: PaperLevel) => config.paperPassRules.find((r) => r.subject === subject && r.level === level)?.percent;
  const change = (subject: Subject, level: PaperLevel, text: string) => {
    const rest = config.paperPassRules.filter((r) => !(r.subject === subject && r.level === level));
    setConfig({ ...config, paperPassRules: text === "" ? rest : [...rest, { subject, level, percent: Math.min(100, Math.max(0, Number(text))) }] });
  };
  return (
    <section className={`${css.setupSection} ${css.setupFull}`}>
      <h2 className={css.panelTitle}>Paper pass marks</h2>
      <p className={css.panelLede}>The percentage a candidate needs to pass each level. A blank level shows the marks and says the pass mark is missing. Save with the button above.</p>
      <div className={css.universityScroll}>
        <table className={css.sheetTable}>
          <thead>
            <tr>
              <th>Subject</th>
              {PAPER_LEVELS.map((level) => (
                <th key={level}>{level}</th>
              ))}
            </tr>
          </thead>
          <tbody>
            {SUBJECTS.map((subject) => (
              <tr key={subject}>
                <td>{subject}</td>
                {PAPER_LEVELS.map((level) => (
                  <td key={level}>
                    <input
                      className={css.numberInput}
                      type="number"
                      min={0}
                      max={100}
                      aria-label={`${subject} ${level} pass percentage`}
                      value={value(subject, level) ?? ""}
                      onChange={(e) => change(subject, level, e.target.value)}
                    />
                  </td>
                ))}
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </section>
  );
}

const fileLink = (file: { id: string; name: string } | undefined) =>
  file ? (
    <a className={css.sourceLink} href={`/api/hiring/file/${encodeURIComponent(file.id)}`} target="_blank" rel="noopener noreferrer">
      {file.name}
    </a>
  ) : (
    <span className={css.warnWord}>Missing</span>
  );

export function PaperLibrary({ data, command, busy }: { data: HiringData; command: Command; busy: boolean }) {
  const [uploading, setUploading] = useState("");
  const [message, setMessage] = useState("");
  const find = (subject: Subject, kind: string) => data.library.find((file) => file.subject === subject && file.kind === kind);
  async function choose(subject: Subject, kind: "question_paper" | "mark_scheme", file: File | undefined) {
    if (!file) return;
    setUploading(`${subject}:${kind}`);
    setMessage("");
    try {
      const id = await uploadAssessmentFile({ kind, subject, candidateId: null, file });
      await command({ action: "file_ready", id });
    } catch (error) {
      setMessage(error instanceof Error ? error.message : "The upload failed.");
    } finally {
      setUploading("");
    }
  }
  const picker = (subject: Subject, kind: "question_paper" | "mark_scheme", label: string) => (
    <label className={css.inlineLink}>
      {uploading === `${subject}:${kind}` ? "Uploading…" : find(subject, kind) ? "Replace" : "Upload"}
      <input
        className="sr-only"
        type="file"
        accept="application/pdf"
        aria-label={`${label} for ${subject}`}
        disabled={busy || !!uploading}
        onChange={(e) => {
          void choose(subject, kind, e.target.files?.[0]);
          e.target.value = "";
        }}
      />
    </label>
  );
  return (
    <section className={`${css.setupSection} ${css.setupFull}`}>
      <h2 className={css.panelTitle}>Paper library</h2>
      <p className={css.panelLede}>
        The AI marks against these files. PDF only: export a Word or Google Docs file first. A subject with no mark scheme is marked from the AI&apos;s own knowledge, and the result shows a warning.
      </p>
      <p className={css.panelLede}>
        AI spend this month: ${data.markingSpend.usd.toFixed(2)}
        {!data.markingSpend.complete && " or more, because a provider left out some costs"}
      </p>
      {message && <p role="alert" className={css.errorText}>{message}</p>}
      <table className={css.sheetTable}>
        <thead>
          <tr>
            <th>Subject</th>
            <th>Question paper</th>
            <th>Mark scheme</th>
          </tr>
        </thead>
        <tbody>
          {SUBJECTS.map((subject) => (
            <tr key={subject}>
              <td>{subject}</td>
              <td>
                {fileLink(find(subject, "question_paper"))} {picker(subject, "question_paper", "Question paper")}
              </td>
              <td>
                {fileLink(find(subject, "mark_scheme"))} {picker(subject, "mark_scheme", "Mark scheme")}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </section>
  );
}
