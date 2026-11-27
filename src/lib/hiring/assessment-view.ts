import { computeSheet, passRulesFor, rubricTotals, type MockRubric, type PaperMarks } from "./marking-sheet";
import type { HiringConfig, Subject } from "./model";

type Booking = {
  candidateId: string;
  kind: "paper" | "mock";
  status: string;
  startTime: Date | string;
  endTime: Date | string;
  visitId?: string | null;
  interviewerKey?: string | null;
  subjects: string[];
};
type Result = { candidateId: string; status: string; source: string; rubric?: MockRubric | null; stuck?: boolean };
type TrackerRow = Result & { subject: string; history?: { date: string | null } | null };
const assessmentKey = (booking: Pick<Booking, "visitId" | "kind" | "candidateId" | "startTime">) =>
  booking.visitId ?? `${booking.kind}:${booking.candidateId}:${new Date(booking.startTime).getTime()}`;

export type AssessmentRow = {
  key: string;
  candidateId: string;
  at: Date | null;
  mockAt: Date | null;
  dateText: string | null;
  subject: string;
  headKey: string | null;
  status: string;
  started: boolean;
  history: boolean;
  /** What this row booked, so an old-flow paper booking does not wait for a mock. */
  kinds: ("paper" | "mock")[];
};

/** One row for each visit, one for each old-flow booking, and one for a person known only from the tracker's results. */
export function assessmentRows(bookings: Booking[], papers: TrackerRow[], mocks: TrackerRow[], now = new Date()): AssessmentRow[] {
  // A candidate whose only visit was cancelled keeps a row, or a person could never reject them.
  const active = new Set(bookings.filter((b) => b.status !== "cancelled").map((b) => b.candidateId));
  const live = bookings.filter((b) => b.status !== "cancelled" || !active.has(b.candidateId));
  const groups = new Map<string, Booking[]>();
  for (const b of live) {
    const key = assessmentKey(b);
    groups.set(key, [...(groups.get(key) ?? []), b]);
  }
  const rows: AssessmentRow[] = [...groups].map(([key, group]) => {
    const exam = group.find((b) => b.kind === "paper");
    const mock = group.find((b) => b.kind === "mock");
    const first = exam ?? mock!;
    const at = new Date(first.startTime);
    return {
      key,
      candidateId: first.candidateId,
      at,
      mockAt: mock ? new Date(mock.startTime) : null,
      dateText: null,
      subject: (mock ?? exam!).subjects[0] ?? "",
      headKey: mock?.interviewerKey ?? null,
      status: first.status,
      started: at <= now,
      history: false,
      kinds: group.map((b) => b.kind),
    };
  });
  const booked = new Set(live.map((b) => b.candidateId));
  const seen = new Set<string>();
  for (const row of [...mocks, ...papers]) {
    if (row.source !== "tracker" || booked.has(row.candidateId) || seen.has(row.candidateId)) continue;
    seen.add(row.candidateId);
    rows.push({
      key: `history:${row.candidateId}`,
      candidateId: row.candidateId,
      at: null,
      mockAt: null,
      dateText: row.history?.date ?? null,
      subject: row.subject,
      headKey: null,
      status: "confirmed",
      started: true,
      history: true,
      kinds: [],
    });
  }
  const time = (row: AssessmentRow) => row.at?.getTime() ?? 0;
  // What is coming, soonest first. Then what has happened, newest first. Then the tracker's past results.
  return rows.sort((a, b) => {
    const group = (row: AssessmentRow) => (row.history ? 2 : row.started ? 1 : 0);
    if (group(a) !== group(b)) return group(a) - group(b);
    return group(a) === 0 ? time(a) - time(b) : time(b) - time(a);
  });
}

/**
 * What stops the Hire button: one mock result, and every uploaded paper finished. A person must clear a result that needs a
 * check. A "pass mark missing" sheet counts, because its marks exist. Reject has its own rule.
 */
export function hireBlockers(papers: Result[], mocks: Result[], paperWaived = false) {
  const blockers: string[] = [];
  // A past result from the tracker is not a result of this visit, and it may say Not Passed.
  if (!paperWaived && !papers.some((p) => p.source !== "tracker")) blockers.push("No paper result yet.");
  if (!mocks.some((m) => m.source !== "tracker")) blockers.push("No mock result yet.");
  if ([...papers, ...mocks].some((r) => r.status === "needs_check")) blockers.push("A result needs a person to check it.");
  if (papers.some((p) => p.status !== "done" && p.status !== "needs_check")) blockers.push("A paper is not finished.");
  if (mocks.length && !mocks.some((m) => m.status === "done" || m.status === "needs_check")) blockers.push("The mock is not finished.");
  return blockers;
}

/** What a paper result means, first word first. The list and the panel read the same numbers from here. */
export type Verdict = "pass" | "fail" | "checking" | "needs_check" | "marking" | "failed" | "missing_mark" | "recorded";
export type PaperScore = { verdict: Verdict; percent: number | null; passMark: number | null; level: string | null; scored: number; max: number; head: string | null; note: string | null };
type PaperLike = { id: string; subject: string; status: string; marks?: Pick<PaperMarks, "questions"> | null; history?: { outcome?: string | null } | null; updatedAt?: Date | string };
type CheckLike = { resultId: string; percent: number; head?: string | null; headLabel?: string | null; done: { passed: boolean; percent: number; head: string; override?: string | null; at?: string; marksAt?: string | null } | null };

/** An override applies only to the marks the head checked. Older checks have only the date of the answer. */
export const paperCheckIsStale = (paper: Pick<PaperLike, "updatedAt">, check?: CheckLike) =>
  !!(check?.done && paper.updatedAt && (check.done.marksAt
    ? new Date(paper.updatedAt).getTime() !== new Date(check.done.marksAt).getTime()
    : check.done.at && new Date(paper.updatedAt) > new Date(check.done.at)));

// The level a pass names: the highest one passed, as "Can teach up to" reads it.
const PASS_ORDER = ["AS / A-Level", "IB SL / HL", "AP", "IGCSE / GCSE", "Key Stage 3", "Other"];

export function paperScore(paper: PaperLike, config: Pick<HiringConfig, "paperPassRules">, check?: CheckLike): PaperScore {
  const empty = { percent: null, passMark: null, level: null, scored: 0, max: 0, head: null, note: null };
  if (paper.history) return { ...empty, verdict: "recorded", note: paper.history.outcome || null };
  if (paper.status === "marking" || paper.status === "uploaded") return { ...empty, verdict: "marking" };
  if (paper.status === "failed" || !paper.marks) return { ...empty, verdict: "failed" };
  const sheet = computeSheet(paper.marks, passRulesFor(config, paper.subject as Subject));
  const tried = sheet.levels.filter((l) => l.result !== "not_done" && l.max > 0);
  // A pass names the level it allows; anything else names the best try, which is what a head checks.
  const passed = PASS_ORDER.map((level) => tried.find((l) => l.level === level && l.result === "passed")).find(Boolean);
  const best = passed ?? [...tried].sort((a, b) => b.scored / b.max - a.scored / a.max)[0];
  const base = { ...empty, percent: best ? Math.round((best.scored / best.max) * 1000) / 10 : 0, passMark: best?.passPercent ?? null, level: best?.level ?? null, scored: best?.scored ?? 0, max: best?.max ?? 0 };
  if (paper.status === "needs_check") return { ...base, verdict: "needs_check" };
  // A pass keeps the passed level's own percent, so the number and the level agree.
  if (check?.done && !paperCheckIsStale(paper, check)) return { ...base, verdict: check.done.passed ? "pass" : "fail", percent: check.done.passed ? base.percent : check.done.percent, head: check.done.head, note: check.done.override ? `Head override: ${check.done.override}` : null };
  if (check?.done) return { ...base, verdict: sheet.result === "passed" ? "pass" : sheet.result === "pass_mark_missing" ? "missing_mark" : "fail" };
  if (check) return { ...base, verdict: "checking", head: check.headLabel ?? check.head ?? null };
  return { ...base, verdict: sheet.result === "passed" ? "pass" : sheet.result === "pass_mark_missing" ? "missing_mark" : "fail" };
}

export function mockScore(rubric: MockRubric) {
  const totals = rubricTotals(rubric);
  return { total: totals.total, max: totals.max, percent: totals.percent };
}

/** Where a visit sits in the work list. The order of LANES is the order of urgency. */
export const LANES = ["late_scan", "check", "rubric", "scan", "decide", "waiting", "upcoming", "finished"] as const;
export type Lane = (typeof LANES)[number];

export function laneOf(row: AssessmentRow, papers: Result[], mocks: Result[], verdicts: Verdict[], decided: boolean, now = new Date(), paperWaived = false): Lane {
  if (row.history || decided || row.status === "cancelled" || row.status === "no_show") return "finished";
  const own = (r: Result) => r.source !== "tracker";
  const results = [...papers, ...mocks].filter(own);
  // A stuck AI run needs a person to run it again, like a failed one.
  if (results.some((r) => r.status === "needs_check" || r.status === "failed" || r.stuck)) return "check";
  if (!row.started) return "upcoming";
  // A scan before the mock still helps the head; after the mock (or with none booked) it is late.
  if (!paperWaived && row.kinds.includes("paper") && !papers.some(own)) return row.mockAt && row.mockAt > now ? "scan" : "late_scan";
  if (verdicts.includes("checking") || results.some((r) => r.status === "marking" || r.status === "uploaded")) return "waiting";
  // A paper that did not pass is final: a person sends the rejection without waiting for the mock.
  if (verdicts.includes("fail") && !verdicts.includes("pass")) return "decide";
  if (row.mockAt && row.mockAt <= now && !mocks.some(own)) return "rubric";
  if (!hireBlockers(papers, mocks, paperWaived).length) return "decide";
  return "waiting";
}

type Slot = { id?: string; candidateId: string; kind: "paper" | "mock"; status: string; startTime: Date | string; visitId?: string | null; interviewerKey?: string | null; subjects: string[] };
const DAY = 86400000;
const BKK = 7 * 3600000;
/** Midnight in Bangkok on the day of `at`. Bangkok has no daylight saving. */
export const bangkokDay = (at: Date) => new Date(Math.floor((at.getTime() + BKK) / DAY) * DAY - BKK);

/** Every paper test and mock from the start of today (Bangkok) for `days` days, soonest first. Cancelled ones are left out. */
export function arrivals<T extends Slot>(bookings: T[], now = new Date(), days = 7) {
  const start = bangkokDay(now).getTime();
  // A visit's paper test has no head of its own; it takes the head of the visit's mock.
  const headOf = new Map(bookings.filter((b) => b.kind === "mock" && b.visitId).map((b) => [b.visitId!, b.interviewerKey ?? null]));
  return bookings
    .filter((b) => b.status !== "cancelled")
    .map((b) => ({ ...b, at: new Date(b.startTime), head: b.interviewerKey ?? (b.visitId ? headOf.get(b.visitId) ?? null : null), subject: b.subjects[0] ?? "" }))
    .filter((b) => b.at.getTime() >= start && b.at.getTime() < start + days * DAY)
    .sort((a, b) => a.at.getTime() - b.at.getTime() || a.kind.localeCompare(b.kind));
}

/** The paper schedule comes from confirmed bookings for the Bangkok date. */
export function todayPaperTests<T extends Booking>(bookings: T[], now: Date) {
  return arrivals(bookings, now, 1)
    .filter((booking) => booking.kind === "paper" && booking.status === "confirmed")
    .map((booking) => ({ ...booking, key: assessmentKey(booking), start: booking.at, end: new Date(booking.endTime) }));
}

type PaperResult = {
  id: string;
  bookingId: string | null;
  candidateId: string;
  subject: string;
  source: string;
  updatedAt: Date | string;
  history?: { date: string | null } | null;
};

/** Open a result at its recorded sitting, or on its own when the sitting cannot be verified. */
export function assessmentPaperResults<T extends PaperResult>(papers: T[], bookings: (Booking & { id: string })[], rows: AssessmentRow[]) {
  const byId = new Map(bookings.map((booking) => [booking.id, booking]));
  const byKey = new Map(rows.map((row) => [row.key, row]));
  return [...papers].sort((a, b) => Number(a.source === "tracker") - Number(b.source === "tracker") ||
    new Date(b.updatedAt).getTime() - new Date(a.updatedAt).getTime()).map((paper) => {
    const linked = paper.bookingId ? byId.get(paper.bookingId) : undefined;
    const booking = linked?.kind === "paper" && linked.candidateId === paper.candidateId ? linked : undefined;
    const at = booking ? new Date(booking.startTime) : null;
    const visit = booking && byKey.get(assessmentKey(booking));
    if (visit && visit.kinds.includes("paper") && visit.at?.getTime() === at?.getTime()) return { paper, row: visit };
    const row: AssessmentRow = {
      key: `paper-result:${paper.id}`,
      candidateId: paper.candidateId,
      at,
      mockAt: null,
      dateText: paper.history?.date ?? null,
      subject: paper.subject,
      headKey: null,
      status: booking?.status ?? "confirmed",
      started: true,
      history: true,
      kinds: [],
    };
    return { paper, row };
  });
}
