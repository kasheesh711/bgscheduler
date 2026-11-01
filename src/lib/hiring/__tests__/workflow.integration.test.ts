import {
  beforeAll,
  afterAll,
  beforeEach,
  afterEach,
  describe,
  expect,
  it,
  vi,
} from "vitest";
import { eq, sql } from "drizzle-orm";
import { startTestDb, stopTestDb } from "@/tests/integration/db-helper";
import { type Database } from "@/lib/db";
import * as s from "@/lib/db/schema";
import { configSchema, HiringError, type HiringConfig, type Slot } from "../model";
import { bookingToken } from "../tokens";
import {
  bookInterview,
  bookingView,
  bookVisit,
  dashboard,
  reviewCandidate,
  saveSettings,
  settings,
  sourceHash,
  visitView,
  type Candidate,
} from "../service";
import { importApplication, observeSeekState } from "../sources";
import { assessCandidates, deliverOutbox, rewriteBriefs, scorePreScreens, type Rewrite } from "../worker";
import { readLimitUsage, releaseQueues, runFollowUps } from "../queue";
import { availableSlots, verifyLiveSlot } from "../availability";
import { deliverCalendar } from "../google";
import { ensureIndex } from "@/lib/search/index";
import { createOutboundEmailSender } from "@/lib/email/outbound";
import { pushLineTextMessage } from "@/lib/line/client";

// The visit tests use the real availableVisitSlots against this database. Only the Wise index and the live read are fake.
vi.mock("../availability", async (actual) => ({
  ...(await actual<typeof import("../availability")>()),
  availableSlots: vi.fn(),
  verifyLiveSlot: vi.fn(),
}));
vi.mock("@/lib/search/index", () => ({ ensureIndex: vi.fn() }));
vi.mock("@/lib/email/outbound", () => ({ createOutboundEmailSender: vi.fn() }));
vi.mock("../google", () => ({
  deliverCalendar: vi.fn().mockResolvedValue({ id: "calendar-event" }),
}));
vi.mock("@/lib/line/client", () => ({
  pushLineTextMessage: vi.fn().mockResolvedValue({
    retryKey: "key",
    sentMessageId: "message",
    response: {},
  }),
  LinePushError: class extends Error {
    status = 500;
  },
}));
let handle: Awaited<ReturnType<typeof startTestDb>>, db: Database;
const now = new Date("2026-10-31T00:00:00Z");
const slot: Slot = {
  date: "2026-11-02",
  start: "2026-11-02T03:00:00.000Z",
  end: "2026-11-02T04:00:00.000Z",
  interviewerKey: "Peat",
  subjects: ["Mathematics"],
};
const sendEmail = vi.fn();
const ACCEPTED = "I have permanent work rights with no restrictions";
const config = configSchema.parse({
  enabled: true,
  deliveryEnabled: true,
  interviewers: [
    {
      canonicalKey: "Peat",
      email: "peat@example.com",
      subjects: ["Mathematics", "Physics"],
    },
  ],
});
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
  vi.stubEnv("PROGRESS_LINE_TUTOR_BOT_KEYS", "");
  vi.clearAllMocks();
  await db.execute(
    sql`truncate hiring_audit,hiring_outbox,hiring_bookings,hiring_candidates,hiring_settings,progress_line_groups,tutor_sit_in_observations,tutor_sit_in_assignments cascade`,
  );
  await db.insert(s.hiringSettings).values({
    id: "default",
    config,
    updatedBy: "owner@example.com",
    workerAt: now,
  });
  await db
    .insert(s.tutorContacts)
    .values({ canonicalKey: "Peat", displayName: "Peat" })
    .onConflictDoNothing();
  await db.insert(s.progressLineGroups).values({
    canonicalKey: "Peat",
    groupId: "group",
    groupName: "Peat",
    enabled: true,
    registeredBy: "owner",
  });
  vi.mocked(availableSlots).mockResolvedValue([slot]);
  vi.mocked(verifyLiveSlot).mockResolvedValue({
    source: "wise-live",
    checkedAt: now.toISOString(),
    snapshotId: "snapshot",
  });
  sendEmail.mockReset().mockResolvedValue({ id: "email-receipt" });
  vi.mocked(createOutboundEmailSender).mockReturnValue({ sendEmail });
});
afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllEnvs();
});
async function candidate(email = "candidate@example.com") {
  const [c] = await db
    .insert(s.hiringCandidates)
    .values({
      name: "Candidate",
      email,
      stage: "paper_passed",
      subjects: ["Mathematics"],
      paperPassedSubjects: ["Mathematics"],
      paperPassedAt: now,
      paperRecordedBy: "owner",
      inviteExpiresAt: new Date("2026-11-15T00:00:00Z"),
    })
    .returning();
  return { c, token: bookingToken(c.id, "mock", c.inviteExpiresAt!) };
}
const input = {
  start: slot.start,
  interviewerKey: "Peat",
  subjects: ["Mathematics"],
  onsiteConfirmed: true,
  teachingCommitmentConfirmed: true,
};
describe("hiring workflow persistence", () => {
  it("accepts the new stages and refuses an unknown stage", async () => {
    for (const stage of ["onsite_invited", "onsite_booked", "no_reply", "no_booking"] as const) {
      await db.insert(s.hiringCandidates).values({ name: stage, email: `${stage}@example.com`, stage });
    }
    await expect(
      db.insert(s.hiringCandidates).values({ name: "Bad", email: "bad@example.com", stage: "nope" as never }),
    ).rejects.toThrow();
  });
  it("accepts a mock outside 10:00-16:00 and refuses one over an hour; a paper then a mock back to back do not clash", async () => {
    const [c] = await db.insert(s.hiringCandidates).values({ name: "Visit", email: "visit@example.com" }).returning();
    const row = (kind: "paper" | "mock", start: string, end: string, status: "confirmed" | "no_show" = "confirmed") => ({
      candidateId: c.id,
      kind,
      subjects: ["Mathematics"] as never,
      interviewerKey: kind === "mock" ? "Peat" : null,
      interviewerEmail: kind === "mock" ? "peat@example.com" : null,
      lineGroupId: kind === "mock" ? "group" : null,
      calendarOwner: "owner@example.com",
      startTime: new Date(start),
      endTime: new Date(end),
      status,
      evidence: {},
    });
    // Saturday 08:00-09:00 Bangkok
    await db.insert(s.hiringBookings).values(row("mock", "2026-11-14T01:00:00Z", "2026-11-14T02:00:00Z", "no_show"));
    await expect(
      db.insert(s.hiringBookings).values(row("mock", "2026-11-14T01:00:00Z", "2026-11-14T03:00:00Z")),
    ).rejects.toThrow();
    // Paper 10:00-12:00 then mock 12:00-13:00 Bangkok, same candidate
    await db.insert(s.hiringBookings).values(row("paper", "2026-11-16T03:00:00Z", "2026-11-16T05:00:00Z"));
    await db.insert(s.hiringBookings).values(row("mock", "2026-11-16T05:00:00Z", "2026-11-16T06:00:00Z"));
    // A no_show frees the slot: the same candidate can take the paper hour again
    await db.update(s.hiringBookings).set({ status: "no_show" }).where(eq(s.hiringBookings.kind, "paper"));
    await db.insert(s.hiringBookings).values(row("paper", "2026-11-16T03:00:00Z", "2026-11-16T05:00:00Z"));
  });
  it("does not return outbox payload from dashboard", async () => {
    const [row] = await db
      .insert(s.hiringCandidates)
      .values({ name: "Private", email: "private@example.com", stage: "pre_screen" })
      .returning();
    await db.insert(s.hiringOutbox).values({
      key: `${row.id}:pre-screen`,
      candidateId: row.id,
      kind: "email",
      status: "sent",
      sentAt: now,
      payload: { to: "private@example.com", text: "SECRET BODY", workflowStage: "pre_screen" },
    });
    const { outbox } = await dashboard(db);
    expect(outbox).toHaveLength(1);
    expect(outbox[0]).toMatchObject({ key: `${row.id}:pre-screen`, workflowStage: "pre_screen" });
    expect(outbox[0]).not.toHaveProperty("payload");
    expect(JSON.stringify(outbox)).not.toContain("SECRET BODY");
  });
  it("retries a held source only on explicit review retry and preserves its stage", async () => {
    const paused = { ...config, enabled: false, deliveryEnabled: false };
    const source = "degree subject curriculum teaching english Mathematics";
    await db.update(s.hiringSettings).set({ config: paused }).where(eq(s.hiringSettings.id, "default"));
    const [row] = await db.insert(s.hiringCandidates).values({ name: "Held", stage: "stopped", profileText: source, profileHash: sourceHash(source), reviewNote: "AI evidence could not be verified. Review this application before advancing it." }).returning();
    const assess = vi.fn(async () => ({
      criteria: ["degree", "subject", "curriculum", "teaching", "english"].map(id => ({id,result:"met",evidence:id,reason:"Source"})),
      subjects: [{subject:"Mathematics",evidence:"Mathematics",relevant:true}], summary:"Evidence",
    }));
    expect(await assessCandidates(db, paused, assess, 1, true, row.id)).toBe(0);
    expect(assess).not.toHaveBeenCalled();
    expect(await assessCandidates(db, paused, assess, 1, true, row.id, true)).toBe(1);
    const [saved] = await db.select().from(s.hiringCandidates).where(eq(s.hiringCandidates.id, row.id));
    expect(saved.profileAssessment).not.toBeNull();
    expect(saved.stage).toBe("stopped");
    expect(saved.reviewNote).toBeNull();
    expect(await db.select().from(s.hiringOutbox)).toEqual([]);
  });
  it("scores separate paused candidates concurrently without changing stages or queuing invitations", async () => {
    const paused = { ...config, enabled: false, deliveryEnabled: false };
    await db.update(s.hiringSettings).set({ config: paused }).where(eq(s.hiringSettings.id, "default"));
    const inserted = await db.insert(s.hiringCandidates).values(["new", "stopped"].map(stage => ({
      name: stage, stage: stage as "new" | "stopped", profileText: "degree subject curriculum teaching english Mathematics", reviewNote: "Human review note",
    }))).returning();
    let entered = 0;
    let release!: () => void;
    const gate = new Promise<void>(resolve => { release = resolve; });
    const assess = async () => {
      if (++entered === 2) release();
      await gate;
      return ({
      criteria: ["degree", "subject", "curriculum", "teaching", "english"].map(id => ({id,result:"met",evidence:id,reason:"Source"})),
      subjects: [{subject:"Mathematics",evidence:"Mathematics",relevant:true}], summary:"Evidence",
      });
    };
    expect(await Promise.all(inserted.map(c => assessCandidates(db, paused, assess, 1, true, c.id)))).toEqual([1, 1]);
    const rows = await db.select().from(s.hiringCandidates);
    expect(rows.map(c => c.stage).sort()).toEqual(["new", "stopped"]);
    expect(rows.every(c => c.profileAssessment !== null)).toBe(true);
    expect(rows.every(c => c.reviewNote === "Human review note")).toBe(true);
    expect(await db.select().from(s.hiringOutbox)).toEqual([]);
    const auditCount = (await db.select().from(s.hiringAudit)).length;
    expect(await assessCandidates(db, paused, assess, 10, true)).toBe(0);
    expect((await db.select().from(s.hiringAudit)).length).toBe(auditCount);
  });
  describe("short evidence rewrite", () => {
    const paused = { ...config, enabled: false, deliveryEnabled: false };
    const ids = ["degree", "subject", "curriculum", "teaching", "english"] as const;
    const stored = (withBriefs = false) => ({
      criteria: ids.map((id) => ({ id, result: "met" as const, evidence: id, reason: `The source shows ${id}.`, ...(withBriefs ? { brief: "Kept line." } : {}) })),
      subjects: [{ subject: "Mathematics" as const, evidence: "Mathematics", relevant: true }],
      universities: [],
      summary: "The tutor has a degree and teaches maths.",
      ...(withBriefs ? { briefSummary: "Kept summary." } : {}),
    });
    const short = (text = "Short line.") => ({
      briefSummary: "The tutor has a maths degree.",
      briefs: Object.fromEntries(ids.map((id) => [id, text])),
    });
    const seed = async (assessment = stored()) => {
      await db.update(s.hiringSettings).set({ config: paused }).where(eq(s.hiringSettings.id, "default"));
      const [row] = await db
        .insert(s.hiringCandidates)
        .values({ name: "Rewrite", email: "rewrite@example.com", stage: "review", profileText: "Application text", profileAssessment: assessment, reviewNote: "Human note", revision: 7 })
        .returning();
      await db.insert(s.hiringOutbox).values({ key: `k-${row.id}`, candidateId: row.id, kind: "email", status: "pending", payload: { to: "a@example.com", subject: "s", text: "t" } });
      return row;
    };
    it("rewrite changes only brief fields", async () => {
      const before = await seed();
      const rewrite = vi.fn<Rewrite>(async () => short());
      expect(await rewriteBriefs(db, rewrite, { max: 5 })).toBe(1);
      expect(rewrite).toHaveBeenCalledWith(expect.stringContaining("The source shows degree."), expect.stringContaining(before.id));
      expect(rewrite.mock.calls[0][0]).not.toMatch(/Application text/);
      const [after] = await db.select().from(s.hiringCandidates).where(eq(s.hiringCandidates.id, before.id));
      const a = after.profileAssessment!;
      expect(a.briefSummary).toBe("The tutor has a maths degree.");
      expect(a.criteria.map((c) => c.brief)).toEqual(ids.map(() => "Short line."));
      const strip = (x: typeof a) => {
        const copy = structuredClone(x);
        delete copy.briefSummary;
        for (const c of copy.criteria) delete c.brief;
        return copy;
      };
      expect(strip(a)).toEqual(strip(before.profileAssessment!));
      expect(after.stage).toBe(before.stage);
      expect(after.revision).toBe(before.revision);
      expect(after.reviewNote).toBe("Human note");
      expect(after.updatedAt).toEqual(before.updatedAt);
      expect(after.profileHash).toBe(before.profileHash);
      expect(await db.select().from(s.hiringOutbox)).toHaveLength(1);
      const audits = (await db.select().from(s.hiringAudit)).filter((r) => r.action === "brief-rewrite");
      expect(audits).toHaveLength(1);
      expect(audits[0].candidateId).toBe(before.id);
    });
    it("rewrite skips a row already holding briefs", async () => {
      await seed(stored(true));
      const rewrite = vi.fn(async () => short());
      expect(await rewriteBriefs(db, rewrite, { max: 5 })).toBe(0);
      expect(rewrite).not.toHaveBeenCalled();
      expect(await db.select().from(s.hiringAudit)).toEqual([]);
    });
    it("retries a line over its limit with the exact count, then leaves the row without briefs", async () => {
      const row = await seed();
      const long = { briefSummary: Array(26).fill("w").join(" "), briefs: short().briefs };
      const feedback: string[] = [];
      const answers = [long, short("Fixed line.")];
      expect(await rewriteBriefs(db, async (user) => (feedback.push(user), answers.shift()), { max: 5 })).toBe(1);
      expect(feedback[1]).toMatch(/briefSummary has 26 words\. The limit is 25/);
      const [fixed] = await db.select().from(s.hiringCandidates).where(eq(s.hiringCandidates.id, row.id));
      expect(fixed.profileAssessment!.criteria[0].brief).toBe("Fixed line.");
      await db.update(s.hiringCandidates).set({ profileAssessment: stored() }).where(eq(s.hiringCandidates.id, row.id));
      const rewrite = vi.fn(async () => long);
      expect(await rewriteBriefs(db, rewrite, { max: 5 })).toBe(1);
      expect(rewrite).toHaveBeenCalledTimes(4);
      const [kept] = await db.select().from(s.hiringCandidates).where(eq(s.hiringCandidates.id, row.id));
      expect(kept.profileAssessment).toEqual(stored());
      expect((await db.select().from(s.hiringAudit)).some((a) => a.action === "brief-rewrite-skipped")).toBe(true);
    });
    it("needs a brief for every criterion the row holds, including written on a pre-screen", async () => {
      const row = await seed();
      const six = { ...stored(), criteria: [...stored().criteria, { id: "written" as const, result: "met" as const, evidence: "", reason: "Specific actions." }] };
      await db.update(s.hiringCandidates).set({ profileAssessment: null, preScreenAssessment: six }).where(eq(s.hiringCandidates.id, row.id));
      const answers = [short(), { ...short(), briefs: { ...short().briefs, written: "Names clear actions." } }];
      expect(await rewriteBriefs(db, async () => answers.shift(), { max: 5 })).toBe(1);
      const [after] = await db.select().from(s.hiringCandidates).where(eq(s.hiringCandidates.id, row.id));
      expect(after.preScreenAssessment!.criteria.at(-1)!.brief).toBe("Names clear actions.");
      expect(after.profileAssessment).toBeNull();
    });
    it("stops at max and rewrites one candidate on request", async () => {
      const first = await seed();
      const [second] = await db.insert(s.hiringCandidates).values({ name: "Two", email: "two@example.com", profileText: "x", profileAssessment: stored() }).returning();
      const rewrite = vi.fn(async () => short());
      expect(await rewriteBriefs(db, rewrite, { max: 1 })).toBe(1);
      expect(await rewriteBriefs(db, rewrite, { max: 5, candidateId: first.id })).toBe(0);
      expect(await rewriteBriefs(db, rewrite, { max: 5, candidateId: second.id })).toBe(1);
    });
    it("refuses to run while hiring or messages are on, and writes nothing if they are switched on during the call", async () => {
      const row = await seed();
      const rewrite = vi.fn(async () => short());
      await db.update(s.hiringSettings).set({ config: { ...paused, enabled: true } }).where(eq(s.hiringSettings.id, "default"));
      await expect(rewriteBriefs(db, rewrite, { max: 5 })).rejects.toThrow(/Pause/);
      await db.update(s.hiringSettings).set({ config: { ...paused, deliveryEnabled: true } }).where(eq(s.hiringSettings.id, "default"));
      await expect(rewriteBriefs(db, rewrite, { max: 5 })).rejects.toThrow(/Pause/);
      expect(rewrite).not.toHaveBeenCalled();
      await db.update(s.hiringSettings).set({ config: paused }).where(eq(s.hiringSettings.id, "default"));
      await rewriteBriefs(db, async () => {
        await db.update(s.hiringSettings).set({ config: { ...paused, enabled: true } }).where(eq(s.hiringSettings.id, "default"));
        return short();
      }, { max: 5 });
      const [after] = await db.select().from(s.hiringCandidates).where(eq(s.hiringCandidates.id, row.id));
      expect(after.profileAssessment).toEqual(stored());
    });
    it("does not overwrite an assessment that was scored again during the call", async () => {
      const row = await seed();
      await rewriteBriefs(db, async () => {
        await db.update(s.hiringCandidates).set({ profileAssessment: { ...stored(), summary: "Rescored." } }).where(eq(s.hiringCandidates.id, row.id));
        return short();
      }, { max: 5 });
      const [after] = await db.select().from(s.hiringCandidates).where(eq(s.hiringCandidates.id, row.id));
      expect(after.profileAssessment).toEqual({ ...stored(), summary: "Rescored." });
    });
  });
  describe("switch-on", () => {
    it("saves with automation on, and still needs the rubric and the write gate", async () => {
      const revision = (await settings(db)).row!.revision;
      await saveSettings({ ...config, enabled: true, deliveryEnabled: false }, revision, "owner@example.com", db);
      const saved = await settings(db);
      expect(saved.config.enabled).toBe(true);
      await expect(
        saveSettings({ ...config, enabled: true, deliveryEnabled: false, rubricApproved: false }, saved.row!.revision, "owner@example.com", db),
      ).rejects.toThrow(/rubric/);
    });
  });
  it("records an unseen work-rights answer for the settings and never accepts it", async () => {
    const other = "I am a long term / permanent resident with eligibility for a work permit";
    const application = (n: number, rights: string | null) => ({
      applicationId: `00000000-0000-4000-8000-0000000001${n}0`,
      name: `Rights ${n}`,
      email: `rights${n}@example.com`,
      profileText: "profile",
      previouslyContacted: false,
      sourceStatus: "Inbox",
      workRightsAnswer: rights,
    });
    const before = (await settings(db)).row!.revision;
    const id = await importApplication(application(1, other), db);
    const read = async () => (await settings(db)).row!;
    const first = await read();
    expect(first.revision).toBe(before + 1);
    expect(configSchema.parse(first.config).seenWorkRights).toEqual([other]);
    expect(configSchema.parse(first.config).acceptedWorkRights).toEqual([ACCEPTED]);
    const [saved] = await db.select().from(s.hiringCandidates).where(eq(s.hiringCandidates.id, id));
    expect(saved.workRightsAnswer).toBe(other);
    // The same answer again, and a missing answer, change nothing.
    await importApplication(application(2, ` ${other.toUpperCase()} `), db);
    await importApplication(application(3, null), db);
    expect((await read()).revision).toBe(before + 1);
    await importApplication(application(4, ACCEPTED), db);
    expect(configSchema.parse((await read()).config).seenWorkRights).toEqual([other, ACCEPTED]);
    // A later import with no answer keeps the stored one.
    await importApplication({ ...application(1, null), profileText: "changed profile" }, db);
    const [again] = await db.select().from(s.hiringCandidates).where(eq(s.hiringCandidates.id, id));
    expect(again.workRightsAnswer).toBe(other);
  });
  it("keeps the answer on the candidate, and leaves the settings alone, when the seen list is full", async () => {
    const seen = Array.from({ length: 200 }, (_, i) => `Answer ${i}`);
    const full = { ...config, seenWorkRights: seen };
    await db.update(s.hiringSettings).set({ config: full }).where(eq(s.hiringSettings.id, "default"));
    const before = (await settings(db)).row!.revision;
    const id = await importApplication(
      {
        applicationId: "00000000-0000-4000-8000-000000000199",
        name: "Full list",
        email: "fulllist@example.com",
        profileText: "profile",
        previouslyContacted: false,
        sourceStatus: "Inbox",
        workRightsAnswer: "A new answer",
      },
      db,
    );
    const [c] = await db.select().from(s.hiringCandidates).where(eq(s.hiringCandidates.id, id));
    expect(c.workRightsAnswer).toBe("A new answer");
    const after = await settings(db);
    expect(after.row!.revision).toBe(before);
    expect(after.config.seenWorkRights).toHaveLength(200);
  });
  describe("score-only pre-screen pass", () => {
    const paused = { ...config, enabled: false, deliveryEnabled: false };
    const pre = {
      sourceRow: 2,
      submittedAt: "31/10/2026, 18:30:05",
      degree: "Bachelor's",
      field: "Mathematics",
      subjects: "Mathematics",
      curricula: "IGCSE",
      yearGroups: "Year 10",
      english: "Advanced (C1)",
      englishEvidence: "C1",
      experience: "5+ years",
      portfolio: "",
      availability: "Weekday Evening (17:00-21:00), Weekend Morning (before 12:00)",
      weeklyHours: "20",
      motivation: "Teaching",
      teachingApproach: "Check understanding",
    };
    const six = (evidence = "Check understanding") => ({
      criteria: ["degree", "subject", "curriculum", "teaching", "english", "written"].map((id) => ({
        id,
        result: "met",
        evidence: id === "written" ? evidence : "Mathematics",
        reason: "Source",
      })),
      subjects: [{ subject: "Mathematics", evidence: "Mathematics", relevant: true }],
      summary: "Evidence",
    });
    const seed = async () => {
      await db.update(s.hiringSettings).set({ config: paused }).where(eq(s.hiringSettings.id, "default"));
      return db
        .insert(s.hiringCandidates)
        .values(
          (["new", "review", "stopped", "pre_screen"] as const).map((stage) => ({
            name: stage,
            email: `${stage}@example.com`,
            stage,
            preScreen: pre,
            profileText: "Application text",
            reviewNote: "Human note",
          })),
        )
        .returning();
    };
    it("scores every stage with no stage change, no outbox row, and one audit row with the source hash", async () => {
      const rows = await seed();
      await db.insert(s.hiringCandidates).values({ name: "No response", stage: "new", profileText: "x" });
      const assess = vi.fn(async () => six());
      expect(await scorePreScreens(db, paused, assess)).toBe(4);
      expect(assess).toHaveBeenCalledWith(expect.stringContaining("teachingApproach: Check understanding"), expect.stringContaining(":pre:"), "pre-screen", expect.any(String));
      const after = await db.select().from(s.hiringCandidates);
      expect(after.filter((c) => c.preScreenAssessment).map((c) => c.stage).sort()).toEqual(["new", "pre_screen", "review", "stopped"]);
      expect(after.find((c) => c.name === "No response")?.preScreenAssessment).toBeNull();
      expect(after.filter((c) => c.preScreen).every((c) => c.reviewNote === "Human note")).toBe(true);
      expect(await db.select().from(s.hiringOutbox)).toEqual([]);
      const audits = (await db.select().from(s.hiringAudit)).filter((a) => a.action === "pre-screen-score-only");
      expect(audits).toHaveLength(4);
      for (const a of audits) {
        const c = rows.find((r) => r.id === a.candidateId)!;
        expect((a.detail as { sourceHash: string }).sourceHash).toBe(
          after.find((x) => x.id === c.id)!.preScreenHash,
        );
      }
      // An unchanged response is not scored again.
      expect(await scorePreScreens(db, paused, assess)).toBe(0);
      expect(assess).toHaveBeenCalledTimes(4);
    });
    it("scores one candidate on request and keeps the profile's university result", async () => {
      const [one, two] = await seed();
      const kept = { name: "Kept", country: "GB", rank: 5, edition: "2025-2026", fraction: 1, reason: "kept", sources: [], catalogHash: sourceHash(paused.universities) };
      await db.update(s.hiringCandidates).set({ universityAssessment: kept }).where(eq(s.hiringCandidates.id, one.id));
      const assess = vi.fn(async () => six());
      expect(await scorePreScreens(db, paused, assess, { candidateId: one.id })).toBe(1);
      const [scored] = await db.select().from(s.hiringCandidates).where(eq(s.hiringCandidates.id, one.id));
      expect(scored.universityAssessment).toEqual(kept);
      const [other] = await db.select().from(s.hiringCandidates).where(eq(s.hiringCandidates.id, two.id));
      expect(other.preScreenAssessment).toBeNull();
    });
    it("holds an answer whose quote is not in the source, once, and changes nothing else", async () => {
      const [one] = await seed();
      const assess = vi.fn(async () => six("invented quote"));
      expect(await scorePreScreens(db, paused, assess, { candidateId: one.id })).toBe(1);
      expect(await scorePreScreens(db, paused, assess, { candidateId: one.id })).toBe(0);
      const [row] = await db.select().from(s.hiringCandidates).where(eq(s.hiringCandidates.id, one.id));
      expect(row.preScreenAssessment).toBeNull();
      expect(row.preScreenHash).not.toBeNull();
      expect([row.stage, row.reviewNote]).toEqual([one.stage, "Human note"]);
      expect((await db.select().from(s.hiringAudit)).some((a) => a.action === "pre-screen-invalid-evidence")).toBe(true);
    });
    it("scores a held answer again only on an explicit retry", async () => {
      const [one] = await seed();
      const bad = vi.fn(async () => six("invented quote"));
      expect(await scorePreScreens(db, paused, bad, { candidateId: one.id })).toBe(1);
      expect(await scorePreScreens(db, paused, bad, { candidateId: one.id })).toBe(0);
      const good = vi.fn(async () => six());
      expect(await scorePreScreens(db, paused, good, { candidateId: one.id, retryInvalid: true })).toBe(1);
      const [row] = await db.select().from(s.hiringCandidates).where(eq(s.hiringCandidates.id, one.id));
      expect(row.preScreenAssessment).not.toBeNull();
      expect([row.stage, row.reviewNote]).toEqual([one.stage, "Human note"]);
      // A scored answer is not retried.
      expect(await scorePreScreens(db, paused, good, { candidateId: one.id, retryInvalid: true })).toBe(0);
    });
    it("redacts the candidate's name and contact details before the model sees the free text", async () => {
      await db.update(s.hiringSettings).set({ config: paused }).where(eq(s.hiringSettings.id, "default"));
      const [row] = await db
        .insert(s.hiringCandidates)
        .values({
          name: "Pat Smith",
          email: "pat@example.com",
          stage: "review",
          profileText: "Application text",
          preScreen: {
            ...pre,
            motivation: "I am Pat Smith. Write to pat.smith@example.com.",
            teachingApproach: "Pat Smith would ask what went wrong. Call +66 81 234 5678.",
            englishEvidence: "Pat Smith, IELTS 8",
            portfolio: "Pat Smith portfolio",
          },
        })
        .returning();
      const seen: { source: string; written?: string }[] = [];
      const assess = vi.fn(async (source: string, _key: string, _kind?: string, written?: string) => {
        seen.push({ source, written });
        return six("would ask what went wrong");
      });
      expect(await scorePreScreens(db, paused, assess, { candidateId: row.id })).toBe(1);
      expect(seen[0].source).not.toMatch(/Pat Smith|pat\.smith@|5678/);
      expect(seen[0].source).toContain("motivation: I am [candidate]. Write to [email].");
      expect(seen[0].source).toContain("[candidate] would ask what went wrong. Call [phone].");
      expect(seen[0].written).not.toMatch(/Pat Smith/);
      const [saved] = await db.select().from(s.hiringCandidates).where(eq(s.hiringCandidates.id, row.id));
      expect(saved.preScreenAssessment).not.toBeNull();
    });
    it("holds a written quote that comes from the CV rather than the written answers", async () => {
      const [one] = await seed();
      await db.update(s.hiringCandidates).set({ profileText: "Taught at Springfield School" }).where(eq(s.hiringCandidates.id, one.id));
      const assess = vi.fn(async () => six("Taught at Springfield School"));
      expect(await scorePreScreens(db, paused, assess, { candidateId: one.id })).toBe(1);
      const [row] = await db.select().from(s.hiringCandidates).where(eq(s.hiringCandidates.id, one.id));
      expect(row.preScreenAssessment).toBeNull();
      expect(row.preScreenHash).not.toBeNull();
    });
    it("leaves a university correction made during the model call alone", async () => {
      const [one] = await seed();
      const catalogHash = sourceHash(paused.universities);
      const before = { name: "Before", country: "GB", rank: 5, edition: "2025-2026", fraction: 1, reason: "before", sources: [], catalogHash };
      const corrected = { ...before, name: "Corrected", fraction: 0.5, reason: "corrected by a person" };
      await db.update(s.hiringCandidates).set({ universityAssessment: before }).where(eq(s.hiringCandidates.id, one.id));
      const assess = vi.fn(async () => {
        // A correction does not change the row's revision.
        await db.update(s.hiringCandidates).set({ universityAssessment: corrected }).where(eq(s.hiringCandidates.id, one.id));
        return six();
      });
      expect(await scorePreScreens(db, paused, assess, { candidateId: one.id })).toBe(1);
      const [row] = await db.select().from(s.hiringCandidates).where(eq(s.hiringCandidates.id, one.id));
      expect(row.preScreenAssessment).not.toBeNull();
      expect(row.universityAssessment).toEqual(corrected);
    });
    it("recomputes a stale university result from the profile's universities, not the pre-screen's", async () => {
      const catalog = [{ name: "Test University", aliases: [], country: "GB", rank: 5, edition: "2025-2026", sourceUrl: "https://example.com/rank" }];
      const custom = configSchema.parse({ ...paused, universities: catalog });
      await db.update(s.hiringSettings).set({ config: custom }).where(eq(s.hiringSettings.id, "default"));
      const stale = { name: null, country: null, rank: null, edition: null, fraction: 0, reason: "old", sources: [], catalogHash: "old-catalog" };
      const profileAssessment = {
        criteria: ["degree", "subject", "curriculum", "teaching", "english"].map((id) => ({ id, result: "met", evidence: "x", reason: "r" })),
        subjects: [],
        universities: [{ name: "Test University", evidence: "x", completedDegree: true }],
        summary: "s",
      };
      const [one] = await db
        .insert(s.hiringCandidates)
        .values({ name: "Stale", stage: "review", profileText: "Application text", preScreen: pre, universityAssessment: stale, profileAssessment: profileAssessment as never })
        .returning();
      // The pre-screen answer names no university.
      expect(await scorePreScreens(db, custom, async () => six(), { candidateId: one.id })).toBe(1);
      const [row] = await db.select().from(s.hiringCandidates).where(eq(s.hiringCandidates.id, one.id));
      expect(row.universityAssessment?.name).toBe("Test University");
      expect(row.universityAssessment?.catalogHash).toBe(sourceHash(custom.universities));
      const audit = (await db.select().from(s.hiringAudit)).find((a) => a.action === "pre-screen-score-only");
      expect(audit?.detail).toMatchObject({ sourceHash: row.preScreenHash });
    });
    it("reports a finished answer that could not be stored", async () => {
      const [one] = await seed();
      const voided = vi.fn();
      const assess = async () => {
        await db.update(s.hiringSettings).set({ config: { ...paused, enabled: true } }).where(eq(s.hiringSettings.id, "default"));
        return six();
      };
      expect(await scorePreScreens(db, paused, assess, { candidateId: one.id, onVoided: voided })).toBe(1);
      expect(voided).toHaveBeenCalledTimes(1);
      const [row] = await db.select().from(s.hiringCandidates).where(eq(s.hiringCandidates.id, one.id));
      expect(row.preScreenAssessment).toBeNull();
    });
    it("makes no model call while the rubric is not approved", async () => {
      await seed();
      const assess = vi.fn(async () => six());
      await expect(scorePreScreens(db, { ...paused, rubricApproved: false }, assess)).rejects.toThrow(/rubric/);
      expect(assess).not.toHaveBeenCalled();
    });
    it("refuses to run while hiring or messages are on", async () => {
      await seed();
      const assess = vi.fn(async () => six());
      await expect(scorePreScreens(db, { ...paused, enabled: true }, assess)).rejects.toThrow(/Pause/);
      await expect(scorePreScreens(db, { ...paused, deliveryEnabled: true }, assess)).rejects.toThrow(/Pause/);
      expect(assess).not.toHaveBeenCalled();
      // The settings row can be switched on after the check; the write is then skipped.
      await db.update(s.hiringSettings).set({ config: { ...paused, enabled: true } }).where(eq(s.hiringSettings.id, "default"));
      await scorePreScreens(db, paused, assess);
      expect((await db.select().from(s.hiringCandidates)).every((c) => c.preScreenAssessment === null)).toBe(true);
    });
  });
  describe("one-visit booking", () => {
    const LINE = "https://lin.ee/OjMHF41";
    const LINK = new Date("2026-11-30T00:00:00Z");
    const EXAM = "2026-11-02T03:00:00.000Z";
    const MOCK = "2026-11-02T05:00:00.000Z";
    const MOCK_END = "2026-11-02T06:00:00.000Z";
    const EXAM_TUE = "2026-11-03T03:00:00.000Z";
    const week = [null, ...Array.from({ length: 5 }, () => ({ start: "10:00", end: "16:00" })), null];
    const peat = { canonicalKey: "Peat", email: "peat@example.com", subjects: ["Mathematics", "Physics"], fallbackWeek: week };
    const ek = { canonicalKey: "Ek", email: "ek@example.com", subjects: ["Mathematics", "Physics"], fallbackWeek: week };
    const base = configSchema.parse({ enabled: true, deliveryEnabled: true, preScreenThreshold: 50, interviewers: [peat] });
    const setVisit = async (patch: Partial<HiringConfig> = {}) =>
      db.update(s.hiringSettings).set({ config: { ...base, ...patch } }).where(eq(s.hiringSettings.id, "default"));
    const pre = {
      sourceRow: 2,
      submittedAt: "31/10/2026, 01:00:00",
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
    const six = {
      criteria: ["degree", "subject", "curriculum", "teaching", "english", "written"].map((id) => ({
        id,
        result: "met",
        evidence: "Mathematics",
        reason: "Source",
      })),
      subjects: [{ subject: "Mathematics", evidence: "Mathematics", relevant: true }],
      universities: [],
      summary: "Evidence",
    };
    let serial = 0;
    /** A candidate who holds a current link, as a release leaves them. */
    async function invited(values: Partial<typeof s.hiringCandidates.$inferInsert> = {}, sentAt: Date | null = now) {
      serial++;
      const [row] = await db
        .insert(s.hiringCandidates)
        .values({
          name: `Visitor ${serial}`,
          email: `visitor${serial}@example.com`,
          stage: "onsite_invited",
          subjects: ["Mathematics"],
          visitSubject: "Mathematics",
          workRightsAnswer: ACCEPTED,
          preScreen: pre,
          preScreenAssessment: six as never,
          preScreenRepliedAt: now,
          inviteExpiresAt: LINK,
          ...values,
        })
        .returning();
      await db.insert(s.hiringOutbox).values({
        key: `${row.id}:visit-invite`,
        candidateId: row.id,
        kind: "email",
        status: sentAt ? "sent" : "pending",
        sentAt,
        createdAt: now,
        payload: { to: row.email, subject: "s", text: "t", workflowStage: "onsite_invited", revision: row.revision },
      });
      return row;
    }
    const link = (row: Candidate, expires = row.inviteExpiresAt!) => bookingToken(row.id, "visit", expires);
    const choice = (start = EXAM, extra: Record<string, unknown> = {}) => ({
      start,
      subject: "Mathematics",
      onsiteConfirmed: true,
      teachingCommitmentConfirmed: true,
      ...extra,
    });
    const read = async (id: string) =>
      (await db.select().from(s.hiringCandidates).where(eq(s.hiringCandidates.id, id)))[0];
    const rowsOf = async (id: string) =>
      (await db.select().from(s.hiringBookings).where(eq(s.hiringBookings.candidateId, id))).sort(
        (a, b) => a.startTime.getTime() - b.startTime.getTime(),
      );
    const jobsOf = async (id: string) => db.select().from(s.hiringOutbox).where(eq(s.hiringOutbox.candidateId, id));
    const click = async (id: string, action: Parameters<typeof reviewCandidate>[1]["action"], subjects: Parameters<typeof reviewCandidate>[1]["subjects"] = ["Mathematics"], reason = "Checked by a person") =>
      reviewCandidate(id, { revision: (await read(id)).revision, action, subjects, reason }, "staff@example.com", db);
    /** The link in the newest invitation email. */
    const newestLink = async (id: string) => {
      const rows = (await jobsOf(id)).filter((j) => j.payload.workflowStage === "onsite_invited" && !j.key.includes("reminder"));
      const text = String(rows.sort((a, b) => b.createdAt.getTime() - a.createdAt.getTime())[0].payload.text);
      return text.match(/\/hiring\/book\/([\w.-]+)/)![1];
    };
    beforeEach(async () => {
      await setVisit();
      await db.insert(s.tutorContacts).values({ canonicalKey: "Ek", displayName: "Ek" }).onConflictDoNothing();
      await db.insert(s.progressLineGroups).values({ canonicalKey: "Ek", groupId: "ek-group", groupName: "Ek", enabled: true, registeredBy: "owner" });
      const group = (canonicalKey: string) => ({
        canonicalKey,
        leavesCompleteThrough: new Date("2027-06-01T00:00:00Z"),
        leaves: [],
        sessionBlocks: [],
        dataIssues: [],
        wiseRecords: [],
      });
      vi.mocked(ensureIndex).mockImplementation(
        async () => ({ snapshotId: "snapshot", syncedAt: new Date(), tutorGroups: [group("Peat"), group("Ek")] }) as never,
      );
    });

    it("books an exam row and a mock row with one visit_id", async () => {
      const row = await invited();
      await bookVisit(link(row), choice(), db);
      const [exam, mock] = await rowsOf(row.id);
      expect([exam.kind, exam.startTime.toISOString(), exam.endTime.toISOString(), exam.interviewerKey]).toEqual(["paper", EXAM, MOCK, null]);
      expect([mock.kind, mock.startTime.toISOString(), mock.endTime.toISOString(), mock.interviewerKey]).toEqual(["mock", MOCK, MOCK_END, "Peat"]);
      expect(exam.visitId).toBeTruthy();
      expect(mock.visitId).toBe(exam.visitId);
      expect((await read(row.id)).stage).toBe("onsite_booked");
      // The live Wise read is for the head's hour, not the exam.
      expect(verifyLiveSlot).toHaveBeenCalledWith(db, expect.objectContaining({ start: MOCK, end: MOCK_END, interviewerKey: "Peat" }));
      // A retry returns the same visit.
      await bookVisit(link(row), choice(), db);
      expect(await rowsOf(row.id)).toHaveLength(2);
    });
    it("sends one email holding both times", async () => {
      const row = await invited();
      await bookVisit(link(row), choice(), db);
      const jobs = (await jobsOf(row.id)).filter((j) => j.bookingId);
      expect(jobs.map((j) => j.kind).sort()).toEqual(["calendar", "calendar", "email", "line"]);
      const text = String(jobs.find((j) => j.kind === "email")!.payload.text);
      expect(text).toContain("10:00");
      expect(text).toContain("12:00");
      expect(text).toContain("13:00");
      expect(text).toContain(LINE);
      await deliverOutbox(db, base);
      expect(sendEmail).toHaveBeenCalledTimes(1);
      expect(vi.mocked(deliverCalendar)).toHaveBeenCalledTimes(2);
      expect(vi.mocked(pushLineTextMessage)).toHaveBeenCalledTimes(1);
    });
    it("candidates cannot pick a head", async () => {
      const row = await invited();
      await expect(bookVisit(link(row), choice(EXAM, { interviewerKey: "Ek" }), db)).rejects.toThrow();
      expect(await rowsOf(row.id)).toEqual([]);
      // Ek has fewer mocks this week, so the server assigns Ek, and each time appears once.
      await setVisit({ interviewers: [peat, ek] } as never);
      const other = await invited();
      await bookVisit(link(other), choice(EXAM), db);
      const view = await visitView(link(row), db);
      expect(view.slots.filter((v) => v.examStart === EXAM_TUE)).toHaveLength(1);
      await bookVisit(link(row), choice(EXAM_TUE), db);
      const heads = [(await rowsOf(other.id))[1].interviewerKey, (await rowsOf(row.id))[1].interviewerKey];
      expect(heads).toEqual(["Peat", "Ek"]);
    });
    it("refuses a subject other than the visit subject and a token of another kind", async () => {
      const row = await invited();
      await expect(bookVisit(link(row), choice(EXAM, { subject: "Physics" }), db)).rejects.toThrow(HiringError);
      await expect(bookVisit(bookingToken(row.id, "mock", LINK), choice(), db)).rejects.toThrow(HiringError);
      await expect(visitView(bookingToken(row.id, "paper", LINK), db)).rejects.toThrow(HiringError);
      await expect(bookingView(link(row), undefined, db)).rejects.toThrow(HiringError);
    });
    it("moves once, cancels the old rows, and notifies the head", async () => {
      const row = await invited();
      await bookVisit(link(row), choice(), db);
      const before = await rowsOf(row.id);
      await deliverOutbox(db, base);
      sendEmail.mockClear();
      vi.mocked(pushLineTextMessage).mockClear();
      await expect(bookVisit(link(row), choice(EXAM_TUE), db)).rejects.toThrow(/already/);
      await bookVisit(link(row), choice(EXAM_TUE, { move: true }), db);
      const all = await rowsOf(row.id);
      expect(all.filter((b) => b.status === "cancelled").map((b) => b.id).sort()).toEqual(before.map((b) => b.id).sort());
      const fresh = all.filter((b) => b.status === "confirmed");
      expect(fresh.map((b) => b.rescheduleOf).sort()).toEqual(before.map((b) => b.id).sort());
      expect(fresh[0].visitId).toBe(fresh[1].visitId);
      expect(fresh[0].visitId).not.toBe(before[0].visitId);
      const jobs = (await jobsOf(row.id)).filter((j) => j.status === "pending");
      expect(jobs.map((j) => j.kind).sort()).toEqual(["calendar", "calendar", "calendar_cancel", "calendar_cancel", "email", "line"]);
      expect(jobs.find((j) => j.kind === "line")!.payload).toEqual({ notice: "moved" });
      expect((await read(row.id)).stage).toBe("onsite_booked");
      await deliverOutbox(db, base);
      expect(sendEmail).toHaveBeenCalledTimes(1);
      expect(vi.mocked(pushLineTextMessage).mock.calls[0][0].text).toMatch(/moved/i);
      expect(vi.mocked(deliverCalendar).mock.calls.filter((c) => c[4] === true)).toHaveLength(2);
      // The same link still opens the moved visit.
      const view = await visitView(link(row), db);
      expect(view.visit?.examStart).toBe(EXAM_TUE);
      expect(view.canMove).toBe(false);
    });
    it("tells the old head when a move assigns another head", async () => {
      const row = await invited();
      await bookVisit(link(row), choice(), db);
      expect((await rowsOf(row.id))[1].interviewerKey).toBe("Peat");
      await setVisit({ interviewers: [ek] } as never);
      await bookVisit(link(row), choice(EXAM_TUE, { move: true }), db);
      const confirmed = (await rowsOf(row.id)).filter((b) => b.status === "confirmed");
      expect(confirmed[1].interviewerKey).toBe("Ek");
      const lines = (await jobsOf(row.id)).filter((j) => j.kind === "line" && j.status === "pending");
      expect(lines.map((j) => j.payload.notice).sort()).toEqual(["cancelled", "moved"]);
      await deliverOutbox(db, base);
      expect(vi.mocked(pushLineTextMessage).mock.calls.map((c) => c[0].to).sort()).toEqual(["ek-group", "group"]);
    });
    it("lets a move take the head's week place the visit already holds", async () => {
      await setVisit({ onsiteLimits: { perWeek: 3, unbooked: 2, perHeadPerWeek: 1, perSubject: 2 } } as never);
      const row = await invited();
      await bookVisit(link(row), choice(), db);
      const view = await visitView(link(row), db);
      expect(view.canMove).toBe(true);
      // The current time is not offered, and the move stays in the same week with the same head.
      expect(view.slots.map((v) => v.examStart)).toContain(EXAM_TUE);
      expect(view.slots.map((v) => v.examStart)).not.toContain(EXAM);
      await bookVisit(link(row), choice(EXAM_TUE, { move: true }), db);
      expect((await rowsOf(row.id)).filter((b) => b.status === "confirmed")).toHaveLength(2);
    });
    it("refuses a second move and a move inside 24 hours, with the LINE contact", async () => {
      const row = await invited();
      await bookVisit(link(row), choice(), db);
      await bookVisit(link(row), choice(EXAM_TUE, { move: true }), db);
      await expect(bookVisit(link(row), choice("2026-11-04T03:00:00.000Z", { move: true }), db)).rejects.toThrow(LINE);
      const view = await visitView(link(row), db);
      expect(view.notice).toContain(LINE);
      expect(view.slots).toEqual([]);

      const late = await invited();
      await bookVisit(link(late), choice("2026-11-04T03:00:00.000Z"), db);
      // Tuesday 11:00 Bangkok: 23 hours before Wednesday's exam.
      vi.setSystemTime(new Date("2026-11-03T04:00:00Z"));
      await expect(bookVisit(link(late), choice("2026-11-05T03:00:00.000Z", { move: true }), db)).rejects.toThrow(LINE);
      expect((await visitView(link(late), db)).canMove).toBe(false);
      // At exactly 24 hours the move is still allowed.
      vi.setSystemTime(new Date("2026-11-03T03:00:00Z"));
      expect((await visitView(link(late), db)).canMove).toBe(true);
    });
    it("keeps a booked link valid until the visit starts, past the unbooked expiry", async () => {
      const booked = await invited();
      await bookVisit(link(booked), choice("2026-11-06T03:00:00.000Z"), db);
      const unbooked = await invited({}, new Date("2026-10-24T00:00:00Z"));
      // Seven days after the send: the worker has not run, and the unbooked link is closed all the same.
      await expect(visitView(link(unbooked), db)).rejects.toThrow(LINE);
      await expect(bookVisit(link(unbooked), choice(EXAM_TUE), db)).rejects.toThrow(LINE);
      // Booked: open just before the start, closed at the start.
      vi.setSystemTime(new Date("2026-11-06T02:59:00Z"));
      expect((await visitView(link(booked), db)).visit).not.toBeNull();
      vi.setSystemTime(new Date("2026-11-06T03:00:00Z"));
      await expect(visitView(link(booked), db)).rejects.toThrow(LINE);
    });
    it("offers only times inside the link's 30-day life, so a booked link outlives the wait to the visit", async () => {
      const short = new Date("2026-11-03T00:00:00Z");
      const row = await invited({ inviteExpiresAt: short });
      const view = await visitView(link(row), db);
      expect(view.slots.length).toBeGreaterThan(0);
      expect(view.slots.every((v) => new Date(v.examStart) < short)).toBe(true);
      await expect(bookVisit(link(row), choice(EXAM_TUE), db)).rejects.toThrow(/no longer available|taken|changed/);
    });
    it("closes a link whose life has ended, with no reminder holding a dead link", async () => {
      await setVisit({ onsiteFollowUp: { remindDays: 40, expireDays: 60 } });
      const row = await invited({ inviteExpiresAt: new Date("2026-11-01T00:00:00Z") });
      vi.setSystemTime(new Date("2026-11-02T00:00:00Z"));
      expect(await runFollowUps(db)).toEqual({ reminded: 0, expired: 1 });
      expect((await read(row.id)).stage).toBe("no_booking");
    });
    it("ends the old link after send_new_link", async () => {
      const row = await invited();
      const old = link(row);
      await bookVisit(old, choice(), db);
      await click(row.id, "cancel_visit");
      await expect(visitView(old, db)).rejects.toThrow(LINE);
      vi.setSystemTime(new Date(now.getTime() + 3600000));
      await click(row.id, "send_new_link");
      await expect(visitView(old, db)).rejects.toThrow(LINE);
      await expect(bookVisit(old, choice(), db)).rejects.toThrow(LINE);
      const fresh = await newestLink(row.id);
      expect(fresh).not.toBe(old);
      expect((await visitView(fresh, db)).subject).toBe("Mathematics");
      expect((await read(row.id)).stage).toBe("onsite_invited");
    });
    it("advance to the form obeys limits, work rights and not-hiring", async () => {
      const fresh = async (values: Partial<typeof s.hiringCandidates.$inferInsert> = {}) => {
        serial++;
        return (
          await db
            .insert(s.hiringCandidates)
            .values({ name: `Form ${serial}`, email: `form${serial}@example.com`, stage: "review", workRightsAnswer: ACCEPTED, ...values })
            .returning()
        )[0];
      };
      const forms = async () => (await db.select().from(s.hiringOutbox)).filter((j) => j.key.endsWith(":pre-screen"));
      const rights = await fresh({ workRightsAnswer: "Other" });
      await expect(click(rights.id, "advance")).rejects.toThrow(/work-rights/);
      await expect(click((await fresh({ workRightsAnswer: null })).id, "advance")).rejects.toThrow(/work-rights/);
      await setVisit({ subjectPriority: [{ subject: "Mathematics", hiring: false }] });
      await expect(click((await fresh()).id, "advance")).rejects.toThrow(/open for hiring/);
      await setVisit({ preScreenLimits: { perDay: 1, perWeek: 15, waiting: 15, perSubject: 3 } });
      const first = await fresh();
      await click(first.id, "advance");
      expect((await read(first.id)).stage).toBe("pre_screen");
      const second = await fresh();
      await expect(click(second.id, "advance")).rejects.toThrow(/per day/);
      expect((await read(second.id)).stage).toBe("review");
      expect(await forms()).toHaveLength(1);
      // A cancelled key must not move the stage with no email.
      await setVisit();
      await db.insert(s.hiringOutbox).values({ key: `${second.id}:pre-screen`, candidateId: second.id, kind: "email", status: "cancelled", payload: {} });
      await expect(click(second.id, "advance")).rejects.toThrow(/already/);
      expect((await read(second.id)).stage).toBe("review");
    });
    it("takes the queue lock before the candidate row, and reads limits after it", async () => {
      const row = await invited({ stage: "review", inviteExpiresAt: null, visitSubject: null }, null);
      await db.delete(s.hiringOutbox).where(eq(s.hiringOutbox.candidateId, row.id));
      const revision = (await read(row.id)).revision;
      const client = await handle.pool.connect();
      await client.query("begin");
      await client.query("select pg_advisory_xact_lock(hashtext('hiring-queue'))");
      let settled = false;
      let pending: Promise<unknown>;
      try {
        pending = reviewCandidate(
          row.id,
          { revision, action: "invite_onsite", subjects: [], reason: "Checked by a person" },
          "staff@example.com",
          db,
        ).finally(() => (settled = true));
        pending.catch(() => {});
        await new Promise((resolve) => setTimeout(resolve, 200));
        expect(settled).toBe(false);
        // The click waits on the queue and does not hold the row, so a writer of the row is not blocked.
        await db.update(s.hiringCandidates).set({ reviewNote: "Row is free" }).where(eq(s.hiringCandidates.id, row.id));
        // The limit set while it waited is the one it obeys.
        await setVisit({ onsiteLimits: { perWeek: 3, unbooked: 0, perHeadPerWeek: 2, perSubject: 2 } });
      } finally {
        await client.query("commit");
        client.release();
      }
      await expect(pending).rejects.toThrow(/invited, not booked/);
      expect((await read(row.id)).stage).toBe("review");
    });
    it("advance with a response now goes to the onsite invite, not a paper invite", async () => {
      const row = await invited({ stage: "review", inviteExpiresAt: null, visitSubject: null }, null);
      await db.delete(s.hiringOutbox).where(eq(s.hiringOutbox.candidateId, row.id));
      await click(row.id, "advance", []);
      const saved = await read(row.id);
      expect([saved.stage, saved.visitSubject]).toEqual(["onsite_invited", "Mathematics"]);
      const jobs = await jobsOf(row.id);
      expect(jobs.map((j) => j.payload.workflowStage)).toEqual(["onsite_invited"]);
    });
    it("click: passes a low score", async () => {
      await setVisit({ preScreenThreshold: 100 });
      const low = { ...six, criteria: six.criteria.map((c) => (c.id === "written" ? { ...c, result: "not_met" } : c)) };
      for (const stage of ["review", "new"] as const) {
        const row = await invited({ stage, inviteExpiresAt: null, visitSubject: null, preScreenAssessment: low as never }, null);
        await db.delete(s.hiringOutbox).where(eq(s.hiringOutbox.candidateId, row.id));
        await click(row.id, "invite_onsite", [], "Strong written answer in the call");
        expect((await read(row.id)).stage).toBe("onsite_invited");
        const [row2] = (await db.select().from(s.hiringAudit)).filter((a) => a.candidateId === row.id && a.action === "invite_onsite");
        expect(row2.actor).toBe("staff@example.com");
        expect(row2.detail).toMatchObject({ reason: "Strong written answer in the call", subject: "Mathematics", passScore: 100 });
        expect(row2.detail.score).toBeLessThan(100);
      }
    });
    it("click: refused for a hard stop, not-hiring subject, no head or full limit, naming the reason", async () => {
      const row = async (values: Partial<typeof s.hiringCandidates.$inferInsert> = {}) => {
        const c = await invited({ stage: "review", inviteExpiresAt: null, visitSubject: null, ...values }, null);
        await db.delete(s.hiringOutbox).where(eq(s.hiringOutbox.candidateId, c.id));
        return c;
      };
      const refused = async (id: string, pattern: RegExp) => {
        await expect(click(id, "invite_onsite")).rejects.toThrow(pattern);
        expect((await read(id)).stage).toBe("review");
        expect(await jobsOf(id)).toEqual([]);
      };
      await refused((await row({ workRightsAnswer: "Other" })).id, /work-rights/);
      await refused((await row({ preScreen: { ...pre, english: "Intermediate (B1)" } })).id, /English/);
      await setVisit({ subjectPriority: [{ subject: "Mathematics", hiring: false }] });
      await refused((await row()).id, /open for hiring/);
      await setVisit({ interviewers: [] });
      await refused((await row()).id, /head/);
      await setVisit({ onsiteLimits: { perWeek: 3, unbooked: 0, perHeadPerWeek: 2, perSubject: 2 } });
      await refused((await row()).id, /invited, not booked/);
      // Every staff action needs a written reason.
      const c = await row();
      await expect(click(c.id, "invite_onsite", [], "ok")).rejects.toThrow(/reason/);
    });
    it("a first-invitation click cannot repeat an invitation; only send_new_link can", async () => {
      const row = await invited({ stage: "no_booking", inviteExpiresAt: null });
      await expect(click(row.id, "invite_onsite")).rejects.toThrow(/new link/);
      const booked = await invited();
      await expect(click(booked.id, "send_new_link")).rejects.toThrow(/cancel/);
      expect(await jobsOf(booked.id)).toHaveLength(1);
    });
    it("cancel and no-show free the slot and the limit", async () => {
      await setVisit({ onsiteLimits: { perWeek: 10, unbooked: 2, perHeadPerWeek: 1, perSubject: 1 } });
      const row = await invited();
      await bookVisit(link(row), choice(), db);
      await db.insert(s.hiringOutbox).values({
        key: `${row.id}:visit-reminder:9`,
        candidateId: row.id,
        kind: "email",
        payload: { to: "x@example.com", subject: "r", text: "r", workflowStage: "onsite_invited" },
      });
      expect((await readLimitUsage(db, "onsite", now)).bySubject.Mathematics).toBe(1);
      await click(row.id, "cancel_visit", [], "Candidate asked on LINE");
      const saved = await read(row.id);
      expect([saved.stage, saved.inviteExpiresAt, saved.reviewNote]).toEqual(["no_booking", null, "Candidate asked on LINE"]);
      expect((await rowsOf(row.id)).map((b) => b.status)).toEqual(["cancelled", "cancelled"]);
      expect((await readLimitUsage(db, "onsite", now)).bySubject.Mathematics).toBeUndefined();
      const jobs = await jobsOf(row.id);
      expect(jobs.find((j) => j.key.includes("visit-reminder"))!.status).toBe("cancelled");
      expect(jobs.filter((j) => j.kind === "calendar_cancel")).toHaveLength(2);
      expect(jobs.filter((j) => j.bookingId && j.kind !== "calendar_cancel" && j.status === "pending").map((j) => j.payload)).toEqual([{ notice: "cancelled" }]);
      expect((await db.select().from(s.hiringAudit)).find((a) => a.action === "cancel_visit")!.detail).toMatchObject({ reason: "Candidate asked on LINE" });
      // The head hears, though the booking is cancelled, and the slot is open for someone else.
      await deliverOutbox(db, base);
      expect(vi.mocked(pushLineTextMessage).mock.calls[0][0].text).toMatch(/cancelled/i);
      expect(vi.mocked(deliverCalendar).mock.calls.filter((c) => c[4] === true)).toHaveLength(2);
      const other = await invited();
      expect((await visitView(link(other), db)).slots.map((v) => v.examStart)).toContain(EXAM);

      // A no-show waits for the start, then frees the head's weekly place.
      await bookVisit(link(other), choice(), db);
      await expect(click(other.id, "mark_no_show")).rejects.toThrow(/not started/);
      vi.setSystemTime(new Date("2026-11-02T03:30:00Z"));
      await expect(click(other.id, "cancel_visit")).rejects.toThrow(/started/);
      await click(other.id, "mark_no_show", [], "Did not arrive at 10:00");
      expect((await rowsOf(other.id)).map((b) => b.status)).toEqual(["no_show", "no_show"]);
      expect((await read(other.id)).stage).toBe("no_booking");
      // Only the mock is still ahead, so only it loses its calendar event.
      const after = await jobsOf(other.id);
      expect(after.filter((j) => j.kind === "calendar_cancel")).toHaveLength(1);
      await deliverOutbox(db, base);
      // A cancel or a no-show emails the candidate nothing: rejection messages stay manual.
      expect(sendEmail).not.toHaveBeenCalled();
      expect(await readLimitUsage(db, "onsite", new Date())).toMatchObject({ unbooked: 0, bySubject: {} });
      await expect(click(other.id, "cancel_visit")).rejects.toThrow(/no booked visit/);
    });
    it("does not send a queued booking email after a no-show", async () => {
      const row = await invited();
      await bookVisit(link(row), choice(), db);
      await db.update(s.hiringBookings).set({ status: "no_show" }).where(eq(s.hiringBookings.candidateId, row.id));
      await deliverOutbox(db, base);
      expect(sendEmail).not.toHaveBeenCalled();
      expect(vi.mocked(deliverCalendar)).not.toHaveBeenCalled();
      expect(vi.mocked(pushLineTextMessage)).not.toHaveBeenCalled();
    });
    it("still cancels the calendar when a person stops the candidate straight after a cancel", async () => {
      const row = await invited();
      await bookVisit(link(row), choice(), db);
      await click(row.id, "cancel_visit");
      await click(row.id, "stop");
      expect((await read(row.id)).stage).toBe("stopped");
      await deliverOutbox(db, base);
      expect(vi.mocked(deliverCalendar).mock.calls.filter((c) => c[4] === true)).toHaveLength(2);
      expect(sendEmail).not.toHaveBeenCalled();
    });
    it("send_new_link resets the move count and obeys limits", async () => {
      await setVisit({ onsiteLimits: { perWeek: 10, unbooked: 0, perHeadPerWeek: 2, perSubject: 2 } });
      const row = await invited();
      await bookVisit(link(row), choice(), db);
      await bookVisit(link(row), choice(EXAM_TUE, { move: true }), db);
      await click(row.id, "cancel_visit");
      await expect(click(row.id, "send_new_link")).rejects.toThrow(/invited, not booked/);
      expect((await read(row.id)).stage).toBe("no_booking");
      await setVisit({ onsiteLimits: { perWeek: 10, unbooked: 2, perHeadPerWeek: 2, perSubject: 2 } });
      vi.setSystemTime(new Date(now.getTime() + 3600000));
      await click(row.id, "send_new_link", [], "Candidate can come next week");
      const fresh = await newestLink(row.id);
      await bookVisit(fresh, choice(), db);
      expect((await visitView(fresh, db)).canMove).toBe(true);
      await bookVisit(fresh, choice(EXAM_TUE, { move: true }), db);
      expect((await visitView(fresh, db)).canMove).toBe(false);
      expect((await db.select().from(s.hiringAudit)).find((a) => a.action === "send_new_link")!.detail).toMatchObject({ reason: "Candidate can come next week" });
      // The new link counts as a send.
      expect((await readLimitUsage(db, "onsite", new Date())).perWeek).toBe(2);
    });
    it("old paper and mock links still work for old-flow candidates", async () => {
      const paper = {
        ...slot,
        interviewerKey: null,
        end: "2026-11-02T05:00:00.000Z",
      };
      vi.mocked(availableSlots).mockResolvedValue([paper]);
      const [c] = await db
        .insert(s.hiringCandidates)
        .values({ name: "Old", email: "old@example.com", stage: "paper_invited", subjects: ["Mathematics"], inviteExpiresAt: LINK })
        .returning();
      const token = bookingToken(c.id, "paper", LINK);
      expect((await bookingView(token, undefined, db)).kind).toBe("paper");
      await bookInterview(token, { ...input, interviewerKey: null }, db);
      expect((await read(c.id)).stage).toBe("paper_booked");
      const [row] = await rowsOf(c.id);
      expect(row.visitId).toBeNull();
      // Their actions stay: a paper pass still sends a mock invitation with its own link.
      vi.setSystemTime(new Date("2026-11-02T06:00:00Z"));
      await click(c.id, "paper_pass", ["Mathematics"], "Marked paper 90 of 100");
      const saved = await read(c.id);
      expect(saved.stage).toBe("paper_passed");
      expect((await jobsOf(c.id)).some((j) => j.key.includes(":mock-invite:"))).toBe(true);
    });
    it("shows a notice and the LINE contact when Wise is stale or no slot fits", async () => {
      const row = await invited();
      vi.mocked(ensureIndex).mockResolvedValueOnce({ snapshotId: "x", syncedAt: new Date(now.getTime() - 86400000), tutorGroups: [] } as never);
      const stale = await visitView(link(row), db);
      expect(stale.slots).toEqual([]);
      expect(stale.notice).toContain(LINE);
      expect(stale.notice).toMatch(/cannot be shown|try again/i);
      await setVisit({ interviewers: [{ ...peat, fallbackWeek: Array(7).fill(null) }] } as never);
      const empty = await visitView(link(row), db);
      expect(empty.slots).toEqual([]);
      expect(empty.notice).toContain(LINE);
      await setVisit({ enabled: false });
      const paused = await visitView(link(row), db);
      expect([paused.enabled, paused.slots]).toEqual([false, []]);
      expect(paused.notice).toContain(LINE);
      await expect(bookVisit(link(row), choice(), db)).rejects.toThrow(HiringError);
    });
    it("lets only one of two candidates take the last exam place, on separate connections", async () => {
      await setVisit({ interviewers: [peat, ek], paperCapacity: 1 } as never);
      const a = await invited(),
        b = await invited();
      const client = await handle.pool.connect();
      await client.query("begin");
      await client.query("select pg_advisory_xact_lock(hashtextextended('hiring:paper',0))");
      const finished: string[] = [];
      let settled: Promise<PromiseSettledResult<unknown>[]>;
      try {
        settled = Promise.allSettled(
          [a, b].map((c) => bookVisit(link(c), choice(), db).finally(() => finished.push(c.id))),
        );
        await new Promise((resolve) => setTimeout(resolve, 300));
        expect(finished).toEqual([]);
      } finally {
        await client.query("commit");
        client.release();
      }
      const outcomes = await settled;
      expect(outcomes.filter((o) => o.status === "fulfilled")).toHaveLength(1);
      const rows = await db.select().from(s.hiringBookings);
      expect(rows.map((r) => r.kind).sort()).toEqual(["mock", "paper"]);
    });
    it("lets only one of two candidates take the last head hour, with room for two exams", async () => {
      await setVisit({ paperCapacity: 2 });
      const a = await invited(),
        b = await invited();
      const outcomes = await Promise.allSettled([bookVisit(link(a), choice(), db), bookVisit(link(b), choice(), db)]);
      expect(outcomes.filter((o) => o.status === "fulfilled")).toHaveLength(1);
      expect(await db.select().from(s.hiringBookings)).toHaveLength(2);
    });
    it("refuses a booking when the head has no LINE group, with nothing saved", async () => {
      await db.delete(s.progressLineGroups).where(eq(s.progressLineGroups.canonicalKey, "Peat"));
      const row = await invited();
      await expect(bookVisit(link(row), choice(), db)).rejects.toThrow(/notifications/);
      expect(await rowsOf(row.id)).toEqual([]);
      expect((await read(row.id)).stage).toBe("onsite_invited");
    });
  });
  it("keeps an old-flow candidate on the paper then mock path: a booked paper, a recorded pass and a confirmed mock", async () => {
    let [c] = await db
      .insert(s.hiringCandidates)
      .values({
        name: "Flow candidate",
        email: "flow@example.com",
        stage: "paper_invited",
        subjects: ["Mathematics"],
        inviteExpiresAt: new Date("2026-11-15T00:00:00Z"),
      })
      .returning();
    const id = c.id;
    const paper = {
      ...slot,
      interviewerKey: null,
      end: "2026-11-02T05:00:00.000Z",
    };
    vi.mocked(availableSlots).mockResolvedValue([paper]);
    await bookInterview(
      bookingToken(c.id, "paper", c.inviteExpiresAt!),
      { ...input, interviewerKey: null },
      db,
      now,
    );
    await deliverOutbox(db, config);
    vi.setSystemTime(new Date("2026-11-02T06:00:00Z"));
    [c] = await db
      .select()
      .from(s.hiringCandidates)
      .where(eq(s.hiringCandidates.id, id));
    await reviewCandidate(
      id,
      {
        action: "paper_pass",
        revision: c.revision,
        subjects: ["Mathematics"],
        reason: "Marked paper: score 90/100",
      },
      "reviewer@example.com",
      db,
    );
    [c] = await db
      .select()
      .from(s.hiringCandidates)
      .where(eq(s.hiringCandidates.id, id));
    expect(c.stage).toBe("paper_passed");
    expect(c.paperRecordedBy).toBe("reviewer@example.com");
    await deliverOutbox(db, config);
    const mock = {
      ...slot,
      date: "2026-11-03",
      start: "2026-11-03T03:00:00.000Z",
      end: "2026-11-03T04:00:00.000Z",
    };
    vi.mocked(availableSlots).mockResolvedValue([mock]);
    await bookInterview(
      bookingToken(c.id, "mock", c.inviteExpiresAt!),
      { ...input, start: mock.start },
      db,
      new Date(),
    );
    await deliverOutbox(db, config);
    expect(
      (
        await db
          .select()
          .from(s.hiringCandidates)
          .where(eq(s.hiringCandidates.id, id))
      )[0].stage,
    ).toBe("mock_booked");
    expect(await db.select().from(s.hiringBookings)).toHaveLength(2);
    const jobs = await db.select().from(s.hiringOutbox);
    // Paper booking 2 (email, calendar), mock invitation 1, mock booking 3 (email, calendar, LINE).
    expect(jobs).toHaveLength(6);
    expect(jobs.every((j) => j.status === "sent")).toBe(true);
    expect(vi.mocked(pushLineTextMessage).mock.calls[0][0].tutorBot).toBe(
      false,
    );
  });
  it("deduplicates applications by source id and email while preserving source aliases", async () => {
    const app = {
      applicationId: "00000000-0000-4000-8000-000000000001",
      name: "Candidate",
      email: "candidate@example.com",
      profileText: "Bachelor Mathematics IGCSE teaching English",
      resumeText: "",
      previouslyContacted: false,
      sourceStatus: "Inbox",
      workRightsAnswer: ACCEPTED,
    };
    const id = await importApplication(app, db);
    expect(await importApplication(app, db)).toBe(id);
    expect(
      await importApplication(
        { ...app, applicationId: "00000000-0000-4000-8000-000000000002" },
        db,
      ),
    ).toBe(id);
    const rows = await db.select().from(s.hiringCandidates);
    expect(rows).toHaveLength(1);
    expect(rows[0].sourceIds).toHaveLength(2);
    await reviewCandidate(
      id,
      {
        revision: rows[0].revision,
        action: "advance",
        subjects: ["Mathematics"],
        reason: "Profile checked by reviewer",
      },
      "reviewer@example.com",
      db,
    );
    expect((await db.select().from(s.hiringCandidates))[0].stage).toBe(
      "pre_screen",
    );
    expect(
      (await db.select().from(s.hiringOutbox))[0].payload.workflowStage,
    ).toBe("pre_screen");
  });
  it("stops pending invitations after manual SEEK contact or a stopped application", async () => {
    const applicationId = "00000000-0000-4000-8000-000000000004";
    const id = await importApplication(
      {
        applicationId,
        name: "Candidate",
        email: "contacted@example.com",
        profileText: "degree subject curriculum teaching english Mathematics",
        resumeText: "",
        previouslyContacted: false,
        sourceStatus: "Inbox",
        workRightsAnswer: ACCEPTED,
      },
      db,
    );
    await assessCandidates(db, config, async () => ({
      criteria: ["degree", "subject", "curriculum", "teaching", "english"].map(
        (id) => ({ id, result: "met", evidence: id, reason: "Source" }),
      ),
      subjects: [
        { subject: "Mathematics", evidence: "Mathematics", relevant: true },
      ],
      summary: "Evidence",
    }));
    await releaseQueues(db);
    expect((await db.select().from(s.hiringOutbox))[0].status).toBe("pending");
    await observeSeekState(applicationId, "Inbox", true, db);
    expect((await db.select().from(s.hiringOutbox))[0].status).toBe(
      "cancelled",
    );
    await observeSeekState(applicationId, "Not Suitable", true, db);
    const [c] = await db
      .select()
      .from(s.hiringCandidates)
      .where(eq(s.hiringCandidates.id, id));
    expect(c.previouslyContacted).toBe(true);
    expect(c.stage).toBe("stopped");
    await deliverOutbox(db, config);
    expect(sendEmail).not.toHaveBeenCalled();
  });
  it("holds unverifiable AI evidence without blocking other candidates or retrying it unchanged", async () => {
    const ids: string[] = [];
    for (const [index, label] of ["invalid", "valid"].entries()) {
      ids.push(
        await importApplication(
          {
            applicationId: `00000000-0000-4000-8000-00000000000${index + 5}`,
            name: label,
            email: `${label}@example.com`,
            profileText: `${label} degree subject curriculum teaching english Mathematics`,
            resumeText: "",
            previouslyContacted: false,
            sourceStatus: "Inbox",
            workRightsAnswer: ACCEPTED,
          },
          db,
        ),
      );
    }
    const assess = vi.fn(async (source: string) => ({
      criteria: ["degree", "subject", "curriculum", "teaching", "english"].map(
        (id) => ({
          id,
          result: "met",
          evidence: source.startsWith("invalid") ? "invented quote" : id,
          reason: "Source",
        }),
      ),
      subjects: [
        { subject: "Mathematics", evidence: "Mathematics", relevant: true },
      ],
      summary: "Evidence",
    }));
    await assessCandidates(db, config, assess);
    await assessCandidates(db, config, assess);
    expect(assess).toHaveBeenCalledTimes(2);
    await releaseQueues(db);
    const rows = await db.select().from(s.hiringCandidates);
    expect(rows.find((c) => c.id === ids[0])?.stage).toBe("review");
    expect(rows.find((c) => c.id === ids[1])?.stage).toBe("pre_screen");
    expect(await db.select().from(s.hiringOutbox)).toHaveLength(1);
  });
  it("can deliver confirmed appointments while holding unsent intake invitations for a source check", async () => {
    vi.stubEnv("PROGRESS_LINE_TUTOR_BOT_KEYS", "Peat");
    const { c, token } = await candidate();
    await bookInterview(token, input, db, now);
    await db.insert(s.hiringOutbox).values({
      key: "intake-pending",
      candidateId: c.id,
      kind: "email",
      payload: {
        workflowStage: "pre_screen",
        to: c.email,
        subject: "intake",
        text: "intake",
      },
    });
    expect(await deliverOutbox(db, config, 50, true)).toBe(3);
    const [intake] = await db
      .select()
      .from(s.hiringOutbox)
      .where(eq(s.hiringOutbox.key, "intake-pending"));
    expect(intake.status).toBe("pending");
    expect(sendEmail).toHaveBeenCalledTimes(1);
    expect(vi.mocked(pushLineTextMessage).mock.calls[0][0].tutorBot).toBe(true);
  });
  it("allows exactly one of two candidates to reserve an interviewer, and returns the same booking on retry", async () => {
    const a = await candidate("one@example.com"),
      b = await candidate("two@example.com");
    const outcomes = await Promise.allSettled([
      bookInterview(a.token, input, db, now),
      bookInterview(b.token, input, db, now),
    ]);
    expect(outcomes.filter((o) => o.status === "fulfilled")).toHaveLength(1);
    const bookings = await db.select().from(s.hiringBookings);
    expect(bookings).toHaveLength(1);
    const winner = bookings[0].candidateId === a.c.id ? a : b;
    expect((await bookInterview(winner.token, input, db, now)).id).toBe(
      bookings[0].id,
    );
    expect(await db.select().from(s.hiringOutbox)).toHaveLength(3);
  });
  it("rechecks the paper pass and invitation after the live Wise read", async () => {
    const { c, token } = await candidate();
    vi.mocked(verifyLiveSlot).mockImplementationOnce(async () => {
      await db
        .update(s.hiringCandidates)
        .set({ stage: "stopped" })
        .where(eq(s.hiringCandidates.id, c.id));
      return {
        source: "wise-live",
        checkedAt: now.toISOString(),
        snapshotId: "snapshot",
      };
    });
    await expect(bookInterview(token, input, db, now)).rejects.toThrow(
      /changed/,
    );
    expect(await db.select().from(s.hiringBookings)).toHaveLength(0);
  });
  it("prevents sit-ins and hiring from booking the same observer in either order", async () => {
    const { token } = await candidate();
    await bookInterview(token, input, db, now);
    const [assignment] = await db
      .insert(s.tutorSitInAssignments)
      .values({
        quarter: "2026-Q4",
        department: "maths",
        canonicalKey: "Other",
        tutorName: "Other",
      })
      .returning();
    await expect(
      db.insert(s.tutorSitInObservations).values({
        assignmentId: assignment.id,
        observerEmail: "peat@example.com",
        observerCanonicalKey: "Peat",
        lesson: {} as never,
        startTime: new Date(slot.start),
        endTime: new Date(slot.end),
      }),
    ).rejects.toThrow();
    await db.update(s.hiringBookings).set({ status: "cancelled" });
    await db.insert(s.tutorSitInObservations).values({
      assignmentId: assignment.id,
      observerEmail: "peat@example.com",
      observerCanonicalKey: "Peat",
      lesson: {} as never,
      startTime: new Date(slot.start),
      endTime: new Date(slot.end),
    });
    await expect(bookInterview(token, input, db, now)).rejects.toThrow();
  });
  it("keeps uncertain email retries on the same idempotency key and stops retries after provider retention", async () => {
    const { c } = await candidate();
    await db.insert(s.hiringOutbox).values({
      key: "invitation",
      candidateId: c.id,
      kind: "email",
      payload: { to: c.email, subject: "Test", text: "Test" },
    });
    sendEmail.mockRejectedValueOnce(new Error("Acceptance is uncertain"));
    await deliverOutbox(db, config);
    vi.setSystemTime(new Date(now.getTime() + 120000));
    await deliverOutbox(db, config);
    expect(sendEmail.mock.calls[0][0].idempotencyKey).toBe(
      sendEmail.mock.calls[1][0].idempotencyKey,
    );
    expect((await db.select().from(s.hiringOutbox))[0].status).toBe("sent");
    await db
      .update(s.hiringOutbox)
      .set({ status: "uncertain", nextAttemptAt: null });
    vi.setSystemTime(new Date(now.getTime() + 24 * 3600000));
    await deliverOutbox(db, config);
    expect(sendEmail).toHaveBeenCalledTimes(2);
  });
  it("changes a decision threshold without sending a duplicate invitation", async () => {
    const app = {
      applicationId: "00000000-0000-4000-8000-000000000001",
      name: "Candidate",
      email: "candidate@example.com",
      profileText: "degree subject curriculum teaching english Mathematics",
      resumeText: "",
      previouslyContacted: false,
      sourceStatus: "Inbox",
      workRightsAnswer: ACCEPTED,
    };
    await importApplication(app, db);
    const assess = vi.fn().mockResolvedValue({
      criteria: ["degree", "subject", "curriculum", "teaching", "english"].map(
        (id) => ({ id, result: "met", evidence: id, reason: "Source" }),
      ),
      subjects: [
        { subject: "Mathematics", evidence: "Mathematics", relevant: true },
      ],
      summary: "Evidence",
    });
    await assessCandidates(db, config, assess);
    await assessCandidates(db, config, assess);
    await releaseQueues(db);
    await releaseQueues(db);
    expect(assess).toHaveBeenCalledTimes(1);
    expect(await db.select().from(s.hiringOutbox)).toHaveLength(1);
    const changed = {
      ...config,
      enabled: false,
      deliveryEnabled: false,
      profileThreshold: 85,
      profileWeights: {
        ...config.profileWeights,
        curriculum: 10,
        teaching: 30,
      },
    };
    // Importing the accepted answer for the first time raised the revision.
    await saveSettings(changed, (await settings(db)).row!.revision, "owner@example.com", db);
    const saved = await settings(db);
    expect(saved.config.profileThreshold).toBe(85);
    expect(saved.config.profileWeights.teaching).toBe(30);
    await assessCandidates(db, saved.config, assess);
    await releaseQueues(db);
    expect(await db.select().from(s.hiringOutbox)).toHaveLength(1);
  });
});
