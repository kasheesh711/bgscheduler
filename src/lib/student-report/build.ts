import { BANGKOK_TIME_ZONE } from "@/lib/bangkok-time";
import { bangkokDateKey } from "@/lib/room-capacity/dates";
import {
  deriveDisplaySubject,
  deriveSessionModality,
} from "@/lib/student-schedule/data";
import { TEACHER_TBC } from "@/lib/student-schedule/types";
import { snapshotDataBounds, windowWarnings } from "./window";

import type {
  BucketTotal,
  KnownSessionBucket,
  ParentReportPayload,
  ReportClassFeedback,
  ReportClassRow,
  ReportPackageRow,
  ReportStudent,
  SessionBucket,
  SummaryDimension,
  SummaryLine,
} from "./types";
import type { ResolvedReportWindow } from "./window";

/** Wise cancellation spellings seen in the feed (both single and double L). */
const CANCELLED_PATTERN = /^CANCELL?ED$/i;

const TIME_FORMATTER = new Intl.DateTimeFormat("en-GB", {
  timeZone: BANGKOK_TIME_ZONE,
  hour: "2-digit",
  minute: "2-digit",
  hour12: false,
});

const WEEKDAY_FORMATTER = new Intl.DateTimeFormat("en-GB", {
  timeZone: BANGKOK_TIME_ZONE,
  weekday: "short",
});

export interface ReportSessionInput {
  wiseSessionId: string;
  wiseStudentId: string;
  studentKey: string;
  title: string;
  subject: string;
  packageName: string;
  scheduledStartTime: Date;
  durationMinutes: number;
  meetingStatus: string;
  sessionKind: string;
  creditApplied: number;
  teacherName: string | null;
}

/** One window-scoped credit-ledger entry, with the identity fields the raw
 * Wise payload carries for SESSION-type charges. */
export interface ReportLedgerEntryInput {
  wiseCreditHistoryId: string;
  wiseStudentId: string;
  wiseClassId: string;
  credit: number;
  type: string | null;
  meetingStatus: string | null;
  durationMinutes: number;
  createdAtWise: Date | null;
  rawTeacherName: string | null;
  rawClassroomSubject: string | null;
}

/** Package identity for one (student, class) pair, used to label ledger rows. */
export interface ReportPackageMeta {
  packageName: string;
  subject: string;
}

export function packageMetaKey(wiseStudentId: string, wiseClassId: string): string {
  return `${wiseStudentId}|${wiseClassId}`;
}

function round2(value: number): number {
  return Math.round(value * 100) / 100;
}

function compareKeys(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}

/**
 * Classifies one session with cancellation first and unknown statuses fail-closed.
 * A blank unknown status is surfaced as `other:(blank)`.
 */
export function classifySession(row: {
  meetingStatus: string;
  sessionKind: string;
  creditApplied: number;
}): SessionBucket {
  const status = row.meetingStatus.trim();
  if (CANCELLED_PATTERN.test(status)) return "cancelled";
  if (row.sessionKind === "future") return "upcoming";
  if (status.toUpperCase() === "ENDED") {
    return row.creditApplied > 0 ? "attended" : "ended-no-credit";
  }
  return `other:${status || "(blank)"}`;
}

/**
 * Normalizes one stored feedback record for display: outer whitespace trimmed
 * per field (interior newlines are meaningful and kept for pre-wrap
 * rendering), and a record whose four fields are all blank collapses to null
 * so the report never renders an empty feedback block.
 */
export function normalizeReportFeedback(
  feedback: ReportClassFeedback | undefined,
): ReportClassFeedback | null {
  if (!feedback) return null;
  const trimmed: ReportClassFeedback = {
    topics: feedback.topics.trim(),
    performance: feedback.performance.trim(),
    improvement: feedback.improvement.trim(),
    homework: feedback.homework.trim(),
  };
  const hasText =
    trimmed.topics !== "" ||
    trimmed.performance !== "" ||
    trimmed.improvement !== "" ||
    trimmed.homework !== "";
  return hasText ? trimmed : null;
}

/**
 * Every Wise session id a feedback lookup should cover: snapshot sessions plus
 * ledger class candidates (a SESSION-type charge's Wise id IS the session id,
 * so pre-floor classes reconstructed from the ledger can still carry feedback).
 */
export function collectFeedbackWiseSessionIds(
  sessions: readonly Pick<ReportSessionInput, "wiseSessionId">[],
  ledgerEntries: readonly ReportLedgerEntryInput[],
): string[] {
  const ids = new Set<string>(sessions.map((session) => session.wiseSessionId));
  for (const entry of ledgerEntries) {
    if (isLedgerClassCandidate(entry)) ids.add(entry.wiseCreditHistoryId);
  }
  return [...ids];
}

/** Shapes one snapshot session into a Bangkok-local report class row. */
export function buildClassRow(
  session: ReportSessionInput,
  feedback: ReportClassFeedback | null,
): ReportClassRow {
  return {
    wiseSessionId: session.wiseSessionId,
    dateKey: bangkokDateKey(session.scheduledStartTime),
    weekday: WEEKDAY_FORMATTER.format(session.scheduledStartTime),
    startLabel: TIME_FORMATTER.format(session.scheduledStartTime),
    durationMinutes: session.durationMinutes,
    classLabel: deriveDisplaySubject(session),
    modality: deriveSessionModality(session.title),
    teacher: session.teacherName?.trim() || TEACHER_TBC,
    bucket: classifySession(session),
    creditApplied: session.creditApplied,
    feedback,
    packageName: session.packageName,
    subjectBand: session.subject,
    meetingStatus: session.meetingStatus,
    source: "snapshot",
    timeApproximate: false,
  };
}

/**
 * Whether a ledger entry stands in for a class the snapshot no longer holds.
 * Only SESSION-type charges with a placeable timestamp qualify; CANCELLED
 * charges are skipped (in-window cancellations already appear as snapshot
 * rows, and pre-floor ones carry no balance information).
 */
export function isLedgerClassCandidate<
  T extends { type: string | null; meetingStatus: string | null; createdAtWise: Date | null },
>(entry: T): entry is T & { createdAtWise: Date } {
  if (entry.type !== "SESSION") return false;
  if (!entry.createdAtWise) return false;
  return !CANCELLED_PATTERN.test((entry.meetingStatus ?? "").trim());
}

/**
 * Shapes one ledger charge into a report class row. The ledger has no session
 * title, so the class label falls back to the package subject and the modality
 * is fail-closed `unknown`; the timestamp is the charge time, flagged
 * approximate. A charge with no resolvable teacher renders TEACHER_TBC. The
 * charge id is the Wise session id, so ledger rows can still carry post-class
 * feedback looked up by that id.
 */
export function buildLedgerClassRow(
  entry: ReportLedgerEntryInput & { createdAtWise: Date },
  packageMeta: ReportPackageMeta | undefined,
  feedback: ReportClassFeedback | null,
): ReportClassRow {
  const chargedAt = entry.createdAtWise;
  const subject = entry.rawClassroomSubject?.trim() || packageMeta?.subject.trim() || "";
  const packageName = packageMeta?.packageName ?? "";
  const meetingStatus = (entry.meetingStatus ?? "").trim();
  return {
    wiseSessionId: entry.wiseCreditHistoryId,
    dateKey: bangkokDateKey(chargedAt),
    weekday: WEEKDAY_FORMATTER.format(chargedAt),
    startLabel: TIME_FORMATTER.format(chargedAt),
    durationMinutes: entry.durationMinutes,
    classLabel: deriveDisplaySubject({ title: "", subject, packageName }),
    modality: "unknown",
    teacher: entry.rawTeacherName?.trim() || TEACHER_TBC,
    bucket: classifySession({
      meetingStatus,
      sessionKind: "past",
      creditApplied: entry.credit,
    }),
    creditApplied: entry.credit,
    feedback,
    packageName,
    subjectBand: subject,
    meetingStatus,
    source: "ledger",
    timeApproximate: true,
  };
}

export const BUCKET_ORDER: readonly KnownSessionBucket[] = [
  "attended",
  "upcoming",
  "cancelled",
  "ended-no-credit",
];

/**
 * Summarizes every represented status bucket.
 *
 * 1. Aggregate session count, minutes, and credit by bucket.
 * 2. Emit represented known buckets in `BUCKET_ORDER`.
 * 3. Append all remaining buckets alphabetically with rounded hours and credits.
 */
export function summarizeBuckets(rows: readonly ReportClassRow[]): BucketTotal[] {
  const totals = new Map<SessionBucket, {
    sessions: number;
    minutes: number;
    credits: number;
  }>();

  for (const row of rows) {
    const current = totals.get(row.bucket) ?? { sessions: 0, minutes: 0, credits: 0 };
    current.sessions += 1;
    current.minutes += row.durationMinutes;
    current.credits += row.creditApplied;
    totals.set(row.bucket, current);
  }

  const known = new Set<SessionBucket>(BUCKET_ORDER);
  const orderedBuckets: SessionBucket[] = [
    ...BUCKET_ORDER.filter((bucket) => totals.has(bucket)),
    ...[...totals.keys()].filter((bucket) => !known.has(bucket)).sort(compareKeys),
  ];

  return orderedBuckets.map((bucket) => {
    const total = totals.get(bucket)!;
    return {
      bucket,
      sessions: total.sessions,
      hours: round2(total.minutes / 60),
      credits: round2(total.credits),
    };
  });
}

const SUMMARY_DIMENSIONS: readonly {
  dimension: SummaryDimension;
  keyOf: (row: ReportClassRow) => string;
}[] = [
  { dimension: "class", keyOf: (row) => row.classLabel },
  { dimension: "teacher", keyOf: (row) => row.teacher },
  { dimension: "month", keyOf: (row) => row.dateKey.slice(0, 7) },
  { dimension: "modality", keyOf: (row) => row.modality },
];

/**
 * Builds attended-only class, teacher, month, and modality summaries.
 *
 * 1. Exclude every non-attended class row.
 * 2. Aggregate each dimension independently.
 * 3. Sort each dimension by session count descending, then key ascending.
 */
export function summarizeAttended(rows: readonly ReportClassRow[]): SummaryLine[] {
  const attended = rows.filter((row) => row.bucket === "attended");
  const summaries: SummaryLine[] = [];

  for (const { dimension, keyOf } of SUMMARY_DIMENSIONS) {
    const groups = new Map<string, { sessions: number; minutes: number; credits: number }>();
    for (const row of attended) {
      const key = keyOf(row);
      const current = groups.get(key) ?? { sessions: 0, minutes: 0, credits: 0 };
      current.sessions += 1;
      current.minutes += row.durationMinutes;
      current.credits += row.creditApplied;
      groups.set(key, current);
    }

    const orderedGroups = [...groups.entries()].sort((left, right) => (
      right[1].sessions - left[1].sessions || compareKeys(left[0], right[0])
    ));
    for (const [key, total] of orderedGroups) {
      summaries.push({
        dimension,
        key,
        sessions: total.sessions,
        hours: round2(total.minutes / 60),
        credits: round2(total.credits),
      });
    }
  }

  return summaries;
}

function deduplicateAndSortSessions(
  sessions: readonly ReportSessionInput[],
): ReportSessionInput[] {
  const seen = new Set<string>();
  const unique: ReportSessionInput[] = [];
  for (const session of sessions) {
    if (seen.has(session.wiseSessionId)) continue;
    seen.add(session.wiseSessionId);
    unique.push(session);
  }
  return unique.sort((left, right) => (
    left.scheduledStartTime.getTime() - right.scheduledStartTime.getTime()
  ));
}

/**
 * Assembles the complete parent report without reading a database or clock.
 *
 * 1. Keep students in requested order and deduplicate/sort each student's sessions.
 * 2. Backfill class rows from ledger charges whose session the snapshot no
 *    longer holds (pre-floor or deleted in Wise), merged in timestamp order.
 * 3. Attach normalized tutor feedback by Wise session id (an absent entry —
 *    including the whole map when feedback is excluded — yields null).
 * 4. Build per-student rows, status totals, attended summaries, packages, and
 *    the ledger movement aggregate over every window-scoped entry.
 * 5. Summarize all student rows together and attach snapshot bounds and warnings.
 */
export function buildParentReportPayload(input: {
  snapshot: { id: string; generatedAt: Date };
  window: ResolvedReportWindow;
  students: ReportStudent[];
  sessionsByStudentId: ReadonlyMap<string, ReportSessionInput[]>;
  packagesByStudentId: ReadonlyMap<string, ReportPackageRow[]>;
  ledgerEntriesByStudentId: ReadonlyMap<string, ReportLedgerEntryInput[]>;
  packageMetaByClassKey: ReadonlyMap<string, ReportPackageMeta>;
  feedbackByWiseSessionId: ReadonlyMap<string, ReportClassFeedback>;
  generatedAt: Date;
}): ParentReportPayload {
  const allRows: ReportClassRow[] = [];
  const students = input.students.map((student) => {
    const sessions = deduplicateAndSortSessions(
      input.sessionsByStudentId.get(student.wiseStudentId) ?? [],
    );
    const sessionIds = new Set(sessions.map((session) => session.wiseSessionId));
    const ledgerEntries = input.ledgerEntriesByStudentId.get(student.wiseStudentId) ?? [];

    // A SESSION-type ledger entry's Wise id IS the session id, so any charge
    // absent from the session set is a class the snapshot cannot show.
    const rows = [
      ...sessions.map((session) => ({
        time: session.scheduledStartTime.getTime(),
        row: buildClassRow(
          session,
          normalizeReportFeedback(
            input.feedbackByWiseSessionId.get(session.wiseSessionId),
          ),
        ),
      })),
      ...ledgerEntries
        .filter(isLedgerClassCandidate)
        .filter((entry) => !sessionIds.has(entry.wiseCreditHistoryId))
        .map((entry) => ({
          time: entry.createdAtWise.getTime(),
          row: buildLedgerClassRow(
            entry,
            input.packageMetaByClassKey.get(
              packageMetaKey(entry.wiseStudentId, entry.wiseClassId),
            ),
            normalizeReportFeedback(
              input.feedbackByWiseSessionId.get(entry.wiseCreditHistoryId),
            ),
          ),
        })),
    ]
      .sort((left, right) => left.time - right.time)
      .map((timed) => timed.row);

    allRows.push(...rows);
    return {
      student,
      rows,
      bucketTotals: summarizeBuckets(rows),
      summaries: summarizeAttended(rows),
      packages: input.packagesByStudentId.get(student.wiseStudentId) ?? [],
      ledger: {
        entries: ledgerEntries.length,
        netCredit: round2(
          ledgerEntries.reduce((sum, entry) => sum + entry.credit, 0),
        ),
      },
    };
  });

  const bounds = snapshotDataBounds(input.snapshot.generatedAt);
  const warnings = windowWarnings(input.window, bounds);

  return {
    meta: {
      snapshotId: input.snapshot.id,
      snapshotGeneratedAt: input.snapshot.generatedAt.toISOString(),
      generatedAt: input.generatedAt.toISOString(),
      window: {
        fromDateKey: input.window.fromDateKey,
        toDateKey: input.window.toDateKey,
        startUtc: input.window.startUtc.toISOString(),
        endUtc: input.window.endUtc.toISOString(),
        label: input.window.label,
      },
      snapshotFloorDateKey: bounds.floorDateKey,
      snapshotCeilingDateKey: bounds.ceilingDateKey,
      floorWarning: warnings.floorWarning,
      ceilingWarning: warnings.ceilingWarning,
    },
    combined: { bucketTotals: summarizeBuckets(allRows) },
    students,
  };
}
