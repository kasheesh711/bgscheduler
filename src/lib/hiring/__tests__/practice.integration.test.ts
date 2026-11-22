import { randomUUID } from "node:crypto";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { eq } from "drizzle-orm";
import { afterAll, afterEach, beforeAll, expect, it, vi } from "vitest";
import { HeadsScreen, HiringReviewScreen } from "@/components/hiring/role-screens";
import type { HiringData } from "@/components/hiring/dashboard";
import type { Database } from "@/lib/db";
import * as s from "@/lib/db/schema";
import { createOutboundEmailSender } from "@/lib/email/outbound";
import { pushLineTextMessage } from "@/lib/line/client";
import { ensureIndex } from "@/lib/search/index";
import { startTestDb, stopTestDb } from "@/tests/integration/db-helper";
import { assessmentRows } from "../assessment-view";
import { availableVisitSlots } from "../availability";
import { saveBriefDecision } from "../decisions";
import { finalReviewAccess, latestReviewPacket, reviewPacketDetail, reviewPacketValid, signOffReview } from "../final-review";
import { buildFunnel } from "../funnel";
import { deliverCalendar } from "../google";
import { headWeek } from "../head-schedule";
import { buildInsights } from "../insights";
import { CALL_MINUTES, configSchema, CONTRACT_MINUTES, HR_CALL_KEY, localDate, PRACTICE_SOURCE_PREFIX, practiceMarker } from "../model";
import { RUBRIC_ITEMS, type MockRubric } from "../marking-sheet";
import { runHiringPractice } from "../practice";
import { deliverRecruitment } from "../recruitment";
import { reviewDocument } from "../review-document";
import { buildRunSheet } from "../run-sheet";
import { isFromSeek } from "../seek-view";
import { briefView, dashboard, saveBriefRubric } from "../service";
import { seekPhonesWanted } from "../sources";
import { deliverOutbox } from "../worker";

vi.mock("@/lib/email/outbound", () => ({ createOutboundEmailSender: vi.fn() }));
vi.mock("@/lib/search/index", () => ({ ensureIndex: vi.fn() }));
vi.mock("@/lib/line/client", () => ({
  pushLineTextMessage: vi.fn(async () => ({ retryKey: "key", sentMessageId: "message", response: {} })),
  LinePushError: class extends Error {},
}));
vi.mock("../google", () => ({
  deliverCalendar: vi.fn(),
  googleConnectionStatus: vi.fn(async () => ({ connected: true, freeBusy: true, email: "", lastError: null })),
  readHrBusy: vi.fn(async () => []),
}));

let handle: Awaited<ReturnType<typeof startTestDb>>;
let db: Database;
const now = new Date("2026-11-24T05:00:00Z");
const email = "owner@example.test";
const gift = "gift@example.test";
const config = configSchema.parse({
  enabled: true, deliveryEnabled: true, recruitmentLineGroupId: `C${"1".repeat(32)}`,
  interviewers: [
    { canonicalKey: "Peat", email: "peat@example.test", subjects: ["Mathematics"],
      fallbackWeek: [null, ...Array.from({ length: 5 }, () => ({ start: "10:00", end: "16:00" })), null] },
    { canonicalKey: "Mimi", email: "mimi@example.test", subjects: ["Chemistry"] },
  ],
  paperPassRules: [{ subject: "Chemistry", level: "AS / A-Level", percent: 95 }],
});

beforeAll(async () => {
  handle = await startTestDb();
  db = handle.db as unknown as Database;
}, 120000);
afterAll(async () => {
  if (handle) await stopTestDb(handle);
});
afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
});

it("seeds, uses and removes all three practice paths without sending during setup", async () => {
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(now);
  vi.stubEnv("AUTH_SECRET", "practice-integration-secret");
  vi.stubEnv("VERCEL_ENV", "production");
  vi.stubEnv("PREVIEW_SANDBOX_ENABLED", "false");
  vi.stubEnv("HIRING_WRITES_ENABLED", "true");
  vi.stubEnv("HIRING_HR_EMAIL", "hr@example.test");
  vi.stubEnv("HIRING_FINAL_REVIEWER_EMAIL", gift);
  vi.stubEnv("HIRING_ONBOARDING_ENABLED", "true");
  vi.stubEnv("HIRING_LINE_LOGIN_ID", "fake-login");
  vi.stubEnv("HIRING_LINE_LOGIN_SECRET", "fake-secret");
  const sendEmail = vi.fn(async () => ({ id: "email-receipt" }));
  vi.mocked(createOutboundEmailSender).mockReturnValue({ sendEmail });
  vi.mocked(ensureIndex).mockResolvedValue({
    snapshotId: "practice-test", profileVersion: "practice-test", builtAt: now, byWeekday: new Map(),
    syncedAt: now,
    tutorGroups: [{
      id: "peat", canonicalKey: "Peat", displayName: "Peat", supportedModes: ["onsite"],
      qualifications: [], wiseRecords: [], availabilityWindows: [], leavesCompleteThrough: new Date("2026-12-31"),
      leaves: [], sessionBlocks: [], dataIssues: [],
    }],
  });
  await db.insert(s.hiringSettings).values({ id: "default", config, updatedBy: "owner" });
  const realSource = randomUUID();
  const [unmarked, mixed, real] = await db.insert(s.hiringCandidates).values([
    { name: "PRACTICE – unmarked record", email: "unmarked@example.test", sourceIds: [realSource] },
    { name: "PRACTICE – mixed sources", email: "mixed@example.test", sourceIds: [PRACTICE_SOURCE_PREFIX + "mixed", randomUUID()] },
    { name: "Real candidate", email: "real@example.test" },
  ]).returning();
  const [settingsBefore] = await db.select().from(s.hiringSettings);
  const slots = () => availableVisitSlots(db, config, "Mathematics", now);
  const week = () => headWeek(db, config, "Peat", localDate(now), now);
  const beforeSlots = await slots();
  expect(beforeSlots.some((slot) => slot.date === "2026-11-25")).toBe(true);
  const beforeWeek = await week();
  const beforeData = await dashboard(db);
  const beforePhones = await seekPhonesWanted(db, config);
  expect(beforePhones.has(realSource)).toBe(true);

  const dry = await runHiringPractice({ email }, db, now);
  expect(dry.rows.filter(({ table }) => table === "hiring_candidates")).toHaveLength(5);
  expect(await db.$count(s.hiringCandidates)).toBe(3);
  const applied = await runHiringPractice({ email, apply: true }, db, now);
  expect(applied.rows).toHaveLength(dry.rows.length);
  expect(applied.summary).toEqual(dry.summary);
  expect((await runHiringPractice({ email, apply: true }, db, now)).rows).toEqual([]);
  expect(await slots()).toEqual(beforeSlots);
  expect(await week()).toEqual(beforeWeek);
  expect(await db.$count(s.hiringOutbox)).toBe(0);
  expect(await db.$count(s.hiringRecruitmentDeliveries)).toBe(0);
  expect(await db.$count(s.hiringAssessmentFiles)).toBe(0);
  expect(sendEmail).not.toHaveBeenCalled();
  expect(pushLineTextMessage).not.toHaveBeenCalled();
  expect(deliverCalendar).not.toHaveBeenCalled();

  const data: HiringData = {
    ...await dashboard(db), reviewAccess: finalReviewAccess(gift),
    google: { connected: true, email: "", lastError: null, callCalendar: "readable" },
  };
  expect(data.headMocks).toEqual({});
  const practice = data.candidates.filter(practiceMarker);
  expect(practice).toHaveLength(5);
  expect(new Set(practice.map((c) => c.email)).size).toBe(5);
  expect(await seekPhonesWanted(db, config)).toEqual(beforePhones);
  // Rows with the same update time can come back in either order.
  const fromSeek = (rows: typeof data.candidates) => rows.filter(isFromSeek).map((c) => c.id).sort();
  expect(fromSeek(data.candidates)).toEqual(fromSeek(beforeData.candidates));
  expect(buildFunnel(data, now)).toEqual(buildFunnel(beforeData, now));
  expect(buildInsights(data, now)).toEqual(buildInsights(beforeData, now));
  const runSheet = buildRunSheet({ ...data, now });
  const assessments = assessmentRows(data.bookings, data.papers, data.mocks, now);
  for (const candidate of practice) {
    expect(runSheet.some((row) => row.candidateId === candidate.id)).toBe(true);
    expect(assessments.some((row) => row.candidateId === candidate.id)).toBe(true);
  }

  const score = practice.find((c) => c.name.includes("Kru Peat: score"))!;
  for (const head of config.interviewers) {
    const finished = practice.find((c) => c.name.includes(`Kru ${head.canonicalKey}: finished`))!;
    const open = practice.find((c) => c.name.includes(`Kru ${head.canonicalKey}: score`))!;
    expect(open).toMatchObject({ resumeState: "none", paperPassedSubjects: [head.subjects[0]] });
    const openMock = data.bookings.find((b) => b.candidateId === open.id && b.kind === "mock")!;
    expect(now.getTime() - openMock.endTime.getTime()).toBeLessThan(86400000);
    expect(openMock.endTime.getTime()).toBeLessThan(now.getTime());
    vi.stubGlobal("window", { localStorage: { getItem: () => head.canonicalKey } });
    const heads = renderToStaticMarkup(createElement(HeadsScreen, { data }));
    const action = heads.slice(heads.indexOf("Mocks that need action"), heads.indexOf("Past mocks"));
    expect(action).toContain(`Score and recommend for ${open.name}`);
    expect(action).toContain(`${data.briefPaths[openMock.id]}#scores`);
    const past = heads.slice(heads.indexOf("Past mocks"));
    expect(past).toContain(finished.name);
    expect(past).toContain("Recommendation: No");
    expect(data.mocks.find((mock) => mock.candidateId === open.id)).toBeUndefined();
  }

  const final = practice.find((c) => c.name.includes("Gift: review"))!;
  const review = renderToStaticMarkup(createElement(HiringReviewScreen, {
    data, offers: false, onOpenResults: vi.fn(), reload: vi.fn(),
  }));
  expect(review).toContain(final.name);
  expect(review).not.toContain("finished No");
  expect(review).not.toContain("score this mock");
  const packet = (await latestReviewPacket(db, final.id))!;
  expect(packet.evidence).toMatchObject({
    resumeSha256: null,
    ats: { weights: config.profileWeights, prestige: 0, penalty: 0 },
    // Mathematics has no pass mark in this config, so the sheet says so, as for a real candidate.
    paper: { result: "pass_mark_missing", fileId: null },
    mock: { total: 126 },
  });
  await expect(reviewPacketValid(db, final.id, packet)).resolves.toBe(true);
  const document = await reviewDocument(packet, "/resume", "/paper");
  expect(document).toContain("Weighted points");
  expect(document).toContain("No résumé file is stored.");
  expect(document).toContain("No paper scan is stored.");
  const finalRow = db.update(s.hiringCandidates);
  await finalRow.set({ name: "Real candidate for packet checks", sourceIds: [] }).where(eq(s.hiringCandidates.id, final.id));
  await expect(reviewPacketValid(db, final.id, packet)).resolves.toBe(false);
  await expect(reviewPacketDetail(db, final.id, packet)).rejects.toThrow("The original résumé and ATS assessment are required.");
  await finalRow.set({ resumePath: "fixture/resume.pdf", resumeSha256: "fixture-sha256" }).where(eq(s.hiringCandidates.id, final.id));
  await expect(reviewPacketDetail(db, final.id, packet)).rejects.toThrow("The graded paper and the completed mock rubric are required.");
  await finalRow.set({ name: final.name, sourceIds: final.sourceIds, resumePath: null, resumeSha256: null }).where(eq(s.hiringCandidates.id, final.id));

  const mock = data.bookings.find((b) => b.candidateId === score.id && b.kind === "mock")!;
  const token = data.briefPaths[mock.id].split("/").at(-1)!;
  await expect(briefView(token, db, now)).resolves.toMatchObject({ form: "open", resume: null, gradedPaper: false });
  const rubric = {
    items: Object.fromEntries(RUBRIC_ITEMS.map((item) => [item, 3])),
    comments: "The examples need more detail.", stressTest: { listens: false, explains: false, plan: false }, checksDone: false,
  } as MockRubric;
  await expect(saveBriefRubric(token, rubric, db, now)).resolves.toBe(42);
  expect(await db.$count(s.hiringOutbox)).toBe(0);
  expect(await db.$count(s.hiringRecruitmentDeliveries)).toBe(0);
  const { queued } = await saveBriefDecision(token, { decision: "reject", reason: "The student needed more help." }, db, now);
  expect(queued).toBeTruthy();
  const offer = await signOffReview(db, final.id, packet.id, gift, "hire", "", now);
  expect(await db.$count(s.hiringOutbox)).toBe(2);
  expect(await db.$count(s.hiringRecruitmentDeliveries)).toBe(1);
  expect((await dashboard(db)).candidates.filter((c) => [score.id, final.id].includes(c.id)))
    .toEqual(expect.arrayContaining([expect.objectContaining({ id: score.id, stage: "rejected" }), expect.objectContaining({ id: final.id, stage: "hired" })]));
  await expect(deliverOutbox(db, config, 1, false, queued!)).resolves.toBe(1);
  await expect(deliverOutbox(db, config, 1, false, offer)).resolves.toBe(1);
  await expect(deliverRecruitment(db, now)).resolves.toBe(1);
  expect(sendEmail).toHaveBeenCalledWith(expect.objectContaining({ to: score.email, cc: ["people@begiftededucation.com"] }));
  expect(sendEmail).toHaveBeenCalledWith(expect.objectContaining({
    to: final.email, cc: ["people@begiftededucation.com"],
    text: expect.stringMatching(/\/hiring\/book\/.+\n[\s\S]+\/hiring\/onboarding\//),
  }));
  expect(pushLineTextMessage).toHaveBeenCalledWith(expect.objectContaining({
    to: config.recruitmentLineGroupId, text: expect.stringContaining("DO NOT HIRE"),
  }));
  expect(deliverCalendar).not.toHaveBeenCalled();

  expect(await db.$count(s.hiringRecruitmentDeliveries)).toBe(1);
  const appointment = (kind: "contract" | "call") => ({
    kind, subjects: ["Mathematics" as const], calendarOwner: config.connectedEmail, interviewerKey: HR_CALL_KEY, interviewerEmail: "hr@example.test",
    startTime: now, endTime: new Date(now.getTime() + (kind === "call" ? CALL_MINUTES : CONTRACT_MINUTES) * 60000), evidence: {},
  });
  const removeApply = () => runHiringPractice({ remove: true, apply: true }, db);
  for (const kind of ["contract", "call"] as const) {
    const [booking] = await db.insert(s.hiringBookings).values({ ...appointment(kind), candidateId: final.id }).returning();
    await expect(runHiringPractice({ remove: true }, db)).rejects.toThrow(final.name);
    await expect(removeApply()).rejects.toThrow(`Cancel the confirmed ${kind} booking in the UI first.`);
    await db.update(s.hiringBookings).set({ status: "cancelled" }).where(eq(s.hiringBookings.id, booking.id));
  }
  const [calendar] = await db.insert(s.hiringOutbox).values({
    key: `booking:${mock.id}:calendar`, candidateId: score.id, bookingId: mock.id, kind: "calendar", status: "sent", payload: {},
  }).returning();
  await expect(runHiringPractice({ remove: true }, db)).rejects.toThrow(score.name);
  await expect(removeApply()).rejects.toThrow("A calendar event was sent. Cancel it in the UI first.");
  await db.update(s.hiringOutbox).set({ status: "cancelled" }).where(eq(s.hiringOutbox.id, calendar.id));

  const [realBooking] = await db.insert(s.hiringBookings).values({ ...appointment("call"), candidateId: real.id }).returning();
  const [realOutbox] = await db.insert(s.hiringOutbox).values({
    key: `booking:${realBooking.id}:calendar`, candidateId: real.id, bookingId: realBooking.id, kind: "calendar", status: "sent", payload: {},
  }).returning();
  const [realDelivery] = await db.insert(s.hiringRecruitmentDeliveries).values({
    key: `booking:${realBooking.id}:booked`, bookingId: realBooking.id, groupId: config.recruitmentLineGroupId!, notice: "booked", message: "Real booking",
  }).returning();
  const [realAudit] = await db.insert(s.hiringAudit).values({ candidateId: real.id, actor: "owner", action: "call-booked", detail: {} }).returning();
  const removeDry = await runHiringPractice({ remove: true }, db);
  expect(removeDry.rows.filter(({ table }) => table === "hiring_candidates")).toHaveLength(5);
  expect((await removeApply()).rows).toHaveLength(removeDry.rows.length);
  expect((await runHiringPractice({ remove: true }, db)).rows).toEqual([]);
  for (const table of [s.hiringPaperResults, s.hiringMockResults, s.hiringDecisions, s.hiringAssessmentFiles, s.hiringOnboarding]) {
    expect(await db.$count(table)).toBe(0);
  }
  expect(await db.select().from(s.hiringCandidates)).toEqual(expect.arrayContaining([unmarked, mixed, real]));
  expect(await db.$count(s.hiringCandidates)).toBe(3);
  expect(await db.select().from(s.hiringBookings)).toEqual([realBooking]);
  expect(await db.select().from(s.hiringOutbox)).toEqual([realOutbox]);
  expect(await db.select().from(s.hiringRecruitmentDeliveries)).toEqual([realDelivery]);
  expect(await db.select().from(s.hiringAudit)).toEqual([realAudit]);
  expect(await db.select().from(s.hiringSettings)).toEqual([settingsBefore]);
});
