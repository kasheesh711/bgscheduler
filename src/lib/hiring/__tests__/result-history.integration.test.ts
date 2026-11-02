import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { eq, sql } from "drizzle-orm";
import { startTestDb, stopTestDb } from "@/tests/integration/db-helper";
import { type Database } from "@/lib/db";
import * as s from "@/lib/db/schema";
import { fetchGoogleSheetRange, listGoogleSheetProperties } from "@/lib/sales-dashboard/sheets";
import { configSchema } from "../model";
import { importResultHistory, parseTrackerResults } from "../result-history";

vi.mock("@/lib/sales-dashboard/sheets", () => ({
  fetchGoogleSheetRange: vi.fn(),
  listGoogleSheetProperties: vi.fn(),
  batchUpdateGoogleSpreadsheet: vi.fn(),
  updateGoogleSheetRangeValues: vi.fn(),
}));

let handle: Awaited<ReturnType<typeof startTestDb>>, db: Database;
const config = configSchema.parse({});
const recruitHead = () => {
  const head = Array.from({ length: 30 }, () => "");
  head[0] = "Applicant ID";
  head[2] = "Email";
  head[13] = "Final Subjects";
  head[16] = "Paper Date";
  head[19] = "Paper Outcome (Mimi)";
  head[20] = "Passed Subjects (Mimi)";
  head[21] = "Levels Passed (Mimi)";
  return head;
};
const mockHead = ["Applicant ID", "Applicant Name", "Subject", "Head Teacher", "Mock Date", "Mock Time", "Mock Score", "Mock Outcome", "Teacher Comment", "Status"];

const recruitRow = (id: string, email: string, outcome: string, subjects = "Mathematics", levels = "AS / A-Level") => {
  const row = Array.from({ length: 30 }, () => "");
  row[0] = id;
  row[2] = email;
  row[13] = subjects;
  row[16] = "1 Oct 2026";
  row[19] = outcome;
  row[20] = subjects;
  row[21] = levels;
  return row;
};
const tracker = (recruit: string[][], mocks: string[][]) => {
  vi.mocked(listGoogleSheetProperties).mockResolvedValue(["Recruitment Sheet", "Mock Teaching Test Log"].map((title) => ({ title, rowCount: 100 })) as never);
  vi.mocked(fetchGoogleSheetRange).mockImplementation(async (_e, _i, range: string) =>
    (range.includes("Recruitment") ? [["title"], recruitHead(), ...recruit] : [["title"], mockHead, ...mocks]) as never,
  );
};

beforeAll(async () => {
  handle = await startTestDb();
  db = handle.db as unknown as Database;
}, 120000);
afterAll(async () => {
  if (handle) await stopTestDb(handle);
});
beforeEach(async () => {
  vi.clearAllMocks();
  await db.execute(sql`truncate hiring_candidates, hiring_outbox, hiring_audit cascade`);
});

describe("parseTrackerResults", () => {
  it("stops when a column moved", () => {
    expect(() => parseTrackerResults([[], ["Applicant ID"]], [[], mockHead])).toThrow(/Recruitment headers/);
    expect(() => parseTrackerResults([[], recruitHead()], [[], ["Applicant ID"]])).toThrow(/Mock Teaching/);
  });
  it("reads a paper for each subject, and a mock with its score, and leaves blank rows", () => {
    const { papers, mocks } = parseTrackerResults(
      [[], recruitHead(), recruitRow("APP-1", "a@example.com", "Passed", "Mathematics, Physics"), recruitRow("APP-2", "b@example.com", ""), recruitRow("not-an-id", "c@example.com", "Passed")],
      [[], mockHead, ["APP-1", "", "Economics", "Kru Gift", "24 ก.ย. 2026", "12:00", "94", "Passed", "Good"], ["APP-2", "", "Physics", "", "", "", "", "", ""]],
    );
    expect(papers.map((p) => [p.applicantId, p.subject])).toEqual([["APP-1", "Mathematics"], ["APP-1", "Physics"]]);
    expect(mocks).toEqual([{ applicantId: "APP-1", subject: "Economics", history: { score: 94, outcome: "Passed", comment: "Good", date: "24 ก.ย. 2026", head: "Kru Gift" } }]);
  });
  it("counts a row with no subject it can name, and keeps a score that is not a number as written", () => {
    const parsed = parseTrackerResults([[], recruitHead(), recruitRow("APP-1", "a@example.com", "Passed", "")], [[], mockHead, ["APP-1", "", "Physics", "", "", "", "94/100", "Passed", ""], ["APP-1", "", "Maths, Physics", "", "", "", "80", "Passed", ""]]);
    expect(parsed.noSubject).toBe(2);
    expect(parsed.mocks[0].history).toMatchObject({ score: null, outcome: "94/100 Passed" });
  });
  it("does not read a pass in one subject as a pass in another (a real row: passed Maths, sat Maths and Physics)", () => {
    const row = recruitRow("APP-1", "a@example.com", "Passed", "Maths, Physics", "All level (Math)");
    row[20] = "Maths";
    const { papers } = parseTrackerResults([[], recruitHead(), row], [[], mockHead]);
    expect(papers.map((p) => [p.subject, p.history.outcome, p.history.levels])).toEqual([
      ["Mathematics", "Passed", "All level (Math)"],
      ["Physics", "Not listed as passed", ""],
    ]);
  });
});

describe("importResultHistory", () => {
  it("reports and writes nothing, then stores with source tracker, by applicant id and by email", async () => {
    const byId = (await db.insert(s.hiringCandidates).values({ name: "A", applicantId: "APP-1", stage: "paper_booked" }).returning())[0];
    const byEmail = (await db.insert(s.hiringCandidates).values({ name: "B", email: "b@example.com", stage: "onsite_booked" }).returning())[0];
    tracker([recruitRow("APP-1", "other@example.com", "Passed"), recruitRow("APP-2", "b@example.com", "Not Passed"), recruitRow("APP-3", "nobody@example.com", "Passed")], [["APP-1", "", "Mathematics", "Kru Peat", "", "", "80", "Passed", ""]]);
    expect(await importResultHistory(db, config, false)).toMatchObject({ papers: 3, mocks: 1, unmatchedPeople: 1, stored: 0, keptFromWebsite: 0, matchedWithBooking: 0 });
    expect(await db.select().from(s.hiringPaperResults)).toEqual([]);
    expect(await db.select().from(s.hiringAudit)).toEqual([]);

    expect(await importResultHistory(db, config, true)).toMatchObject({ stored: 3, keptFromWebsite: 0 });
    const papers = await db.select().from(s.hiringPaperResults);
    expect(papers.map((p) => p.candidateId).sort()).toEqual([byId.id, byEmail.id].sort());
    expect(papers[0]).toMatchObject({ source: "tracker", status: "done", marks: null });
    expect((await db.select().from(s.hiringMockResults))[0].history).toMatchObject({ score: 80, head: "Kru Peat" });
  });
  it("changes no stage, writes no old-flow pass, and queues nothing, even for a Passed", async () => {
    const row = (await db.insert(s.hiringCandidates).values({ name: "A", applicantId: "APP-1", stage: "paper_booked", subjects: ["Mathematics"] }).returning())[0];
    tracker([recruitRow("APP-1", "a@example.com", "Passed")], []);
    await importResultHistory(db, config, true);
    const [after] = await db.select().from(s.hiringCandidates).where(eq(s.hiringCandidates.id, row.id));
    expect(after).toMatchObject({ stage: "paper_booked", paperPassedSubjects: [], revision: row.revision });
    expect(await db.select().from(s.hiringOutbox)).toEqual([]);
  });
  it("refreshes its own rows on a rerun, and never touches a result from the website", async () => {
    const row = (await db.insert(s.hiringCandidates).values({ name: "A", applicantId: "APP-1" }).returning())[0];
    await db.insert(s.hiringMockResults).values({ candidateId: row.id, subject: "Physics", source: "ai", status: "done" });
    tracker([recruitRow("APP-1", "a@example.com", "Passed")], [["APP-1", "", "Physics", "", "", "", "70", "Passed", ""]]);
    expect(await importResultHistory(db, config, false)).toMatchObject({ keptFromWebsite: 1 });
    expect(await importResultHistory(db, config, true)).toMatchObject({ stored: 1, keptFromWebsite: 1 });
    expect((await db.select().from(s.hiringMockResults))[0]).toMatchObject({ source: "ai", history: null });
    tracker([recruitRow("APP-1", "a@example.com", "Not Passed")], []);
    await importResultHistory(db, config, true);
    expect((await db.select().from(s.hiringPaperResults))[0].history).toMatchObject({ outcome: "Not Passed" });
    expect(await db.select().from(s.hiringPaperResults)).toHaveLength(1);
  });
  it("removes its own row when someone corrects it out of the tracker", async () => {
    await db.insert(s.hiringCandidates).values({ name: "A", applicantId: "APP-1" });
    tracker([recruitRow("APP-1", "a@example.com", "Passed", "Mathematics, Physics")], []);
    await importResultHistory(db, config, true);
    expect(await db.select().from(s.hiringPaperResults)).toHaveLength(2);
    tracker([recruitRow("APP-1", "a@example.com", "Passed", "Mathematics")], []);
    expect(await importResultHistory(db, config, true)).toMatchObject({ removed: 1 });
    expect((await db.select().from(s.hiringPaperResults)).map((p) => p.subject)).toEqual(["Mathematics"]);
  });
  it("reads dates as the team sees them, not as serial numbers", async () => {
    tracker([], []);
    await importResultHistory(db, config, false);
    expect(vi.mocked(fetchGoogleSheetRange).mock.calls.every((call) => (call[3] as { dateTimeRenderOption?: string })?.dateTimeRenderOption === "FORMATTED_STRING")).toBe(true);
  });
  it("gives the report the number of matched people with a booking, for the approval", async () => {
    const row = (await db.insert(s.hiringCandidates).values({ name: "A", applicantId: "APP-1", stage: "onsite_booked" }).returning())[0];
    await db.insert(s.hiringBookings).values({ candidateId: row.id, kind: "paper", subjects: ["Mathematics"], calendarOwner: "o@example.com", startTime: new Date(), endTime: new Date(Date.now() + 1000), status: "confirmed", visitId: crypto.randomUUID(), evidence: {} as never });
    tracker([recruitRow("APP-1", "a@example.com", "Passed")], []);
    expect(await importResultHistory(db, config, false)).toMatchObject({ matchedWithBooking: 1 });
  });
});
