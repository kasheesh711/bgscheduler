"use client";

import { useEffect, useRef, useState } from "react";
import type { PDFDocumentProxy } from "pdfjs-dist";
import css from "./dashboard.module.css";

const RUNTIME = "/api/hiring/pdf-runtime";
// shortcut: a résumé is a few pages, so every page is drawn at once and a long file stops here; draw pages on
// scroll when a longer file must show in full. Download always gives the whole file.
const MAX_PAGES = 15;

/**
 * The pages of a PDF, drawn on the page itself. The browser's own PDF viewer is not used: Safari, phones and a
 * sandboxed response each show it blank, and a frame takes the drag that moves a card.
 */
/** `runtime` is the folder of the pdf.js files. A page with no staff session gives its own (the interviewer brief, the paper check). */
export function PdfPages({ src, title, runtime = RUNTIME, maxPages = MAX_PAGES, hasDownload, onUnavailable }: {
  src: string; title: string; runtime?: string; maxPages?: number; hasDownload?: boolean; onUnavailable?: () => void;
}) {
  const box = useRef<HTMLDivElement>(null);
  const sheets = useRef<(HTMLCanvasElement | null)[]>([]);
  const [pdf, setPdf] = useState<PDFDocumentProxy | null>(null);
  const [failed, setFailed] = useState(false);
  const [width, setWidth] = useState(0);
  const [rendered, setRendered] = useState(false);

  useEffect(() => {
    const observer = new ResizeObserver((entries) => setWidth(Math.floor(entries[0].contentRect.width)));
    if (box.current) observer.observe(box.current);
    return () => observer.disconnect();
  }, []);

  useEffect(() => {
    let stopped = false;
    let task: ReturnType<typeof import("pdfjs-dist/legacy/build/pdf.mjs").getDocument> | undefined;
    const abort = new AbortController();
    const holder = box.current;
    void (async () => {
      const response = await fetch(src, { cache: "no-store", signal: abort.signal });
      // A session that ended redirects to the login page, which is a 200.
      if (!response.ok || response.redirected) throw new Error("not a file");
      const data = new Uint8Array(await response.arrayBuffer());
      // The legacy build: HR opens the cards on Safari and on older phones.
      const lib = await import("pdfjs-dist/legacy/build/pdf.mjs");
      if (stopped) return;
      lib.GlobalWorkerOptions.workerSrc = `${runtime}/worker-legacy.mjs?v=${lib.version}`;
      task = lib.getDocument({ data, cMapUrl: `${runtime}/`, cMapPacked: true, standardFontDataUrl: `${runtime}/`, wasmUrl: `${runtime}/` });
      const opened = await task.promise;
      if (!stopped) setPdf(opened);
    })().catch(() => {
      if (!stopped) {
        setFailed(true);
        onUnavailable?.();
      }
    });
    return () => {
      stopped = true;
      abort.abort();
      void task?.destroy();
      // Safari on a phone frees a canvas late and has a total limit, so each one gives its memory back now.
      for (const canvas of holder?.querySelectorAll("canvas") ?? []) canvas.width = canvas.height = 0;
    };
  }, [src, runtime, onUnavailable]);

  const count = pdf ? Math.min(pdf.numPages, maxPages) : 0;
  useEffect(() => {
    if (!pdf || !width) return;
    let stopped = false;
    let render: { cancel: () => void; promise: Promise<unknown> } | undefined;
    void (async () => {
      // Twice the screen's points at least, so small print stays sharp when a phone zooms in.
      const ratio = Math.min(Math.max(window.devicePixelRatio || 1, 2), 3);
      const sample = onUnavailable ? document.createElement("canvas").getContext("2d") : null;
      if (sample) sample.canvas.width = sample.canvas.height = 64;
      let hasContent = !sample;
      for (let number = 1; number <= count; number++) {
        const page = await pdf.getPage(number);
        const canvas = sheets.current[number - 1];
        if (stopped || !canvas) return;
        const viewport = page.getViewport({ scale: width / page.getViewport({ scale: 1 }).width });
        canvas.width = Math.ceil(viewport.width * ratio);
        canvas.height = Math.ceil(viewport.height * ratio);
        // annotationMode 0: no link in the file can be clicked from the card.
        render = page.render({ canvas, viewport, transform: [ratio, 0, 0, ratio, 0, 0], annotationMode: 0 });
        await render.promise;
        if (stopped) return;
        if (sample && !hasContent) {
          // PDF.js can complete successfully and still draw an empty page.
          sample.drawImage(canvas, 0, 0, 64, 64);
          hasContent = sample.getImageData(0, 0, 64, 64).data.some((value, i, pixels) =>
            i % 4 !== 3 && value < 250 && pixels[i - i % 4 + 3] > 0);
        }
      }
      if (!hasContent) throw new Error("Empty PDF preview");
      setRendered(true);
    })().catch(() => {
      if (!stopped) {
        setFailed(true);
        onUnavailable?.();
      }
    });
    return () => {
      stopped = true;
      render?.cancel();
    };
  }, [pdf, width, count, onUnavailable]);

  if (failed) return <p role="alert" className={css.errorText}>
    {hasDownload ? "Preview unavailable." : "This PDF could not be drawn here. Use the link to open it."}
  </p>;
  return (
    <div ref={box} className={css.pdfPages} role="region" aria-label={title} aria-busy={!rendered} tabIndex={0}>
      {!pdf && <p role="status" className={css.inspectorMeta}>Opening the file…</p>}
      {Array.from({ length: count }, (_, i) => (
        <canvas key={i} ref={(el) => void (sheets.current[i] = el)} role="img" aria-label={`${title}, page ${i + 1} of ${pdf?.numPages}`} />
      ))}
      {pdf && pdf.numPages > maxPages && (
        <p className={css.inspectorMeta}>
          The first {maxPages} of {pdf.numPages} pages show here. Use Download for the full file.
        </p>
      )}
    </div>
  );
}
