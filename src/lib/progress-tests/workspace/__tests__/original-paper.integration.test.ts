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
import { fileForScope } from "../files";
import { runPublication } from "../publication";
import { WorkspaceError, isUploadedReview, type Paper } from "../model";
import type { NativeWise, WiseSection } from "../wise-publication";
import type { Command } from "../commands";
const mock = vi.hoisted(() => ({ bytes: new Map<string, Buffer>(), format: vi.fn(), convert: vi.fn(), render: vi.fn(), report: vi.fn() }));
vi.mock("../ai", async original => ({ ...await original<typeof import("../ai")>(), formatPaper: mock.format }));
vi.mock("../documents", async original => ({ ...await original<typeof import("../documents")>(), convertDocx: mock.convert, renderProgressReport: mock.report }));
vi.mock("../paper-renderer", () => ({ PAPER_RENDERER_VERSION: "fixture-v4", renderFormattedPaper: mock.render, renderMarkingScheme: mock.render }));
vi.mock("../files", async original => ({ ...await original<typeof import("../files")>(), readBlobBytes: async (file: { id: string }) => mock.bytes.get(file.id)!, storeGenerated: async (ownerKey: string, name: string, bytes: Buffer, db: Database) => {
  const id = randomUUID(); mock.bytes.set(id, bytes);
  return (await db.insert(s.ptFiles).values({ id, ownerKey, name, mime: "application/pdf", size: bytes.length, pageCount: 1, sha256: hash(bytes), pathname: `progress-tests/${id}/generated`, status: "ready", purpose: "generated" }).returning())[0];
} }));
const hash = (bytes: Buffer) => createHash("sha256").update(bytes).digest("hex");
let handle: Awaited<ReturnType<typeof startTestDb>>, db: Database, a: Scope, b: Scope, pdf: Buffer;
const content: Paper = { title: "Algebra", instructions: "Show working", warnings: [], coverage: [{ page: 1, purpose: "questions", questionIds: ["q1"] }], questions: [{ id: "q1", number: "1", text: "Solve x+1=2", topic: "Algebra", maxMarks: 2, rubric: "Subtract 1", sourcePage: 1, sourcePages: [1], needsVisual: false, blocks: [{ kind: "text", text: "Solve x+1=2" }], answerLines: 4 }] };
const report = { summary: "Technical fixture review", strengths: ["Method"], focusAreas: ["Checking"], nextSteps: ["Practise checking"], contextLimitations: "No verified class feedback was available." };
beforeAll(async () => { handle = await startTestDb(); db = handle.db as unknown as Database; const document = await PDFDocument.create(); document.addPage(); pdf = Buffer.from(await document.save()); });
afterAll(async () => { if (handle) await stopTestDb(handle); vi.unstubAllEnvs(); });
beforeEach(async () => {
  vi.clearAllMocks(); mock.bytes.clear();
  await db.execute(sql`TRUNCATE pt_workspace_config, pt_series, pt_papers, pt_files, pt_jobs, pt_wise_destinations, tutor_contacts, admin_users RESTART IDENTITY CASCADE`);
  await db.insert(s.tutorContacts).values([{ canonicalKey: "a", displayName: "A", onsiteEmail: "a@example.test", active: true }, { canonicalKey: "b", displayName: "B", onsiteEmail: "b@example.test", active: true }]);
  a = await scopeForEmail("a@example.test", db); b = await scopeForEmail("b@example.test", db);
  await db.update(s.ptWorkspaceSettings).set({ publishingEnabled: true, formattingEnabled: true, verifiedAt: new Date() });
  vi.stubEnv("BLOB_READ_WRITE_TOKEN", "fixture"); vi.stubEnv("WISE_USER_ID", "fixture"); vi.stubEnv("WISE_API_KEY", "fixture"); vi.stubEnv("OPENAI_API_KEY", ""); vi.stubEnv("OPENAI_PROGRESS_TEST_API_KEY", "");
  vi.stubEnv("OPENAI_PROGRESS_TEST_FORMAT_MODEL", "gpt-6-astra"); vi.stubEnv("OPENAI_PROGRESS_TEST_FORMAT_EFFORT", "low");
  mock.format.mockResolvedValue({ data: content, model: "gpt-6-astra", promptVersion: "fixture", responseId: "fixture-response" }); mock.render.mockResolvedValue(pdf); mock.convert.mockResolvedValue(pdf); mock.report.mockResolvedValue(pdf);
});
async function file(purpose = "paper", ownerKey = "a", assessmentId?: string, mime = "application/pdf") {
  const id = randomUUID(); const bytes = mime === "application/pdf" ? pdf : Buffer.from("fixture DOCX bytes"); mock.bytes.set(id, bytes);
  await db.insert(s.ptFiles).values({ id, ownerKey, assessmentId, name: "Fixture", mime, size: bytes.length, pageCount: mime === "application/pdf" ? 1 : null, sha256: hash(bytes), pathname: `progress-tests/${id}/source`, status: "ready", purpose });
  return id;
}
async function original(assessmentId?: string, mime?: string) {
  const p = await executeCommand(a, { action: "create-paper", title: "Original", assessmentId }, db);
  const sourceFileId = await file("paper", "a", undefined, mime);
  const attached = await executeCommand(a, { action: "attach-original", id: p.id!, expectedRevision: 0, sourceFileId, keyFileId: null }, db);
  return { id: p.id!, sourceFileId, ...attached };
}
async function run(id: string) { const job = await claimJob(db, undefined, id); expect(job).toBeTruthy(); await runJob(job!, db); }
async function ready(p: Awaited<ReturnType<typeof original>>) {
  const detail = await paperDetail(a, p.id!, db);
  return executeCommand(a, { action: "approve-paper", id: p.id!, expectedRevision: detail.revision, versionId: p.versionId!, confirmed: true }, db);
}
async function assessment() {
  const [series] = await db.insert(s.ptSeries).values({ ownerKey: "a", wiseClassId: randomUUID(), wiseStudentId: "student", studentName: "Student", courseName: "Maths", tutorName: "A", classType: "ONE_TO_ONE", count: 16, sessionIds: Array.from({ length: 16 }, (_, i) => "session" + (i + 1)) }).returning();
  return (await db.insert(s.ptAssessments).values({ seriesId: series.id, cycle: 1 }).returning())[0];
}
async function act(id: string, values: Record<string, unknown>) {
  const { assessment } = await getAssessment(a, id, db);
  return executeCommand(a, { ...values, id, expectedRevision: assessment.revision } as Command, db);
}
async function submitted() {
  const target = await assessment(), p = await original(target.id); await ready(p);
  await act(target.id, { action: "prepare", paperVersionId: p.versionId, topics: "Algebra", studentInformed: true });
  await act(target.id, { action: "submit", sessionId: "session9", fileIds: [await file("work", "a", target.id)] });
  return { target, p };
}
describe("original papers and uploaded marked reviews", () => {
  it("makes the exact uploaded PDF ready without AI, questions, rubric or a key", async () => {
    const p = await original(); await ready(p);
    const detail = await paperDetail(a, p.id!, db);
    expect(detail.versions[0].paper).toEqual({ kind: "original", title: "Original" });
    expect(detail.versions[0].approved).toBe(true); expect(detail.versions[0].rubricApproved).toBe(false);
    expect(detail.artifacts[0].fileId).toBe(p.sourceFileId);
    expect(hash(mock.bytes.get(detail.artifacts[0].fileId)!)).toBe(hash(pdf));
    expect(await db.select().from(s.ptJobs)).toHaveLength(0); expect(mock.format).not.toHaveBeenCalled();
    await expect(fileForScope(b, p.sourceFileId, db)).rejects.toMatchObject({ status: 404 });
    await expect(db.delete(s.ptPaperApprovals)).rejects.toThrow();
    await expect(db.update(s.ptFiles).set({ name: "Changed metadata" }).where(eq(s.ptFiles.id, p.sourceFileId))).rejects.toThrow();
  });
  it("keeps originals usable and replaceable while beta runs, and never adopts its result", async () => {
    const p = await original();
    const beta = await executeCommand(a, { action: "format-paper", id: p.id!, expectedRevision: 1, sourceFileId: p.sourceFileId, keyFileId: null }, db);
    await ready(p);
    const replacement = await executeCommand(a, { action: "attach-original", id: p.id!, expectedRevision: 2, sourceFileId: await file(), keyFileId: null }, db);
    await run(beta.jobId!);
    const detail = await paperDetail(a, p.id!, db);
    expect(detail.versions[0].id).toBe(replacement.versionId);
    const formatted = detail.versions.find(v => v.id === beta.versionId)!;
    expect(formatted.approved).toBe(false); expect(formatted.sourceVersionId).toBe(p.versionId);
    expect((await paperVersionForOwner(p.versionId!, "a", db)).approved).toBe(true);
    expect(mock.format.mock.calls[0].slice(2, 4)).toEqual(["gpt-6-astra", "low"]);
  });
  it("requires a saved source version and freezes its exact formatting prompt and settings", async () => {
    const created = await executeCommand(a, { action: "create-paper", title: "Source binding" }, db), sourceFileId = await file();
    await expect(executeCommand(a, { action: "format-paper", id: created.id!, expectedRevision: 0, sourceFileId, keyFileId: null }, db)).rejects.toMatchObject({ status: 409 });
    const original = await executeCommand(a, { action: "attach-original", id: created.id!, expectedRevision: 0, sourceFileId, keyFileId: null }, db);
    const queued = await executeCommand(a, { action: "format-paper", id: created.id!, expectedRevision: 1, sourceFileId, keyFileId: null }, db);
    const [job] = await db.select().from(s.ptJobs).where(eq(s.ptJobs.id, queued.jobId!));
    expect(job.input).toMatchObject({ sourceVersionId: original.versionId, sourceHash: hash(pdf), model: "gpt-6-astra", reasoningEffort: "low", formatPrompt: expect.stringContaining("subpart") });
    vi.stubEnv("OPENAI_PROGRESS_TEST_FORMAT_MODEL", "changed-after-queue"); vi.stubEnv("OPENAI_PROGRESS_TEST_FORMAT_EFFORT", "high");
    await run(queued.jobId!);
    expect(mock.format.mock.calls[0].slice(2)).toEqual(["gpt-6-astra", "low", job.input.formatPrompt]);
  });
  it("persists successful extraction if formatting is paused during the request", async () => {
    const p = await original(), queued = await executeCommand(a, { action: "format-paper", id: p.id!, expectedRevision: 1, sourceFileId: p.sourceFileId, keyFileId: null }, db);
    mock.format.mockImplementationOnce(async () => {
      await db.update(s.ptWorkspaceSettings).set({ formattingEnabled: false });
      return { data: content, model: "gpt-6-astra", responseId: "saved-before-pause" };
    });
    await run(queued.jobId!);
    expect((await paperDetail(a, p.id!, db)).versions.some(v => v.id === queued.versionId)).toBe(true);
    await db.update(s.ptWorkspaceSettings).set({ formattingEnabled: true });
    const job = await claimJob(db, new Date(Date.now() + 10_000), queued.jobId); await runJob(job!, db);
    expect(mock.format).toHaveBeenCalledTimes(1); expect((await paperDetail(a, p.id!, db)).artifacts).toHaveLength(3);
  });
  it("keeps a correction intact when an older render job finishes", async () => {
    const { target } = await submitted(), markedFileId = await file("marked", "a", target.id);
    await act(target.id, { action: "save-marked-review", markedFileId, earned: 4, possible: 5, report });
    const queued = await act(target.id, { action: "preview-review" });
    await act(target.id, { action: "save-marked-review", markedFileId, earned: 5, possible: 5, report });
    const correction = (await getAssessment(a, target.id, db)).assessment.currentReviewId;
    await run(queued.jobId!);
    expect((await getAssessment(a, target.id, db)).assessment.currentReviewId).toBe(correction);
    expect((await db.select().from(s.ptJobs).where(eq(s.ptJobs.id, queued.jobId!)))[0].status).toBe("superseded");
  });
  it("converts DOCX independently and preserves actionable conversion failures", async () => {
    const p = await original(undefined, "application/vnd.openxmlformats-officedocument.wordprocessingml.document");
    await expect(ready(p)).rejects.toMatchObject({ status: 409 });
    mock.convert.mockRejectedValueOnce(new WorkspaceError(400, "Export the unsupported equation from Word as PDF."));
    await run(p.jobId!); expect((await db.select().from(s.ptJobs))[0].status).toBe("failed");
    const retry = await executeCommand(a, { action: "retry-job", id: p.jobId! }, db); await run(retry.jobId!); await ready(p);
    expect((await paperDetail(a, p.id!, db)).artifacts).toHaveLength(1); expect(mock.format).not.toHaveBeenCalled();
  });
  it("requires explicit retry after AI failure while keeping the original ready", async () => {
    const p = await original();
    const job = await executeCommand(a, { action: "format-paper", id: p.id!, expectedRevision: 1, sourceFileId: p.sourceFileId, keyFileId: null }, db);
    mock.format.mockRejectedValueOnce(new WorkspaceError(400, "Formatting timed out. Retry explicitly."));
    await run(job.jobId!); await ready(p);
    expect((await db.select().from(s.ptJobs))[0].status).toBe("failed"); expect(await claimJob(db, new Date(Date.now() + 600_000), job.jobId)).toBeNull();
    const retry = await executeCommand(a, { action: "retry-job", id: job.jobId! }, db); await run(retry.jobId!);
    expect(mock.format).toHaveBeenCalledTimes(2);
  });
  it("defers extraction when the worker budget is insufficient and honors independent formatting pause", async () => {
    const p = await original();
    const result = await executeCommand(a, { action: "format-paper", id: p.id!, expectedRevision: 1, sourceFileId: p.sourceFileId, keyFileId: null }, db);
    const job = (await claimJob(db, undefined, result.jobId))!;
    await runJob(job, db, Date.now() + 100_000);
    expect(mock.format).not.toHaveBeenCalled(); expect((await db.select().from(s.ptJobs))[0].status).toBe("queued");
    await db.update(s.ptWorkspaceSettings).set({ formattingEnabled: false });
    expect(await claimJob(db, new Date(Date.now() + 10_000), result.jobId)).toBeNull(); await ready(p);
    await expect(executeCommand(a, { action: "format-paper", id: p.id!, expectedRevision: 2, sourceFileId: p.sourceFileId, keyFileId: null }, db)).rejects.toMatchObject({ status: 409 });
    expect((await db.select().from(s.ptWorkspaceSettings))[0].publishingEnabled).toBe(true);
  });
  it("separates branded-paper readiness from approval of a complete private rubric", async () => {
    const p = await original();
    const job = await executeCommand(a, { action: "format-paper", id: p.id!, expectedRevision: 1, sourceFileId: p.sourceFileId, keyFileId: null }, db); await run(job.jobId!);
    await executeCommand(a, { action: "approve-paper", id: p.id!, expectedRevision: 2, versionId: job.versionId!, confirmed: true }, db);
    expect((await paperVersionForOwner(job.versionId!, "a", db)).rubricApproved).toBe(false);
    await executeCommand(a, { action: "approve-rubric", id: p.id!, expectedRevision: 2, versionId: job.versionId!, confirmed: true }, db);
    expect((await paperVersionForOwner(job.versionId!, "a", db)).rubricApproved).toBe(true);
  });
  it("rejects cross-assessment and wrong-purpose marked PDFs and invalid scores", async () => {
    const { target } = await submitted(), other = await assessment();
    for (const markedFileId of [await file("work", "a", target.id), await file("marked", "a", other.id), await file("marked", "b", target.id)])
      await expect(act(target.id, { action: "save-marked-review", markedFileId, earned: 4, possible: 5, report })).rejects.toMatchObject({ status: 400 });
    const markedFileId = await file("marked", "a", target.id);
    await expect(act(target.id, { action: "save-marked-review", markedFileId, earned: 6, possible: 5, report })).rejects.toMatchObject({ status: 400 });
    await expect(act(target.id, { action: "grade" })).rejects.toMatchObject({ status: 409 });
    await expect(executeCommand(a, { action: "upload-intent", purpose: "marked", mime: "image/png", name: "x", size: 10, assessmentId: target.id }, db)).rejects.toMatchObject({ status: 400 });
  });
  it("publishes only the exact reviewed marked PDF and report and preserves fixed cadence and launch", async () => {
    const launch = new Date("2026-09-13T11:36:37.162Z"); await db.insert(s.ptWorkspaceConfig).values({ id: "launch", activatedAt: launch, activatedBy: "fixture" });
    const { target } = await submitted(); const markedFileId = await file("marked", "a", target.id);
    await act(target.id, { action: "save-marked-review", markedFileId, earned: 4.5, possible: 8, report });
    const preview = await act(target.id, { action: "preview-review" }); await run(preview.jobId!);
    const approved = await act(target.id, { action: "approve", confirmed: true });
    const publicationFiles = await db.select().from(s.ptPublicationFiles);
    expect(publicationFiles.map(f => f.kind).sort()).toEqual(["graded", "report"]);
    const graded = publicationFiles.find(f => f.kind === "graded")!;
    expect(graded.sha256).toBe(hash(mock.bytes.get(markedFileId)!)); expect(graded.fileId).not.toBe(markedFileId);
    const sections: WiseSection[] = [];
    const wise: NativeWise = { verifyCourse: vi.fn().mockResolvedValue(undefined), timeline: vi.fn(async () => structuredClone(sections)), createSection: vi.fn(async () => { sections.push({ _id: "section", name: "Progress Tests", enabled: true, entities: [] }); return "section"; }), upload: vi.fn().mockResolvedValue("private-token"), attach: vi.fn(async (classId, sectionId, name) => { sections[0].entities.push({ _id: randomUUID(), name, classId, type: "file", file: { _id: randomUUID(), path: "https://files.wiseapp.live/test", type: "pdf", size: pdf.length } }); }), verifyFile: vi.fn().mockResolvedValue(undefined) };
    const job = (await claimJob(db, undefined, approved.jobId))!;
    await runPublication(job, db, wise); await runPublication(job, db, wise);
    expect(wise.attach).toHaveBeenCalledTimes(2); expect((await db.select().from(s.ptPublications))[0].status).toBe("published");
    const oldReviewId = (await getAssessment(a, target.id, db)).assessment.approvedReviewId;
    const correction = await act(target.id, { action: "save-marked-review", markedFileId, earned: 5, possible: 8, report });
    expect(correction.revision).toBeGreaterThan(0);
    const [old] = await db.select().from(s.ptReviews).where(eq(s.ptReviews.id, oldReviewId!));
    expect(isUploadedReview(old.data) && old.data.earned).toBe(4.5); expect(old.approved).toBe(true);
    expect((await db.select().from(s.ptSeries))[0].count).toBe(16); expect((await db.select().from(s.ptWorkspaceConfig))[0].activatedAt).toEqual(launch);
  });
});
