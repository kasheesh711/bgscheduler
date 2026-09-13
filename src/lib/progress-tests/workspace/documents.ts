import { existsSync } from "node:fs";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { PDFDocument } from "pdf-lib";
import { type Browser, chromium as playwright } from "playwright-core";
import { validateMarks, WorkspaceError, type Paper, type Review } from "./model";
import { readBlobBytes, type StoredFile } from "./files";

export const escapeHtml = (value: unknown) => String(value ?? "").replace(/[&<>"']/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]!));
const brandDir = path.join(process.cwd(), "public/brand/progress-tests");
let assetsPromise: Promise<{ fonts: string; logo: string }> | undefined;
async function brandAssets() {
  assetsPromise ??= (async () => {
    const [head, body, labels, logo, thai] = await Promise.all([
      readFile(path.join(brandDir, "fonts/space-grotesk-latin-600-normal.woff2")),
      readFile(path.join(brandDir, "fonts/sarabun-latin-400-normal.woff2")),
      readFile(path.join(brandDir, "fonts/inter-latin-600-normal.woff2")), readFile(path.join(brandDir, "logo.png")),
      readFile(path.join(brandDir, "fonts/sarabun-thai-400-normal.woff2")),
    ]);
    return { fonts: `@font-face{font-family:BGHead;src:url(data:font/woff2;base64,${head.toString("base64")})} @font-face{font-family:BGBody;src:url(data:font/woff2;base64,${body.toString("base64")})} @font-face{font-family:BGThai;src:url(data:font/woff2;base64,${thai.toString("base64")})} @font-face{font-family:BGLabel;src:url(data:font/woff2;base64,${labels.toString("base64")})}`, logo: `data:image/png;base64,${logo.toString("base64")}` };
  })();
  return assetsPromise;
}
export async function launchDocumentBrowser(): Promise<Browser> {
  if (process.env.VERCEL || process.env.AWS_LAMBDA_FUNCTION_NAME) {
    const { default: chromium } = await import("@sparticuz/chromium");
    chromium.setGraphicsMode = false;
    return playwright.launch({ executablePath: await chromium.executablePath(), args: chromium.args.filter(a => !a.startsWith("--user-data-dir")), headless: true });
  }
  const executablePath = [process.env.CHROME_EXECUTABLE_PATH, "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome", "/Applications/Chromium.app/Contents/MacOS/Chromium", "/usr/bin/google-chrome", "/usr/bin/chromium"].find(p => p && existsSync(p));
  if (!executablePath) throw new WorkspaceError(503, "The PDF conversion runtime is unavailable.");
  return playwright.launch({ executablePath, headless: true });
}
export async function renderHtmlPdf(html: string) {
  const browser = await launchDocumentBrowser();
  try {
    const context = await browser.newContext({ serviceWorkers: "block" });
    await context.route("**/*", route => route.abort());
    const page = await context.newPage();
    await page.setContent(html, { waitUntil: "load", timeout: 30_000 });
    await page.evaluate(() => document.fonts.ready);
    const broken = await page.evaluate(() => Array.from(document.images).some(i => !i.complete || i.naturalWidth === 0));
    if (broken) throw new WorkspaceError(400, "A document illustration could not be rendered.");
    return Buffer.from(await page.pdf({ format: "A4", printBackground: true, preferCSSPageSize: true, tagged: true,
      displayHeaderFooter: true, headerTemplate: "<span></span>", footerTemplate: '<div style="font-size:8px;color:#4e5d72;width:100%;text-align:center">BeGifted Education · Progress Tests &nbsp; | &nbsp; <span class="pageNumber"></span> / <span class="totalPages"></span></div>',
      margin: { top: "16mm", right: "17mm", bottom: "16mm", left: "17mm" } }));
  } finally { await browser.close(); }
}
export function docxUnsupportedReasons(xml: string) {
  const checks: [RegExp, string][] = [
    [/<m:(oMath|oMathPara)[\s>]/, "equations"], [/<(?:c:chart|dgm:relIds|w:altChunk|w:object|v:shape|wps:txbx)[\s/>]/, "charts, embedded objects or drawings"],
    [/TargetMode\s*=\s*["']External["']/i, "externally linked content"],
    [/<w:(?:ins|del|moveFrom|moveTo)[\s>]/, "unresolved tracked changes"],
  ];
  return checks.filter(([pattern]) => pattern.test(xml)).map(([, reason]) => reason);
}
export async function convertDocx(bytes: Buffer): Promise<Buffer> {
  const { default: JSZip } = await import("jszip");
  const zip = await JSZip.loadAsync(bytes);
  const xmls = await Promise.all(Object.values(zip.files).filter(f => /^word\//.test(f.name) && /\.(?:xml|rels)$/.test(f.name)).map(f => f.async("string")));
  const unsupported = [...new Set(xmls.flatMap(docxUnsupportedReasons))];
  if (unsupported.length) throw new WorkspaceError(400, `This DOCX contains ${unsupported.join(", ")}. Export it to PDF in Word and check every page before uploading. Nothing has been discarded.`);
  const [jszip, preview] = await Promise.all([
    readFile(path.join(process.cwd(), "node_modules/jszip/dist/jszip.min.js"), "utf8"),
    readFile(path.join(process.cwd(), "node_modules/docx-preview/dist/docx-preview.min.js"), "utf8"),
  ]);
  const browser = await launchDocumentBrowser();
  try {
    const context = await browser.newContext({ serviceWorkers: "block" });
    await context.route("**/*", route => route.abort());
    const page = await context.newPage();
    await page.setContent('<!doctype html><html><head><meta charset="utf-8"><style>body{margin:0}.docx-wrapper{background:white!important;padding:0!important}.docx-wrapper>section.docx{box-shadow:none!important;margin:0!important;break-after:page}.docx-wrapper>section.docx:last-child{break-after:auto}</style></head><body><div id="doc"></div></body></html>');
    await page.addScriptTag({ content: jszip });
    await page.addScriptTag({ content: preview });
    await page.evaluate(async base64 => {
      const data = Uint8Array.from(atob(base64), c => c.charCodeAt(0));
      const api = (window as unknown as { docx: { renderAsync: (data: Uint8Array, container: HTMLElement, styles: HTMLElement, options: Record<string, unknown>) => Promise<void> } }).docx;
      await api.renderAsync(data, document.getElementById("doc")!, document.head, {
        breakPages: true, ignoreLastRenderedPageBreak: false, renderHeaders: true, renderFooters: true,
        renderFootnotes: true, renderEndnotes: true, renderAltChunks: false, useBase64URL: true,
        hideWrapperOnPrint: true,
      });
      await document.fonts.ready;
      await Promise.all(Array.from(document.images).map(i => i.decode()));
    }, bytes.toString("base64"));
    // docx-preview clears its style container while rendering. Install print
    // overrides afterward so its grey wrapper and spacing cannot add pages.
    await page.addStyleTag({ content: "@page{size:A4;margin:0}body{margin:0!important}.docx-wrapper{display:block!important;padding:0!important;background:white!important}.docx-wrapper>section.docx{box-shadow:none!important;margin:0!important;break-after:page}.docx-wrapper>section.docx:last-child{break-after:auto}" });
    const invalid = await page.evaluate(() => !document.querySelector("section.docx") || Array.from(document.querySelectorAll("section.docx")).some(p => p.scrollWidth > p.clientWidth + 2));
    if (invalid) throw new WorkspaceError(400, "This DOCX layout needs correction. Export a visual PDF from Word and upload it.");
    return Buffer.from(await page.pdf({ format: "A4", printBackground: true, preferCSSPageSize: true, tagged: true }));
  } catch (error) {
    if (error instanceof WorkspaceError) throw error;
    throw new WorkspaceError(400, "DOCX conversion could not preserve the whole document. Export a PDF in Word and upload that file.");
  } finally { await browser.close(); }
}
export async function visualPdf(file: StoredFile): Promise<Buffer> {
  const bytes = await readBlobBytes(file);
  if (file.mime === "application/pdf") return bytes;
  if (file.mime.includes("wordprocessingml")) return convertDocx(bytes);
  const pdf = await PDFDocument.create();
  const img = file.mime === "image/png" ? await pdf.embedPng(bytes) : await pdf.embedJpg(bytes);
  const page = pdf.addPage([595.28, 841.89]);
  const scale = Math.min(559 / img.width, 806 / img.height);
  page.drawImage(img, { x: (595.28 - img.width * scale) / 2, y: (841.89 - img.height * scale) / 2, width: img.width * scale, height: img.height * scale });
  return Buffer.from(await pdf.save());
}
export async function appendPdfs(first: Buffer, rest: Buffer[]) {
  const result = await PDFDocument.load(first);
  for (const bytes of rest) {
    const source = await PDFDocument.load(bytes);
    const pages = await result.copyPages(source, source.getPageIndices());
    pages.forEach(page => result.addPage(page));
  }
  if (result.getPageCount() > 150) throw new WorkspaceError(400, "Use at most 150 pages in one generated document.");
  return Buffer.from(await result.save());
}
export async function orderResponsePages(files: { id: string; bytes: Buffer }[], order?: { fileId: string; page: number }[]) {
  const sources = new Map<string, PDFDocument>();
  for (const file of files) sources.set(file.id, await PDFDocument.load(file.bytes));
  const pages = order ?? files.flatMap(f => sources.get(f.id)!.getPageIndices().map(i => ({ fileId: f.id, page: i + 1 })));
  const result = await PDFDocument.create();
  for (const ref of pages) {
    const source = sources.get(ref.fileId);
    if (!source || ref.page < 1 || ref.page > source.getPageCount()) throw new WorkspaceError(400, "A submitted page reference is invalid.");
    const [page] = await result.copyPages(source, [ref.page - 1]);
    result.addPage(page);
  }
  return Buffer.from(await result.save());
}
const para = (text: string) => `<p>${escapeHtml(text).replace(/\n/g, "<br>")}</p>`;
export async function documentHtml(title: string, eyebrow: string, content: string) {
  const { fonts, logo } = await brandAssets();
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><title>${escapeHtml(title)}</title><style>
  ${fonts} @page{size:A4} *{box-sizing:border-box} body{margin:0;color:#16203A;background:#fff;font:11pt/1.55 BGBody,BGThai,Arial,sans-serif}
  header{display:flex;justify-content:space-between;align-items:center;border-bottom:2px solid #FF7518;padding-bottom:5mm;margin-bottom:8mm}header img{width:43mm;height:auto}header span,.label{font:8pt BGLabel,Arial;text-transform:uppercase;letter-spacing:1px;color:#126DCE}
  h1,h2,h3{font-family:BGHead,Arial;line-height:1.2;break-after:avoid}h1{font-size:28pt;margin:0 0 4mm}h2{font-size:16pt;margin-top:8mm}h3{font-size:12pt}p,li{orphans:3;widows:3;overflow-wrap:anywhere}p{white-space:normal}.meta{color:#4e5d72;margin-bottom:8mm}.question{border-top:1px solid #dce3ed;padding-top:5mm;margin-top:5mm}.question h2{font-size:13pt;margin-top:0}.score{float:right;font:10pt BGLabel;color:#126DCE}.response{min-height:20mm;border-bottom:1px dotted #dce3ed;margin-bottom:6mm}.callout{background:#edf5fe;border-left:3px solid #126DCE;padding:4mm 5mm;break-inside:avoid}.mark{break-inside:avoid;border-bottom:1px solid #dce3ed;padding:3mm 0}.muted{color:#4e5d72;font-size:9pt}ul{padding-left:5mm}li{margin-bottom:2mm}.totals{font:22pt BGHead;color:#126DCE;margin:5mm 0}footer{margin-top:8mm;font-size:9pt;color:#4e5d72}
  </style></head><body><header><img src="${logo}" alt="BeGifted Education"><span>${escapeHtml(eyebrow)}</span></header><h1>${escapeHtml(title)}</h1>${content}</body></html>`;
}
export async function renderPaper(paper: Paper, original?: Buffer) {
  const content = `<div class="meta">Name: __________________________ &nbsp; Date: ______________</div>${para(paper.instructions)}<p class="label">Total · ${paper.questions.reduce((n,q) => n+q.maxMarks,0)} marks</p>`
    + paper.questions.map((q,i) => `<section class="question"><h2>${i+1}. <span class="score">${q.maxMarks} marks</span></h2>${para(q.text)}${q.needsVisual ? `<p class="callout">Refer to the original illustration on source page ${q.sourcePage ?? "indicated in the attached paper"}. The complete source paper follows.</p>` : ""}<div class="response"></div></section>`).join("");
  const pdf = await renderHtmlPdf(await documentHtml(paper.title, "Progress Test", content));
  return original ? appendPdfs(pdf, [original]) : pdf;
}
export async function renderReview(paper: Paper, review: Review, student: string, course: string, tutor: string, cycle: number, work: Buffer[], originalPaper?: Buffer) {
  const total = validateMarks(paper, review.marks);
  const meta = `<div class="meta">${escapeHtml(student)} · ${escapeHtml(course)}<br>Tutor: ${escapeHtml(tutor)} · Cycle ${cycle} · ${escapeHtml(paper.title)}</div>`;
  const marks = paper.questions.map((q,i) => {
    const mark = review.marks.find(m => m.questionId === q.id)!;
    return `<section class="mark"><h3>${i+1}. ${escapeHtml(q.topic)} <span class="score">${mark.marks} / ${q.maxMarks}</span></h3>${para(q.text)}${q.needsVisual && originalPaper ? `<p class="muted">Illustration: source paper page ${q.sourcePage ?? "as indicated"}, attached after the response pages.</p>` : ""}${para(mark.explanation)}<p class="muted">Answer reference: ${escapeHtml(mark.answerReference || "See the original response pages attached.")}${mark.needsReview ? " · Tutor review required" : ""}</p></section>`;
  }).join("");
  const graded = await renderHtmlPdf(await documentHtml("Graded progress test", "Assessment", `${meta}<div class="totals">${total.earned} / ${total.possible} <small>(${total.percent}%)</small></div><p class="callout">The student's original responses follow this marking record, in the submitted page order.</p>${marks}`));
  const list = (title: string, values: string[]) => `<h2>${title}</h2><ul>${values.map(v => `<li>${escapeHtml(v)}</li>`).join("")}</ul>`;
  const report = await renderHtmlPdf(await documentHtml("Progress report", "Learning progress", `${meta}<div class="totals">${total.percent}% <span class="muted">${total.earned} of ${total.possible} marks</span></div>${para(review.report.summary)}${list("Strengths", review.report.strengths)}${list("Areas to develop", review.report.focusAreas)}${list("Next steps", review.report.nextSteps)}${review.report.contextLimitations ? `<h2>Context and limitations</h2>${para(review.report.contextLimitations)}` : ""}<footer>Based on this reviewed assessment${review.feedback.length ? ` and ${review.feedback.length} verified class-feedback record(s)` : ""}. Class feedback informs learning recommendations; marks reflect the test answers and approved rubric.</footer>`));
  return { graded: await appendPdfs(graded, [...work, ...(originalPaper ? [originalPaper] : [])]), report };
}
