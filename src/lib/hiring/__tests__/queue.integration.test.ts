import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { eq, sql } from "drizzle-orm";
import { startTestDb, stopTestDb } from "@/tests/integration/db-helper";
import { type Database } from "@/lib/db";
import { withDatabaseTransaction } from "@/lib/db/transaction";
import * as s from "@/lib/db/schema";
import { createOutboundEmailSender } from "@/lib/email/outbound";
import {
  batchUpdateGoogleSpreadsheet,
  fetchGoogleSheetRange,
  listGoogleSheetProperties,
  updateGoogleSheetRangeValues,
} from "@/lib/sales-dashboard/sheets";
import { configSchema, HiringError, type HiringConfig } from "../model";
import { bookingView, inviteToVisit, reviewCandidate, sourceHash, type Candidate } from "../service";
import { readyToInvite } from "../insights";
import { isNewFlow, mirrorTracker, parseFormTimestamp, syncTracker } from "../sources";
import { assessCandidates, deliverOutbox, preScreenText, runHiringCycle } from "../worker";
import {
  autoInviteEligible,
  callQueue,
  moveInQueue,
  onsiteQueue,
  preScreenQueue,
  readLimitUsage,
  recordCall,
  releaseQueues,
  resetQueueOrder,
  runFollowUps,
} from "../queue";

vi.mock("../availability", () => ({ availableSlots: vi.fn(), verifyLiveSlot: vi.fn(), readLiveBusy: vi.fn(async () => { throw new Error("no Wise in tests"); }) }));
vi.mock("@/lib/email/outbound", () => ({ createOutboundEmailSender: vi.fn() }));
vi.mock("../google", () => ({ deliverCalendar: vi.fn().mockResolvedValue({ id: "calendar-event" }) }));
vi.mock("@/lib/line/client", () => ({ pushLineTextMessage: vi.fn(), LinePushError: class extends Error {} }));
vi.mock("@/lib/sales-dashboard/sheets", () => ({
  fetchGoogleSheetRange: vi.fn(),
  listGoogleSheetProperties: vi.fn(),
  batchUpdateGoogleSpreadsheet: vi.fn(),
  updateGoogleSheetRangeValues: vi.fn(),
}));

let handle: Awaited<ReturnType<typeof startTestDb>>, db: Database;
const DAY = 86400000;
// Wednesday 12:00 in Bangkok.
const now = new Date("2026-11-04T05:00:00Z");
const after = (days: number) => new Date(now.getTime() + days * DAY);
const ACCEPTED = "I have permanent work rights with no restrictions";
const config = configSchema.parse({
  enabled: true,
  deliveryEnabled: true,
  // Most suites here test the form queue alone. The call queue tests set a call score.
  callThreshold: null,
  preScreenThreshold: 50,
  interviewers: [{ canonicalKey: "Peat", email: "peat@example.com", subjects: ["Mathematics", "Physics"] }],
});
const sendEmail = vi.fn();
const ids = ["degree", "subject", "curriculum", "teaching", "english"];
const subjectRow = (subject: string) => ({ subject, evidence: subject, relevant: true });
const five = (subjects = ["Mathematics"]) => ({
  criteria: ids.map((id) => ({ id, result: "met", evidence: id, reason: "Source" })),
  subjects: subjects.map(subjectRow),
  universities: [],
  summary: "Evidence",
});
const six = (subjects = ["Mathematics"], written: "met" | "not_met" = "met") => ({
  criteria: [...ids, "written"].map((id) => ({
    id,
    result: id === "written" ? written : "met",
    evidence: id === "written" ? "Check understanding" : "Mathematics",
    reason: "Source",
  })),
  subjects: subjects.map(subjectRow),
  universities: [],
  summary: "Evidence",
});
const pre = {
  sourceRow: 2,
  submittedAt: "5/11/2026, 05:00:00",
  degree: "Bachelor's",
  field: "Mathematics",
  subjects: "Mathematics",
  curricula: "IGCSE",
  yearGroups: "Year 10",
  english: "Advanced (C1)",
  englishEvidence: "",
  experience: "5+ years",
  portfolio: "",
  availability: "Weekday Evening (17:00-21:00), Weekend Morning (before 12:00)",
  weeklyHours: "20",
  motivation: "Teaching",
  teachingApproach: "Check understanding",
};
type Values = Partial<typeof s.hiringCandidates.$inferInsert>;

beforeAll(async () => {
  handle = await startTestDb();
  db = handle.db as unknown as Database;
});
afterAll(async () => {
  if (handle) await stopTestDb(handle);
});
beforeEach(async () => {
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(now);
  vi.stubEnv("HIRING_WRITES_ENABLED", "true");
  vi.stubEnv("AUTH_SECRET", "test-secret");
  vi.stubEnv("VERCEL_ENV", "production");
  vi.clearAllMocks();
  await db.execute(
    sql`truncate hiring_recruitment_deliveries,hiring_audit,hiring_outbox,hiring_bookings,hiring_candidates,hiring_settings,progress_line_groups cascade`,
  );
  await db.insert(s.hiringSettings).values({ id: "default", config, updatedBy: "owner@example.com", workerAt: now });
  sendEmail.mockReset().mockResolvedValue({ id: "email-receipt" });
  vi.mocked(createOutboundEmailSender).mockReturnValue({ sendEmail });
  tracker();
});
afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllEnvs();
});

const setConfig = (patch: Partial<HiringConfig>) =>
  db.update(s.hiringSettings).set({ config: { ...config, ...patch } }).where(eq(s.hiringSettings.id, "default"));
const settingsConfig = async () =>
  configSchema.parse((await db.select().from(s.hiringSettings))[0].config);
let serial = 0;
async function seed(values: Values = {}) {
  serial++;
  const [row] = await db
    .insert(s.hiringCandidates)
    .values({
      name: `Applicant ${serial}`,
      email: `c${serial}@example.com`,
      profileText: `degree subject curriculum teaching english Mathematics ${serial}`,
      profileAssessment: five() as never,
      workRightsAnswer: ACCEPTED,
      ...values,
    })
    .returning();
  return row;
}
const formRow = (id: string, values: Partial<typeof s.hiringOutbox.$inferInsert> = {}) =>
  db.insert(s.hiringOutbox).values({
    key: `${id}:pre-screen`,
    candidateId: id,
    kind: "email",
    status: "sent",
    sentAt: now,
    createdAt: now,
    payload: { to: "x@example.com", subject: "s", text: "t", workflowStage: "pre_screen" },
    ...values,
  });
/** A candidate the app sent the form, who then replied for the first time. */
async function replied(values: Values = {}, sentAt = now) {
  const row = await seed({
    stage: "pre_screen",
    subjects: ["Mathematics"],
    preScreen: pre,
    preScreenAssessment: six() as never,
    preScreenRepliedAt: new Date(sentAt.getTime() + DAY),
    ...values,
  });
  await formRow(row.id, { sentAt, createdAt: sentAt });
  return row;
}
const candidate = async (id: string) =>
  (await db.select().from(s.hiringCandidates).where(eq(s.hiringCandidates.id, id)))[0];
const outbox = () => db.select().from(s.hiringOutbox);
const invites = async () => (await outbox()).filter((j) => j.key.includes(":visit-invite"));
const forms = async () => (await outbox()).filter((j) => j.key.endsWith(":pre-screen"));
const assessment = async (kind?: string) => (kind === "pre-screen" ? six() : five());

function tracker(rows: { pre?: unknown[][]; recruit?: unknown[][]; mock?: unknown[][] } = {}) {
  const preHead = Array.from({ length: 18 }, () => "");
  preHead[2] = "Contact Email";
  preHead[17] = "A student is bright but keeps losing motivation and their grades are slipping. How would you approach it?";
  const recruitHead = Array.from({ length: 20 }, () => "");
  recruitHead[0] = "Applicant ID";
  recruitHead[19] = "Paper Outcome";
  vi.mocked(listGoogleSheetProperties).mockResolvedValue(
    ["Pre-screen Responses", "Recruitment Sheet", "Mock Teaching Test Log", "Hiring Automation"].map((title) => ({
      title,
      rowCount: 100,
    })) as never,
  );
  vi.mocked(fetchGoogleSheetRange).mockImplementation(async (_email, _id, range: string) => {
    if (range.includes("Pre-screen")) return [preHead, ...(rows.pre ?? [])] as never;
    if (range.includes("Recruitment")) return [[], recruitHead, ...(rows.recruit ?? [])] as never;
    if (range.includes("Mock")) return [[], [], ...(rows.mock ?? [])] as never;
    return [] as never;
  });
}
const preRow = (email: string, submittedAt: string, answer = "Check understanding") => {
  const row = Array.from({ length: 18 }, () => "");
  Object.assign(row, {
    0: submittedAt,
    1: "Form name",
    2: email,
    3: pre.degree,
    4: pre.field,
    5: pre.subjects,
    6: pre.curricula,
    7: pre.yearGroups,
    8: pre.english,
    10: pre.experience,
    13: pre.availability,
    14: pre.weeklyHours,
    16: pre.motivation,
    17: answer,
  });
  return row;
};
const recruitRow = (email: string, outcome = "", passed = "", status = "") => {
  const row = Array.from({ length: 30 }, () => "");
  Object.assign(row, { 0: "APP-7", 1: "Tracker name", 2: email, 13: "Physics", 19: outcome, 20: passed, 26: status });
  return row;
};

describe("limits under concurrency", () => {
  it("does not exceed a limit under two concurrent releases", async () => {
    for (let i = 0; i < 8; i++) await seed();
    await setConfig({ preScreenLimits: { perDay: 5, perWeek: 15, waiting: 15, perSubject: 8 } });
    const results = await Promise.all([releaseQueues(db), releaseQueues(db)]);
    expect(results.map((r) => r.preScreen).reduce((a, b) => a + b, 0)).toBe(5);
    expect(await forms()).toHaveLength(5);
  });
  it("makes a release and a click wait for the same lock, on separate connections", async () => {
    await seed();
    // A changed response stays out of the automatic queue, so only the click takes it.
    const clicked = await replied({ preScreenResubmitted: true });
    const client = await handle.pool.connect();
    await client.query("begin");
    await client.query("select pg_advisory_xact_lock(hashtext('hiring-queue'))");
    const finished: string[] = [];
    const release = releaseQueues(db).then((r) => (finished.push("release"), r));
    const click = withDatabaseTransaction(db, (tx) => inviteToVisit(tx, clicked, config, "click-key")).then(() =>
      finished.push("click"),
    );
    await new Promise((resolve) => setTimeout(resolve, 300));
    expect(finished).toEqual([]);
    await client.query("commit");
    client.release();
    await Promise.all([release, click]);
    expect(finished.sort()).toEqual(["click", "release"]);
  });
  it("a release and a click cannot both take the last onsite place", async () => {
    await setConfig({ onsiteLimits: { perWeek: 3, unbooked: 1, perHeadPerWeek: 2, perSubject: 2 } });
    const queued = await replied();
    const clicked = await replied();
    const results = await Promise.allSettled([
      releaseQueues(db),
      withDatabaseTransaction(db, (tx) => inviteToVisit(tx, clicked, { ...config, onsiteLimits: { perWeek: 3, unbooked: 1, perHeadPerWeek: 2, perSubject: 2 } }, `${clicked.id}:click`)),
    ]);
    const sent = (await outbox()).filter((j) => j.payload.workflowStage === "onsite_invited");
    expect(sent).toHaveLength(1);
    const stages = [(await candidate(queued.id)).stage, (await candidate(clicked.id)).stage];
    expect(stages.filter((v) => v === "onsite_invited")).toHaveLength(1);
    // Whichever came second did nothing, and a refused click names the limit.
    if (results[1].status === "rejected") expect(String(results[1].reason)).toMatch(/invited, not booked/);
    else expect((results[0] as PromiseFulfilledResult<{ onsite: number }>).value.onsite).toBe(0);
  });
  it("refuses a click at a full limit, and names it", async () => {
    await setConfig({ onsiteLimits: { perWeek: 1, unbooked: 2, perHeadPerWeek: 2, perSubject: 2 } });
    const row = await replied();
    await db.insert(s.hiringOutbox).values({
      key: "other:visit-invite",
      candidateId: row.id,
      kind: "email",
      createdAt: now,
      payload: { workflowStage: "onsite_invited" },
    });
    await expect(
      withDatabaseTransaction(db, (tx) =>
        inviteToVisit(tx, row, { ...config, onsiteLimits: { perWeek: 1, unbooked: 2, perHeadPerWeek: 2, perSubject: 2 } }, "k"),
      ),
    ).rejects.toThrow(/per week/);
    expect((await candidate(row.id)).stage).toBe("pre_screen");
  });
  it("refuses a repeat invitation, a stop and a stopped candidate at the shared gate", async () => {
    const twice = await replied();
    await withDatabaseTransaction(db, (tx) => inviteToVisit(tx, twice, config, "first"));
    const invited = await candidate(twice.id);
    await expect(withDatabaseTransaction(db, (tx) => inviteToVisit(tx, invited, config, "second"))).rejects.toThrow(HiringError);
    expect((await outbox()).filter((j) => j.key === "second")).toHaveLength(0);
    const rights = await replied({ workRightsAnswer: "Other" });
    await expect(withDatabaseTransaction(db, (tx) => inviteToVisit(tx, rights, config, "k3"))).rejects.toThrow(/work-rights/);
    const paper = await replied({ stage: "paper_invited" });
    await expect(withDatabaseTransaction(db, (tx) => inviteToVisit(tx, paper, config, "k4"))).rejects.toThrow(HiringError);
    const key = await replied();
    await db.insert(s.hiringOutbox).values({ key: "taken", candidateId: key.id, kind: "email", status: "cancelled", payload: {} });
    await expect(withDatabaseTransaction(db, (tx) => inviteToVisit(tx, key, config, "taken"))).rejects.toThrow(HiringError);
    expect((await candidate(key.id)).stage).toBe("pre_screen");
  });
});

describe("usage counts", () => {
  it("counts a pending outbox row as used", async () => {
    await setConfig({ preScreenLimits: { perDay: 1, perWeek: 15, waiting: 15, perSubject: 3 } });
    const first = await seed({ stage: "pre_screen", subjects: ["Mathematics"] });
    await formRow(first.id, { status: "pending", sentAt: null });
    await seed();
    expect(await releaseQueues(db)).toEqual({ preScreen: 0, onsite: 0 });
    expect(await forms()).toHaveLength(1);
  });
  it.each([
    ["pending", 1],
    ["processing", 1],
    ["sent", 1],
    ["failed", 1],
    ["uncertain", 1],
    ["cancelled", 0],
  ] as const)("a %s form row counts as %i", async (status, count) => {
    const row = await seed({ stage: "pre_screen", subjects: ["Physics"] });
    await formRow(row.id, { status });
    const usage = await readLimitUsage(db, "pre_screen", now);
    expect([usage.perDay, usage.perWeek, usage.waiting, usage.bySubject.Physics ?? 0]).toEqual([count, count, count, count]);
  });
  it("uses Bangkok days and a Monday week from the outbox creation time, not the send time", async () => {
    const row = (createdAt: Date) =>
      seed({ stage: "no_reply" }).then((c) => formRow(c.id, { createdAt, sentAt: after(1) }));
    await row(new Date("2026-11-03T17:00:00Z")); // Wed 00:00 Bangkok: today
    await row(new Date("2026-11-03T16:59:59Z")); // Tue 23:59 Bangkok: this week
    await row(new Date("2026-11-01T17:00:00Z")); // Mon 00:00 Bangkok: this week
    await row(new Date("2026-11-01T16:59:59Z")); // Sun 23:59 Bangkok: last week
    const usage = await readLimitUsage(db, "pre_screen", now);
    expect([usage.perDay, usage.perWeek, usage.waiting]).toEqual([1, 3, 0]);
  });
  it("stops counting a form as waiting after a reply or no reply", async () => {
    const answered = await seed({ stage: "pre_screen", preScreen: pre });
    const silent = await seed({ stage: "no_reply" });
    await formRow(answered.id);
    await formRow(silent.id);
    expect((await readLimitUsage(db, "pre_screen", now)).waiting).toBe(0);
  });
  it("counts onsite places from the stage, and frees a booked place when the visit ends", async () => {
    const booking = (candidateId: string, end: Date, status: "confirmed" | "cancelled" = "confirmed") => ({
      candidateId,
      kind: "paper" as const,
      subjects: ["Mathematics"] as never,
      calendarOwner: "o@example.com",
      startTime: new Date(end.getTime() - 3600000),
      endTime: end,
      status,
      evidence: {},
    });
    await seed({ stage: "onsite_invited", visitSubject: "Mathematics" });
    const live = await seed({ stage: "onsite_booked", visitSubject: "Mathematics" });
    await db.insert(s.hiringBookings).values(booking(live.id, after(2)));
    const finished = await seed({ stage: "onsite_booked", visitSubject: "Mathematics" });
    await db.insert(s.hiringBookings).values(booking(finished.id, after(-1)));
    const cancelled = await seed({ stage: "onsite_booked", visitSubject: "Physics" });
    await db.insert(s.hiringBookings).values(booking(cancelled.id, after(2), "cancelled"));
    // Old-flow candidates use no places, though their bookings exist.
    const old = await seed({ stage: "mock_booked", visitSubject: "Mathematics" });
    await db.insert(s.hiringBookings).values(booking(old.id, after(5)));
    await seed({ stage: "paper_invited" });
    const usage = await readLimitUsage(db, "onsite", now);
    expect(usage.unbooked).toBe(1);
    expect(usage.bySubject).toEqual({ Mathematics: 2 });
  });
  it("counts an onsite send, not its reminder, and ignores a cancelled send", async () => {
    const row = await seed({ stage: "no_booking" });
    const job = (key: string, status: "sent" | "cancelled" = "sent") => ({
      key,
      candidateId: row.id,
      kind: "email" as const,
      status,
      createdAt: now,
      payload: { workflowStage: "onsite_invited" },
    });
    await db.insert(s.hiringOutbox).values([
      job(`${row.id}:visit-invite`),
      job(`${row.id}:visit-reminder:3`),
      job(`${row.id}:visit-invite:9`, "cancelled"),
    ]);
    expect((await readLimitUsage(db, "onsite", now)).perWeek).toBe(1);
  });
  it("does not count a reminder as a form send", async () => {
    const row = await seed({ stage: "pre_screen", subjects: ["Mathematics"] });
    await formRow(row.id);
    await db.insert(s.hiringOutbox).values({
      key: `${row.id}:pre-screen-reminder`,
      candidateId: row.id,
      kind: "email",
      createdAt: now,
      payload: { workflowStage: "pre_screen" },
    });
    expect((await readLimitUsage(db, "pre_screen", now)).perDay).toBe(1);
  });
});

describe("the Hiring Automation tab", () => {
  it("writes the result columns to its own tab only, and expands a tab with too few columns", async () => {
    const row = await seed();
    await db.insert(s.hiringPaperResults).values({ candidateId: row.id, subject: "Mathematics", source: "ai", status: "done", marks: { comment: "", missingPages: null, questions: [{ id: "1", level: "AP", marks: 8, max: 10, reason: "", attempted: true, readable: true }] } });
    await db.insert(s.hiringMockResults).values({ candidateId: row.id, subject: "Mathematics", source: "tracker", status: "done", history: { score: 84, outcome: "Passed", comment: "", date: null, head: "" } });
    await db.insert(s.hiringDecisions).values({ candidateId: row.id, decision: "hire", status: "sent", reason: "", emailSubject: "s", emailBody: "b", decidedBy: "a" });
    vi.mocked(listGoogleSheetProperties).mockResolvedValue([{ title: "Hiring Automation", rowCount: 2500, columnCount: 10, sheetId: 7 }] as never);
    vi.mocked(fetchGoogleSheetRange).mockResolvedValue([["Managed by Scheduling hiring automation"]] as never);
    await mirrorTracker(db, config);
    expect(vi.mocked(batchUpdateGoogleSpreadsheet).mock.calls[0][2]).toEqual([{ updateSheetProperties: { properties: { sheetId: 7, gridProperties: { columnCount: 14 } }, fields: "gridProperties.columnCount" } }]);
    const writes = vi.mocked(updateGoogleSheetRangeValues).mock.calls;
    expect(writes).toHaveLength(1);
    const [, , range, rows] = writes[0];
    expect(range).toBe("'Hiring Automation'!A1:L3");
    expect((rows[1] as string[]).slice(8)).toEqual(["Paper results", "Levels passed", "Mock score", "Decision"]);
    expect((rows[2] as string[]).slice(8)).toEqual(["Mathematics: 8/10", "Mathematics: Pass mark missing for AP", "Mathematics: 84", "Hired"]);
  });
});

describe("a person's score", () => {
  it("takes a passing reply out of the automatic visit queue, and a raised score does not bring one in", async () => {
    const form = (id: string) => ({ key: `${id}:pre-screen`, candidateId: id, kind: "email" as const, status: "sent" as const, sentAt: after(-1), payload: {} });
    const replied = { stage: "pre_screen" as const, preScreen: pre, preScreenAssessment: six() as never, preScreenRepliedAt: after(0) };
    const row = await seed(replied);
    await db.insert(s.hiringOutbox).values(form(row.id));
    expect((await onsiteQueue(db, await settingsConfig())).map((e) => e.id)).toEqual([row.id]);
    await db.update(s.hiringCandidates).set({ preScreenOverride: { score: 10, reason: "Weak", by: "o", at: "" } }).where(eq(s.hiringCandidates.id, row.id));
    expect(await onsiteQueue(db, await settingsConfig())).toEqual([]);
    expect(await releaseQueues(db)).toEqual({ preScreen: 0, onsite: 0 });
    await db.update(s.hiringCandidates).set({ preScreenOverride: { score: 99, reason: "Strong", by: "o", at: "" } }).where(eq(s.hiringCandidates.id, row.id));
    expect(await onsiteQueue(db, await settingsConfig())).toEqual([]);
    expect(await releaseQueues(db)).toEqual({ preScreen: 0, onsite: 0 });
  });
  it("the worker cycle leaves a changed score at its stage", async () => {
    const row = await seed({
      stage: "pre_screen",
      preScreen: pre,
      preScreenAssessment: six() as never,
      preScreenRepliedAt: after(0),
      preScreenOverride: { score: 99, reason: "Strong", by: "o", at: "" },
    });
    await assessCandidates(db, await settingsConfig(), async () => six());
    const [fresh] = await db.select().from(s.hiringCandidates).where(eq(s.hiringCandidates.id, row.id));
    expect(fresh.stage).toBe("pre_screen");
  });
});

describe("manual queue order", () => {
  it("sends in the dragged order, and the drag itself sends nothing and changes no stage or revision", async () => {
    await setConfig({ preScreenLimits: { perDay: 1, perWeek: 15, waiting: 15, perSubject: 3 } });
    const a = await seed({ createdAt: after(-3) });
    const b = await seed({ createdAt: after(-2) });
    const late = await seed({ createdAt: after(-1) });
    await moveInQueue(late.id, [], "owner@example.com", db);
    const [moved] = await db.select().from(s.hiringCandidates).where(eq(s.hiringCandidates.id, late.id));
    expect(moved).toMatchObject({ stage: "new", revision: late.revision });
    expect(moved.updatedAt).toEqual(late.updatedAt);
    expect(await db.select().from(s.hiringOutbox)).toEqual([]);
    const [row] = await db.select().from(s.hiringAudit).where(eq(s.hiringAudit.action, "queue-move"));
    expect(row).toMatchObject({ actor: "owner@example.com", candidateId: late.id });

    expect((await releaseQueues(db)).preScreen).toBe(1);
    expect((await forms()).map((f) => f.candidateId)).toEqual([late.id]);
    // The next day the automatic order carries on, and the person who left does not disturb it.
    vi.setSystemTime(after(1));
    await releaseQueues(db);
    expect((await forms()).map((f) => f.candidateId).sort()).toEqual([a.id, late.id].sort());
    expect((await db.select().from(s.hiringCandidates).where(eq(s.hiringCandidates.id, b.id)))[0].stage).toBe("new");
  });
  it("puts the automatic order back on a reset", async () => {
    await setConfig({ preScreenLimits: { perDay: 1, perWeek: 15, waiting: 15, perSubject: 3 } });
    const a = await seed({ createdAt: after(-3) });
    const late = await seed({ createdAt: after(-1) });
    await moveInQueue(late.id, [], "owner@example.com", db);
    await resetQueueOrder("owner@example.com", db);
    await releaseQueues(db);
    expect((await forms()).map((f) => f.candidateId)).toEqual([a.id]);
  });
  it("refuses a move for someone who has left the queue, or a list holding the person", async () => {
    const gone = await seed({ stage: "pre_screen" });
    await expect(moveInQueue(gone.id, [], "owner@example.com", db)).rejects.toMatchObject({ status: 409 });
    const here = await seed();
    await expect(moveInQueue(here.id, [here.id], "owner@example.com", db)).rejects.toMatchObject({ status: 400 });
  });
});

describe("call queue", () => {
  // five() scores 80. With English partial it scores 70.
  const seventy = () => ({ ...five(), criteria: five().criteria.map((c) => (c.id === "english" ? { ...c, result: "partial" } : c)) });
  beforeEach(() => setConfig({ callThreshold: 80 }));
  const hr = "hr@example.com";
  it("holds a score of 80 for HR's call, and sends a score of 70 at once", async () => {
    const strong = await seed();
    const middle = await seed({ profileAssessment: seventy() as never });
    expect((await callQueue(db, await settingsConfig())).map((e) => e.id)).toEqual([strong.id]);
    expect(await releaseQueues(db)).toEqual({ preScreen: 1, onsite: 0 });
    expect((await forms()).map((f) => f.candidateId)).toEqual([middle.id]);
    await recordCall(strong.id, "good", hr, db);
    expect(await callQueue(db, await settingsConfig())).toEqual([]);
    expect(await releaseQueues(db)).toEqual({ preScreen: 1, onsite: 0 });
    expect((await forms()).map((f) => f.candidateId).sort()).toEqual([strong.id, middle.id].sort());
  });
  it("orders the call queue by score, then the earlier application", async () => {
    const late = await seed({ createdAt: after(-1) });
    const early = await seed({ createdAt: after(-2) });
    const top = await seed({ universityAssessment: { fraction: 1 } as never, createdAt: after(0) });
    expect((await callQueue(db, await settingsConfig())).map((e) => e.id)).toEqual([top.id, early.id, late.id]);
  });
  it("records a no answer as a try, sends nothing, and changes no stage or revision", async () => {
    const row = await seed();
    await recordCall(row.id, "no_answer", hr, db);
    vi.setSystemTime(after(1));
    await recordCall(row.id, "no_answer", hr, db);
    const stored = await candidate(row.id);
    expect(stored).toMatchObject({ stage: "new", revision: row.revision });
    expect(stored.callReview).toEqual({ good: null, tries: [{ at: now.toISOString(), by: hr }, { at: after(1).toISOString(), by: hr }] });
    expect(await releaseQueues(db)).toEqual({ preScreen: 0, onsite: 0 });
    expect(await outbox()).toEqual([]);
    expect((await callQueue(db, await settingsConfig())).map((e) => e.id)).toEqual([row.id]);
    const actions = (await db.select().from(s.hiringAudit)).map((a) => a.action);
    expect(actions).toEqual(["call-no-answer", "call-no-answer"]);
  });
  it("refuses a call for someone who left the call queue", async () => {
    const stopped = await seed({ stage: "stopped" });
    await expect(recordCall(stopped.id, "good", hr, db)).rejects.toMatchObject({ status: 409 });
    const middle = await seed({ profileAssessment: seventy() as never });
    await expect(recordCall(middle.id, "good", hr, db)).rejects.toMatchObject({ status: 409 });
    const called = await seed();
    await recordCall(called.id, "good", hr, db);
    await expect(recordCall(called.id, "no_answer", hr, db)).rejects.toMatchObject({ status: 409 });
  });
  it("counts a hand invite past the call queue as a good call", async () => {
    const row = await seed();
    await reviewCandidate(row.id, { revision: row.revision, action: "advance", subjects: ["Mathematics"], reason: "Strong profile" }, "owner@example.com", db);
    const stored = await candidate(row.id);
    expect(stored.stage).toBe("pre_screen");
    expect(stored.callReview).toEqual({ good: { at: now.toISOString(), by: "owner@example.com", manual: true }, tries: [] });
    expect(await forms()).toHaveLength(1);
  });
  it("stops on a bad call, which is the existing Stop, and sends nothing", async () => {
    const row = await seed();
    await reviewCandidate(row.id, { revision: row.revision, action: "stop", subjects: ["Mathematics"], reason: "Bad call before the pre-screen form." }, hr, db);
    expect((await candidate(row.id)).stage).toBe("stopped");
    expect(await callQueue(db, await settingsConfig())).toEqual([]);
    expect(await releaseQueues(db)).toEqual({ preScreen: 0, onsite: 0 });
    expect(await outbox()).toEqual([]);
  });
  it("needs no call when the call score is blank", async () => {
    await setConfig({ callThreshold: null });
    await seed();
    expect(await callQueue(db, await settingsConfig())).toEqual([]);
    expect((await releaseQueues(db)).preScreen).toBe(1);
  });
});

describe("form queue", () => {
  it("queues 5 of 40 by rank then score, and queues 0 more on the same day", async () => {
    await setConfig({
      preScreenLimits: { perDay: 5, perWeek: 15, waiting: 15, perSubject: 3 },
      subjectPriority: [
        { subject: "Physics", hiring: true },
        { subject: "Mathematics", hiring: true },
        { subject: "Chemistry", hiring: false },
      ],
    });
    for (let i = 0; i < 4; i++) await seed({ profileAssessment: five(["Physics"]) as never });
    for (let i = 0; i < 2; i++) await seed({ profileAssessment: five(["Chemistry"]) as never });
    for (let i = 0; i < 34; i++) await seed();
    expect(await preScreenQueue(db, await settingsConfig())).toHaveLength(38);
    expect(await releaseQueues(db)).toEqual({ preScreen: 5, onsite: 0 });
    const released = await db.select().from(s.hiringCandidates).where(eq(s.hiringCandidates.stage, "pre_screen"));
    expect(released).toHaveLength(5);
    // Physics ranks first, at its subject limit of 3. Chemistry is not hiring.
    expect(released.filter((c) => c.subjects[0] === "Physics")).toHaveLength(3);
    expect(released.filter((c) => c.subjects[0] === "Mathematics")).toHaveLength(2);
    expect(await releaseQueues(db)).toEqual({ preScreen: 0, onsite: 0 });
    expect(await forms()).toHaveLength(5);
    // The next Bangkok day has room again, but each subject still holds its open places (3 Physics, 2 of 3 Mathematics).
    vi.setSystemTime(new Date("2026-11-04T17:00:00Z"));
    expect((await releaseQueues(db)).preScreen).toBe(1);
  });
  it("does not repeat a form email", async () => {
    const row = await seed();
    expect((await releaseQueues(db)).preScreen).toBe(1);
    expect((await releaseQueues(db)).preScreen).toBe(0);
    // A stage put back by hand does not send it again.
    await db.update(s.hiringCandidates).set({ stage: "new" }).where(eq(s.hiringCandidates.id, row.id));
    expect((await releaseQueues(db)).preScreen).toBe(0);
    expect(await preScreenQueue(db, config)).toEqual([]);
    // A cancelled form also stays out: only a person can send it again.
    await db.update(s.hiringOutbox).set({ status: "cancelled" }).where(eq(s.hiringOutbox.candidateId, row.id));
    expect(await preScreenQueue(db, config)).toEqual([]);
    expect((await releaseQueues(db)).preScreen).toBe(0);
    const rows = await forms();
    expect(rows.map((j) => j.key)).toEqual([`${row.id}:pre-screen`]);
    expect(rows[0].payload.text).toContain("docs.google.com/forms");
  });
  it("only stage new enters the form queue", async () => {
    const paused = await seed();
    for (const stage of ["review", "stopped", "pre_screen", "paper_invited", "no_reply", "no_booking"] as const)
      await seed({ stage });
    await seed({ previouslyContacted: true });
    await seed({ preScreen: pre });
    await seed({ email: null });
    await seed({ workRightsAnswer: null });
    await seed({ profileAssessment: null });
    const queue = await preScreenQueue(db, config);
    expect(queue.map((e) => e.id)).toEqual([paused.id]);
  });
  it("releases nothing unless automation, delivery, the rubric and the write gate all allow it", async () => {
    await seed();
    await setConfig({ enabled: false });
    expect((await releaseQueues(db)).preScreen).toBe(0);
    await setConfig({ deliveryEnabled: false });
    expect((await releaseQueues(db)).preScreen).toBe(0);
    await setConfig({ rubricApproved: false });
    expect((await releaseQueues(db)).preScreen).toBe(0);
    await setConfig({});
    vi.stubEnv("HIRING_WRITES_ENABLED", "false");
    expect((await releaseQueues(db)).preScreen).toBe(0);
    expect(await outbox()).toEqual([]);
  });
  it("sends nothing and changes no stage while assessing", async () => {
    const row = await seed({ profileAssessment: null });
    await assessCandidates(db, config, async () => five());
    expect((await candidate(row.id)).stage).toBe("new");
    expect(await outbox()).toEqual([]);
    const low = await seed({ profileAssessment: null, previouslyContacted: true });
    await assessCandidates(db, config, async () => five());
    expect((await candidate(low.id)).stage).toBe("review");
    expect(await outbox()).toEqual([]);
  });
  it("adds no row over four days while delivery is paused, and starts at the daily limit on resume", async () => {
    await setConfig({ deliveryEnabled: false });
    for (let i = 0; i < 8; i++) await seed();
    const waiting = await replied();
    const before = await outbox();
    for (let day = 0; day < 4; day++) {
      vi.setSystemTime(after(day));
      expect(await releaseQueues(db)).toEqual({ preScreen: 0, onsite: 0 });
      expect(await runFollowUps(db)).toEqual({ reminded: 0, expired: 0 });
      expect(await runHiringCycle(db, (_s, _k, kind) => assessment(kind))).toMatchObject({ preScreen: 0, onsite: 0, reminded: 0, expired: 0 });
    }
    expect(await outbox()).toEqual(before);
    expect((await candidate(waiting.id)).stage).toBe("pre_screen");
    await setConfig({ preScreenLimits: { perDay: 5, perWeek: 15, waiting: 15, perSubject: 8 } });
    expect(await releaseQueues(db)).toEqual({ preScreen: 5, onsite: 1 });
  });
});

describe("follow-ups", () => {
  it("reminds once on day 3 and marks no reply on day 7", async () => {
    const row = await seed({ stage: "pre_screen", subjects: ["Mathematics"] });
    await formRow(row.id);
    vi.setSystemTime(after(2.9));
    expect(await runFollowUps(db)).toEqual({ reminded: 0, expired: 0 });
    vi.setSystemTime(after(3));
    expect(await runFollowUps(db)).toEqual({ reminded: 1, expired: 0 });
    expect(await runFollowUps(db)).toEqual({ reminded: 0, expired: 0 });
    await db.update(s.hiringCandidates).set({ revision: 9 }).where(eq(s.hiringCandidates.id, row.id));
    expect(await runFollowUps(db)).toEqual({ reminded: 0, expired: 0 });
    const reminders = (await outbox()).filter((j) => j.key === `${row.id}:pre-screen-reminder`);
    expect(reminders).toHaveLength(1);
    expect(reminders[0].payload.workflowStage).toBe("pre_screen");
    vi.setSystemTime(after(7));
    expect(await runFollowUps(db)).toEqual({ reminded: 0, expired: 1 });
    expect((await candidate(row.id)).stage).toBe("no_reply");
    expect((await readLimitUsage(db, "pre_screen", after(7))).waiting).toBe(0);
    // The stage change cancels the unsent reminder.
    await deliverOutbox(db, config);
    expect(sendEmail).not.toHaveBeenCalled();
    expect((await outbox()).find((j) => j.key.endsWith("reminder"))?.status).toBe("cancelled");
    expect(await runFollowUps(db)).toEqual({ reminded: 0, expired: 0 });
  });
  it("sends no form reminder after a person contacted the candidate in SEEK, and still marks no reply", async () => {
    const row = await seed({ stage: "pre_screen", previouslyContacted: true });
    await formRow(row.id);
    vi.setSystemTime(after(3));
    expect(await runFollowUps(db)).toEqual({ reminded: 0, expired: 0 });
    vi.setSystemTime(after(7));
    expect(await runFollowUps(db)).toEqual({ reminded: 0, expired: 1 });
  });
  it.each(["failed", "uncertain"] as const)("frees the place of a %s form row after the expiry days, with no reminder", async (status) => {
    const row = await seed({ stage: "pre_screen", subjects: ["Mathematics"] });
    await formRow(row.id, { status, sentAt: null, firstAttemptAt: now });
    vi.setSystemTime(after(3));
    expect(await runFollowUps(db)).toEqual({ reminded: 0, expired: 0 });
    vi.setSystemTime(after(6.9));
    expect(await runFollowUps(db)).toEqual({ reminded: 0, expired: 0 });
    expect((await readLimitUsage(db, "pre_screen", after(6.9))).waiting).toBe(1);
    vi.setSystemTime(after(7));
    expect(await runFollowUps(db)).toEqual({ reminded: 0, expired: 1 });
    expect((await candidate(row.id)).stage).toBe("no_reply");
    expect((await readLimitUsage(db, "pre_screen", after(7))).waiting).toBe(0);
    // The clock runs from the first attempt, and the stage change cancels the row before it can leave.
    await db.update(s.hiringOutbox).set({ nextAttemptAt: null });
    await deliverOutbox(db, config);
    expect(sendEmail).not.toHaveBeenCalled();
  });
  it("holds no clock on a pending form row, or on a failed row with no first attempt", async () => {
    const pending = await seed({ stage: "pre_screen" });
    await formRow(pending.id, { status: "pending", sentAt: null, firstAttemptAt: now });
    const unattempted = await seed({ stage: "pre_screen" });
    await formRow(unattempted.id, { status: "failed", sentAt: null, firstAttemptAt: null });
    vi.setSystemTime(after(30));
    expect(await runFollowUps(db)).toEqual({ reminded: 0, expired: 0 });
    expect((await candidate(pending.id)).stage).toBe("pre_screen");
    expect((await candidate(unattempted.id)).stage).toBe("pre_screen");
  });
  it("does not start the follow-up clock until sentAt", async () => {
    const row = await seed({ stage: "pre_screen" });
    await formRow(row.id, { status: "pending", sentAt: null, createdAt: after(-30) });
    expect(await runFollowUps(db)).toEqual({ reminded: 0, expired: 0 });
    expect((await candidate(row.id)).stage).toBe("pre_screen");
    // Delivery paused: no reminder and no expiry, even on an old sent form or link.
    const sent = await seed({ stage: "pre_screen" });
    await formRow(sent.id, { sentAt: after(-30) });
    await setConfig({ deliveryEnabled: false });
    expect(await runFollowUps(db)).toEqual({ reminded: 0, expired: 0 });
    expect((await candidate(sent.id)).stage).toBe("pre_screen");
    await setConfig({ deliveryEnabled: true, enabled: false });
    expect(await runFollowUps(db)).toEqual({ reminded: 0, expired: 0 });
    await setConfig({});
    expect(await runFollowUps(db)).toEqual({ reminded: 0, expired: 1 });
    // An unsent onsite link has no clock.
    const unsent = await replied();
    expect((await releaseQueues(db)).onsite).toBe(1);
    vi.setSystemTime(after(30));
    await runFollowUps(db);
    expect((await candidate(unsent.id)).stage).toBe("onsite_invited");
  });
  it("frees the place when the onsite link expires and clears the link", async () => {
    await setConfig({ onsiteLimits: { perWeek: 3, unbooked: 1, perHeadPerWeek: 2, perSubject: 2 } });
    const row = await replied();
    const waiting = await replied({}, now);
    expect((await releaseQueues(db)).onsite).toBe(1);
    const invited = (await Promise.all([row, waiting].map((c) => candidate(c.id)))).find((c) => c.stage === "onsite_invited")!;
    const held = invited.id === row.id ? waiting : row;
    expect(invited.visitSubject).toBe("Mathematics");
    await deliverOutbox(db, await settingsConfig());
    const [job] = await invites();
    expect(job.key).toBe(`${invited.id}:visit-invite`);
    expect(job.sentAt).not.toBeNull();
    const text = String(job.payload.text);
    expect(job.payload.workflowStage).toBe("onsite_invited");
    expect(text).toMatch(/3 hours/);
    expect(text).toMatch(/2-hour exam/);
    expect(text).toMatch(/1-hour mock/);
    expect(text).toContain("Mathematics");
    expect(text).toContain("https://lin.ee/OjMHF41");
    expect(text).toMatch(/IGCSE topic/);
    // The link: a fixed 30-day life, and the same second on the row and in the token.
    const token = text.match(/\/hiring\/book\/([\w.-]+)/)![1];
    const payload = JSON.parse(Buffer.from(token.split(".")[0], "base64url").toString());
    expect(payload).toMatchObject({ id: invited.id, kind: "visit" });
    expect(invited.inviteExpiresAt!.getTime()).toBe(payload.exp * 1000);
    expect(payload.exp * 1000).toBe(Math.floor(now.getTime() / 1000) * 1000 + 30 * DAY);
    // The old paper and mock routes do not accept it.
    await expect(bookingView(token, undefined, db, now)).rejects.toThrow(HiringError);
    // Day 3: one reminder with the same link, once for this link even if the revision moves.
    vi.setSystemTime(after(3));
    expect(await runFollowUps(db)).toEqual({ reminded: 1, expired: 0 });
    await db.update(s.hiringCandidates).set({ revision: 99 }).where(eq(s.hiringCandidates.id, invited.id));
    expect(await runFollowUps(db)).toEqual({ reminded: 0, expired: 0 });
    const reminder = (await outbox()).find((j) => j.key.includes("visit-reminder"))!;
    expect(reminder.key).toBe(`${invited.id}:visit-reminder:${invited.revision}`);
    expect(reminder.payload.workflowStage).toBe("onsite_invited");
    expect(reminder.payload.text).toContain(token);
    // Day 7: no booking, the link is gone and the place is free for the next person.
    vi.setSystemTime(after(7));
    expect(await runFollowUps(db)).toEqual({ reminded: 0, expired: 1 });
    const expired = await candidate(invited.id);
    expect(expired.stage).toBe("no_booking");
    expect(expired.inviteExpiresAt).toBeNull();
    expect((await readLimitUsage(db, "onsite", after(7))).unbooked).toBe(0);
    expect((await releaseQueues(db)).onsite).toBe(1);
    expect((await candidate(held.id)).stage).toBe("onsite_invited");
    // No second link without a click.
    expect((await candidate(invited.id)).stage).toBe("no_booking");
    expect((await invites()).filter((j) => j.candidateId === invited.id)).toHaveLength(1);
  });
});
describe("university result on a live reply", () => {
  const catalog = sourceHash(config.universities);
  const stored = { name: "Stored", country: "US", rank: 5, edition: "e", fraction: 0.75, reason: "r", sources: [], catalogHash: catalog };
  const inCatalog = config.universities.find((u) => u.rank)!;
  // A live reply: the app sent the form, then the reply came.
  const scored = async (values: Values) => {
    const row = await seed({ stage: "pre_screen", subjects: ["Mathematics"], preScreen: pre, preScreenRepliedAt: now, previouslyContacted: true, ...values });
    await formRow(row.id, { sentAt: after(-1) });
    return row;
  };
  const assess = async (_s: string, _k: string, kind?: string) => assessment(kind);
  it("keeps the stored fraction when the reply's assessment lists no university", async () => {
    const row = await scored({ universityAssessment: stored });
    await assessCandidates(db, config, assess);
    const saved = await candidate(row.id);
    expect(saved.preScreenAssessment).not.toBeNull();
    expect(saved.universityAssessment).toEqual(stored);
  });
  it("recomputes a stale catalog result from the profile, not from the reply", async () => {
    const row = await scored({
      universityAssessment: { ...stored, catalogHash: "old" },
      profileAssessment: {
        ...five(),
        universities: [{ name: inCatalog.name, evidence: inCatalog.name, completedDegree: true }],
      } as never,
    });
    await assessCandidates(db, config, assess);
    const saved = await candidate(row.id);
    expect(saved.universityAssessment).toMatchObject({ name: inCatalog.name, catalogHash: catalog });
    expect(saved.universityAssessment!.fraction).toBeGreaterThan(0);
  });
  it("computes a missing result from the profile too", async () => {
    const row = await scored({
      profileAssessment: {
        ...five(),
        universities: [{ name: inCatalog.name, evidence: inCatalog.name, completedDegree: true }],
      } as never,
    });
    await assessCandidates(db, config, assess);
    expect((await candidate(row.id)).universityAssessment).toMatchObject({ name: inCatalog.name, catalogHash: catalog });
  });
  it("falls back to the reply's universities only when there is no profile assessment", async () => {
    const row = await scored({ profileAssessment: null });
    await assessCandidates(db, config, assess);
    expect((await candidate(row.id)).universityAssessment).toMatchObject({ name: null, fraction: 0, catalogHash: catalog });
  });
});

describe("reply rule", () => {
  it("a first reply after the app send queues automatically", async () => {
    const row = await seed({ stage: "pre_screen", subjects: ["Mathematics"] });
    await formRow(row.id, { sentAt: after(-1) });
    tracker({ pre: [preRow(row.email!, "4/11/2026, 05:00:00")] });
    const result = await runHiringCycle(db, (_s, _k, kind) => assessment(kind));
    const after1 = await candidate(row.id);
    expect(after1.preScreenRepliedAt?.toISOString()).toBe("2026-11-04T05:00:00.000Z");
    expect(after1.preScreenAssessment).not.toBeNull();
    expect(after1.preScreenResubmitted).toBe(false);
    expect(after1.stage).toBe("onsite_invited");
    expect(after1.visitSubject).toBe("Mathematics");
    expect(result).toMatchObject({ preScreen: 0, onsite: 1 });
    expect(await invites()).toHaveLength(1);
  });
  it("runs a cycle in order: a place freed by follow-ups is used in the same cycle", async () => {
    await setConfig({ onsiteLimits: { perWeek: 3, unbooked: 1, perHeadPerWeek: 2, perSubject: 2 } });
    const old = await seed({ stage: "onsite_invited", visitSubject: "Mathematics", inviteExpiresAt: after(30) });
    await db.insert(s.hiringOutbox).values({
      key: `${old.id}:visit-invite`,
      candidateId: old.id,
      kind: "email",
      status: "sent",
      sentAt: after(-8),
      createdAt: after(-8),
      payload: { workflowStage: "onsite_invited", revision: 0 },
    });
    const next = await replied({ preScreenAssessment: null, preScreenHash: null });
    const result = await runHiringCycle(db, (_s, _k, kind) => assessment(kind));
    expect(result).toMatchObject({ expired: 1, onsite: 1 });
    expect((await candidate(old.id)).stage).toBe("no_booking");
    expect((await candidate(next.id)).stage).toBe("onsite_invited");
  });
  it("a late reply on no_reply is scored", async () => {
    const row = await seed({ stage: "no_reply", subjects: ["Mathematics"] });
    await formRow(row.id, { sentAt: after(-10) });
    tracker({ pre: [preRow(row.email!, "4/11/2026, 05:00:00")] });
    const assess = vi.fn(async (_s: string, _k: string, kind?: string) => assessment(kind));
    await runHiringCycle(db, assess);
    expect(assess).toHaveBeenCalledWith(expect.any(String), expect.stringContaining(":pre:"), "pre-screen", expect.any(String));
    const after1 = await candidate(row.id);
    expect(after1.preScreenAssessment).not.toBeNull();
    expect(after1.stage).toBe("onsite_invited");
  });
  it("keeps a no_reply row unscored when its form was never confirmed sent", async () => {
    const row = await seed({ stage: "no_reply", subjects: ["Mathematics"] });
    await formRow(row.id, { status: "uncertain", sentAt: null });
    tracker({ pre: [preRow(row.email!, "4/11/2026, 05:00:00")] });
    const assess = vi.fn(async (_s: string, _k: string, kind?: string) => assessment(kind));
    await runHiringCycle(db, assess);
    expect(assess).not.toHaveBeenCalled();
    const saved = await candidate(row.id);
    expect([saved.stage, saved.preScreenAssessment, saved.preScreen === null]).toEqual(["no_reply", null, false]);
  });
  it("cancels an unsent reminder when the reply arrives", async () => {
    const row = await seed({ stage: "pre_screen" });
    await formRow(row.id, { sentAt: after(-4) });
    await runFollowUps(db);
    tracker({ pre: [preRow(row.email!, "4/11/2026, 05:00:00")] });
    await syncTracker(db, config);
    expect((await outbox()).find((j) => j.key.endsWith("reminder"))?.status).toBe("cancelled");
    expect((await forms())[0].status).toBe("sent");
  });
  it("requires a click for: no app send, a stopped candidate, a resubmission, a time before the send, an unparsable time", async () => {
    const sent = after(-1);
    const c = (values: Partial<Candidate>) => ({
      stage: "pre_screen",
      email: "a@example.com",
      previouslyContacted: false,
      preScreen: pre,
      preScreenAssessment: six(),
      preScreenRepliedAt: now,
      preScreenResubmitted: false,
      workRightsAnswer: ACCEPTED,
      universityAssessment: null,
      ...values,
    }) as unknown as Candidate;
    expect(autoInviteEligible(c({}), sent, config)).toBe(true);
    expect(autoInviteEligible(c({ stage: "no_reply" }), sent, config)).toBe(true);
    expect(autoInviteEligible(c({}), null, config)).toBe(false);
    for (const stage of ["stopped", "review", "new", "no_booking", "onsite_invited", "paper_invited"] as const)
      expect(autoInviteEligible(c({ stage }), sent, config)).toBe(false);
    expect(autoInviteEligible(c({ preScreenResubmitted: true }), sent, config)).toBe(false);
    expect(autoInviteEligible(c({ preScreenRepliedAt: after(-2) }), sent, config)).toBe(false);
    expect(autoInviteEligible(c({ preScreenRepliedAt: null }), sent, config)).toBe(false);
    expect(autoInviteEligible(c({ previouslyContacted: true }), sent, config)).toBe(false);
    expect(parseFormTimestamp("next Tuesday")).toBeNull();
    expect(parseFormTimestamp("29/9/2026, 14:38:38")?.toISOString()).toBe("2026-09-29T14:38:38.000Z");
    // The same cases through the tracker and the worker: nothing is invited.
    const unsent = await seed({ stage: "new" });
    const stopped = await seed({ stage: "stopped" });
    await formRow(stopped.id, { sentAt: after(-1) });
    const early = await seed({ stage: "pre_screen" });
    await formRow(early.id, { sentAt: after(-1) });
    const unreadable = await seed({ stage: "pre_screen" });
    await formRow(unreadable.id, { sentAt: after(-1) });
    const resubmit = await replied({ preScreen: { ...pre, submittedAt: "3/11/2026, 05:00:00" } }, after(-2));
    tracker({
      pre: [
        preRow(unsent.email!, "4/11/2026, 05:00:00"),
        preRow(stopped.email!, "4/11/2026, 05:00:00"),
        preRow(early.email!, "1/11/2026, 05:00:00"),
        preRow(unreadable.email!, "yesterday"),
        preRow(resubmit.email!, "4/11/2026, 05:00:00", "Check understanding again"),
      ],
    });
    const result = await runHiringCycle(db, (_s, _k, kind) => assessment(kind));
    expect(result).toMatchObject({ onsite: 0 });
    expect(await invites()).toEqual([]);
    // A response with no app send, or older than the send, or with no readable time, is not scored and keeps its stage.
    for (const [row, stage] of [[unsent, "new"], [stopped, "stopped"], [early, "pre_screen"], [unreadable, "pre_screen"]] as const) {
      const saved = await candidate(row.id);
      expect([saved.stage, saved.preScreenAssessment]).toEqual([stage, null]);
    }
    expect((await candidate(unreadable.id)).preScreenRepliedAt).toBeNull();
    const again = await candidate(resubmit.id);
    expect(again.preScreenResubmitted).toBe(true);
    expect(again.stage).toBe("review");
  });
  it("matches a form by email and announces its completion only once", async () => {
    await setConfig({ recruitmentLineGroupId: "C" + "1".repeat(32) });
    const row = await seed({ stage: "pre_screen", email: "mixed@example.com" });
    await formRow(row.id, { sentAt: after(-1) });
    tracker({ pre: [preRow("  MiXeD@Example.COM ", "4/11/2026, 05:00:00")] });
    await syncTracker(db, config);
    const saved = await candidate(row.id);
    expect(saved.preScreen).not.toBeNull();
    expect(saved.preScreenRepliedAt).not.toBeNull();
    expect(await db.select().from(s.hiringCandidates)).toHaveLength(1);
    await syncTracker(db, config);
    tracker({ pre: [preRow(row.email!, "4/11/2026, 06:00:00", "Changed answer")] });
    await syncTracker(db, config);
    const notices = await db.select().from(s.hiringRecruitmentDeliveries);
    expect(notices).toHaveLength(1);
    expect(notices[0]).toMatchObject({ notice: "form_completed", message: expect.stringContaining(row.name) });
  });
  it("repairs an unchanged serial response, assesses it and queues one invitation and form notice", async () => {
    await setConfig({ recruitmentLineGroupId: "C" + "1".repeat(32) });
    const timestamp = "46335.31536583333";
    const row = await seed({ stage: "pre_screen" });
    await formRow(row.id, { sentAt: after(-1) });
    tracker({ pre: [preRow(row.email!, timestamp)] });
    await syncTracker(db, config);
    // Reproduce the already-imported production row whose timestamp could not be parsed.
    await db.delete(s.hiringRecruitmentDeliveries);
    await db.update(s.hiringCandidates).set({ preScreenRepliedAt: null }).where(eq(s.hiringCandidates.id, row.id));
    const result = await runHiringCycle(db, (_s, _k, kind) => assessment(kind));
    expect(result.onsite).toBe(1);
    const saved = await candidate(row.id);
    expect(saved.preScreenRepliedAt?.toISOString()).toBe("2026-11-09T07:34:07.608Z");
    expect(saved.preScreenResubmitted).toBe(false);
    expect(saved.preScreenAssessment).not.toBeNull();
    expect(saved.stage).toBe("onsite_invited");
    await runHiringCycle(db, (_s, _k, kind) => assessment(kind));
    expect(await invites()).toHaveLength(1);
    expect(await forms()).toHaveLength(1);
    expect(await db.select().from(s.hiringRecruitmentDeliveries)).toHaveLength(1);
  });
  it("does not call a moved sheet row a resubmission", async () => {
    const row = await replied({ preScreen: { ...pre, submittedAt: "4/11/2026, 05:00:00", sourceRow: 9 } });
    tracker({ pre: [preRow(row.email!, "4/11/2026, 05:00:00")] });
    await syncTracker(db, config);
    const saved = await candidate(row.id);
    expect(saved.preScreen!.sourceRow).toBe(2);
    expect(saved.preScreenResubmitted).toBe(false);
  });
  it("does not invite again after an earlier invitation, and still invites the others", async () => {
    const earlier = await replied();
    await db.insert(s.hiringOutbox).values({
      key: `${earlier.id}:visit-invite`,
      candidateId: earlier.id,
      kind: "email",
      status: "cancelled",
      payload: { workflowStage: "onsite_invited" },
    });
    const other = await replied();
    expect((await onsiteQueue(db, config)).map((e) => e.id)).toEqual([other.id]);
    expect((await releaseQueues(db)).onsite).toBe(1);
    expect((await candidate(earlier.id)).stage).toBe("pre_screen");
    expect((await candidate(other.id)).stage).toBe("onsite_invited");
  });
  it("keeps the candidate waiting when the pass score is empty", async () => {
    await setConfig({ preScreenThreshold: null });
    const row = await replied({ preScreenAssessment: null });
    const result = await runHiringCycle(db, (_s, _k, kind) => assessment(kind));
    expect(result).toMatchObject({ onsite: 0 });
    const saved = await candidate(row.id);
    expect(saved.stage).toBe("pre_screen");
    expect(saved.preScreenAssessment).not.toBeNull();
    expect(await invites()).toEqual([]);
    expect(await onsiteQueue(db, await settingsConfig())).toEqual([]);
    // Once Kevin sets the score, the next cycle invites.
    await setConfig({ preScreenThreshold: 50 });
    expect((await releaseQueues(db)).onsite).toBe(1);
  });
  it("moves a low score or a stop to review with the reason, and sends nothing", async () => {
    await setConfig({ preScreenThreshold: 95 });
    const low = await replied({ preScreenAssessment: null, preScreenHash: null });
    const stop = await replied({ preScreenAssessment: null, preScreenHash: null, preScreen: { ...pre, degree: "Below Bachelor's" } });
    await runHiringCycle(db, (_s, _k, kind) => assessment(kind));
    const a = await candidate(low.id);
    expect([a.stage, a.reviewNote]).toEqual(["review", expect.stringMatching(/below the pass score/)]);
    const b = await candidate(stop.id);
    expect([b.stage, b.reviewNote]).toEqual(["review", expect.stringMatching(/bachelor/i)]);
    expect(await invites()).toEqual([]);
  });
  it("never asks the model about a response that answers no app send", async () => {
    const old = await seed({ stage: "review", preScreen: pre, preScreenRepliedAt: now, reviewNote: "Tracker state: Awaiting Review." });
    // The form went out after this response arrived.
    const early = await seed({ stage: "pre_screen", preScreen: pre, preScreenRepliedAt: after(-2) });
    await formRow(early.id, { sentAt: after(-1) });
    const assess = vi.fn(async (_s: string, _k: string, kind?: string) => assessment(kind));
    await assessCandidates(db, config, assess);
    expect(assess).not.toHaveBeenCalled();
    for (const [row, stage] of [[old, "review"], [early, "pre_screen"]] as const) {
      const saved = await candidate(row.id);
      expect([saved.stage, saved.preScreenAssessment, saved.preScreenHash, saved.revision]).toEqual([stage, null, null, row.revision]);
    }
  });
  it("leaves a human note on a review candidate who holds a response", async () => {
    const row = await seed({ stage: "review", preScreen: pre, preScreenRepliedAt: now, reviewNote: "Human note" });
    await formRow(row.id, { sentAt: after(-1) });
    await assessCandidates(db, config, async (_s, _k, kind) => assessment(kind));
    const saved = await candidate(row.id);
    expect(saved.preScreenAssessment).not.toBeNull();
    expect([saved.stage, saved.reviewNote]).toEqual(["review", "Human note"]);
    expect((await outbox()).map((o) => o.key)).toEqual([`${row.id}:pre-screen`]);
  });
  it("sets the highest-ranked hiring, supported, unstopped subject, and counts that subject only", async () => {
    await setConfig({
      subjectPriority: [
        { subject: "Chemistry", hiring: false },
        { subject: "EFL/ESL", hiring: true },
        { subject: "Biology", hiring: true },
        { subject: "Physics", hiring: true },
        { subject: "Mathematics", hiring: true },
      ],
    });
    // Chemistry is not hiring. EFL/ESL needs C1 and this form says B2. Biology has no assessment support.
    const row = await replied({
      preScreen: { ...pre, english: "Upper-Intermediate (B2)", subjects: "Chemistry, EFL/ESL, Biology, Physics, Mathematics" },
      preScreenAssessment: six(["Chemistry", "EFL/ESL", "Physics", "Mathematics"]) as never,
    });
    await releaseQueues(db);
    const saved = await candidate(row.id);
    expect(saved.visitSubject).toBe("Physics");
    expect((await readLimitUsage(db, "onsite", now)).bySubject).toEqual({ Physics: 1 });
  });
  it("waits on a not-hiring result, and invites without a stage change when the subject opens", async () => {
    await setConfig({ subjectPriority: [{ subject: "Mathematics", hiring: false }] });
    const row = await replied({ preScreenHash: null, preScreenAssessment: null });
    await runHiringCycle(db, (_s, _k, kind) => assessment(kind));
    expect((await candidate(row.id)).stage).toBe("pre_screen");
    expect(await onsiteQueue(db, await settingsConfig())).toEqual([]);
    expect(await invites()).toEqual([]);
    const assess = vi.fn(async (_s: string, _k: string, kind?: string) => assessment(kind));
    await setConfig({});
    await runHiringCycle(db, assess);
    expect(assess).not.toHaveBeenCalled();
    expect((await candidate(row.id)).stage).toBe("onsite_invited");
  });
  it("still moves a low score to review when the subject is not hiring", async () => {
    await setConfig({ preScreenThreshold: 95, subjectPriority: [{ subject: "Mathematics", hiring: false }] });
    const row = await replied({ preScreenHash: null, preScreenAssessment: null });
    await runHiringCycle(db, (_s, _k, kind) => assessment(kind));
    expect((await candidate(row.id)).reviewNote).toMatch(/below the pass score/);
  });
  it("sends a candidate with no supported subject to review, not the onsite queue", async () => {
    const unsupported = { ...six(), subjects: [{ subject: "Mathematics", evidence: "Mathematics", relevant: false }] };
    const row = await replied({ preScreenHash: null, preScreenAssessment: null });
    await runHiringCycle(db, async () => unsupported);
    const saved = await candidate(row.id);
    expect(saved.stage).toBe("review");
    expect(saved.reviewNote).toMatch(/supported/);
    expect(await invites()).toEqual([]);
  });
  it("keeps the visit subject to a subject with a head, and waits when none has one", async () => {
    await setConfig({
      subjectPriority: [
        { subject: "Biology", hiring: true },
        { subject: "Mathematics", hiring: true },
      ],
    });
    const both = await replied({
      preScreen: { ...pre, subjects: "Biology, Mathematics" },
      preScreenAssessment: six(["Biology", "Mathematics"]) as never,
    });
    const biology = await replied({
      preScreen: { ...pre, subjects: "Biology" },
      preScreenAssessment: null,
    });
    await runHiringCycle(db, async (source) =>
      six(source.includes("Biology, Mathematics") ? ["Biology", "Mathematics"] : ["Biology"]),
    );
    expect((await candidate(both.id)).visitSubject).toBe("Mathematics");
    const waiting = await candidate(biology.id);
    expect(waiting.stage).toBe("pre_screen");
    expect(waiting.visitSubject).toBeNull();
    expect((await invites()).map((j) => j.candidateId)).toEqual([both.id]);
    // A click cannot spend a link on a page with no slots either.
    const current = await settingsConfig();
    await expect(withDatabaseTransaction(db, (tx) => inviteToVisit(tx, waiting, current, "click"))).rejects.toThrow(/subject/);
    // Adding a head cures it, on the next cycle, with no model call.
    const assess = vi.fn(async () => six(["Biology"]));
    await setConfig({
      subjectPriority: current.subjectPriority,
      interviewers: [...current.interviewers, { canonicalKey: "Gift", email: "gift@example.com", subjects: ["Biology"] }],
    });
    await runHiringCycle(db, assess);
    expect(assess).not.toHaveBeenCalled();
    const invited = await candidate(biology.id);
    expect([invited.stage, invited.visitSubject]).toEqual(["onsite_invited", "Biology"]);
  });
  it("counts a subject missing from the saved list as not hiring, for a release and for a click", async () => {
    await setConfig({ subjectPriority: [{ subject: "Physics", hiring: true }] });
    const current = await settingsConfig();
    const fresh = await seed();
    expect(await preScreenQueue(db, current)).toEqual([]);
    const row = await replied();
    expect(await onsiteQueue(db, current)).toEqual([]);
    await expect(withDatabaseTransaction(db, (tx) => inviteToVisit(tx, row, current, "click"))).rejects.toThrow(/subject/);
    expect(await releaseQueues(db)).toEqual({ preScreen: 0, onsite: 0 });
    expect((await candidate(fresh.id)).stage).toBe("new");
    expect((await candidate(row.id)).stage).toBe("pre_screen");
  });
  it("handles a reply that arrived during a pause when automation resumes", async () => {
    const row = await seed({ stage: "pre_screen", subjects: ["Mathematics"] });
    await formRow(row.id, { sentAt: after(-10), createdAt: after(-10) });
    await setConfig({ enabled: false, deliveryEnabled: false });
    await expect(runHiringCycle(db, (_s, _k, kind) => assessment(kind))).rejects.toThrow(/not enabled/);
    expect((await candidate(row.id)).stage).toBe("pre_screen");
    // The form time is 5 days after the send, inside the pause, and the send is now past the 7-day expiry.
    tracker({ pre: [preRow(row.email!, "30/10/2026, 05:00:00")] });
    await setConfig({});
    const result = await runHiringCycle(db, (_s, _k, kind) => assessment(kind));
    expect(result).toMatchObject({ reminded: 0, expired: 0, onsite: 1 });
    const saved = await candidate(row.id);
    expect(saved.preScreenRepliedAt?.toISOString()).toBe("2026-10-30T05:00:00.000Z");
    expect(saved.stage).toBe("onsite_invited");
    const audits = await db.select().from(s.hiringAudit);
    expect(audits.filter((a) => a.action === "no-reply")).toEqual([]);
  });
  it("does not offer an onsite place to a subject at its limit, and passes it for the next subject", async () => {
    await setConfig({
      onsiteLimits: { perWeek: 3, unbooked: 2, perHeadPerWeek: 2, perSubject: 1 },
      subjectPriority: [{ subject: "Mathematics", hiring: true }, { subject: "Physics", hiring: true }],
    });
    await replied();
    await replied();
    const physics = await replied({
      preScreen: { ...pre, subjects: "Physics" },
      preScreenAssessment: six(["Physics"]) as never,
    });
    expect((await releaseQueues(db)).onsite).toBe(2);
    expect((await candidate(physics.id)).stage).toBe("onsite_invited");
    expect((await readLimitUsage(db, "onsite", now)).bySubject).toEqual({ Mathematics: 1, Physics: 1 });
  });
});

describe("tracker guard", () => {
  const paperPass = (email: string) => recruitRow(email, "Passed", "Mathematics", "Paper Passed");
  it("tracker change on a new-flow candidate changes nothing and queues nothing", async () => {
    const check = async (values: Values, formSent: boolean) => {
      const row = await seed({ subjects: ["Mathematics"], trackerHash: "old", reviewNote: "Keep", ...values });
      if (formSent) await formRow(row.id, { status: "pending", sentAt: null });
      tracker({ recruit: [paperPass(row.email!)] });
      await syncTracker(db, config);
      const saved = await candidate(row.id);
      expect(saved.trackerHash).not.toBe("old");
      expect({ ...saved, trackerHash: "old" }).toEqual(row);
    };
    await check({ stage: "pre_screen" }, true);
    for (const stage of ["onsite_invited", "onsite_booked", "no_reply", "no_booking"] as const)
      await check({ stage }, false);
    // A stop in the tracker is also ignored.
    const stop = await seed({ stage: "onsite_invited", trackerHash: "old" });
    tracker({ recruit: [recruitRow(stop.email!, "", "", "Rejected")] });
    await syncTracker(db, config);
    expect((await candidate(stop.id)).stage).toBe("onsite_invited");
    expect((await outbox()).filter((j) => j.payload.workflowStage !== "pre_screen")).toEqual([]);
  });
  it("a mock-log row on a new-flow candidate adds no booking and does not stop the cycle", async () => {
    const row = await seed({ stage: "onsite_invited" });
    const logRow = Array.from({ length: 10 }, () => "");
    Object.assign(logRow, { 0: "APP-7", 2: "Mathematics", 3: "Kru Nobody", 4: "2026-12-01", 5: "10:00-11:00" });
    tracker({ recruit: [paperPass(row.email!)], mock: [logRow] });
    await syncTracker(db, config);
    expect(await db.select().from(s.hiringBookings)).toEqual([]);
    expect((await candidate(row.id)).applicantId).toBeNull();
  });
  it("tracker change on an old-flow candidate behaves as today", async () => {
    const row = await seed({ stage: "paper_booked", subjects: ["Mathematics"], trackerHash: "old", previouslyContacted: true });
    tracker({ recruit: [paperPass(row.email!)] });
    await syncTracker(db, config);
    const saved = await candidate(row.id);
    expect(saved.stage).toBe("paper_passed");
    expect(saved.paperPassedSubjects).toEqual(["Mathematics"]);
    expect(saved.applicantId).toBe("APP-7");
    const jobs = await outbox();
    expect(jobs).toHaveLength(1);
    expect(jobs[0].payload.workflowStage).toBe("paper_passed");
    expect(jobs[0].key).toContain(":tracker-mock:");
  });
  it("treats a click-invited candidate with no form row as new flow, at any invite status", async () => {
    const row = await seed({ stage: "review", preScreen: pre, preScreenAssessment: six() as never, subjects: ["Mathematics"], trackerHash: "old" });
    const key = `${row.id}:visit-invite`;
    await withDatabaseTransaction(db, (tx) => inviteToVisit(tx, row, config, key));
    await db.update(s.hiringCandidates).set({ stage: "stopped" }).where(eq(s.hiringCandidates.id, row.id));
    await db.update(s.hiringOutbox).set({ status: "cancelled" }).where(eq(s.hiringOutbox.key, key));
    tracker({ recruit: [paperPass(row.email!)] });
    await syncTracker(db, config);
    const saved = await candidate(row.id);
    expect(saved.stage).toBe("stopped");
    expect(saved.paperPassedSubjects).toEqual([]);
    expect((await outbox()).map((j) => j.key)).toEqual([key]);
    // A click sees the same fact: the used key refuses a second first invitation, even when that row was cancelled.
    await db.update(s.hiringCandidates).set({ stage: "review" }).where(eq(s.hiringCandidates.id, row.id));
    await expect(
      reviewCandidate(row.id, { revision: saved.revision, action: "advance", subjects: ["Mathematics"], reason: "Checked by a person" }, "r@example.com", db),
    ).rejects.toThrow(/new link/);
  });
  it("treats an old stage as old-flow even when the old worker sent the form", () => {
    expect(isNewFlow({ stage: "paper_invited" }, true)).toBe(false);
    expect(isNewFlow({ stage: "mock_booked" }, true)).toBe(false);
    expect(isNewFlow({ stage: "review" }, true)).toBe(true);
    expect(isNewFlow({ stage: "pre_screen" }, true)).toBe(true);
    expect(isNewFlow({ stage: "stopped" }, true)).toBe(true);
    expect(isNewFlow({ stage: "review" }, false)).toBe(false);
    expect(isNewFlow({ stage: "no_booking" }, false)).toBe(true);
  });
});

describe("no paper invitation in the new flow", () => {
  it("never sends a paper invitation for a response: a scored one goes to the visit, an unscored one is refused", async () => {
    const row = await replied({ stage: "review" });
    const input = { revision: row.revision, action: "advance" as const, subjects: ["Mathematics" as const], reason: "Checked by a person" };
    await reviewCandidate(row.id, input, "r@example.com", db);
    expect((await candidate(row.id)).stage).toBe("onsite_invited");
    const unscored = await seed({ stage: "review", preScreen: pre });
    await expect(reviewCandidate(unscored.id, { ...input, revision: unscored.revision }, "r@example.com", db)).rejects.toThrow(/no score/);
    expect((await candidate(unscored.id)).stage).toBe("review");
    expect((await outbox()).filter((j) => j.payload.workflowStage === "paper_invited")).toEqual([]);
  });
  it("cancels an old paper invitation that is still unsent when the stage has moved on", async () => {
    const row = await seed({ stage: "onsite_invited" });
    await db.insert(s.hiringOutbox).values({
      key: "old-paper",
      candidateId: row.id,
      kind: "email",
      payload: { to: row.email, subject: "paper", text: "paper", workflowStage: "paper_invited" },
    });
    await deliverOutbox(db, config);
    expect(sendEmail).not.toHaveBeenCalled();
    expect((await outbox())[0].status).toBe("cancelled");
  });
});

describe("profile gate sweep", () => {
  const text = "degree subject curriculum teaching english Mathematics";
  const scored = (values: Values = {}) => seed({ profileText: text, profileHash: sourceHash(text), ...values });
  const noModel = vi.fn(async (): Promise<unknown> => {
    throw new Error("The model must not be called.");
  });
  const moves = async () => (await db.select().from(s.hiringAudit)).filter((a) => a.action === "move-to-review");
  const notMet = { ...five(), criteria: five().criteria.map((c) => (c.id === "degree" ? { ...c, result: "not_met" } : c)) };
  const ready = async (row: Candidate) =>
    readyToInvite({ ...(await candidate(row.id)), profileScore: null }, await settingsConfig());
  beforeEach(() => {
    noModel.mockClear();
  });
  it.each<[string, Values, Partial<HiringConfig>, (row: Candidate) => Promise<unknown>]>([
    ["a not-hiring subject", {}, { subjectPriority: [{ subject: "Mathematics", hiring: false }] }, () => setConfig({})],
    [
      "a work-rights answer not accepted",
      { workRightsAnswer: "Other" },
      {},
      () => setConfig({ acceptedWorkRights: [ACCEPTED, "Other"] }),
    ],
    [
      "a missing work-rights answer",
      { workRightsAnswer: null },
      {},
      (row) => db.update(s.hiringCandidates).set({ workRightsAnswer: ACCEPTED }).where(eq(s.hiringCandidates.id, row.id)),
    ],
    ["a score below the threshold", {}, { profileThreshold: 90 }, () => setConfig({})],
  ])("%s stays new and out of the queue, then enters after the change", async (_name, values, patch, cure) => {
    await setConfig(patch);
    const row = await scored(values);
    for (let cycle = 0; cycle < 2; cycle++) await runHiringCycle(db, noModel);
    const held = await candidate(row.id);
    expect([held.stage, held.revision, held.reviewNote]).toEqual(["new", row.revision, null]);
    expect(await preScreenQueue(db, await settingsConfig())).toEqual([]);
    expect(await ready(row)).toBe(false);
    expect(await outbox()).toEqual([]);
    expect(await moves()).toEqual([]);
    await cure(row);
    expect((await preScreenQueue(db, await settingsConfig())).map((e) => e.id)).toEqual([row.id]);
    expect(await ready(row)).toBe(true);
    expect((await candidate(row.id)).stage).toBe("new");
    expect(await runHiringCycle(db, noModel)).toMatchObject({ preScreen: 1 });
    expect((await candidate(row.id)).stage).toBe("pre_screen");
    expect(await forms()).toHaveLength(1);
    expect(noModel).not.toHaveBeenCalled();
  });
  it.each<[string, Values, RegExp]>([
    ["a degree that is not met", { profileAssessment: notMet as never }, /degree/i],
    ["no supported subject", { profileAssessment: five([]) as never }, /supports no subject/],
    ["no email", { email: null }, /email/],
    ["earlier contact", { previouslyContacted: true }, /earlier contact/],
  ])("%s moves to review, with an audit row of the reasons, though the hash did not change", async (_name, values, reason) => {
    const row = await scored(values);
    await runHiringCycle(db, noModel);
    const saved = await candidate(row.id);
    expect(saved.stage).toBe("review");
    expect(saved.revision).toBe(row.revision + 1);
    expect(saved.reviewNote).toMatch(reason);
    const audits = await moves();
    expect(audits).toHaveLength(1);
    expect(audits[0].candidateId).toBe(row.id);
    expect((audits[0].detail as { reasons: string[] }).reasons.join(" ")).toMatch(reason);
    await runHiringCycle(db, noModel);
    expect(await moves()).toHaveLength(1);
    expect(noModel).not.toHaveBeenCalled();
  });
  it("names every real reason when a curable and a final failure come together", async () => {
    const row = await scored({ profileAssessment: notMet as never, workRightsAnswer: null });
    await runHiringCycle(db, noModel);
    const saved = await candidate(row.id);
    expect(saved.stage).toBe("review");
    expect(saved.reviewNote).toMatch(/degree/i);
    expect(saved.reviewNote).toMatch(/work-rights/);
  });
  it("audits a reply moved to review, though the hash did not change", async () => {
    const row = await replied({ preScreen: { ...pre, degree: "Below Bachelor's" } });
    await db
      .update(s.hiringCandidates)
      .set({ preScreenHash: sourceHash(preScreenText(row.preScreen!, row.name) + "\n\nApplication education and experience:\n" + row.profileText) })
      .where(eq(s.hiringCandidates.id, row.id));
    await runHiringCycle(db, noModel);
    expect(noModel).not.toHaveBeenCalled();
    expect((await candidate(row.id)).stage).toBe("review");
    expect(await moves()).toHaveLength(1);
  });
  it("leaves 335 new candidates with no work-rights answer at new, with nothing sent and no model call", async () => {
    const rows = Array.from({ length: 335 }, (_, i) => ({
      name: `Bulk ${i}`,
      email: `bulk${i}@example.com`,
      profileText: text,
      profileHash: sourceHash(text),
      profileAssessment: five() as never,
      workRightsAnswer: null,
    }));
    await db.insert(s.hiringCandidates).values(rows);
    const result = await runHiringCycle(db, noModel);
    expect(result).toMatchObject({ calls: 0, preScreen: 0, onsite: 0 });
    expect(noModel).not.toHaveBeenCalled();
    const all = await db.select({ stage: s.hiringCandidates.stage }).from(s.hiringCandidates);
    const counts = Object.fromEntries(
      [...new Set(all.map((c) => c.stage))].map((stage) => [stage, all.filter((c) => c.stage === stage).length]),
    );
    expect(counts).toEqual({ new: 335 });
    expect(await outbox()).toEqual([]);
    expect(await moves()).toEqual([]);
  });
});

describe("live cycle duration", () => {
  it("starts no new assessment after the time budget, and a later cycle continues", async () => {
    for (let i = 0; i < 4; i++) await seed({ profileAssessment: null });
    const assess = vi.fn(async () => {
      // Each assessment takes 12 minutes: 4 calls at 180 seconds.
      vi.setSystemTime(new Date(Date.now() + 12 * 60000));
      return five();
    });
    await runHiringCycle(db, assess);
    expect(assess).toHaveBeenCalledTimes(1);
    await runHiringCycle(db, assess);
    expect(assess).toHaveBeenCalledTimes(2);
  });
});
