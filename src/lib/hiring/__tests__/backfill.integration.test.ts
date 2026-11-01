import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { eq, sql } from "drizzle-orm";
import { list } from "@vercel/blob";
import { put } from "@vercel/blob/client";
import { startTestDb, stopTestDb } from "@/tests/integration/db-helper";
import { type Database } from "@/lib/db";
import * as s from "@/lib/db/schema";
import * as sheets from "@/lib/sales-dashboard/sheets";
import { configSchema } from "../model";
import { profileGate } from "../insights";
import { autoInviteEligible, onsiteQueue, preScreenQueue } from "../queue";
import { RESUME_TYPES } from "../model";
import { resumePath } from "../resume-files";
import {
  applyBackfill,
  backfillTodo,
  importApplication,
  importMissingTracker,
  reconcileTracker,
} from "../sources";
import { countOrphanResumes, createBackfillStep, parseBackfillArgs } from "../backfill";

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
    expect(await backfillTodo(db, done.sourceIds[0])).toBeNull();
    const checked = await seed();
    expect(await backfillTodo(db, checked.sourceIds[0])).not.toBeNull();
    await applyBackfill(db, checked.sourceIds[0], { workRightsAnswer: null, file: null });
    // Checked with nothing on the page: a rerun does not open it again.
    expect(await backfillTodo(db, checked.sourceIds[0])).toBeNull();
    expect(await backfillTodo(db, "unknown-application")).toBeNull();
  });

  it("skips a row whose résumé was deleted by retention", async () => {
    const row = await seed({ resumePath: null, resumeStoredAt: new Date("2025-01-01T00:00:00Z") });
    expect(await backfillTodo(db, row.sourceIds[0])).toBeNull();
    await applyBackfill(db, row.sourceIds[0], { workRightsAnswer: ACCEPTED, file: pdf() });
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

  it("does not mark the candidate checked when the upload fails, so a rerun retries", async () => {
    const row = await seed();
    vi.mocked(put).mockRejectedValueOnce(new Error("storage down"));
    await expect(applyBackfill(db, "app-1", { workRightsAnswer: ACCEPTED, file: pdf() })).rejects.toThrow();
    expect(await backfillTodo(db, "app-1")).not.toBeNull();
    expect((await load(row.id)).resumePath).toBeNull();
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
    const run = createBackfillStep({
      db,
      until: Date.parse("2026-11-02T10:00:00Z"),
      limit: null,
      pause: 10000,
      now: () => Date.parse("2026-11-02T09:00:00Z"),
      sleep,
      shouldStop: () => false,
      ...over,
    });
    return { run, sleep };
  };
  const page = () => vi.fn().mockResolvedValue({ workRightsAnswer: OTHER, file: null });

  it("reads only candidates that need it, and waits between reads", async () => {
    await seed();
    await seed();
    await seed({ workRightsAnswer: ACCEPTED, resumePath: "x", resumeStoredAt: new Date() });
    const { run, sleep } = step();
    const read = page();
    expect(await run("app-1", read)).toBe("read");
    expect(await run("app-2", read)).toBe("read");
    expect(await run("app-3", read)).toBe("skipped");
    expect(await run("not-known", read)).toBe("skipped");
    expect(read).toHaveBeenCalledTimes(2);
    // No wait before the first read; one wait before the second; none for skipped ones.
    expect(sleep).toHaveBeenCalledTimes(1);
    expect(sleep).toHaveBeenCalledWith(10000);
  });

  it("stops at the limit, at the stop time, and when asked", async () => {
    await seed();
    await seed();
    const limited = step({ limit: 1 });
    expect(await limited.run("app-1", page())).toBe("read");
    expect(await limited.run("app-2", page())).toBe("stop");
    const late = step({ now: () => Date.parse("2026-11-02T10:00:00Z") });
    expect(await late.run("app-2", page())).toBe("stop");
    const asked = step({ shouldStop: () => true });
    expect(await asked.run("app-2", page())).toBe("stop");
  });

  it("does not open the page while automation is on", async () => {
    await seed();
    await setConfig({ enabled: true });
    const read = page();
    await expect(step().run("app-1", read)).rejects.toThrow(/pause/i);
    expect(read).not.toHaveBeenCalled();
  });

  const env = { HIRING_BACKFILL_UNTIL: "2099-01-01T00:00:00Z" };
  it("accepts one mode, a limit and a stop time", () => {
    expect(parseBackfillArgs(["--seek", "--limit", "5"], env)).toMatchObject({ mode: "seek", limit: 5 });
    expect(parseBackfillArgs(["--tracker-report"], {})).toMatchObject({ mode: "tracker-report" });
    expect(parseBackfillArgs(["--tracker-import"], {})).toMatchObject({ mode: "tracker-import" });
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
  });
});

describe("tracker passes", () => {
  const TABS = ["Sourcing Log", "Scheduling Responses"];
  const header = ["Timestamp", "Applicant Name", "Email Address", "Rating"];
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
        reviewNote: "No source text",
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
