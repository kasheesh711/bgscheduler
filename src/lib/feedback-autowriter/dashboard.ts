import { and, desc, eq, gte, sql } from "drizzle-orm";
import type { Database } from "@/lib/db";
import * as schema from "@/lib/db/schema";
import { wiseSessionLink } from "@/lib/wise/links";
import { judgeProblems } from "./judge";
import { AUTOWRITER_TUTORS, rosterTutor, tutorLabel } from "./roster";
import { readControl, type AutowriterSessionRow } from "./store";

const S = schema.feedbackAutowriterSessions;
const CALLS = schema.feedbackAutowriterCalls;

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
  latency: { medianMinutes: number | null; p90Minutes: number | null; samples: number };
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
    scheduledEndAt: string | null;
    state: string;
    reason: string | null;
    arm: string | null;
    evidence: "summary" | "transcript";
    postStartedAt: string | null;
    latencyMinutes: number | null;
    costUsd: number;
    fields: Record<string, string> | null;
    /** Every problem the stored judge verdict lists (`judgeProblems`); a v3 verdict has only its unsupported quotes. */
    judgeUnsupported: string[];
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
  sessions: readonly DashboardSessionRow[];
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

  const judgeRejections = calls.filter((call) => call.role === "judge" && call.result?.faithful === false).length;
  const armed = drafts.filter((row) => row.arm);

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
    latency: { medianMinutes: round(median(latencies)), p90Minutes: round(percentile(latencies, 90)), samples: latencies.length },
    cost: {
      totalUsd: round(totalCost, 4) ?? 0,
      perDraftUsd: drafts.length > 0 ? round(totalCost / drafts.length, 4) : null,
      byModel: [...byModel.values()].map((entry) => ({ ...entry, costUsd: round(entry.costUsd, 4) ?? 0 }))
        .toSorted((a, b) => b.costUsd - a.costUsd),
      byDay: [...days.values()].map((entry) => ({ ...entry, costUsd: round(entry.costUsd, 4) ?? 0 }))
        .toSorted((a, b) => a.date.localeCompare(b.date)),
    },
    fallbackShare: armed.length > 0 ? round(armed.filter((row) => row.arm === "luna").length / armed.length, 3) : null,
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
          wiseUrl: row.wiseClassId ? wiseSessionLink({ wiseClassId: row.wiseClassId, wiseSessionId: row.wiseSessionId }) : null,
          className: row.className,
          tutor: (() => {
            const tutor = rosterTutor(row.wiseTeacherUserId);
            return tutor ? tutorLabel(tutor) : row.wiseTeacherUserId ?? "unknown";
          })(),
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

/** A stored verdict of any version: v4 lists all three kinds, v3 (`{ faithful, unsupported }`) only unsupported claims. */
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

/** Read-only loader for the page and its API route. */
export async function loadAutowriterDashboard(db: Database, input: { windowDays: number; now?: Date }): Promise<AutowriterDashboard> {
  const now = input.now ?? new Date();
  const since = new Date(now.getTime() - input.windowDays * 24 * 60 * 60 * 1000);
  const webhookSince = new Date(now.getTime() - 24 * 60 * 60 * 1000);
  const [control, sessionRows, callRows, webhookRows] = await Promise.all([
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
      className: schema.postClassSessions.className,
    }).from(S)
      .leftJoin(schema.postClassSessions, eq(schema.postClassSessions.wiseSessionId, S.wiseSessionId))
      // In-person classes never reach the page (see isOnsiteSkip); a NULL reason is kept.
      .where(and(gte(S.createdAt, since), sql`not (${S.state} = 'skipped_scope' and coalesce(${S.reason}, '') in (${sql.join(ONSITE_REASONS.map((reason) => sql`${reason}`), sql`, `)}))`))
      .orderBy(desc(S.scheduledEndAt))
      .limit(2_000),
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
    sessions: sessionRows,
    calls: callRows.map((row) => ({ ...row, costUsd: Number(row.costUsd ?? 0) || 0 })),
    webhooks: webhookRows,
  });
}
