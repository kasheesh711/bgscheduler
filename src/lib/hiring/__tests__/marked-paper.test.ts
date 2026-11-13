import { PDFDocument, degrees } from "pdf-lib";
import { getDocument } from "pdfjs-dist/legacy/build/pdf.mjs";
import { describe, expect, it } from "vitest";
import { buildMarkedPaper } from "../marked-paper";
import type { PaperMarks, PaperQuestion } from "../marking-sheet";

const q = (id: string, marks: number | null, patch: Partial<PaperQuestion> = {}): PaperQuestion => ({ id, level: "Other", marks, max: 4, reason: "Clear working.", attempted: true, readable: marks !== null, page: 1, points: [{ point: "Correct formula", awarded: 1 }, { point: "Uses the elasticity figure", awarded: 0 }], ...patch });
async function scan(pages: number, turned = false) {
  const doc = await PDFDocument.create();
  for (let i = 0; i < pages; i++) doc.addPage([595, 842]).setRotation(degrees(turned ? 90 : 0));
  return doc.save();
}
async function read(bytes: Uint8Array) {
  const pdf = await getDocument({ data: bytes.slice() }).promise;
  const pages: { width: number; text: string }[] = [];
  for (let n = 1; n <= pdf.numPages; n++) {
    const page = await pdf.getPage(n);
    const content = await page.getTextContent();
    pages.push({ width: Math.round(page.view[2] - page.view[0]), text: content.items.map((item) => ("str" in item ? item.str : "")).join(" ") });
  }
  return pages;
}
const input = (marks: PaperMarks, bytes: Uint8Array, aiMarks: PaperMarks | null = null) => ({ scan: bytes, candidate: "Sample Person", subject: "Business Studies", marks, aiMarks, markSchemeUsed: true });

describe("buildMarkedPaper", () => {
  it("puts a summary first, and each page's marking in a strip beside that page only", async () => {
    const marks: PaperMarks = { questions: [q("1a", 1), q("2b", 3, { page: 2, points: [{ point: "Level 2 analysis", awarded: 3 }] })], comment: "Solid.", missingPages: null };
    const pages = await read(await buildMarkedPaper(input(marks, await scan(3))));
    expect(pages).toHaveLength(4);
    expect(pages[0].text).toMatch(/Sample Person.*Paper score: 4 \/ 8.*with the mark scheme.*Solid\./);
    expect(pages[1].width).toBeGreaterThan(595);
    expect(pages[1].text).toMatch(/1a\s+1 \/ 4.*\[\+1\] Correct formula.*\[ 0\] Uses the elasticity figure.*Clear working\./);
    expect(pages[1].text).not.toContain("2b");
    expect(pages[2].text).toContain("[+3] Level 2 analysis");
    // A page with no question keeps its size.
    expect(pages[3]).toEqual({ width: 595, text: "" });
  });
  it("keeps an answer with no known page on the summary, and says where a person changed a mark", async () => {
    const marks: PaperMarks = { questions: [q("1", 2, { page: null }), q("2", null, { page: 9, points: [] }), q("3", 0, { attempted: false, page: undefined, points: undefined })], comment: "", missingPages: "Page 4" };
    const ai: PaperMarks = { ...marks, questions: [q("1", 4), q("2", null), q("3", 0)] };
    const pages = await read(await buildMarkedPaper(input(marks, await scan(1), ai)));
    expect(pages).toHaveLength(2);
    expect(pages[0].text).toMatch(/Missing pages: Page 4.*page not known.*Changed by a person\. The AI gave 4\./);
    expect(pages[0].text).toContain("Unreadable");
    expect(pages[0].text).toContain("Not tried");
  });
  it("puts the marking of a turned page on the next page, runs a long strip on to a new page, and survives text outside Latin", async () => {
    const long = Array.from({ length: 40 }, (_, i) => ({ point: `Point ${i} ถูกต้อง ${"long ".repeat(12)}`, awarded: i % 2 }));
    const turned = await read(await buildMarkedPaper(input({ questions: [q("1", 1)], comment: "", missingPages: null }, await scan(1, true))));
    expect(turned).toHaveLength(3);
    expect(turned[2].text).toMatch(/Marking for scan page 1.*Correct formula/);
    const pages = await read(await buildMarkedPaper(input({ questions: [q("1", 1, { points: long })], comment: "“Smart” – quotes", missingPages: null }, await scan(1))));
    expect(pages.length).toBeGreaterThan(2);
    expect(pages.at(-1)!.text).toMatch(/continued.*Point 39/);
    expect(pages[0].text).toContain('"Smart" - quotes');
  });
});
