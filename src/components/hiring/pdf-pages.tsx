"use client";

import { useEffect, useRef, useState } from "react";
import type { PDFDocumentProxy, RenderTask } from "pdfjs-dist";
import css from "./dashboard.module.css";

const RUNTIME = "/api/hiring/pdf-runtime";
// Download always gives the complete document.
const MAX_PAGES = 15;

const FAILED = "This PDF could not be drawn here. Use the link to open it.";

/**
 * The pages of a PDF, drawn on the page itself. The browser's own PDF viewer is not used: Safari, phones and a
 * sandboxed response each show it blank, and a frame takes the drag that moves a card.
 */
/** `runtime` is the folder of the pdf.js files. A page with no staff session gives its own (the interviewer brief, the paper check). */
type PdfProps = { src: string; title: string; runtime?: string; maxPages?: number };

export function PdfPages(props: PdfProps) {
  return <PdfDocument key={JSON.stringify([props.src, props.runtime])} {...props} />;
}

function PdfDocument({ src, title, runtime = RUNTIME, maxPages = MAX_PAGES }: PdfProps) {
  const box = useRef<HTMLDivElement>(null);
  const [pdf, setPdf] = useState<PDFDocumentProxy | null>(null);
  const [error, setError] = useState("");
  const [width, setWidth] = useState(0);

  useEffect(() => {
    const holder = box.current;
    if (!holder) return;
    const observer = new ResizeObserver(([entry]) => {
      const next = Math.floor(entry.contentRect.width);
      if (next > 0 && holder.style.getPropertyValue("--pdf-page-width") !== `${next}px`) {
        // Keep the same place on the page when rotation or browser zoom changes its width.
        const top = holder.getBoundingClientRect().top;
        const anchor = holder.scrollTop > 0 && Array.from(holder.querySelectorAll("canvas")).find((canvas) => canvas.getBoundingClientRect().bottom > top);
        const before = anchor && anchor.getBoundingClientRect();
        holder.style.setProperty("--pdf-page-width", `${next}px`);
        if (anchor && before && before.height) {
          const after = anchor.getBoundingClientRect();
          holder.scrollTop += after.top - top + (top - before.top) * after.height / before.height;
        }
      }
      setWidth(next);
    });
    observer.observe(holder);
    return () => observer.disconnect();
  }, []);

  useEffect(() => {
    let stopped = false;
    let task: ReturnType<typeof import("pdfjs-dist/legacy/build/pdf.mjs").getDocument> | undefined;
    const abort = new AbortController();
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
      if (!stopped) setError(FAILED);
    });
    return () => {
      stopped = true;
      abort.abort();
      void task?.destroy();
    };
  }, [src, runtime]);

  const count = pdf ? Math.min(pdf.numPages, maxPages) : 0;
  useEffect(() => {
    const holder = box.current;
    if (!pdf || !width || !holder) return;

    // Keep the page boxes in the scroll area. Only nearby pages need backing pixels.
    const active = new Map<HTMLCanvasElement, () => void>();
    const ratio = Math.min(Math.max(window.devicePixelRatio || 1, 2), 3);
    const observer = new IntersectionObserver((entries) => {
      for (const entry of entries) {
        const canvas = entry.target as HTMLCanvasElement;
        if (!entry.isIntersecting) {
          active.get(canvas)?.();
          active.delete(canvas);
          continue;
        }
        if (active.has(canvas)) continue;

        let stopped = false;
        let render: RenderTask | undefined;
        active.set(canvas, () => {
          stopped = true;
          render?.cancel();
          // Safari frees large canvases late unless their backing dimensions are cleared.
          canvas.width = canvas.height = 0;
        });
        void (async () => {
          const page = await pdf.getPage(Number(canvas.dataset.page));
          if (stopped) return;
          const size = page.getViewport({ scale: 1 });
          const viewport = page.getViewport({ scale: width / size.width });
          canvas.style.aspectRatio = `${size.width} / ${size.height}`;
          canvas.width = Math.ceil(viewport.width * ratio);
          canvas.height = Math.ceil(viewport.height * ratio);
          // annotationMode 0: no link in the file can be clicked from the card.
          render = page.render({ canvas, viewport, transform: [ratio, 0, 0, ratio, 0, 0], annotationMode: 0 });
          await render.promise;
        })().catch(() => {
          if (!stopped) setError(FAILED);
        });
      }
    }, { root: holder, rootMargin: "128px 0px" });
    for (const canvas of holder.querySelectorAll("canvas")) observer.observe(canvas);
    return () => {
      observer.disconnect();
      observer.takeRecords();
      for (const release of active.values()) release();
    };
  }, [pdf, width, count, error]);

  if (error) return <p role="alert" className={css.errorText}>{error}</p>;
  return (
    <div ref={box} className={css.pdfPages} role="region" aria-label={title} tabIndex={0}>
      {!pdf && <p role="status" className={css.inspectorMeta}>Opening the file…</p>}
      {Array.from({ length: count }, (_, i) => (
        <canvas key={i} data-page={i + 1} width={0} height={0} style={{ width: "var(--pdf-page-width, 100%)", aspectRatio: "595 / 842" }} role="img" aria-label={`${title}, page ${i + 1} of ${pdf?.numPages}`} />
      ))}
      {pdf && pdf.numPages > maxPages && (
        <p className={css.inspectorMeta}>
          The first {maxPages} of {pdf.numPages} pages show here. Use Download for the full file.
        </p>
      )}
    </div>
  );
}
