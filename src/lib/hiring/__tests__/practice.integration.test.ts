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
import { startTestDb, stopTestDb } from "@/tests/integration/db-helper";
import { saveBriefDecision } from "../decisions";
import { finalReviewAccess, latestReviewPacket, reviewPacketValid, signOffReview } from "../final-review";
import { deliverCalendar } from "../google";
import { configSchema, practiceMarker } from "../model";
import { RUBRIC_ITEMS, type MockRubric } from "../marking-sheet";
import { runHiringPractice } from "../practice";
import { deliverRecruitment } from "../recruitment";
import { reviewDocument } from "../review-document";
import { briefView, dashboard, saveBriefRubric } from "../service";
import { deliverOutbox } from "../worker";

vi.mock("@/lib/email/outbound", () => ({ createOutboundEmailSender: vi.fn() }));
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
    { canonicalKey: "Peat", email: "peat@example.test", subjects: ["Mathematics"] },
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
  await db.insert(s.hiringSettings).values({ id: "default", config, updatedBy: "owner" });
  const [unmarked] = await db.insert(s.hiringCandidates).values({
    name: "PRACTICE – unmarked record", email: "unmarked@example.test",
  }).returning();
  const [settingsBefore] = await db.select().from(s.hiringSettings);

  const dry = await runHiringPractice({ email }, db);
  expect(dry.filter(({ table }) => table === "hiring_candidates")).toHaveLength(5);
  expect(await db.$count(s.hiringCandidates)).toBe(1);
  expect(await runHiringPractice({ email, apply: true }, db)).toHaveLength(dry.length);
  expect(await runHiringPractice({ email, apply: true }, db)).toEqual([]);
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
  await db.update(s.hiringCandidates).set({ sourceIds: [] }).where(eq(s.hiringCandidates.id, final.id));
  await expect(reviewPacketValid(db, final.id, packet)).resolves.toBe(false);
  await db.update(s.hiringCandidates).set({ sourceIds: final.sourceIds }).where(eq(s.hiringCandidates.id, final.id));

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

  const removeDry = await runHiringPractice({ remove: true }, db);
  expect(removeDry.filter(({ table }) => table === "hiring_candidates")).toHaveLength(5);
  expect(await db.$count(s.hiringRecruitmentDeliveries)).toBe(1);
  expect(await runHiringPractice({ remove: true, apply: true, email }, db)).toHaveLength(removeDry.length);
  expect(await runHiringPractice({ remove: true }, db)).toEqual([]);
  for (const table of [s.hiringBookings, s.hiringPaperResults, s.hiringMockResults, s.hiringDecisions,
    s.hiringAudit, s.hiringOutbox, s.hiringRecruitmentDeliveries, s.hiringAssessmentFiles, s.hiringOnboarding]) {
    expect(await db.$count(table)).toBe(0);
  }
  expect(await db.select().from(s.hiringCandidates)).toEqual([unmarked]);
  expect(await db.select().from(s.hiringSettings)).toEqual([settingsBefore]);
});
