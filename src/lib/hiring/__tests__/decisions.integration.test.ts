import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { eq, sql } from "drizzle-orm";
import { startTestDb, stopTestDb } from "@/tests/integration/db-helper";
import { type Database } from "@/lib/db";
import * as s from "@/lib/db/schema";
import { createOutboundEmailSender } from "@/lib/email/outbound";
import { configSchema } from "../model";
import { discardDecision, draftDecision, resultEmail, saveDraft, sendDecision, sendRefusal } from "../decisions";
import { reviewCandidate } from "../service";
import { isNewFlow, observeSeekState } from "../sources";
import { deliverOutbox } from "../worker";

vi.mock("@/lib/email/outbound", () => ({ createOutboundEmailSender: vi.fn() }));
vi.mock("../availability", () => ({ availableSlots: vi.fn(), verifyLiveSlot: vi.fn(), readLiveBusy: vi.fn(async () => { throw new Error("no Wise in tests"); }) }));
vi.mock("../google", () => ({ deliverCalendar: vi.fn(), googleConnectionStatus: vi.fn(async () => ({ connected: true, freeBusy: false, email: "", lastError: null })), readHrBusy: vi.fn(), }));
vi.mock("@/lib/line/client", () => ({ pushLineTextMessage: vi.fn(), LinePushError: class extends Error {} }));

let handle: Awaited<ReturnType<typeof startTestDb>>, db: Database;
const on = configSchema.parse({ enabled: true, deliveryEnabled: true });
const sendEmail = vi.fn();
const email = { emailSubject: "Your result", emailBody: "Dear person, edited by a person." };

async function candidate(values = {}) {
  const [row] = await db.insert(s.hiringCandidates).values({ name: "Sample", email: "person@example.com", stage: "onsite_booked", visitSubject: "Mathematics", subjects: ["Mathematics"], ...values }).returning();
  return row;
}
const results = async (candidateId: string, status: "done" | "needs_check" = "done") => {
  await db.insert(s.hiringPaperResults).values({ candidateId, subject: "Mathematics", source: "ai", status });
  await db.insert(s.hiringMockResults).values({ candidateId, subject: "Mathematics", source: "ai", status: "done" });
};
const read = async (id: string) => (await db.select().from(s.hiringCandidates).where(eq(s.hiringCandidates.id, id)))[0];
const outbox = () => db.select().from(s.hiringOutbox);
const setConfig = (config = on) => db.update(s.hiringSettings).set({ config }).where(eq(s.hiringSettings.id, "default"));

beforeAll(async () => {
  handle = await startTestDb();
  db = handle.db as unknown as Database;
}, 120000);
afterAll(async () => {
  if (handle) await stopTestDb(handle);
});
beforeEach(async () => {
  vi.clearAllMocks();
  vi.stubEnv("HIRING_WRITES_ENABLED", "true");
  vi.stubEnv("VERCEL_ENV", "production");
  vi.mocked(createOutboundEmailSender).mockReturnValue({ sendEmail });
  sendEmail.mockResolvedValue({ id: "email-receipt" });
  await db.execute(sql`truncate hiring_candidates, hiring_outbox, hiring_audit, hiring_settings cascade`);
  await db.insert(s.hiringSettings).values({ id: "default", config: on, updatedBy: "owner" });
});

describe("drafting", () => {
  it("saves a draft with the email text, and sends nothing and changes no stage", async () => {
    const c = await candidate();
    await results(c.id);
    const draft = await draftDecision(c.id, { decision: "hire", reason: "" }, "person", db);
    expect(draft).toMatchObject({ status: "draft", decision: "hire", decidedBy: "person" });
    expect(draft.emailBody).toMatch(/Dear Sample/);
    expect(draft.emailBody).toMatch(/Mathematics/);
    expect(await outbox()).toEqual([]);
    expect(await read(c.id)).toMatchObject({ stage: "onsite_booked", revision: c.revision });
  });
  it("keeps one draft, the latest", async () => {
    const c = await candidate();
    await results(c.id);
    await draftDecision(c.id, { decision: "hire", reason: "" }, "a", db);
    await draftDecision(c.id, { decision: "reject", reason: "Changed my mind" }, "a", db);
    const rows = await db.select().from(s.hiringDecisions);
    expect(rows.filter((r) => r.status === "draft").map((r) => r.decision)).toEqual(["reject"]);
  });
  it("blocks Hire until both results are in, and a check is cleared", async () => {
    const none = await candidate();
    await expect(draftDecision(none.id, { decision: "hire", reason: "" }, "a", db)).rejects.toThrow(/No paper result/);
    const flagged = await candidate({ email: "b@example.com" });
    await results(flagged.id, "needs_check");
    await expect(draftDecision(flagged.id, { decision: "hire", reason: "" }, "a", db)).rejects.toThrow(/check/);
  });
  it("hires with low scores, because the person decides", async () => {
    const c = await candidate();
    await results(c.id);
    await expect(draftDecision(c.id, { decision: "hire", reason: "" }, "a", db)).resolves.toMatchObject({ decision: "hire" });
  });
  it("lets Reject go with results missing, but needs a reason and an email", async () => {
    const c = await candidate();
    await expect(draftDecision(c.id, { decision: "reject", reason: "no" }, "a", db)).rejects.toThrow(/reason/);
    await expect(draftDecision(c.id, { decision: "reject", reason: "Left early" }, "a", db)).resolves.toMatchObject({ decision: "reject" });
    const noEmail = await candidate({ email: null });
    await expect(draftDecision(noEmail.id, { decision: "reject", reason: "Left early" }, "a", db)).rejects.toThrow(/no email/);
  });
  it("refuses a decision while a visit is ahead", async () => {
    const c = await candidate();
    await db.insert(s.hiringBookings).values({ candidateId: c.id, kind: "paper", subjects: ["Mathematics"], calendarOwner: "o@example.com", startTime: new Date(Date.now() + 86400000), endTime: new Date(Date.now() + 90000000), status: "confirmed", visitId: crypto.randomUUID(), evidence: {} as never });
    await expect(draftDecision(c.id, { decision: "reject", reason: "Left early" }, "a", db)).rejects.toThrow(/visit ahead/);
  });
  it("keeps a person's edits, and creates no row", async () => {
    const c = await candidate();
    const draft = await draftDecision(c.id, { decision: "reject", reason: "Left early" }, "a", db);
    await saveDraft(draft.id, email, "a", db);
    expect((await db.select().from(s.hiringDecisions))[0]).toMatchObject({ status: "draft", emailSubject: email.emailSubject });
    expect(await outbox()).toEqual([]);
  });
  it("lets Reject go past a future old-flow booking, and Send ends that booking", async () => {
    const c = await candidate({ stage: "mock_booked", visitSubject: null });
    const later = new Date(Date.now() + 86400000);
    await db.insert(s.hiringBookings).values({ candidateId: c.id, kind: "paper", subjects: ["Mathematics"], calendarOwner: "o@example.com", startTime: later, endTime: new Date(later.getTime() + 3600000), status: "confirmed", evidence: {} as never });
    const draft = await draftDecision(c.id, { decision: "reject", reason: "Not a fit" }, "a", db);
    await sendDecision(draft.id, email, "a", db);
    expect((await db.select().from(s.hiringBookings))[0].status).toBe("cancelled");
    expect((await outbox()).map((r) => r.kind).sort()).toEqual(["calendar_cancel", "email"]);
  });
  it("discards a draft once", async () => {
    const c = await candidate();
    const draft = await draftDecision(c.id, { decision: "reject", reason: "Left early" }, "a", db);
    await discardDecision(draft.id, "a", db);
    await expect(discardDecision(draft.id, "a", db)).rejects.toMatchObject({ status: 409 });
  });
});

describe("sending", () => {
  async function drafted() {
    const c = await candidate();
    const draft = await draftDecision(c.id, { decision: "reject", reason: "Left early" }, "a", db);
    return { c, draft };
  }
  it("queues exactly the person's text, moves the stage, and a second Send stops", async () => {
    const { c, draft } = await drafted();
    const key = await sendDecision(draft.id, email, "person", db);
    expect(key).toBe(`${c.id}:result:${draft.id}`);
    const rows = await outbox();
    expect(rows).toHaveLength(1);
    expect(rows[0].payload).toMatchObject({ to: "person@example.com", subject: "Your result", text: email.emailBody, workflowStage: "rejected" });
    expect(rows[0].bookingId).toBeNull();
    expect(await read(c.id)).toMatchObject({ stage: "rejected", revision: c.revision + 1 });
    await expect(sendDecision(draft.id, email, "person", db)).rejects.toThrow(/already sent/);
    expect(await outbox()).toHaveLength(1);
  });
  it("delivers that one row at once, and leaves other rows alone", async () => {
    const { c, draft } = await drafted();
    await db.insert(s.hiringOutbox).values({ key: "other", candidateId: c.id, kind: "email", payload: { to: "x@example.com", subject: "Other", text: "Other" } });
    const key = await sendDecision(draft.id, email, "person", db);
    expect(await deliverOutbox(db, on, 1, false, key)).toBe(1);
    expect(sendEmail).toHaveBeenCalledTimes(1);
    expect(sendEmail.mock.calls[0][0]).toMatchObject({ to: "person@example.com", subject: "Your result" });
    expect((await outbox()).find((r) => r.key === "other")!.status).toBe("pending");
  });
  it.each([
    { enabled: false, deliveryEnabled: true },
    { enabled: true, deliveryEnabled: false },
    { enabled: false, deliveryEnabled: false },
  ])("refuses while a switch is off, keeps the draft, and creates no row: %o", async (patch) => {
    const { c, draft } = await drafted();
    await setConfig({ ...on, ...patch });
    await expect(sendDecision(draft.id, email, "person", db)).rejects.toThrow(/must both be on/);
    expect(await outbox()).toEqual([]);
    expect((await read(c.id)).stage).toBe("onsite_booked");
    expect((await db.select().from(s.hiringDecisions))[0].status).toBe("draft");
    // Nothing waits to leave when the switches come on.
    await setConfig(on);
    expect(await deliverOutbox(db, on)).toBe(0);
  });
  it("checks the Hire rule again at Send", async () => {
    const c = await candidate();
    await results(c.id);
    const draft = await draftDecision(c.id, { decision: "hire", reason: "" }, "a", db);
    await db.update(s.hiringPaperResults).set({ status: "needs_check" }).where(eq(s.hiringPaperResults.candidateId, c.id));
    await expect(sendDecision(draft.id, email, "a", db)).rejects.toThrow(/check/);
    expect(await outbox()).toEqual([]);
  });
  it("refuses an empty email", async () => {
    const { draft } = await drafted();
    await expect(sendDecision(draft.id, { emailSubject: " ", emailBody: "x" }, "a", db)).rejects.toMatchObject({ status: 400 });
  });
  it("a changed decision needs its own Send, and cancels the old email if it has not left", async () => {
    const c = await candidate();
    await results(c.id);
    const first = await draftDecision(c.id, { decision: "reject", reason: "Left early" }, "a", db);
    await sendDecision(first.id, email, "a", db);
    const second = await draftDecision(c.id, { decision: "hire", reason: "" }, "a", db);
    const key = await sendDecision(second.id, { emailSubject: "Good news", emailBody: "Hired." }, "a", db);
    await deliverOutbox(db, on);
    expect(sendEmail).toHaveBeenCalledTimes(1);
    expect(sendEmail.mock.calls[0][0].subject).toBe("Good news");
    expect((await outbox()).find((r) => r.key === key)!.status).toBe("sent");
    expect((await read(c.id)).stage).toBe("hired");
    const rows = await db.select().from(s.hiringDecisions);
    expect(rows.filter((r) => r.status === "sent").map((r) => r.decision)).toEqual(["hire"]);
  });
});

describe("no duplicate result email", () => {
  it.each(["failed", "pending", "uncertain"] as const)("cancels an earlier %s result email at the next Send, so only the new one leaves", async (status) => {
    const c = await candidate();
    await results(c.id);
    const first = await draftDecision(c.id, { decision: "hire", reason: "" }, "a", db);
    const firstKey = await sendDecision(first.id, { emailSubject: "First", emailBody: "First." }, "a", db);
    await db.update(s.hiringOutbox).set({ status }).where(eq(s.hiringOutbox.key, firstKey));
    if (status === "pending") await expect(draftDecision(c.id, { decision: "hire", reason: "" }, "a", db)).rejects.toThrow(/on its way/);
    else {
      const second = await draftDecision(c.id, { decision: "hire", reason: "" }, "a", db);
      await sendDecision(second.id, { emailSubject: "Second", emailBody: "Second." }, "a", db);
      await deliverOutbox(db, on);
      expect(sendEmail.mock.calls.map((call) => call[0].subject)).toEqual(["Second"]);
      expect((await outbox()).find((r) => r.key === firstKey)!.status).toBe("cancelled");
    }
  });
  it("cancels an unsent email when the decision changes", async () => {
    const c = await candidate();
    await results(c.id);
    const first = await draftDecision(c.id, { decision: "hire", reason: "" }, "a", db);
    await sendDecision(first.id, { emailSubject: "First", emailBody: "First." }, "a", db);
    const second = await draftDecision(c.id, { decision: "reject", reason: "Changed my mind" }, "a", db);
    await sendDecision(second.id, { emailSubject: "Second", emailBody: "Second." }, "a", db);
    await deliverOutbox(db, on);
    expect(sendEmail.mock.calls.map((call) => call[0].subject)).toEqual(["Second"]);
  });
  it("refuses the same result again after it left, and a Send while one is leaving", async () => {
    const c = await candidate();
    await results(c.id);
    const first = await draftDecision(c.id, { decision: "hire", reason: "" }, "a", db);
    const key = await sendDecision(first.id, email, "a", db);
    await deliverOutbox(db, on);
    await expect(draftDecision(c.id, { decision: "hire", reason: "" }, "a", db)).rejects.toThrow(/already sent/);
    const other = await draftDecision(c.id, { decision: "reject", reason: "Changed my mind" }, "a", db);
    await db.update(s.hiringOutbox).set({ status: "processing" }).where(eq(s.hiringOutbox.key, key));
    await expect(sendDecision(other.id, email, "a", db)).rejects.toThrow(/right now/);
  });
  it("does not send a retried booking email to someone decided", async () => {
    const c = await candidate();
    const past = new Date(Date.now() - 86400000);
    const [booking] = await db.insert(s.hiringBookings).values({ candidateId: c.id, kind: "paper", subjects: ["Mathematics"], calendarOwner: "o@example.com", startTime: past, endTime: new Date(past.getTime() + 3600000), status: "confirmed", visitId: crypto.randomUUID(), evidence: {} as never }).returning();
    await db.insert(s.hiringOutbox).values({ key: "visit-email", candidateId: c.id, bookingId: booking.id, kind: "email", status: "failed", firstAttemptAt: past, payload: { to: "a@example.com", subject: "Visit confirmed", text: "See you" } });
    const draft = await draftDecision(c.id, { decision: "reject", reason: "Left early" }, "a", db);
    await sendDecision(draft.id, email, "a", db);
    await deliverOutbox(db, on);
    expect(sendEmail.mock.calls.map((call) => call[0].subject)).toEqual(["Your result"]);
    expect((await outbox()).find((r) => r.key === "visit-email")!.status).toBe("cancelled");
  });
});

describe("a sent decision stands", () => {
  async function decided() {
    const c = await candidate({ seekApplicationId: "00000000-0000-4000-8000-0000000000aa", sourceIds: ["00000000-0000-4000-8000-0000000000aa"] });
    const draft = await draftDecision(c.id, { decision: "reject", reason: "Left early" }, "a", db);
    await sendDecision(draft.id, email, "a", db);
    return read(c.id);
  }
  it("is not overwritten by a move in SEEK, and its waiting email is not cancelled", async () => {
    const c = await decided();
    await observeSeekState(c.seekApplicationId!, "Not Suitable", true, db);
    const after = await read(c.id);
    expect(after.stage).toBe("rejected");
    expect((await outbox())[0].status).toBe("pending");
  });
  it("counts as new flow for the tracker", () => {
    expect(isNewFlow({ stage: "hired" }, false)).toBe(true);
    expect(isNewFlow({ stage: "rejected" }, false)).toBe(true);
  });
  it("refuses Stop, and cannot be invited", async () => {
    const c = await decided();
    const click = (action: "stop" | "invite_onsite" | "send_new_link") => reviewCandidate(c.id, { action, revision: c.revision, subjects: [], reason: "A person clicked" }, "a", db);
    await expect(click("stop")).rejects.toThrow(/already sent/);
    await expect(click("send_new_link")).rejects.toMatchObject({ status: 409 });
  });
});

describe("words", () => {
  it("offers the right first text for each decision, with no marks in it", () => {
    expect(resultEmail("hire", "Ann", "Physics").body).toMatch(/pleased to offer you the Physics tutor position/);
    expect(resultEmail("reject", "Ann", null).body).toMatch(/will not continue/);
    expect(resultEmail("reject", "Ann", null).body).not.toMatch(/\d/);
  });
  it("says why a send is refused", () => {
    expect(sendRefusal({ enabled: false, deliveryEnabled: false })).toMatch(/must both be on/);
    expect(sendRefusal({ enabled: true, deliveryEnabled: true })).toBeNull();
  });
});
