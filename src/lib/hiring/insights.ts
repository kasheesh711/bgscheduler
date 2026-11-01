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
/**
 * Which stages count as having reached each funnel step. The old paper path and the new onsite path both follow
 * `pre_screen`, so a step on one path never counts a candidate on the other. A parked candidate did get the form
 * (`no_reply`) or the link (`no_booking`), so it counts as having reached that step.
 */
const AFTER_REVIEW: Stage[] = [
  "pre_screen",
  "paper_invited",
  "paper_booked",
  "paper_passed",
  "mock_booked",
  "onsite_invited",
  "onsite_booked",
  "no_reply",
  "no_booking",
];
const REACHED: Partial<Record<Stage, Stage[]>> = {
  new: ["new", "review", ...AFTER_REVIEW],
  review: ["review", ...AFTER_REVIEW],
  pre_screen: AFTER_REVIEW,
  paper_invited: ["paper_invited", "paper_booked", "paper_passed", "mock_booked"],
  paper_booked: ["paper_booked", "paper_passed", "mock_booked"],
  paper_passed: ["paper_passed", "mock_booked"],
  mock_booked: ["mock_booked"],
  onsite_invited: ["onsite_invited", "onsite_booked", "no_booking"],
  onsite_booked: ["onsite_booked"],
};
/** Parked: the form or link went out and nothing came back. They stay in `active`, because a late reply is scored and a click sends a new link. */
const PARKED: Stage[] = ["no_reply", "no_booking"];
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
    /** A visit is an exam row and a mock row with one id. */
    visitId?: string | null;
  }[];
  outbox: { status: string }[];
};

/**
 * Who may receive the pre-screen form: a profile score at or above the threshold, an accepted work-rights answer,
 * a usable email, no earlier contact, a supported subject that is still hiring, and a degree that is not `not_met`.
 * `subject` is the highest-ranked hiring subject the profile supports.
 * `review` lists the reasons no setting can cure, which send a `new` row to review. A row with only other reasons waits at
 * `new`, because the next cycle re-runs this gate and a changed setting or a re-read answer lets it through.
 */
export function profileGate(
  candidate: Pick<
    InsightCandidate,
    "email" | "previouslyContacted" | "workRightsAnswer" | "profileAssessment" | "universityAssessment"
  >,
  config: GateConfig,
): { eligible: boolean; reasons: string[]; short: string[]; review: string[]; subject: Subject | null } {
  const reasons: string[] = [];
  // The same reasons in a few words, for a table cell.
  const short: string[] = [];
  const review: string[] = [];
  const add = (reason: string, words: string) => {
    reasons.push(reason);
    short.push(words);
  };
  const final = (reason: string, words: string) => {
    add(reason, words);
    review.push(reason);
  };
  const assessment = candidate.profileAssessment;
  const relevant = (assessment?.subjects ?? []).filter((s) => s.relevant).map((s) => s.subject);
  const subject = topHiringSubject(relevant, config.subjectPriority);
  if (!assessment) add("The profile is not scored.", "Not scored");
  else {
    if (
      profileScore(assessment, config.profileWeights, candidate.universityAssessment?.fraction ?? 0) <
      config.profileThreshold
    )
      add("The profile score is below the threshold.", "Below profile threshold");
    if (assessment.criteria.some((c) => c.id === "degree" && c.result === "not_met"))
      final("The degree criterion is not met.", "Degree not met");
    if (!relevant.length) final("The profile supports no subject.", "No supported subject");
    else if (!subject) add("No supported subject is open for hiring.", "Subject not hiring");
  }
  if (!workRightsAccepted(candidate.workRightsAnswer, config.acceptedWorkRights))
    add("The work-rights answer is missing or not accepted.", "Work-rights answer not accepted");
  if (!candidate.email) final("There is no usable email.", "No usable email");
  if (candidate.previouslyContacted) final("There was earlier contact.", "Earlier contact");
  return { eligible: reasons.length === 0, reasons, short, review, subject };
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
  // No reply and No booking stay in `active`: a late reply is scored and a click sends a new link. `parked` says how many they are.
  const active = candidates.filter((c) => c.stage !== "stopped");
  const byStage = Object.fromEntries(
    (Object.keys(STAGE_LABELS) as Stage[]).map((stage) => [stage, candidates.filter((c) => c.stage === stage).length]),
  ) as Record<Stage, number>;
  const scores = candidates.flatMap((c) => (c.profileScore === null ? [] : [c.profileScore]));
  const sorted = [...scores].sort((a, b) => a - b);
  const mid = sorted.length >> 1;

  const stages = ACTIVE_STAGES.map((stage) => ({
    stage,
    label: STAGE_LABELS[stage],
    at: byStage[stage],
    reached: (REACHED[stage] ?? [stage]).reduce((n, s) => n + byStage[s], 0),
  }));

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
  // A visit is two rows (exam and mock) with one visit id. It is one appointment.
  const appointments = new Set(
    upcoming
      .filter((b) => startOf(b) < weekEnd)
      .map((b) => b.visitId ?? `${b.candidateId}:${b.kind}:${startOf(b)}`),
  );
  const status = (name: string) => input.outbox.filter((j) => j.status === name).length;

  return {
    total: candidates.length,
    active: active.length,
    parked: PARKED.reduce((n, stage) => n + byStage[stage], 0),
    byStage,
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
    appointmentsThisWeek: appointments.size,
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
