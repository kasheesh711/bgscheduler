import { SUBJECTS, type HiringConfig, type Stage, type Subject } from "./model";
import { profileScore, topHiringSubject, workRightsAccepted, type Assessment } from "./scoring";

export const STAGE_LABELS: Record<Stage, string> = {
  new: "New",
  review: "In review",
  pre_screen: "Pre-screen",
  paper_invited: "Paper invited",
  paper_booked: "Paper booked",
  paper_passed: "Paper passed",
  mock_booked: "Mock booked",
  onsite_invited: "Onsite invited",
  onsite_booked: "Onsite booked",
  no_reply: "No reply",
  no_booking: "No booking",
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
  "onsite_invited",
  "onsite_booked",
];
export const CRITERIA = ["degree", "subject", "curriculum", "teaching", "english"] as const;
export const RESULTS = ["met", "partial", "not_met", "unknown"] as const;
export type CriterionResult = (typeof RESULTS)[number];

const POINTS: Record<CriterionResult, number> = { met: 1, partial: 0.5, not_met: 0, unknown: 0 };
/** Degree, Subject, Curriculum, Teaching, English as 1, 0.5 or 0. */
export const criterionValues = (assessment: { criteria: { id: string; result: CriterionResult }[] }) =>
  CRITERIA.map((id) => {
    const row = assessment.criteria.find((c) => c.id === id);
    return row ? POINTS[row.result] : 0;
  });
/** Mean value per criterion across candidates that have a profile assessment. */
export function averageValues(candidates: { profileAssessment: Assessment | null }[]) {
  const rows = candidates.flatMap((c) => (c.profileAssessment ? [criterionValues(c.profileAssessment)] : []));
  return CRITERIA.map((_, i) => (rows.length ? rows.reduce((n, r) => n + r[i], 0) / rows.length : 0));
}

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
  workRightsAnswer: string | null;
};
type GateConfig = Pick<
  HiringConfig,
  "profileThreshold" | "profileWeights" | "acceptedWorkRights" | "subjectPriority"
>;
type InsightInput = {
  config: GateConfig & Pick<HiringConfig, "interviewers">;
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

/**
 * Who may receive the pre-screen form: a profile score at or above the threshold, an accepted work-rights answer,
 * a usable email, no earlier contact, a supported subject that is still hiring, and a degree that is not `not_met`.
 * `subject` is the highest-ranked hiring subject the profile supports.
 */
export function profileGate(
  candidate: Pick<
    InsightCandidate,
    "email" | "previouslyContacted" | "workRightsAnswer" | "profileAssessment" | "universityAssessment"
  >,
  config: GateConfig,
): { eligible: boolean; reasons: string[]; subject: Subject | null } {
  const reasons: string[] = [];
  const assessment = candidate.profileAssessment;
  const subject = topHiringSubject(
    (assessment?.subjects ?? []).filter((s) => s.relevant).map((s) => s.subject),
    config.subjectPriority,
  );
  if (!assessment) reasons.push("The profile is not scored.");
  else {
    if (
      profileScore(assessment, config.profileWeights, candidate.universityAssessment?.fraction ?? 0) <
      config.profileThreshold
    )
      reasons.push("The profile score is below the threshold.");
    if (assessment.criteria.some((c) => c.id === "degree" && c.result === "not_met"))
      reasons.push("The degree criterion is not met.");
    if (!subject) reasons.push("No supported subject is open for hiring.");
  }
  if (!workRightsAccepted(candidate.workRightsAnswer, config.acceptedWorkRights))
    reasons.push("The work-rights answer is missing or not accepted.");
  if (!candidate.email) reasons.push("There is no usable email.");
  if (candidate.previouslyContacted) reasons.push("There was earlier contact.");
  return { eligible: reasons.length === 0, reasons, subject };
}

/** Mirrors the queue's gate for sending a new profile the pre-screen form. */
export function readyToInvite(
  candidate: InsightCandidate,
  config: GateConfig,
) {
  return (
    candidate.stage === "new" &&
    !candidate.preScreen &&
    profileGate(candidate, config).eligible
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
