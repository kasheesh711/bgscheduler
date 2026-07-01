import { and, eq, lt, sql } from "drizzle-orm";
import { getDb, type Database } from "@/lib/db";
import * as schema from "@/lib/db/schema";
import { CRON_JOBS, getCronJobDefinition, type CronJobKey } from "./cron-registry";
import type { CronInvocationOutcome, CronTriggerSource } from "./types";

export const ABANDONED_INVOCATION_BUFFER_MS = 60 * 1000;
export const ABANDONED_CRON_INVOCATION_ERROR =
  "Cron invocation marked failed because it exceeded maxDuration and the platform did not return a response.";

interface AuditInput {
  jobKey: CronJobKey;
  triggerSource: CronTriggerSource;
  actorEmail?: string | null;
  requestMethod?: string;
}

interface StartedInvocation {
  id: string;
  startedAt: Date;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function stringValue(value: unknown): string | null {
  return typeof value === "string" && value.trim() ? value : null;
}

function summarizeError(body: unknown, fallbackStatus: number): string | null {
  if (!isRecord(body)) return fallbackStatus >= 400 ? `HTTP ${fallbackStatus}` : null;
  return (
    stringValue(body.errorSummary) ??
    stringValue(body.error) ??
    (isRecord(body.result) ? stringValue(body.result.errorSummary) ?? stringValue(body.result.error) : null) ??
    (fallbackStatus >= 400 ? `HTTP ${fallbackStatus}` : null)
  );
}

function extractLinkedRunIds(body: unknown): Record<string, unknown> {
  if (!isRecord(body)) return {};
  const linked: Record<string, unknown> = {};

  const syncRunId = stringValue(body.syncRunId);
  if (syncRunId) linked.syncRunId = syncRunId;

  if (isRecord(body.result)) {
    const resultSyncRunId = stringValue(body.result.syncRunId) ?? stringValue(body.result.id);
    if (resultSyncRunId) linked.resultRunId = resultSyncRunId;
  }

  if (Array.isArray(body.results)) {
    linked.resultCount = body.results.length;
  }

  if (isRecord(body.projectionResult)) {
    const projectionRunId = stringValue(body.projectionResult.runId) ?? stringValue(body.projectionResult.id);
    if (projectionRunId) linked.projectionRunId = projectionRunId;
  }

  return linked;
}

function determineOutcome(status: number, body: unknown): CronInvocationOutcome {
  if (isRecord(body)) {
    const message = `${stringValue(body.error) ?? ""} ${stringValue(body.message) ?? ""}`.toLowerCase();
    if (body.skipped === true || message.includes("already running")) return "skipped";
    if (body.ok === false || body.success === false) return "failed";
  }
  if (status === 202) return "skipped";
  if (status >= 400) return "failed";
  return "success";
}

async function responseBodyForAudit(response: Response): Promise<unknown> {
  const clone = response.clone();
  const contentType = clone.headers.get("content-type") ?? "";
  try {
    if (contentType.includes("application/json")) return await clone.json();
    const text = await clone.text();
    return text ? { text: text.slice(0, 500) } : {};
  } catch {
    return {};
  }
}

async function startInvocation(input: AuditInput): Promise<StartedInvocation | null> {
  const definition = getCronJobDefinition(input.jobKey);
  if (!definition) return null;

  const startedAt = new Date();
  try {
    const [row] = await getDb()
      .insert(schema.cronInvocations)
      .values({
        jobKey: definition.key,
        path: definition.path,
        schedule: definition.schedule,
        triggerSource: input.triggerSource,
        actorEmail: input.actorEmail ?? null,
        requestMethod: input.requestMethod ?? definition.routeMethod,
        receivedAt: startedAt,
        outcome: "running",
        metadata: {
          label: definition.label,
          feature: definition.feature,
        },
      })
      .returning({ id: schema.cronInvocations.id });
    return { id: row.id, startedAt };
  } catch (error) {
    console.error("Failed to record cron invocation start", error);
    return null;
  }
}

async function finishInvocation(
  started: StartedInvocation | null,
  response: Response,
): Promise<void> {
  if (!started) return;

  const finishedAt = new Date();
  const body = await responseBodyForAudit(response);
  const outcome = determineOutcome(response.status, body);

  try {
    await getDb()
      .update(schema.cronInvocations)
      .set({
        finishedAt,
        durationMs: finishedAt.getTime() - started.startedAt.getTime(),
        responseStatus: response.status,
        outcome,
        errorSummary: summarizeError(body, response.status),
        linkedRunIds: extractLinkedRunIds(body),
        metadata: {
          response: isRecord(body) ? body : {},
        },
      })
      .where(eq(schema.cronInvocations.id, started.id));
  } catch (error) {
    console.error("Failed to record cron invocation finish", error);
  }
}

function isMissingCronInvocationsTable(error: unknown): boolean {
  const message = error instanceof Error ? error.message : String(error);
  const cause = typeof error === "object" && error && "cause" in error
    ? (error as { cause?: unknown }).cause
    : undefined;
  const causeMessage = cause instanceof Error ? cause.message : String(cause ?? "");
  const causeCode = typeof cause === "object" && cause && "code" in cause
    ? String((cause as { code?: unknown }).code)
    : "";
  return (
    message.includes("cron_invocations") ||
    causeMessage.includes("cron_invocations")
  ) && (
    message.includes("does not exist") ||
    causeMessage.includes("does not exist") ||
    message.includes("relation") ||
    causeCode === "42P01"
  );
}

export async function markAbandonedCronInvocations(
  db: Database = getDb(),
  now = new Date(),
): Promise<number> {
  let marked = 0;

  try {
    for (const job of CRON_JOBS) {
      const abandonedAfterMs = job.maxDurationSeconds * 1000 + ABANDONED_INVOCATION_BUFFER_MS;
      const cutoff = new Date(now.getTime() - abandonedAfterMs);
      const rows = await db
        .update(schema.cronInvocations)
        .set({
          finishedAt: sql<Date>`${schema.cronInvocations.receivedAt} + (${abandonedAfterMs} * interval '1 millisecond')`,
          durationMs: abandonedAfterMs,
          outcome: "failed",
          errorSummary: `${ABANDONED_CRON_INVOCATION_ERROR} Threshold: ${job.maxDurationSeconds}s maxDuration + 60s buffer.`,
          metadata: sql`${schema.cronInvocations.metadata} || ${JSON.stringify({
            abandoned: true,
            abandonedAt: now.toISOString(),
            abandonedBy: "cron_watchdog",
            abandonedReason: "maxDuration_exceeded",
          })}::jsonb`,
        })
        .where(and(
          eq(schema.cronInvocations.jobKey, job.key),
          eq(schema.cronInvocations.outcome, "running"),
          lt(schema.cronInvocations.receivedAt, cutoff),
        ))
        .returning({ id: schema.cronInvocations.id });
      marked += rows.length;
    }
  } catch (error) {
    if (isMissingCronInvocationsTable(error)) {
      console.info("cron_invocations table is unavailable; abandoned invocation cleanup skipped.");
      return marked;
    }
    throw error;
  }

  return marked;
}

export async function withCronInvocationAudit(
  input: AuditInput,
  handler: () => Promise<Response>,
): Promise<Response> {
  const started = await startInvocation(input);
  try {
    const response = await handler();
    await finishInvocation(started, response);
    return response;
  } catch (error) {
    const message = error instanceof Error ? error.message : "Cron invocation failed";
    const response = Response.json({ error: message }, { status: 500 });
    await finishInvocation(started, response);
    return response;
  }
}
