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
import { configSchema, type Slot } from "../model";
import { bookingToken } from "../tokens";
import {
  bookInterview,
  dashboard,
  reviewCandidate,
  saveSettings,
  settings,
  sourceHash,
} from "../service";
import { importApplication, observeSeekState } from "../sources";
import { assessCandidates, deliverOutbox, scorePreScreens } from "../worker";
import { availableSlots, verifyLiveSlot } from "../availability";
import { createOutboundEmailSender } from "@/lib/email/outbound";
import { pushLineTextMessage } from "@/lib/line/client";

vi.mock("../availability", () => ({
  availableSlots: vi.fn(),
  verifyLiveSlot: vi.fn(),
}));
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
      expect(assess).toHaveBeenCalledWith(expect.stringContaining("teachingApproach: Check understanding"), expect.stringContaining(":pre:"), "pre-screen");
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
  it("runs from a new application through both invitations, a recorded paper pass and a confirmed mock", async () => {
    const id = await importApplication(
      {
        applicationId: "00000000-0000-4000-8000-000000000003",
        name: "Flow candidate",
        email: "flow@example.com",
        profileText: "degree subject curriculum teaching english Mathematics",
        resumeText: "",
        previouslyContacted: false,
        sourceStatus: "Inbox",
        workRightsAnswer: ACCEPTED,
      },
      db,
    );
    const profile = (kind?: string) => ({
      criteria: [
        "degree",
        "subject",
        "curriculum",
        "teaching",
        "english",
        ...(kind === "pre-screen" ? ["written"] : []),
      ].map((id) => ({
        id,
        result: "met",
        evidence: id === "written" ? "Check understanding" : id,
        reason: "Source",
      })),
      subjects: [
        { subject: "Mathematics", evidence: "Mathematics", relevant: true },
      ],
      summary: "Evidence",
    });
    await assessCandidates(db, config, async () => profile());
    let [c] = await db
      .select()
      .from(s.hiringCandidates)
      .where(eq(s.hiringCandidates.id, id));
    expect(c.stage).toBe("pre_screen");
    await deliverOutbox(db, config);
    await db
      .update(s.hiringCandidates)
      .set({
        preScreen: {
          sourceRow: 2,
          submittedAt: now.toISOString(),
          degree: "Bachelor's",
          field: "Mathematics",
          subjects: "Mathematics",
          curricula: "IGCSE",
          yearGroups: "Year 10",
          english: "Advanced (C1)",
          englishEvidence: "C1",
          experience: "5+ years",
          portfolio: "",
          availability:
            "Weekday Evening (17:00-21:00), Weekend Morning (before 12:00)",
          weeklyHours: "20",
          motivation: "Teaching",
          teachingApproach: "Check understanding",
        },
      })
      .where(eq(s.hiringCandidates.id, id));
    await assessCandidates(db, config, async (_s, _k, kind) => profile(kind));
    [c] = await db
      .select()
      .from(s.hiringCandidates)
      .where(eq(s.hiringCandidates.id, id));
    expect(c.stage).toBe("paper_invited");
    await deliverOutbox(db, config);
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
    expect(jobs).toHaveLength(8);
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
    expect(assess).toHaveBeenCalledTimes(1);
    expect(await db.select().from(s.hiringOutbox)).toHaveLength(1);
    const changed = {
      ...config,
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
    expect(await db.select().from(s.hiringOutbox)).toHaveLength(1);
  });
});
