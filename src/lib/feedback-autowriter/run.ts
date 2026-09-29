import fs from "node:fs";
import path from "node:path";
import { and, desc, eq, gt, gte, inArray, isNotNull, isNull, lt, notInArray, or } from "drizzle-orm";
import { z } from "zod";
import type { Database } from "@/lib/db";
import * as schema from "@/lib/db/schema";
import type { PriorFeedbackComparison } from "@/lib/post-class-feedback/similarity";
import {
  POST_CLASS_FEEDBACK_FIELDS,
  type FeedbackFieldAnswers,
  type FeedbackFieldMapping,
} from "@/lib/post-class-feedback/types";
import { DEFAULT_FEEDBACK_FIELD_MAPPINGS } from "@/lib/post-class-feedback/wise";
import { WiseClient } from "@/lib/wise/client";
import { resolveBilling } from "./billing";
import { callOpenRouter, type OpenRouterCallResult } from "./openrouter";
import {
  FEEDBACK_JSON_SCHEMA,
  PROMPT_VERSION,
  buildFeedbackMessages,
  chooseStudentDisplayName,
  redactForModel,
} from "./prompt";
import {
  classifyTeacherSubmission,
  detailClassId,
  evaluateSessionGates,
  extractAiSummary,
  parseAutowriterSessionDetail,
  planFeedbackForm,
  scheduledWindow,
  studentParticipants,
} from "./session";
import type { WiseFeedbackOps } from "./submit";
import { AUTOWRITER_MODELS, AUTOWRITER_WISE_READ_TIMEOUT_MS, type AutowriterModelConfig } from "./config";
import {
  AUTOWRITER_DEADLINE_MARGIN_MS,
  AUTOWRITER_MIN_SUMMARY_CHARACTERS,
  type AiSummary,
  type BillingPlan,
  type GateInput,
  type ModelArm,
  type SubmissionState,
} from "./types";
import { finalizeFields, parseModelOutput, validateFeedbackDraft, type ModelOutput } from "./validate";

/** Per-run artifacts (drafts, grading export). Durable state lives in `autowriterStateDir()`. */
export const AUTOWRITER_ROOT = ".feedback-autowriter";
const OBJECT_ID = /^[0-9a-f]{24}$/iu;

function checkedId(value: string): string {
  if (!OBJECT_ID.test(value)) throw new Error("Wise path id is not an object id");
  return value;
}

// ---------------------------------------------------------------------------
// Database reads (read-only)
// ---------------------------------------------------------------------------

export interface SessionRow {
  wiseSessionId: string;
  wiseClassId: string;
  className: string | null;
  scheduledStartAt: Date;
  scheduledEndAt: Date;
}

/** Same mapping source the post-class sync uses (`loadPolicyContext`). */
export async function loadFieldMappings(db: Database): Promise<FeedbackFieldMapping[]> {
  const [settings] = await db.select({ version: schema.postClassSettings.formMappingVersion })
    .from(schema.postClassSettings).limit(1);
  const rows = await db.select().from(schema.postClassFieldMappings).where(and(
    eq(schema.postClassFieldMappings.mappingVersion, settings?.version ?? 1),
    eq(schema.postClassFieldMappings.active, true),
  ));
  const valid = new Set<string>(POST_CLASS_FEEDBACK_FIELDS);
  const mappings = rows.flatMap((row): FeedbackFieldMapping[] => valid.has(row.fieldKey)
    ? [{ field: row.fieldKey as FeedbackFieldMapping["field"], questionText: row.wiseQuestionText }]
    : []);
  return mappings.length > 0 ? mappings : [...DEFAULT_FEEDBACK_FIELD_MAPPINGS];
}

/**
 * Ended, not-yet-due sessions for the given Wise teachers. `final_status` may
 * lag Wise, so only known-dead statuses are excluded here; the live Wise gate
 * decides everything else.
 */
export async function loadCandidateShortlist(
  db: Database,
  input: { teacherIds: readonly string[]; now: Date },
): Promise<Array<SessionRow & { wiseTeacherUserId: string | null; deadlineAt: Date | null }>> {
  if (input.teacherIds.length === 0) return [];
  const rows = await db.select({
    wiseSessionId: schema.postClassSessions.wiseSessionId,
    wiseClassId: schema.postClassSessions.wiseClassId,
    className: schema.postClassSessions.className,
    scheduledStartAt: schema.postClassSessions.scheduledStartAt,
    scheduledEndAt: schema.postClassSessions.scheduledEndAt,
    wiseTeacherUserId: schema.postClassSessions.wiseTeacherUserId,
    deadlineAt: schema.postClassSessions.deadlineAt,
  }).from(schema.postClassSessions).where(and(
    inArray(schema.postClassSessions.wiseTeacherUserId, [...input.teacherIds]),
    or(
      isNull(schema.postClassSessions.finalStatus),
      notInArray(schema.postClassSessions.finalStatus, ["CANCELLED", "CANCELED", "NO_SHOW", "DELETED"]),
    ),
    lt(schema.postClassSessions.scheduledEndAt, input.now),
    gt(schema.postClassSessions.deadlineAt, new Date(input.now.getTime() + AUTOWRITER_DEADLINE_MARGIN_MS)),
    isNull(schema.postClassSessions.wiseDeletedAt),
    isNotNull(schema.postClassSessions.wiseClassId),
  )).orderBy(schema.postClassSessions.scheduledStartAt);
  return rows.flatMap((row) => row.wiseClassId ? [{ ...row, wiseClassId: row.wiseClassId }] : []);
}

export interface HumanFeedbackRow extends SessionRow {
  fields: FeedbackFieldAnswers;
}

async function loadLatestHumanFeedback(
  db: Database,
  input: { teacherId?: string; canonicalTutorKey?: string; since?: Date; limit?: number; excludeSessionIds?: string[] },
): Promise<HumanFeedbackRow[]> {
  const conditions = [
    input.canonicalTutorKey
      ? eq(schema.postClassSessions.canonicalTutorKey, input.canonicalTutorKey)
      : eq(schema.postClassSessions.wiseTeacherUserId, input.teacherId ?? ""),
    eq(schema.postClassSessions.finalStatus, "ENDED"),
    eq(schema.postClassFeedbackVersions.profile, "teacher"),
    eq(schema.postClassFeedbackVersions.substantive, true),
    isNotNull(schema.postClassSessions.wiseClassId),
  ];
  if (input.since) conditions.push(gte(schema.postClassSessions.scheduledStartAt, input.since));
  if (input.excludeSessionIds?.length) {
    conditions.push(notInArray(schema.postClassSessions.wiseSessionId, input.excludeSessionIds));
  }
  const query = db.select({
    wiseSessionId: schema.postClassSessions.wiseSessionId,
    wiseClassId: schema.postClassSessions.wiseClassId,
    className: schema.postClassSessions.className,
    scheduledStartAt: schema.postClassSessions.scheduledStartAt,
    scheduledEndAt: schema.postClassSessions.scheduledEndAt,
    topics: schema.postClassFeedbackVersions.topics,
    performance: schema.postClassFeedbackVersions.performance,
    improvement: schema.postClassFeedbackVersions.improvement,
    homework: schema.postClassFeedbackVersions.homework,
  }).from(schema.postClassSessions)
    .innerJoin(
      schema.postClassFeedbackVersions,
      eq(schema.postClassFeedbackVersions.id, schema.postClassSessions.latestFeedbackVersionId),
    )
    .where(and(...conditions))
    .orderBy(desc(schema.postClassSessions.scheduledStartAt));
  const rows = input.limit ? await query.limit(input.limit) : await query;
  return rows.flatMap((row) => row.wiseClassId ? [{
    wiseSessionId: row.wiseSessionId,
    wiseClassId: row.wiseClassId,
    className: row.className,
    scheduledStartAt: row.scheduledStartAt,
    scheduledEndAt: row.scheduledEndAt,
    fields: {
      topics: row.topics ?? "",
      performance: row.performance ?? "",
      improvement: row.improvement ?? "",
      homework: row.homework ?? "",
    },
  }] : []);
}

/** Most recent sessions the tutor already wrote substantive feedback for. */
export function loadEvalSessions(
  db: Database,
  input: { teacherId: string; limit: number; excludeSessionIds: string[] },
): Promise<HumanFeedbackRow[]> {
  return loadLatestHumanFeedback(db, input);
}

/**
 * The tutor's last-90-day feedback across ALL their Wise accounts (the
 * canonical key), matching what the post-class copy-similarity check compares.
 */
export async function loadPriorFeedback(
  db: Database,
  input: { canonicalTutorKey: string; now: Date },
): Promise<PriorFeedbackComparison[]> {
  const rows = await loadLatestHumanFeedback(db, {
    canonicalTutorKey: input.canonicalTutorKey,
    since: new Date(input.now.getTime() - 90 * 24 * 60 * 60 * 1000),
  });
  return rows.map((row) => ({
    key: row.wiseSessionId,
    fields: row.fields,
    studentNames: row.className ? [row.className] : [],
  }));
}

// ---------------------------------------------------------------------------
// Wise access
// ---------------------------------------------------------------------------

function wiseCredentials() {
  const userId = process.env.WISE_USER_ID;
  const apiKey = process.env.WISE_API_KEY;
  const instituteId = process.env.WISE_INSTITUTE_ID;
  if (!userId || !apiKey || !instituteId) throw new Error("WISE_USER_ID, WISE_API_KEY and WISE_INSTITUTE_ID are required");
  return { userId, apiKey, instituteId, namespace: process.env.WISE_NAMESPACE ?? "begifted-education" };
}

const SessionCreditHistorySchema = z.object({
  data: z.object({
    sessionCreditHistory: z.array(z.object({ _id: z.string(), credit: z.number() }).passthrough()),
  }).passthrough(),
}).passthrough();

const FeedbackEventsSchema = z.object({
  data: z.object({
    events: z.array(z.object({
      user: z.object({ _id: z.string().optional(), role: z.string().optional() }).passthrough().nullable().optional(),
      event: z.object({
        eventTimestamp: z.string(),
        payload: z.object({
          session: z.object({ id: z.string().optional(), autoSubmitted: z.boolean().optional() }).passthrough().optional(),
        }).passthrough().optional(),
      }).passthrough(),
    }).passthrough()).default([]),
  }).passthrough(),
}).passthrough();

/**
 * Reads are paced (Wise throttles this institute), retry transient errors and
 * stop when the kill switch appears. The feedback POST is a single raw fetch:
 * no retry, 2xx = sent (whatever the body), 429 = rate limited (not sent),
 * other 4xx = rejected, anything else = unknown — so a successful write can
 * never be mistaken for a failure.
 */
export function createWiseFeedbackOps(input: { stopFile?: string } = {}): WiseFeedbackOps {
  const credentials = wiseCredentials();
  const read = new WiseClient({
    userId: credentials.userId,
    apiKey: credentials.apiKey,
    namespace: credentials.namespace,
    maxConcurrency: 1,
    requestsPerSecond: 0.5,
    maxRetries: 3,
    beforeRequest: () => input.stopFile && fs.existsSync(input.stopFile)
      ? Promise.reject(new Error(`Kill switch present: ${input.stopFile}`))
      : Promise.resolve(),
  });
  const detailParams = {
    showLiveClassInsight: "true",
    showFeedbackConfig: "true",
    showFeedbackSubmission: "true",
    showSessionFiles: "true",
  };
  return {
    getSessionDetailById(sessionId) {
      return read.get(`/user/session/${checkedId(sessionId)}`, detailParams, { cache: "no-store", signal: AbortSignal.timeout(AUTOWRITER_WISE_READ_TIMEOUT_MS) });
    },
    getSessionDetail(classId, sessionId) {
      return read.get(`/user/classes/${checkedId(classId)}/sessions/${checkedId(sessionId)}`, {
        showLiveClassInsight: "true",
        showFeedbackConfig: "true",
        showFeedbackSubmission: "true",
        showSessionFiles: "true",
      }, { cache: "no-store", signal: AbortSignal.timeout(AUTOWRITER_WISE_READ_TIMEOUT_MS) });
    },
    async postFeedback(classId, sessionId, body) {
      const url = `https://api.wiseapp.live/teacher/classes/${checkedId(classId)}/session/${checkedId(sessionId)}/feedback`;
      let response: Response;
      try {
        response = await fetch(url, {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            Authorization: `Basic ${Buffer.from(`${credentials.userId}:${credentials.apiKey}`).toString("base64")}`,
            "x-api-key": credentials.apiKey,
            "x-wise-namespace": credentials.namespace,
            "user-agent": `VendorIntegrations/${credentials.namespace}`,
          },
          body: JSON.stringify(body),
          signal: AbortSignal.timeout(60_000),
        });
      } catch (error) {
        return { kind: "unknown", error: error instanceof Error ? error.name : "Error" };
      }
      const text = await response.text().catch(() => "");
      if (response.ok) return { kind: "sent", status: response.status };
      if (response.status === 429) return { kind: "rate_limited", status: 429 };
      if (response.status >= 400 && response.status < 500) {
        return { kind: "rejected", status: response.status, body: text.slice(0, 300) };
      }
      return { kind: "unknown", error: `HTTP ${response.status}: ${text.slice(0, 200)}` };
    },
    async getSessionCreditEntries(classId, studentId, sessionId) {
      const response = await read.get(
        `/institutes/${checkedId(credentials.instituteId)}/classes/${checkedId(classId)}/students/${checkedId(studentId)}/sessionCredits`,
        { fetchHistory: "true" },
        { cache: "no-store", signal: AbortSignal.timeout(AUTOWRITER_WISE_READ_TIMEOUT_MS) },
      );
      return SessionCreditHistorySchema.parse(response).data.sessionCreditHistory
        .filter((entry) => entry._id === sessionId)
        .map((entry) => ({ credit: entry.credit }));
    },
    async findFeedbackEvents(classId, sessionId, since) {
      const response = await read.get(`/institutes/${checkedId(credentials.instituteId)}/events`, {
        page_number: "1",
        page_size: "50",
        eventName: "SessionFeedbackSubmittedEvent",
        classIds: checkedId(classId),
      }, { cache: "no-store", signal: AbortSignal.timeout(AUTOWRITER_WISE_READ_TIMEOUT_MS) });
      return FeedbackEventsSchema.parse(response).data.events.flatMap((row) => {
        const at = new Date(row.event.eventTimestamp);
        const session = row.event.payload?.session;
        if (session?.id !== sessionId || Number.isNaN(at.getTime()) || at < since) return [];
        return [{
          at,
          autoSubmitted: session.autoSubmitted ?? null,
          actorId: row.user?._id ?? null,
          actorRole: row.user?.role ?? null,
        }];
      });
    },
  };
}

// ---------------------------------------------------------------------------
// Session preparation and paired generation
// ---------------------------------------------------------------------------

export interface PreparedSession {
  purpose: "candidate" | "eval";
  sessionId: string;
  classId: string;
  className: string | null;
  scheduledStartAt: string;
  scheduledMinutes: number;
  studentFullName: string;
  studentDisplayName: string;
  subject: string | null;
  summary: AiSummary;
  submission: SubmissionState;
  billing: BillingPlan | null;
  humanFields: FeedbackFieldAnswers | null;
}

export type PreparedOrSkipped =
  | { ok: true; session: PreparedSession }
  | { ok: false; sessionId: string; purpose: "candidate" | "eval"; reason: string };

export async function prepareSession(input: {
  ops: WiseFeedbackOps;
  row: SessionRow & { fields?: FeedbackFieldAnswers };
  purpose: "candidate" | "eval";
  mappings: readonly FeedbackFieldMapping[];
  gateInput: GateInput;
}): Promise<PreparedOrSkipped> {
  const { row, purpose } = input;
  const skip = (reason: string): PreparedOrSkipped => ({ ok: false, sessionId: row.wiseSessionId, purpose, reason });
  let detail;
  try {
    detail = parseAutowriterSessionDetail(await input.ops.getSessionDetail(row.wiseClassId, row.wiseSessionId));
  } catch (error) {
    return skip(`detail_unavailable:${error instanceof Error ? error.message.slice(0, 120) : "error"}`);
  }
  if (detailClassId(detail) !== row.wiseClassId) return skip("class_id_mismatch");
  const window = scheduledWindow(detail);
  const summary = extractAiSummary(detail);
  const students = studentParticipants(detail);
  const submission = classifyTeacherSubmission(detail);

  let billing: BillingPlan | null = null;
  if (purpose === "candidate") {
    const gates = evaluateSessionGates(detail, input.gateInput);
    if (!gates.ok) return skip(gates.reason);
    const form = planFeedbackForm(detail, input.mappings);
    if (!form.ok) return skip(form.reason);
    // Sessions nobody submitted would be charged by this POST; the pilot only
    // completes Wise's own blank auto-submissions (billing already applied).
    if (submission.kind !== "auto_blank") return skip(`submission_${submission.kind}_not_enabled_in_pilot`);
    const resolved = resolveBilling({ submission, scheduledMinutes: window.minutes });
    if (!resolved.ok) return skip(`billing:${resolved.reason}`);
    billing = resolved.plan;
  } else {
    if (detail.meetingStatus !== "ENDED") return skip("eval_meeting_not_ended");
    if (students.length !== 1) return skip(`eval_student_count_${students.length}`);
    if (!summary || [...summary.text].length < AUTOWRITER_MIN_SUMMARY_CHARACTERS) return skip("eval_no_ai_summary");
  }
  if (!summary) return skip("no_ai_summary");
  const studentFullName = students[0]?.name || row.className || "";
  if (!studentFullName) return skip("student_name_missing");
  return {
    ok: true,
    session: {
      purpose,
      sessionId: row.wiseSessionId,
      classId: row.wiseClassId,
      className: row.className,
      scheduledStartAt: window.start.toISOString(),
      scheduledMinutes: window.minutes,
      studentFullName,
      studentDisplayName: chooseStudentDisplayName(summary.text, studentFullName),
      subject: detail.classSubject ?? null,
      summary,
      submission,
      billing,
      humanFields: row.fields ?? null,
    },
  };
}

export interface DraftRecord {
  sessionId: string;
  purpose: "candidate" | "eval";
  arm: ModelArm;
  requestedModel: string;
  promptVersion: number;
  call: Omit<Extract<OpenRouterCallResult, { ok: true }>, "content" | "ok"> | Omit<Extract<OpenRouterCallResult, { ok: false }>, "ok">;
  callOk: boolean;
  output: ModelOutput | null;
  fields: FeedbackFieldAnswers | null;
  validation: { ok: boolean; reasons: string[] };
}

function omitKeys<T extends object, K extends keyof T>(value: T, ...keys: K[]): Omit<T, K> {
  const copy = { ...value };
  for (const key of keys) delete copy[key];
  return copy;
}

export async function generateDraft(input: {
  apiKey: string;
  arm: ModelArm;
  session: PreparedSession;
  tutorNames: readonly string[];
  priorFeedback: readonly PriorFeedbackComparison[];
  maxTokens?: number;
  timeoutMs?: number;
}): Promise<DraftRecord> {
  const config: AutowriterModelConfig = input.arm === "glm" ? AUTOWRITER_MODELS.writer : AUTOWRITER_MODELS.fallbackWriter;
  const { session } = input;
  const call = await callOpenRouter({
    apiKey: input.apiKey,
    model: config.model,
    provider: config.provider,
    messages: buildFeedbackMessages({
      studentFullName: session.studentFullName,
      tutorNames: input.tutorNames,
      subject: session.subject,
      scheduledMinutes: session.scheduledMinutes,
      summary: session.summary,
    }),
    schemaName: "post_class_feedback",
    schema: FEEDBACK_JSON_SCHEMA,
    effort: config.effort,
    maxTokens: input.maxTokens ?? 32_000,
    timeoutMs: input.timeoutMs ?? 300_000,
  });
  const base = {
    sessionId: session.sessionId,
    purpose: session.purpose,
    arm: input.arm,
    requestedModel: config.model,
    promptVersion: PROMPT_VERSION,
  };
  if (!call.ok) {
    return { ...base, call: omitKeys(call, "ok"), callOk: false, output: null, fields: null, validation: { ok: false, reasons: [`call:${call.error}`] } };
  }
  const meta = omitKeys(call, "ok", "content");
  const parsed = parseModelOutput(call.content);
  if (!parsed.ok) {
    return { ...base, call: meta, callOk: true, output: null, fields: null, validation: { ok: false, reasons: [parsed.reason] } };
  }
  const fields = finalizeFields(parsed.output, session.studentDisplayName);
  const validation = validateFeedbackDraft({
    output: parsed.output,
    fields,
    studentFullName: session.studentFullName,
    tutorNames: input.tutorNames,
    // Eval drafts must not be compared against the same lesson's own feedback.
    priorFeedback: input.priorFeedback.filter((prior) => prior.key !== session.sessionId),
  });
  return {
    ...base,
    call: meta,
    callOk: true,
    output: parsed.output,
    fields,
    validation: validation.ok ? { ok: true, reasons: [] } : { ok: false, reasons: validation.reasons },
  };
}

export async function mapWithConcurrency<T, R>(
  items: readonly T[],
  concurrency: number,
  worker: (item: T, index: number) => Promise<R>,
): Promise<R[]> {
  const results = new Array<R>(items.length);
  let next = 0;
  const runners = Array.from({ length: Math.min(concurrency, items.length) }, async () => {
    while (next < items.length) {
      const index = next;
      next += 1;
      results[index] = await worker(items[index], index);
    }
  });
  await Promise.all(runners);
  return results;
}

// ---------------------------------------------------------------------------
// Artifacts, grading export and cost report
// ---------------------------------------------------------------------------

export function writeArtifact(filePath: string, value: unknown): void {
  fs.mkdirSync(path.dirname(filePath), { recursive: true, mode: 0o700 });
  fs.writeFileSync(filePath, `${JSON.stringify(value, null, 2)}\n`, { encoding: "utf8", mode: 0o600 });
}

export function readArtifact<T>(filePath: string): T {
  return JSON.parse(fs.readFileSync(filePath, "utf8")) as T;
}

export interface GradingGroup {
  group: string;
  lessonSummary: string;
  variants: Array<{ id: string; feedback: FeedbackFieldAnswers }>;
}

export type GradingMap = Record<string, { sessionId: string; source: ModelArm | "human"; purpose: string }>;

/**
 * Blind export for the Opus graders: one group per lesson (its redacted
 * summary plus every feedback variant under a shuffled letter). Names are
 * redacted the same way for AI and human text, and nothing says which variant
 * is human or which model wrote it — that map is written separately and must
 * not be shown to graders.
 */
export function buildGradingExport(input: {
  sessions: readonly PreparedSession[];
  drafts: readonly DraftRecord[];
  tutorNames: readonly string[];
  random: () => number;
}): { groups: GradingGroup[]; map: GradingMap } {
  const shuffle = <T>(values: readonly T[]) =>
    values.map((value) => ({ value, key: input.random() })).toSorted((a, b) => a.key - b.key).map(({ value }) => value);
  const groups: GradingGroup[] = [];
  const map: GradingMap = {};
  shuffle(input.sessions).forEach((session, groupIndex) => {
    const variants: Array<{ source: ModelArm | "human"; fields: FeedbackFieldAnswers }> = [];
    for (const draft of input.drafts) {
      if (draft.sessionId === session.sessionId && draft.fields) variants.push({ source: draft.arm, fields: draft.fields });
    }
    if (session.humanFields) variants.push({ source: "human", fields: session.humanFields });
    if (variants.length === 0) return;
    const group = `L${String(groupIndex + 1).padStart(2, "0")}`;
    const redact = (text: string) => redactForModel(text, { studentFullName: session.studentFullName, tutorNames: input.tutorNames });
    groups.push({
      group,
      lessonSummary: redact(session.summary.text),
      variants: shuffle(variants).map((variant, index) => {
        const id = `${group}-${String.fromCharCode(65 + index)}`;
        map[id] = { sessionId: session.sessionId, source: variant.source, purpose: session.purpose };
        const feedback = {} as FeedbackFieldAnswers;
        for (const field of POST_CLASS_FEEDBACK_FIELDS) feedback[field] = redact(variant.fields[field]);
        return { id, feedback };
      }),
    });
  });
  return { groups, map };
}

function percentile(values: number[], p: number): number | null {
  if (values.length === 0) return null;
  const sorted = [...values].toSorted((a, b) => a - b);
  return sorted[Math.min(sorted.length - 1, Math.ceil((p / 100) * sorted.length) - 1)];
}

function mean(values: number[]): number | null {
  return values.length === 0 ? null : values.reduce((sum, value) => sum + value, 0) / values.length;
}

export function summarizeCosts(drafts: readonly DraftRecord[]) {
  const arms: ModelArm[] = ["glm", "luna"];
  return Object.fromEntries(arms.map((arm) => {
    const rows = drafts.filter((draft) => draft.arm === arm);
    const withUsage = rows.flatMap((draft) => "usage" in draft.call && draft.call.usage ? [{ draft, usage: draft.call.usage }] : []);
    const cost = withUsage.map(({ usage }) => usage.costUsd ?? 0);
    const accepted = rows.filter((draft) => draft.validation.ok).length;
    const totalCost = cost.reduce((sum, value) => sum + value, 0);
    return [arm, {
      calls: rows.length,
      callsOk: rows.filter((draft) => draft.callOk).length,
      validatorPassed: accepted,
      totalCostUsd: totalCost,
      costPerCallUsd: { mean: mean(cost), p90: percentile(cost, 90) },
      costPerAcceptedDraftUsd: accepted > 0 ? totalCost / accepted : null,
      promptTokens: { mean: mean(withUsage.map(({ usage }) => usage.promptTokens)), p90: percentile(withUsage.map(({ usage }) => usage.promptTokens), 90) },
      reasoningTokens: { mean: mean(withUsage.map(({ usage }) => usage.reasoningTokens)), p90: percentile(withUsage.map(({ usage }) => usage.reasoningTokens), 90) },
      visibleOutputTokens: {
        mean: mean(withUsage.map(({ usage }) => usage.completionTokens - usage.reasoningTokens)),
        p90: percentile(withUsage.map(({ usage }) => usage.completionTokens - usage.reasoningTokens), 90),
      },
      latencyMs: { p50: percentile(rows.map((draft) => draft.call.latencyMs), 50), p90: percentile(rows.map((draft) => draft.call.latencyMs), 90) },
      resolvedModels: [...new Set(rows.map((draft) => draft.call.model).filter(Boolean))],
      providers: [...new Set(rows.map((draft) => draft.call.provider).filter(Boolean))],
      failures: rows.filter((draft) => !draft.validation.ok).map((draft) => ({ sessionId: draft.sessionId, reasons: draft.validation.reasons })),
    }];
  }));
}
