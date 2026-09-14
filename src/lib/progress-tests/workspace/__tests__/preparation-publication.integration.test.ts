import { beforeAll, beforeEach, afterAll, describe, it, expect, vi } from "vitest";
import { eq, sql } from "drizzle-orm";
import { startTestDb, stopTestDb } from "@/tests/integration/db-helper";
import * as s from "@/lib/db/schema";
import type { Database } from "@/lib/db";
import { scopeForEmail } from "../access";
import { executeCommand, getAssessment, assessmentDetail } from "../data";
import { claimJob } from "../jobs";
import { latestPreparation, runPreparationPublication } from "../preparation-publication";
import { fileHash, type NativeWise, type WiseSection } from "../wise-publication";
vi.mock("../files", async () => ({ ...await vi.importActual("../files"), readBlobBytes: vi.fn(async (f: { name: string }) => Buffer.from(f.name)) }));
let handle: Awaited<ReturnType<typeof startTestDb>>, db: Database;
beforeAll(async () => { handle = await startTestDb(); db = handle.db as unknown as Database; });
afterAll(async () => { await stopTestDb(handle); vi.unstubAllEnvs(); });
beforeEach(async () => {
  await db.execute(sql`TRUNCATE pt_series, pt_files, pt_jobs, pt_papers, pt_wise_destinations, tutor_contacts, admin_users RESTART IDENTITY CASCADE`);
  await db.insert(s.tutorContacts).values({ canonicalKey: "tutor", displayName: "Tutor", onsiteEmail: "tutor@example.test", active: true });
  await db.update(s.ptWorkspaceSettings).set({ publishingEnabled: true, verifiedAt: new Date() });
  vi.stubEnv("BLOB_READ_WRITE_TOKEN", "test"); vi.stubEnv("WISE_USER_ID", "test"); vi.stubEnv("WISE_API_KEY", "test");
});
async function setup() {
  const scope = await scopeForEmail("tutor@example.test", db);
  const [series] = await db.insert(s.ptSeries).values({ ownerKey: "tutor", wiseClassId: "course", wiseStudentId: "student", studentName: "Student", courseName: "Maths", tutorName: "Tutor", classType: "ONE_TO_ONE" }).returning();
  const [assessment] = await db.insert(s.ptAssessments).values({ seriesId: series.id, cycle: 1 }).returning();
  async function paper(title: string, original = false, purpose = original ? "paper" : "generated") {
    const [record] = await db.insert(s.ptPapers).values({ ownerKey: "tutor", title, revision: 1 }).returning();
    const [file] = await db.insert(s.ptFiles).values({ ownerKey: "tutor", name: title, mime: "application/pdf", size: Buffer.byteLength(title), pathname: crypto.randomUUID(), purpose, status: "ready", sha256: fileHash(Buffer.from(title)) }).returning();
    const [version] = await db.insert(s.ptPaperVersions).values({ paperId: record.id, revision: 1, approved: !original, createdBy: scope.user.email, paper: { title, instructions: "Answer.", warnings: [], questions: [{ id: "q", text: "2 + 2?", topic: "Maths", maxMarks: 1, rubric: "4", sourcePage: null, needsVisual: false }] } }).returning();
    if (original) await db.insert(s.ptPaperApprovals).values({ versionId: version.id, createdBy: scope.user.email });
    await db.insert(s.ptPaperArtifacts).values({ versionId: version.id, kind: "paper", fileId: file.id, rendererVersion: "test" });
    return { version, file };
  }
  const first = await paper("original.pdf", true), second = await paper("replacement.pdf");
  const sections: WiseSection[] = [{ _id: "section", name: "Progress Tests", enabled: true, entities: [{ _id: "unrelated", name: "Existing teacher resource", type: "file", classId: "course" }] }];
  const uploads = new Map<string, Buffer>(); let sequence = 0;
  const wise: NativeWise = {
    verifyCourse: vi.fn().mockResolvedValue(undefined), timeline: vi.fn(async () => structuredClone(sections)), createSection: vi.fn().mockResolvedValue("section"),
    upload: vi.fn(async (name, bytes) => { uploads.set(name, bytes); return name; }),
    attach: vi.fn(async (classId, _section, name) => { sections[0].entities.push({ _id: `resource-${++sequence}`, name, classId, type: "file", file: { _id: `file-${sequence}`, path: "https://files.wiseapp.live/test", type: "pdf", size: 1 } }); }),
    verifyFile: vi.fn(async (remote, hash) => { expect(fileHash(uploads.get(remote.name)!)).toBe(hash); }),
    remove: vi.fn(async (_class, _section, id) => { sections[0].entities = sections[0].entities.filter(r => r._id !== id); }),
  };
  const assessmentNow = async () => (await getAssessment(scope, assessment.id, db)).assessment;
  const prepare = async (versionId = first.version.id) => executeCommand(scope, { action: "prepare", id: assessment.id, expectedRevision: (await assessmentNow()).revision, paperVersionId: versionId, topics: "Revision topics", studentInformed: true }, db);
  const remove = async () => executeCommand(scope, { action: "remove-preparation-paper", id: assessment.id, expectedRevision: (await assessmentNow()).revision }, db);
  const run = async (jobId: string) => { const job = (await claimJob(db, undefined, jobId))!; await runPreparationPublication(job, db, wise); await db.update(s.ptJobs).set({ status: "completed" }).where(eq(s.ptJobs.id, jobId)); return job; };
  return { scope, series, assessment, first, second, sections, uploads, wise, assessmentNow, prepare, remove, run, paper };
}
describe("preparation paper publication", () => {
  it("uploads the exact approved original artifact once and exposes status separately from results", async () => {
    const x = await setup(), queued = await x.prepare(); await x.run(queued.jobId!);
    expect(x.wise.upload).toHaveBeenCalledTimes(1); expect([...x.uploads.values()][0]).toEqual(Buffer.from(x.first.file.name));
    expect((await x.prepare()).jobId).toBeUndefined(); expect(x.sections[0].entities).toHaveLength(2);
    const detail = await assessmentDetail(x.scope, x.assessment.id, db);
    expect(detail.preparationPublication?.status).toBe("published"); expect(detail.publications).toHaveLength(0);
  });
  it("verifies a formatted replacement before withdrawing only the previous preparation resource", async () => {
    const x = await setup(); await x.run((await x.prepare()).jobId!); const oldId = x.sections[0].entities[1]._id;
    await x.run((await x.prepare(x.second.version.id)).jobId!);
    expect(x.wise.remove).toHaveBeenCalledWith("course", "section", oldId);
    expect(x.sections[0].entities.map(r => r._id)).toEqual(["unrelated", "resource-2"]);
    expect(vi.mocked(x.wise.verifyFile).mock.invocationCallOrder.at(-2)!).toBeLessThan(vi.mocked(x.wise.remove).mock.invocationCallOrder[0]);
    expect((await db.select().from(s.ptPaperVersions))).toHaveLength(2);
  });
  it("removes the selected paper and Wise copy while preserving topics, library and history", async () => {
    const x = await setup(); await x.run((await x.prepare()).jobId!); await x.run((await x.remove()).jobId!);
    expect((await x.assessmentNow()).preparation).toEqual({ paperVersionId: null, topics: "Revision topics", studentInformed: false });
    expect(x.sections[0].entities.map(r => r._id)).toEqual(["unrelated"]); expect(await db.select().from(s.ptPapers)).toHaveLength(2);
    expect((await latestPreparation(x.assessment.id, db))?.status).toBe("removed");
    await expect(db.delete(s.ptPreparationPublications)).rejects.toThrow();
  });
  it("reconciles a lost successful attachment response without a second POST", async () => {
    const x = await setup(), q = await x.prepare(), job = (await claimJob(db, undefined, q.jobId))!;
    const attach = x.wise.attach; x.wise.attach = vi.fn(async (...args: Parameters<NativeWise["attach"]>) => { await attach(...args); throw new Error("Lost reply"); });
    await expect(runPreparationPublication(job, db, x.wise)).rejects.toThrow();
    await runPreparationPublication(job, db, x.wise); expect(attach).toHaveBeenCalledTimes(1);
  });
  it("does not repeat an uncertain attachment with no readback evidence", async () => {
    const x = await setup(), q = await x.prepare(), job = (await claimJob(db, undefined, q.jobId))!;
    x.wise.attach = vi.fn().mockRejectedValue(new Error("Lost reply"));
    await expect(runPreparationPublication(job, db, x.wise)).rejects.toThrow(); await expect(runPreparationPublication(job, db, x.wise)).rejects.toMatchObject({ status: 422 });
    expect(x.wise.attach).toHaveBeenCalledTimes(1); await expect(x.remove()).rejects.toMatchObject({ status: 409 });
  });
  it("preserves the old attachment when replacement upload fails and resumes safely", async () => {
    const x = await setup(); await x.run((await x.prepare()).jobId!); const q = await x.prepare(x.second.version.id), job = (await claimJob(db, undefined, q.jobId))!;
    vi.mocked(x.wise.upload).mockRejectedValueOnce(new Error("Expired upload URL"));
    await expect(runPreparationPublication(job, db, x.wise)).rejects.toThrow(); expect(x.wise.remove).not.toHaveBeenCalled(); expect(x.sections[0].entities).toHaveLength(2);
    await runPreparationPublication(job, db, x.wise); expect(x.sections[0].entities).toHaveLength(2); expect(x.wise.remove).toHaveBeenCalledTimes(1);
  });
  it("reconciles a lost deletion response without reuploading or deleting twice", async () => {
    const x = await setup(); await x.run((await x.prepare()).jobId!); const q = await x.prepare(x.second.version.id), job = (await claimJob(db, undefined, q.jobId))!;
    const remove = x.wise.remove; x.wise.remove = vi.fn(async (...args: Parameters<NativeWise["remove"]>) => { await remove(...args); throw new Error("Lost deletion reply"); });
    await expect(runPreparationPublication(job, db, x.wise)).rejects.toThrow(); await runPreparationPublication(job, db, x.wise);
    expect(remove).toHaveBeenCalledTimes(1); expect(x.wise.attach).toHaveBeenCalledTimes(2);
  });
  it("cancels an untouched paused upload on removal and never publishes the cancelled job", async () => {
    const x = await setup(), q = await x.prepare(); await db.update(s.ptWorkspaceSettings).set({ publishingEnabled: false });
    expect(await claimJob(db)).toBeNull(); expect((await x.remove()).jobId).toBeUndefined();
    await db.update(s.ptWorkspaceSettings).set({ publishingEnabled: true }); expect(await claimJob(db, undefined, q.jobId)).toBeNull(); expect(x.wise.attach).not.toHaveBeenCalled();
  });
  it("allows submission during a publishing pause, locks the paper and finishes its queued upload", async () => {
    const x = await setup(), queued = await x.prepare();
    await db.update(s.ptWorkspaceSettings).set({ publishingEnabled: false });
    await db.update(s.ptSeries).set({ count: 8, sessionIds: ["class-8"] }).where(eq(s.ptSeries.id, x.series.id));
    const [file] = await db.insert(s.ptFiles).values({ ownerKey: "tutor", assessmentId: x.assessment.id, name: "work.pdf", mime: "application/pdf", size: 1, pageCount: 1, pathname: crypto.randomUUID(), purpose: "work", status: "ready" }).returning();
    await executeCommand(x.scope, { action: "submit", id: x.assessment.id, expectedRevision: (await x.assessmentNow()).revision, sessionId: "class-8", fileIds: [file.id] }, db);
    expect((await x.assessmentNow()).currentSubmissionId).toBeTruthy();
    await expect(x.remove()).rejects.toMatchObject({ status: 409 });
    await expect(x.prepare(x.second.version.id)).rejects.toMatchObject({ status: 409 });
    await db.update(s.ptWorkspaceSettings).set({ publishingEnabled: true });
    await x.run(queued.jobId!); expect((await latestPreparation(x.assessment.id, db))?.status).toBe("published");
  });
  it("rejects overlapping replacement/removal and stale revisions", async () => {
    const x = await setup(), q = await x.prepare(); await claimJob(db, undefined, q.jobId);
    await expect(x.remove()).rejects.toMatchObject({ status: 409 }); await expect(x.prepare(x.second.version.id)).rejects.toMatchObject({ status: 409 });
    await expect(executeCommand(x.scope, { action: "remove-preparation-paper", id: x.assessment.id, expectedRevision: 0 }, db)).rejects.toMatchObject({ status: 409 });
  });
  it("blocks revoked ownership and rejects marking-key artifacts", async () => {
    const x = await setup(), key = await x.paper("private marking key.pdf", false, "key");
    await expect(x.prepare(key.version.id)).rejects.toMatchObject({ status: 409 });
    const q = await x.prepare(), job = (await claimJob(db, undefined, q.jobId))!; await db.update(s.tutorContacts).set({ active: false });
    await expect(runPreparationPublication(job, db, x.wise)).rejects.toMatchObject({ status: 403 }); expect(x.wise.attach).not.toHaveBeenCalled();
  });
  it("stops before deleting the old paper if its replacement disappears during recovery", async () => {
    const x = await setup(); await x.run((await x.prepare()).jobId!); const q = await x.prepare(x.second.version.id), job = (await claimJob(db, undefined, q.jobId))!;
    vi.mocked(x.wise.remove).mockRejectedValueOnce(new Error("Temporary failure")); await expect(runPreparationPublication(job, db, x.wise)).rejects.toThrow();
    x.sections[0].entities = x.sections[0].entities.filter(r => r._id !== "resource-2");
    await expect(runPreparationPublication(job, db, x.wise)).rejects.toMatchObject({ status: 422 }); expect(x.sections[0].entities.some(r => r._id === "resource-1")).toBe(true);
  });
});
