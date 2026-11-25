"use client";

import { useEffect, useState } from "react";
import c from "./booking.module.css";
import p from "./print-pack.module.css";

export type PrintRow = { key: string; name: string; subject: string; time: string; fileId: string | null };

/** The cover of each paper test, then its question paper, merged into one PDF here so no server response limit applies. */
export async function buildFile(token: string, rows: PrintRow[]) {
  const { PDFDocument } = await import("pdf-lib");
  let order: string | null = null;
  const read = async (path: string) => {
    const response = await fetch(path, { cache: "no-store" });
    if (!response.ok) throw new Error(((await response.json().catch(() => null)) as { error?: string } | null)?.error ?? "A file could not be loaded. Reload this page.");
    if (path.endsWith("/covers")) order = response.headers.get("X-Print-Order");
    return PDFDocument.load(await response.arrayBuffer(), { ignoreEncryption: true });
  };
  const ids = [...new Set(rows.flatMap((r) => (r.fileId ? [r.fileId] : [])))];
  const [covers, ...papers] = await Promise.all([read(`/api/hiring/print/${token}/covers`), ...ids.map((id) => read(`/api/hiring/print/${token}/paper/${id}`))]);
  // A test booked, moved or cancelled since the page loaded would put a cover on another candidate's paper.
  if (covers.getPageCount() !== rows.length || order !== rows.map((r) => r.key).join(",")) throw new Error("The list changed while the file was made. Reload this page.");
  const paperOf = new Map(ids.map((id, i) => [id, papers[i]]));
  const out = await PDFDocument.create();
  for (const [i, row] of rows.entries()) {
    const [cover] = await out.copyPages(covers, [i]);
    out.addPage(cover);
    const paper = row.fileId ? paperOf.get(row.fileId) : undefined;
    if (paper) for (const page of await out.copyPages(paper, paper.getPageIndices())) out.addPage(page);
  }
  return out.save();
}

export function PrintPack({ token, date, rows }: { token: string; date: string; rows: PrintRow[] }) {
  const [state, setState] = useState<{ url?: string; error?: string }>({});
  useEffect(() => {
    if (!rows.length) return;
    let url: string | undefined;
    let stopped = false;
    buildFile(token, rows).then((bytes) => URL.createObjectURL(new Blob([new Uint8Array(bytes)], { type: "application/pdf" }))).then((made) => { url = made; if (stopped) URL.revokeObjectURL(made); else setState({ url: made }); })
      .catch((e: unknown) => { if (!stopped) setState({ error: e instanceof Error ? e.message : "The print file could not be made." }); });
    return () => { stopped = true; if (url) URL.revokeObjectURL(url); };
  }, [token, rows]);
  const missing = rows.filter((r) => !r.fileId);
  if (!rows.length) return <p className={c.note}>No paper tests are left to print for {date}.</p>;
  return (
    <div className={p.pack}>
      <p className={p.lead}>{date} · {rows.length} paper {rows.length === 1 ? "test" : "tests"}. Each paper comes after its cover page.</p>
      <ul className={p.rows}>
        {rows.map((r) => (
          <li key={r.key}><b>{r.time}</b><span>{r.name}<small>{r.subject}{r.fileId ? "" : " · cover only, no paper in the library"}</small></span></li>
        ))}
      </ul>
      {!!missing.length && <p role="alert" className={c.alert}>No question paper for {[...new Set(missing.map((r) => r.subject))].join(", ")}. Add it in Hiring, Rules and setup, then reload this page.</p>}
      {state.error ? <p role="alert" className={c.alert}>{state.error}</p>
        : state.url ? (
          <div className={p.actions}>
            <a className={c.button} href={state.url} target="_blank" rel="noopener">Open the print file</a>
            <a className={c.ghost} href={state.url} download={`paper-tests-${date}.pdf`}>Download PDF</a>
          </div>
        ) : <p role="status" className={c.note}>Making one print file of all covers and papers. This takes up to a minute.</p>}
    </div>
  );
}
