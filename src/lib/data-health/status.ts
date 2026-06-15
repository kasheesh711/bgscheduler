import type { CronJobDefinition } from "./cron-registry";
import type { CronInvocationOutcome, CronJobStatus, CronProofSource } from "./types";

const BANGKOK_OFFSET_MS = 7 * 60 * 60 * 1000;
const DAY_MS = 24 * 60 * 60 * 1000;
const STUCK_BUFFER_MS = 60 * 1000;

export interface RunEvidence {
  status: string;
  startedAt: Date;
  finishedAt: Date | null;
  errorSummary: string | null;
}

export interface InvocationEvidence {
  outcome: CronInvocationOutcome | string;
  receivedAt: Date;
  finishedAt: Date | null;
  durationMs: number | null;
  responseStatus: number | null;
  errorSummary: string | null;
}

export interface CronStatusInput {
  job: CronJobDefinition;
  now: Date;
  latestInvocation: InvocationEvidence | null;
  latestCronInvocation: InvocationEvidence | null;
  latestRun: RunEvidence | null;
  latestSuccessfulRun: RunEvidence | null;
  latestFailedRun: RunEvidence | null;
  runningRun: RunEvidence | null;
}

export interface CronStatusResult {
  status: CronJobStatus;
  proof: CronProofSource;
  proofLabel: string;
  lastSeenAt: Date | null;
  lastSuccessAt: Date | null;
  lastFailureAt: Date | null;
  nextExpectedAt: Date | null;
  lastExpectedAt: Date | null;
  lateAfterAt: Date | null;
  durationMs: number | null;
  responseStatus: number | null;
  errorSummary: string | null;
  healthDetail: string;
}

function dateMax(values: Array<Date | null | undefined>): Date | null {
  const dates = values.filter((value): value is Date => value instanceof Date);
  if (!dates.length) return null;
  return new Date(Math.max(...dates.map((date) => date.getTime())));
}

function minutesFromSchedule(schedule: string | null): number[] {
  if (!schedule) return [];
  const first = schedule.split(/\s+/)[0] ?? "";
  if (first.startsWith("*/")) {
    const interval = Number(first.slice(2));
    if (!Number.isFinite(interval) || interval <= 0) return [];
    return Array.from({ length: Math.ceil(60 / interval) }, (_, index) => index * interval).filter((value) => value < 60);
  }
  return first
    .split(",")
    .map((value) => Number(value))
    .filter((value) => Number.isInteger(value) && value >= 0 && value < 60);
}

function intervalExpectation(job: CronJobDefinition, now: Date) {
  const minutes = minutesFromSchedule(job.schedule);
  if (!minutes.length) return { lastExpectedAt: null, nextExpectedAt: null, lateAfterAt: null };

  const currentHour = new Date(now);
  currentHour.setUTCMinutes(0, 0, 0);
  const candidates: Date[] = [];
  for (let hourOffset = -2; hourOffset <= 2; hourOffset += 1) {
    for (const minute of minutes) {
      const candidate = new Date(currentHour.getTime() + hourOffset * 60 * 60 * 1000);
      candidate.setUTCMinutes(minute, 0, 0);
      candidates.push(candidate);
    }
  }
  candidates.sort((a, b) => a.getTime() - b.getTime());
  const lastExpectedAt = [...candidates].reverse().find((candidate) => candidate.getTime() <= now.getTime()) ?? null;
  const nextExpectedAt = candidates.find((candidate) => candidate.getTime() > now.getTime()) ?? null;
  const lateAfterAt = lastExpectedAt
    ? new Date(lastExpectedAt.getTime() + job.lateAfterMinutes * 60 * 1000)
    : null;
  return { lastExpectedAt, nextExpectedAt, lateAfterAt };
}

function bangkokParts(now: Date) {
  const shifted = new Date(now.getTime() + BANGKOK_OFFSET_MS);
  return {
    year: shifted.getUTCFullYear(),
    month: shifted.getUTCMonth(),
    day: shifted.getUTCDate(),
    weekday: shifted.getUTCDay(),
    minuteOfDay: shifted.getUTCHours() * 60 + shifted.getUTCMinutes(),
  };
}

function bangkokLocalInstant(year: number, month: number, day: number, minuteOfDay: number): Date {
  const hour = Math.floor(minuteOfDay / 60);
  const minute = minuteOfDay % 60;
  return new Date(Date.UTC(year, month, day, hour - 7, minute, 0, 0));
}

function dailyExpectation(job: CronJobDefinition, now: Date) {
  const parts = bangkokParts(now);
  const startMinute = job.expectedBangkokWindowStartMinute ?? job.expectedBangkokMinute;
  const endMinute = job.expectedBangkokWindowEndMinute ?? job.expectedBangkokMinute;
  if (startMinute === undefined || endMinute === undefined) {
    return { lastExpectedAt: null, nextExpectedAt: null, lateAfterAt: null };
  }

  const todayStart = bangkokLocalInstant(parts.year, parts.month, parts.day, startMinute);
  const todayEnd = bangkokLocalInstant(parts.year, parts.month, parts.day, endMinute);
  const hasTodaysWindowStarted = now.getTime() >= todayStart.getTime();

  const lastExpectedAt = hasTodaysWindowStarted
    ? todayStart
    : new Date(todayStart.getTime() - 24 * 60 * 60 * 1000);
  const windowEnd = hasTodaysWindowStarted
    ? todayEnd
    : new Date(todayEnd.getTime() - 24 * 60 * 60 * 1000);
  const nextExpectedAt = hasTodaysWindowStarted
    ? new Date(todayStart.getTime() + 24 * 60 * 60 * 1000)
    : todayStart;
  const lateAfterAt = new Date(windowEnd.getTime() + job.lateAfterMinutes * 60 * 1000);

  return { lastExpectedAt, nextExpectedAt, lateAfterAt };
}

function weeklyExpectation(job: CronJobDefinition, now: Date) {
  const targetWeekday = job.expectedBangkokWeekday;
  const parts = bangkokParts(now);
  const startMinute = job.expectedBangkokWindowStartMinute ?? job.expectedBangkokMinute;
  const endMinute = job.expectedBangkokWindowEndMinute ?? job.expectedBangkokMinute;
  if (targetWeekday === undefined || startMinute === undefined || endMinute === undefined) {
    return { lastExpectedAt: null, nextExpectedAt: null, lateAfterAt: null };
  }

  const todayStart = bangkokLocalInstant(parts.year, parts.month, parts.day, startMinute);
  const todayEnd = bangkokLocalInstant(parts.year, parts.month, parts.day, endMinute);
  const daysSinceTarget = (parts.weekday - targetWeekday + 7) % 7;
  const currentWeekStart = new Date(todayStart.getTime() - daysSinceTarget * DAY_MS);
  const currentWeekEnd = new Date(todayEnd.getTime() - daysSinceTarget * DAY_MS);
  const hasCurrentWeekWindowStarted = now.getTime() >= currentWeekStart.getTime();

  const lastExpectedAt = hasCurrentWeekWindowStarted
    ? currentWeekStart
    : new Date(currentWeekStart.getTime() - 7 * DAY_MS);
  const windowEnd = hasCurrentWeekWindowStarted
    ? currentWeekEnd
    : new Date(currentWeekEnd.getTime() - 7 * DAY_MS);
  const nextExpectedAt = hasCurrentWeekWindowStarted
    ? new Date(currentWeekStart.getTime() + 7 * DAY_MS)
    : currentWeekStart;
  const lateAfterAt = new Date(windowEnd.getTime() + job.lateAfterMinutes * 60 * 1000);

  return { lastExpectedAt, nextExpectedAt, lateAfterAt };
}

export function expectedWindowForJob(job: CronJobDefinition, now: Date) {
  if (job.manualOnly) return { lastExpectedAt: null, nextExpectedAt: null, lateAfterAt: null };
  if (job.expectedBangkokWeekday !== undefined) {
    return weeklyExpectation(job, now);
  }
  if (job.expectedBangkokMinute !== undefined || job.expectedBangkokWindowStartMinute !== undefined) {
    return dailyExpectation(job, now);
  }
  return intervalExpectation(job, now);
}

function invocationIsFailure(invocation: InvocationEvidence | null): boolean {
  if (!invocation) return false;
  return invocation.outcome === "failed";
}

function invocationIsRunning(invocation: InvocationEvidence | null): boolean {
  return invocation?.outcome === "running";
}

function runIsFailure(run: RunEvidence | null): boolean {
  return run?.status === "failed";
}

function runIsRunning(run: RunEvidence | null): boolean {
  return run?.status === "running";
}

export function evaluateCronJobStatus(input: CronStatusInput): CronStatusResult {
  const { job, now } = input;
  const { lastExpectedAt, nextExpectedAt, lateAfterAt } = expectedWindowForJob(job, now);

  if (job.manualOnly) {
    const lastSeenAt = input.latestRun?.startedAt ?? input.latestInvocation?.receivedAt ?? null;
    return {
      status: "manual-only",
      proof: lastSeenAt ? (input.latestInvocation ? "direct" : "inferred") : "none",
      proofLabel: lastSeenAt ? "Manual run evidence" : "No automatic schedule",
      lastSeenAt,
      lastSuccessAt: input.latestSuccessfulRun?.finishedAt ?? null,
      lastFailureAt: input.latestFailedRun?.finishedAt ?? null,
      nextExpectedAt: null,
      lastExpectedAt: null,
      lateAfterAt: null,
      durationMs: input.latestInvocation?.durationMs ?? null,
      responseStatus: input.latestInvocation?.responseStatus ?? null,
      errorSummary: input.latestRun?.errorSummary ?? input.latestInvocation?.errorSummary ?? null,
      healthDetail: "Not listed in vercel.json; runs only from manual controls.",
    };
  }

  const latestDirect = input.latestCronInvocation;
  const latestRun = input.latestRun;
  const proof: CronProofSource = latestDirect ? "direct" : latestRun ? "inferred" : "none";
  const lastSeenAt = latestDirect?.receivedAt ?? latestRun?.startedAt ?? null;
  const latestRunningAt = invocationIsRunning(latestDirect)
    ? latestDirect?.receivedAt
    : runIsRunning(input.runningRun)
      ? input.runningRun?.startedAt
      : null;
  const latestSuccessAt = dateMax([
    latestDirect?.outcome === "success" || latestDirect?.outcome === "skipped" ? latestDirect.finishedAt ?? latestDirect.receivedAt : null,
    input.latestSuccessfulRun?.finishedAt ?? null,
  ]);
  const latestFailureAt = dateMax([
    latestDirect && invocationIsFailure(latestDirect) ? latestDirect.finishedAt ?? latestDirect.receivedAt : null,
    input.latestFailedRun?.finishedAt ?? null,
  ]);
  const hasRecentFailure =
    latestFailureAt !== null &&
    (latestSuccessAt === null || latestFailureAt.getTime() > latestSuccessAt.getTime());
  const runningStuckAt = latestRunningAt
    ? new Date(latestRunningAt.getTime() + job.maxDurationSeconds * 1000 + STUCK_BUFFER_MS)
    : null;

  if (latestRunningAt && runningStuckAt && now.getTime() > runningStuckAt.getTime()) {
    return {
      status: "failing",
      proof,
      proofLabel: proof === "direct" ? "Direct cron audit" : "Run-table inference",
      lastSeenAt,
      lastSuccessAt: latestSuccessAt,
      lastFailureAt: latestFailureAt,
      nextExpectedAt,
      lastExpectedAt,
      lateAfterAt,
      durationMs: latestDirect?.durationMs ?? null,
      responseStatus: latestDirect?.responseStatus ?? null,
      errorSummary: latestRun?.errorSummary ?? latestDirect?.errorSummary ?? "Run appears stuck past maxDuration.",
      healthDetail: `Running longer than ${job.maxDurationSeconds}s maxDuration.`,
    };
  }

  if (latestRunningAt) {
    return {
      status: "running",
      proof,
      proofLabel: proof === "direct" ? "Direct cron audit" : "Run-table inference",
      lastSeenAt,
      lastSuccessAt: latestSuccessAt,
      lastFailureAt: latestFailureAt,
      nextExpectedAt,
      lastExpectedAt,
      lateAfterAt,
      durationMs: latestDirect?.durationMs ?? null,
      responseStatus: latestDirect?.responseStatus ?? null,
      errorSummary: latestRun?.errorSummary ?? latestDirect?.errorSummary ?? null,
      healthDetail: "A run is currently in progress.",
    };
  }

  if (proof === "none") {
    return {
      status: "unknown",
      proof,
      proofLabel: "No run evidence",
      lastSeenAt: null,
      lastSuccessAt: null,
      lastFailureAt: null,
      nextExpectedAt,
      lastExpectedAt,
      lateAfterAt,
      durationMs: null,
      responseStatus: null,
      errorSummary: null,
      healthDetail: "No invocation or run-table evidence found.",
    };
  }

  if (hasRecentFailure || invocationIsFailure(latestDirect) || runIsFailure(latestRun)) {
    return {
      status: "failing",
      proof,
      proofLabel: proof === "direct" ? "Direct cron audit" : "Run-table inference",
      lastSeenAt,
      lastSuccessAt: latestSuccessAt,
      lastFailureAt: latestFailureAt,
      nextExpectedAt,
      lastExpectedAt,
      lateAfterAt,
      durationMs: latestDirect?.durationMs ?? null,
      responseStatus: latestDirect?.responseStatus ?? null,
      errorSummary: latestRun?.errorSummary ?? latestDirect?.errorSummary ?? null,
      healthDetail: "Latest observed run failed after the latest success.",
    };
  }

  const isDailyWindow =
    job.expectedBangkokMinute !== undefined ||
    job.expectedBangkokWindowStartMinute !== undefined;
  const usesCalendarWindow = isDailyWindow || job.expectedBangkokWeekday !== undefined;
  const intervalEvidenceTooOld =
    !usesCalendarWindow &&
    lastSeenAt !== null &&
    now.getTime() - lastSeenAt.getTime() > job.lateAfterMinutes * 60 * 1000;
  const missedExpectedWindow =
    lateAfterAt !== null &&
    lastExpectedAt !== null &&
    now.getTime() > lateAfterAt.getTime() &&
    (lastSeenAt === null || lastSeenAt.getTime() < lastExpectedAt.getTime());

  if (intervalEvidenceTooOld || missedExpectedWindow) {
    return {
      status: "late",
      proof,
      proofLabel: proof === "direct" ? "Direct cron audit" : "Run-table inference",
      lastSeenAt,
      lastSuccessAt: latestSuccessAt,
      lastFailureAt: latestFailureAt,
      nextExpectedAt,
      lastExpectedAt,
      lateAfterAt,
      durationMs: latestDirect?.durationMs ?? null,
      responseStatus: latestDirect?.responseStatus ?? null,
      errorSummary: latestRun?.errorSummary ?? latestDirect?.errorSummary ?? null,
      healthDetail: "No observed run for the latest expected schedule window.",
    };
  }

  return {
    status: "healthy",
    proof,
    proofLabel: proof === "direct" ? "Direct cron audit" : "Run-table inference until cron audit rows accumulate",
    lastSeenAt,
    lastSuccessAt: latestSuccessAt,
    lastFailureAt: latestFailureAt,
    nextExpectedAt,
    lastExpectedAt,
    lateAfterAt,
    durationMs: latestDirect?.durationMs ?? null,
    responseStatus: latestDirect?.responseStatus ?? null,
    errorSummary: latestRun?.errorSummary ?? latestDirect?.errorSummary ?? null,
    healthDetail: proof === "direct"
      ? "Cron audit confirms this route fired recently."
      : "No cron audit row yet; using durable run-table cadence evidence.",
  };
}
