import { PDFDocument, StandardFonts, rgb, type PDFFont, type PDFPage } from "pdf-lib";
import type { PaperMarks, PaperQuestion } from "./marking-sheet";

export type MarkedPaperInput = {
  scan: Uint8Array;
  candidate: string;
  subject: string;
  marks: PaperMarks;
  /** The AI's first answer, to show where a person changed a mark. */
  aiMarks: PaperMarks | null;
  markSchemeUsed: boolean | null;
};

const INK = rgb(0.1, 0.1, 0.12);
const MUTED = rgb(0.38, 0.38, 0.42);
const GOOD = rgb(0.05, 0.45, 0.2);
const BAD = rgb(0.7, 0.12, 0.1);
const A4: [number, number] = [595, 842];

// The standard PDF fonts hold Latin text only, and a character outside them stops the whole file.
// shortcut: other scripts print as "?", embed a Unicode font if marker comments are ever written in Thai.
const clean = (text: string) =>
  text
    .replace(/[‘’]/g, "'")
    .replace(/[“”]/g, '"')
    .replace(/[–—]/g, "-")
    .replace(/\s+/g, " ")
    .replace(/[^\x20-\x7E\xA1-\xFF]/g, "?")
    .trim();

function wrap(text: string, font: PDFFont, size: number, width: number) {
  const lines: string[] = [];
  let line = "";
  for (const word of clean(text).split(" ")) {
    // A word wider than the column is cut, so it cannot run off the page.
    let rest = word;
    while (font.widthOfTextAtSize(rest, size) > width) {
      let cut = rest.length - 1;
      while (cut > 1 && font.widthOfTextAtSize(rest.slice(0, cut), size) > width) cut--;
      if (line) lines.push(line);
      lines.push(rest.slice(0, cut));
      line = "";
      rest = rest.slice(cut);
    }
    const next = line ? `${line} ${rest}` : rest;
    if (font.widthOfTextAtSize(next, size) > width) {
      lines.push(line);
      line = rest;
    } else line = next;
  }
  if (line) lines.push(line);
  return lines;
}

const score = (q: PaperQuestion) => (!q.attempted ? `Not tried, 0 / ${q.max}` : q.marks === null ? `Unreadable, ? / ${q.max}` : `${q.marks} / ${q.max}`);

/**
 * The scan with the marking beside it: each page gets a strip on its right with that page's questions, the marks,
 * what each mark was given for, and the marker's comment. Nothing is drawn on the candidate's writing, because the AI
 * knows the page of an answer and not its exact place. A summary page comes first.
 */
export async function buildMarkedPaper(input: MarkedPaperInput) {
  const source = await PDFDocument.load(input.scan, { ignoreEncryption: true });
  const doc = await PDFDocument.create();
  const regular = await doc.embedFont(StandardFonts.Helvetica);
  const bold = await doc.embedFont(StandardFonts.HelveticaBold);
  const count = source.getPageCount();
  const first = new Map(input.aiMarks?.questions.map((q) => [q.id, q.marks]));
  const onPage = (n: number) => input.marks.questions.filter((q) => q.page === n);
  const unplaced = input.marks.questions.filter((q) => !q.page || !Number.isInteger(q.page) || q.page < 1 || q.page > count);

  // One column of text. When it is full, `more` gives the next column on a new page.
  type Column = { page: PDFPage; x: number; y: number; bottom: number; width: number; unit: number; more: () => Column };
  const writer = (start: Column) => {
    let col = start;
    const line = (text: string, font: PDFFont, size: number, color = INK, indent = 0) => {
      for (const part of wrap(text, font, size * col.unit, col.width - indent * col.unit)) {
        if (col.y - size * col.unit * 1.3 < col.bottom) col = col.more();
        col.y -= size * col.unit * 1.3;
        col.page.drawText(part, { x: col.x + indent * col.unit, y: col.y, size: size * col.unit, font, color });
      }
    };
    const gap = (points: number) => void (col.y -= points * col.unit);
    // One line with its second part at the right edge, as on a marked paper.
    const pair = (left: string, right: string, font: PDFFont, size: number) => {
      if (col.y - size * col.unit * 1.3 < col.bottom) col = col.more();
      col.y -= size * col.unit * 1.3;
      const end = clean(right);
      col.page.drawText(clean(left), { x: col.x, y: col.y, size: size * col.unit, font, color: INK });
      col.page.drawText(end, { x: col.x + col.width - font.widthOfTextAtSize(end, size * col.unit), y: col.y, size: size * col.unit, font, color: INK });
    };
    const question = (q: PaperQuestion) => {
      pair(q.id, score(q), bold, 13);
      for (const point of q.points ?? []) line(`[${point.awarded > 0 ? "+" : " "}${point.awarded}] ${point.point}`, regular, 10.5, point.awarded > 0 ? GOOD : BAD, 4);
      if (q.attempted && q.reason) line(q.reason, regular, 10, MUTED, 4);
      if (first.has(q.id) && first.get(q.id) !== q.marks) line(`Changed by a person. The AI gave ${first.get(q.id) ?? "no mark"}.`, regular, 10, BAD, 4);
      gap(10);
    };
    return { line, gap, pair, question };
  };
  const notesPage = (size: [number, number], unit: number, title: string): Column => {
    const page = doc.addPage(size);
    const margin = 40 * unit;
    const col: Column = { page, x: margin, y: size[1] - margin, bottom: margin, width: size[0] - margin * 2, unit, more: () => notesPage(size, unit, title) };
    writer(col).line(title, bold, 11);
    col.y -= 6 * unit;
    return col;
  };

  const total = input.marks.questions.reduce((sum, q) => sum + (q.marks ?? 0), 0);
  const max = input.marks.questions.reduce((sum, q) => sum + q.max, 0);
  const summary = writer(notesPage(A4, 1, `Marked paper: ${input.subject}`));
  summary.line(input.candidate, bold, 14);
  summary.line(`Paper score: ${total} / ${max}`, bold, 12);
  summary.line(input.markSchemeUsed ? "Marked by the AI with the mark scheme." : "Marked by the AI without a mark scheme, from its own subject knowledge.", regular, 9, input.markSchemeUsed ? MUTED : BAD);
  if (input.marks.missingPages) summary.line(`Missing pages: ${input.marks.missingPages}`, regular, 9, BAD);
  summary.gap(6);
  summary.line(input.marks.comment, regular, 10);
  summary.gap(10);
  summary.pair("Question", "Marks, and the scan page of the answer", bold, 9);
  for (const q of input.marks.questions) summary.pair(q.id, `${score(q)}, ${unplaced.includes(q) ? "page not known" : `page ${q.page}`}`, regular, 9);
  if (unplaced.length) {
    summary.gap(10);
    summary.line("Marking for answers with no known page", bold, 10);
    summary.gap(4);
    unplaced.forEach(summary.question);
  }

  const pages = await doc.copyPages(source, source.getPageIndices());
  pages.forEach((page, index) => {
    doc.addPage(page);
    const questions = onPage(index + 1);
    if (!questions.length) return;
    const box = page.getMediaBox();
    const unit = Math.min(box.width, box.height) / A4[0];
    const title = `Marking for scan page ${index + 1}`;
    const size: [number, number] = [box.width, box.height];
    // A turned page has turned axes, so its marking goes on the next page.
    if (page.getRotation().angle % 360 !== 0) return void questions.forEach(writer(notesPage(size, unit, title)).question);
    const strip = box.width * 0.45;
    page.setMediaBox(box.x, box.y, box.width + strip, box.height);
    page.setCropBox(box.x, box.y, box.width + strip, box.height);
    const left = box.x + box.width;
    page.drawRectangle({ x: left, y: box.y, width: strip, height: box.height, color: rgb(1, 1, 1) });
    page.drawLine({ start: { x: left, y: box.y }, end: { x: left, y: box.y + box.height }, thickness: unit, color: MUTED });
    const pad = 10 * unit;
    const column = writer({ page, x: left + pad, y: box.y + box.height - pad, bottom: box.y + pad, width: strip - pad * 2, unit, more: () => notesPage(size, unit, `${title}, continued`) });
    column.line("MARKING", bold, 8, MUTED);
    column.gap(4);
    questions.forEach(column.question);
  });
  return doc.save();
}
