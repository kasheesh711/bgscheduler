import { SUBJECTS, type HiringConfig, type Stage, type Subject } from "./model";
import { profileCanAdvance, type Assessment } from "./scoring";

export const STAGE_LABELS: Record<Stage, string> = {
  new: "New",
  review: "In review",
  pre_screen: "Pre-screen",
  paper_invited: "Paper invited",
  paper_booked: "Paper booked",
  paper_passed: "Paper passed",
  mock_booked: "Mock booked",
  stopped: "Stopped",
};
export const ACTIVE_STAGES: Stage[] = [
  "new",
  "review",
  "pre_screen",
  "paper_invited",
  "paper_booked",
  "paper_passed",
  "mock_booked",
];
export const CRITERIA = ["degree", "subject", "curriculum", "teaching", "english"] as const;
export const RESULTS = ["met", "partial", "not_met", "unknown"] as const;
export type CriterionResult = (typeof RESULTS)[number];

type InsightCandidate = {
  id: string;
  stage: Stage;
  email: string | null;
  preScreen: unknown;
  profileScore: number | null;
  profileAssessment: Assessment | null;
  universityAssessment: { fraction: number } | null;
  subjects: Subject[];
  paperPassedSubjects: Subject[];
  previouslyContacted: boolean;
  workRightsConfirmed: boolean | null;
};
type InsightInput = {
  config: Pick<HiringConfig, "profileThreshold" | "profileWeights" | "interviewers">;
  candidates: InsightCandidate[];
  bookings: {
    candidateId: string;
    kind: "paper" | "mock";
    interviewerKey: string | null;
    status: string;
    startTime: Date | string;
  }[];
  outbox: { status: string }[];
};

/** Mirrors the worker's gate for sending a new profile the pre-screen form. */
export function readyToInvite(
  candidate: InsightCandidate,
  config: InsightInput["config"],
) {
  return (
    candidate.stage === "new" &&
    !candidate.preScreen &&
    !!candidate.profileAssessment &&
    !!candidate.email &&
    !candidate.previouslyContacted &&
    candidate.workRightsConfirmed === true &&
    profileCanAdvance(
      candidate.profileAssessment,
      config.profileThreshold,
      config.profileWeights,
      candidate.universityAssessment?.fraction ?? 0,
    )
  );
}

export function buildInsights(input: InsightInput, now = new Date()) {
  const { candidates, config } = input;
  const threshold = config.profileThreshold;
  const active = candidates.filter((c) => c.stage !== "stopped");
  const scores = candidates.flatMap((c) => (c.profileScore === null ? [] : [c.profileScore]));
  const sorted = [...scores].sort((a, b) => a - b);
  const mid = sorted.length >> 1;

  let reached = 0;
  const stages = [...ACTIVE_STAGES]
    .reverse()
    .map((stage) => {
      const at = active.filter((c) => c.stage === stage).length;
      reached += at;
      return { stage, label: STAGE_LABELS[stage], at, reached };
    })
    .reverse();

  const histogram = Array.from({ length: 10 }, (_, i) => ({
    min: i * 10,
    count: scores.filter((v) => Math.min(Math.floor(v / 10), 9) === i).length,
  }));

  const evidence = CRITERIA.map((id) => {
    const counts = { met: 0, partial: 0, not_met: 0, unknown: 0 };
    for (const c of candidates)
      for (const row of c.profileAssessment?.criteria ?? [])
        if (row.id === id) counts[row.result]++;
    const total = RESULTS.reduce((n, r) => n + counts[r], 0);
    return { id, counts, total, metShare: total ? counts.met / total : 0 };
  });

  const subjects = SUBJECTS.map((subject) => ({
    subject,
    candidates: active.filter((c) => c.subjects.includes(subject)).length,
    passed: active.filter((c) => c.paperPassedSubjects.includes(subject)).length,
    interviewers: config.interviewers
      .filter((i) => i.subjects.includes(subject))
      .map((i) => i.canonicalKey),
  })).sort((a, b) => b.candidates - a.candidates || a.subject.localeCompare(b.subject));

  const confirmed = input.bookings.filter((b) => b.status === "confirmed");
  const startOf = (b: { startTime: Date | string }) => new Date(b.startTime).getTime();
  const weekEnd = now.getTime() + 7 * 86400000;
  const upcoming = confirmed.filter((b) => startOf(b) >= now.getTime());
  const booked = new Set(confirmed.map((b) => `${b.candidateId}:${b.kind}`));
  const status = (name: string) => input.outbox.filter((j) => j.status === name).length;

  return {
    total: candidates.length,
    active: active.length,
    stopped: candidates.length - active.length,
    scored: scores.length,
    unscored: candidates.length - scores.length,
    aboveThreshold: scores.filter((v) => v >= threshold).length,
    median: !sorted.length
      ? null
      : sorted.length % 2
        ? sorted[mid]
        : (sorted[mid - 1] + sorted[mid]) / 2,
    ready: candidates.filter((c) => readyToInvite(c, config)).length,
    pastReview: stages.find((s) => s.stage === "pre_screen")?.reached ?? 0,
    stages,
    histogram,
    evidence,
    weakest: scores.length
      ? evidence.reduce((low, row) => (row.metShare < low.metShare ? row : low))
      : null,
    subjects,
    uncoveredSubjects: subjects.filter((s) => !s.interviewers.length).length,
    appointmentsThisWeek: upcoming.filter((b) => startOf(b) < weekEnd).length,
    upcomingByInterviewer: Object.fromEntries(
      config.interviewers.map((i) => [
        i.canonicalKey,
        upcoming.filter((b) => b.interviewerKey === i.canonicalKey).length,
      ]),
    ),
    // Tracker imports can reach a booked stage with no reservation held here.
    bookedWithoutAppointment: active.filter(
      (c) =>
        (c.stage === "paper_booked" && !booked.has(`${c.id}:paper`)) ||
        (c.stage === "mock_booked" && !booked.has(`${c.id}:mock`)),
    ).length,
    messages: {
      sent: status("sent"),
      waiting: status("pending") + status("processing"),
      problems: status("failed") + status("uncertain"),
    },
  };
}
