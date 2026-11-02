import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { eq, sql } from "drizzle-orm";
import { startTestDb, stopTestDb } from "@/tests/integration/db-helper";
import { type Database } from "@/lib/db";
import * as s from "@/lib/db/schema";
import { del, get } from "@vercel/blob";
import { handleUpload } from "@vercel/blob/client";
import { assessmentUploadHandler, createFileIntent, finishFile } from "../assessment-files";

vi.mock("@vercel/blob", () => ({ get: vi.fn(), del: vi.fn(), list: vi.fn() }));
vi.mock("@vercel/blob/client", () => ({ handleUpload: vi.fn(), put: vi.fn() }));

let handle: Awaited<ReturnType<typeof startTestDb>>, db: Database;
const PDF = Buffer.from("%PDF-1.4 fixture");
const stored = (bytes: Buffer) =>
  vi.mocked(get).mockResolvedValue({
    statusCode: 200,
    blob: { size: bytes.length },
    stream: new Response(new Uint8Array(bytes)).body,
  } as never);
const library = (name: string) => ({ kind: "mark_scheme" as const, subject: "Mathematics" as const, candidateId: null, name, size: PDF.length });

beforeAll(async () => {
  handle = await startTestDb();
  db = handle.db as unknown as Database;
}, 120000);
afterAll(async () => {
  if (handle) await stopTestDb(handle);
});
beforeEach(async () => {
  vi.clearAllMocks();
  await db.execute(sql`truncate hiring_assessment_files, hiring_audit cascade`);
});

describe("assessment files", () => {
  it("refuses a file that is too large, empty, or with no owner", async () => {
    await expect(createFileIntent(library("a.pdf"), "o", db).then(() => createFileIntent({ ...library("a.pdf"), size: 26 * 1024 * 1024 }, "o", db))).rejects.toMatchObject({ status: 400 });
    await expect(createFileIntent({ ...library("a.pdf"), size: 0 }, "o", db)).rejects.toMatchObject({ status: 400 });
    await expect(createFileIntent({ ...library("a.pdf"), subject: null }, "o", db)).rejects.toThrow(/subject or a candidate/);
    await expect(createFileIntent({ kind: "paper_scan", subject: "Physics", candidateId: null, name: "a.pdf", size: 1 }, "o", db)).rejects.toThrow(/subject or a candidate/);
  });
  it("cleans the name, and gives the upload one fixed path", async () => {
    const { id, pathname } = await createFileIntent(library('../../"evil"\n.pdf'), "o", db);
    expect(pathname).toBe(`hiring-assessment/${id}.pdf`);
    const [row] = await db.select().from(s.hiringAssessmentFiles);
    expect(row.name).not.toMatch(/[/"\n]/);
    expect(row).toMatchObject({ status: "pending", active: false, uploadedBy: "o" });
  });
  it("gives a browser token only for the pending file and its own path", async () => {
    const { id, pathname } = await createFileIntent(library("a.pdf"), "o", db);
    assessmentUploadHandler(new Request("http://x"), {} as never, db);
    const { onBeforeGenerateToken } = vi.mocked(handleUpload).mock.calls[0][0];
    const options = await onBeforeGenerateToken(pathname, id, false);
    expect(options).toMatchObject({ allowedContentTypes: ["application/pdf"], maximumSizeInBytes: PDF.length, allowOverwrite: false });
    await expect(onBeforeGenerateToken("hiring-assessment/other.pdf", id, false)).rejects.toMatchObject({ status: 409 });
    await expect(onBeforeGenerateToken(pathname, "not-an-id", false)).rejects.toMatchObject({ status: 400 });
  });
  it("checks the stored bytes: a PDF type from the bytes, and the size chosen", async () => {
    const { id } = await createFileIntent(library("a.pdf"), "o", db);
    stored(Buffer.from("too long to match the size chosen"));
    await expect(finishFile(id, "o", db)).rejects.toThrow(/size differs/);
    const other = await createFileIntent({ ...library("b.pdf"), size: 16 }, "o", db);
    stored(Buffer.from("not a pdf at all"));
    await expect(finishFile(other.id, "o", db)).rejects.toThrow(/Only a PDF/);
    // A refused file leaves nothing behind.
    expect(del).toHaveBeenCalledWith(other.pathname, expect.anything());
    expect(await db.select().from(s.hiringAssessmentFiles).where(eq(s.hiringAssessmentFiles.id, other.id))).toEqual([]);
  });
  it("makes a new library file the one in use, and writes an audit row", async () => {
    const first = await createFileIntent(library("old.pdf"), "o", db);
    stored(PDF);
    await finishFile(first.id, "o", db);
    const second = await createFileIntent(library("new.pdf"), "o", db);
    stored(PDF);
    const ready = await finishFile(second.id, "o", db);
    expect(ready).toMatchObject({ status: "ready", active: true });
    expect(ready.sha256).toHaveLength(64);
    const active = await db.select().from(s.hiringAssessmentFiles).where(eq(s.hiringAssessmentFiles.active, true));
    expect(active.map((f) => f.name)).toEqual(["new.pdf"]);
    expect(await db.select().from(s.hiringAudit)).toHaveLength(2);
  });
  it("keeps a separate file in use for each kind", async () => {
    const scheme = await createFileIntent(library("scheme.pdf"), "o", db);
    const paper = await createFileIntent({ ...library("paper.pdf"), kind: "question_paper" }, "o", db);
    stored(PDF);
    await finishFile(scheme.id, "o", db);
    stored(PDF);
    await finishFile(paper.id, "o", db);
    expect(await db.select().from(s.hiringAssessmentFiles).where(eq(s.hiringAssessmentFiles.active, true))).toHaveLength(2);
  });
});
