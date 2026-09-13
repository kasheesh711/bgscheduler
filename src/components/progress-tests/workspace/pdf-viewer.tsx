"use client";
import { useEffect, useRef, useState } from "react";
import type { PDFDocumentProxy } from "pdfjs-dist";
import { ChevronLeft, ChevronRight, Download, ZoomIn, ZoomOut } from "lucide-react";
import css from "./workspace.module.css";

const root = "/api/progress-tests/workspace";
export function PdfViewer({ fileId, title = "Document preview", initialPage = 1 }: { fileId: string; title?: string; initialPage?: number }) {
  const [pdf, setPdf] = useState<PDFDocumentProxy | null>(null);
  const [pageNumber, setPageNumber] = useState(initialPage);
  const [zoom, setZoom] = useState(1);
  const [width, setWidth] = useState(560);
  const [error, setError] = useState("");
  const [loading, setLoading] = useState(true);
  const [image, setImage] = useState<string | null>(null);
  const container = useRef<HTMLDivElement>(null), canvas = useRef<HTMLCanvasElement>(null), text = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const observer = new ResizeObserver(entries => setWidth(Math.max(220, entries[0].contentRect.width - 20)));
    if (container.current) observer.observe(container.current);
    return () => observer.disconnect();
  }, []);
  useEffect(() => {
    let stopped = false, task: ReturnType<typeof import("pdfjs-dist").getDocument> | undefined, objectUrl: string | undefined;
    const abort = new AbortController();
    setLoading(true); setError(""); setPdf(null); setImage(null); setPageNumber(initialPage);
    if (canvas.current) canvas.current.getContext("2d")?.clearRect(0, 0, canvas.current.width, canvas.current.height);
    text.current?.replaceChildren();
    void (async () => {
      const response = await fetch(`${root}/files/${fileId}`, { cache: "no-store", signal: abort.signal });
      if (!response.ok) throw new Error("This document is unavailable. Check your access and try again.");
      const type = response.headers.get("content-type") ?? "";
      if (type.startsWith("image/")) {
        objectUrl = URL.createObjectURL(await response.blob());
        if (!stopped) { setImage(objectUrl); setLoading(false); }
        return;
      }
      if (!type.includes("application/pdf")) throw new Error("Download this original file to view it. Its PDF preview appears after formatting.");
      const bytes = new Uint8Array(await response.arrayBuffer());
      const lib = await import("pdfjs-dist");
      if (stopped) return;
      lib.GlobalWorkerOptions.workerSrc = `${root}/pdf-runtime/worker.mjs?v=${lib.version}`;
      task = lib.getDocument({ data: bytes, cMapUrl: `${root}/pdf-runtime/`, cMapPacked: true, standardFontDataUrl: `${root}/pdf-runtime/`, wasmUrl: `${root}/pdf-runtime/` });
      const doc = await task.promise;
      if (!stopped) { setPdf(doc); setPageNumber(Math.min(initialPage, doc.numPages)); }
    })().catch(e => { if (!stopped) { setError(e instanceof Error ? e.message : "Unable to display the document."); setLoading(false); } });
    return () => { stopped = true; abort.abort(); void task?.destroy(); if (objectUrl) URL.revokeObjectURL(objectUrl); };
  }, [fileId, initialPage]);
  useEffect(() => {
    if (!pdf) return;
    let stopped = false, render: ReturnType<Awaited<ReturnType<PDFDocumentProxy["getPage"]>>["render"]> | undefined, layer: InstanceType<typeof import("pdfjs-dist").TextLayer> | undefined;
    setLoading(true); setError("");
    void (async () => {
      const page = await pdf.getPage(pageNumber);
      if (stopped || !canvas.current || !text.current) return;
      const base = page.getViewport({ scale: 1 }), viewport = page.getViewport({ scale: width / base.width * zoom });
      const surface = canvas.current, target = text.current, ratio = Math.min(window.devicePixelRatio || 1, 2);
      surface.width = Math.ceil(viewport.width * ratio); surface.height = Math.ceil(viewport.height * ratio);
      surface.style.width = `${viewport.width}px`; surface.style.height = `${viewport.height}px`;
      target.replaceChildren(); target.style.width = `${viewport.width}px`; target.style.height = `${viewport.height}px`; target.style.setProperty("--scale-factor", String(viewport.scale)); target.style.setProperty("--total-scale-factor", String(viewport.scale));
      render = page.render({ canvas: surface, viewport, transform: ratio === 1 ? undefined : [ratio, 0, 0, ratio, 0, 0], annotationMode: 0 });
      await render.promise;
      const lib = await import("pdfjs-dist");
      if (stopped) return;
      layer = new lib.TextLayer({ textContentSource: await page.getTextContent(), container: target, viewport });
      await layer.render();
      if (!stopped) setLoading(false);
    })().catch(e => { if (!stopped) { setError(e instanceof Error ? e.message : "Unable to render this page."); setLoading(false); } });
    return () => { stopped = true; render?.cancel(); layer?.cancel(); };
  }, [pdf, pageNumber, zoom, width]);
  return <div className={css.pdfViewer} aria-label={title} ref={container}>
    <div className={css.pdfToolbar}><div className={css.actions}>
      <button type="button" aria-label="Previous PDF page" disabled={!pdf || pageNumber <= 1} onClick={() => setPageNumber(n => n - 1)}><ChevronLeft size={17}/></button>
      <span aria-live="polite">{pdf ? `Page ${pageNumber} of ${pdf.numPages}` : "Preview"}</span>
      <button type="button" aria-label="Next PDF page" disabled={!pdf || pageNumber >= pdf.numPages} onClick={() => setPageNumber(n => n + 1)}><ChevronRight size={17}/></button>
      <button type="button" aria-label="Zoom out" disabled={!pdf || zoom <= .75} onClick={() => setZoom(z => z - .25)}><ZoomOut size={16}/></button>
      <button type="button" aria-label="Zoom in" disabled={!pdf || zoom >= 2} onClick={() => setZoom(z => z + .25)}><ZoomIn size={16}/></button>
    </div><a href={`${root}/files/${fileId}?download=1`} className={css.fileLink}><Download size={15}/>Download</a></div>
    {loading && <p className={css.hint} role="status">Loading document…</p>}
    {error && <p className={css.error} role="alert">{error}</p>}
    {/* Private authenticated image bytes use a short-lived browser object URL. */}
    {/* eslint-disable-next-line @next/next/no-img-element */}
    <div className={css.pdfPages}>{image ? <img src={image} alt={title}/> : <div className={css.pdfPage}><canvas ref={canvas} aria-label={`${title}, page ${pageNumber}`}/><div ref={text} className={css.pdfTextLayer}/></div>}</div>
  </div>;
}
