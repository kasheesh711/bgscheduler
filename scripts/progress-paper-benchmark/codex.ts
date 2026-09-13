/** Explicit ChatGPT-authenticated Codex evaluation. No OpenAI API-key requests. */
import { spawn, spawnSync, execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdir, readFile, writeFile, readdir, mkdtemp } from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import { createCanvas } from "@napi-rs/canvas";
import { z } from "zod";
import { formattedPaperSchema } from "../../src/lib/progress-tests/workspace/model";
import { FORMAT_INSTRUCTIONS, FORMAT_PROMPT_VERSION } from "../../src/lib/progress-tests/workspace/ai";
import { createFixtures, root as baseRoot, pdfPages } from "./fixtures";

const root = `${baseRoot}/codex-app-images-1600`;
const hash = (value: string | Buffer) => createHash("sha256").update(value).digest("hex");
const disabled = ["apps", "plugins", "hooks", "memories", "multi_agent", "multi_agent_v2", "shell_tool", "unified_exec", "view_image", "browser_use", "browser_use_external", "computer_use", "image_generation", "in_app_browser", "skill_search", "workspace_dependencies"];
const value = (name: string) => process.argv.find(v => v.startsWith(`--${name}=`))?.split("=")[1];

async function main() {
  if (!process.argv.includes("--run")) throw new Error("Pass --run to authorize use of the signed-in Codex allowance.");
  const binary = value("binary") ?? "/Applications/ChatGPT.app/Contents/Resources/codex";
  const concurrency = Math.max(1, Math.min(4, Number(value("concurrency") ?? 4)));
  const auth = spawnSync(binary, ["login", "status"], { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });
  if (auth.status !== 0 || !(auth.stdout + auth.stderr).includes("ChatGPT")) throw new Error("This evaluation requires ChatGPT authentication, not an API key.");
  const cliVersion = execFileSync(binary, ["--version"], { encoding: "utf8" }).trim();
  const schema = z.toJSONSchema(formattedPaperSchema, { target: "draft-7" });
  await mkdir(`${root}/runs`, { recursive: true });
  await mkdir(`${root}/inputs`, { recursive: true });
  await writeFile(`${root}/schema.json`, JSON.stringify(schema), { mode: 0o600 });
  const fixtures = await createFixtures();
  const inputs = [];
  for (const fixture of fixtures) {
    const files: string[] = [], labels: string[] = [], imageHashes: string[] = [];
    for (const [sourceIndex, source] of [fixture.source, ...(fixture.key ? [fixture.key] : [])].entries()) {
      const { pdf, task } = await pdfPages(source);
      try {
        for (let n = 1; n <= pdf.numPages; n++) {
          const page = await pdf.getPage(n), base = page.getViewport({ scale: 1 });
          const viewport = page.getViewport({ scale: 1600 / Math.max(base.width, base.height) });
          const canvas = createCanvas(Math.ceil(viewport.width), Math.ceil(viewport.height));
          await page.render({ canvas: canvas as never, canvasContext: canvas.getContext("2d") as never, viewport }).promise;
          const bytes = canvas.toBuffer("image/png");
          const file = path.resolve(`${root}/inputs/${fixture.id}-${sourceIndex ? "key" : "paper"}-${n}.png`);
          await writeFile(file, bytes, { mode: 0o600 }); files.push(file); imageHashes.push(hash(bytes));
          labels.push(`Image ${files.length}: ${sourceIndex ? "PRIVATE marking key" : "test paper"}, page ${n} of ${pdf.numPages}.`);
          page.cleanup();
        }
      } finally { await task.destroy(); }
    }
    const prompt = `${FORMAT_INSTRUCTIONS}\n\nThis is an isolated document-transformation evaluation. Use only the attached images. Do not use tools, read files, browse, delegate, or write code. Return only the complete JSON object required by the schema.\n\n${JSON.stringify({ sourcePageCount: fixture.pageCount, keyIncluded: !!fixture.key })}\n${labels.join("\n")}`;
    inputs.push({ id: fixture.id, files, imageHashes, prompt, pages: fixture.pageCount, keyIncluded: !!fixture.key });
    await writeFile(`${root}/inputs/${fixture.id}-prompt.txt`, prompt, { mode: 0o600 });
  }
  const fingerprint = hash(JSON.stringify({ cliVersion, schema, inputs: inputs.map(i => ({ id: i.id, prompt: i.prompt, imageHashes: i.imageHashes })), disabled }));
  const manifest = { fingerprint, cliVersion, promptVersion: FORMAT_PROMPT_VERSION, inputMode: "codex-page-images-1600", auth: "ChatGPT", isolatedReadOnly: true, concurrency, captureDeadlineMs: 300000, disabled, outputLimit: "Codex runtime default; not the API matrix's 32000-token cap", fixtures: inputs.map(({ id, pages, keyIncluded, imageHashes }) => ({ id, pages, keyIncluded, imageHashes })) };
  try { const old = JSON.parse(await readFile(`${root}/manifest.json`, "utf8")); if (old.fingerprint !== fingerprint) throw new Error("Codex experiment inputs changed. Preserve old evidence and use another directory."); }
  catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; }
  await writeFile(`${root}/manifest.json`, JSON.stringify(manifest, null, 2), { mode: 0o600 });
  const models = value("models")?.split(",") ?? ["gpt-5.6-luna", "gpt-5.6-terra", "gpt-5.6-sol", "gpt-6-astra"];
  const efforts = value("efforts")?.split(",") ?? ["low", "medium", "high", "xhigh", "max"];
  const repetitions = Number(value("repetitions") ?? 1);
  const selected = value("fixtures") ? inputs.filter(i => value("fixtures")!.split(",").includes(i.id)) : inputs;
  const configs = efforts.flatMap(effort => models.map(model => ({ model, effort })));
  const jobs = Array.from({ length: repetitions }, (_, rep) => selected.flatMap((fixture, index) => configs.map((_, c) => ({ ...configs[(c + index + rep) % configs.length], fixture, replicate: rep + 1 })))).flat();
  const environment = { ...process.env };
  for (const k of Object.keys(environment)) if (/OPENAI.*KEY|AZURE.*KEY/.test(k)) delete environment[k];
  let next = 0, blocked = false, stopped = false;
  for (const signal of ["SIGINT", "SIGTERM"] as const) process.on(signal, () => { stopped = true; });
  const existing = new Set(await readdir(`${root}/runs`));
  await Promise.all(Array.from({ length: concurrency }, async () => {
    for (;;) {
      if (blocked || stopped) return;
      const job = jobs[next++]; if (!job) return;
      const id = `${job.model}-${job.effort}--${job.fixture.id}--${job.replicate}`;
      if (existing.has(`${id}.json`)) continue;
      const cwd = await mkdtemp(path.join(os.tmpdir(), "pt-codex-eval-"));
      const output = path.resolve(`${root}/runs/${id}.response.json`);
      const args = ["exec", "--ignore-user-config", "--ephemeral", "--skip-git-repo-check", "--sandbox", "read-only", "-C", cwd, "-m", job.model, "-c", `model_reasoning_effort="${job.effort}"`, "-c", 'forced_login_method="chatgpt"', "-c", 'web_search="disabled"', ...disabled.flatMap(f => ["--disable", f]), "--output-schema", path.resolve(`${root}/schema.json`), "--output-last-message", output, "--json", ...job.fixture.files.flatMap(f => ["-i", f]), "-"];
      const started = Date.now(); console.log(JSON.stringify({ event: "run_started", id }));
      await writeFile(`${root}/runs/${id}.started`, JSON.stringify({ id, startedAt: new Date(started).toISOString(), fingerprint }), { mode: 0o600 });
      const result = await new Promise<{ stdout: string; stderr: string; exitCode: number | null; timedOut: boolean }>(resolve => {
        const child = spawn(binary, args, { env: environment }); let stdout = "", stderr = "", timedOut = false;
        child.stdin.end(job.fixture.prompt); child.stdout.on("data", b => { stdout += b; }); child.stderr.on("data", b => { stderr += b; });
        const timer = setTimeout(() => { timedOut = true; child.kill("SIGTERM"); }, 300000);
        child.on("close", exitCode => { clearTimeout(timer); resolve({ stdout, stderr, exitCode, timedOut }); });
      });
      const events = result.stdout.split("\n").flatMap(line => { try { return [JSON.parse(line)]; } catch { return []; } });
      const usage = events.findLast(e => e.type === "turn.completed")?.usage ?? null;
      const errors = events.filter(e => e.type === "error" || e.type === "turn.failed");
      const toolItems = events.filter(e => e.item && !["reasoning", "agent_message", "plan", "error"].includes(e.item.type));
      let paper = null, parseError: string | null = null;
      try { paper = formattedPaperSchema.parse(JSON.parse(await readFile(output, "utf8"))); }
      catch (error) { parseError = error instanceof Error ? error.message.slice(0, 1500) : "No structured output"; }
      blocked = /usage limit|insufficient_quota|credit_balance|rate limit reached|authentication failed|not logged in/i.test(JSON.stringify(errors) + result.stderr);
      const row = { id, model: job.model, effort: job.effort, fixture: job.fixture.id, replicate: job.replicate, fingerprint, concurrency, startedAt: new Date(started).toISOString(), latencyMs: Date.now() - started, exitCode: result.exitCode, timedOut: result.timedOut, usage, errors, parseError, toolItems, apiSuccess: result.exitCode === 0 && !!paper && !toolItems.length, paper, costUsd: null, billing: "Codex allowance; no API charge measurement" };
      await writeFile(`${root}/runs/${id}.json`, JSON.stringify(row, null, 2), { mode: 0o600 });
      await writeFile(`${root}/runs/${id}.events.jsonl`, result.stdout, { mode: 0o600 });
      await writeFile(`${root}/runs/${id}.stderr.txt`, result.stderr, { mode: 0o600 });
      console.log(JSON.stringify({ event: "run_finished", id, success: row.apiSuccess, seconds: row.latencyMs / 1000, usage, errors, toolItems: toolItems.length, parseError: paper ? null : parseError }));
    }
  }));
  console.log(JSON.stringify({ event: blocked ? "codex_allowance_blocked" : stopped ? "codex_paused_by_operator" : "codex_sweep_finished", plannedInInvocation: jobs.length }));
}
main().catch(error => { console.error(error instanceof Error ? error.message : error); process.exitCode = 1; });
