#!/usr/bin/env node
/** Local V5 publisher. All Google data writes are explicitly requested by --publish. */
import { spawn } from "node:child_process";
import { readFileSync, mkdirSync, openSync, closeSync, unlinkSync, writeFileSync } from "node:fs";
import { resolve, dirname, join } from "node:path";
import { gunzipSync, gzipSync } from "node:zlib";
import { parseArgs } from "node:util";

async function main() {
  const { values } = parseArgs({ options: {
    bundle: { type: "string" }, "env-file": { type: "string" }, "datasets-dir": { type: "string" },
    "google-credentials": { type: "string" }, "spreadsheet-id": { type: "string" }, "rollback-id": { type: "string" },
    "folder-id": { type: "string" }, publish: { type: "boolean", default: false }, validate: { type: "boolean", default: false },
  } });
  const root = resolve(dirname(new URL(import.meta.url).pathname), "..");
  const datasets = resolve(values["datasets-dir"] ?? join(root, "..", "BeGifted Datasets"));
  const envFile = resolve(values["env-file"] ?? join(root, ".env.production.local"));
  process.loadEnvFile(envFile);
  const { PublicationGoogle } = await import("../src/lib/unearned-revenue/publisher/google");
  const { publishBundle, validateDailyBundle } = await import("../src/lib/unearned-revenue/publisher/publish");
  const { sha256, parseValuesPublication } = await import("../src/lib/unearned-revenue/publication");
  const { splitMonth, allocatedCells, monthDigest } = await import("../src/lib/unearned-revenue/publisher/layout");
  const { getUnearnedRevenueConnectedEmail, getUnearnedRevenueSpreadsheetId } = await import("../src/lib/unearned-revenue/sync");
  const output = join(datasets, "outputs", "unearned-v5"); mkdirSync(output, { recursive: true, mode: 0o700 });
  const lockPath = join(output, "publisher.lock");
  let lock: number;
  try { lock = openSync(lockPath, "wx", 0o600); writeFileSync(lock, JSON.stringify({ pid: process.pid, startedAt: new Date().toISOString() })); }
  catch { throw new Error(`Publisher already running or interrupted. Check the PID in ${lockPath} before removing a stale lock.`); }
  try {
    const id = values["spreadsheet-id"] ?? getUnearnedRevenueSpreadsheetId();
    let bundlePath = values.bundle && resolve(values.bundle);
    if (!bundlePath) {
      bundlePath = join(output, `bundle-${new Date().toISOString().replaceAll(":", "-")}.json.gz`);
      const credentials = values["google-credentials"] ?? join(root, "..", "BeGifted_Consulting_Materials", "begifted-sheets-ab2b8e47aa86.json");
      const args = [join(datasets, "scripts", "build_unearned_report_bundle.py"), "--cutoff", "previous-day", "--target-spreadsheet-id", id, "--wise-env-file", envFile, "--google-credentials", credentials, "--output", bundlePath];
      const code = await new Promise<number | null>((resolveCode, reject) => { const child = spawn(join(datasets, ".venv", "bin", "python"), args, { cwd: datasets, stdio: "inherit" }); child.on("exit", resolveCode); child.on("error", reject); });
      if (code !== 0) throw new Error("Accounting engine failed; previous publication retained");
    }
    const bytes = readFileSync(bundlePath);
    const bundle = JSON.parse(gunzipSync(bytes, { maxOutputLength: 500_000_000 }).toString()) as import("../src/lib/unearned-revenue/publisher/layout").ReportBundle;
    validateDailyBundle(bundle);
    const contract = gzipSync(JSON.stringify({ tables: bundle.tables, traces: {} }));
    const fakeFile = { fileId: "preflight-placeholder", bytes: contract.length, sha256: sha256(contract) };
    const qa = bundle.tables["QA Checks"];
    const months = Object.entries(bundle.reports.months).flatMap(([month, data]) => splitMonth(data).map(part => ({ month, from: part.finance[0].date, to: part.finance.at(-1)!.date, spreadsheetId: "preflight-placeholder", cells: allocatedCells(part), sha256: monthDigest(part), overviewSheetId: 1, studentSheetId: 2, packageSheetId: 3 })));
    const manifest = { schemaVersion: 5, runId: bundle.status.run_id, cutoff: bundle.status.published_cutoff, sourceFingerprint: bundle.status.source_fingerprint, revision: bundle.status.publication_revision, generatedAtBangkok: bundle.status.generated_at_bangkok, canonicalModel: bundle.status.canonical_model, modelVersion: bundle.status.candidate_model_version, contract: fakeFile, audit: fakeFile, folderId: "preflight-placeholder", rollbackSpreadsheetId: "preflight-placeholder", months,
      rowCounts: Object.fromEntries(Object.entries(bundle.tables).map(([name, rows]) => [name, rows.length - 1])),
      qa: { hardStatus: "PASS", dailyCount: bundle.reports.finance.length, creditTolerance: 0.001, moneyTolerance: 1, checks: qa.slice(1).filter(row => row[qa[0].indexOf("status")] === "PASS").map(row => row[0]) },
    };
    parseValuesPublication({ manifest, contractBytes: contract, statusStart: bundle.tables["Model Status"], statusEnd: bundle.tables["Model Status"] });
    if (values.validate) { process.stdout.write(JSON.stringify({ status: "validated", cutoff: bundle.status.published_cutoff, days: bundle.reports.finance.length, reports: months.length, cells: months.map(m => ({ month: m.month, cells: m.cells })) }) + "\n"); return; }
    const google = new PublicationGoogle(getUnearnedRevenueConnectedEmail(), [
      { type: "user", emailAddress: "nui@absoluteboutiquefitness.com", role: "reader" },
      { type: "user", emailAddress: "chittima.karoon@gmail.com", role: "reader" },
      { type: "user", emailAddress: "aoengnatchasmith@gmail.com", role: "writer" },
      { type: "user", emailAddress: "k.waritpariya@gmail.com", role: "writer" },
      { type: "user", emailAddress: "begifted-bot@begifted-sheets.iam.gserviceaccount.com", role: "writer" },
    ]);
    await google.connect();
    const result = await publishBundle({ google, bundle, bundleHash: sha256(bytes), spreadsheetId: id,
      rollbackId: values["rollback-id"] ?? "133Upo9wrHY5NKKxXyZnZStqW7bnyODu18nDNok9Z82U", statePath: bundlePath + ".prepared.json", folderId: values["folder-id"], commit: values.publish });
    process.stdout.write(JSON.stringify(result) + "\n");
    process.exitCode = result.reviewChanged ? 2 : 0;
  } finally { closeSync(lock); unlinkSync(lockPath); }
}
main().catch(error => { process.stderr.write(`${error instanceof Error ? error.stack : error}\n`); process.stdout.write(JSON.stringify({ status: "failed", publicationOutcome: "Read Model Status run_id to resolve any transport failure after atomic commit", error: error instanceof Error ? error.message : String(error) }) + "\n"); process.exitCode = 1; });
