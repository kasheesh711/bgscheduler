/** Separate paid experiment: identical formatting task, explicit high-detail PDF versus page images. */
import { readFile, writeFile, mkdir } from "node:fs/promises";
import { createHash } from "node:crypto";
import { parse } from "dotenv";
import { z } from "zod";
import { FORMAT_INSTRUCTIONS, FORMAT_PROMPT_VERSION } from "../../src/lib/progress-tests/workspace/ai";
import { formattedPaperSchema, normalizeFormattedPaper } from "../../src/lib/progress-tests/workspace/model";
import { renderFormattedPaper, renderMarkingScheme } from "../../src/lib/progress-tests/workspace/paper-renderer";
import { scorePaper } from "./score";

async function main() {
  if (!process.argv.includes("--run")) throw new Error("Pass --run for paid requests.");
  const env = parse(await readFile(".env.local"));
  const bytes = await readFile("output/progress-tests-pdf/source-regression.pdf");
  const dir = "output/progress-tests-pdf/input-ablation";
  await mkdir(dir, { recursive: true });
  const pageImages = await Promise.all(Array.from({ length: 17 }, (_, i) => readFile(`output/progress-tests-pdf/inspection/source-regression/${i+1}.png`)));
  const schema = z.toJSONSchema(formattedPaperSchema, { target: "draft-7" });
  const manifest = { promptVersion: FORMAT_PROMPT_VERSION, instructions: FORMAT_INSTRUCTIONS, schema, sourceSha256: createHash("sha256").update(bytes).digest("hex"), imageSha256: pageImages.map(b => createHash("sha256").update(b).digest("hex")), effort: "medium", replicas: 1, captureDeadlineMs: 300000 };
  await writeFile(`${dir}/manifest.json`, JSON.stringify(manifest, null, 2), { mode: 0o600 });
  const rates: Record<string, [number, number, number]> = { "gpt-5.6-luna": [.2,.02,1.2], "gpt-5.6-terra": [2,.2,12], "gpt-5.6-sol": [4,.4,20], "gpt-6-astra": [10,1,50] };
  const jobs = Object.keys(rates).flatMap(model => ["pdf-high", "page-images"].map(mode => ({ model, mode })));
  let index = 0;
  await Promise.all(Array.from({ length: 2 }, async () => { for (;;) {
    const job = jobs[index++]; if (!job) break;
    const id = `${job.model}-${job.mode}`;
    try { await readFile(`${dir}/${id}.json`); continue; } catch {}
    const started = Date.now();
    let row: Record<string, unknown> = { ...job, effort: "medium", startedAt: new Date(started).toISOString() };
    try {
      const visual = job.mode === "pdf-high"
        ? [{ type: "input_file", detail: "high", filename: "paper.pdf", file_data: `data:application/pdf;base64,${bytes.toString("base64")}` }]
        : pageImages.flatMap((image, i) => [{ type: "input_text", text: `FIRST PDF, source page ${i+1} of 17.` }, { type: "input_image", detail: "high", image_url: `data:image/png;base64,${image.toString("base64")}` }]);
      const response = await fetch("https://api.openai.com/v1/responses", { method: "POST", signal: AbortSignal.timeout(300000), headers: { Authorization: `Bearer ${env.OPENAI_PROGRESS_TEST_API_KEY || env.OPENAI_API_KEY}`, "Content-Type": "application/json" }, body: JSON.stringify({ model: job.model, reasoning: { effort: "medium" }, service_tier: "default", store: false, instructions: FORMAT_INSTRUCTIONS, max_output_tokens: 32000, input: [{ role: "user", content: [{ type: "input_text", text: JSON.stringify({ documents: ["paper.pdf"], sourcePageCount: 17, keyIncluded: false }) }, ...visual] }], text: { format: { type: "json_schema", name: "begifted_assessment", strict: true, schema } } }) });
      const body = await response.json(); const latencyMs = Date.now() - started;
      const usage = body.usage; const [input, cached, output] = rates[job.model];
      const read = usage?.input_tokens_details?.cached_tokens ?? 0, write = usage?.input_tokens_details?.cache_write_tokens ?? 0;
      const costUsd = usage ? ((usage.input_tokens-read-write)*input+read*cached+write*input*1.25+usage.output_tokens*output)/1e6 : null;
      const text = body.output?.flatMap((o: {content?: {type:string;text?:string}[]}) => o.content ?? []).filter((c: {type:string}) => c.type === "output_text").map((c: {text?:string}) => c.text ?? "").join("") ?? "";
      row = { ...row, status: response.status, responseId: body.id, latencyMs, usage, costUsd, error: body.error, responseStatus: body.status, productionTimeout: latencyMs > 110000 };
      const raw = formattedPaperSchema.parse(JSON.parse(text));
      const paper = normalizeFormattedPaper(raw, 17, false);
      row = { ...row, apiSuccess: response.ok && body.status === "completed", paper: raw, quality: scorePaper(paper, "regression-17", 17) };
      // Persist billed evidence before optional rendering, so a render crash never loses API costs.
      await writeFile(`${dir}/${id}.json`, JSON.stringify(row, null, 2), { mode: 0o600 });
      const renderStarted = Date.now();
      try {
        const pdf = await renderFormattedPaper(paper, bytes), key = await renderMarkingScheme(paper);
        await writeFile(`${dir}/${id}.pdf`, pdf, { mode: 0o600 });
        await writeFile(`${dir}/${id}-key.pdf`, key, { mode: 0o600 });
        row = { ...row, renderSuccess: true, renderMs: Date.now()-renderStarted };
      } catch (error) { row = { ...row, renderSuccess: false, renderError: error instanceof Error ? error.message : String(error) }; }
    } catch (error) { row = { ...row, error: error instanceof Error ? error.message : String(error) }; }
    await writeFile(`${dir}/${id}.json`, JSON.stringify(row, null, 2), { mode: 0o600 });
    console.log(JSON.stringify({ id, seconds: Number(row.latencyMs)/1000, costUsd: row.costUsd, apiSuccess: row.apiSuccess, renderSuccess: row.renderSuccess, quality: row.quality, error: row.error, renderError: row.renderError }));
  } }));
}
main().catch(error => { console.error(error); process.exitCode=1; });
