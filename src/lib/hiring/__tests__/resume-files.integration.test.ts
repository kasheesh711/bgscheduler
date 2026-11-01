import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { eq, sql } from "drizzle-orm";
import { NextRequest } from "next/server";
import { del, list } from "@vercel/blob";
import { put } from "@vercel/blob/client";
import { startTestDb, stopTestDb } from "@/tests/integration/db-helper";
import { getDb, type Database } from "@/lib/db";
import * as s from "@/lib/db/schema";
import { GET as retentionCron, maxDuration } from "@/app/api/internal/hiring-resume-retention/route";
import { getCronJobDefinition } from "@/lib/data-health/cron-registry";
import { requestResumeUploadToken } from "../dispatch";
import { RESUME_TYPES } from "../model";
import { deleteExpiredResumes, keepResume, resumePath, storeResume } from "../resume-files";
import { dashboard } from "../service";

vi.mock("@vercel/blob", () => ({ del: vi.fn(), list: vi.fn(), get: vi.fn() }));
vi.mock("@vercel/blob/client", () => ({ put: vi.fn() }));
vi.mock("@/lib/db", async (actual) => ({
  ...(await actual<typeof import("@/lib/db")>()),
  getDb: vi.fn(),
}));
vi.mock("@/lib/data-health/cron-audit", () => ({
  withCronInvocationAudit: vi.fn((_input, run) => run()),
}));
vi.mock("../dispatch", async (actual) => ({
  ...(await actual<typeof import("../dispatch")>()),
  requestResumeUploadToken: vi.fn(),
}));

let handle: Awaited<ReturnType<typeof startTestDb>>, db: Database;
const now = new Date("2026-11-02T00:00:00Z");
const OLD = new Date("2025-06-01T00:00:00Z");
const RECENT = new Date("2026-10-01T00:00:00Z");
const c = s.hiringCandidates;

let serial = 0;
async function candidate(values: Partial<typeof c.$inferInsert> = {}) {
  const n = ++serial;
  const id = `00000000-0000-4000-8000-${String(n).padStart(12, "0")}`;
  const path = resumePath(id, "a".repeat(64), "pdf");
  await db.insert(c).values({
    id,
    name: `Invented ${n}`,
    profileText: "Invented extracted text",
    resumePath: path,
    resumeName: "cv.pdf",
    resumeType: RESUME_TYPES.pdf,
    resumeSha256: "a".repeat(64),
    resumeSize: 10,
    resumeStoredAt: OLD,
    // Old rows may have this changed by a pass, so it must not count.
    updatedAt: RECENT,
    ...values,
  });
  return { id, path };
}
const load = async (id: string) => (await db.select().from(c).where(eq(c.id, id)))[0];
const auditRow = (candidateId: string, actor: string, action: string, createdAt = RECENT) =>
  db.insert(s.hiringAudit).values({ candidateId, actor, action, createdAt });
const booking = (candidateId: string, status: "confirmed" | "cancelled") =>
  db.insert(s.hiringBookings).values({
    candidateId,
    kind: "mock",
    status,
    subjects: ["Mathematics"],
    calendarOwner: "owner@example.com",
    interviewerKey: "Peat",
    interviewerEmail: "head@example.com",
    lineGroupId: "invented-group",
    startTime: new Date(RECENT.getTime() - 3600000),
    endTime: RECENT,
    evidence: {},
  });
const runAudits = () =>
  db.select().from(s.hiringAudit).where(eq(s.hiringAudit.action, "resume-retention"));

beforeAll(async () => {
  handle = await startTestDb();
  db = handle.db as unknown as Database;
});
afterAll(async () => {
  if (handle) await stopTestDb(handle);
});
beforeEach(async () => {
  vi.clearAllMocks();
  vi.stubEnv("HIRING_WRITES_ENABLED", "true");
  vi.stubEnv("VERCEL_ENV", "production");
  vi.stubEnv("PREVIEW_SANDBOX_ENABLED", "false");
  vi.stubEnv("CRON_SECRET", "cron-secret");
  vi.mocked(getDb).mockReturnValue(db);
  // By default each candidate's folder holds the one old stored file.
  vi.mocked(list).mockImplementation((async (options: { prefix: string }) => ({
    blobs: [{ pathname: `${options.prefix}${"a".repeat(64)}.pdf`, uploadedAt: OLD }],
    hasMore: false,
  })) as never);
  vi.mocked(del).mockResolvedValue(undefined);
  await db.execute(sql`truncate hiring_audit,hiring_outbox,hiring_bookings,hiring_candidates,hiring_settings cascade`);
});
afterEach(() => vi.unstubAllEnvs());

describe("deleteExpiredResumes", () => {
  it("deletes only files past retention, and keeps the text", async () => {
    const expired = await candidate();
    const fresh = await candidate({ resumeStoredAt: RECENT });
    const before = await load(expired.id);
    expect(await deleteExpiredResumes(db, now, 12)).toBe(1);
    expect(del).toHaveBeenCalledTimes(1);
    expect(vi.mocked(del).mock.calls[0][0]).toEqual([expired.path]);
    const after = await load(expired.id);
    expect(after.resumePath).toBeNull();
    expect(after.resumeName).toBeNull();
    // The marker the panel reads, and the text stays.
    expect(after.resumeStoredAt).toEqual(OLD);
    expect(after.profileText).toBe("Invented extracted text");
    // A file cleanup must not void a person's decision or look like a change to the candidate.
    expect(after.revision).toBe(before.revision);
    expect(after.updatedAt).toEqual(before.updatedAt);
    expect((await load(fresh.id)).resumePath).toBe(fresh.path);
  });

  it("counts a reply, a confirmed booking and a person's action as activity", async () => {
    await candidate({ preScreenRepliedAt: RECENT });
    const booked = await candidate();
    await booking(booked.id, "confirmed");
    const decided = await candidate();
    await auditRow(decided.id, "staff@example.com", "advance");
    const contacted = await candidate();
    await auditRow(contacted.id, "hiring-queue", "pre-screen-release");
    expect(await deleteExpiredResumes(db, now, 12)).toBe(0);
    expect(del).not.toHaveBeenCalled();
  });

  it("does not count automatic passes, a cancelled booking, or updated_at", async () => {
    const passes = await candidate();
    for (const [actor, action] of [
      ["subscription-assessment", "brief-rewrite"],
      ["subscription-assessment", "brief-rewrite-skipped"],
      ["subscription-assessment", "pre-screen-score-only"],
      ["subscription-assessment", "pre-screen-invalid-evidence"],
      ["subscription-assessment", "profile-score-only"],
      ["subscription-assessment", "invalid-evidence"],
      ["subscription-assessment", "profile-assessment"],
      ["hiring-worker", "move-to-review"],
      ["hiring-backfill", "seek-backfill"],
    ])
      await auditRow(passes.id, actor, action);
    const cancelled = await candidate();
    await booking(cancelled.id, "cancelled");
    expect(await deleteExpiredResumes(db, now, 12)).toBe(2);
  });

  it("deletes older copies of the candidate's file as well", async () => {
    const { id, path } = await candidate();
    const older = resumePath(id, "b".repeat(64), "docx");
    vi.mocked(list).mockResolvedValue({
      blobs: [{ pathname: path, uploadedAt: OLD }, { pathname: older, uploadedAt: OLD }],
      hasMore: false,
    } as never);
    await deleteExpiredResumes(db, now, 12);
    expect(list).toHaveBeenCalledWith(expect.objectContaining({ prefix: `hiring-resumes/${id}/` }));
    expect(vi.mocked(del).mock.calls[0][0]).toEqual([path, older]);
  });

  it.each([
    ["a booking", (id: string) => booking(id, "confirmed")],
    ["an import", (id: string) => auditRow(id, "seek-import", "source-update")],
    ["a reply", (id: string) => db.update(c).set({ preScreenRepliedAt: RECENT }).where(eq(c.id, id))],
  ])("%s that arrives during the run prevents the delete", async (_name, event) => {
    await candidate({ resumeStoredAt: new Date(OLD.getTime() - 86400000) });
    const second = await candidate();
    // Both rows are in the batch. The event lands while the first file is deleted.
    vi.mocked(del).mockImplementationOnce(async () => {
      await event(second.id);
    });
    expect(await deleteExpiredResumes(db, now, 12)).toBe(1);
    expect(list).toHaveBeenCalledTimes(1);
    expect((await load(second.id)).resumePath).toBe(second.path);
  });

  it("keeps a file uploaded after the cutoff, and deletes the old one", async () => {
    const { id, path } = await candidate();
    const fresh = resumePath(id, "b".repeat(64), "pdf");
    vi.mocked(list).mockResolvedValue({
      blobs: [{ pathname: path, uploadedAt: OLD }, { pathname: fresh, uploadedAt: new Date(now.getTime() - 60000) }],
      hasMore: false,
    } as never);
    expect(await deleteExpiredResumes(db, now, 12)).toBe(1);
    expect(vi.mocked(del).mock.calls[0][0]).toEqual([path]);
  });

  it("changes nothing when the stored file itself was uploaded after the cutoff", async () => {
    const { id, path } = await candidate();
    vi.mocked(list).mockResolvedValue({
      blobs: [{ pathname: path, uploadedAt: new Date(now.getTime() - 60000) }],
      hasMore: false,
    } as never);
    expect(await deleteExpiredResumes(db, now, 12)).toBe(0);
    expect(del).not.toHaveBeenCalled();
    expect((await load(id)).resumePath).toBe(path);
  });

  it("clears the row when storage no longer holds the file", async () => {
    const { id } = await candidate();
    vi.mocked(list).mockResolvedValue({ blobs: [], hasMore: false } as never);
    expect(await deleteExpiredResumes(db, now, 12)).toBe(1);
    expect(del).not.toHaveBeenCalled();
    expect((await load(id)).resumePath).toBeNull();
  });

  it("a failed delete leaves the row for the next run, and the run reports it", async () => {
    const { id, path } = await candidate();
    const log = vi.spyOn(console, "error").mockImplementation(() => {});
    vi.mocked(del).mockRejectedValueOnce(new Error(`could not delete ${path}`));
    await expect(deleteExpiredResumes(db, now, 12)).rejects.toThrow(/1 résumé file/);
    expect((await load(id)).resumePath).toBe(path);
    expect(JSON.stringify(log.mock.calls)).not.toContain(path);
    const [run] = await runAudits();
    expect(run.detail).toEqual({ deleted: 0, failed: 1 });
    expect(await deleteExpiredResumes(db, now, 12)).toBe(1);
    expect((await load(id)).resumePath).toBeNull();
  });

  it("does not touch storage for a stored path that breaks the pattern", async () => {
    const { id } = await candidate({ resumePath: "https://store.blob.vercel-storage.com/x.pdf" });
    await expect(deleteExpiredResumes(db, now, 12)).rejects.toThrow(/1 résumé file/);
    expect(list).not.toHaveBeenCalled();
    expect(del).not.toHaveBeenCalled();
    expect((await load(id)).resumePath).not.toBeNull();
  });

  it("stops at the batch limit, oldest first, and the next run continues", async () => {
    for (let i = 0; i < 51; i++) await candidate();
    expect(await deleteExpiredResumes(db, now, 12)).toBe(50);
    expect(await deleteExpiredResumes(db, now, 12)).toBe(1);
  });

  it("does nothing destructive unless writes are allowed", async () => {
    const { id, path } = await candidate();
    vi.stubEnv("HIRING_WRITES_ENABLED", "false");
    expect(await deleteExpiredResumes(db, now, 12)).toBe(0);
    vi.stubEnv("HIRING_WRITES_ENABLED", "true");
    vi.stubEnv("VERCEL_ENV", "preview");
    expect(await deleteExpiredResumes(db, now, 12)).toBe(0);
    expect(del).not.toHaveBeenCalled();
    expect(list).not.toHaveBeenCalled();
    expect((await load(id)).resumePath).toBe(path);
  });

  it("writes one audit row per run, with counts only", async () => {
    await candidate();
    await candidate({ resumeStoredAt: RECENT });
    await deleteExpiredResumes(db, now, 12);
    const rows = await runAudits();
    expect(rows).toHaveLength(1);
    expect(rows[0].candidateId).toBeNull();
    expect(rows[0].detail).toEqual({ deleted: 1, failed: 0 });
  });
});

describe("the dashboard", () => {
  it("gives the screen a state, never the storage path or sha", async () => {
    const available = await candidate({ resumeStoredAt: RECENT });
    const deleted = await candidate({ resumePath: null, resumeType: null });
    const none = await candidate({ resumePath: null, resumeType: null, resumeStoredAt: null });
    const { candidates } = await dashboard(db);
    const stateOf = (id: string) => candidates.find((row) => row.id === id)!;
    expect(stateOf(available.id).resumeState).toBe("available");
    expect(stateOf(deleted.id).resumeState).toBe("deleted");
    expect(stateOf(none.id).resumeState).toBe("none");
    const sent = JSON.stringify(candidates);
    expect(sent).not.toContain("hiring-resumes/");
    expect(sent).not.toContain("a".repeat(64));
  });
});

describe("the retention cron", () => {
  const call = (secret?: string) =>
    retentionCron(
      new NextRequest("https://bgscheduler.vercel.app/api/internal/hiring-resume-retention", {
        headers: secret ? { Authorization: `Bearer ${secret}` } : {},
      }),
    );
  it("uses the shared cron secret, the saved months and the registry duration", async () => {
    await db.insert(s.hiringSettings).values({
      id: "default",
      config: { resumeRetentionMonths: 1 },
      updatedBy: "owner@example.com",
    } as never);
    const recentButPastOneMonth = await candidate({ resumeStoredAt: new Date(Date.now() - 40 * 86400000) });
    expect((await call()).status).toBe(401);
    expect((await call("wrong")).status).toBe(401);
    expect(del).not.toHaveBeenCalled();
    const response = await call("cron-secret");
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ deleted: 1 });
    expect((await load(recentButPastOneMonth.id)).resumePath).toBeNull();
    expect(getCronJobDefinition("hiring_resume_retention")?.maxDurationSeconds).toBe(maxDuration);
  });
  it("reports a failed run as a failure, so Data Health shows it", async () => {
    await candidate();
    vi.spyOn(console, "error").mockImplementation(() => {});
    vi.mocked(del).mockRejectedValue(new Error("storage down"));
    const response = await call("cron-secret");
    expect(response.status).toBe(503);
    expect((await response.json()).error).toMatch(/next run/);
  });
});

describe("storeResume", () => {
  const PDF = Buffer.from("%PDF-1.4 invented");
  const stub = () => {
    vi.mocked(requestResumeUploadToken).mockResolvedValue("client-token");
    vi.mocked(put).mockResolvedValue({} as never);
  };
  it("writes the columns from the file bytes, with a clean name, and no revision change", async () => {
    stub();
    const { id } = await candidate({ resumePath: null, resumeName: null, resumeType: null, resumeSha256: null, resumeStoredAt: null, resumeSize: null });
    const before = await load(id);
    await storeResume(id, { bytes: PDF, name: '../"CV".docx' }, db);
    const after = await load(id);
    expect(after.resumeType).toBe(RESUME_TYPES.pdf);
    expect(after.resumeName).toBe("CV.pdf");
    expect(after.resumeSize).toBe(PDF.length);
    expect(after.resumePath).toBe(resumePath(id, after.resumeSha256!, "pdf"));
    expect(after.resumeStoredAt).not.toBeNull();
    expect(after.revision).toBe(before.revision);
    expect(after.updatedAt).toEqual(before.updatedAt);
    expect(requestResumeUploadToken).toHaveBeenCalledWith({ candidateId: id, sha256: after.resumeSha256, extension: "pdf" });
    expect(vi.mocked(put).mock.calls[0]).toEqual([
      after.resumePath,
      PDF,
      expect.objectContaining({ access: "private", token: "client-token", contentType: RESUME_TYPES.pdf }),
    ]);
  });
  it("deduplicates by sha, and stores a changed file", async () => {
    stub();
    const { id } = await candidate({ resumePath: null, resumeName: null, resumeType: null, resumeSha256: null, resumeStoredAt: null, resumeSize: null });
    await storeResume(id, { bytes: PDF, name: "cv.pdf" }, db);
    await storeResume(id, { bytes: PDF, name: "cv.pdf" }, db);
    expect(put).toHaveBeenCalledTimes(1);
    await storeResume(id, { bytes: Buffer.from("%PDF-1.4 changed"), name: "cv.pdf" }, db);
    expect(put).toHaveBeenCalledTimes(2);
  });
  it("after a failed upload the text stays, and a retry stores the file", async () => {
    stub();
    const { id } = await candidate({ resumePath: null, resumeName: null, resumeType: null, resumeSha256: null, resumeStoredAt: null, resumeSize: null });
    vi.spyOn(console, "error").mockImplementation(() => {});
    vi.mocked(put).mockRejectedValueOnce(new Error("storage down"));
    expect(await keepResume(id, { bytes: PDF, name: "cv.pdf" }, db)).toBe(false);
    let row = await load(id);
    expect(row.resumePath).toBeNull();
    expect(row.profileText).toBe("Invented extracted text");
    expect(await keepResume(id, { bytes: PDF, name: "cv.pdf" }, db)).toBe(true);
    row = await load(id);
    expect(row.resumePath).not.toBeNull();
  });
  it("refuses a candidate that does not exist", async () => {
    stub();
    await expect(
      storeResume("00000000-0000-4000-8000-00000000ffff", { bytes: PDF, name: "cv.pdf" }, db),
    ).rejects.toThrow(/Candidate/);
    expect(put).not.toHaveBeenCalled();
  });
});
