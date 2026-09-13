import katex from "katex";
import { readFileSync } from "node:fs";
import path from "node:path";
import { paperCoverageWarnings, type Paper } from "../../src/lib/progress-tests/workspace/model";

export type Check = { name: string; pass: boolean; category: "coverage" | "marks" | "math" | "content" | "figures" | "privacy" };
const normalizeWords = (s: string) => s.normalize("NFKC").toLowerCase().replace(/[^\p{L}\p{N}]/gu, "");
export function canonicalMath(s: string) {
  try {
    // Sentence punctuation can sit inside math delimiters without changing an equation.
    // Preserve invisible delimiters such as \\right. and all internal decimal points.
    const expression = s.trim().replace(/(?<!\\right|\\left)[.,;]$/, "");
    return katex.renderToString(expression.replace(/\\(?:dfrac|tfrac)/g, "\\frac"), { output: "mathml", throwOnError: true, trust: false })
      .replace(/<annotation[\s\S]*?<\/annotation>/g, "").replace(/<\/?(?:span|math|semantics|mrow|mstyle)(?:\s[^>]*)?>/g, "")
      .replace(/<mspace[^>]*\/>/g, "").replace(/<mspace[^>]*><\/mspace>/g, "").replace(/\s+/g, "");
  } catch { return "INVALID"; }
}
function maths(q: Paper["questions"][number]) {
  // Score what the student PDF actually renders; correct hidden grading text cannot mask a bad block.
  const values = q.blocks?.length ? q.blocks.flatMap(b => b.kind === "text" ? [b.text] : b.kind === "math" ? [`\\(${b.latex}\\)`] : []) : [q.text];
  return values.flatMap(s => Array.from(s.matchAll(/\\\(([\s\S]*?)\\\)|\\\[([\s\S]*?)\\\]|\$\$([\s\S]*?)\$\$|\$([^$\n]+)\$/g), m => canonicalMath(m[1] ?? m[2] ?? m[3] ?? m[4]))).join("|");
}
export function hasRenderedPartMarks(q: Paper["questions"][number] | undefined, part: string, marks: number) {
  if (!q) return false;
  // Rubric/context text is private and cannot stand in for marks on the student's paper.
  const rendered = q.blocks?.length ? q.blocks.map(b => b.kind === "text" ? b.text : b.kind === "math" ? b.latex : "").join("\n") : q.text;
  const section = rendered.split(new RegExp(`\\(${part}\\)`, "i"))[1]?.split(/\([a-z]\)/i)[0];
  return !!section && new RegExp(`(?:[\\(\\[]\\s*${marks}\\s*(?:marks?)?\\s*[\\)\\]]|\\b${marks}\\s+marks?\\b)`, "i").test(section);
}
export function scorePaper(paper: Paper, fixture: string, pageCount: number) {
  const checks: Check[] = []; const check = (category: Check["category"], name: string, pass: boolean) => checks.push({ category, name, pass });
  check("coverage", "Every source page and question is accounted for", paperCoverageWarnings(paper, pageCount).length === 0);
  check("coverage", "Unique question IDs", new Set(paper.questions.map(q => q.id)).size === paper.questions.length);
  const forNumber = (number: number) => paper.questions.find(q => !q.sourcePages?.includes(16) && (q.number ?? "").replace(/^(?:question|q)\s*/i, "").replace(/[.\s:]+$/, "") === String(number));
  const hasMath = (q: Paper["questions"][number] | undefined, latex: string) => !!q && maths(q).includes(canonicalMath(latex));
  if (fixture !== "regression-17") {
    check("coverage", "All six questions, no generated questions", paper.questions.length === 6);
    for (let n = 1; n <= 6; n++) { const q = forNumber(n); check("coverage", `Question ${n} exists`, !!q); check("marks", `Question ${n} mark allocation`, q?.maxMarks === [3,2,3,3,8,6][n-1]); }
    check("math", "Q1 equation", hasMath(forNumber(1), "3x+4=19"));
    check("figures", "Q2 original rectangle", !!forNumber(2)?.blocks?.some(b => b.kind === "figure" && b.page === 1));
    const table = forNumber(3)?.blocks?.find(b => b.kind === "table");
    check("content", "Q3 complete numeric table", table?.kind === "table" && JSON.stringify(table.rows) === JSON.stringify([["0","0"],["1","12"],["2","24"]]));
    check("content", "Q4 Thai wording retained", !!forNumber(4) && normalizeWords(forNumber(4)!.text).includes(normalizeWords("จงกระจายและจัดรูป")));
    check("math", "Q4 original factors", hasMath(forNumber(4), "(x+2)(x-5)"));
    for (const latex of ["x=\\frac{c}{3}", "y=\\frac{ac}{4}", "z=\\frac{a^2}{2c+1}", "x^2", "x+y", "\\frac{xy}{z}"]) check("math", `Q5 ${latex}`, hasMath(forNumber(5), latex));
    check("math", "Q6 part a", hasMath(forNumber(6), "\\frac{x^2-1}{2x-2}"));
    check("math", "Q6 continuation part b", hasMath(forNumber(6), "\\frac{x^2-x}{9}\\times\\frac{3}{x^2-8x+7}"));
    check("coverage", "Q6 spans source pages", (forNumber(6)?.sourcePages?.length ?? 0) >= 2);
    check("privacy", "Uploaded key never appears on blank paper", !JSON.stringify(paper.questions.map(q => q.blocks)).includes("PRIVATE-KEY-4826"));
  } else {
    const { mainMath, marks, extraMath, workedSteps } = JSON.parse(readFileSync(path.join(process.cwd(), "output/progress-tests-pdf/benchmark/ground-truth.json"), "utf8")) as { mainMath: (string | null)[]; marks: number[]; extraMath: string[]; workedSteps: string[] };
    for (let n = 1; n <= 32; n++) {
      const q = forNumber(n); check("coverage", `Main question ${n} exists`, !!q); check("marks", `Main question ${n} marks`, q?.maxMarks === marks[n-1]);
      if (mainMath[n-1]) check("math", `Main question ${n} mathematics`, hasMath(q, mainMath[n-1]!));
    }
    for (const latex of ["x=\\frac{c}{3}", "y=\\frac{ac}{4}", "z=\\frac{a^2}{2c+1}", "x^2", "x+y", "\\frac{xy}{z}"]) check("math", `Q24 ${latex}`, hasMath(forNumber(24), latex));
    for (const [part, marks] of [["a", 2], ["b", 2], ["c", 4]] as const) check("marks", `Q24 part ${part} marks visible on paper`, hasRenderedPartMarks(forNumber(24), part, marks));
    const extra = paper.questions.filter(q => q.sourcePages?.includes(16)); const all = extra.map(maths).join("|");
    for (let i = 0; i < extraMath.length; i++) check("math", `Extra worksheet equation ${i+1}`, all.includes(canonicalMath(extraMath[i])));
    check("coverage", "Additional worksheet questions included", extra.length >= 3);
    check("marks", "Unmarked worksheet has no invented marks", extra.length > 0 && extra.every(q => !q.maxMarks));
    check("figures", "Q23 original labelled rectangle", !!forNumber(23)?.blocks?.some(b => b.kind === "figure" && b.page === 9));
    // This is printed worked algebra. Faithful transcription is as valid as an intact source crop.
    check("content", "Complete worked mistake example preserved", extra.some(q => q.blocks?.some(b => b.kind === "figure" && b.page === 16)) || workedSteps.every(latex => all.includes(canonicalMath(latex))));
    check("privacy", "Answer page classified private and excluded from blank paper", paper.coverage?.find(p => p.page === 17)?.purpose === "answer_key" && !paper.questions.some(q => q.sourcePages?.includes(17)));
  }
  return { checks, score: Math.round(checks.filter(c => c.pass).length / checks.length * 1000) / 10, passed: checks.filter(c => c.pass).length, total: checks.length, failures: checks.filter(c => !c.pass) };
}
