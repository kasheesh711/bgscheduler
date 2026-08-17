// ----------------------------------------------------------------------------
// LINE credit-runout digest — once daily, pushed into every staff group that
// opted in via `/credit setup` (credit-bot.ts).
//
// Flags two things, per package on the active credit-control snapshot:
//   • runs out  — walking the package's UPCOMING sessions in Bangkok date
//                 order, deducting durationMinutes/60 each (the dashboard's
//                 projection rule), the balance first hits ≤ 0 within the next
//                 7 days.
//   • already out — the balance is ≤ 0 right now and classes are still
//                 scheduled.
//
// Balances are raw Wise remainingCredits — consistent with /credit replies and
// the Parent Report, deliberately NOT the dashboard's adjusted-remaining. The
// dashboard can therefore flag a student a class or two earlier than this
// digest when feedback-pending deductions exist.
//
// Bangkok-safe by construction: sessions are bucketed by bangkokDateKey and
// fed to computeProjection as Bangkok-midnight instants, and only the NUMERIC
// daysUntilExhaust is consumed — the engine's date strings go through a
// process-local formatter and are off by one on a UTC server.
//
// Once-per-day idempotency mirrors the progress-test admin digest: a terminal
// line_credit_digest_runs row for the date short-circuits any re-run, and the
// per-(date, group) deterministic push retry key makes a webhook-level retry a
// no-op even without the row.
// ----------------------------------------------------------------------------

import { v5 as uuidv5 } from "uuid";
import { and, desc, eq, isNull } from "drizzle-orm";

import { getDb, type Database } from "@/lib/db";
import * as schema from "@/lib/db/schema";
import { lineSchedulerEnabled, pushLineTextMessage } from "@/lib/line/client";
import { computeProjection } from "@/lib/credit-control/projection";
import {
  addBangkokDays,
  bangkokDateKey,
  bangkokDateStartUtc,
  todayBangkok,
} from "@/lib/room-capacity/dates";
import { parseStudentDisplay } from "@/lib/student-schedule/data";
import {
  creditDigestMessage,
  type CreditDigestAlreadyOutRow,
  type CreditDigestRunOutRow,
} from "@/lib/line/schedule-bot-copy";

/** Own namespace so credit retry keys can never collide with schedule-bot ones. */
const LINE_CREDIT_DIGEST_RETRY_NAMESPACE = "b3a9d7c2-8e14-4f6b-a5d0-2c7f9e1b6a38";

const DEFAULT_BASE_URL = "https://bgscheduler.vercel.app";
const RUNOUT_WINDOW_DAYS = 7;

export interface LineCreditDigestResult {
  status: "sent" | "partial" | "failed" | "skipped";
  digestDate: string;
  digestRunId: string | null;
  runsOutCount: number;
  alreadyOutCount: number;
  groupCount: number;
  attempted: number;
  success: number;
  failed: number;
  message: string;
}

export interface CreditRunoutInput {
  packages: Array<{
    studentKey: string;
    packageKey: string;
    studentName: string;
    subject: string;
    packageName: string;
    remainingCredits: number;
  }>;
  sessions: Array<{
    packageKey: string;
    scheduledStartTime: Date;
    durationMinutes: number;
  }>;
  inactiveStudentKeys: ReadonlySet<string>;
  /** "YYYY-MM-DD", the Bangkok calendar day the digest runs on. */
  todayBkk: string;
  windowDays?: number;
}

export interface CreditRunouts {
  runsOut: CreditDigestRunOutRow[];
  alreadyOut: CreditDigestAlreadyOutRow[];
}

function digestLabel(studentName: string): string {
  return parseStudentDisplay(studentName).code ?? studentName;
}

/**
 * Pure classification of every package into the two digest buckets.
 *
 * 1. Sessions are grouped per package, bucketed to Bangkok calendar days, and
 *    zero/negative durations default to 60 minutes (same guard the dashboard
 *    applies before dividing by 60).
 * 2. A package at ≤ 0 with any class today-or-later is "already out" — no
 *    projection needed, the family is out right now with classes booked.
 * 3. Otherwise the projection walks strictly-future Bangkok days (mirroring
 *    the dashboard's `date > today` filter) and the package lands in
 *    "runs out" when the balance first reaches ≤ 0 within `windowDays`.
 * 4. Inactive students are skipped entirely; a package at ≤ 0 with no
 *    upcoming classes is not reported (nothing at stake in the window).
 */
export function computeCreditRunouts(input: CreditRunoutInput): CreditRunouts {
  const windowDays = input.windowDays ?? RUNOUT_WINDOW_DAYS;
  const todayInstant = bangkokDateStartUtc(input.todayBkk);

  const sessionsByPackage = new Map<string, Array<{ bkk: string; durationMin: number }>>();
  for (const session of input.sessions) {
    const list = sessionsByPackage.get(session.packageKey) ?? [];
    list.push({
      bkk: bangkokDateKey(session.scheduledStartTime),
      durationMin: session.durationMinutes > 0 ? session.durationMinutes : 60,
    });
    sessionsByPackage.set(session.packageKey, list);
  }

  const runsOut: CreditDigestRunOutRow[] = [];
  const alreadyOut: CreditDigestAlreadyOutRow[] = [];

  for (const pkg of input.packages) {
    if (input.inactiveStudentKeys.has(pkg.studentKey)) continue;

    const upcoming = (sessionsByPackage.get(pkg.packageKey) ?? [])
      .filter((session) => session.bkk >= input.todayBkk)
      .sort((a, b) => a.bkk.localeCompare(b.bkk));
    if (upcoming.length === 0) continue;

    const label = digestLabel(pkg.studentName);
    const subject = pkg.subject || pkg.packageName;

    if (pkg.remainingCredits <= 0) {
      alreadyOut.push({
        label,
        subject,
        remainingCredits: pkg.remainingCredits,
        nextClassBkk: upcoming[0].bkk,
      });
      continue;
    }

    const projectable = upcoming
      .filter((session) => session.bkk > input.todayBkk)
      .map((session) => ({
        date: bangkokDateStartUtc(session.bkk),
        durationMin: session.durationMin,
      }));
    const projection = computeProjection(pkg.remainingCredits, projectable, todayInstant);
    if (
      projection.daysUntilExhaust !== null &&
      projection.daysUntilExhaust >= 1 &&
      projection.daysUntilExhaust <= windowDays
    ) {
      runsOut.push({
        exhaustDateBkk: addBangkokDays(input.todayBkk, projection.daysUntilExhaust),
        label,
        subject,
        remainingCredits: pkg.remainingCredits,
      });
    }
  }

  runsOut.sort((a, b) =>
    a.exhaustDateBkk.localeCompare(b.exhaustDateBkk) || a.label.localeCompare(b.label));
  alreadyOut.sort((a, b) =>
    a.nextClassBkk.localeCompare(b.nextClassBkk) || a.label.localeCompare(b.label));

  return { runsOut, alreadyOut };
}

async function activeSnapshot(
  db: Database,
): Promise<{ id: string; generatedAt: Date } | null> {
  const [snapshot] = await db
    .select({
      id: schema.creditControlSnapshots.id,
      generatedAt: schema.creditControlSnapshots.generatedAt,
    })
    .from(schema.creditControlSnapshots)
    .where(eq(schema.creditControlSnapshots.active, true))
    .orderBy(desc(schema.creditControlSnapshots.generatedAt))
    .limit(1);
  return snapshot ?? null;
}

/** Any run row for the date — sent, partial, failed, or skipped — is terminal. */
async function hasTerminalDigestForDate(db: Database, digestDate: string): Promise<boolean> {
  const rows = await db
    .select({ id: schema.lineCreditDigestRuns.id })
    .from(schema.lineCreditDigestRuns)
    .where(eq(schema.lineCreditDigestRuns.digestDate, digestDate))
    .limit(1);
  return rows.length > 0;
}

/** Inserts the per-date run row; null on the 23505 of a lost concurrent race. */
async function createDigestRun(
  db: Database,
  input: { digestDate: string; runsOutCount: number; alreadyOutCount: number; groupCount: number },
): Promise<{ id: string } | null> {
  try {
    const [run] = await db
      .insert(schema.lineCreditDigestRuns)
      .values({
        digestDate: input.digestDate,
        idempotencyKey: `line-credit-digest:${input.digestDate}`,
        runsOutCount: input.runsOutCount,
        alreadyOutCount: input.alreadyOutCount,
        groupCount: input.groupCount,
      })
      .returning({ id: schema.lineCreditDigestRuns.id });
    return run ?? null;
  } catch (error) {
    if (typeof error === "object" && error !== null && "code" in error
      && (error as { code?: unknown }).code === "23505") {
      return null;
    }
    throw error;
  }
}

/**
 * Computes today's run-outs and pushes the digest into every registered staff
 * group. Never throws for expected states (disabled, no snapshot, already ran,
 * nothing registered) — those come back as `skipped` so the cron route stays a
 * 200 and the audit trail explains itself.
 */
export async function sendLineCreditDigest(
  db: Database = getDb(),
  now: Date = new Date(),
  overrides: { push?: typeof pushLineTextMessage; baseUrl?: string } = {},
): Promise<LineCreditDigestResult> {
  const digestDate = todayBangkok(now);
  const base = (counts: Partial<LineCreditDigestResult> = {}): LineCreditDigestResult => ({
    status: "skipped",
    digestDate,
    digestRunId: null,
    runsOutCount: 0,
    alreadyOutCount: 0,
    groupCount: 0,
    attempted: 0,
    success: 0,
    failed: 0,
    message: "",
    ...counts,
  });

  if (!lineSchedulerEnabled()) {
    return base({ message: "LINE scheduler is disabled; credit digest not sent." });
  }

  if (await hasTerminalDigestForDate(db, digestDate)) {
    return base({ message: "LINE credit digest already recorded for this date." });
  }

  const snapshot = await activeSnapshot(db);
  if (!snapshot) {
    // No terminal row on purpose: a snapshot appearing later the same day
    // should be able to produce the digest on a manual re-run.
    return base({ message: "No active credit-control snapshot; credit digest not sent." });
  }

  const [packages, sessions, inactiveRows, groups] = await Promise.all([
    db
      .select({
        studentKey: schema.creditControlPackages.studentKey,
        packageKey: schema.creditControlPackages.packageKey,
        studentName: schema.creditControlPackages.studentName,
        subject: schema.creditControlPackages.subject,
        packageName: schema.creditControlPackages.packageName,
        remainingCredits: schema.creditControlPackages.remainingCredits,
      })
      .from(schema.creditControlPackages)
      .where(and(
        eq(schema.creditControlPackages.snapshotId, snapshot.id),
        isNull(schema.creditControlPackages.excludedReason),
      )),
    db
      .select({
        packageKey: schema.creditControlSessions.packageKey,
        scheduledStartTime: schema.creditControlSessions.scheduledStartTime,
        durationMinutes: schema.creditControlSessions.durationMinutes,
      })
      .from(schema.creditControlSessions)
      .where(and(
        eq(schema.creditControlSessions.snapshotId, snapshot.id),
        eq(schema.creditControlSessions.sessionKind, "future"),
        eq(schema.creditControlSessions.meetingStatus, "UPCOMING"),
      )),
    db
      .select({ studentKey: schema.creditControlInactiveStudents.studentKey })
      .from(schema.creditControlInactiveStudents),
    db
      .select({ groupId: schema.lineGroupSettings.groupId })
      .from(schema.lineGroupSettings)
      .where(and(
        // Re-checked at send time: a chat later flipped to family (or an
        // unexpected audience value) drops off the target list (CRED-BOT-G1).
        eq(schema.lineGroupSettings.audience, "staff"),
        eq(schema.lineGroupSettings.creditDigestEnabled, true),
      )),
  ]);

  const { runsOut, alreadyOut } = computeCreditRunouts({
    packages,
    sessions,
    inactiveStudentKeys: new Set(inactiveRows.map((row) => row.studentKey)),
    todayBkk: digestDate,
  });
  const counts = { runsOutCount: runsOut.length, alreadyOutCount: alreadyOut.length };

  if (groups.length === 0) {
    const run = await createDigestRun(db, { digestDate, ...counts, groupCount: 0 });
    if (run) {
      await db
        .update(schema.lineCreditDigestRuns)
        .set({ status: "skipped", updatedAt: new Date() })
        .where(eq(schema.lineCreditDigestRuns.id, run.id));
    }
    return base({
      ...counts,
      digestRunId: run?.id ?? null,
      message: "No staff group has the credit digest enabled (/credit setup).",
    });
  }

  const run = await createDigestRun(db, { digestDate, ...counts, groupCount: groups.length });
  if (!run) {
    return base({ ...counts, message: "LINE credit digest was already created concurrently." });
  }

  const baseUrl = overrides.baseUrl
    ?? process.env.APP_BASE_URL?.trim()
    ?? DEFAULT_BASE_URL;
  const text = creditDigestMessage({
    digestDateBkk: digestDate,
    runsOut,
    alreadyOut,
    dashboardUrl: `${baseUrl}/credit-control`,
    generatedAt: snapshot.generatedAt,
  });

  const push = overrides.push ?? pushLineTextMessage;
  const sendCounts = { attempted: 0, success: 0, failed: 0 };
  let lastError: string | null = null;
  for (const group of groups) {
    sendCounts.attempted += 1;
    try {
      await push({
        to: group.groupId,
        text,
        retryKey: uuidv5(
          `line-credit-digest:${digestDate}:${group.groupId}`,
          LINE_CREDIT_DIGEST_RETRY_NAMESPACE,
        ),
      });
      sendCounts.success += 1;
    } catch (error) {
      sendCounts.failed += 1;
      lastError = error instanceof Error ? error.message : "LINE credit digest push failed";
      console.error("[credit-digest] push failed", error);
    }
  }

  const status = sendCounts.failed > 0
    ? (sendCounts.success > 0 ? "partial" : "failed")
    : "sent";
  await db
    .update(schema.lineCreditDigestRuns)
    .set({
      status,
      attemptedCount: sendCounts.attempted,
      successCount: sendCounts.success,
      failedCount: sendCounts.failed,
      lastError,
      sentAt: sendCounts.success > 0 ? new Date() : null,
      updatedAt: new Date(),
    })
    .where(eq(schema.lineCreditDigestRuns.id, run.id));

  return {
    status,
    digestDate,
    digestRunId: run.id,
    ...counts,
    groupCount: groups.length,
    ...sendCounts,
    message: `LINE credit digest ${status} (${runsOut.length} running out, ${alreadyOut.length} already out, ${groups.length} ${groups.length === 1 ? "group" : "groups"}).`,
  };
}
