import "server-only";

import { createHash } from "node:crypto";
import { and, desc, eq, gte, inArray, isNull, lt, or, sql } from "drizzle-orm";
import { z } from "zod";

import { extractOutputText } from "@/lib/ai/scheduler";
import { getDb, type Database } from "@/lib/db";
import * as schema from "@/lib/db/schema";

import { PostClassConflictError, PostClassNotFoundError, PostClassValidationError } from "./errors";
import { safeErrorFields } from "./safe-error";
import { assessAiSuspect, redactKnownNames, type PriorFeedbackComparison } from "./similarity";
import { withPostClassTransaction } from "./transaction";

const PROMPT_VERSION = 1;
const REDACTION_VERSION = 1;
/** One model call. Production p99 is about 6s (2026-09), so only a stalled call reaches this. */
const QUALITY_MODEL_TIMEOUT_MS = 30_000;
/** Consecutive model failures that end the pass for this tick: the model is likely down. */
const MAX_CONSECUTIVE_MODEL_FAILURES = 3;
/** Model attempts per feedback version, the first included. */
const MAX_MODEL_ATTEMPTS = 3;
/** A transient failure waits at least this long before its next attempt. */
const RETRY_AFTER_MS = 60 * 60 * 1_000;
/** No claim outlives one 800s tick, so a run still `running` after this was killed mid-call. */
const STALE_RUNNING_MS = 15 * 60 * 1_000;
const DIMENSIONS = [
  "vagueness",
  "actionable_detail",
  "irrelevance",
  "unprofessional_tone",
  "contradiction",
  "probable_copying",
] as const;

const AiOutputSchema = z.object({
  concerns: z.array(z.object({
    dimension: z.enum(DIMENSIONS),
    summary: z.string().min(1).max(500),
    confidence: z.number().min(0).max(1),
  })).max(DIMENSIONS.length),
});

interface OpenAiResponse {
  output?: Array<{ content?: Array<{ type?: string; text?: string }> }>;
  output_text?: string;
}

function requestHash(sessionId: string, feedbackVersionId: string, contentHash: string): string {
  return createHash("sha256")
    .update(`${sessionId}:${feedbackVersionId}:${contentHash}:prompt-${PROMPT_VERSION}:redaction-${REDACTION_VERSION}`)
    .digest("hex");
}

function safeAiError(error: unknown): string {
  if (error instanceof Error && /OPENAI_API_KEY/.test(error.message)) return error.message;
  if (error instanceof Error && /HTTP \d{3}/.test(error.message)) return error.message.slice(0, 300);
  return "AI quality review failed";
}

/**
 * Whether a failed model call is worth another attempt later: a timeout or
 * abort, a network failure (undici's `TypeError: fetch failed`, or
 * `terminated` when the socket drops mid-body), a rate limit or a server
 * error. A bad request, a rejected key, unparseable or off-schema output, a
 * code bug, and anything else stay final.
 */
export function isTransientQualityModelError(error: unknown): boolean {
  if (!(error instanceof Error)) return false;
  if (error.name === "TimeoutError" || error.name === "AbortError") return true;
  if (error instanceof TypeError) return error.message === "fetch failed" || error.message === "terminated";
  const status = /^OpenAI HTTP (\d{3})$/.exec(error.message)?.[1];
  return status === "429" || Boolean(status?.startsWith("5"));
}

interface EarlierAiRun {
  status: string;
  metadata: Record<string, unknown>;
  finishedAt: Date | null;
  updatedAt: Date;
}

function modelAttempts(metadata: Record<string, unknown>): number {
  return typeof metadata.attempts === "number" ? metadata.attempts : 1;
}

/** A claim no live pass can still hold: its function was killed mid-call. */
function isStaleClaim(run: EarlierAiRun, now: Date): boolean {
  return run.status === "running" && now.getTime() - run.updatedAt.getTime() >= STALE_RUNNING_MS;
}

/** Whether an earlier run for the same request is due another model attempt (mirrors the candidate query). */
function retryDue(run: EarlierAiRun, now: Date): boolean {
  if (modelAttempts(run.metadata) >= MAX_MODEL_ATTEMPTS) return false;
  if (run.status === "failed") {
    return run.metadata.retryable === true
      && run.finishedAt !== null
      && now.getTime() - run.finishedAt.getTime() >= RETRY_AFTER_MS;
  }
  return isStaleClaim(run, now);
}

export interface PostClassAiReviewPassResult {
  /** Model reviews that finished. */
  processed: number;
  /** Model calls that failed; each run row records why and whether it is retryable. */
  failed: number;
  /** Versions already settled, cleared without the model, not yet due a retry, or claimed by another pass. */
  skipped: number;
  /** Model calls that retried an earlier failed or killed run (also counted in processed or failed). */
  retried: number;
  /** Why model calls ended early (`deadline`, `model_failures`) or never started (`not_configured`). */
  stopped: "deadline" | "model_failures" | "not_configured" | null;
}

async function callQualityModel(input: {
  model: string;
  topics: string;
  performance: string;
  improvement: string;
  triggerReasons: string[];
  similarity: number;
}): Promise<z.infer<typeof AiOutputSchema>> {
  const apiKey = process.env.OPENAI_API_KEY?.trim();
  if (!apiKey) throw new Error("OPENAI_API_KEY is not configured");

  const response = await fetch("https://api.openai.com/v1/responses", {
    method: "POST", signal: AbortSignal.timeout(QUALITY_MODEL_TIMEOUT_MS),
    headers: {
      Authorization: `Bearer ${apiKey}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      model: input.model,
      store: false,
      reasoning: { effort: "low" },
      input: [
        "Review this de-identified tutor feedback as an advisory quality check.",
        "The deterministic compliance policy is handled elsewhere. Do not decide deductions or compliance.",
        "Assess English, Thai, or bilingual text only for: vagueness, missing actionable detail, irrelevance, unprofessional tone, contradictions, and probable copying.",
        "Return only genuine concerns. A concise but specific field may be acceptable.",
        `Deterministic triggers: ${input.triggerReasons.join(", ") || "none"}`,
        `Prior-text similarity: ${(input.similarity * 100).toFixed(1)}%`,
        `Topics:\n${input.topics}`,
        `Student performance:\n${input.performance}`,
        `Improvement / next step:\n${input.improvement}`,
      ].join("\n\n"),
      text: {
        verbosity: "low",
        format: {
          type: "json_schema",
          name: "post_class_feedback_quality",
          strict: true,
          schema: {
            type: "object",
            additionalProperties: false,
            required: ["concerns"],
            properties: {
              concerns: {
                type: "array",
                maxItems: DIMENSIONS.length,
                items: {
                  type: "object",
                  additionalProperties: false,
                  required: ["dimension", "summary", "confidence"],
                  properties: {
                    dimension: { type: "string", enum: DIMENSIONS },
                    summary: { type: "string", minLength: 1, maxLength: 500 },
                    confidence: { type: "number", minimum: 0, maximum: 1 },
                  },
                },
              },
            },
          },
        },
      },
    }),
  });
  if (!response.ok) throw new Error(`OpenAI HTTP ${response.status}`);
  const json = await response.json() as OpenAiResponse;
  return AiOutputSchema.parse(JSON.parse(extractOutputText(json)));
}

/**
 * Runs one bounded batch of AI quality reviews.
 *
 * 1. Load up to `limit * 4` substantive, source-ready versions that have no AI
 *    run yet, or whose run (for the current prompt and redaction) is due a
 *    retry: a transient failure at least an hour old, or a run killed mid-call
 *    (still `running` after 15 minutes). A retry is capped at three model
 *    attempts in total; a killed run out of attempts is closed as failed.
 * 2. A first look assesses the version deterministically; a clean version gets a
 *    `deterministic-only` run and no model call. A retry reuses the triggers
 *    recorded with its first attempt.
 * 3. Before each model call: without `OPENAI_API_KEY`, leave the version
 *    unclaimed and move on; stop once a call could not finish (30s timeout)
 *    before `deadlineAt`. Then claim the run exclusively, by insert on the unique
 *    request hash or by a conditional update of the earlier row. A lost claim
 *    skips the version.
 * 4. A failed model call records whether it is retryable; three consecutive
 *    failures stop the pass for this tick. A successful call is saved in one
 *    transaction, and only while this pass still holds its claim.
 */
export async function processPostClassAiReviews(
  options: { limit?: number; now?: Date; deadlineAt?: number } = {},
  db: Database = getDb(),
): Promise<PostClassAiReviewPassResult> {
  const limit = Math.max(1, Math.min(25, options.limit ?? 10));
  const now = options.now ?? new Date();
  const runs = schema.postClassAiRuns;
  // jsonb_typeof guards the cast: a hand-edited non-number counts as one attempt
  // instead of failing the candidate query on every tick.
  const attemptsSql = sql`(case when jsonb_typeof(${runs.metadata}->'attempts') = 'number'
    then (${runs.metadata}->>'attempts')::numeric else 1 end)`;
  const candidates = await db
    .select({
      session: schema.postClassSessions,
      version: schema.postClassFeedbackVersions,
    })
    .from(schema.postClassSessions)
    .innerJoin(
      schema.postClassFeedbackVersions,
      eq(schema.postClassSessions.latestFeedbackVersionId, schema.postClassFeedbackVersions.id),
    )
    .leftJoin(runs, eq(runs.feedbackVersionId, schema.postClassFeedbackVersions.id))
    .where(and(
      eq(schema.postClassSessions.eligible, true),
      eq(schema.postClassSessions.sourceStatus, "ready"),
      eq(schema.postClassFeedbackVersions.substantive, true),
      or(
        isNull(runs.id),
        and(
          // Only a run of the current request can be retried; an older prompt's
          // run would otherwise keep its version a candidate forever.
          eq(runs.redactionVersion, REDACTION_VERSION),
          sql`(${runs.metadata}->>'promptVersion') = ${String(PROMPT_VERSION)}`,
          or(
            and(
              sql`${attemptsSql} < ${MAX_MODEL_ATTEMPTS}`,
              eq(runs.status, "failed"),
              sql`(${runs.metadata}->>'retryable') = 'true'`,
              lt(runs.finishedAt, new Date(now.getTime() - RETRY_AFTER_MS)),
            ),
            // Any stale claim: one out of attempts is closed below, not retried.
            and(
              eq(runs.status, "running"),
              lt(runs.updatedAt, new Date(now.getTime() - STALE_RUNNING_MS)),
            ),
          ),
        ),
      ),
    ))
    .orderBy(desc(schema.postClassSessions.lastAssessedAt))
    .limit(limit * 4);

  const sessionIds = candidates.map((row) => row.session.id);
  const tutorKeys = [...new Set(candidates.flatMap((row) =>
    row.session.canonicalTutorKey ? [row.session.canonicalTutorKey] : []))];
  const [participants, tutorContacts, identityNames] = await Promise.all([
    sessionIds.length > 0
      ? db.select().from(schema.postClassSessionParticipants)
        .where(inArray(schema.postClassSessionParticipants.sessionId, sessionIds))
      : Promise.resolve([]),
    tutorKeys.length > 0
      ? db.select({
        canonicalKey: schema.tutorContacts.canonicalKey,
        displayName: schema.tutorContacts.displayName,
        sourceNames: schema.tutorContacts.sourceNames,
      }).from(schema.tutorContacts)
        .where(inArray(schema.tutorContacts.canonicalKey, tutorKeys))
      : Promise.resolve([]),
    tutorKeys.length > 0
      ? db.select({
        canonicalKey: schema.tutorIdentityGroups.canonicalKey,
        wiseDisplayName: schema.tutorIdentityGroupMembers.wiseDisplayName,
      }).from(schema.tutorIdentityGroupMembers)
        .innerJoin(
          schema.tutorIdentityGroups,
          eq(schema.tutorIdentityGroupMembers.groupId, schema.tutorIdentityGroups.id),
        )
        .innerJoin(
          schema.snapshots,
          eq(schema.tutorIdentityGroups.snapshotId, schema.snapshots.id),
        )
        .where(and(
          eq(schema.snapshots.active, true),
          inArray(schema.tutorIdentityGroups.canonicalKey, tutorKeys),
        ))
      : Promise.resolve([]),
  ]);
  const tutorNamesByKey = new Map<string, string[]>();
  for (const contact of tutorContacts) {
    tutorNamesByKey.set(contact.canonicalKey, [contact.displayName, ...contact.sourceNames]);
  }
  for (const identity of identityNames) {
    tutorNamesByKey.set(identity.canonicalKey, [
      ...(tutorNamesByKey.get(identity.canonicalKey) ?? []),
      identity.wiseDisplayName,
    ]);
  }
  const namesBySession = new Map<string, string[]>();
  for (const participant of participants) {
    const names = namesBySession.get(participant.sessionId) ?? [];
    names.push(participant.studentName);
    namesBySession.set(participant.sessionId, names);
  }

  const modelConfigured = Boolean(process.env.OPENAI_API_KEY?.trim());
  let processed = 0;
  let failed = 0;
  let skipped = 0;
  let retried = 0;
  let consecutiveFailures = 0;
  let stopped: PostClassAiReviewPassResult["stopped"] = null;
  for (const candidate of candidates) {
    if (processed >= limit) break;
    const key = requestHash(candidate.session.id, candidate.version.id, candidate.version.contentHash);
    const [earlier] = await db.select({
      id: runs.id,
      status: runs.status,
      triggerReasons: runs.triggerReasons,
      metadata: runs.metadata,
      finishedAt: runs.finishedAt,
      updatedAt: runs.updatedAt,
    })
      .from(runs)
      .where(eq(runs.requestHash, key))
      .limit(1);
    if (earlier && !retryDue(earlier, now)) {
      if (isStaleClaim(earlier, now)) {
        // Killed mid-call on its last attempt: close it, so it stops reading as in progress.
        await db.update(runs).set({
          status: "failed",
          finishedAt: new Date(),
          errorMessage: "AI quality review abandoned after its last attempt was interrupted",
          metadata: { ...earlier.metadata, retryable: false },
          updatedAt: new Date(),
        }).where(and(
          eq(runs.id, earlier.id),
          eq(runs.status, "running"),
          sql`${attemptsSql} = ${modelAttempts(earlier.metadata)}`,
        ));
      }
      skipped += 1;
      continue;
    }

    const studentNames = namesBySession.get(candidate.session.id) ?? [];
    const tutorNames = [...new Set([
      candidate.session.canonicalTutorName ?? "",
      ...(candidate.session.canonicalTutorKey
        ? tutorNamesByKey.get(candidate.session.canonicalTutorKey) ?? []
        : []),
    ].filter(Boolean))];
    let suspect: { reasons: string[]; highestPriorSimilarity: number; matchingPriorKey: string | null };
    if (earlier) {
      // A retry is the same request: keep the triggers its first attempt recorded.
      suspect = {
        reasons: earlier.triggerReasons,
        highestPriorSimilarity: typeof earlier.metadata.highestPriorSimilarity === "number"
          ? earlier.metadata.highestPriorSimilarity
          : 0,
        matchingPriorKey: typeof earlier.metadata.matchingPriorKey === "string"
          ? earlier.metadata.matchingPriorKey
          : null,
      };
    } else {
      const priorRows = candidate.session.canonicalTutorKey
        ? await db.select({
          sessionId: schema.postClassSessions.id,
          wiseSessionId: schema.postClassSessions.wiseSessionId,
          version: schema.postClassFeedbackVersions,
        }).from(schema.postClassSessions)
          .innerJoin(
            schema.postClassFeedbackVersions,
            eq(schema.postClassSessions.latestFeedbackVersionId, schema.postClassFeedbackVersions.id),
          )
          .where(and(
            eq(schema.postClassSessions.canonicalTutorKey, candidate.session.canonicalTutorKey),
            gte(
              schema.postClassSessions.scheduledEndAt,
              new Date(candidate.session.scheduledEndAt.getTime() - 90 * 86_400_000),
            ),
            lt(schema.postClassSessions.scheduledEndAt, candidate.session.scheduledEndAt),
          ))
        : [];
      const priorParticipantRows = priorRows.length > 0
        ? await db.select({
          sessionId: schema.postClassSessionParticipants.sessionId,
          studentName: schema.postClassSessionParticipants.studentName,
        }).from(schema.postClassSessionParticipants).where(inArray(
          schema.postClassSessionParticipants.sessionId,
          priorRows.map((row) => row.sessionId),
        ))
        : [];
      const priorNamesBySession = new Map<string, string[]>();
      for (const participant of priorParticipantRows) {
        const names = priorNamesBySession.get(participant.sessionId) ?? [];
        names.push(participant.studentName);
        priorNamesBySession.set(participant.sessionId, names);
      }
      const prior: PriorFeedbackComparison[] = priorRows
        .filter((row) => row.sessionId !== candidate.session.id)
        .map((row) => ({
          key: row.wiseSessionId,
          fields: {
            topics: row.version.topics,
            performance: row.version.performance,
            improvement: row.version.improvement,
            homework: row.version.homework,
          },
          studentNames: priorNamesBySession.get(row.sessionId) ?? [],
        }));
      const assessment = assessAiSuspect({
        topics: candidate.version.topics,
        performance: candidate.version.performance,
        improvement: candidate.version.improvement,
        homework: candidate.version.homework,
      }, { studentNames, tutorNames, priorFeedback: prior });
      if (!assessment.suspect) {
        // Persist the deterministic decision so the same healthy version cannot
        // occupy the head of every bounded cron batch. No model is invoked.
        await db.insert(schema.postClassAiRuns).values({
          sessionId: candidate.session.id,
          feedbackVersionId: candidate.version.id,
          status: "succeeded",
          triggerReasons: [],
          model: "deterministic-only",
          requestHash: key,
          redactionVersion: REDACTION_VERSION,
          startedAt: now,
          finishedAt: now,
          metadata: {
            promptVersion: PROMPT_VERSION,
            modelInvoked: false,
            highestPriorSimilarity: assessment.highestPriorSimilarity,
          },
        }).onConflictDoNothing({ target: schema.postClassAiRuns.requestHash });
        skipped += 1;
        continue;
      }
      suspect = assessment;
    }

    if (!modelConfigured) {
      // No key: keep settling versions that need no model, and leave this one
      // unclaimed for when a key is set.
      stopped = "not_configured";
      skipped += 1;
      continue;
    }
    if (options.deadlineAt !== undefined && Date.now() + QUALITY_MODEL_TIMEOUT_MS > options.deadlineAt) {
      stopped = "deadline";
      break;
    }

    const model = process.env.OPENAI_POST_CLASS_FEEDBACK_MODEL?.trim() || "gpt-5.4-mini";
    const claimedAt = new Date();
    const attempts = earlier ? modelAttempts(earlier.metadata) + 1 : 1;
    const metadata: Record<string, unknown> = earlier
      ? {
        // The previous failure's verdict does not describe this attempt.
        ...Object.fromEntries(Object.entries(earlier.metadata)
          .filter(([field]) => field !== "retryable" && field !== "lastErrorName")),
        attempts,
      }
      : {
        promptVersion: PROMPT_VERSION,
        highestPriorSimilarity: suspect.highestPriorSimilarity,
        matchingPriorKey: suspect.matchingPriorKey,
        attempts,
      };
    // Two passes can overlap once the sync lock is released, so the claim is
    // exclusive: only the pass whose write lands calls the model.
    const [run] = earlier
      ? await db.update(runs).set({
        status: "running",
        model,
        startedAt: claimedAt,
        finishedAt: null,
        errorMessage: null,
        metadata,
        updatedAt: claimedAt,
      }).where(and(
        eq(runs.id, earlier.id),
        eq(runs.status, earlier.status),
        sql`${attemptsSql} = ${modelAttempts(earlier.metadata)}`,
      )).returning({ id: runs.id })
      : await db.insert(runs).values({
        sessionId: candidate.session.id,
        feedbackVersionId: candidate.version.id,
        status: "running",
        triggerReasons: suspect.reasons,
        model,
        requestHash: key,
        redactionVersion: REDACTION_VERSION,
        startedAt: claimedAt,
        metadata,
      }).onConflictDoNothing({ target: runs.requestHash })
        .returning({ id: runs.id });
    if (!run) {
      skipped += 1;
      continue;
    }
    if (earlier) retried += 1;

    // Every later write settles this claim only while this pass still holds it.
    const stillClaimed = and(
      eq(runs.id, run.id),
      eq(runs.status, "running"),
      sql`${attemptsSql} = ${attempts}`,
    );
    const recordFailure = (error: unknown, retryable: boolean) => db.update(runs).set({
      status: "failed",
      finishedAt: new Date(),
      errorMessage: safeAiError(error),
      metadata: { ...metadata, retryable, lastErrorName: safeErrorFields(error).errorName },
      updatedAt: new Date(),
    }).where(stillClaimed);

    let output: z.infer<typeof AiOutputSchema>;
    try {
      const redact = (value: string) => redactKnownNames(value, { studentNames, tutorNames });
      output = await callQualityModel({
        model,
        topics: redact(candidate.version.topics),
        performance: redact(candidate.version.performance),
        improvement: redact(candidate.version.improvement),
        triggerReasons: suspect.reasons,
        similarity: suspect.highestPriorSimilarity,
      });
    } catch (error) {
      await recordFailure(error, isTransientQualityModelError(error));
      failed += 1;
      consecutiveFailures += 1;
      if (consecutiveFailures >= MAX_CONSECUTIVE_MODEL_FAILURES) {
        stopped = "model_failures";
        break;
      }
      continue;
    }
    consecutiveFailures = 0;

    try {
      const saved = await withPostClassTransaction(db, async (tx) => {
        const [held] = await tx.update(runs).set({
          status: "succeeded",
          finishedAt: new Date(),
          updatedAt: new Date(),
        }).where(stillClaimed).returning({ id: runs.id });
        if (held && output.concerns.length > 0) {
          await tx.insert(schema.postClassAiConcerns).values(output.concerns.map((concern) => ({
            runId: run.id,
            dimension: concern.dimension,
            summary: concern.summary,
            confidence: concern.confidence,
          })));
        }
        return Boolean(held);
      });
      if (saved) processed += 1;
      else skipped += 1;
    } catch (error) {
      // The model answered but saving its answer failed: not a model failure,
      // so it does not count toward the stop, and the next attempt re-asks.
      await recordFailure(error, true);
      failed += 1;
    }
  }
  if (stopped) {
    // Counts only: each run row keeps its own failure cause.
    console.error("[post-class-ai-review]", { stopped, processed, failed, retried });
  }
  return { processed, failed, skipped, retried, stopped };
}

function auditRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : {};
}

export function assertPostClassAiReviewIdempotentPayloadMatches(
  prior: {
    action: string;
    actorEmail: string;
    note: string | null;
    beforeValue: Record<string, unknown> | null;
    afterValue: Record<string, unknown> | null;
  },
  expected: {
    concernId: string;
    decision: "confirmed" | "dismissed";
    actorEmail: string;
    note: string;
    expectedVersion: number;
  },
): void {
  const before = auditRecord(prior.beforeValue);
  const after = auditRecord(prior.afterValue);
  if (
    prior.action !== expected.decision ||
    prior.actorEmail.trim().toLowerCase() !== expected.actorEmail.trim().toLowerCase() ||
    prior.note !== expected.note ||
    after.concernId !== expected.concernId ||
    before.version !== expected.expectedVersion
  ) {
    throw new PostClassConflictError(
      "The idempotency key was already used with a different AI review payload.",
    );
  }
}

export async function reviewPostClassAiConcerns(
  actorEmail: string,
  input: {
    concernId: string;
    action: "confirm" | "dismiss";
    note: string;
    expectedVersion: number;
    idempotencyKey: string;
  },
  db: Database = getDb(),
) {
  const note = input.note.trim();
  if (!note) throw new PostClassValidationError("A review note is required.");
  const decision = input.action === "confirm" ? "confirmed" : "dismissed";

  return withPostClassTransaction(db, async (tx) => {
    await tx.execute(sql`select pg_advisory_xact_lock(hashtext(${
      `post_class_ai_review:${input.idempotencyKey}`
    }))`);
    const [prior] = await tx.select({
      action: schema.postClassConfigAuditLog.action,
      actorEmail: schema.postClassConfigAuditLog.actorEmail,
      note: schema.postClassConfigAuditLog.note,
      beforeValue: schema.postClassConfigAuditLog.beforeValue,
      afterValue: schema.postClassConfigAuditLog.afterValue,
    })
      .from(schema.postClassConfigAuditLog)
      .where(and(
        eq(schema.postClassConfigAuditLog.entityType, "ai_review_request"),
        eq(schema.postClassConfigAuditLog.entityKey, input.idempotencyKey),
      )).limit(1);
    if (prior) {
      assertPostClassAiReviewIdempotentPayloadMatches(prior, {
        concernId: input.concernId,
        decision,
        actorEmail,
        note,
        expectedVersion: input.expectedVersion,
      });
      return { reviewed: 0, duplicate: true };
    }

    const [concern] = await tx.select().from(schema.postClassAiConcerns)
      .where(eq(schema.postClassAiConcerns.id, input.concernId)).limit(1);
    if (!concern || concern.decision !== "pending") {
      throw new PostClassNotFoundError("The pending AI concern was not found.");
    }
    if (concern.version !== input.expectedVersion) {
      throw new PostClassConflictError("The AI concern changed; refresh before reviewing it.");
    }
    const [updated] = await tx.update(schema.postClassAiConcerns).set({
      decision,
      version: concern.version + 1,
      updatedAt: new Date(),
    }).where(and(
      eq(schema.postClassAiConcerns.id, concern.id),
      eq(schema.postClassAiConcerns.version, input.expectedVersion),
      eq(schema.postClassAiConcerns.decision, "pending"),
    )).returning();
    if (!updated) throw new PostClassConflictError("The AI concern changed; refresh before reviewing it.");
    await tx.insert(schema.postClassAiReviews).values({
      concernId: concern.id,
      decision,
      note,
      actorEmail,
      expectedVersion: concern.version,
    });
    await tx.insert(schema.postClassConfigAuditLog).values({
      entityType: "ai_review_request",
      entityKey: input.idempotencyKey,
      action: decision,
      actorEmail,
      beforeValue: { concernId: concern.id, decision: concern.decision, version: concern.version },
      afterValue: { concernId: concern.id, decision, version: updated.version },
      note,
    });
    return { reviewed: 1, duplicate: false };
  });
}
