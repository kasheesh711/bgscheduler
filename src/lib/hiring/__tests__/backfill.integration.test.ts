import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { eq, sql } from "drizzle-orm";
import { del, list } from "@vercel/blob";
import { put } from "@vercel/blob/client";
import { startTestDb, stopTestDb } from "@/tests/integration/db-helper";
import { type Database } from "@/lib/db";
import * as s from "@/lib/db/schema";
import * as sheets from "@/lib/sales-dashboard/sheets";
import { dashboard } from "../service";
import { configSchema } from "../model";
import { profileGate } from "../insights";
import { autoInviteEligible, onsiteQueue, preScreenQueue } from "../queue";
import { RESUME_TYPES } from "../model";
import { countOrphanResumes, deleteExpiredResumes, resumePath, runResumeRetention } from "../resume-files";
import {
  applyBackfill,
  backfillStatus,
  importApplication,
  importMissingTracker,
  markTrackerContacted,
  reconcileTracker,
} from "../sources";
import { BackfillFatal, createBackfillStep, parseBackfillArgs } from "../backfill";

vi.mock("@vercel/blob", () => ({ del: vi.fn(), list: vi.fn(), get: vi.fn() }));
vi.mock("@vercel/blob/client", () => ({ put: vi.fn() }));
vi.mock("../dispatch", async (actual) => ({
  ...(await actual<typeof import("../dispatch")>()),
  requestResumeUploadToken: vi.fn().mockResolvedValue("upload-token"),
}));
vi.mock("@/lib/sales-dashboard/sheets", () => ({
  fetchGoogleSheetRange: vi.fn(),
  listGoogleSheetProperties: vi.fn(),
  updateGoogleSheetCell: vi.fn(),
  updateGoogleSheetRangeValues: vi.fn(),
  batchUpdateGoogleSheetValues: vi.fn(),
  batchUpdateGoogleSpreadsheet: vi.fn(),
  insertGoogleSheetRow: vi.fn(),
  updateGoogleSheetRowValues: vi.fn(),
  appendGoogleSheetRows: vi.fn(),
}));

let handle: Awaited<ReturnType<typeof startTestDb>>, db: Database;
const c = s.hiringCandidates;
const config = configSchema.parse({});
const ACCEPTED = "I have permanent work rights with no restrictions";
const OTHER = "I am a long term / permanent resident with eligibility for a work permit";
const pdf = (tag = "a") => ({ bytes: Buffer.from(`%PDF-1.4 invented ${tag}`), name: "cv.pdf" });

let serial = 0;
async function seed(values: Partial<typeof c.$inferInsert> = {}) {
  const n = ++serial;
  const [row] = await db
    .insert(c)
    .values({
      name: `Invented ${n}`,
      email: `c${n}@example.com`,
      sourceIds: [`app-${n}`],
      stage: "review",
      revision: 7,
      reviewNote: "Keep this note",
      profileText: "Invented profile text",
      profileHash: "profile-hash",
      preScreenHash: "pre-hash",
      updatedAt: new Date("2026-10-01T00:00:00Z"),
      ...values,
    })
    .returning();
  return row;
}
const load = async (id: string) => (await db.select().from(c).where(eq(c.id, id)))[0];
const settingsConfig = async () => configSchema.parse((await db.select().from(s.hiringSettings))[0]?.config ?? {});
const setConfig = (patch: Record<string, unknown>) =>
  db
    .insert(s.hiringSettings)
    .values({ id: "default", config: configSchema.parse(patch), updatedBy: "test" })
    .onConflictDoUpdate({ target: s.hiringSettings.id, set: { config: configSchema.parse(patch) } });
const counts = async () => ({
  candidates: (await db.select().from(c)).length,
  audit: (await db.select().from(s.hiringAudit)).length,
  outbox: (await db.select().from(s.hiringOutbox)).length,
  bookings: (await db.select().from(s.hiringBookings)).length,
  settings: (await db.select().from(s.hiringSettings)).length,
});

beforeAll(async () => {
  handle = await startTestDb();
  db = handle.db as unknown as Database;
});
afterAll(async () => {
  if (handle) await stopTestDb(handle);
});
beforeEach(async () => {
  serial = 0;
  vi.clearAllMocks();
  vi.mocked(put).mockResolvedValue({} as never);
  await db.execute(sql`truncate hiring_audit,hiring_outbox,hiring_bookings,hiring_candidates,hiring_settings cascade`);
});
afterEach(() => vi.unstubAllEnvs());

describe("SEEK pass: applyBackfill", () => {
  it("changes no stage, revision, review note, text, hash or updated_at, and adds no outbox row", async () => {
    const row = await seed();
    await applyBackfill(db, "app-1", { workRightsAnswer: ACCEPTED, file: pdf() });
    const after = await load(row.id);
    expect(after.stage).toBe("review");
    expect(after.revision).toBe(7);
    expect(after.reviewNote).toBe("Keep this note");
    expect(after.profileText).toBe("Invented profile text");
    expect(after.profileHash).toBe("profile-hash");
    expect(after.preScreenHash).toBe("pre-hash");
    expect(after.updatedAt).toEqual(row.updatedAt);
    // The two things it is allowed to write.
    expect(after.workRightsAnswer).toBe(ACCEPTED);
    expect(after.resumePath).toMatch(new RegExp(`^hiring-resumes/${row.id}/[0-9a-f]{64}\\.pdf$`));
    expect(after.resumeType).toBe(RESUME_TYPES.pdf);
    expect(await db.select().from(s.hiringOutbox)).toEqual([]);
    const audits = await db.select().from(s.hiringAudit).where(eq(s.hiringAudit.action, "seek-backfill"));
    expect(audits).toHaveLength(1);
    expect(audits[0]).toMatchObject({ actor: "hiring-backfill", candidateId: row.id });
  });

  it("is resumable: a candidate with an answer and a file, or one already checked, is not read again", async () => {
    const done = await seed({
      workRightsAnswer: ACCEPTED,
      resumePath: resumePath("00000000-0000-4000-8000-000000000001", "a".repeat(64), "pdf"),
      resumeStoredAt: new Date(),
    });
    expect(await backfillStatus(db, done.sourceIds[0])).toEqual({ state: "done" });
    const checked = await seed();
    expect(await backfillStatus(db, checked.sourceIds[0])).toEqual({ state: "todo", candidateId: checked.id });
    await applyBackfill(db, checked.sourceIds[0], { workRightsAnswer: null, file: null });
    // Checked with nothing on the page: a rerun does not open it again.
    expect(await backfillStatus(db, checked.sourceIds[0])).toEqual({ state: "done" });
    expect(await backfillStatus(db, "unknown-application")).toEqual({ state: "notOurs" });
  });

  it("skips a row whose résumé was deleted by retention", async () => {
    const row = await seed({ resumePath: null, resumeStoredAt: new Date("2025-01-01T00:00:00Z") });
    expect(await backfillStatus(db, row.sourceIds[0])).toEqual({ state: "done" });
    expect(await applyBackfill(db, row.sourceIds[0], { workRightsAnswer: ACCEPTED, file: pdf() })).toBeNull();
    expect(put).not.toHaveBeenCalled();
    const after = await load(row.id);
    expect(after.resumePath).toBeNull();
    expect(after.workRightsAnswer).toBeNull();
    expect(await db.select().from(s.hiringAudit)).toEqual([]);
  });

  it("adds a new work-rights answer to seenWorkRights, unticked", async () => {
    await seed();
    await applyBackfill(db, "app-1", { workRightsAnswer: OTHER, file: null });
    const saved = await settingsConfig();
    expect(saved.seenWorkRights).toEqual([OTHER]);
    expect(saved.acceptedWorkRights).toEqual(config.acceptedWorkRights);
    // The same answer for a second person is not listed twice.
    await seed();
    await applyBackfill(db, "app-2", { workRightsAnswer: ` ${OTHER} `, file: null });
    expect((await settingsConfig()).seenWorkRights).toEqual([OTHER]);
  });

  it("keeps the newer exact answer when it differs from the stored one, and never accepts it", async () => {
    const row = await seed({ workRightsAnswer: ACCEPTED });
    await applyBackfill(db, "app-1", { workRightsAnswer: OTHER, file: null });
    expect((await load(row.id)).workRightsAnswer).toBe(OTHER);
    const saved = await settingsConfig();
    expect(saved.seenWorkRights).toContain(OTHER);
    expect(saved.acceptedWorkRights).toEqual(config.acceptedWorkRights);
    const [audit] = await db.select().from(s.hiringAudit).where(eq(s.hiringAudit.action, "seek-backfill"));
    expect(audit.detail).toMatchObject({ answer: "replaced", previous: ACCEPTED });
  });

  it("stores the file only when none is stored, and leaves a blank page answer alone", async () => {
    const row = await seed({ workRightsAnswer: ACCEPTED });
    await applyBackfill(db, "app-1", { workRightsAnswer: null, file: pdf("one") });
    const first = await load(row.id);
    expect(first.workRightsAnswer).toBe(ACCEPTED);
    expect(first.resumePath).not.toBeNull();
    expect(put).toHaveBeenCalledTimes(1);
  });

  it("saves the answer but writes no seek-backfill row when the upload fails, so a rerun retries", async () => {
    const row = await seed();
    vi.mocked(put).mockRejectedValueOnce(new Error("storage down"));
    expect(await applyBackfill(db, "app-1", { workRightsAnswer: ACCEPTED, file: pdf() })).toEqual({ answer: "filled", file: "failed" });
    expect(await backfillStatus(db, "app-1")).toEqual({ state: "todo", candidateId: row.id });
    const after = await load(row.id);
    expect(after.resumePath).toBeNull();
    expect(after.workRightsAnswer).toBe(ACCEPTED);
    const actions = (await db.select().from(s.hiringAudit)).map((a) => a.action);
    expect(actions).not.toContain("seek-backfill");
    expect(actions).toContain("seek-backfill-retry");
  });

  it("saves the answer and writes no seek-backfill row when the page download failed", async () => {
    const row = await seed();
    expect(await applyBackfill(db, "app-1", { workRightsAnswer: ACCEPTED, file: null, resumeFailed: true })).toEqual({ answer: "filled", file: "failed" });
    expect((await load(row.id)).workRightsAnswer).toBe(ACCEPTED);
    expect((await backfillStatus(db, "app-1")).state).toBe("todo");
    // The next run gets the file and then marks the candidate.
    expect(await applyBackfill(db, "app-1", { workRightsAnswer: ACCEPTED, file: pdf() })).toEqual({ answer: "same", file: "stored" });
    expect((await backfillStatus(db, "app-1")).state).toBe("done");
  });

  it.each([
    ["a page that reported an unusable file", { workRightsAnswer: ACCEPTED, file: null, resumeUnusable: true }],
    ["a Word 97 file", { workRightsAnswer: ACCEPTED, file: { bytes: Buffer.from("\xd0\xcf\x11\xe0 old doc", "latin1"), name: "cv.doc" } }],
  ])("marks %s as unusable and does not retry it", async (_name, page) => {
    const row = await seed();
    expect(await applyBackfill(db, "app-1", page)).toEqual({ answer: "filled", file: "unusable" });
    expect(put).not.toHaveBeenCalled();
    expect((await load(row.id)).resumePath).toBeNull();
    expect((await backfillStatus(db, "app-1")).state).toBe("done");
    const [audit] = await db.select().from(s.hiringAudit).where(eq(s.hiringAudit.action, "seek-backfill"));
    expect(audit.detail).toMatchObject({ file: "unusable" });
  });

  it("records file kept when a file already exists", async () => {
    const row = await seed({
      resumePath: resumePath("00000000-0000-4000-8000-000000000001", "a".repeat(64), "pdf"),
      resumeStoredAt: new Date(),
    });
    await applyBackfill(db, row.sourceIds[0], { workRightsAnswer: ACCEPTED, file: pdf() });
    expect(put).not.toHaveBeenCalled();
    const [audit] = await db.select().from(s.hiringAudit).where(eq(s.hiringAudit.action, "seek-backfill"));
    expect(audit.detail).toMatchObject({ file: "kept" });
  });

  it.each([["enabled"], ["deliveryEnabled"]])("refuses while %s is true", async (flag) => {
    const row = await seed();
    await setConfig({ [flag]: true });
    await expect(applyBackfill(db, "app-1", { workRightsAnswer: ACCEPTED, file: pdf() })).rejects.toThrow(/pause/i);
    expect((await load(row.id)).workRightsAnswer).toBeNull();
    expect(put).not.toHaveBeenCalled();
  });
});

describe("SEEK pass: step and arguments", () => {
  const step = (over: Partial<Parameters<typeof createBackfillStep>[0]> = {}) => {
    const sleep = vi.fn().mockResolvedValue(undefined);
    const made = createBackfillStep({
      db,
      until: Date.parse("2026-11-02T10:00:00Z"),
      limit: null,
      pause: 10000,
      now: () => Date.parse("2026-11-02T09:00:00Z"),
      sleep,
      shouldStop: () => false,
      ...over,
    });
    return { ...made, sleep };
  };
  const page = (id: string, over = {}) =>
    vi.fn().mockResolvedValue({ applicationId: id, workRightsAnswer: OTHER, file: null, ...over });

  it("reads only candidates that need it, waits between reads, and counts what it did", async () => {
    await seed();
    await seed();
    await seed({ workRightsAnswer: ACCEPTED, resumePath: "x", resumeStoredAt: new Date() });
    const { run, sleep, counts } = step();
    const read = page("app-1");
    expect(await run("app-1", read)).toBe("read");
    expect(await run("app-2", page("app-2", { file: pdf() }))).toBe("read");
    expect(await run("app-3", read)).toBe("skipped");
    expect(await run("not-known", read)).toBe("skipped");
    expect(read).toHaveBeenCalledTimes(1);
    // No wait before the first read; one wait before the second; none for skipped ones.
    expect(sleep).toHaveBeenCalledTimes(1);
    expect(sleep).toHaveBeenCalledWith(10000);
    expect(counts).toMatchObject({ read: 2, done: 1, notOurs: 1, answersFilled: 2, filesStored: 1, readFailed: 0 });
  });

  it("stops at the limit, at the stop time, and when asked", async () => {
    await seed();
    await seed();
    const limited = step({ limit: 1 });
    expect(await limited.run("app-1", page("app-1"))).toBe("read");
    expect(await limited.run("app-2", page("app-2"))).toBe("stop");
    const late = step({ now: () => Date.parse("2026-11-02T10:00:00Z") });
    expect(await late.run("app-2", page("app-2"))).toBe("stop");
    const asked = step({ shouldStop: () => true });
    expect(await asked.run("app-2", page("app-2"))).toBe("stop");
  });

  it("does not open the page while automation is on, and does not absorb that error", async () => {
    await seed();
    await setConfig({ enabled: true });
    const read = page("app-1");
    const made = step();
    await expect(made.run("app-1", read)).rejects.toThrow(/pause/i);
    expect(read).not.toHaveBeenCalled();
    expect(made.counts.readFailed).toBe(0);
  });

  it("writes nothing when the card that was read is another person's", async () => {
    const first = await seed();
    const second = await seed();
    const before = await counts();
    const made = step();
    // The list moved: the card planned as app-1 now shows app-2, with its own answer and file.
    expect(await made.run("app-1", page("app-2", { workRightsAnswer: ACCEPTED, file: pdf() }))).toBe("failed");
    expect(put).not.toHaveBeenCalled();
    expect(await counts()).toEqual(before);
    for (const row of [first, second]) {
      const after = await load(row.id);
      expect(after.workRightsAnswer).toBeNull();
      expect(after.resumePath).toBeNull();
    }
    expect(made.counts).toMatchObject({ readFailed: 1, read: 0 });
  });

  it("counts a failed read, writes no audit row, goes on, and stops after five in a row", async () => {
    for (let i = 0; i < 8; i++) await seed();
    const failing = () => vi.fn().mockRejectedValue(new Error("SEEK page step failed: TimeoutError"));
    const made = step();
    expect(await made.run("app-1", failing())).toBe("failed");
    expect(await made.run("app-2", page("app-2"))).toBe("read");
    // A good read resets the run of failures.
    for (const n of [3, 4, 5, 6]) expect(await made.run(`app-${n}`, failing())).toBe("failed");
    await expect(made.run("app-7", failing())).rejects.toThrow(/5 candidates in a row/);
    expect(made.counts.readFailed).toBe(6);
    expect(await db.select().from(s.hiringAudit).where(eq(s.hiringAudit.action, "seek-backfill"))).toHaveLength(1);
    expect((await backfillStatus(db, "app-1")).state).toBe("todo");
  });

  it("does not absorb a fatal error such as a lost sign-in", async () => {
    await seed();
    const made = step();
    await expect(made.run("app-1", vi.fn().mockRejectedValue(new BackfillFatal("SEEK is signed out.")))).rejects.toThrow(/signed out/);
    expect(made.counts.readFailed).toBe(0);
  });

  it("counts a failed download and an unusable file apart", async () => {
    await seed();
    await seed();
    const made = step();
    await made.run("app-1", page("app-1", { resumeFailed: true }));
    await made.run("app-2", page("app-2", { resumeUnusable: true }));
    expect(made.counts).toMatchObject({ fileFailed: 1, fileUnusable: 1, filesStored: 0 });
  });

  const env = { HIRING_BACKFILL_UNTIL: "2099-01-01T00:00:00Z" };
  it("accepts one mode, a limit and a stop time", () => {
    expect(parseBackfillArgs(["--seek", "--limit", "5"], env)).toMatchObject({ mode: "seek", limit: 5 });
    expect(parseBackfillArgs(["--tracker-report"], {})).toMatchObject({ mode: "tracker-report" });
    expect(parseBackfillArgs(["--tracker-import"], {})).toMatchObject({ mode: "tracker-import" });
    expect(parseBackfillArgs(["--tracker-results-report"], {})).toMatchObject({ mode: "tracker-results-report" });
    expect(parseBackfillArgs(["--tracker-results-import"], {})).toMatchObject({ mode: "tracker-results-import" });
    expect(() => parseBackfillArgs(["--tracker-results-import", "--limit", "5"], {})).toThrow();
  });
  it.each([
    [[], env],
    [["--nope"], env],
    [["--seek", "--tracker-report"], env],
    [["--seek", "--limit", "0"], env],
    [["--seek", "--limit"], env],
    [["--tracker-report", "--limit", "5"], env],
    [["--seek"], {}],
    [["--seek"], { HIRING_BACKFILL_UNTIL: "not a time" }],
    [["--seek"], { HIRING_BACKFILL_UNTIL: "2000-01-01T00:00:00Z" }],
  ])("refuses %j", (argv, vars) => {
    expect(() => parseBackfillArgs(argv, vars)).toThrow();
  });
  it("prints usage for a missing or unknown flag", () => {
    expect(() => parseBackfillArgs([], {})).toThrow(/Usage: npm run hiring:backfill/);
    expect(() => parseBackfillArgs(["--nope"], {})).toThrow(/Usage: npm run hiring:backfill/);
  });
});

describe("orphan files", () => {
  it("counts stored files that no candidate points to, and deletes nothing", async () => {
    const row = await seed({ resumePath: resumePath("00000000-0000-4000-8000-0000000000aa", "a".repeat(64), "pdf") });
    vi.mocked(list)
      .mockResolvedValueOnce({
        blobs: [{ pathname: row.resumePath }, { pathname: "hiring-resumes/x/older.pdf" }],
        hasMore: true,
        cursor: "next",
      } as never)
      .mockResolvedValueOnce({ blobs: [{ pathname: "hiring-resumes/y/lost.docx" }], hasMore: false } as never);
    expect(await countOrphanResumes(db)).toBe(2);
    expect(list).toHaveBeenCalledWith(expect.objectContaining({ prefix: "hiring-resumes/" }));
    expect(del).not.toHaveBeenCalled();
  });

  it("is recorded on the retention cron's audit row, and a failed count never fails the run", async () => {
    vi.stubEnv("HIRING_WRITES_ENABLED", "true");
    vi.stubEnv("VERCEL_ENV", "production");
    vi.mocked(list).mockResolvedValueOnce({ blobs: [{ pathname: "hiring-resumes/x/lost.pdf" }], hasMore: false } as never);
    await runResumeRetention(db, new Date("2026-11-02T00:00:00Z"));
    vi.mocked(list).mockRejectedValueOnce(new Error("storage down"));
    await runResumeRetention(db, new Date("2026-11-02T00:00:00Z"));
    const rows = await db.select().from(s.hiringAudit).where(eq(s.hiringAudit.action, "resume-retention")).orderBy(s.hiringAudit.createdAt);
    expect(rows.map((r) => r.detail)).toEqual([
      { deleted: 0, failed: 0, orphans: 1 },
      { deleted: 0, failed: 0, orphans: null },
    ]);
    // The old three-argument call writes the old shape.
    await deleteExpiredResumes(db, new Date("2026-11-02T00:00:00Z"), 12);
    const [last] = (await db.select().from(s.hiringAudit).where(eq(s.hiringAudit.action, "resume-retention")).orderBy(s.hiringAudit.createdAt)).slice(-1);
    expect(last.detail).toEqual({ deleted: 0, failed: 0 });
  });
});

describe("source text in the dashboard", () => {
  it("derives hasSourceText, never sends the text, and fits tracker-only rows and empty-text rows", async () => {
    const withText = await seed();
    const empty = await seed({ profileText: "" });
    vi.mocked(sheets.listGoogleSheetProperties).mockResolvedValue(
      ["Sourcing Log", "Scheduling Responses"].map((title) => ({ title, sheetId: 1, rowCount: 10, columnCount: 5 })) as never,
    );
    vi.mocked(sheets.fetchGoogleSheetRange).mockImplementation((async (_e: string, _i: string, range: string) =>
      range.includes("Sourcing") ? [["Name", "Email", "Send email to invite"], ["Invented T", "t@example.com"]] : [["Name", "Email"]]) as never);
    await importMissingTracker(db, config);
    const { candidates } = await dashboard(db);
    const byEmail = (email: string) => candidates.find((c) => c.email === email)!;
    expect(byEmail(withText.email!).hasSourceText).toBe(true);
    expect(byEmail(empty.email!).hasSourceText).toBe(false);
    const tracker = byEmail("t@example.com");
    expect(tracker.hasSourceText).toBe(false);
    expect(tracker.reviewNote).toBe("Added from the tracker. No SEEK application is linked yet.");
    expect(JSON.stringify(candidates)).not.toContain("Invented profile text");
    expect(JSON.stringify(candidates)).not.toContain("workRightsConfirmed");
  });
});

describe("tracker passes", () => {
  const TABS = ["Sourcing Log", "Scheduling Responses"];
  const header = ["Timestamp", "Applicant Name", "Email Address", "Rating", "Send email to invite"];
  function tracker(rows: { sourcing?: unknown[][]; scheduling?: unknown[][] }, headerRow = 0) {
    vi.mocked(sheets.listGoogleSheetProperties).mockResolvedValue(
      [...TABS, "Recruitment Sheet"].map((title) => ({ title, sheetId: 1, rowCount: 100, columnCount: 10 })) as never,
    );
    vi.mocked(sheets.fetchGoogleSheetRange).mockImplementation((async (_email: string, _id: string, range: string) => {
      const body = range.includes("Sourcing") ? rows.sourcing : range.includes("Scheduling") ? rows.scheduling : [];
      return [...Array.from({ length: headerRow }, () => []), header, ...(body ?? [])];
    }) as never);
  }
  const person = (name: string, email: string) => ["1/11/2026", name, email, "High"];
  const writeCalls = () =>
    [
      sheets.updateGoogleSheetCell,
      sheets.updateGoogleSheetRangeValues,
      sheets.batchUpdateGoogleSheetValues,
      sheets.batchUpdateGoogleSpreadsheet,
      sheets.insertGoogleSheetRow,
      sheets.updateGoogleSheetRowValues,
      sheets.appendGoogleSheetRows,
    ].reduce((total, fn) => total + vi.mocked(fn).mock.calls.length, 0);

  it("reports counts and rows, matches by normalized email, and lists no-email rows apart", async () => {
    await seed({ email: "known@example.com" });
    tracker(
      {
        sourcing: [
          person("Invented A", "  KNOWN@Example.com "),
          person("Invented B", "b@example.com"),
          person("Invented B again", "B@example.com"),
          person("Invented C", ""),
          person("Invented D", "not an email"),
          [],
        ],
        scheduling: [person("Invented E", "e@example.com"), person("Invented F", "known@example.com")],
      },
      1,
    );
    const result = await reconcileTracker(db, config);
    expect(result.sourcing).toBe(1);
    expect(result.scheduling).toBe(1);
    expect(result.missing).toEqual([
      { sourceTab: "Sourcing Log", row: 4 },
      { sourceTab: "Scheduling Responses", row: 3 },
    ]);
    expect(result.noEmail).toEqual({ sourcing: 2, scheduling: 0 });
  });

  it("writes nothing: no row, no update, and only read calls to Sheets", async () => {
    await seed({ email: "known@example.com" });
    tracker({ sourcing: [person("Invented B", "b@example.com")], scheduling: [person("Invented E", "e@example.com")] });
    const before = await counts();
    const spies = (["insert", "update", "delete", "execute", "transaction"] as const).map((m) =>
      vi.spyOn(db as never as Record<string, (...a: unknown[]) => unknown>, m),
    );
    await reconcileTracker(db, config);
    spies.forEach((spy) => expect(spy).not.toHaveBeenCalled());
    spies.forEach((spy) => spy.mockRestore());
    expect(await counts()).toEqual(before);
    expect(writeCalls()).toBe(0);
    expect(sheets.listGoogleSheetProperties).toHaveBeenCalled();
    expect(sheets.fetchGoogleSheetRange).toHaveBeenCalled();
  });

  it("stops with a clear message when a tab or its email column is missing", async () => {
    tracker({});
    vi.mocked(sheets.listGoogleSheetProperties).mockResolvedValue([{ title: "Sourcing Log", rowCount: 5 }] as never);
    await expect(reconcileTracker(db, config)).rejects.toThrow(/Scheduling Responses/);
    tracker({});
    vi.mocked(sheets.fetchGoogleSheetRange).mockResolvedValue([["Name", "Phone"], ["A", "1"]] as never);
    await expect(reconcileTracker(db, config)).rejects.toThrow(/headers changed/i);
    tracker({});
    vi.mocked(sheets.fetchGoogleSheetRange).mockResolvedValue([["Name", "Email"], ["A", "a@example.com"]] as never);
    await expect(reconcileTracker(db, config)).rejects.toThrow(/Send email to invite/);
  });

  describe("people already emailed through the tracker", () => {
    const invited = (name: string, email: string) => [...person(name, email), "3/11/2026"];
    async function people() {
      const viewed = await seed({ stage: "new", email: "viewed@example.com" });
      const emailed = await seed({ stage: "new", email: "emailed@example.com" });
      const replied = await seed({ stage: "new", email: "replied@example.com" });
      const later = await seed({ stage: "pre_screen", email: "later@example.com" });
      const marked = await seed({ stage: "new", email: "marked@example.com", previouslyContacted: true });
      tracker({
        sourcing: [
          person("Viewed", "viewed@example.com"),
          invited("Emailed", " EMAILED@example.com "),
          invited("Later", "later@example.com"),
          invited("Marked", "marked@example.com"),
          // A name not in the app is reported as missing, not as contacted.
          invited("Unknown", "unknown@example.com"),
        ],
        scheduling: [person("Replied", "replied@example.com")],
      });
      return { viewed, emailed, replied, later, marked };
    }
    const contactedEmails = async () =>
      (await db.select().from(c).where(eq(c.previouslyContacted, true))).map((r) => r.email).sort();

    it("counts both kinds of contact at `new`, and not a view, another stage or a row already marked", async () => {
      await people();
      const before = await db.select().from(c);
      expect((await reconcileTracker(db, config)).alreadyContactedAtNew).toBe(2);
      expect(await db.select().from(c)).toEqual(before);
    });

    it("marks exactly those rows with one audit row each, changing nothing else, and a rerun marks none", async () => {
      const { emailed, replied } = await people();
      const before = new Map((await db.select().from(c)).map((r) => [r.id, r]));
      const outboxBefore = (await counts()).outbox;
      expect(await markTrackerContacted(db, config)).toBe(2);
      expect(await contactedEmails()).toEqual(["emailed@example.com", "marked@example.com", "replied@example.com"]);
      for (const row of await db.select().from(c)) {
        const changed = [emailed.id, replied.id].includes(row.id);
        expect(row).toEqual({ ...before.get(row.id), previouslyContacted: changed || before.get(row.id)!.previouslyContacted });
      }
      expect((await counts()).outbox).toBe(outboxBefore);
      const audits = await db.select().from(s.hiringAudit).where(eq(s.hiringAudit.action, "tracker-mark-contacted"));
      expect(audits.map((a) => a.actor)).toEqual(["hiring-backfill", "hiring-backfill"]);
      expect(audits.map((a) => a.candidateId).sort()).toEqual([emailed.id, replied.id].sort());
      // Idempotent.
      expect(await markTrackerContacted(db, config)).toBe(0);
      expect((await reconcileTracker(db, config)).alreadyContactedAtNew).toBe(0);
      expect(await db.select().from(s.hiringAudit).where(eq(s.hiringAudit.action, "tracker-mark-contacted"))).toHaveLength(2);
      expect(writeCalls()).toBe(0);
    });

    it("keeps a marked person out of the form queue", async () => {
      const { emailed } = await people();
      await db.update(c).set({ profileAssessment: { criteria: [], subjects: [], universities: [], summary: "" } }).where(eq(c.id, emailed.id));
      await markTrackerContacted(db, config);
      const [row] = await db.select().from(c).where(eq(c.id, emailed.id));
      expect(profileGate(row, configSchema.parse({ profileThreshold: 0 })).reasons).toContain("There was earlier contact.");
    });

    it("refuses while Automation or Messages is on", async () => {
      const { emailed } = await people();
      for (const on of [{ enabled: true }, { deliveryEnabled: true }]) {
        await db.insert(s.hiringSettings).values({ id: "default", config: configSchema.parse(on), updatedBy: "test" }).onConflictDoUpdate({ target: s.hiringSettings.id, set: { config: configSchema.parse(on) } });
        await expect(markTrackerContacted(db, config)).rejects.toThrow(/Pause live hiring/);
      }
      expect((await db.select().from(c).where(eq(c.id, emailed.id)))[0].previouslyContacted).toBe(false);
    });

    it("parses the flag", () => {
      expect(parseBackfillArgs(["--tracker-mark-contacted"], {}).mode).toBe("tracker-mark-contacted");
      expect(() => parseBackfillArgs(["--tracker-mark-contacted", "--limit", "2"], {})).toThrow(/Usage/);
    });
  });

  it("imports each missing person once, with earlier contact, review stage and no source text", async () => {
    await seed({ email: "known@example.com" });
    tracker({
      sourcing: [person("Invented B", "b@example.com"), person("Invented K", "known@example.com")],
      scheduling: [person("Invented B", "B@example.com"), person("Invented E", "e@example.com"), person("No email", "")],
    });
    expect(await importMissingTracker(db, config)).toBe(2);
    const rows = await db.select().from(c).where(sql`${c.email} in ('b@example.com','e@example.com')`);
    expect(rows).toHaveLength(2);
    for (const row of rows) {
      expect(row).toMatchObject({
        previouslyContacted: true,
        stage: "review",
        reviewNote: "Added from the tracker. No SEEK application is linked yet.",
        profileText: "",
        sourceIds: [],
        seekApplicationId: null,
        applicantId: null,
        profileAssessment: null,
        preScreen: null,
      });
    }
    expect(rows.find((r) => r.email === "b@example.com")?.name).toBe("Invented B");
    const audits = await db.select().from(s.hiringAudit).where(eq(s.hiringAudit.action, "tracker-import"));
    expect(audits.map((a) => a.actor)).toEqual(["hiring-backfill", "hiring-backfill"]);
    // A second run adds no duplicates.
    expect(await importMissingTracker(db, config)).toBe(0);
    expect(await db.select().from(c)).toHaveLength(3);
  });

  it("never makes an imported person eligible for an email", async () => {
    tracker({ sourcing: [person("Invented B", "b@example.com")] });
    await importMissingTracker(db, config);
    const [row] = await db.select().from(c).where(eq(c.email, "b@example.com"));
    const open = configSchema.parse({ enabled: true, deliveryEnabled: true, preScreenThreshold: 0 });
    expect(profileGate(row, open).eligible).toBe(false);
    expect(autoInviteEligible(row, null, open)).toBe(false);
    expect(await preScreenQueue(db, open)).toEqual([]);
    expect(await onsiteQueue(db, open)).toEqual([]);
    expect(await db.select().from(s.hiringOutbox)).toEqual([]);
    expect(writeCalls()).toBe(0);
  });

  it.each([["enabled"], ["deliveryEnabled"]])("the import refuses while %s is true", async (flag) => {
    tracker({ sourcing: [person("Invented B", "b@example.com")] });
    await setConfig({ [flag]: true });
    await expect(importMissingTracker(db, config)).rejects.toThrow(/pause/i);
    expect(await db.select().from(c)).toEqual([]);
  });

  it("a later SEEK import of the same person merges into the tracker-only row by email", async () => {
    tracker({ sourcing: [person("Invented B", "b@example.com")] });
    await importMissingTracker(db, config);
    const id = await importApplication(
      {
        applicationId: "9c1f0a52-3b1e-4c53-8a5e-0d2f6f7a1b90",
        name: "Invented B",
        email: "b@example.com",
        profileText: "Invented SEEK profile",
        resumeText: "",
        previouslyContacted: false,
        sourceStatus: "Inbox",
        workRightsAnswer: null,
      },
      db,
    );
    const rows = await db.select().from(c);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ id, stage: "review", previouslyContacted: true, sourceIds: ["9c1f0a52-3b1e-4c53-8a5e-0d2f6f7a1b90"], profileText: "Invented SEEK profile" });
  });
});
