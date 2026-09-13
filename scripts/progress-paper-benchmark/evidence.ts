/** Export aggregate evidence only. Private papers and model responses stay ignored. */
import { createHash } from "node:crypto";
import { readFile, writeFile } from "node:fs/promises";
import { root } from "./fixtures";

async function main() {
  const read = async (file: string) => JSON.parse(await readFile(file, "utf8"));
  const hashFile = async (file: string) => createHash("sha256").update(await readFile(file)).digest("hex");
  const [pdf, images, codex] = await Promise.all([
    read(`${root}/report/results.json`), read(`${root}/images-1600/report/results.json`),
    read(`${root}/codex-app-images-1600/report/results.json`),
  ]);
  const aggregate = (report: typeof pdf) => Object.fromEntries(
    ["runs", "recordedRequests", "accountRejections", "expectedRuns", "totalCostUsd", "unknownCostRequests", "groups"].map(k => [k, report[k]]),
  );
  const evidence = {
    date: "2026-09-13", generatedAt: new Date().toISOString(),
    status: codex.runs === codex.plannedRuns ? "codex_complete_api_interrupted" : "codex_in_progress_api_interrupted",
    nativePdf: aggregate(pdf), pageImages: aggregate(images),
    codexApp: {
      runs: codex.runs, expectedRuns: codex.plannedRuns, groups: codex.groups,
      cliVersion: codex.manifest.cliVersion, inputMode: codex.manifest.inputMode,
      captureDeadlineMs: codex.manifest.captureDeadlineMs, concurrency: codex.manifest.concurrency,
      billing: "ChatGPT-authenticated Codex allowance; API costs not measured",
      completedResponses: codex.rows.filter((r: { success: boolean }) => r.success).length,
      contentAndPdfPasses: codex.rows.filter((r: { contentPass: boolean }) => r.contentPass).length,
      renderedResponses: codex.rows.filter((r: { renderSuccess: boolean }) => r.renderSuccess).length,
    },
    fingerprints: { pdf: pdf.manifest.fingerprint, images: images.manifest.fingerprint, codexApp: codex.manifest.fingerprint },
    scorerSha256: await hashFile("scripts/progress-paper-benchmark/score.ts"),
    scorerRevision: "visible-subpart-marks-v1",
    groundTruthSha256: await hashFile(`${root}/ground-truth.json`),
    benchmarkRenderer: "begifted-3.1-paper-v2", laterLayoutReplay: "begifted-3.1-paper-v3",
    codexRenderer: "begifted-3.1-paper-v3",
    limitations: ["Only three related source fixtures; not a representative production sample", "API and Codex outcomes must not be pooled", "No API requests after the user declined a top-up", "Final scores include visible subpart marks; interim perfect Sol scores are superseded", "Manual inspection found insufficient working space, which the source-check score does not measure", "PDF construction is not proof of print readiness"],
  };
  await writeFile("docs/operations/progress-paper-model-benchmark-2026-09-13.json", JSON.stringify(evidence, null, 2) + "\n");
  console.log(JSON.stringify({ api: pdf.runs + images.runs, codex: codex.runs, status: evidence.status }));
}
main().catch(error => { console.error(error); process.exitCode = 1; });
