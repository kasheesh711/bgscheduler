import type { AutowriterDashboard } from "@/lib/feedback-autowriter/dashboard";
import type { AutowriterReview, ReviewQueueItem } from "@/lib/feedback-autowriter/review-data";
import type { AutowriterTrends, TrendDay, TrendRangeDays } from "@/lib/feedback-autowriter/trends";

/**
 * Made-up payloads of the autowriter dashboard, for the component tests and for the visual check
 * (`scripts/dev/render-autowriter-dashboard.mjs`, which bundles this file for the browser: types only from the
 * server modules). Tutors are Anna, Ben, Chai, Dao and Emma; a class is named by its subject, never by a student.
 */

/** Tuesday 6 October 2026, 15:35 in Bangkok: every fixture is dated from here. */
export const FIXTURE_NOW = "2026-10-06T08:35:00.000Z";
export const FIXTURE_TODAY = "2026-10-06";

/** An instant from a Bangkok date and time of day. */
function at(date: string, time: string): string {
  return new Date(`${date}T${time}:00+07:00`).toISOString();
}

function addDays(date: string, days: number): string {
  const value = new Date(`${date}T00:00:00Z`);
  value.setUTCDate(value.getUTCDate() + days);
  return value.toISOString().slice(0, 10);
}

/** The feedback deadline of a class: the end of the second Bangkok day after it. */
function deadlineOf(date: string): string {
  return new Date(`${addDays(date, 2)}T23:59:59.999+07:00`).toISOString();
}

const id = (suffix: string) => `6a${suffix.padStart(22, "0")}`;
const wiseUrl = (wiseSessionId: string) => `https://learn.example.com/links?type=classroom_entity&entityId=${wiseSessionId}`;

export const FIXTURE_TUTORS = [
  { tutorKey: "Anna", displayName: "Anna", wiseUserIds: [id("a1"), id("a2")] },
  { tutorKey: "Ben", displayName: "Ben", wiseUserIds: [id("b1"), id("b2")] },
  { tutorKey: "Chai", displayName: "Chai", wiseUserIds: [id("c1"), id("c2")] },
  { tutorKey: "Dao", displayName: "Dao", wiseUserIds: [id("d1"), id("d2")] },
  { tutorKey: "Emma", displayName: "Emma", wiseUserIds: [id("e1"), id("e2")] },
] as const;

/** Wise session ids the tests look classes up by. */
export const SESSION = {
  annaToReview: id("1001"),
  benToReview: id("1002"),
  chaiToReview: id("1003"),
  benFlagged: id("1004"),
  chaiReviewed: id("1005"),
  benCritical: id("1006"),
  annaReviewed: id("1007"),
  benHeldRecording: id("2001"),
  chaiHeldJudge: id("2002"),
  annaHeldAbsent: id("2003"),
  daoHeldWritten: id("2004"),
  emmaHeldStale: id("2005"),
  benFailed: id("3001"),
  annaTutorFirst: id("4001"),
  daoWaiting: id("4002"),
  emmaOutOfScope: id("4003"),
  annaShadow: id("4004"),
} as const;

export const INCIDENT = {
  critical: "11111111-1111-4111-8111-111111111111",
  acknowledged: "22222222-2222-4222-8222-222222222222",
  info: "33333333-3333-4333-8333-333333333333",
} as const;

export const FIRST_SHOT = {
  topics: "Rotations and reflections on the coordinate grid",
  performance: "Finished all eight questions on rotation and explained each step aloud.",
  improvement: "Describing a reflection by the equation of its mirror line",
  homework: "Worksheet 4, questions 1 to 6, for Thursday",
};

const CORRECTED = { ...FIRST_SHOT, performance: "Finished six of the eight questions on rotation and explained each step aloud." };

type Recent = AutowriterDashboard["recent"][number];
type Hold = AutowriterDashboard["holds"][number];

function recent(wiseSessionId: string, tutorKey: string, date: string, time: string, patch: Partial<Recent>): Recent {
  return {
    wiseSessionId,
    wiseUrl: wiseUrl(wiseSessionId),
    className: "Year 9 Maths",
    tutor: tutorKey,
    tutorKey,
    scheduledEndAt: at(date, time),
    state: "verified",
    reason: "verified",
    arm: "sol",
    evidence: "transcript",
    postStartedAt: null,
    latencyMinutes: null,
    costUsd: 0.041,
    fields: null,
    judgeUnsupported: [],
    summaryFallback: null,
    ...patch,
  };
}

function hold(wiseSessionId: string, tutorKey: string, date: string, time: string, patch: Partial<Hold>): Hold {
  return {
    wiseSessionId,
    tutor: tutorKey,
    tutorKey,
    className: "Year 9 Maths",
    classEndedAt: at(date, time),
    deadlineAt: deadlineOf(date),
    reason: "recording_too_short",
    alertSentAt: null,
    hasDraft: false,
    resolvedBy: null,
    wiseUrl: wiseUrl(wiseSessionId),
    ...patch,
  };
}

/** The busy day of the mockup: three posts to review, three holds, a failed post and a critical incident. */
export function dashboardFixture(overrides: Partial<AutowriterDashboard> = {}): AutowriterDashboard {
  return {
    generatedAt: FIXTURE_NOW,
    windowDays: 7,
    control: {
      mode: "live", haltedAt: null, haltReason: null, disabledTutors: [...FIXTURE_TUTORS[4].wiseUserIds, FIXTURE_TUTORS[3].wiseUserIds[0]],
      updatedBy: "owner@example.com", updatedAt: at("2026-09-29", "15:07"),
    },
    system: {
      writer: { model: "openai/gpt-6.1-sol", effort: "low" },
      fallbackWriter: { model: "openai/gpt-6-luna", effort: "max" },
      judge: { model: "z-ai/glm-5.3-flash", efforts: ["medium", "high"] },
      transcriptFirst: true,
      secondPass: true,
      promptVersion: 5,
      judgeVersion: 5,
      commit: "abc1234",
    },
    today: { date: FIXTURE_TODAY, posted: 6, awaitingRecording: 2, held: 1, skippedHuman: 1, skippedScope: 1 },
    holds: [
      // The deadline passed 15 hours ago: red, and listed for a day more.
      hold(SESSION.annaHeldAbsent, "Anna", "2026-10-03", "10:00", { className: "IGCSE Physics", reason: "attendance_0pct", alertSentAt: at("2026-10-03", "11:20") }),
      // Due tonight: amber.
      hold(SESSION.benHeldRecording, "Ben", "2026-10-04", "12:00", { className: "Year 8 English", alertSentAt: at("2026-10-04", "14:05") }),
      // Two days to go; the judged draft is kept on the row.
      hold(SESSION.chaiHeldJudge, "Chai", "2026-10-05", "14:00", {
        className: "A-level Chemistry", reason: "sol:unfaithful:finished the whole past paper; luna:unfaithful:finished the whole past paper",
        alertSentAt: at("2026-10-05", "15:18"), hasDraft: true,
      }),
      // A person wrote it since: off the to-do list, still in the log.
      hold(SESSION.daoHeldWritten, "Dao", "2026-10-05", "16:00", { className: "SAT Reading", reason: "speakers_unclear", resolvedBy: "tutor_wrote" }),
      // Nobody wrote it and the deadline is days gone: off the to-do list too.
      hold(SESSION.emmaHeldStale, "Emma", "2026-09-30", "09:00", { className: "Year 6 Science", reason: "transcript_too_short" }),
    ],
    failedPosts: [{
      wiseSessionId: SESSION.benFailed, tutor: "Ben", tutorKey: "Ben", className: "Year 8 English", classEndedAt: at("2026-10-05", "10:00"),
      state: "verify_failed", reason: "verify_failed", wiseUrl: wiseUrl(SESSION.benFailed),
    }],
    totals: {
      seen: 58, posted: 41, verified: 40, awaitingEvent: 1, shadowDrafts: 1, awaitingRecording: 2, fromTranscript: 27,
      held: 5, skippedHuman: 6, skippedScope: 2, expired: 1, failed: 1, inProgress: 0,
    },
    latency: {
      medianMinutes: 12.4, p90Minutes: 71.5, samples: 41,
      byRoute: [
        { route: "transcript", label: "From the transcript", medianMinutes: 55, p90Minutes: 72, samples: 27 },
        { route: "summary_fallback", label: "From the summary (fallback)", medianMinutes: 184.5, p90Minutes: 190, samples: 2 },
        { route: "summary", label: "From the summary", medianMinutes: 2.5, p90Minutes: 4, samples: 12 },
      ],
    },
    summaryFallbacks: [{ cause: "no_recording", label: "No recording after 3 h — from summary", count: 2 }],
    cost: {
      totalUsd: 1.7234,
      perDraftUsd: 0.041,
      byModel: [
        { model: "openai/gpt-6.1-sol", role: "writer", calls: 39, costUsd: 1.2012 },
        { model: "stt-async-v5", role: "transcriber", calls: 29, costUsd: 0.2925 },
        { model: "z-ai/glm-5.3-flash", role: "judge", calls: 84, costUsd: 0.1861 },
        { model: "openai/gpt-6-luna", role: "writer", calls: 5, costUsd: 0.0436 },
      ],
      byDay: [
        { date: "2026-09-30", costUsd: 0.2214, drafts: 6, posted: 6 },
        { date: "2026-10-01", costUsd: 0.2406, drafts: 7, posted: 7 },
        { date: "2026-10-02", costUsd: 0.2101, drafts: 6, posted: 6 },
        { date: "2026-10-03", costUsd: 0.2633, drafts: 7, posted: 7 },
        { date: "2026-10-04", costUsd: 0.2198, drafts: 6, posted: 6 },
        { date: "2026-10-05", costUsd: 0.2872, drafts: 8, posted: 7 },
        { date: "2026-10-06", costUsd: 0.281, drafts: 7, posted: 6 },
      ],
    },
    fallbackShare: 0.119,
    judgeRejections: 4,
    tutors: [
      { ...FIXTURE_TUTORS[0], wiseUserIds: [...FIXTURE_TUTORS[0].wiseUserIds], enabled: true, partlyEnabled: false, seen: 19, posted: 15, shadowDrafts: 1, held: 1, skippedHuman: 2, expired: 0, failed: 0, medianLatencyMinutes: 11.8, costUsd: 0.6241 },
      { ...FIXTURE_TUTORS[1], wiseUserIds: [...FIXTURE_TUTORS[1].wiseUserIds], enabled: true, partlyEnabled: false, seen: 18, posted: 12, shadowDrafts: 0, held: 1, skippedHuman: 3, expired: 1, failed: 1, medianLatencyMinutes: 14.2, costUsd: 0.5122 },
      { ...FIXTURE_TUTORS[2], wiseUserIds: [...FIXTURE_TUTORS[2].wiseUserIds], enabled: true, partlyEnabled: false, seen: 16, posted: 13, shadowDrafts: 0, held: 1, skippedHuman: 1, expired: 0, failed: 0, medianLatencyMinutes: 12.1, costUsd: 0.5408 },
      { ...FIXTURE_TUTORS[3], wiseUserIds: [...FIXTURE_TUTORS[3].wiseUserIds], enabled: false, partlyEnabled: true, seen: 3, posted: 1, shadowDrafts: 0, held: 1, skippedHuman: 0, expired: 0, failed: 0, medianLatencyMinutes: 58, costUsd: 0.0463 },
      { ...FIXTURE_TUTORS[4], wiseUserIds: [...FIXTURE_TUTORS[4].wiseUserIds], enabled: false, partlyEnabled: false, seen: 2, posted: 0, shadowDrafts: 0, held: 1, skippedHuman: 0, expired: 0, failed: 0, medianLatencyMinutes: null, costUsd: 0 },
    ],
    recent: [
      recent(SESSION.annaToReview, "Anna", FIXTURE_TODAY, "13:00", { postStartedAt: at(FIXTURE_TODAY, "14:12"), latencyMinutes: 72, costUsd: 0.0452, fields: FIRST_SHOT }),
      recent(SESSION.benToReview, "Ben", FIXTURE_TODAY, "11:00", {
        className: "Year 8 English", arm: "luna", evidence: "summary", postStartedAt: at(FIXTURE_TODAY, "11:03"), latencyMinutes: 2.5, costUsd: 0.0094, fields: FIRST_SHOT,
      }),
      recent(SESSION.daoWaiting, "Dao", FIXTURE_TODAY, "10:00", {
        className: "SAT Reading", state: "awaiting_recording", reason: "transcript_first", arm: null, costUsd: 0,
      }),
      recent(SESSION.annaTutorFirst, "Anna", FIXTURE_TODAY, "09:00", {
        className: "IGCSE Physics", state: "skipped_human", reason: "human_submission", arm: null, evidence: "summary", costUsd: 0,
      }),
      recent(SESSION.emmaOutOfScope, "Emma", FIXTURE_TODAY, "08:00", {
        className: "Year 6 Science", state: "skipped_scope", reason: "student_count_3", arm: null, evidence: "summary", costUsd: 0,
      }),
      recent(SESSION.chaiToReview, "Chai", "2026-10-05", "18:00", {
        className: "A-level Chemistry", postStartedAt: at("2026-10-05", "19:16"), latencyMinutes: 76, costUsd: 0.0431, fields: FIRST_SHOT,
      }),
      recent(SESSION.daoHeldWritten, "Dao", "2026-10-05", "16:00", { className: "SAT Reading", state: "held", reason: "speakers_unclear", arm: null, costUsd: 0.0102 }),
      recent(SESSION.benFlagged, "Ben", "2026-10-05", "15:00", {
        className: "Year 8 English", arm: "luna", evidence: "summary", postStartedAt: at("2026-10-05", "18:06"), latencyMinutes: 186, costUsd: 0.0131, fields: CORRECTED,
        summaryFallback: { cause: "no_recording", label: "No recording after 3 h — from summary" },
      }),
      recent(SESSION.chaiHeldJudge, "Chai", "2026-10-05", "14:00", {
        className: "A-level Chemistry", state: "held", reason: "sol:unfaithful:finished the whole past paper; luna:unfaithful:finished the whole past paper",
        costUsd: 0.0874, fields: { ...FIRST_SHOT, performance: "Finished the whole past paper under timed conditions." },
        judgeUnsupported: ["finished the whole past paper"],
      }),
      recent(SESSION.benFailed, "Ben", "2026-10-05", "10:00", {
        className: "Year 8 English", state: "verify_failed", reason: "verify_failed", postStartedAt: at("2026-10-05", "11:04"), latencyMinutes: 64, fields: FIRST_SHOT,
      }),
      recent(SESSION.annaShadow, "Anna", "2026-10-05", "09:00", {
        className: "IGCSE Physics", state: "would_submit", reason: "shadow", fields: FIRST_SHOT, costUsd: 0.0419,
      }),
      recent(SESSION.chaiReviewed, "Chai", "2026-10-04", "17:00", {
        className: "A-level Chemistry", postStartedAt: at("2026-10-04", "17:58"), latencyMinutes: 58, fields: FIRST_SHOT,
      }),
      recent(SESSION.benHeldRecording, "Ben", "2026-10-04", "12:00", { className: "Year 8 English", state: "held", reason: "recording_too_short", arm: null, costUsd: 0 }),
      recent(SESSION.annaHeldAbsent, "Anna", "2026-10-03", "10:00", {
        className: "IGCSE Physics", state: "held", reason: "attendance_0pct", arm: null, evidence: "summary", costUsd: 0,
      }),
      recent(SESSION.emmaHeldStale, "Emma", "2026-09-30", "09:00", { className: "Year 6 Science", state: "held", reason: "transcript_too_short", arm: null, costUsd: 0.0098 }),
    ],
    webhooks: {
      lastReceivedAt: at(FIXTURE_TODAY, "15:31"),
      byEvent: [{ eventName: "MeetingEndedEvent", count: 14 }, { eventName: "AttendanceComputedEvent", count: 13 }, { eventName: "RecordingCompletedEvent", count: 11 }],
      byOutcome: [{ outcome: "verified", count: 6 }, { outcome: "not_roster", count: 21 }, { outcome: "already_handled", count: 11 }],
    },
    ...overrides,
  };
}

type Verdict = NonNullable<ReviewQueueItem["currentVerdict"]>;

export const APPROVED: Verdict = {
  id: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa", verdict: "approve", severity: null, criticalCategory: null, note: null, reviewer: "owner@example.com",
  source: "dashboard", downgradedFrom: null, createdAt: at("2026-10-05", "20:00"), current: true,
};
export const MAJOR: Verdict = { ...APPROVED, id: "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb", verdict: "needs_fix", severity: "factual" };
export const CRITICAL: Verdict = {
  ...APPROVED, id: "cccccccc-cccc-4ccc-8ccc-cccccccccccc", verdict: "needs_fix", severity: "critical", criticalCategory: "wrong_person",
  note: "Another student's work was described.", createdAt: at("2026-09-29", "17:42"),
};
export const FLAG_ID = "dddddddd-dddd-4ddd-8ddd-dddddddddddd";

/** A first shot as the post log records it: written by Sol from the transcript, verified. */
export function firstShot(wiseSessionId: string, postedAt: string, patch: Partial<ReviewQueueItem["firstShot"]> = {}): ReviewQueueItem["firstShot"] {
  return {
    postId: `post-${wiseSessionId}`, fields: FIRST_SHOT, fieldsSha256: "a".repeat(64), provenance: "snapshot", method: null,
    postStartedAt: postedAt, arm: "sol", evidence: "transcript", outcome: "verified", problems: [], ...patch,
  };
}

/** One posted class of the review queue: unreviewed, unchanged since its first shot. */
export function queueItem(wiseSessionId: string, tutorKey: string, date: string, time: string, patch: Partial<ReviewQueueItem> = {}): ReviewQueueItem {
  return {
    wiseSessionId,
    wiseUrl: wiseUrl(wiseSessionId),
    className: "Year 9 Maths",
    tutor: tutorKey,
    tutorKey,
    classEndedAt: at(date, time),
    bangkokDate: date,
    inclusionReason: "new_tutor",
    required: true,
    status: "needs_review",
    openFlags: [],
    firstShot: firstShot(wiseSessionId, at(date, time)),
    current: { fields: FIRST_SHOT, source: "first_shot", at: at(date, time) },
    changed: false,
    diff: [],
    corrections: [],
    fixEvents: [{ wiseEventId: `event-${wiseSessionId}`, at: at(date, time), actorKind: "autowriter_first", countsAsFix: false, counted: false }],
    measuredFixCount: 0,
    measuredFixesByActor: {},
    verdicts: [],
    currentVerdict: null,
    ...patch,
  };
}

/** A post a correction changed after it went out: the diff, the measured fix and the correction's record. */
export function correctedQueueItem(patch: Partial<ReviewQueueItem> = {}): ReviewQueueItem {
  const base = queueItem(SESSION.benFlagged, "Ben", "2026-10-05", "15:00");
  return {
    ...base,
    className: "Year 8 English",
    firstShot: firstShot(SESSION.benFlagged, at("2026-10-05", "18:06"), { provenance: "backfill", method: "pc_first_version", arm: "luna", evidence: "summary" }),
    current: { fields: CORRECTED, source: "correction", at: at("2026-10-05", "21:26") },
    changed: true,
    diff: [{ field: "performance", segments: [
      { kind: "same", text: "Finished " }, { kind: "removed", text: "all" }, { kind: "added", text: "six of the" },
      { kind: "same", text: " eight questions on rotation and explained each step aloud." },
    ] }],
    corrections: [{
      kind: "correction", actor: "script:correct-posts (owner@example.com)", reason: "made-up correction", outcome: "verified",
      at: at("2026-10-05", "21:26"), provenance: "backfill",
    }],
    fixEvents: [
      { wiseEventId: "e1", at: at("2026-10-05", "18:06"), actorKind: "autowriter_first", countsAsFix: false, counted: false },
      { wiseEventId: "e2", at: at("2026-10-05", "21:26"), actorKind: "autowriter_correction", countsAsFix: true, counted: true },
      { wiseEventId: "e3", at: at("2026-10-06", "09:10"), actorKind: "other_staff", countsAsFix: true, counted: false },
    ],
    measuredFixCount: 1,
    measuredFixesByActor: { autowriter_correction: 1 },
    ...patch,
  };
}

/** The 14 days of the gate window, oldest first: what the rail's charts and the quality table read. */
const WINDOW_DATES = Array.from({ length: 14 }, (_, index) => addDays("2026-09-23", index));
const REVIEWED = [3, 4, 3, 4, 4, 4, 4, 3, 4, 4, 4, 4, 4, 2];
const ACCURATE = [3, 3, 3, 4, 4, 4, 2, 3, 4, 3, 4, 4, 4, 1];
const CRITICAL_VERDICTS = [0, 0, 0, 0, 0, 0, 1, 0, 0, 0, 0, 0, 0, 0];
const POSTED = [5, 6, 5, 7, 6, 6, 5, 6, 7, 6, 7, 6, 7, 7];
const ELIGIBLE = [8, 8, 7, 8, 8, 8, 8, 8, 9, 8, 8, 8, 8, 8];
const FROM_TRANSCRIPT = [2, 3, 2, 5, 4, 3, 3, 4, 5, 4, 5, 4, 5, 5];
const BY_LUNA = [1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 0, 0];
const BY_GLM = [1, 1, 1, 1, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0];
const MINUTES_TO_POST = [14.2, 12.6, 16.4, 11.2, 11.8, 13.8, 17.5, 11.1, 9.7, 11.8, 10.2, 9.3, 10.5, 11.1];
const COST_PER_CLASS = [0.041, 0.039, 0.044, 0.037, 0.038, 0.036, 0.047, 0.035, 0.033, 0.034, 0.036, 0.035, 0.034, 0.033];
const WILSON_14D = [0.68, 0.69, 0.685, 0.705, 0.715, 0.73, 0.685, 0.7, 0.715, 0.725, 0.745, 0.76, 0.775, 0.7903];

const sum = (values: readonly number[]) => values.reduce((total, value) => total + value, 0);

export function reviewFixture(overrides: Partial<AutowriterReview> = {}): AutowriterReview {
  const critical = queueItem(SESSION.benCritical, "Ben", "2026-09-29", "16:00", {
    className: "Year 8 English", status: "reviewed", currentVerdict: CRITICAL, verdicts: [CRITICAL],
    firstShot: firstShot(SESSION.benCritical, at("2026-09-29", "16:04"), { arm: "glm", evidence: "summary" }),
  });
  const flagged = correctedQueueItem({
    status: "flagged", currentVerdict: APPROVED, verdicts: [APPROVED],
    openFlags: [{ id: FLAG_ID, source: "measured_fix", note: "Saved again in Wise after the approval", suggestedSeverity: null, suggestedCategory: null, createdAt: at("2026-10-06", "09:10") }],
  });
  const queue = [
    queueItem(SESSION.annaToReview, "Anna", FIXTURE_TODAY, "13:00", { firstShot: firstShot(SESSION.annaToReview, at(FIXTURE_TODAY, "14:12")) }),
    queueItem(SESSION.benToReview, "Ben", FIXTURE_TODAY, "11:00", {
      className: "Year 8 English", firstShot: firstShot(SESSION.benToReview, at(FIXTURE_TODAY, "11:03"), { arm: "luna", evidence: "summary" }),
    }),
    queueItem(SESSION.chaiToReview, "Chai", "2026-10-05", "18:00", {
      className: "A-level Chemistry", firstShot: firstShot(SESSION.chaiToReview, at("2026-10-05", "19:16")),
    }),
    flagged,
    queueItem(SESSION.chaiReviewed, "Chai", "2026-10-04", "17:00", { className: "A-level Chemistry", status: "reviewed", currentVerdict: APPROVED, verdicts: [APPROVED] }),
    queueItem(SESSION.annaReviewed, "Anna", "2026-10-02", "11:00", { status: "reviewed", currentVerdict: APPROVED, verdicts: [APPROVED] }),
    critical,
  ];
  return {
    available: true,
    generatedAt: FIXTURE_NOW,
    window: { start: WINDOW_DATES[0], end: FIXTURE_TODAY, days: 14 },
    gate: {
      status: "blocked_critical", wilsonLower: 0.7903, coverage: 86 / 112,
      reasons: ["1 critical verdict(s) in the window", "accuracy lower bound 79% < 80% (46/51)", "1 flagged post(s) waiting for review", "3 required post(s) not yet reviewed"],
      reviewed: 51, accurate: 46, criticalVerdicts: 1, unresolvedCriticalFlags: 0, pendingFlaggedReviews: 1, requiredPending: 3,
      unrecordedPosts: 0, unexplainedApiWrites: 0, coverageNum: 86, coverageDen: 112,
      thresholds: { passLowerBound: 0.8, headStartLowerBound: 0.7, minCoverage: 0.7 },
      lastDaily: { date: "2026-10-05", status: "blocked_critical", wilsonLower: 0.775, createdAt: at("2026-10-05", "22:27") },
      currentTutors: 5, nextExpansionSize: 8, blockedUntil: "2026-10-13",
    },
    coverage: {
      posted: 86, miss_held: 9, miss_late: 6, miss_expired: 8, miss_failed: 2, miss_unseen: 1, excluded_tutor_first: 14,
      excluded_data_quality: 5, excluded_tutor_off: 2, excluded_not_live: 0, excluded_scope: 17, pending: 3,
    },
    fixRounds: { zero: 38, one: 6, two: 2, threePlus: 0, unresolved: 8 },
    daily: WINDOW_DATES.map((date, index) => ({
      date, liveMode: true, posted: POSTED[index], required: REVIEWED[index] + (index === 13 ? 2 : index === 12 ? 1 : 0), reviewed: REVIEWED[index],
      requiredPending: index === 13 ? 2 : index === 12 ? 1 : 0, accurate: ACCURATE[index], cosmetic: index % 4 === 0 ? 1 : 0,
      factual: REVIEWED[index] - ACCURATE[index] - CRITICAL_VERDICTS[index], critical: CRITICAL_VERDICTS[index], eligible: ELIGIBLE[index],
      coverage: POSTED[index] / ELIGIBLE[index], measuredFixClasses: REVIEWED[index] - ACCURATE[index], correctionsVerified: REVIEWED[index] - ACCURATE[index],
    })).toReversed(),
    // The pilot's first class was on the window's first date: nothing before it.
    lookback: [],
    tutors: [
      { tutorKey: "Anna", displayName: "Anna", phase: "full_review", textsInWise: 21, reviewed: 20, accurate: 19, critical: 0, wilsonLower: 0.7639, requiredPending: 1, coverage: 33 / 39, coverageNum: 33, coverageDen: 39, measuredFixClasses: 2 },
      { tutorKey: "Ben", displayName: "Ben", phase: "full_review", textsInWise: 19, reviewed: 17, accurate: 14, critical: 1, wilsonLower: 0.5897, requiredPending: 1, coverage: 26 / 38, coverageNum: 26, coverageDen: 38, measuredFixClasses: 4 },
      { tutorKey: "Chai", displayName: "Chai", phase: "full_review", textsInWise: 15, reviewed: 14, accurate: 13, critical: 0, wilsonLower: 0.6853, requiredPending: 1, coverage: 27 / 35, coverageNum: 27, coverageDen: 35, measuredFixClasses: 1 },
      { tutorKey: "Dao", displayName: "Dao", phase: "full_review", textsInWise: 0, reviewed: 0, accurate: 0, critical: 0, wilsonLower: 0, requiredPending: 0, coverage: null, coverageNum: 0, coverageDen: 0, measuredFixClasses: 0 },
      { tutorKey: "Emma", displayName: "Emma", phase: "full_review", textsInWise: 0, reviewed: 0, accurate: 0, critical: 0, wilsonLower: 0, requiredPending: 0, coverage: null, coverageNum: 0, coverageDen: 0, measuredFixClasses: 0 },
    ],
    queue,
    queueTotals: { needsReview: 3, flagged: 1, all: 58, shown: queue.length },
    incidents: [
      {
        id: INCIDENT.critical, kind: "critical_verdict", severity: "critical", summary: "Critical verdict: Wrong person (recorded by owner@example.com)",
        wiseSessionId: SESSION.benCritical, pushStatus: "sent", lastPushError: null, acknowledgedAt: null, acknowledgedBy: null, createdAt: at("2026-09-29", "17:42"),
      },
      {
        id: INCIDENT.acknowledged, kind: "api_actor_unmatched", severity: "critical", summary: "A feedback save by the Wise API user matches no recorded autowriter post",
        wiseSessionId: null, pushStatus: "failed", lastPushError: "email: relay down", acknowledgedAt: at("2026-09-30", "08:00"), acknowledgedBy: "owner@example.com",
        createdAt: at("2026-09-29", "23:00"),
      },
      {
        id: INCIDENT.info, kind: "first_shot_unverified", severity: "info", summary: "A first shot could not be proven against the POST body yet",
        wiseSessionId: null, pushStatus: "not_required", lastPushError: null, acknowledgedAt: null, acknowledgedBy: null, createdAt: at("2026-09-29", "16:00"),
      },
    ],
    lastRun: { status: "succeeded", startedAt: at(FIXTURE_TODAY, "15:27"), finishedAt: at(FIXTURE_TODAY, "15:27"), errorSummary: null, dailyGateSkipped: null },
    ...overrides,
  };
}

/** Σ numerators ÷ Σ denominators over an entry and the six before it (fewer at the start), as the trends pool a week. */
function pooled(numerators: readonly number[], denominators: readonly number[], index: number): number | null {
  const from = Math.max(0, index - 6);
  const denominator = sum(denominators.slice(from, index + 1));
  return denominator > 0 ? sum(numerators.slice(from, index + 1)) / denominator : null;
}

function round(value: number, digits: number): number {
  return Math.round(value * 10 ** digits) / 10 ** digits;
}

/** The 14 days of the busy fixture as the trends route returns them; a longer range starts with days without data. */
export function trendsFixture(rangeDays: TrendRangeDays = 14, overrides: Partial<AutowriterTrends> = {}): AutowriterTrends {
  const cost = POSTED.map((posted, index) => round(posted * COST_PER_CLASS[index], 4));
  const busy = WINDOW_DATES.map((date, index): TrendDay => ({
    date,
    reviewed: REVIEWED[index],
    accurate: ACCURATE[index],
    critical: CRITICAL_VERDICTS[index],
    accuracy: ACCURATE[index] / REVIEWED[index],
    accuracy7d: pooled(ACCURATE, REVIEWED, index),
    wilson14d: WILSON_14D[index],
    posted: POSTED[index],
    eligible: ELIGIBLE[index],
    coverage: POSTED[index] / ELIGIBLE[index],
    coverage7d: pooled(POSTED, ELIGIBLE, index),
    minutesToPost: MINUTES_TO_POST[index],
    minutesToPost7d: round(sum(MINUTES_TO_POST.slice(Math.max(0, index - 6), index + 1)) / Math.min(7, index + 1), 1),
    costUsd: cost[index],
    costPerClass: COST_PER_CLASS[index],
    costPerClass7d: round(pooled(cost, POSTED, index) ?? 0, 4),
    fromSummary: POSTED[index] - FROM_TRANSCRIPT[index],
    fromTranscript: FROM_TRANSCRIPT[index],
    transcriptShare7d: pooled(FROM_TRANSCRIPT, POSTED, index),
    writers: { sol: POSTED[index] - BY_LUNA[index] - BY_GLM[index], luna: BY_LUNA[index], glm: BY_GLM[index] },
  }));
  const start = addDays(FIXTURE_TODAY, -(rangeDays - 1));
  const empty = Array.from({ length: rangeDays - 14 }, (_, index): TrendDay => ({
    date: addDays(start, index), reviewed: 0, accurate: 0, critical: 0, accuracy: null, accuracy7d: null, wilson14d: null, posted: 0, eligible: 0,
    coverage: null, coverage7d: null, minutesToPost: null, minutesToPost7d: null, costUsd: 0, costPerClass: null, costPerClass7d: null, fromSummary: 0,
    fromTranscript: 0, transcriptShare7d: null, writers: { sol: 0, luna: 0, glm: 0 },
  }));
  return {
    generatedAt: FIXTURE_NOW,
    range: { start, end: FIXTURE_TODAY, days: rangeDays },
    tutorKey: "*",
    // The first date with data, whatever the range: the pilot's first class.
    since: WINDOW_DATES[0],
    days: [...empty, ...busy],
    totals: {
      reviewed: sum(REVIEWED), accurate: sum(ACCURATE), critical: 1, posted: sum(POSTED), eligible: sum(ELIGIBLE),
      medianMinutesToPost: 12.4, p90MinutesToPost: 71.5, costUsd: round(sum(cost), 4), costPerClass: round(sum(cost) / sum(POSTED), 4),
      fromSummary: sum(POSTED) - sum(FROM_TRANSCRIPT), fromTranscript: sum(FROM_TRANSCRIPT),
      writers: { sol: sum(POSTED) - sum(BY_LUNA) - sum(BY_GLM), luna: sum(BY_LUNA), glm: sum(BY_GLM) },
      holdsByCategory: { data_quality: 5, judge: 3, validation: 1, billing_or_form: 0, error: 0, other: 0 },
    },
    ...overrides,
  };
}

/** A quiet day early in the pilot: nothing to do, two days of history, not enough reviews for a gate. */
export function quietDashboardFixture(overrides: Partial<AutowriterDashboard> = {}): AutowriterDashboard {
  const kept = new Set<string>([SESSION.chaiReviewed, SESSION.annaTutorFirst, SESSION.daoWaiting]);
  return dashboardFixture({
    today: { date: FIXTURE_TODAY, posted: 3, awaitingRecording: 1, held: 0, skippedHuman: 1, skippedScope: 0 },
    holds: [],
    failedPosts: [],
    recent: dashboardFixture().recent.filter((row) => kept.has(row.wiseSessionId)),
    ...overrides,
  });
}

export function quietReviewFixture(overrides: Partial<AutowriterReview> = {}): AutowriterReview {
  const busy = reviewFixture();
  const queue = [
    queueItem(SESSION.chaiReviewed, "Chai", "2026-10-05", "17:00", { className: "A-level Chemistry", status: "reviewed", currentVerdict: APPROVED, verdicts: [APPROVED] }),
    queueItem(SESSION.annaReviewed, "Anna", "2026-10-05", "11:00", { status: "reviewed", currentVerdict: APPROVED, verdicts: [APPROVED] }),
  ];
  return reviewFixture({
    gate: {
      ...busy.gate, status: "insufficient_data", wilsonLower: 0, coverage: 5 / 6, reasons: ["no owner-reviewed posts in the window"],
      reviewed: 0, accurate: 0, criticalVerdicts: 0, pendingFlaggedReviews: 0, requiredPending: 0, coverageNum: 5, coverageDen: 6, lastDaily: null, blockedUntil: null,
    },
    coverage: { ...busy.coverage, posted: 5, miss_held: 0, miss_late: 1, miss_expired: 0, miss_failed: 0, miss_unseen: 0, excluded_tutor_first: 2, excluded_data_quality: 0, excluded_tutor_off: 0, excluded_scope: 1, pending: 1 },
    fixRounds: { zero: 2, one: 0, two: 0, threePlus: 0, unresolved: 0 },
    daily: busy.daily.slice(0, 2).map((row, index) => ({
      ...row, posted: index === 0 ? 3 : 2, eligible: 3, coverage: index === 0 ? 1 : 2 / 3, required: 0, reviewed: 0, requiredPending: 0, accurate: 0,
      cosmetic: 0, factual: 0, critical: 0, measuredFixClasses: 0, correctionsVerified: 0,
    })),
    tutors: busy.tutors.map((tutor) => ({
      ...tutor, textsInWise: tutor.tutorKey === "Anna" || tutor.tutorKey === "Chai" ? 1 : 0, reviewed: 0, accurate: 0, critical: 0, wilsonLower: 0, requiredPending: 0,
      coverage: null, coverageNum: 0, coverageDen: 0, measuredFixClasses: 0,
    })),
    queue,
    queueTotals: { needsReview: 0, flagged: 0, all: 2, shown: 2 },
    incidents: [],
    ...overrides,
  });
}

/** Two days of history in a 14-day range: the charts start on 5 October. */
export function shortHistoryTrendsFixture(): AutowriterTrends {
  const full = trendsFixture();
  const days = full.days.map((day, index): TrendDay => index >= 12 ? {
    ...day, reviewed: 0, accurate: 0, critical: 0, accuracy: null, accuracy7d: null, wilson14d: null,
    posted: index === 12 ? 2 : 3, eligible: 3, coverage: index === 12 ? 2 / 3 : 1, coverage7d: index === 12 ? 2 / 3 : 5 / 6,
    fromSummary: 1, fromTranscript: index === 12 ? 1 : 2, transcriptShare7d: index === 12 ? 0.5 : 0.6, writers: { sol: index === 12 ? 2 : 3, luna: 0, glm: 0 },
    minutesToPost7d: day.minutesToPost, costPerClass7d: day.costPerClass, costUsd: round((index === 12 ? 2 : 3) * (day.costPerClass ?? 0), 4),
  } : {
    ...day, reviewed: 0, accurate: 0, critical: 0, accuracy: null, accuracy7d: null, wilson14d: null, posted: 0, eligible: 0, coverage: null, coverage7d: null,
    minutesToPost: null, minutesToPost7d: null, costUsd: 0, costPerClass: null, costPerClass7d: null, fromSummary: 0, fromTranscript: 0, transcriptShare7d: null,
    writers: { sol: 0, luna: 0, glm: 0 },
  });
  return {
    ...full,
    since: "2026-10-05",
    days,
    totals: {
      reviewed: 0, accurate: 0, critical: 0, posted: 5, eligible: 6, medianMinutesToPost: 10.5, p90MinutesToPost: 11.1, costUsd: 0.167, costPerClass: 0.0334,
      fromSummary: 2, fromTranscript: 3, writers: { sol: 5, luna: 0, glm: 0 },
      holdsByCategory: { data_quality: 0, judge: 0, validation: 0, billing_or_form: 0, error: 0, other: 0 },
    },
  };
}
