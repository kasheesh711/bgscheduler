import { eq } from "drizzle-orm";
import { getDb } from "@/lib/db";
import * as schema from "@/lib/db/schema";
import { getCronJobDefinition, type CronJobKey } from "./cron-registry";
import type { CronInvocationOutcome, CronTriggerSource } from "./types";

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
