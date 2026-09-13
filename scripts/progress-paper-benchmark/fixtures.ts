import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { createCanvas } from "@napi-rs/canvas";
import { PDFDocument } from "pdf-lib";
import { formattedPaperHtml } from "../../src/lib/progress-tests/workspace/paper-renderer";
import { renderHtmlPdf } from "../../src/lib/progress-tests/workspace/documents";
import type { Paper } from "../../src/lib/progress-tests/workspace/model";

export const root = "output/progress-tests-pdf/benchmark";
export type Fixture = { id: string; source: Buffer; key?: Buffer; pageCount: number };
export const synthetic: Paper = {
  title: "Mathematics Progress Test", instructions: "Answer all six questions. Show all working. Do not use a calculator.", warnings: [],
  questions: [
    { id: "q1", number: "1", text: "Solve 3x + 4 = 19.", topic: "Equations", maxMarks: 3, rubric: "Subtract 4, divide by 3, x = 5. PRIVATE-KEY-4826", sourcePage: 1, needsVisual: false, answerLines: 2, blocks: [{ kind: "text", text: "Solve \\(3x+4=19\\)." }] },
    { id: "q2", number: "2", text: "Calculate the area of this rectangle. Dimensions 8 cm and 3 cm.", topic: "Area", maxMarks: 2, rubric: "Use length times width, 24 square centimetres.", sourcePage: 1, needsVisual: true, answerLines: 1, blocks: [{ kind: "text", text: "Calculate the area of this rectangle." }, { kind: "figure", page: 1, box: [.15, .3, .65, .48], alt: "Rectangle with 8 cm and 3 cm dimensions" }] },
    { id: "q3", number: "3", text: "Use the table to calculate the constant speed in metres per second.", topic: "Rate", maxMarks: 3, rubric: "Distance divided by time, 12 metres per second. Show a consistent pair from the table.", sourcePage: 1, needsVisual: false, answerLines: 1, blocks: [{ kind: "text", text: "Use the table to calculate the constant speed in metres per second." }, { kind: "table", headers: ["Time (s)", "Distance (m)"], rows: [["0", "0"], ["1", "12"], ["2", "24"]] }] },
    { id: "q4", number: "4", text: "จงกระจายและจัดรูป (x+2)(x-5) ให้เป็นรูปอย่างง่าย", topic: "Expansion", maxMarks: 3, rubric: "Expand all four terms; collect like terms to x squared minus 3x minus 10.", sourcePage: 2, needsVisual: false, answerLines: 2, blocks: [{ kind: "text", text: "จงกระจายและจัดรูป \\((x+2)(x-5)\\) ให้เป็นรูปอย่างง่าย" }] },
    { id: "q5", number: "5", text: "Given x=c/3, y=ac/4, z=a^2/(2c+1), find (a) x^2, (b) x+y, (c) xy/z.", topic: "Algebraic fractions", maxMarks: 8, rubric: "(a) c squared / 9 [2]; (b) c(4+3a)/12 [2]; (c) c squared (2c+1)/(12a) [4].", sourcePage: 2, needsVisual: false, answerLines: 3, blocks: [{ kind: "text", text: "Given \\(x=\\frac{c}{3}\\), \\(y=\\frac{ac}{4}\\), \\(z=\\frac{a^2}{2c+1}\\). Find an expression for:" }, { kind: "math", latex: "\\text{(a) }x^2\\qquad\\text{(b) }x+y\\qquad\\text{(c) }\\frac{xy}{z}", display: true }] },
    { id: "q6", number: "6", text: "Simplify fully both expressions, including part (b) continued on the next page.", topic: "Rational expressions", maxMarks: 6, rubric: "(a) (x+1)/2 [3]; (b) 3/(x-7) [3], with original denominator exclusions.", sourcePage: 2, needsVisual: false, answerLines: 2, blocks: [{ kind: "text", text: "Simplify fully. Part (b) continues on the next page." }, { kind: "math", latex: "\\text{(a) }\\frac{x^2-1}{2x-2}", display: true }, { kind: "text", text: "Question 6 continued — (b)" }, { kind: "math", latex: "\\frac{x^2-x}{9}\\times\\frac{3}{x^2-8x+7}", display: true }] },
  ],
};
export async function pdfPages(bytes: Buffer) {
  const { getDocument } = await import("pdfjs-dist/legacy/build/pdf.mjs");
  const assets = path.join(process.cwd(), "node_modules/pdfjs-dist");
  const task = getDocument({ data: new Uint8Array(bytes), useSystemFonts: false, standardFontDataUrl: `${assets}/standard_fonts/`, cMapUrl: `${assets}/cmaps/`, cMapPacked: true, wasmUrl: `${assets}/wasm/` });
  return { task, pdf: await task.promise };
}
async function scan(bytes: Buffer) {
  const { task, pdf } = await pdfPages(bytes); const result = await PDFDocument.create();
  try { for (let i = 1; i <= pdf.numPages; i++) {
    const page = await pdf.getPage(i); const viewport = page.getViewport({ scale: 1.7 }); const canvas = createCanvas(Math.ceil(viewport.width), Math.ceil(viewport.height));
    await page.render({ canvas: canvas as never, canvasContext: canvas.getContext("2d") as never, viewport }).promise;
    const jpg = await result.embedJpg(canvas.toBuffer("image/jpeg", 78)); const target = result.addPage([595.28, 841.89]); target.drawImage(jpg, { x: 0, y: 0, width: 595.28, height: 841.89 });
  } return Buffer.from(await result.save()); } finally { await task.destroy(); }
}
export async function createFixtures(): Promise<Fixture[]> {
  await mkdir(`${root}/fixtures`, { recursive: true });
  let typed: Buffer, key: Buffer, scanned: Buffer;
  try { [typed, key, scanned] = await Promise.all(["typed.pdf", "key.pdf", "scan.pdf"].map(file => readFile(`${root}/fixtures/${file}`))); }
  catch {
    const svg = '<svg xmlns="http://www.w3.org/2000/svg" width="340" height="175"><rect x="50" y="35" width="220" height="100" fill="none" stroke="black" stroke-width="2"/><text x="135" y="22" font-size="20">8 cm</text><text x="278" y="95" font-size="20">3 cm</text></svg>';
    let html = await formattedPaperHtml(synthetic, new Map([["1:0.15,0.3,0.65,0.48", `data:image/svg+xml;base64,${Buffer.from(svg).toString("base64")}`]]));
    html = html.replace('</style>', '.question[data-question="q4"]{break-before:page}.question[data-question="q6"]{break-inside:auto}</style>').replace('<p>Question 6 continued — (b)</p>', '<p style="break-before:page">Question 6 continued — (b)</p>');
    typed = await renderHtmlPdf(html); key = await renderHtmlPdf(await formattedPaperHtml(synthetic, undefined, true)); scanned = await scan(typed);
    await Promise.all([["typed.pdf", typed], ["key.pdf", key], ["scan.pdf", scanned]].map(([file, bytes]) => writeFile(`${root}/fixtures/${file}`, bytes, { mode: 0o600 })));
  }
  const regression = await readFile("output/progress-tests-pdf/source-regression.pdf");
  return Promise.all([{ id: "typed-key", source: typed, key }, { id: "scan-draft", source: scanned }, { id: "regression-17", source: regression }].map(async f => ({ ...f, pageCount: (await PDFDocument.load(f.source)).getPageCount() })));
}
