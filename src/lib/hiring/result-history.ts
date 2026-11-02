import { and, eq } from "drizzle-orm";
import { type Database } from "@/lib/db";
import { withDatabaseTransaction } from "@/lib/db/transaction";
import * as s from "@/lib/db/schema";
import { fetchGoogleSheetRange, listGoogleSheetProperties } from "@/lib/sales-dashboard/sheets";
import { computeSheet, passRulesFor, rubricTotals, type MockHistory, type MockRubric, type PaperHistory, type PaperMarks } from "./marking-sheet";
import { normalizeEmail, normalizeSubjects, TRACKER_ID, type HiringConfig, type Subject } from "./model";
import { audit } from "./service";

const cell = (row: unknown[], index: number) => String(row[index] ?? "").trim();
const isApplicant = (id: string) => /^APP-\d+$/.test(id);

export type TrackerPaper = { applicantId: string; email: string | null; subject: Subject; history: PaperHistory };
export type TrackerMock = { applicantId: string; subject: Subject; history: MockHistory };

/**
 * The past results in the tracker. It holds an outcome and levels for a paper, and a total for a mock, so history has no
 * question or rubric detail. A column that moved stops the pass, because a wrong column would store wrong results.
 */
export function parseTrackerResults(recruit: unknown[][], mockLog: unknown[][]) {
  const recruitHead = recruit[1] ?? [];
  const headers = (row: unknown[], names: [number, string][]) => names.every(([index, name]) => cell(row, index).includes(name));
  if (!headers(recruitHead, [[0, "Applicant ID"], [2, "Email"], [13, "Final Subjects"], [16, "Paper Date"], [19, "Paper Outcome"], [20, "Passed Subjects"], [21, "Levels Passed"]]))
    throw new Error("Recruitment headers changed. Review the source mapping.");
  const mockHead = mockLog[1] ?? [];
  if (!headers(mockHead, [[0, "Applicant ID"], [2, "Subject"], [3, "Head Teacher"], [4, "Mock Date"], [6, "Mock Score"], [7, "Mock Outcome"], [8, "Teacher Comment"]]))
    throw new Error("Mock Teaching Test Log headers changed. Review the source mapping.");
  const emails = new Map<string, string | null>();
  const papers: TrackerPaper[] = [];
  let noSubject = 0;
  for (const row of recruit.slice(2)) {
    const applicantId = cell(row, 0);
    if (!isApplicant(applicantId)) continue;
    const email = normalizeEmail(row[2]);
    emails.set(applicantId, email);
    const outcome = cell(row, 19);
    if (!outcome) continue;
    const subjects = normalizeSubjects(cell(row, 13) || cell(row, 20));
    if (!subjects.length) noSubject++;
    const passed = normalizeSubjects(cell(row, 20));
    for (const subject of subjects) {
      // One outcome covers the whole row, so a person who passed Maths only must not read as passing Physics too.
      const notListed = outcome === "Passed" && passed.length > 0 && !passed.includes(subject);
      papers.push({
        applicantId,
        email,
        subject,
        history: { outcome: notListed ? "Not listed as passed" : outcome, passedSubjects: cell(row, 20), levels: notListed ? "" : cell(row, 21), date: cell(row, 16) || null },
      });
    }
  }
  const mocks: TrackerMock[] = [];
  for (const row of mockLog.slice(2)) {
    const applicantId = cell(row, 0);
    const scoreText = cell(row, 6);
    const outcome = cell(row, 7);
    if (!isApplicant(applicantId) || (!scoreText && !outcome)) continue;
    const named = normalizeSubjects(cell(row, 2));
    // A row should name one subject. Any other row is counted, and not guessed.
    if (named.length !== 1) {
      noSubject++;
      continue;
    }
    const score = Number(scoreText);
    const isNumber = scoreText !== "" && Number.isFinite(score);
    mocks.push({
      applicantId,
      subject: named[0],
      // A score such as "94/100" is kept as written, so a person can still read it.
      history: { score: isNumber ? score : null, outcome: isNumber || !scoreText ? outcome : [scoreText, outcome].filter(Boolean).join(" "), comment: cell(row, 8), date: cell(row, 4) || null, head: cell(row, 3) },
    });
  }
  return { papers, mocks, emails, noSubject };
}

async function readTrackerResults(config: HiringConfig) {
  const tabs = await listGoogleSheetProperties(config.connectedEmail, TRACKER_ID);
  const read = (name: string, last: string) => {
    const tab = tabs.find((t) => t.title === name);
    if (!tab) throw new Error(`Required tracker tab is missing: ${name}`);
    if (tab.rowCount > 10000) throw new Error("Tracker grew beyond the verified import range.");
    // The default gives a date cell as a serial number such as 46289.
    return fetchGoogleSheetRange(config.connectedEmail, TRACKER_ID, `'${name}'!A1:${last}${tab.rowCount}`, { dateTimeRenderOption: "FORMATTED_STRING" });
  };
  const [recruit, mockLog] = await Promise.all([read("Recruitment Sheet", "AD"), read("Mock Teaching Test Log", "J")]);
  return parseTrackerResults(recruit, mockLog);
}

/**
 * The tracker's past results. `write: false` only reports. A write stores rows with source `tracker`, and a rerun refreshes
 * only those: a result from this website is never touched. It changes no stage, writes no old-flow pass, and queues nothing,
 * so a "Passed" here can never start the old flow's mock invitation. Counts only, never names.
 */
export async function importResultHistory(db: Database, config: HiringConfig, write: boolean, actor = "hiring-backfill") {
  const { papers, mocks, emails, noSubject } = await readTrackerResults(config);
  const candidates = await db
    .select({ id: s.hiringCandidates.id, applicantId: s.hiringCandidates.applicantId, email: s.hiringCandidates.email })
    .from(s.hiringCandidates);
  const byApplicant = new Map(candidates.flatMap((c) => (c.applicantId ? [[c.applicantId, c.id] as const] : [])));
  // A new-flow row stores no applicant id, so the email is the second way to find the same person.
  const byEmail = new Map(candidates.flatMap((c) => (c.email ? [[c.email, c.id] as const] : [])));
  const find = (applicantId: string) => {
    const email = emails.get(applicantId);
    return byApplicant.get(applicantId) ?? (email ? byEmail.get(email) : undefined) ?? null;
  };
  const counts = { papers: papers.length, mocks: mocks.length, noSubject, unmatchedPeople: 0, stored: 0, keptFromWebsite: 0, removed: 0, matchedWithBooking: 0 };
  const unmatched = new Set([...papers, ...mocks].map((row) => row.applicantId).filter((id) => !find(id)));
  counts.unmatchedPeople = unmatched.size;
  const p = s.hiringPaperResults;
  const m = s.hiringMockResults;
  const [existingPapers, existingMocks, bookings] = await Promise.all([
    db.select({ candidateId: p.candidateId, subject: p.subject, source: p.source }).from(p),
    db.select({ candidateId: m.candidateId, subject: m.subject, source: m.source }).from(m),
    db.select({ candidateId: s.hiringBookings.candidateId, status: s.hiringBookings.status }).from(s.hiringBookings),
  ]);
  const websiteKeys = new Set([...existingPapers.map((r) => ({ ...r, kind: "paper" })), ...existingMocks.map((r) => ({ ...r, kind: "mock" }))].filter((r) => r.source !== "tracker").map((r) => `${r.kind}|${r.candidateId}|${r.subject}`));
  const keyOf = (kind: string, row: { applicantId: string; subject: Subject }) => `${kind}|${find(row.applicantId)}|${row.subject}`;
  // The report's numbers for the person who approves the write.
  counts.keptFromWebsite = papers.filter((row) => websiteKeys.has(keyOf("paper", row))).length + mocks.filter((row) => websiteKeys.has(keyOf("mock", row))).length;
  const matched = new Set([...papers, ...mocks].flatMap((row) => find(row.applicantId) ?? []));
  counts.matchedWithBooking = new Set(bookings.filter((b) => b.status !== "cancelled" && matched.has(b.candidateId)).map((b) => b.candidateId)).size;
  if (!write) return counts;
  await withDatabaseTransaction(db, async (tx) => {
    const keep = new Set<string>();
    for (const row of papers) {
      const candidateId = find(row.applicantId);
      if (!candidateId) continue;
      keep.add(keyOf("paper", row));
      const saved = await tx
        .insert(p)
        .values({ candidateId, subject: row.subject, source: "tracker", status: "done", history: row.history })
        .onConflictDoUpdate({ target: [p.candidateId, p.subject], set: { history: row.history, updatedAt: new Date() }, where: eq(p.source, "tracker") })
        .returning({ id: p.id });
      if (saved.length) counts.stored++;
    }
    for (const row of mocks) {
      const candidateId = find(row.applicantId);
      if (!candidateId) continue;
      keep.add(keyOf("mock", row));
      const saved = await tx
        .insert(m)
        .values({ candidateId, subject: row.subject, source: "tracker", status: "done", history: row.history })
        .onConflictDoUpdate({ target: [m.candidateId, m.subject], set: { history: row.history, updatedAt: new Date() }, where: eq(m.source, "tracker") })
        .returning({ id: m.id });
      if (saved.length) counts.stored++;
    }
    // A row someone corrected out of the tracker goes on a rerun too. Only for people still in the tracker's results.
    for (const old of existingPapers)
      if (old.source === "tracker" && matched.has(old.candidateId) && !keep.has(`paper|${old.candidateId}|${old.subject}`)) {
        await tx.delete(p).where(and(eq(p.candidateId, old.candidateId), eq(p.subject, old.subject), eq(p.source, "tracker")));
        counts.removed++;
      }
    for (const old of existingMocks)
      if (old.source === "tracker" && matched.has(old.candidateId) && !keep.has(`mock|${old.candidateId}|${old.subject}`)) {
        await tx.delete(m).where(and(eq(m.candidateId, old.candidateId), eq(m.subject, old.subject), eq(m.source, "tracker")));
        counts.removed++;
      }
    await audit(tx, actor, "result-history-import", null, counts);
  });
  return counts;
}

type PaperRow = { candidateId: string; subject: Subject; marks: PaperMarks | null; history: PaperHistory | null; status: string };
type MockRow = { candidateId: string; subject: Subject; rubric: MockRubric | null; history: MockHistory | null; status: string };
type DecisionRow = { candidateId: string; decision: string; status: string };
// "failed" here means the marking call failed. It must not read as the person failing.
const STATUS_WORDS: Record<string, string> = { uploaded: "waiting to be marked", marking: "being marked", failed: "could not be marked, retry needed", done: "done", needs_check: "needs check" };

/** Plain text for the `Hiring Automation` tab: paper results, levels passed, mock score, decision. */
export function resultColumns(candidateId: string, papers: PaperRow[], mocks: MockRow[], decisions: DecisionRow[], config: Pick<HiringConfig, "paperPassRules">) {
  const mine = papers.filter((row) => row.candidateId === candidateId);
  const sheets = mine.map((row) => ({ row, sheet: row.marks ? computeSheet(row.marks, passRulesFor(config, row.subject)) : null }));
  const paperText = sheets
    .map(({ row, sheet }) => {
      if (row.history) return `${row.subject}: ${row.history.outcome}`;
      if (!sheet) return `${row.subject}: ${STATUS_WORDS[row.status] ?? row.status}`;
      return `${row.subject}: ${sheet.total}/${sheet.max}${row.status === "needs_check" ? " (needs check)" : ""}`;
    })
    .join("; ");
  const levelsText = sheets
    .map(({ row, sheet }) => {
      const levels = sheet?.canTeachUpTo ?? row.history?.levels;
      return levels ? `${row.subject}: ${levels}` : "";
    })
    .filter(Boolean)
    .join("; ");
  const mockText = mocks
    .filter((row) => row.candidateId === candidateId)
    .map((row) => {
      if (row.history) return `${row.subject}: ${row.history.score ?? row.history.outcome}`;
      if (!row.rubric) return `${row.subject}: ${STATUS_WORDS[row.status] ?? row.status}`;
      return `${row.subject}: ${rubricTotals(row.rubric).total}/100${row.status === "needs_check" ? " (needs check)" : ""}`;
    })
    .join("; ");
  const sent = decisions.find((row) => row.candidateId === candidateId && row.status === "sent");
  return [paperText, levelsText, mockText, sent ? (sent.decision === "hire" ? "Hired" : "Rejected") : ""];
}
