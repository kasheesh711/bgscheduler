/** Real private storage + multimodal processing, guarded to disposable local databases. */
import { readFile, writeFile, mkdir } from "node:fs/promises";
import { createHash } from "node:crypto";
import { parse } from "dotenv";
import { Pool } from "pg";
import { drizzle } from "drizzle-orm/node-postgres";
import { migrate } from "drizzle-orm/node-postgres/migrator";
import { eq } from "drizzle-orm";
import { put } from "@vercel/blob";
import { PDFDocument } from "pdf-lib";
import * as schema from "../src/lib/db/schema";
import type { Database } from "../src/lib/db";
import { scopeForEmail } from "../src/lib/progress-tests/workspace/access";
import { executeCommand, paperDetail } from "../src/lib/progress-tests/workspace/data";
import { claimJob } from "../src/lib/progress-tests/workspace/jobs";
import { runFormatting } from "../src/lib/progress-tests/workspace/formatting";
import { readBlobBytes } from "../src/lib/progress-tests/workspace/files";
import { documentHtml, renderHtmlPdf } from "../src/lib/progress-tests/workspace/documents";

async function main() {
  if (!process.argv.includes("--live-ai")) throw new Error("Paid API verification requires explicit authorization and --live-ai.");
  const env = parse(await readFile(".env.local"));
  const url = new URL(env.DATABASE_URL);
  if (!["localhost", "127.0.0.1"].includes(url.hostname) || !url.pathname.endsWith("_test")) throw new Error("Use a disposable local _test database.");
  Object.assign(process.env, env);
  const output = "output/progress-tests-pdf"; await mkdir(output, { recursive: true });
  const pool = new Pool({ connectionString: url.toString(), max: 4 });
  try {
    const actual = drizzle(pool, { schema }); await migrate(actual, { migrationsFolder: "drizzle" }); const db = actual as unknown as Database;
    await db.insert(schema.tutorContacts).values({ canonicalKey: "pdf-check", displayName: "PDF validation tutor", onsiteEmail: "pdf-check@example.test", active: true }).onConflictDoNothing();
    const scope = await scopeForEmail("pdf-check@example.test", db);
    const sourcePath = process.argv.slice(2).find(arg => arg !== "--live-ai");
    const source = sourcePath ? await readFile(sourcePath) : await renderHtmlPdf(await documentHtml("Technical sample assessment", "Source fixture", '<p>Answer both questions. Show working. อ่านคำสั่งและแสดงวิธีทำ</p><h2>1. Solve 3x + 4 = 19. [3 marks]</h2><p>...................................................................</p><h2>2. Calculate the area of this rectangle. [2 marks]</h2><svg xmlns="http://www.w3.org/2000/svg" width="340" height="190"><rect x="50" y="40" width="220" height="110" fill="none" stroke="black" stroke-width="2"/><text x="140" y="25">8 cm</text><text x="280" y="100">3 cm</text></svg><p>...................................................................</p>'));
    const pageCount = (await PDFDocument.load(source)).getPageCount();
    if (!sourcePath) await writeFile(`${output}/sample-source.pdf`, source);
    const create = await executeCommand(scope, { action: "create-paper", title: "Pipeline verification" }, db);
    const intent = await executeCommand(scope, { action: "upload-intent", purpose: "paper", name: "Uploaded paper.pdf", mime: "application/pdf", size: source.length }, db);
    await put(intent.pathname!, source, { access: "private", contentType: "application/pdf", addRandomSuffix: false, allowOverwrite: false });
    await db.update(schema.ptFiles).set({ status: "ready", pageCount, sha256: createHash("sha256").update(source).digest("hex") }).where(eq(schema.ptFiles.id, intent.id!));
    await executeCommand(scope, { action: "attach-original", id: create.id!, expectedRevision: 0, sourceFileId: intent.id!, keyFileId: null }, db);
    const queued = await executeCommand(scope, { action: "format-paper", id: create.id!, expectedRevision: 1, sourceFileId: intent.id!, keyFileId: null }, db);
    const job = await claimJob(db, undefined, queued.jobId); if (!job) throw new Error("Job was not dispatched");
    console.log(JSON.stringify({ state: "started", pages: pageCount, paperId: create.id, jobId: job.id, model: job.input.model, effort: job.input.reasoningEffort }));
    const started = Date.now();
    const result = await runFormatting(job, db);
    await db.update(schema.ptJobs).set({ status: "completed", result, finishedAt: new Date(), leaseUntil: null }).where(eq(schema.ptJobs.id, job.id));
    const detail = await paperDetail(scope, create.id!, db);
    const stem = sourcePath ? "regression" : "sample";
    for (const artifact of detail.artifacts) {
      const [file] = await db.select().from(schema.ptFiles).where(eq(schema.ptFiles.id, artifact.fileId));
      await writeFile(`${output}/${stem}-${artifact.kind}.pdf`, await readBlobBytes(file), { mode: 0o600 });
    }
    const [finished] = await db.select().from(schema.ptJobs).where(eq(schema.ptJobs.id, job.id));
    const evidence = { paperId: create.id, jobId: job.id, durationSeconds: (Date.now() - started) / 1000, sourcePages: pageCount, questionCount: ("questions" in detail.versions[0].paper ? detail.versions[0].paper.questions.length : 0), warnings: ("warnings" in detail.versions[0].paper ? detail.versions[0].paper.warnings : []), model: detail.versions[0].model, timings: finished.timings, artifacts: detail.artifacts, paper: detail.versions[0].paper };
    await writeFile(`${output}/${stem}-verification.json`, JSON.stringify(evidence, null, 2), { mode: 0o600 });
    console.log(JSON.stringify({ state: "completed", durationSeconds: evidence.durationSeconds, sourcePages: pageCount, questionCount: evidence.questionCount, warnings: evidence.warnings, timings: evidence.timings }));
  } finally { await pool.end(); }
}
main().catch(error => { console.error(error instanceof Error ? error.message : "Pipeline verification failed"); process.exitCode = 1; });
