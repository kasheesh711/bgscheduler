import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { createHash, randomUUID } from "node:crypto";
import { eq, sql } from "drizzle-orm";
import { PDFDocument } from "pdf-lib";
import { startTestDb, stopTestDb } from "@/tests/integration/db-helper";
import type { Database } from "@/lib/db";
import * as s from "@/lib/db/schema";
import { scopeForEmail, type Scope } from "../access";
import { executeCommand, getAssessment, paperDetail, paperVersionForOwner } from "../data";
import { claimJob, runJob } from "../jobs";
import { jobProgress } from "../progress";
import { structuredPaper, type Paper } from "../model";

const mock = vi.hoisted(() => ({ format: vi.fn(), paper: vi.fn(), key: vi.fn(), bytes: new Map<string, Buffer>() }));
vi.mock("../ai", async original => ({ ...await original<typeof import("../ai")>(), formatPaper: mock.format }));
vi.mock("../paper-renderer", () => ({ PAPER_RENDERER_VERSION: "test-v2", renderFormattedPaper: mock.paper, renderMarkingScheme: mock.key }));
vi.mock("../files", async original => ({ ...await original<typeof import("../files")>(), readBlobBytes: async (file: { id: string }) => mock.bytes.get(file.id)!, storeGenerated: async (ownerKey: string, name: string, bytes: Buffer, db: Database) => {
  const id = randomUUID(); mock.bytes.set(id, bytes);
  const [file] = await db.insert(s.ptFiles).values({ id, ownerKey, name, mime: "application/pdf", size: bytes.length, pageCount: 1, sha256: createHash("sha256").update(bytes).digest("hex"), pathname: `progress-tests/${id}/generated`, status: "ready", purpose: "generated" }).returning(); return file;
} }));
let handle: Awaited<ReturnType<typeof startTestDb>>, db: Database, a: Scope, b: Scope, bytes: Buffer;
const paper: Paper = { title: "Fractions", instructions: "Show working", warnings: [], coverage: [{ page: 1, purpose: "questions", questionIds: ["q1"] }], questions: [{ id: "q1", number: "1", text: "Simplify 2/4", topic: "Fractions", maxMarks: 2, rubric: "1 mark cancellation, 1 mark 1/2", sourcePage: 1, sourcePages: [1], needsVisual: false, answerLines: 3, blocks: [{ kind: "text", text: "Simplify \\(\\frac{2}{4}\\)." }] }] };
beforeAll(async () => { handle = await startTestDb(); db = handle.db as unknown as Database; const pdf = await PDFDocument.create(); pdf.addPage(); bytes = Buffer.from(await pdf.save()); });
afterAll(async () => { if (handle) await stopTestDb(handle); });
beforeEach(async () => {
  vi.clearAllMocks(); mock.bytes.clear();
  await db.execute(sql`TRUNCATE pt_series, pt_papers, pt_files, pt_jobs, tutor_contacts, admin_users RESTART IDENTITY CASCADE`);
  await db.insert(s.tutorContacts).values([{ canonicalKey: "a", displayName: "A", onsiteEmail: "a@example.test", active: true }, { canonicalKey: "b", displayName: "B", onsiteEmail: "b@example.test", active: true }]);
  a = await scopeForEmail("a@example.test", db); b = await scopeForEmail("b@example.test", db);
  mock.format.mockResolvedValue({ data: paper, model: "gpt-6-astra", responseId: "response", promptVersion: "test" }); mock.paper.mockResolvedValue(bytes); mock.key.mockResolvedValue(bytes);
});
async function source(ownerKey = "a") {
  const id = randomUUID(); mock.bytes.set(id, bytes);
  await db.insert(s.ptFiles).values({ id, ownerKey, name: "paper.pdf", mime: "application/pdf", size: bytes.length, pageCount: 1, sha256: createHash("sha256").update(bytes).digest("hex"), pathname: `progress-tests/${id}/source`, status: "ready", purpose: "paper" });
  return id;
}
async function start() {
  const created = await executeCommand(a, { action: "create-paper", title: "Draft" }, db);
  const sourceFileId = await source();
  await executeCommand(a, { action: "attach-original", id: created.id!, expectedRevision: 0, sourceFileId, keyFileId: null }, db);
  const command = { action: "format-paper" as const, id: created.id!, expectedRevision: 1, sourceFileId, keyFileId: null };
  const result = await executeCommand(a, command, db); return { command, result };
}
describe("durable upload-to-PDF pipeline", () => {
  it("deduplicates double clicks, binds two previews to one immutable version, and approval preserves that version", async () => {
    const { command, result } = await start();
    expect((await executeCommand(a, command, db)).jobId).toBe(result.jobId);
    await runJob((await claimJob(db, undefined, result.jobId))!, db);
    const detail = await paperDetail(a, command.id, db);
    expect(detail.versions).toHaveLength(2); expect(detail.artifacts.map(x => x.kind).sort()).toEqual(["key", "paper", "paper"]);
    const approval = { action: "approve-paper" as const, id: command.id, expectedRevision: 2, versionId: detail.versions[0].id, confirmed: true as const };
    await executeCommand(a, approval, db); await executeCommand(a, approval, db);
    const approved = await paperDetail(a, command.id, db);
    expect(approved.versions[0].approved).toBe(true); expect(approved.versions[0].id).toBe(detail.versions[0].id); expect(approved.artifacts).toEqual(detail.artifacts);
    expect(await db.select().from(s.ptPaperApprovals)).toHaveLength(1);
    expect((await paperVersionForOwner(approval.versionId, "a", db)).approved).toBe(true);
    const [job] = await db.select().from(s.ptJobs).where(eq(s.ptJobs.id, result.jobId!));
    expect(job.status).toBe("completed"); expect(job.stage).toBe("ready"); expect((await jobProgress(job, a, db)).artifact?.fileId).toBeTruthy();
  });
  it("resumes only the unfinished PDF after partial failure without repeating multimodal extraction", async () => {
    const { command, result } = await start(); mock.key.mockRejectedValueOnce(new Error("Renderer interrupted"));
    await runJob((await claimJob(db, undefined, result.jobId))!, db);
    const partial = await paperDetail(a, command.id, db); expect(partial.artifacts).toHaveLength(2);
    await executeCommand(a, { action: "approve-paper", id: command.id, expectedRevision: 2, versionId: partial.versions[0].id, confirmed: true }, db);
    await expect(executeCommand(a, { action: "approve-rubric", id: command.id, expectedRevision: 2, versionId: partial.versions[0].id, confirmed: true }, db)).rejects.toMatchObject({ status: 409 });
    await runJob((await claimJob(db, new Date(Date.now() + 65_000), result.jobId))!, db);
    expect(mock.format).toHaveBeenCalledTimes(1); expect(mock.paper).toHaveBeenCalledTimes(1); expect(mock.key).toHaveBeenCalledTimes(2);
    expect((await paperDetail(a, command.id, db)).artifacts).toHaveLength(3);
  });
  it("retains a completed version even when a newer parent revision appears", async () => {
    const { command, result } = await start(); await db.update(s.ptPapers).set({ revision: 3 }).where(eq(s.ptPapers.id, command.id));
    await runJob((await claimJob(db, undefined, result.jobId))!, db);
    const detail = await paperDetail(a, command.id, db);
    expect(detail.artifacts).toHaveLength(3); expect(detail.revision).toBe(3); expect(detail.versions[0].revision).toBe(2);
  });
  it("recovers an expired lease without permanently superseding the requested paper", async () => {
    const { result } = await start(); const job = (await claimJob(db, undefined, result.jobId))!;
    await db.update(s.ptJobs).set({ leaseUntil: new Date(Date.now() - 1000) }).where(eq(s.ptJobs.id, job.id));
    await runJob(job, db);
    const [interrupted] = await db.select().from(s.ptJobs).where(eq(s.ptJobs.id, job.id));
    expect(interrupted.status).toBe("queued"); expect(mock.format).not.toHaveBeenCalled();
    await runJob((await claimJob(db, new Date(Date.now() + 65_000), job.id))!, db);
    expect((await db.select().from(s.ptJobs).where(eq(s.ptJobs.id, job.id)))[0].status).toBe("completed");
    expect(mock.format).toHaveBeenCalledTimes(1);
  });
  it("dispatches the requested job and freshly denies revoked owners before processing", async () => {
    const first = await start(), second = await start();
    const job = await claimJob(db, undefined, second.result.jobId); expect(job?.id).toBe(second.result.jobId);
    await db.update(s.tutorContacts).set({ active: false }).where(eq(s.tutorContacts.canonicalKey, "a"));
    await runJob(job!, db); expect(mock.format).not.toHaveBeenCalled();
    const [denied] = await db.select().from(s.ptJobs).where(eq(s.ptJobs.id, job!.id)); expect(denied.status).toBe("failed");
    expect((await db.select().from(s.ptJobs).where(eq(s.ptJobs.id, first.result.jobId!)))[0].status).toBe("queued");
  });
  it("derives inline ownership from the assessment and rejects cross-tutor files and guessed IDs", async () => {
    const [series] = await db.insert(s.ptSeries).values({ ownerKey: "b", wiseClassId: "course", wiseStudentId: "student", studentName: "Student", courseName: "Maths", tutorName: "B", classType: "ONE_TO_ONE" }).returning();
    const [assessment] = await db.insert(s.ptAssessments).values({ seriesId: series.id, cycle: 1 }).returning();
    await db.insert(s.adminUsers).values({ email: "admin@example.test" }); const admin = await scopeForEmail("admin@example.test", db);
    const created = await executeCommand(admin, { action: "create-paper", title: "Inline", assessmentId: assessment.id }, db);
    expect((await paperDetail(b, created.id!, db)).ownerKey).toBe("b");
    await expect(paperDetail(a, created.id!, db)).rejects.toMatchObject({ status: 404 });
    await expect(getAssessment(a, assessment.id, db)).rejects.toMatchObject({ status: 404 });
    await expect(executeCommand(admin, { action: "upload-intent", assessmentId: assessment.id, ownerKey: "a", name: "paper.pdf", purpose: "paper", mime: "application/pdf", size: 10 }, db)).rejects.toMatchObject({ status: 404 });
    await expect(executeCommand(b, { action: "format-paper", id: created.id!, expectedRevision: 0, sourceFileId: await source("a"), keyFileId: null }, db)).rejects.toMatchObject({ status: 400 });
  });
  it("blocks readiness for missing coverage even when the renderer produces a preview", async () => {
    mock.format.mockResolvedValueOnce({ data: { ...paper, coverage: [] }, model: "gpt-6-astra" });
    const { command, result } = await start(); await runJob((await claimJob(db, undefined, result.jobId))!, db);
    const detail = await paperDetail(a, command.id, db); expect(structuredPaper(detail.versions[0].paper).warnings.length).toBeGreaterThan(0);
    await expect(executeCommand(a, { action: "approve-paper", id: command.id, expectedRevision: 2, versionId: detail.versions[0].id, confirmed: true }, db)).rejects.toMatchObject({ status: 400 });
  });
});
