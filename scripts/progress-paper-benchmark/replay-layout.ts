/** Rebuild selected saved responses with the current renderer. Never calls AI. */
import { readFile, writeFile, mkdir } from "node:fs/promises";
import { PDFDocument } from "pdf-lib";
import { renderFormattedPaper, renderMarkingScheme, PAPER_RENDERER_VERSION } from "../../src/lib/progress-tests/workspace/paper-renderer";
import { normalizeFormattedPaper, paperCoverageWarnings } from "../../src/lib/progress-tests/workspace/model";

async function main() {
  const out = `output/progress-tests-pdf/${PAPER_RENDERER_VERSION}`;
  await mkdir(out, { recursive: true });
  const source = await readFile("output/progress-tests-pdf/source-regression.pdf");
  const results = [];
  for (const id of ["gpt-5.6-sol-none", "gpt-5.6-sol-low", "gpt-6-astra-low"]) {
    const run = JSON.parse(await readFile(`output/progress-tests-pdf/benchmark/runs/${id}--regression-17--1.json`, "utf8"));
    const paper = normalizeFormattedPaper(run.paper, 17, false);
    paper.warnings = [...new Set([...paper.warnings, ...paper.questions.filter(q => !q.maxMarks).map(q => `Question ${q.number}: marks not supplied.`), ...paperCoverageWarnings(paper, 17)])];
    const bytes = await renderFormattedPaper(paper, source), key = await renderMarkingScheme(paper);
    await writeFile(`${out}/${id}-paper.pdf`, bytes, { mode: 0o600 });
    await writeFile(`${out}/${id}-key.pdf`, key, { mode: 0o600 });
    results.push({ id, renderer: PAPER_RENDERER_VERSION, paperPages: (await PDFDocument.load(bytes)).getPageCount(), keyPages: (await PDFDocument.load(key)).getPageCount(), paidRequests: 0 });
  }
  await writeFile(`${out}/results.json`, JSON.stringify(results, null, 2));
  console.log(JSON.stringify(results));
}
main().catch(error => { console.error(error); process.exitCode = 1; });
