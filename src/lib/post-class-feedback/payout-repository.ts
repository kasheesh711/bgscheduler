import "server-only";

import { and, asc, eq, gte, inArray, isNull, lt, ne, sql } from "drizzle-orm";

import { getDb, type Database } from "@/lib/db";
import * as schema from "@/lib/db/schema";

import { lockPostClassFinance } from "./actions";
import { PostClassConflictError } from "./errors";
import { payoutLineIdempotencyKey, type PayoutRunCoverage } from "./payout-plan";
import { payoutRunRangeUtc, type PayoutRunWindow } from "./payout-window";
import { withPostClassTransaction } from "./transaction";

// ── Payout run persistence ──────────────────────────────────────────────
//
// Database only: no Google calls, no network. The publish orchestrator keeps
// every transaction here short precisely so none of them is ever open while a
// Sheets or Drive request is in flight.

export type PayoutRun = typeof schema.postClassPayoutRuns.$inferSelect;
export type PayoutRunLine = typeof schema.postClassPayoutRunLines.$inferSelect;
export type PayoutTutorName = typeof schema.postClassPayoutTutorNames.$inferSelect;

export interface PayoutRunCandidate {
  deductionId: string;
  sessionId: string;
  canonicalTutorKey: string | null;
  tutorName: string | null;
  wiseSessionId: string;
  className: string | null;
  scheduledStartAt: Date;
  scheduledEndAt: Date;
  deadlineAt: Date;
  amountMinor: number;
  currency: string;
  defaultFinanceMonth: string | null;
  studentNames: string[];
  tutorSubmittedAt: Date | null;
  reason: string;
}

function anchorMonthDate(anchorMonth: string): string {
  return `${anchorMonth}-01`;
}

/**
 * Approved, unreversed deductions whose session ended inside the window.
 *
 * Only `approved` is publishable. `pending_review` has had no human decision,
 * and writing a negative number into someone's pay for an undecided item is the
 * one mistake here with no clean undo. `waived` is a decision not to deduct,
 * and `processed` means a previous run already published it.
 */
export async function selectPayoutRunCandidates(
  db: Database,
  window: PayoutRunWindow,
): Promise<PayoutRunCandidate[]> {
  const { start, endExclusive } = payoutRunRangeUtc(window);

  const rows = await db.select({
    deductionId: schema.postClassDeductions.id,
    amountMinor: schema.postClassDeductions.amountMinor,
    currency: schema.postClassDeductions.currency,
    defaultFinanceMonth: schema.postClassDeductions.defaultFinanceMonth,
    sessionId: schema.postClassSessions.id,
    wiseSessionId: schema.postClassSessions.wiseSessionId,
    canonicalTutorKey: schema.postClassSessions.canonicalTutorKey,
    tutorName: schema.postClassSessions.canonicalTutorName,
    className: schema.postClassSessions.className,
    scheduledStartAt: schema.postClassSessions.scheduledStartAt,
    scheduledEndAt: schema.postClassSessions.scheduledEndAt,
    deadlineAt: schema.postClassSessions.deadlineAt,
  })
    .from(schema.postClassDeductions)
    .innerJoin(
      schema.postClassSessions,
      eq(schema.postClassDeductions.sessionId, schema.postClassSessions.id),
    )
    // Reversal is DERIVED from the presence of an offset row: the reverse
    // action never updates `postClassDeductions.status`, which still reads
    // `processed` afterwards. Filtering on status alone would publish money
    // for a deduction that had been reversed.
    .leftJoin(
      schema.postClassDeductionOffsets,
      eq(schema.postClassDeductionOffsets.deductionId, schema.postClassDeductions.id),
    )
    .where(and(
      gte(schema.postClassSessions.scheduledEndAt, start),
      lt(schema.postClassSessions.scheduledEndAt, endExclusive),
      eq(schema.postClassDeductions.status, "approved"),
      isNull(schema.postClassDeductionOffsets.id),
    ))
    .orderBy(
      asc(schema.postClassSessions.canonicalTutorKey),
      asc(schema.postClassSessions.scheduledStartAt),
    );

  if (rows.length === 0) return [];
  const sessionIds = rows.map((row) => row.sessionId);

  const [participants, submissions, assessments] = await Promise.all([
    db.select({
      sessionId: schema.postClassSessionParticipants.sessionId,
      studentName: schema.postClassSessionParticipants.studentName,
    }).from(schema.postClassSessionParticipants)
      .where(inArray(schema.postClassSessionParticipants.sessionId, sessionIds)),
    // The tutor's own first submission. Auto-submitted events are excluded:
    // they are the system filling a gap, not evidence the tutor acted.
    db.select({
      sessionId: schema.postClassFeedbackEventLinks.sessionId,
      submittedAt: sql<string | null>`min(${schema.postClassFeedbackEventLinks.eventTimestamp})`,
    }).from(schema.postClassFeedbackEventLinks)
      .where(and(
        inArray(schema.postClassFeedbackEventLinks.sessionId, sessionIds),
        ne(schema.postClassFeedbackEventLinks.autoSubmitted, true),
      ))
      .groupBy(schema.postClassFeedbackEventLinks.sessionId),
    // The deduction carries no reason column; the dashboard derives it from the
    // latest assessment's field failures and this must read the same way.
    db.select({
      sessionId: schema.postClassAssessments.sessionId,
      fieldFailures: schema.postClassAssessments.fieldFailures,
      assessedAt: schema.postClassAssessments.assessedAt,
    }).from(schema.postClassAssessments)
      .where(inArray(schema.postClassAssessments.sessionId, sessionIds))
      .orderBy(asc(schema.postClassAssessments.assessedAt)),
  ]);

  const studentsBySession = new Map<string, string[]>();
  for (const row of participants) {
    const names = studentsBySession.get(row.sessionId) ?? [];
    if (!names.includes(row.studentName)) names.push(row.studentName);
    studentsBySession.set(row.sessionId, names);
  }
  const submittedBySession = new Map(
    submissions.map((row) => [row.sessionId, row.submittedAt ? new Date(row.submittedAt) : null]),
  );
  // Ordered ascending, so the last write per session is the latest assessment.
  const reasonBySession = new Map<string, string>();
  for (const row of assessments) {
    reasonBySession.set(
      row.sessionId,
      row.fieldFailures.join(", ") || "Feedback was incomplete at the deadline",
    );
  }

  return rows.map((row) => ({
    deductionId: row.deductionId,
    sessionId: row.sessionId,
    canonicalTutorKey: row.canonicalTutorKey,
    tutorName: row.tutorName,
    wiseSessionId: row.wiseSessionId,
    className: row.className,
    scheduledStartAt: row.scheduledStartAt,
    scheduledEndAt: row.scheduledEndAt,
    deadlineAt: row.deadlineAt,
    amountMinor: row.amountMinor,
    currency: row.currency,
    defaultFinanceMonth: row.defaultFinanceMonth,
    // Falls back to the class name for a 1-on-1 whose participant row is
    // missing, so the sheet match still has something to compare.
    studentNames: studentsBySession.get(row.sessionId)
      ?? (row.className ? [row.className] : []),
    tutorSubmittedAt: submittedBySession.get(row.sessionId) ?? null,
    reason: reasonBySession.get(row.sessionId) ?? "Feedback was incomplete at the deadline",
  }));
}

/** Everything the publish gate needs to judge whether the run is trustworthy. */
export async function computePayoutRunCoverage(
  db: Database,
  window: PayoutRunWindow,
  candidates: PayoutRunCandidate[],
  mappedTutorKeys: ReadonlySet<string>,
): Promise<PayoutRunCoverage> {
  const { start, endExclusive } = payoutRunRangeUtc(window);
  const inWindow = and(
    gte(schema.postClassSessions.scheduledEndAt, start),
    lt(schema.postClassSessions.scheduledEndAt, endExclusive),
  );

  const [[sessionCounts], [pending], [issues]] = await Promise.all([
    db.select({
      eligible: sql<number>`count(*) filter (where ${schema.postClassSessions.eligible})`,
      ready: sql<number>`count(*) filter (where ${schema.postClassSessions.eligible} and ${schema.postClassSessions.sourceStatus} = 'ready')`,
      unavailable: sql<number>`count(*) filter (where ${schema.postClassSessions.eligible} and ${schema.postClassSessions.sourceStatus} = 'unavailable')`,
      formDrift: sql<number>`count(*) filter (where ${schema.postClassSessions.eligible} and ${schema.postClassSessions.sourceStatus} = 'form_drift')`,
      identityReview: sql<number>`count(*) filter (where ${schema.postClassSessions.eligible} and ${schema.postClassSessions.sourceStatus} = 'identity_review')`,
    }).from(schema.postClassSessions).where(inWindow),
    db.select({ count: sql<number>`count(*)` })
      .from(schema.postClassDeductions)
      .innerJoin(
        schema.postClassSessions,
        eq(schema.postClassDeductions.sessionId, schema.postClassSessions.id),
      )
      .where(and(inWindow, eq(schema.postClassDeductions.status, "pending_review"))),
    db.select({ count: sql<number>`count(*)` })
      .from(schema.postClassSourceIssues)
      .where(and(
        eq(schema.postClassSourceIssues.scope, "global"),
        eq(schema.postClassSourceIssues.status, "open"),
        eq(schema.postClassSourceIssues.blocksEnforcement, true),
      )),
  ]);

  const unmapped = new Set<string>();
  let nullTutorKeyLines = 0;
  for (const candidate of candidates) {
    if (!candidate.canonicalTutorKey) nullTutorKeyLines += 1;
    else if (!mappedTutorKeys.has(candidate.canonicalTutorKey)) unmapped.add(candidate.canonicalTutorKey);
  }

  return {
    eligibleSessions: Number(sessionCounts?.eligible ?? 0),
    readySessions: Number(sessionCounts?.ready ?? 0),
    unavailableSessions: Number(sessionCounts?.unavailable ?? 0),
    formDriftSessions: Number(sessionCounts?.formDrift ?? 0),
    identityReviewSessions: Number(sessionCounts?.identityReview ?? 0),
    pendingReviewDeductions: Number(pending?.count ?? 0),
    approvedDeductions: candidates.length,
    unmappedTutorKeys: [...unmapped].toSorted(),
    nullTutorKeyLines,
    blockingGlobalSourceIssues: Number(issues?.count ?? 0),
  };
}

/**
 * Tutor → the exact identity strings the master ledger uses.
 *
 * A deduction only reaches a tutor's view if its ledger row carries one of
 * these verbatim, because that view filters on an exact string match.
 */
export async function loadPayoutTutorNames(
  db: Database,
): Promise<Map<string, PayoutTutorName>> {
  const rows = await db.select().from(schema.postClassPayoutTutorNames)
    .where(eq(schema.postClassPayoutTutorNames.active, true));
  return new Map(rows.map((row) => [row.canonicalKey, row]));
}

/** Both identity strings for one tutor, onsite first. */
export function payoutTutorNameStrings(mapping: PayoutTutorName): string[] {
  return [mapping.onsiteName, mapping.onlineName].filter(
    (name): name is string => Boolean(name && name.trim()),
  );
}

export async function upsertPayoutTutorName(db: Database, input: {
  canonicalKey: string;
  onsiteName: string;
  onlineName: string | null;
  active: boolean;
  updatedByEmail: string;
}): Promise<PayoutTutorName> {
  const [row] = await db.insert(schema.postClassPayoutTutorNames).values(input)
    .onConflictDoUpdate({
      target: schema.postClassPayoutTutorNames.canonicalKey,
      set: {
        onsiteName: input.onsiteName,
        onlineName: input.onlineName,
        active: input.active,
        updatedByEmail: input.updatedByEmail,
        updatedAt: new Date(),
      },
    }).returning();
  return row;
}

export async function getPayoutRunByAnchor(
  db: Database,
  anchorMonth: string,
): Promise<PayoutRun | null> {
  const [row] = await db.select().from(schema.postClassPayoutRuns)
    .where(eq(schema.postClassPayoutRuns.anchorMonth, anchorMonthDate(anchorMonth)))
    .limit(1);
  return row ?? null;
}

export async function loadPayoutRunLines(
  db: Database,
  runId: string,
): Promise<PayoutRunLine[]> {
  return db.select().from(schema.postClassPayoutRunLines)
    .where(eq(schema.postClassPayoutRunLines.runId, runId))
    .orderBy(
      asc(schema.postClassPayoutRunLines.canonicalTutorKey),
      asc(schema.postClassPayoutRunLines.scheduledStartAt),
    );
}

export interface PreparePayoutRunResult {
  run: PayoutRun;
  candidates: PayoutRunCandidate[];
  coverage: PayoutRunCoverage;
  tutorNames: Map<string, PayoutTutorName>;
  lines: PayoutRunLine[];
}

/**
 * One short transaction that establishes what this pass will work on.
 *
 * Takes the feature-wide finance lock so the selected set is consistent against
 * concurrent approvals and month closes — the same lock an ordinary approval
 * takes, held for about as long. No network call happens inside it.
 *
 * The run is a durable container rather than a one-shot event: re-running this
 * against a published run adds lines for deductions approved since, and resets
 * `failed` and `skipped` lines to `pending` so a retry re-evaluates them from a
 * fresh grid. Lines already `written` are never touched.
 */
export async function preparePayoutRunPass(input: {
  window: PayoutRunWindow;
  actorEmail: string;
  expectedVersion?: number;
}, db: Database = getDb()): Promise<PreparePayoutRunResult> {
  return withPostClassTransaction(db, async (tx) => {
    await lockPostClassFinance(tx);

    const anchor = anchorMonthDate(input.window.anchorMonth);
    await tx.insert(schema.postClassPayoutRuns).values({
      anchorMonth: anchor,
      windowStart: input.window.windowStart,
      windowEnd: input.window.windowEnd,
    }).onConflictDoNothing({ target: schema.postClassPayoutRuns.anchorMonth });

    const [run] = await tx.select().from(schema.postClassPayoutRuns)
      .where(eq(schema.postClassPayoutRuns.anchorMonth, anchor)).limit(1);

    if (input.expectedVersion !== undefined && run.version !== input.expectedVersion) {
      throw new PostClassConflictError(
        "This payout run changed since it was loaded. Refresh and try again.",
      );
    }

    const [candidates, tutorNames] = await Promise.all([
      selectPayoutRunCandidates(tx, input.window),
      loadPayoutTutorNames(tx),
    ]);
    const coverage = await computePayoutRunCoverage(
      tx,
      input.window,
      candidates,
      new Set(tutorNames.keys()),
    );

    const now = new Date();
    if (candidates.length > 0) {
      await tx.insert(schema.postClassPayoutRunLines).values(candidates.map((candidate) => ({
        runId: run.id,
        deductionId: candidate.deductionId,
        sessionId: candidate.sessionId,
        canonicalTutorKey: candidate.canonicalTutorKey,
        tutorName: candidate.tutorName,
        wiseSessionId: candidate.wiseSessionId,
        studentNames: candidate.studentNames,
        scheduledStartAt: candidate.scheduledStartAt,
        deadlineAt: candidate.deadlineAt,
        tutorSubmittedAt: candidate.tutorSubmittedAt,
        amountMinor: candidate.amountMinor,
        currency: candidate.currency,
        reason: candidate.reason,
        idempotencyKey: payoutLineIdempotencyKey({
          runId: run.id,
          deductionId: candidate.deductionId,
        }),
      }))).onConflictDoNothing({
        target: [
          schema.postClassPayoutRunLines.runId,
          schema.postClassPayoutRunLines.deductionId,
        ],
      });
    }

    // A deduction that stopped being publishable between passes — waived, or
    // reversed — must not be written. Its line is retired rather than removed,
    // so the run still records that it was considered.
    const publishableIds = new Set(candidates.map((candidate) => candidate.deductionId));
    const existing = await tx.select().from(schema.postClassPayoutRunLines)
      .where(eq(schema.postClassPayoutRunLines.runId, run.id));
    const retired = existing.filter((line) =>
      line.writeStatus !== "written" && !publishableIds.has(line.deductionId));
    if (retired.length > 0) {
      await tx.update(schema.postClassPayoutRunLines).set({
        matchStatus: "no_sheet",
        writeStatus: "skipped",
        writeError: "The deduction is no longer approved.",
        updatedAt: now,
      }).where(inArray(
        schema.postClassPayoutRunLines.id,
        retired.map((line) => line.id),
      ));
    }

    // Reset everything not yet written so this pass re-evaluates it against a
    // freshly read grid. `written` lines are deliberately excluded.
    await tx.update(schema.postClassPayoutRunLines).set({
      matchStatus: "pending",
      writeStatus: "pending",
      writeError: null,
      updatedAt: now,
    }).where(and(
      eq(schema.postClassPayoutRunLines.runId, run.id),
      ne(schema.postClassPayoutRunLines.writeStatus, "written"),
      ne(schema.postClassPayoutRunLines.writeStatus, "skipped"),
    ));

    const [claimed] = await tx.update(schema.postClassPayoutRuns).set({
      version: run.version + 1,
      updatedAt: now,
    }).where(and(
      eq(schema.postClassPayoutRuns.id, run.id),
      eq(schema.postClassPayoutRuns.version, run.version),
    )).returning();
    if (!claimed) {
      throw new PostClassConflictError(
        "Another publish is already running for this payout month.",
      );
    }

    const lines = await tx.select().from(schema.postClassPayoutRunLines)
      .where(eq(schema.postClassPayoutRunLines.runId, run.id))
      .orderBy(
        asc(schema.postClassPayoutRunLines.canonicalTutorKey),
        asc(schema.postClassPayoutRunLines.scheduledStartAt),
      );

    return { run: claimed, candidates, coverage, tutorNames, lines };
  });
}

export interface PayoutLineMatchPatch {
  matchStatus: "matched" | "unmatched" | "ambiguous" | "no_sheet";
  spreadsheetId?: string | null;
  sheetName?: string | null;
  matchedRowNumber?: number | null;
  writeStatus?: "pending" | "written" | "failed" | "skipped";
  /** Ledger row the append landed on. */
  masterRowNumber?: number | null;
  writeError?: string | null;
  writtenAt?: Date | null;
  /** Reconcile bookkeeping — see migration 0059. */
  markerMissCount?: number;
  lastSeenInMasterAt?: Date | null;
  reappendCount?: number;
}

/**
 * Persisted immediately, outside any transaction, one statement per line.
 *
 * Google cannot be rolled back, so durability here comes from writing each
 * outcome the moment it is known rather than from a transaction wrapping the
 * batch.
 */
export async function markPayoutLine(
  db: Database,
  lineId: string,
  patch: PayoutLineMatchPatch,
): Promise<void> {
  await db.update(schema.postClassPayoutRunLines).set({
    ...patch,
    writeError: patch.writeError === undefined
      ? undefined
      : patch.writeError?.slice(0, 500) ?? null,
    updatedAt: new Date(),
  }).where(eq(schema.postClassPayoutRunLines.id, lineId));
}

export async function finalizePayoutRunPass(db: Database, input: {
  runId: string;
  actorEmail: string;
  csvFileId: string | null;
  csvUrl: string | null;
}): Promise<PayoutRun> {
  const [row] = await db.update(schema.postClassPayoutRuns).set({
    status: "published",
    publishedByEmail: input.actorEmail,
    // Stamped once: a later pass re-publishes into the same run and must not
    // rewrite when it was first published.
    publishedAt: sql`coalesce(${schema.postClassPayoutRuns.publishedAt}, now())`,
    ...(input.csvFileId ? { csvFileId: input.csvFileId } : {}),
    ...(input.csvUrl ? { csvUrl: input.csvUrl } : {}),
    updatedAt: new Date(),
  }).where(eq(schema.postClassPayoutRuns.id, input.runId)).returning();
  return row;
}
