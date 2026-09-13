import { mkdir, readdir, readFile, writeFile } from "node:fs/promises";
import { normalizeFormattedPaper } from "../../src/lib/progress-tests/workspace/model";
import { scorePaper } from "./score";
import { root as baseRoot } from "./fixtures";

const root = `${baseRoot}/codex-app-images-1600`;
const mean = (values: number[]) => values.reduce((a, b) => a + b, 0) / values.length;
const median = (values: number[]) => { const a = [...values].sort((a, b) => a - b); return (a[Math.floor((a.length - 1) / 2)] + a[Math.floor(a.length / 2)]) / 2; };
async function main() {
  const manifest = JSON.parse(await readFile(`${root}/manifest.json`, "utf8"));
  const rows = [];
  for (const file of (await readdir(`${root}/runs`)).filter(f => f.endsWith(".json") && !f.endsWith(".response.json"))) {
    const run = JSON.parse(await readFile(`${root}/runs/${file}`, "utf8"));
    const fixture = manifest.fixtures.find((f: { id: string }) => f.id === run.fixture);
    const paper = run.paper ? normalizeFormattedPaper(run.paper, fixture.pages, fixture.keyIncluded) : null;
    const quality = paper ? scorePaper(paper, run.fixture, fixture.pages) : null;
    let rendered;
    try { rendered = JSON.parse(await readFile(`${root}/renders/${run.id}/result.json`, "utf8")); } catch {}
    rows.push({ id: run.id, model: run.model, effort: run.effort, fixture: run.fixture, replicate: run.replicate, success: run.apiSuccess, timedOut: run.timedOut, exitCode: run.exitCode, parseError: run.parseError, errors: run.errors, toolItems: run.toolItems.length, quality: quality?.score ?? null, failures: quality?.failures.map(f => f.name) ?? [], renderSuccess: rendered?.success ?? null, renderSeconds: rendered?.renderMs ? rendered.renderMs / 1000 : null, seconds: run.latencyMs / 1000, usage: run.usage, contentPass: run.apiSuccess && rendered?.success === true && quality?.score === 100, within110: run.latencyMs <= 110000 });
  }
  const groups = [];
  for (const model of ["gpt-5.6-luna", "gpt-5.6-terra", "gpt-5.6-sol", "gpt-6-astra"]) {
    for (const effort of ["low", "medium", "high", "xhigh", "max"]) {
      const rs = rows.filter(r => r.model === model && r.effort === effort);
      if (!rs.length) continue;
      const balanced = (get: (r: typeof rs[number]) => number | null) => {
        const bins = manifest.fixtures.map((f: { id: string }) => rs.filter(r => r.fixture === f.id).map(get).filter((v): v is number => v !== null));
        return bins.some((v: number[]) => !v.length) ? null : mean(bins.map((v: number[]) => mean(v)));
      };
      groups.push({ model, effort, n: rs.length, nByFixture: Object.fromEntries(manifest.fixtures.map((f: { id: string }) => [f.id, rs.filter(r => r.fixture === f.id).length])), contentPass: rs.filter(r => r.contentPass).length, contentPassBalanced: balanced(r => r.contentPass ? 100 : 0), deadlinePass: rs.filter(r => r.contentPass && r.within110).length, responseFailures: rs.filter(r => !r.success).length, sourceFailures: rs.filter(r => r.success && r.quality !== null && r.quality < 100).length, toolViolations: rs.filter(r => r.toolItems > 0).length, renderFailures: rs.filter(r => r.renderSuccess === false).length, captureTimeouts: rs.filter(r => r.timedOut).length, sourceChecks: balanced(r => r.success ? r.quality : null), medianSeconds: median(rs.map(r => r.seconds)), meanInputTokens: balanced(r => r.usage?.input_tokens ?? null), meanOutputTokens: balanced(r => r.usage?.output_tokens ?? null), meanReasoningTokens: balanced(r => r.usage?.reasoning_output_tokens ?? null) });
    }
  }
  const report = { generatedAt: new Date().toISOString(), plannedRuns: 108, runs: rows.length, manifest, groups, rows };
  await mkdir(`${root}/report`, { recursive: true });
  await writeFile(`${root}/report/results.json`, JSON.stringify(report, null, 2), { mode: 0o600 });
  const table = ["| Requested model | Effort | Runs | Content/PDF passes | Passes also within 110s | Response / source / PDF errors | Source checks | Median captured elapsed |", "|---|---|---:|---:|---:|---|---:|---:|", ...groups.map(g => `| ${g.model.replace("gpt-", "")} | ${g.effort} | ${g.n} | ${g.contentPass}/${g.n} | ${g.deadlinePass}/${g.n} | ${g.responseFailures} / ${g.sourceFailures} / ${g.renderFailures} | ${g.sourceChecks === null ? "Unscored" : `${g.sourceChecks.toFixed(1)}%`} | ${g.medianSeconds.toFixed(1)}s |`)];
  const text = `# Codex formatting evaluation\n\n${rows.length}/108 planned outcomes recorded. This is a separate ChatGPT-authenticated Codex experiment; **no API-key balance is used and no API dollar costs are measured here**.\n\n${table.join("\n")}\n\nThe sweep covers low/medium/high/xhigh/max on all four models and three documents. Low and medium receive three repeats per document; other levels receive one. Codex does not list none for these models. Ultra is an agent-orchestration mode and is outside this fixed document-transformation comparison.\n\nSources are the same papers, rendered as 1,600-pixel page images. The instructions, JSON schema, source checks and BeGifted PDF renderer are fixed within this experiment. Tools, plugins, hooks, web access and delegation are disabled. Each process is ephemeral with a separate read-only working directory; only the attached images are supplied. API-key environment variables are removed and ChatGPT authentication is required. The main sweep uses four concurrent processes; the included Astra-low typed-paper preflight ran alone with a configured limit of two. Tables identify the requested model and effort, not a pinned backend snapshot.\n\nCodex adds its own system instructions, image handling and transport behavior. Its elapsed time includes CLI startup and the runtime's normal transport handling, and it uses its default output cap. These results must not be pooled with the native-PDF Responses API trials or treated as website latency/error-rate validation. The 110-second column is an informational comparison with the current website timeout; content/PDF passes allow the full 300-second capture window.\n\nDollar comparisons come from the separate API measurements and official token rates. Reported Codex token usage is preserved for analysis, not represented as an API invoice. Source-check percentages are conditional on complete responses, balanced equally across document types; raw pass fractions use the available trials. Capture timeouts are censored at 300 seconds: their completion time, token usage and content quality are unknown, not zero. Source-check means remain unscored when a document has no complete response. Small, correlated samples cannot establish a production failure rate.\n`;
  await writeFile(`${root}/report/report.md`, text);
  const headers = ["model", "effort", "n", "contentPass", "deadlinePass", "responseFailures", "sourceFailures", "renderFailures", "captureTimeouts", "toolViolations", "sourceChecks", "medianSeconds", "meanInputTokens", "meanOutputTokens", "meanReasoningTokens"];
  await writeFile(`${root}/report/summary.csv`, headers.join(",") + "\n" + groups.map(g => headers.map(h => JSON.stringify(g[h as keyof typeof g] ?? "")).join(",")).join("\n") + "\n");
  console.log(JSON.stringify({ runs: rows.length, complete: rows.filter(r => r.success).length, rendered: rows.filter(r => r.renderSuccess === true).length, contentPasses: rows.filter(r => r.contentPass).length, groups: groups.map(g => ({ model: g.model, effort: g.effort, n: g.n, pass: g.contentPass, score: g.sourceChecks })) }));
}
main().catch(error => { console.error(error); process.exitCode = 1; });
