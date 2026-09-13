/** Offline document verification: source annotations and saved responses, with no AI requests. */
import assert from "node:assert/strict";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { PDFDocument, StandardFonts, rgb } from "pdf-lib";
import { convertDocx } from "../src/lib/progress-tests/workspace/documents";
import { renderFormattedPaper, renderMarkingScheme, formattedPaperHtml } from "../src/lib/progress-tests/workspace/paper-renderer";
import { paperCoverageWarnings, type Paper } from "../src/lib/progress-tests/workspace/model";

async function main() {
  const out = "output/progress-tests-pdf/original-release";
  await mkdir(out, { recursive: true });
  const pdf = await PDFDocument.create(), font = await pdf.embedFont(StandardFonts.Helvetica);
  const page = pdf.addPage([595.28, 841.89]);
  page.drawText("SYNTHETIC VALIDATION - not a student assessment", { x: 40, y: 801, size: 13, font });
  page.drawText("1 (a) Calculate the area of this rectangle. [2 marks]", { x: 40, y: 752, size: 12, font });
  page.drawRectangle({ x: 130, y: 625, width: 220, height: 80, borderColor: rgb(0, 0, 0), borderWidth: 1.5 });
  page.drawText("8 cm", { x: 220, y: 715, size: 12, font });
  page.drawText("3 cm", { x: 360, y: 660, size: 12, font });
  page.drawText("Question 1 continues on the next page.", { x: 40, y: 55, size: 11, font });
  const continued = pdf.addPage([595.28, 841.89]);
  continued.drawText("1 (b) Simplify (x^2 - 1) / (2x - 2). [3 marks]", { x: 40, y: 775, size: 12, font });
  for (let i = 0; i < 12; i++) continued.drawLine({ start: { x: 40, y: 630 - i * 32 }, end: { x: 550, y: 630 - i * 32 }, thickness: .3, color: rgb(.7, .7, .7) });
  const blank = pdf.addPage([595.28, 841.89]);
  blank.drawText("Additional working space", { x: 40, y: 790, size: 11, font });
  const source = Buffer.from(await pdf.save());
  const paper: Paper = { title: "Synthetic source-region validation", instructions: "Answer both parts of question 1. Show all working.", warnings: [], gradingWarnings: [], coverage: [{ page: 1, purpose: "questions", questionIds: ["q1"] }, { page: 2, purpose: "questions", questionIds: ["q1"] }, { page: 3, purpose: "blank", questionIds: [] }], questions: [{ id: "q1", number: "1", text: "Calculate a rectangle area and simplify an algebraic fraction.", topic: "Area and algebra", maxMarks: 5, rubric: "(a) 8 times 3 = 24 square centimetres [2]. (b) Factor and cancel to (x+1)/2, x not equal to 1 [3].", sourcePage: 1, sourcePages: [1, 2], needsVisual: true, answerLines: 0, blocks: [
    { kind: "text", text: "(a) Calculate the area of this rectangle." },
    { kind: "figure", page: 1, box: [.18, .13, .72, .27], alt: "Original rectangle labelled 8 cm and 3 cm" },
    { kind: "part-marks", label: "(a)", marks: 2 },
    { kind: "working-area", page: 1, box: [.067, .32, .925, .88], lines: 0 },
    { kind: "text", text: "Question 1 continued — (b) Simplify fully." },
    { kind: "math", latex: "\\frac{x^2-1}{2x-2}", display: true },
    { kind: "part-marks", label: "(b)", marks: 3 },
    { kind: "working-area", page: 2, box: [.067, .25, .925, .71], lines: 12 },
  ] }] };
  assert.deepEqual(paperCoverageWarnings(paper, 3), []);
  const rendered = await renderFormattedPaper(paper, source), key = await renderMarkingScheme(paper);
  const html = await formattedPaperHtml(paper, new Map([["1:0.18,0.13,0.72,0.27", "data:image/png;base64,fixture"]]), false, new Map([[1, 841.89], [2, 841.89], [3, 841.89]]));
  assert(html.includes("height:166.320mm")); assert(html.includes("height:136.620mm"));
  assert(html.includes("(a) · 2 marks")); assert(html.includes("(b) · 3 marks"));
  assert(html.includes('aria-label="Blank working page"'));
  await writeFile(`${out}/annotated-source.pdf`, source, { mode: 0o600 });
  await writeFile(`${out}/annotated-paper.pdf`, rendered, { mode: 0o600 });
  await writeFile(`${out}/annotated-key.pdf`, key, { mode: 0o600 });
  await writeFile(`${out}/source-annotations.json`, JSON.stringify(paper, null, 2), { mode: 0o600 });
  const docx = await convertDocx(await readFile("output/progress-tests-pdf/docx-source.docx"));
  await writeFile(`${out}/original-docx.pdf`, docx, { mode: 0o600 });
  await assert.rejects(() => readFile("output/progress-tests-pdf/unsupported-equation.docx").then(convertDocx), /Export it to PDF in Word/);
  const evidence = { paidRequests: 0, annotatedSourcePages: 3, paperPages: (await PDFDocument.load(rendered)).getPageCount(), keyPages: (await PDFDocument.load(key)).getPageCount(), measuredWorkingAreasMm: [166.32, 136.62], sourceDiagram: "cropped from original PDF", continuation: "both parts present", blankWorkingPages: 1, visualDocxPages: (await PDFDocument.load(docx)).getPageCount(), unsupportedDocx: "actionable export-to-PDF error" };
  await writeFile(`${out}/document-checks.json`, JSON.stringify(evidence, null, 2));
  console.log(JSON.stringify(evidence));
}
main().catch(error => { console.error(error); process.exitCode = 1; });
