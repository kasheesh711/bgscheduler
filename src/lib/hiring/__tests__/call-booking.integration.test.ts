import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { and, eq, sql } from "drizzle-orm";
import { ZodError } from "zod";
import { startTestDb, stopTestDb } from "@/tests/integration/db-helper";
import { type Database } from "@/lib/db";
import * as s from "@/lib/db/schema";
import { configSchema, HiringError, HR_CALENDAR, HR_CALL_KEY, type HiringConfig } from "../model";
import { bookCall, bookingView, callView, dashboard, reviewCandidate, visitView } from "../service";
import { callQueue, readLimitUsage, recordCall, releaseCallInvites, releaseQueues } from "../queue";
import { observeSeekState } from "../sources";
import { googleConnectionStatus, readHrBusy } from "../google";
import { bookingToken } from "../tokens";

// The real slot builder runs against this database. Google, Wise and the tutor index are fake.
vi.mock("../availability", async (actual) => ({
  ...(await actual<typeof import("../availability")>()),
  verifyLiveSlot: vi.fn(),
  readLiveBusy: vi.fn(async () => {
    throw new Error("no Wise in tests");
  }),
}));
vi.mock("@/lib/search/index", () => ({ ensureIndex: vi.fn() }));
vi.mock("@/lib/email/outbound", () => ({ createOutboundEmailSender: vi.fn() }));
vi.mock("../google", () => ({ deliverCalendar: vi.fn(), googleConnectionStatus: vi.fn(), readHrBusy: vi.fn() }));
vi.mock("@/lib/line/client", () => ({ pushLineTextMessage: vi.fn(), LinePushError: class extends Error {} }));

let handle: Awaited<ReturnType<typeof startTestDb>>, db: Database;
const DAY = 86400000;
// Wednesday 12:00 in Bangkok. The five dates on offer are Thu 5, Fri 6, Mon 9, Tue 10 and Wed 11 November.
const now = new Date("2026-11-04T05:00:00Z");
const after = (days: number) => new Date(now.getTime() + days * DAY);
// Thursday 09:00, 09:15 and 09:30 in Bangkok, and Friday 09:00.
const NINE = "2026-11-05T02:00:00.000Z";
const QUARTER = "2026-11-05T02:15:00.000Z";
const HALF = "2026-11-05T02:30:00.000Z";
const FRIDAY = "2026-11-06T02:00:00.000Z";
const LINK = after(14);
const hr = "hr@example.com";
const config = configSchema.parse({
  enabled: true,
  deliveryEnabled: true,
  callThreshold: 80,
  interviewers: [{ canonicalKey: "Peat", email: "peat@example.com", subjects: ["Mathematics", "Physics"] }],
});
const ids = ["degree", "subject", "curriculum", "teaching", "english"];
// Scores 80: at the call score, so HR must call.
const five = () => ({
  criteria: ids.map((id) => ({ id, result: "met", evidence: id, reason: "Source" })),
  subjects: [{ subject: "Mathematics", evidence: "Mathematics", relevant: true }],
  universities: [],
  summary: "Evidence",
});
const connection = (freeBusy: boolean) =>
  vi.mocked(googleConnectionStatus).mockResolvedValue({ connected: true, freeBusy, email: "", lastError: null });

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
  connection(true);
  vi.mocked(readHrBusy).mockResolvedValue([]);
});
afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllEnvs();
});

const setConfig = (patch: Partial<HiringConfig>) =>
  db.update(s.hiringSettings).set({ config: { ...config, ...patch } }).where(eq(s.hiringSettings.id, "default"));
const settingsConfig = async () => configSchema.parse((await db.select().from(s.hiringSettings))[0].config);
let serial = 0;
async function seed(values: Partial<typeof s.hiringCandidates.$inferInsert> = {}) {
  serial++;
  const [row] = await db
    .insert(s.hiringCandidates)
    .values({
      name: `Applicant ${serial}`,
      email: `c${serial}@example.com`,
      profileText: `degree subject curriculum teaching english Mathematics ${serial}`,
      profileAssessment: five() as never,
      workRightsAnswer: "I have permanent work rights with no restrictions",
      ...values,
    })
    .returning();
  return row;
}
const link = (id: string) => bookingToken(id, "call", LINK);
const candidate = async (id: string) => (await db.select().from(s.hiringCandidates).where(eq(s.hiringCandidates.id, id)))[0];
const callsOf = async (id: string) =>
  (await db.select().from(s.hiringBookings).where(and(eq(s.hiringBookings.candidateId, id), eq(s.hiringBookings.kind, "call")))).sort(
    (a, b) => a.startTime.getTime() - b.startTime.getTime(),
  );
const jobsOf = (id: string) => db.select().from(s.hiringOutbox).where(eq(s.hiringOutbox.candidateId, id));
const inviteRow = (id: string, status: "sent" | "pending" = "sent") =>
  db.insert(s.hiringOutbox).values({
    key: `${id}:call-invite`,
    candidateId: id,
    kind: "email",
    status,
    sentAt: status === "sent" ? now : null,
    createdAt: now,
    payload: { to: "x@example.com", subject: "s", text: "t", workflowStage: "new" },
  });
const book = (id: string, start = NINE, extra: Record<string, unknown> = {}) =>
  bookCall(link(id), { start, phone: "+66 81-234 5678", ...extra }, db);

describe("the call booking link", () => {
  it("leaves under the day's number, once per candidate, and only when the calendar can be read", async () => {
    const [a, b, c] = [await seed({ createdAt: after(-3) }), await seed({ createdAt: after(-2) }), await seed({ createdAt: after(-1) })];
    await setConfig({ preScreenLimits: { ...config.preScreenLimits, perDay: 2 } });
    connection(false);
    expect(await releaseCallInvites(db)).toBe(0);
    expect(await db.select().from(s.hiringOutbox)).toEqual([]);
    connection(true);
    expect(await releaseCallInvites(db)).toBe(2);
    const first = await db.select().from(s.hiringOutbox);
    expect(first.map((job) => job.key).sort()).toEqual([`${a.id}:call-invite`, `${b.id}:call-invite`].sort());
    expect(first[0].payload).toMatchObject({ workflowStage: "new", subject: "BeGifted tutor application: book your call" });
    const token = String(first.find((job) => job.candidateId === a.id)!.payload.text).match(/\/hiring\/book\/([\w.-]+)/)![1];
    expect(JSON.parse(Buffer.from(token.split(".")[0], "base64url").toString())).toMatchObject({ id: a.id, kind: "call" });
    // The day is full. The form queue is apart and sends nothing: these people still wait for a call.
    expect(await releaseCallInvites(db)).toBe(0);
    expect(await releaseQueues(db)).toEqual({ preScreen: 0, onsite: 0 });
    vi.setSystemTime(after(1));
    expect(await releaseCallInvites(db)).toBe(1);
    expect(await releaseCallInvites(db)).toBe(0);
    expect((await jobsOf(c.id)).map((job) => job.key)).toEqual([`${c.id}:call-invite`]);
    expect((await db.select().from(s.hiringAudit)).filter((row) => row.action === "call-invite-release")).toHaveLength(3);
    // The link is not a visit link or an old-flow link.
    await expect(visitView(token, db)).rejects.toMatchObject({ status: 404 });
    await expect(bookingView(token, undefined, db)).rejects.toMatchObject({ status: 404 });
  });

  it("shows only the times that HR's calendar and other calls leave free, and none when the calendar cannot be read", async () => {
    const [a, b] = [await seed(), await seed()];
    vi.mocked(readHrBusy).mockResolvedValue([{ start: new Date(NINE), end: new Date("2026-11-05T02:20:00.000Z") }]);
    await book(b.id, HALF);
    const view = await callView(link(a.id), db);
    // 36 times a day for 5 days, less 09:00 and 09:15 (the calendar) and 09:30 (the other candidate).
    expect(view.slots).toHaveLength(36 * 5 - 3);
    expect(view.slots[0]).toEqual({ date: "2026-11-05", start: "2026-11-05T02:45:00.000Z", end: "2026-11-05T03:00:00.000Z" });
    expect(view.slots.at(-1)!.end).toBe("2026-11-11T11:00:00.000Z");
    expect(view).toMatchObject({ kind: "call", minutes: 15, enabled: true, call: null, canMove: false, notice: null });
    expect(vi.mocked(readHrBusy).mock.calls.at(-1)!.slice(1, 3)).toEqual([new Date(NINE), new Date("2026-11-11T11:00:00.000Z")]);
    // No stored phone number ever comes back through the link.
    expect(JSON.stringify(await callView(link(b.id), db))).not.toContain("66812345678");
    vi.mocked(readHrBusy).mockRejectedValue(new HiringError(502, "Google did not return the call calendar."));
    const closed = await callView(link(a.id), db);
    expect(closed.slots).toEqual([]);
    expect(closed.notice).toMatch(/cannot be shown/);
  });
});

describe("booking a call", () => {
  it("saves the call and the phone number, and queues the email and the calendar event", async () => {
    const a = await seed();
    const call = await book(a.id);
    expect(call).toMatchObject({
      kind: "call",
      status: "confirmed",
      interviewerKey: HR_CALL_KEY,
      interviewerEmail: HR_CALENDAR,
      subjects: ["Mathematics"],
      visitId: null,
    });
    expect([call.startTime.toISOString(), call.endTime.toISOString()]).toEqual([NINE, QUARTER]);
    // A click on an open Calls tab sends the revision it loaded, so a booking must not change it.
    expect(await candidate(a.id)).toMatchObject({ phone: "+66812345678", stage: "new", revision: a.revision });
    const jobs = await jobsOf(a.id);
    expect(jobs.map((job) => [job.kind, job.bookingId]).sort()).toEqual([["calendar", call.id], ["email", call.id]]);
    const text = String(jobs.find((job) => job.kind === "email")!.payload.text);
    expect(text).toContain("We will call: +66812345678");
    expect(text).toContain("09:00–09:15 (Bangkok)");
    expect(text).toMatch(/Move your call:\n\S+\/hiring\/book\//);
    const [audit] = await db.select().from(s.hiringAudit);
    expect([audit.action, audit.detail]).toEqual(["call-booked", { start: NINE }]);
    // A retry returns the same call.
    expect((await book(a.id)).id).toBe(call.id);
    expect(await callsOf(a.id)).toHaveLength(1);
    expect(await callView(link(a.id), db)).toMatchObject({ call: { start: NINE, end: QUARTER }, canMove: true });
  });

  it("refuses a time another candidate holds, and the database refuses a second row for it", async () => {
    const [a, b] = [await seed(), await seed()];
    await book(a.id);
    await expect(book(b.id)).rejects.toMatchObject({ status: 409, message: expect.stringMatching(/no longer available/) });
    const raw = db.insert(s.hiringBookings).values({
      candidateId: b.id,
      kind: "call",
      subjects: ["Mathematics"],
      interviewerKey: HR_CALL_KEY,
      interviewerEmail: HR_CALENDAR,
      calendarOwner: "owner@example.com",
      startTime: new Date(NINE),
      endTime: new Date(QUARTER),
      evidence: {},
    });
    await expect(raw).rejects.toMatchObject({ cause: { code: "23P01" } });
    expect(await callsOf(b.id)).toEqual([]);
  });

  it("moves once, before the call starts", async () => {
    const a = await seed();
    const first = await book(a.id);
    await expect(book(a.id, QUARTER)).rejects.toMatchObject({ status: 409, message: expect.stringMatching(/already have a booked call/) });
    const moved = await book(a.id, QUARTER, { move: true });
    expect(moved.rescheduleOf).toBe(first.id);
    expect((await callsOf(a.id)).map((row) => row.status)).toEqual(["cancelled", "confirmed"]);
    const jobs = await jobsOf(a.id);
    expect(jobs.filter((job) => job.kind === "calendar_cancel").map((job) => job.bookingId)).toEqual([first.id]);
    // The first confirmation never left, so it is cancelled, and the moved one says that it cannot move again.
    expect(jobs.find((job) => job.key === `booking:${first.id}:email`)!.status).toBe("cancelled");
    expect(String(jobs.find((job) => job.key === `booking:${moved.id}:email`)!.payload.text)).toContain("cannot move again");
    await expect(book(a.id, HALF, { move: true })).rejects.toMatchObject({ status: 409, message: expect.stringMatching(/already moved once/) });
    expect(await callView(link(a.id), db)).toMatchObject({ canMove: false, slots: [] });
  });

  it("fails closed at confirm: no calendar read, a time gone from the calendar, a bad phone number, a wrong link", async () => {
    const a = await seed();
    vi.mocked(readHrBusy).mockRejectedValueOnce(new HiringError(502, "Google did not return the call calendar."));
    await expect(book(a.id)).rejects.toMatchObject({ status: 503, message: expect.stringMatching(/cannot be checked/) });
    vi.mocked(readHrBusy).mockResolvedValueOnce([{ start: new Date(NINE), end: new Date(QUARTER) }]);
    await expect(book(a.id)).rejects.toMatchObject({ status: 409 });
    await expect(bookCall(link(a.id), { start: NINE, phone: "call me" }, db)).rejects.toBeInstanceOf(ZodError);
    await expect(bookCall(link(a.id), { start: NINE }, db)).rejects.toBeInstanceOf(ZodError);
    // A time that is not on the list: Saturday, 18:00, and a time off the quarter hour.
    for (const start of ["2026-11-07T02:00:00.000Z", "2026-11-05T11:00:00.000Z", "2026-11-05T02:05:00.000Z"])
      await expect(book(a.id, start)).rejects.toMatchObject({ status: 409 });
    for (const token of [bookingToken(a.id, "visit", LINK), bookingToken(a.id, "call", after(-1)), bookingToken(a.id, "brief", LINK)])
      await expect(bookCall(token, { start: NINE, phone: "+66812345678" }, db)).rejects.toMatchObject({ status: 404 });
    await setConfig({ enabled: false });
    await expect(book(a.id)).rejects.toMatchObject({ status: 503 });
    expect(await callsOf(a.id)).toEqual([]);
  });
});

describe("call results with a booked call", () => {
  it("a good call cancels a call still ahead and ends the link", async () => {
    const a = await seed();
    const call = await book(a.id);
    await recordCall(a.id, "good", hr, db);
    expect((await callsOf(a.id)).map((row) => row.status)).toEqual(["cancelled"]);
    expect((await jobsOf(a.id)).filter((job) => job.kind === "calendar_cancel").map((job) => job.bookingId)).toEqual([call.id]);
    await expect(callView(link(a.id), db)).rejects.toMatchObject({ status: 404 });
    await expect(book(a.id, QUARTER)).rejects.toMatchObject({ status: 404 });
    // The form now goes, as before.
    expect(await releaseQueues(db)).toEqual({ preScreen: 1, onsite: 0 });
  });

  it("a good call after the call started leaves it in place, and a no answer closes it so the candidate can book again", async () => {
    const [a, b] = [await seed(), await seed()];
    await book(a.id);
    await book(b.id, QUARTER);
    // Thursday 09:16 in Bangkok: both calls have started.
    vi.setSystemTime(new Date("2026-11-05T02:16:00.000Z"));
    await recordCall(a.id, "good", hr, db);
    expect((await callsOf(a.id)).map((row) => row.status)).toEqual(["confirmed"]);
    expect((await jobsOf(a.id)).filter((job) => job.kind === "calendar_cancel")).toEqual([]);
    await recordCall(b.id, "no_answer", hr, db);
    expect((await callsOf(b.id)).map((row) => row.status)).toEqual(["no_show"]);
    expect((await candidate(b.id)).callReview?.tries).toHaveLength(1);
    const view = await callView(link(b.id), db);
    expect(view.call).toBeNull();
    expect(view.slots[0].start).toBe(FRIDAY);
    const again = await bookCall(link(b.id), { start: FRIDAY, phone: "0812345678" }, db);
    expect(again.rescheduleOf).toBeNull();
    expect((await candidate(b.id)).phone).toBe("0812345678");
  });

  it("a bad call, which is Stop, cancels a booked call and does not refuse", async () => {
    const a = await seed();
    await book(a.id);
    await reviewCandidate(a.id, { revision: a.revision, action: "stop", subjects: ["Mathematics"], reason: "Bad call before the pre-screen form." }, hr, db);
    expect((await candidate(a.id)).stage).toBe("stopped");
    expect((await callsOf(a.id)).map((row) => row.status)).toEqual(["cancelled"]);
    const jobs = await jobsOf(a.id);
    // The unsent confirmation is cancelled. The calendar cancel still leaves.
    expect(jobs.filter((job) => job.status === "pending").map((job) => job.kind)).toEqual(["calendar_cancel"]);
  });

  it("a hand invite to the form cancels a call still ahead", async () => {
    const a = await seed();
    await book(a.id);
    await reviewCandidate(a.id, { revision: a.revision, action: "advance", subjects: ["Mathematics"], reason: "Strong profile" }, "owner@example.com", db);
    expect((await candidate(a.id)).stage).toBe("pre_screen");
    expect((await callsOf(a.id)).map((row) => row.status)).toEqual(["cancelled"]);
  });
});

describe("SEEK and the lists", () => {
  it("a sent call link keeps the candidate on the Calls tab; a waiting link does not; Not Suitable stops and cancels the call", async () => {
    const sent = await seed({ sourceIds: ["app-sent"] });
    const waiting = await seed({ sourceIds: ["app-waiting"] });
    await inviteRow(sent.id, "sent");
    await inviteRow(waiting.id, "pending");
    await book(sent.id);
    // HR moves both cards in SEEK and writes to both candidates.
    await observeSeekState("app-sent", "Shortlist", true, db);
    await observeSeekState("app-waiting", "Shortlist", true, db);
    expect(await candidate(sent.id)).toMatchObject({ stage: "new", previouslyContacted: true });
    expect((await candidate(waiting.id)).stage).toBe("review");
    expect((await callQueue(db, await settingsConfig())).map((entry) => entry.id)).toEqual([sent.id]);
    // The waiting link is cancelled with the other pending invitations, so it cannot leave later.
    expect((await jobsOf(waiting.id)).map((job) => job.status)).toEqual(["cancelled"]);
    expect(await callView(link(sent.id), db)).toMatchObject({ call: { start: NINE } });
    await recordCall(sent.id, "no_answer", hr, db);
    await observeSeekState("app-sent", "Not Suitable", false, db);
    expect((await candidate(sent.id)).stage).toBe("stopped");
    expect((await callsOf(sent.id)).map((row) => row.status)).toEqual(["cancelled"]);
  });

  it("the dashboard lists calls apart from visits, booked calls first, and a past call is not a booked visit", async () => {
    const [a, b, c] = [await seed({ createdAt: after(-3) }), await seed({ createdAt: after(-2) }), await seed({ createdAt: after(-1) })];
    await inviteRow(a.id);
    await book(c.id, QUARTER);
    await book(b.id, NINE);
    const data = await dashboard(db);
    expect(data.callOrder).toEqual([b.id, c.id, a.id]);
    expect(data.calls.map((call) => [call.candidateId, call.start.toISOString()])).toEqual([[c.id, QUARTER], [b.id, NINE]]);
    expect(data.bookings).toEqual([]);
    expect(data.candidates.find((row) => row.id === a.id)).toMatchObject({ callInvited: true, phone: null });
    expect(data.candidates.find((row) => row.id === b.id)).toMatchObject({ callInvited: false, phone: "+66812345678" });
    // Later: the call is in the past and still confirmed, and the candidate holds a visit link that is not booked.
    await db.update(s.hiringCandidates).set({ stage: "onsite_invited", visitSubject: "Mathematics" }).where(eq(s.hiringCandidates.id, b.id));
    expect((await readLimitUsage(db, "onsite", after(7))).unbooked).toBe(1);
  });
});
