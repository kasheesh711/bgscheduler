import { and, desc, eq, inArray } from "drizzle-orm";
import type { Database } from "@/lib/db";
import { ptJobs } from "@/lib/db/schema";
import type { Scope } from "./access";
import { releaseFormattingTimings } from "./format-benchmarks";

export const FORMAT_STAGES = ["queued", "reading", "formatting", "building", "checking", "ready"] as const;
export const FORMAT_STAGE_LABELS: Record<string, string> = { queued: "Queued", converting: "Converting your original DOCX", reading: "Reading paper", formatting: "Formatting", building: "Building PDF", checking: "Checking", ready: "Ready" };
export function estimateRemaining(elapsedMs: number, samples: number[]) {
  if (samples.length < 3) return null;
  const sorted = [...samples].sort((a, b) => a - b);
  const low = sorted[Math.floor((sorted.length - 1) * .2)], high = sorted[Math.ceil((sorted.length - 1) * .9)];
  return { minSeconds: Math.max(0, Math.round((low - elapsedMs) / 1000)), maxSeconds: Math.max(0, Math.round((high - elapsedMs) / 1000)), takingLonger: elapsedMs > high };
}
export async function jobProgress(job: typeof ptJobs.$inferSelect, scope: Scope, db: Database) {
  const completed = job.kind === "format-paper" ? await db.select({ checkpoint: ptJobs.checkpoint, timings: ptJobs.timings }).from(ptJobs)
    .where(and(eq(ptJobs.kind, "format-paper"), eq(ptJobs.status, "completed"), scope.keys === null ? undefined : inArray(ptJobs.ownerKey, scope.keys)))
    .orderBy(desc(ptJobs.finishedAt)).limit(40) : [];
  const pages = Number(job.checkpoint.pageCount ?? 0);
  const durations = completed.filter(j => j.checkpoint.model === job.checkpoint.model && j.checkpoint.reasoningEffort === job.checkpoint.reasoningEffort && pages > 0 && Number(j.checkpoint.pageCount) >= pages * .6 && Number(j.checkpoint.pageCount) <= pages * 1.5)
    .map(j => Object.values(j.timings).reduce((sum, n) => sum + n, 0)).filter(n => n > 0);
  const samples = durations.length >= 3 ? durations : releaseFormattingTimings(job.checkpoint.model, job.checkpoint.reasoningEffort, pages);
  const elapsedMs = (job.finishedAt?.getTime() ?? Date.now()) - job.createdAt.getTime();
  const processingMs = Object.values(job.timings).reduce((sum, n) => sum + n, 0) + (job.status === "running" && job.stageStartedAt ? Date.now() - job.stageStartedAt.getTime() : 0);
  const estimatedElapsedMs = durations.length >= 3 ? processingMs : Math.max(0, processingMs - (job.timings.reading ?? 0));
  return { id: job.id, targetId: job.targetId, kind: job.kind, expectedRevision: job.expectedRevision, status: job.status, stage: job.status === "completed" ? "ready" : job.stage, elapsedSeconds: Math.max(0, Math.floor(elapsedMs / 1000)),
    estimate: job.status === "running" ? estimateRemaining(estimatedElapsedMs, samples) : null,
    attempts: job.attempts, error: job.error, retryAt: job.status === "queued" && job.error ? job.availableAt.toISOString() : null,
    artifact: job.result ? { versionId: job.result.versionId, fileId: job.result.fileId, keyFileId: job.result.keyFileId } : null };
}
export type JobProgress = Awaited<ReturnType<typeof jobProgress>>;
