/** Paid, explicit operator benchmark. No application DB, Blob or Wise writes. Resumes local evidence. */
import { readFile, writeFile, mkdir, readdir } from "node:fs/promises";
import { createHash } from "node:crypto";
import { parse } from "dotenv";
import { z } from "zod";
import { createCanvas } from "@napi-rs/canvas";
import { FORMAT_INSTRUCTIONS, FORMAT_PROMPT_VERSION } from "../../src/lib/progress-tests/workspace/ai";
import { formattedPaperSchema } from "../../src/lib/progress-tests/workspace/model";
import { root as baseRoot, createFixtures, pdfPages } from "./fixtures";

const rates = {
  "gpt-5.6-luna": { input: .2, cached: .02, output: 1.2 },
  "gpt-5.6-terra": { input: 2, cached: .2, output: 12 },
  "gpt-5.6-sol": { input: 4, cached: .4, output: 20 },
  "gpt-6-astra": { input: 10, cached: 1, output: 50 },
};
const efforts = ["none", "low", "medium", "high", "xhigh", "max"];
const sha = (data: string | Buffer) => createHash("sha256").update(data).digest("hex");
async function main() {
  if (!process.argv.includes("--run") && !process.argv.includes("--prepare-only")) throw new Error("Pass --run to authorize paid model requests. Output remains private/local.");
  const env = parse(await readFile(".env.local")); const key = env.OPENAI_PROGRESS_TEST_API_KEY || env.OPENAI_API_KEY;
  if (!key) throw new Error("Missing configured OpenAI key");
  const images = process.argv.includes("--images");
  const root = images ? `${baseRoot}/images-1600` : baseRoot;
  const fixtures = await createFixtures(); const schema = z.toJSONSchema(formattedPaperSchema, { target: "draft-7" });
  const imageInputs = new Map<string, Record<string, unknown>[]>();
  if (images) for (const fixture of fixtures) {
    const content: Record<string, unknown>[] = [];
    const sources = [fixture.source, ...(fixture.key ? [fixture.key] : [])];
    for (let sourceIndex = 0; sourceIndex < sources.length; sourceIndex++) {
      const { pdf, task } = await pdfPages(sources[sourceIndex]);
      try { for (let n = 1; n <= pdf.numPages; n++) {
        const page = await pdf.getPage(n), base = page.getViewport({ scale: 1 });
        const vp = page.getViewport({ scale: 1600 / Math.max(base.width, base.height) });
        const canvas = createCanvas(Math.ceil(vp.width), Math.ceil(vp.height));
        await page.render({ canvas: canvas as never, canvasContext: canvas.getContext("2d") as never, viewport: vp }).promise;
        content.push({ type: "input_text", text: `${sourceIndex ? "SECOND PDF — PRIVATE marking key" : "FIRST PDF — test paper"}, source page ${n} of ${pdf.numPages}.` }, { type: "input_image", detail: "high", image_url: `data:image/png;base64,${canvas.toBuffer("image/png").toString("base64")}` });
        page.cleanup();
      } } finally { await task.destroy(); }
    }
    imageInputs.set(fixture.id, content);
  }
  const fingerprint = sha(JSON.stringify({ prompt: FORMAT_INSTRUCTIONS, schema, fixtures: fixtures.map(f => ({ id: f.id, sha: sha(f.source), key: f.key ? sha(f.key) : null })), ...(images ? { inputMode: "page-images-1600", imageHashes: [...imageInputs].map(([id, content]) => [id, sha(JSON.stringify(content))]) } : {}) }));
  await mkdir(`${root}/runs`, { recursive: true });
  const metadata = { fingerprint, inputMode: images ? "page-images-1600" : "pdf", promptVersion: FORMAT_PROMPT_VERSION, rates, pricingDate: "2026-09-13", pricingSources: Object.keys(rates).map(id => `https://developers.openai.com/api/docs/models/${id}`), replicates: 3, maxOutputTokens: 32000, productionAiDeadlineMs: 110000, benchmarkCaptureDeadlineMs: 300000, concurrency: 4, fixtures: fixtures.map(f => ({ id: f.id, pages: f.pageCount, bytes: f.source.length, sha256: sha(f.source), keyIncluded: !!f.key })), instructions: FORMAT_INSTRUCTIONS, schema };
  try { const existing = JSON.parse(await readFile(`${root}/manifest.json`, "utf8")); if (existing.fingerprint !== fingerprint) throw new Error("Benchmark inputs changed. Use a new output directory; never mix experiments."); } catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; }
  if (process.argv.includes("--prepare-only")) { console.log(JSON.stringify({ event: "inputs_verified", fingerprint, fixtures: metadata.fixtures.map(f => ({ id: f.id, pages: f.pages })), paidRequests: 0 })); return; }
  await writeFile(`${root}/manifest.json`, JSON.stringify(metadata, null, 2), { mode: 0o600 });
  const configs = Object.keys(rates).flatMap(model => (images ? ["low", "medium"] : efforts).filter(e => model !== "gpt-6-astra" || e !== "none").map(effort => ({ model: model as keyof typeof rates, effort })));
  // Rotate all models/efforts across fixtures and repeats; avoid running one model only during one traffic window.
  const jobs = Array.from({ length: 3 }, (_, rep) => fixtures.flatMap((fixture, fi) => configs.map((_, c) => ({ ...configs[(c * 7 + rep + fi) % configs.length], fixture, rep: rep + 1 })))).flat();
  const existing = await readdir(`${root}/runs`); let spent = 0; let done = 0;
  for (const file of existing.filter(f => f.endsWith('.json'))) { const row = JSON.parse(await readFile(`${root}/runs/${file}`, 'utf8')); spent += row.costUsd ?? 0; }
  console.log(JSON.stringify({ event: "benchmark_started", settings: configs.length, runs: jobs.length, fingerprint, priorRecordedCostUsd: spent }));
  let index = 0, accountBlocked = false;
  await Promise.all(Array.from({ length: 4 }, async () => { for (;;) {
    if (accountBlocked) break;
    const job = jobs[index++]; if (!job) break;
    const id = `${job.model}-${job.effort}--${job.fixture.id}--${job.rep}`; const file = `${root}/runs/${id}.json`;
    if (existing.includes(`${id}.json`)) { done++; continue; }
    if (spent > 125) throw new Error("Benchmark recorded spend crossed the $125 ceiling; inspect evidence before additional calls.");
    const started = Date.now(); let row: Record<string, unknown> = { id, model: job.model, effort: job.effort, fixture: job.fixture.id, replicate: job.rep, fingerprint, startedAt: new Date(started).toISOString() };
    console.log(JSON.stringify({ event: "run_started", id }));
    try {
      const files = [{ name: 'paper.pdf', bytes: job.fixture.source }, ...(job.fixture.key ? [{ name: 'marking-key.pdf', bytes: job.fixture.key }] : [])];
      const result = await fetch('https://api.openai.com/v1/responses', { method: 'POST', signal: AbortSignal.timeout(300000), headers: { Authorization: `Bearer ${key}`, 'Content-Type': 'application/json' }, body: JSON.stringify({ model: job.model, reasoning: { effort: job.effort }, service_tier: 'default', store: false, instructions: FORMAT_INSTRUCTIONS, max_output_tokens: 32000,
        input: [{ role: 'user', content: [{ type: 'input_text', text: JSON.stringify({ documents: files.map(f => f.name), sourcePageCount: job.fixture.pageCount, keyIncluded: files.length > 1 }) }, ...(images ? imageInputs.get(job.fixture.id)! : files.map(f => ({ type: 'input_file', filename: f.name, file_data: `data:application/pdf;base64,${f.bytes.toString('base64')}` })))] }], text: { format: { type: 'json_schema', name: 'begifted_assessment', strict: true, schema } } }) });
      const body = await result.json(); const latencyMs = Date.now() - started; const usage = body.usage ?? null; const r = rates[job.model];
      if (body.error?.type === 'insufficient_quota' || body.error?.code === 'credit_balance_exhausted') accountBlocked = true;
      const cached = usage?.input_tokens_details?.cached_tokens ?? 0; const writes = usage?.input_tokens_details?.cache_write_tokens ?? 0;
      const costUsd = usage ? ((usage.input_tokens - cached - writes) * r.input + cached * r.cached + writes * r.input * 1.25 + usage.output_tokens * r.output) / 1e6 : null;
      const uncachedCostUsd = usage ? (usage.input_tokens * r.input + usage.output_tokens * r.output) / 1e6 : null;
      const text = body.output?.flatMap((o: { content?: { type: string; text?: string }[] }) => o.content ?? []).filter((c: { type: string }) => c.type === 'output_text').map((c: { text?: string }) => c.text || '').join('') ?? '';
      let parsed; let parseError: string | null = null;
      try { parsed = formattedPaperSchema.parse(JSON.parse(text)); } catch (error) { parseError = error instanceof Error ? error.message.slice(0, 2000) : 'Invalid response'; }
      row = { ...row, httpStatus: result.status, requestId: result.headers.get('x-request-id'), responseId: body.id, returnedModel: body.model, serviceTier: body.service_tier, responseStatus: body.status, latencyMs, productionTimeout: latencyMs > 110000, usage, costUsd, uncachedCostUsd, providerError: body.error ?? null, incompleteDetails: body.incomplete_details ?? null, parseError, paper: parsed ?? null, rawText: parsed ? undefined : text, apiSuccess: result.ok && body.status === 'completed' && !!parsed };
      spent += costUsd ?? 0;
    } catch (error) { row = { ...row, latencyMs: Date.now() - started, apiSuccess: false, transportError: error instanceof Error ? error.message : 'Request failed', costUsd: null }; }
    await writeFile(file, JSON.stringify(row, null, 2), { mode: 0o600 }); done++;
    console.log(JSON.stringify({ event: 'run_finished', done, total: jobs.length, id, success: row.apiSuccess, seconds: Number(row.latencyMs) / 1000, costUsd: row.costUsd, recordedTotalUsd: Math.round(spent * 100) / 100 }));
  } }));
  console.log(JSON.stringify({ event: accountBlocked ? 'benchmark_paused_no_credits' : 'benchmark_finished', done, recordedCostUsd: spent }));
}
main().catch(error => { console.error(error instanceof Error ? error.message : error); process.exitCode = 1; });
