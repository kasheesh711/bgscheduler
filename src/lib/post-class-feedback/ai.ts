import "server-only";

import { createHash } from "node:crypto";
import { and, desc, eq, gte, inArray, isNull, lt, sql } from "drizzle-orm";
import { z } from "zod";

import { extractOutputText } from "@/lib/ai/scheduler";
import { getDb, type Database } from "@/lib/db";
import * as schema from "@/lib/db/schema";

import { PostClassConflictError, PostClassNotFoundError, PostClassValidationError } from "./errors";
import { assessAiSuspect, redactKnownNames, type PriorFeedbackComparison } from "./similarity";
import { withPostClassTransaction } from "./transaction";

const PROMPT_VERSION = 1;
const REDACTION_VERSION = 1;
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
    method: "POST",
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

export async function processPostClassAiReviews(
  options: { limit?: number; now?: Date } = {},
  db: Database = getDb(),
) {
  const limit = Math.max(1, Math.min(25, options.limit ?? 10));
  const now = options.now ?? new Date();
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
    .leftJoin(
      schema.postClassAiRuns,
      eq(schema.postClassAiRuns.feedbackVersionId, schema.postClassFeedbackVersions.id),
    )
    .where(and(
      eq(schema.postClassSessions.eligible, true),
      eq(schema.postClassSessions.sourceStatus, "ready"),
      eq(schema.postClassFeedbackVersions.substantive, true),
      isNull(schema.postClassAiRuns.id),
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

  let processed = 0;
  let failed = 0;
  let skipped = 0;
  for (const candidate of candidates) {
    if (processed >= limit) break;
    const key = requestHash(candidate.session.id, candidate.version.id, candidate.version.contentHash);
    const [existing] = await db.select({ id: schema.postClassAiRuns.id })
      .from(schema.postClassAiRuns)
      .where(eq(schema.postClassAiRuns.requestHash, key))
      .limit(1);
    if (existing) {
      skipped += 1;
      continue;
    }

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
    const studentNames = namesBySession.get(candidate.session.id) ?? [];
    const tutorNames = [...new Set([
      candidate.session.canonicalTutorName ?? "",
      ...(candidate.session.canonicalTutorKey
        ? tutorNamesByKey.get(candidate.session.canonicalTutorKey) ?? []
        : []),
    ].filter(Boolean))];
    const suspect = assessAiSuspect({
      topics: candidate.version.topics,
      performance: candidate.version.performance,
      improvement: candidate.version.improvement,
      homework: candidate.version.homework,
    }, { studentNames, tutorNames, priorFeedback: prior });
    if (!suspect.suspect) {
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
          highestPriorSimilarity: suspect.highestPriorSimilarity,
        },
      }).onConflictDoNothing({ target: schema.postClassAiRuns.requestHash });
      skipped += 1;
      continue;
    }

    const model = process.env.OPENAI_POST_CLASS_FEEDBACK_MODEL?.trim() || "gpt-5.4-mini";
    const [run] = await db.insert(schema.postClassAiRuns).values({
      sessionId: candidate.session.id,
      feedbackVersionId: candidate.version.id,
      status: "running",
      triggerReasons: suspect.reasons,
      model,
      requestHash: key,
      redactionVersion: REDACTION_VERSION,
      startedAt: now,
      metadata: {
        promptVersion: PROMPT_VERSION,
        highestPriorSimilarity: suspect.highestPriorSimilarity,
        matchingPriorKey: suspect.matchingPriorKey,
      },
    }).returning();

    try {
      const redact = (value: string) => redactKnownNames(value, { studentNames, tutorNames });
      const output = await callQualityModel({
        model,
        topics: redact(candidate.version.topics),
        performance: redact(candidate.version.performance),
        improvement: redact(candidate.version.improvement),
        triggerReasons: suspect.reasons,
        similarity: suspect.highestPriorSimilarity,
      });
      if (output.concerns.length > 0) {
        await db.insert(schema.postClassAiConcerns).values(output.concerns.map((concern) => ({
          runId: run.id,
          dimension: concern.dimension,
          summary: concern.summary,
          confidence: concern.confidence,
        })));
      }
      await db.update(schema.postClassAiRuns).set({
        status: "succeeded",
        finishedAt: new Date(),
        updatedAt: new Date(),
      }).where(eq(schema.postClassAiRuns.id, run.id));
      processed += 1;
    } catch (error) {
      await db.update(schema.postClassAiRuns).set({
        status: "failed",
        finishedAt: new Date(),
        errorMessage: safeAiError(error),
        updatedAt: new Date(),
      }).where(eq(schema.postClassAiRuns.id, run.id));
      failed += 1;
    }
  }
  return { processed, failed, skipped };
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
