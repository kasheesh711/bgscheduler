import { PDFDocument } from "pdf-lib";
import path from "node:path";
import { readFile } from "node:fs/promises";
import katex from "katex";
import { documentHtml, escapeHtml, renderHtmlPdf } from "./documents";
import { WorkspaceError, type Paper, type PaperBlock } from "./model";

export const PAPER_RENDERER_VERSION = "begifted-3.1-paper-v4";
const math = (latex: string, displayMode = false) => {
  try { return katex.renderToString(latex, { displayMode, trust: false, throwOnError: true, maxExpand: 1000, maxSize: 20, output: "htmlAndMathml" }); }
  catch { throw new WorkspaceError(400, "An equation could not be preserved. Check the source PDF and reformat it before marking this paper ready."); }
};
export function formattedText(text: string) {
  const pattern = /\\\(([\s\S]*?)\\\)|\\\[([\s\S]*?)\\\]|\$\$([\s\S]*?)\$\$|(?<!\\)\$([^$\n]+)\$/g;
  let result = "", position = 0;
  for (const m of text.matchAll(pattern)) {
    result += escapeHtml(text.slice(position, m.index)).replace(/\n/g, "<br>");
    result += math(m[1] ?? m[2] ?? m[3] ?? m[4], m[2] !== undefined || m[3] !== undefined);
    position = m.index! + m[0].length;
  }
  return result + escapeHtml(text.slice(position)).replace(/\n/g, "<br>");
}
let mathCssPromise: Promise<string> | undefined;
async function mathCss() {
  mathCssPromise ??= (async () => {
    let css = await readFile(path.join(process.cwd(), "node_modules/katex/dist/katex.min.css"), "utf8");
    const fonts = [...new Set(Array.from(css.matchAll(/url\((?:["']?)(fonts\/[^)'"\s]+)(?:["']?)\)/g), m => m[1]))];
    // Embed local fonts so the document renderer needs no network access.
    for (const font of fonts) css = css.split(font).join(`data:font/${font.endsWith("woff2") ? "woff2" : "woff"};base64,${(await readFile(path.join(process.cwd(), "node_modules/katex/dist", font))).toString("base64")}`);
    return css;
  })();
  return mathCssPromise;
}
type Figure = Extract<PaperBlock, { kind: "figure" }>;
const figureKey = (f: Figure) => `${f.page}:${f.box.join(",")}`;
/** Explicit subpart separators are safe line breaks; never split inside an equation. */
export function splitMathSubparts(latex: string) {
  return latex.split(/\\(?:qquad|quad)\s*(?=\\text\{\s*\([a-zivx]+\))/i);
}
export function expandFigureEdges(pixels: Uint8ClampedArray, width: number, height: number, initial: number[], topGuard = 0) {
  let [left, top, right, bottom] = initial;
  const ink = (x: number, y: number) => { const i = (y * width + x) * 4; return pixels[i + 3] > 20 && Math.min(pixels[i], pixels[i + 1], pixels[i + 2]) < 215; };
  const row = (y: number) => { for (let x = left; x < right; x++) if (ink(x, y)) return true; return false; };
  const col = (x: number) => { for (let y = top; y < bottom; y++) if (ink(x, y)) return true; return false; };
  // Snap each edge out to whitespace. A line cut by an estimated crop cannot disappear.
  const maxX = Math.ceil(width * .2), maxY = Math.ceil(height * .2);
  for (let n = 0; n < maxY && top > topGuard + 4 && [0, 1, 2, 3].some(d => row(top + d)); n++) top--;
  for (let n = 0; n < maxY && bottom < height - 1 && [1, 2, 3, 4].some(d => row(bottom - d)); n++) bottom++;
  for (let n = 0; n < maxX && left > 0 && [0, 1, 2, 3].some(d => col(left + d)); n++) left--;
  for (let n = 0; n < maxX && right < width - 1 && [1, 2, 3, 4].some(d => col(right - d)); n++) right++;
  const clipped = (top > topGuard + 4 && row(top)) || (bottom < height - 1 && row(bottom - 1)) || (left > 0 && col(left)) || (right < width - 1 && col(right - 1));
  if (clipped) throw new WorkspaceError(400, "An illustration could not be isolated without clipping. Reformat a clearer source PDF.");
  return [Math.max(0, left - 3), Math.max(topGuard, top - 3), Math.min(width, right + 3), Math.min(height, bottom + 3)];
}
export async function sourceFigures(paper: Paper, source: Buffer) {
  const figures = paper.questions.flatMap(q => (q.blocks ?? []).filter((b): b is Figure => b.kind === "figure"));
  const result = new Map<string, string>();
  if (!figures.length) return result;
  const { getDocument } = await import("pdfjs-dist/legacy/build/pdf.mjs");
  const { createCanvas } = await import("@napi-rs/canvas");
  const assets = path.join(process.cwd(), "node_modules/pdfjs-dist");
  const task = getDocument({ data: new Uint8Array(source), useSystemFonts: false, standardFontDataUrl: `${assets}/standard_fonts/`, cMapUrl: `${assets}/cmaps/`, cMapPacked: true, wasmUrl: `${assets}/wasm/` });
  const pdf = await task.promise;
  try {
    for (const number of new Set(figures.map(f => f.page))) {
      if (number < 1 || number > pdf.numPages) throw new WorkspaceError(400, "An illustration references a missing source page.");
      const page = await pdf.getPage(number);
      const viewport = page.getViewport({ scale: 2 });
      if (viewport.width * viewport.height > 40_000_000) throw new WorkspaceError(400, "A source page is too large to render. Export it as A4 PDF.");
      const canvas = createCanvas(Math.ceil(viewport.width), Math.ceil(viewport.height));
      await page.render({ canvas: canvas as never, canvasContext: canvas.getContext("2d") as never, viewport, annotationMode: 0 }).promise;
      const pixels = canvas.getContext("2d").getImageData(0, 0, canvas.width, canvas.height).data;
      const text = await page.getTextContent();
      for (const f of figures.filter(f => f.page === number)) {
        const [l, t, r, b] = f.box;
        if (l < 0 || t < 0 || r > 1 || b > 1 || r <= l || b <= t) throw new WorkspaceError(400, "An illustration region needs correction. Reformat the source.");
        const normalize = (value: string) => value.toLowerCase().replace(/[^\p{L}]/gu, "");
        const owner = paper.questions.find(q => q.blocks?.includes(f));
        const stems = (owner?.blocks ?? []).filter(v => v.kind === "text").map(v => normalize(v.text));
        let topGuard = 0;
        // The model's approximate region can include the question stem already reflowed above.
        // Remove that exact duplicate text before expanding artwork edges; preserve diagram labels.
        for (const item of text.items) if ("str" in item) {
          const words = normalize(item.str);
          const [, baseline] = viewport.convertToViewportPoint(item.transform[4], item.transform[5]);
          const bottom = baseline + item.height * viewport.scale * .3;
          if (words.length >= 18 && stems.some(s => s.includes(words) || words.includes(s)) && bottom >= (t - .025) * canvas.height && bottom < (t + (b - t) * .4) * canvas.height) topGuard = Math.max(topGuard, Math.ceil(bottom + 6));
        }
        const initial = [Math.max(0, Math.floor((l - .015) * canvas.width)), Math.max(topGuard, Math.floor((t - .015) * canvas.height), 0), Math.min(canvas.width, Math.ceil((r + .015) * canvas.width)), Math.min(canvas.height, Math.ceil((b + .015) * canvas.height))];
        const [x, y, right, bottom] = expandFigureEdges(pixels, canvas.width, canvas.height, initial, topGuard);
        const w = right - x, h = bottom - y;
        const crop = createCanvas(w, h);
        crop.getContext("2d").drawImage(canvas, x, y, w, h, 0, 0, w, h);
        result.set(figureKey(f), `data:image/png;base64,${crop.toBuffer("image/png").toString("base64")}`);
      }
      page.cleanup();
    }
    return result;
  } finally { await task.destroy(); }
}
export function blockHtml(b: PaperBlock, figures: Map<string, string>, pageHeights = new Map<number, number>()) {
  if (b.kind === "part-marks") return '<p class="part-marks">' + escapeHtml(b.label) + ' · ' + b.marks + (b.marks === 1 ? ' mark' : ' marks') + '</p>';
  if (b.kind === "working-area") {
    const points = pageHeights.get(b.page);
    if (!points || b.box[3] <= b.box[1]) throw new WorkspaceError(400, "A working area could not be measured from its source page.");
    const height = (b.box[3] - b.box[1]) * points * 25.4 / 72;
    const spacing = b.lines ? height / b.lines : 0;
    let remaining = height, html = "";
    while (remaining > .01) {
      const segment = Math.min(210, remaining);
      html += '<div class="working-area" aria-label="Working space" style="height:' + segment.toFixed(3) + 'mm;' + (spacing ? 'background-image:repeating-linear-gradient(to bottom,transparent 0,transparent calc(' + spacing.toFixed(3) + 'mm - 1px),#c9d4e1 calc(' + spacing.toFixed(3) + 'mm - 1px),#c9d4e1 ' + spacing.toFixed(3) + 'mm);' : '') + '"></div>';
      remaining -= segment;
    }
    return html;
  }
  if (b.kind === "text") return `<p>${formattedText(b.text)}</p>`;
  if (b.kind === "math") return splitMathSubparts(b.latex).map(part => `<div class="equation">${math(part, b.display)}</div>`).join("");
  if (b.kind === "table") return `<table>${b.headers.length ? `<thead><tr>${b.headers.map(h => `<th>${formattedText(h)}</th>`).join("")}</tr></thead>` : ""}<tbody>${b.rows.map(row => `<tr>${row.map(c => `<td>${formattedText(c)}</td>`).join("")}</tr>`).join("")}</tbody></table>`;
  const data = figures.get(figureKey(b));
  if (!data) throw new WorkspaceError(400, "An original illustration could not be preserved.");
  return `<figure><img src="${data}" alt="${escapeHtml(b.alt)}" style="width:${Math.min(100, (b.box[2] - b.box[0]) * 118)}%"></figure>`;
}
const layoutCss = `.question{break-inside:auto}.working-area{break-inside:auto;width:100%;box-decoration-break:slice}.working-page{height:250mm;break-before:page;break-after:page}.part-marks{font-family:BGLabel;text-align:right;break-before:avoid}.question h2{break-after:avoid}.question>p:first-of-type{break-before:avoid}figure{margin:4mm 0;break-inside:avoid}figure img{max-width:100%;max-height:225mm;object-fit:contain;object-position:left center}table{width:100%;border-collapse:collapse;table-layout:fixed;margin:4mm 0}thead{display:table-header-group}tr{break-inside:avoid}td,th{border:1px solid #c9d4e1;padding:2mm;overflow-wrap:anywhere;text-align:left}th{background:#edf5fe}.answer-line{height:7mm;border-bottom:1px dotted #c9d4e1;break-inside:avoid}.equation{max-width:100%;margin:3mm 0}.katex-display{white-space:normal}.katex{font-size:1.05em}.paper-warning{border:1px solid #c24e00;color:#7c3514;padding:4mm;margin-bottom:5mm}.question-number{font-family:BGLabel}`;
export async function withPaperStyles(html: string) {
  // A long question may span pages; keep each subpart label with its equation.
  return html.replace("</style>", `${await mathCss()}${layoutCss}.question>p:has(+.equation){break-after:avoid}.question>.equation{break-inside:avoid}</style>`);
}
export async function formattedPaperHtml(paper: Paper, figures = new Map<string, string>(), key = false, pageHeights = new Map<number, number>()) {
  const warnings = paper.warnings.length ? `<div class="paper-warning"><strong>Draft — ${paper.warnings.length} items require tutor review. This paper is not ready to use.</strong></div>` : "";
  const blanks = new Set((paper.coverage ?? []).filter(p => p.purpose === "blank").map(p => p.page));
  const blankBefore = (nextPage: number) => {
    if (key) return "";
    let html = "";
    for (const page of [...blanks].sort((a, b) => a - b)) if (page < nextPage) { html += '<section class="working-page" aria-label="Blank working page"></section>'; blanks.delete(page); }
    return html;
  };
  const questions = paper.questions.map((q, i) => blankBefore(Math.min(...(q.sourcePages ?? [q.sourcePage ?? Infinity]))) + `<section class="question" data-question="${escapeHtml(q.id)}"><h2><span class="question-number">${escapeHtml(q.number ?? String(i + 1))}</span> <span class="score">${q.maxMarks > 0 ? `${q.maxMarks} ${q.maxMarks === 1 ? "mark" : "marks"}` : "Marks not supplied"}</span></h2>${key ? `<p>${formattedText(q.rubric)}</p>` : (q.blocks?.map(b => blockHtml(b, figures, pageHeights)).join("") ?? `<p>${formattedText(q.text)}</p>`) + Array.from({ length: q.blocks?.some(b => b.kind === "working-area") ? 0 : q.answerLines ?? 3 }, () => '<div class="answer-line"></div>').join("")}</section>`).join("") + blankBefore(Infinity);
  const content = `${key ? '<p class="callout">Private marking scheme · Tutor review required before use. Do not distribute to students.</p>' : '<div class="meta">Name: __________________________ &nbsp; Date: ______________</div>'}${warnings}${key ? "" : `<p>${formattedText(paper.instructions)}</p>`}<p class="label">Total · ${paper.questions.some(q => !q.maxMarks) ? "Mark allocations need review" : `${Math.round(paper.questions.reduce((n, q) => n + q.maxMarks, 0) * 100) / 100} marks`}</p>${questions}`;
  return withPaperStyles(await documentHtml(paper.title, key ? "Private marking scheme" : "Progress Test", content));
}
export async function renderFormattedPaper(paper: Paper, source: Buffer) {
  const pdf = await PDFDocument.load(source);
  const heights = new Map(pdf.getPages().map((p, i) => [i + 1, p.getRotation().angle % 180 ? p.getWidth() : p.getHeight()]));
  return renderHtmlPdf(await formattedPaperHtml(paper, await sourceFigures(paper, source), false, heights));
}
export async function renderMarkingScheme(paper: Paper) { return renderHtmlPdf(await formattedPaperHtml(paper, undefined, true)); }
