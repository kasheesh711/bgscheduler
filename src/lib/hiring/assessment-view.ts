import { bangkokWeekStart } from "./limits";

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
type Result = { candidateId: string; status: string; source: string };
type TrackerRow = Result & { subject: string; history?: { date: string | null } | null };

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
    const key = b.visitId ?? `${b.kind}:${b.candidateId}:${new Date(b.startTime).getTime()}`;
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
export function hireBlockers(papers: Result[], mocks: Result[]) {
  const blockers: string[] = [];
  // A past result from the tracker is not a result of this visit, and it may say Not Passed.
  if (!papers.some((p) => p.source !== "tracker")) blockers.push("No paper result yet.");
  if (!mocks.some((m) => m.source !== "tracker")) blockers.push("No mock result yet.");
  if ([...papers, ...mocks].some((r) => r.status === "needs_check")) blockers.push("A result needs a person to check it.");
  if (papers.some((p) => p.status !== "done" && p.status !== "needs_check")) blockers.push("A paper is not finished.");
  if (mocks.length && !mocks.some((m) => m.status === "done" || m.status === "needs_check")) blockers.push("The mock is not finished.");
  return blockers;
}

export const ASSESSMENT_CHIPS = ["Needs upload", "Needs check", "Ready to decide", "Past results"] as const;
export type AssessmentChip = (typeof ASSESSMENT_CHIPS)[number];
export const ASSESSMENT_RANGES = ["All dates", "This week", "Upcoming", "Past"] as const;
export type AssessmentRange = (typeof ASSESSMENT_RANGES)[number];

export function matchesRange(row: AssessmentRow, range: AssessmentRange, now = new Date()) {
  if (range === "All dates") return true;
  if (range === "Upcoming") return !row.history && !row.started;
  if (range === "Past") return row.started;
  if (!row.at) return false;
  const start = bangkokWeekStart(now).getTime();
  return row.at.getTime() >= start && row.at.getTime() < start + 7 * 86400000;
}

/** A person with a decision sent is not ready to decide. A no-show has nothing to upload. */
export function matchesChip(row: AssessmentRow, chip: AssessmentChip | null, papers: Result[], mocks: Result[], decided: boolean) {
  switch (chip) {
    case null:
      return !row.history;
    case "Needs upload":
      return !decided && !row.history && row.started && row.status === "confirmed" && ((row.kinds.includes("paper") && !papers.some((p) => p.source !== "tracker")) || (row.kinds.includes("mock") && !mocks.some((m) => m.source !== "tracker")));
    case "Needs check":
      return [...papers, ...mocks].some((r) => r.status === "needs_check");
    case "Ready to decide":
      return !row.history && !decided && !hireBlockers(papers, mocks).length;
    case "Past results":
      return row.history;
  }
}
