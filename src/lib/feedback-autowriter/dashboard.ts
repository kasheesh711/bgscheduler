import { and, desc, eq, gte, sql } from "drizzle-orm";
import type { Database } from "@/lib/db";
import * as schema from "@/lib/db/schema";
import type { FeedbackFieldAnswers } from "@/lib/post-class-feedback/types";
import { wiseSessionLink } from "@/lib/wise/links";
import { AUTOWRITER_MAX_TRANSCRIBE_ERRORS, AUTOWRITER_MAX_WRITER_ERRORS, AUTOWRITER_TRANSCRIPT_FIRST_FALLBACK_MS, writersFor } from "./config";
import { HOLD_LISTED_AFTER_DEADLINE_MS } from "./inbox";
import { judgeProblems } from "./judge";
import { tutorKeyFor } from "./review-job";
import { AUTOWRITER_TUTORS, rosterTutor, tutorLabel } from "./roster";
import { readControl, sessionClassNameSql, type AutowriterSessionRow } from "./store";
import { buildSystemStatus, type AutowriterSystemStatus } from "./system-status";
import { SUMMARY_FALLBACK_CAUSES, type SummaryFallbackCause } from "./types";
import { readNoShow } from "./no-show";

const S = schema.feedbackAutowriterSessions;
const CALLS = schema.feedbackAutowriterCalls;
const PC = schema.postClassSessions;
const PCV = schema.postClassFeedbackVersions;

export const DASHBOARD_WINDOWS = [1, 7, 30] as const;
export type DashboardWindowDays = (typeof DASHBOARD_WINDOWS)[number];

export interface DashboardCallRow {
  wiseSessionId: string;
  role: "writer" | "judge" | "transcriber";
  arm: "glm" | "luna" | "sol" | "soniox";
  requestedModel: string;
  ok: boolean;
  costUsd: number;
  createdAt: Date;
  result: Record<string, unknown> | null;
}

export interface DashboardSessionRow extends Pick<AutowriterSessionRow,
  "wiseSessionId" | "wiseClassId" | "wiseTeacherUserId" | "scheduledEndAt" | "deadlineAt" | "state" | "reason" |
  "arm" | "postStartedAt" | "fields" | "metadata" | "createdAt" | "updatedAt" | "evidence"> {
  className: string | null;
}

/** A class in state `held`, whatever its age: what the Held group of the to-do list shows. */
export interface DashboardHoldRow extends Pick<AutowriterSessionRow,
  "wiseSessionId" | "wiseClassId" | "wiseTeacherUserId" | "scheduledEndAt" | "deadlineAt" | "reason" | "alertsSent"> {
  className: string | null;
  /** The row stores a judged draft (`fields`). */
  hasDraft: boolean;
  /** The class's teacher feedback in Wise holds text now, a person's (`loadHeldClassesAPersonWrote`). */
  personWrote: boolean;
  /** `metadata.noShow`, read by `readNoShow`. */
  noShow?: unknown;
}

/**
 * Held classes loaded at most. The ones that may still wait for someone come first (no deadline, or one ahead or
 * passed less than a day ago: the deadline side of `isOpenHold`), so the cap can only leave out old ones; then the
 * latest deadlines.
 */
export const DASHBOARD_HOLDS_LIMIT = 500;

export interface DashboardWebhookRow {
  eventName: string | null;
  outcome: string | null;
  receivedAt: Date;
}

const POSTED = new Set(["posting", "awaiting_event", "verified"]);
const FAILED = new Set(["rejected", "unknown_outcome", "verify_failed"]);

/** Skip reasons of an in-person class: Wise's session type, or its "In-Person/On-site Session" title. */
const ONSITE_REASONS = ["session_type_OFFLINE", "session_type_in_person_title"];

/**
 * In-person classes on a roster account are skipped at once and stay the
 * tutor's to write: they are not the autowriter's business, so the dashboard
 * leaves them out entirely (no rows, no counts).
 */
export function isOnsiteSkip(row: Pick<AutowriterSessionRow, "state" | "reason">): boolean {
  return row.state === "skipped_scope" && row.reason !== null && ONSITE_REASONS.includes(row.reason);
}

function median(values: number[]): number | null {
  if (values.length === 0) return null;
  const sorted = [...values].toSorted((a, b) => a - b);
  const middle = Math.floor(sorted.length / 2);
  return sorted.length % 2 ? sorted[middle] : (sorted[middle - 1] + sorted[middle]) / 2;
}

function percentile(values: number[], p: number): number | null {
  if (values.length === 0) return null;
  const sorted = [...values].toSorted((a, b) => a - b);
  return sorted[Math.min(sorted.length - 1, Math.ceil((p / 100) * sorted.length) - 1)];
}

function round(value: number | null, digits = 1): number | null {
  if (value === null) return null;
  const factor = 10 ** digits;
  return Math.round(value * factor) / factor;
}

function bangkokDate(date: Date): string {
  return new Intl.DateTimeFormat("en-CA", { timeZone: "Asia/Bangkok", year: "numeric", month: "2-digit", day: "2-digit" }).format(date);
}

/** Minutes from the scheduled class end to the moment the POST was claimed. */
function latencyMinutes(row: Pick<DashboardSessionRow, "scheduledEndAt" | "postStartedAt">): number | null {
  if (!row.scheduledEndAt || !row.postStartedAt) return null;
  return (row.postStartedAt.getTime() - row.scheduledEndAt.getTime()) / 60_000;
}

/** A tutor's name and the key their rows join on: the roster's, or the Wise account id of someone not on it. */
function tutorOf(wiseTeacherUserId: string | null): { tutor: string; tutorKey: string } {
  const tutor = rosterTutor(wiseTeacherUserId);
  return { tutor: tutor ? tutorLabel(tutor) : wiseTeacherUserId ?? "unknown", tutorKey: tutorKeyFor(wiseTeacherUserId) };
}

function wiseUrlOf(row: Pick<AutowriterSessionRow, "wiseClassId" | "wiseSessionId">): string | null {
  return row.wiseClassId ? wiseSessionLink({ wiseClassId: row.wiseClassId, wiseSessionId: row.wiseSessionId }) : null;
}

/** `now()::text` as Postgres prints it: "2026-09-30 03:20:05.123456+00" (the offset is the session's time zone). */
const POSTGRES_TIMESTAMP = /^(\d{4}-\d{2}-\d{2}) (\d{2}:\d{2}:\d{2}(?:\.\d+)?)([+-]\d{2})(?::?(\d{2}))?$/u;

/**
 * When an alert was emailed, from its `alerts_sent` entry (`markAlertsSent`): the send time, or null for a note such
 * as `suppressed:shadow` (the digest was deliberately not emailed) and for no entry at all.
 */
function alertSentAt(value: unknown): string | null {
  const match = typeof value === "string" ? POSTGRES_TIMESTAMP.exec(value) : null;
  if (!match) return null;
  const sent = new Date(`${match[1]}T${match[2]}${match[3]}:${match[4] ?? "00"}`);
  return Number.isNaN(sent.getTime()) ? null : sent.toISOString();
}

/** How a transcript-first class that went back to the summary is shown (`metadata.summaryFallback.cause`). */
export const SUMMARY_FALLBACK_LABELS: Record<SummaryFallbackCause, string> = {
  no_recording: `No recording after ${AUTOWRITER_TRANSCRIPT_FIRST_FALLBACK_MS / 3_600_000} h — from summary`,
  recording_multiple_parts: "Recording in several parts — from summary",
  speakers_unclear: "Speakers unclear — from summary",
  soniox_failed: `Transcription failed ${AUTOWRITER_MAX_TRANSCRIBE_ERRORS} times — from summary`,
  transcript_pass_off: "Transcript pass switched off — from summary",
  writer_failed: `Writer failed ${AUTOWRITER_MAX_WRITER_ERRORS} times on the transcript — from summary`,
};

function fallbackLabel(cause: string): string {
  return (SUMMARY_FALLBACK_CAUSES as readonly string[]).includes(cause)
    ? SUMMARY_FALLBACK_LABELS[cause as SummaryFallbackCause]
    : `${cause} — from summary`;
}

/** A row's transcript-first fallback, if it has one. */
function summaryFallback(metadata: unknown): { cause: string; label: string } | null {
  const fallback = (metadata as { summaryFallback?: { cause?: unknown } | null } | null)?.summaryFallback;
  if (!fallback || typeof fallback !== "object") return null;
  const cause = typeof fallback.cause === "string" ? fallback.cause : "unknown";
  return { cause, label: fallbackLabel(cause) };
}

/** What a posted class was written from: the transcript, the summary after a transcript-first fallback, or the summary. */
export type PostRoute = "transcript" | "summary_fallback" | "summary";
const POST_ROUTES: ReadonlyArray<{ route: PostRoute; label: string }> = [
  { route: "transcript", label: "From the transcript" },
  { route: "summary_fallback", label: "From the summary (fallback)" },
  { route: "summary", label: "From the summary" },
];

function postRoute(row: Pick<DashboardSessionRow, "evidence" | "metadata">): PostRoute {
  if (row.evidence === "transcript") return "transcript";
  return summaryFallback(row.metadata) ? "summary_fallback" : "summary";
}

export interface AutowriterDashboard {
  generatedAt: string;
  windowDays: number;
  control: {
    mode: "off" | "shadow" | "live";
    haltedAt: string | null;
    haltReason: string | null;
    disabledTutors: string[];
    updatedBy: string | null;
    updatedAt: string | null;
  };
  /** Models, versions, evidence switches and commit the autowriter runs with (the system line). */
  system: AutowriterSystemStatus;
  /** The classes that end today in Bangkok (`date`), by where they stand: the Today line. */
  today: { date: string; posted: number; awaitingRecording: number; held: number; skippedHuman: number; skippedScope: number };
  /** Every class in state `held` now (not limited to the window), soonest deadline first. */
  holds: Array<{
    wiseSessionId: string;
    tutor: string;
    /** Joins with `tutors[].tutorKey`, `QualityTutorRow.tutorKey` and `ReviewQueueItem.tutorKey`. */
    tutorKey: string;
    className: string | null;
    classEndedAt: string | null;
    deadlineAt: string | null;
    reason: string | null;
    /** When the hold's alert digest was emailed (`alerts_sent.held`); null when it was not (yet), or was suppressed. */
    alertSentAt: string | null;
    /** A judged draft is stored on the row. */
    hasDraft: boolean;
    /**
     * `tutor_wrote`: the class's teacher feedback in Wise holds text now, a person's, so it no longer waits for anyone
     * (the row stays `held`: the autowriter never touches a held class again). Null while it holds none — a form saved
     * blank, staff correcting its status or credits, or text taken out again is not a write-up.
     */
    resolvedBy: "tutor_wrote" | null;
    wiseUrl: string | null;
    /** The student never joined while the tutor waited: the standard note, ready for the owner's one click. */
    noShow?: { tutorMinutes: number; studentSeconds: number; note: FeedbackFieldAnswers } | null;
  }>;
  /** Classes of the window whose POST did not end well, latest class first. */
  failedPosts: Array<{
    wiseSessionId: string;
    tutor: string;
    tutorKey: string;
    className: string | null;
    classEndedAt: string | null;
    state: "verify_failed" | "unknown_outcome" | "rejected";
    reason: string | null;
    wiseUrl: string | null;
  }>;
  totals: {
    seen: number;
    posted: number;
    verified: number;
    awaitingEvent: number;
    shadowDrafts: number;
    /** Second pass: waiting for Wise's recording or being transcribed. */
    awaitingRecording: number;
    /** Posted drafts written from a transcript. */
    fromTranscript: number;
    held: number;
    skippedHuman: number;
    skippedScope: number;
    expired: number;
    failed: number;
    inProgress: number;
  };
  latency: {
    medianMinutes: number | null;
    p90Minutes: number | null;
    samples: number;
    /** Class end → POST claim for each evidence route, so transcript-first's wait for the recording shows on its own. */
    byRoute: Array<{ route: PostRoute; label: string; medianMinutes: number | null; p90Minutes: number | null; samples: number }>;
  };
  /** Transcript-first classes that went back to the summary in the window, by cause (most first). */
  summaryFallbacks: Array<{ cause: string; label: string; count: number }>;
  cost: {
    totalUsd: number;
    perDraftUsd: number | null;
    byModel: Array<{ model: string; role: string; calls: number; costUsd: number }>;
    byDay: Array<{ date: string; costUsd: number; drafts: number; posted: number }>;
  };
  fallbackShare: number | null;
  judgeRejections: number;
  /** One row per tutor, covering both of their Wise accounts. */
  tutors: Array<{
    tutorKey: string;
    displayName: string;
    wiseUserIds: string[];
    /** On for every account. */
    enabled: boolean;
    /** On for some accounts only (set per account from the CLI). */
    partlyEnabled: boolean;
    seen: number;
    posted: number;
    shadowDrafts: number;
    held: number;
    skippedHuman: number;
    expired: number;
    failed: number;
    medianLatencyMinutes: number | null;
    costUsd: number;
  }>;
  recent: Array<{
    wiseSessionId: string;
    wiseUrl: string | null;
    className: string | null;
    tutor: string;
    /** Joins with `tutors[].tutorKey`, `QualityTutorRow.tutorKey` and `ReviewQueueItem.tutorKey`. */
    tutorKey: string;
    scheduledEndAt: string | null;
    state: string;
    reason: string | null;
    arm: string | null;
    evidence: "summary" | "transcript";
    postStartedAt: string | null;
    latencyMinutes: number | null;
    costUsd: number;
    fields: Record<string, string> | null;
    /**
     * Every problem the stored judge verdict lists (`judgeProblems`): since v5 the union of both judge levels; a v3
     * verdict has only its unsupported quotes.
     */
    judgeUnsupported: string[];
    /** Set when transcript first sent the class back to the summary. */
    summaryFallback: { cause: string; label: string } | null;
  }>;
  webhooks: {
    lastReceivedAt: string | null;
    byEvent: Array<{ eventName: string; count: number }>;
    byOutcome: Array<{ outcome: string; count: number }>;
  };
}

/** Pure shaping so the numbers are unit-testable without a database. */
export function buildAutowriterDashboard(input: {
  now: Date;
  windowDays: number;
  control: Awaited<ReturnType<typeof readControl>>;
  system: AutowriterSystemStatus;
  sessions: readonly DashboardSessionRow[];
  /** Every class in state `held`, in or out of the window. */
  holds: readonly DashboardHoldRow[];
  calls: readonly DashboardCallRow[];
  webhooks: readonly DashboardWebhookRow[];
  recentLimit?: number;
}): AutowriterDashboard {
  const { calls } = input;
  const sessions = input.sessions.filter((row) => !isOnsiteSkip(row));
  const costBySession = new Map<string, number>();
  for (const call of calls) costBySession.set(call.wiseSessionId, (costBySession.get(call.wiseSessionId) ?? 0) + call.costUsd);
  const count = (predicate: (row: DashboardSessionRow) => boolean, rows = sessions) => rows.filter(predicate).length;
  const posted = sessions.filter((row) => POSTED.has(row.state));
  const drafts = sessions.filter((row) => POSTED.has(row.state) || row.state === "would_submit");
  const latencies = posted.map(latencyMinutes).filter((value): value is number => value !== null);
  const totalCost = calls.reduce((sum, call) => sum + call.costUsd, 0);

  const modelKey = (call: DashboardCallRow) => `${call.role}|${call.requestedModel}`;
  const byModel = new Map<string, { model: string; role: string; calls: number; costUsd: number }>();
  for (const call of calls) {
    const entry = byModel.get(modelKey(call)) ?? { model: call.requestedModel, role: call.role, calls: 0, costUsd: 0 };
    entry.calls += 1;
    entry.costUsd += call.costUsd;
    byModel.set(modelKey(call), entry);
  }

  const days = new Map<string, { date: string; costUsd: number; drafts: number; posted: number }>();
  const day = (date: string) => {
    const entry = days.get(date) ?? { date, costUsd: 0, drafts: 0, posted: 0 };
    days.set(date, entry);
    return entry;
  };
  for (const call of calls) day(bangkokDate(call.createdAt)).costUsd += call.costUsd;
  // A posted draft dates from its POST claim; a shadow draft from its last transition (would_submit rows are not touched again).
  for (const row of drafts) day(bangkokDate(row.postStartedAt ?? row.updatedAt)).drafts += 1;
  for (const row of posted) if (row.postStartedAt) day(bangkokDate(row.postStartedAt)).posted += 1;

  // Drafts the judge rejected. Since v5 two calls judge each draft (one per effort), so a draft counts once, by the
  // key its calls carry (`judgedGeneration`: the writer's generation id, or the pipeline's own key for a reply that
  // had none); an older call (no `judgedGeneration`) counts on its own.
  const judgeRejections = new Set(calls.flatMap((call, index) => call.role === "judge" && call.result?.faithful === false
    ? [`${call.wiseSessionId}|${typeof call.result.judgedGeneration === "string" ? call.result.judgedGeneration : `call-${index}`}`]
    : [])).size;
  const armed = drafts.filter((row) => row.arm);
  const today = bangkokDate(input.now);
  const endsToday = sessions.filter((row) => row.scheduledEndAt !== null && bangkokDate(row.scheduledEndAt) === today);
  const time = (value: Date | null) => value?.getTime() ?? Number.POSITIVE_INFINITY;

  return {
    generatedAt: input.now.toISOString(),
    windowDays: input.windowDays,
    control: {
      mode: input.control.mode,
      haltedAt: input.control.haltedAt?.toISOString() ?? null,
      haltReason: input.control.haltReason,
      disabledTutors: input.control.disabledTutors,
      updatedBy: input.control.updatedBy,
      updatedAt: input.control.updatedAt?.toISOString() ?? null,
    },
    system: input.system,
    today: {
      date: today,
      posted: count((row) => POSTED.has(row.state), endsToday),
      awaitingRecording: count((row) => row.state === "awaiting_recording" || row.state === "transcribing", endsToday),
      held: count((row) => row.state === "held", endsToday),
      skippedHuman: count((row) => row.state === "skipped_human", endsToday),
      skippedScope: count((row) => row.state === "skipped_scope", endsToday),
    },
    holds: input.holds
      // Soonest deadline first (one that has passed comes before one still ahead); a class without a deadline last.
      .toSorted((a, b) => time(a.deadlineAt) - time(b.deadlineAt) || time(a.scheduledEndAt) - time(b.scheduledEndAt)
        || a.wiseSessionId.localeCompare(b.wiseSessionId))
      .map((row) => ({
        wiseSessionId: row.wiseSessionId,
        ...tutorOf(row.wiseTeacherUserId),
        className: row.className,
        classEndedAt: row.scheduledEndAt?.toISOString() ?? null,
        deadlineAt: row.deadlineAt?.toISOString() ?? null,
        reason: row.reason,
        alertSentAt: alertSentAt(row.alertsSent?.held),
        hasDraft: row.hasDraft,
        resolvedBy: row.personWrote ? "tutor_wrote" as const : null,
        wiseUrl: wiseUrlOf(row),
        noShow: noShowOf(row.noShow),
      })),
    failedPosts: sessions
      .flatMap((row) => row.state === "verify_failed" || row.state === "unknown_outcome" || row.state === "rejected" ? [{ row, state: row.state }] : [])
      .toSorted((a, b) => (b.row.scheduledEndAt?.getTime() ?? 0) - (a.row.scheduledEndAt?.getTime() ?? 0))
      .map(({ row, state }) => ({
        wiseSessionId: row.wiseSessionId,
        ...tutorOf(row.wiseTeacherUserId),
        className: row.className,
        classEndedAt: row.scheduledEndAt?.toISOString() ?? null,
        state,
        reason: row.reason,
        wiseUrl: wiseUrlOf(row),
      })),
    totals: {
      seen: sessions.length,
      posted: posted.length,
      verified: count((row) => row.state === "verified"),
      awaitingEvent: count((row) => row.state === "awaiting_event" || row.state === "posting"),
      shadowDrafts: count((row) => row.state === "would_submit"),
      awaitingRecording: count((row) => row.state === "awaiting_recording" || row.state === "transcribing"),
      fromTranscript: count((row) => POSTED.has(row.state) && row.evidence === "transcript"),
      held: count((row) => row.state === "held"),
      skippedHuman: count((row) => row.state === "skipped_human"),
      skippedScope: count((row) => row.state === "skipped_scope"),
      expired: count((row) => row.state === "expired"),
      failed: count((row) => FAILED.has(row.state)),
      inProgress: count((row) => row.state === "pending" || row.state === "generating"),
    },
    latency: {
      medianMinutes: round(median(latencies)),
      p90Minutes: round(percentile(latencies, 90)),
      samples: latencies.length,
      byRoute: POST_ROUTES.map(({ route, label }) => {
        const values = posted.filter((row) => postRoute(row) === route).map(latencyMinutes)
          .filter((value): value is number => value !== null);
        return { route, label, medianMinutes: round(median(values)), p90Minutes: round(percentile(values, 90)), samples: values.length };
      }),
    },
    summaryFallbacks: tallyBy(sessions.flatMap((row) => summaryFallback(row.metadata) ?? []), (fallback) => fallback.cause)
      .map(([cause, count]) => ({ cause, label: fallbackLabel(cause), count })),
    cost: {
      totalUsd: round(totalCost, 4) ?? 0,
      perDraftUsd: drafts.length > 0 ? round(totalCost / drafts.length, 4) : null,
      byModel: [...byModel.values()].map((entry) => ({ ...entry, costUsd: round(entry.costUsd, 4) ?? 0 }))
        .toSorted((a, b) => b.costUsd - a.costUsd),
      byDay: [...days.values()].map((entry) => ({ ...entry, costUsd: round(entry.costUsd, 4) ?? 0 }))
        .toSorted((a, b) => a.date.localeCompare(b.date)),
    },
    // A draft from the tutor's fallback writer: Luna, or Sol for the tutors added on 2 Oct (Luna first for them).
    fallbackShare: armed.length > 0
      ? round(armed.filter((row) => row.arm === writersFor(rosterTutor(row.wiseTeacherUserId)?.canonicalKey)[1].arm).length / armed.length, 3)
      : null,
    judgeRejections,
    tutors: AUTOWRITER_TUTORS.map((tutor) => {
      const accounts = new Set(tutor.wiseUserIds);
      const rows = sessions.filter((row) => row.wiseTeacherUserId !== null && accounts.has(row.wiseTeacherUserId));
      const tutorPosted = rows.filter((row) => POSTED.has(row.state));
      const accountsOn = tutor.wiseUserIds.filter((id) => !input.control.disabledTutors.includes(id)).length;
      return {
        tutorKey: tutor.canonicalKey,
        displayName: tutor.label,
        wiseUserIds: [...tutor.wiseUserIds],
        enabled: accountsOn === tutor.wiseUserIds.length,
        partlyEnabled: accountsOn > 0 && accountsOn < tutor.wiseUserIds.length,
        seen: rows.length,
        posted: tutorPosted.length,
        shadowDrafts: count((row) => row.state === "would_submit", rows),
        held: count((row) => row.state === "held", rows),
        skippedHuman: count((row) => row.state === "skipped_human", rows),
        expired: count((row) => row.state === "expired", rows),
        failed: count((row) => FAILED.has(row.state), rows),
        medianLatencyMinutes: round(median(tutorPosted.map(latencyMinutes).filter((value): value is number => value !== null))),
        costUsd: round(rows.reduce((sum, row) => sum + (costBySession.get(row.wiseSessionId) ?? 0), 0), 4) ?? 0,
      };
    }),
    recent: [...sessions]
      .toSorted((a, b) => (b.scheduledEndAt?.getTime() ?? 0) - (a.scheduledEndAt?.getTime() ?? 0))
      .slice(0, input.recentLimit ?? 60)
      .map((row) => {
        return {
          wiseSessionId: row.wiseSessionId,
          wiseUrl: wiseUrlOf(row),
          className: row.className,
          ...tutorOf(row.wiseTeacherUserId),
          scheduledEndAt: row.scheduledEndAt?.toISOString() ?? null,
          state: row.state,
          reason: row.reason,
          arm: row.arm,
          evidence: row.evidence,
          postStartedAt: row.postStartedAt?.toISOString() ?? null,
          latencyMinutes: round(latencyMinutes(row)),
          costUsd: round(costBySession.get(row.wiseSessionId) ?? 0, 4) ?? 0,
          fields: row.fields,
          judgeUnsupported: storedJudgeProblems(row.metadata),
          summaryFallback: summaryFallback(row.metadata),
        };
      }),
    webhooks: {
      lastReceivedAt: input.webhooks.length > 0
        ? input.webhooks.reduce((latest, row) => row.receivedAt > latest ? row.receivedAt : latest, input.webhooks[0].receivedAt).toISOString()
        : null,
      byEvent: tallyBy(input.webhooks, (row) => row.eventName ?? "unparsed").map(([eventName, count]) => ({ eventName, count })),
      byOutcome: tallyBy(input.webhooks, (row) => (row.outcome ?? "not processed").split(":")[0]).map(([outcome, count]) => ({ outcome, count })),
    },
  };
}

function strings(value: unknown): string[] {
  return Array.isArray(value) ? value.filter((item): item is string => typeof item === "string") : [];
}

/**
 * A stored verdict of any version: v5 holds the union of both judge levels at its top level (read here) next to each
 * level's own lists, v4 lists all three kinds, v3 (`{ faithful, unsupported }`) only unsupported claims.
 */
function storedJudgeProblems(metadata: unknown): string[] {
  const judge = (metadata as { judge?: Record<string, unknown> | null } | null)?.judge;
  if (!judge || typeof judge !== "object") return [];
  return judgeProblems({
    unsupported: strings(judge.unsupported),
    misattributed: strings(judge.misattributed),
    homeworkNotSet: strings(judge.homeworkNotSet),
  });
}

function tallyBy<T>(rows: readonly T[], key: (row: T) => string): Array<[string, number]> {
  const counts = new Map<string, number>();
  for (const row of rows) counts.set(key(row), (counts.get(key(row)) ?? 0) + 1);
  return [...counts.entries()].toSorted((a, b) => b[1] - a[1]);
}

/**
 * The held classes a person has written since: those whose teacher feedback in Wise holds text now, as the Class
 * Feedback collection last read it (`post_class_sessions.latest_feedback_version_id`: on every read it points at the
 * class's current teacher submission when its topics, performance or improvement hold text, and at nothing
 * otherwise; the collection runs every half hour and takes a class with a new save first). The autowriter never
 * posts to a held class, so that text is a person's.
 *
 * Two weaker signals were tried and dropped, both able to take a class off the to-do list with no feedback in Wise:
 * - a person's save (the fix events): staff correcting the status or the credits of a class held for its billing, and
 *   a form submitted blank, are saves too;
 * - the version observed last (`observed_at`): a version is stored once per content, first seen, so text written and
 *   then taken out again stays the "latest" one.
 * The price is a hold someone settled without writing (a student marked absent, or homework alone): it stays listed
 * until a day after its deadline.
 */
function noShowOf(value: unknown): AutowriterDashboard["holds"][number]["noShow"] {
  const facts = readNoShow({ noShow: value });
  return facts ? { tutorMinutes: facts.tutorMinutes, studentSeconds: facts.studentSeconds, note: facts.note } : null;
}

async function loadHeldClassesAPersonWrote(db: Database): Promise<Set<string>> {
  const rows = await db.select({ wiseSessionId: S.wiseSessionId }).from(S)
    .innerJoin(PC, eq(PC.wiseSessionId, S.wiseSessionId))
    .innerJoin(PCV, eq(PCV.id, PC.latestFeedbackVersionId))
    .where(and(eq(S.state, "held"), eq(PCV.profile, "teacher")));
  return new Set(rows.map((row) => row.wiseSessionId));
}

/** Read-only loader for the page and its API route. `holdsLimit` defaults to `DASHBOARD_HOLDS_LIMIT` (tests set a small one). */
export async function loadAutowriterDashboard(
  db: Database,
  input: { windowDays: number; now?: Date; holdsLimit?: number },
): Promise<AutowriterDashboard> {
  const now = input.now ?? new Date();
  const since = new Date(now.getTime() - input.windowDays * 24 * 60 * 60 * 1000);
  const webhookSince = new Date(now.getTime() - 24 * 60 * 60 * 1000);
  // A deadline after this may still be listed as waiting (`isOpenHold`).
  const holdsOpenAfter = new Date(now.getTime() - HOLD_LISTED_AFTER_DEADLINE_MS);
  const [control, sessionRows, holdRows, personWrote, callRows, webhookRows] = await Promise.all([
    readControl(db),
    db.select({
      wiseSessionId: S.wiseSessionId,
      wiseClassId: S.wiseClassId,
      wiseTeacherUserId: S.wiseTeacherUserId,
      scheduledEndAt: S.scheduledEndAt,
      deadlineAt: S.deadlineAt,
      state: S.state,
      reason: S.reason,
      arm: S.arm,
      evidence: S.evidence,
      postStartedAt: S.postStartedAt,
      fields: S.fields,
      metadata: S.metadata,
      createdAt: S.createdAt,
      updatedAt: S.updatedAt,
      className: sessionClassNameSql,
    }).from(S)
      .leftJoin(schema.postClassSessions, eq(schema.postClassSessions.wiseSessionId, S.wiseSessionId))
      // In-person classes never reach the page (see isOnsiteSkip); a NULL reason is kept.
      .where(and(gte(S.createdAt, since), sql`not (${S.state} = 'skipped_scope' and coalesce(${S.reason}, '') in (${sql.join(ONSITE_REASONS.map((reason) => sql`${reason}`), sql`, `)}))`))
      .orderBy(desc(S.scheduledEndAt))
      .limit(2_000),
    // Every held class, whatever its age (up to the cap, the ones that may still wait first): it stays on the to-do
    // list until someone deals with it.
    db.select({
      wiseSessionId: S.wiseSessionId,
      wiseClassId: S.wiseClassId,
      wiseTeacherUserId: S.wiseTeacherUserId,
      scheduledEndAt: S.scheduledEndAt,
      deadlineAt: S.deadlineAt,
      reason: S.reason,
      alertsSent: S.alertsSent,
      hasDraft: sql<boolean>`${S.fields} is not null`,
      noShow: sql<unknown>`${S.metadata}->'noShow'`,
      className: sessionClassNameSql,
    }).from(S)
      .leftJoin(schema.postClassSessions, eq(schema.postClassSessions.wiseSessionId, S.wiseSessionId))
      .where(eq(S.state, "held"))
      // Open holds first, soonest deadline first (a hold with no deadline stays open, so it leads); past the cap it is
      // the least urgent open holds that are cut, then the settled ones by latest deadline.
      .orderBy(
        sql`(${S.deadlineAt} is null or ${S.deadlineAt} > ${holdsOpenAfter}) desc`,
        sql`case when ${S.deadlineAt} is null or ${S.deadlineAt} > ${holdsOpenAfter} then ${S.deadlineAt} end asc nulls first`,
        sql`${S.deadlineAt} desc nulls first`,
      )
      .limit(input.holdsLimit ?? DASHBOARD_HOLDS_LIMIT),
    loadHeldClassesAPersonWrote(db),
    db.select({
      wiseSessionId: CALLS.wiseSessionId,
      role: CALLS.role,
      arm: CALLS.arm,
      requestedModel: CALLS.requestedModel,
      ok: CALLS.ok,
      costUsd: sql<string | null>`${CALLS.costUsd}`,
      createdAt: CALLS.createdAt,
      result: CALLS.result,
    }).from(CALLS).where(gte(CALLS.createdAt, since)).limit(10_000),
    db.select({
      eventName: schema.wiseWebhookEvents.eventName,
      outcome: schema.wiseWebhookEvents.outcome,
      receivedAt: schema.wiseWebhookEvents.receivedAt,
    }).from(schema.wiseWebhookEvents).where(and(gte(schema.wiseWebhookEvents.receivedAt, webhookSince))).limit(10_000),
  ]);
  return buildAutowriterDashboard({
    now,
    windowDays: input.windowDays,
    control,
    system: buildSystemStatus(),
    sessions: sessionRows,
    holds: holdRows.map((row) => ({ ...row, hasDraft: row.hasDraft === true, personWrote: personWrote.has(row.wiseSessionId) })),
    calls: callRows.map((row) => ({ ...row, costUsd: Number(row.costUsd ?? 0) || 0 })),
    webhooks: webhookRows,
  });
}
