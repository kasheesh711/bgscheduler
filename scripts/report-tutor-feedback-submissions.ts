// ----------------------------------------------------------------------------
// Per-tutor feedback-submission evidence report, for deduction disputes.
// Read-only: issues SELECTs only, never writes, never calls Wise.
//
// For every post_class_sessions row of one tutor it prints the full submission
// trail: every SessionFeedbackSubmittedEvent (human vs auto), the FIRST human
// submission (the instant the system and the payout sheet charge on — the
// `min(event_timestamp)` rule shared by deriveEventTimingEvidence, the
// dashboard Submitted column, and payout tutor_submitted_at, D-EVT-04), the
// LATEST human submission (the tutor's most recent copy), every stored
// feedback version, the deduction verdict, and the payout-sheet line values.
//
// The activity mirror (`wise_activity_events`) is also queried directly and
// any submission event missing from `post_class_feedback_event_links` is
// flagged, so link-table gaps cannot hide a submission.
//
// Usage:
//   npx tsx --tsconfig scripts/tsconfig.json \
//     scripts/report-tutor-feedback-submissions.ts \
//     --tutor=Aey [--from=2026-07-26] [--to=2026-08-25] [--all] [--out=/some/dir]
//
// Defaults: --tutor=Aey; window = the current payout window (26th of the
// previous-or-current month through today, Bangkok). --all ignores the window.
// ----------------------------------------------------------------------------

import { mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";

import { loadEnvConfig } from "@next/env";
import { and, asc, eq, gte, ilike, inArray, lt, or } from "drizzle-orm";

import { getDb } from "@/lib/db";
import * as schema from "@/lib/db/schema";
import { BANGKOK_TIME_ZONE } from "@/lib/bangkok-time";
import { bangkokDateKey, bangkokDateStartUtc } from "@/lib/room-capacity/dates";

loadEnvConfig(process.cwd());

const BKK_PARTS = new Intl.DateTimeFormat("en-GB", {
  timeZone: BANGKOK_TIME_ZONE,
  year: "numeric",
  month: "2-digit",
  day: "2-digit",
  hour: "2-digit",
  minute: "2-digit",
  second: "2-digit",
  hour12: false,
});

/** `YYYY-MM-DD HH:mm:ss` in Asia/Bangkok, or an em dash for null. */
function fmtBkk(date: Date | null | undefined): string {
  if (!date) return "—";
  const parts = new Map(
    BKK_PARTS.formatToParts(date).map((p) => [p.type, p.value]),
  );
  return `${parts.get("year")}-${parts.get("month")}-${parts.get("day")} ${parts.get("hour")}:${parts.get("minute")}:${parts.get("second")}`;
}

/** Reads a `--flag=value` CLI arg, returning `fallback` when absent. */
function parseArgValue(flag: string, fallback: string): string {
  const prefix = `--${flag}=`;
  const found = process.argv.find((arg) => arg.startsWith(prefix));
  return found ? found.slice(prefix.length) : fallback;
}

/** Host of the configured database, with credentials stripped. */
function maskedDbHost(): string {
  const raw = process.env.DATABASE_URL;
  if (!raw) return "(DATABASE_URL not set)";
  try {
    return new URL(raw).host;
  } catch {
    return "(unparseable DATABASE_URL)";
  }
}

/**
 * Start date (`YYYY-MM-DD`) of the payout window containing the given Bangkok
 * date key: windows run the 26th through the 25th.
 */
function payoutWindowStartKey(todayKey: string): string {
  const [y, m, d] = todayKey.split("-").map(Number);
  if (d >= 26) return `${y}-${String(m).padStart(2, "0")}-26`;
  const prevMonth = m === 1 ? 12 : m - 1;
  const prevYear = m === 1 ? y - 1 : y;
  return `${prevYear}-${String(prevMonth).padStart(2, "0")}-26`;
}

/**
 * The auto-submission flag as recorded on a raw mirror event payload, with the
 * same defensive fallbacks as `toFeedbackEventEvidence`: nested first, then
 * top-level. Unknown shapes yield null (treated as human, matching the
 * NULL-safe `IS DISTINCT FROM true` rule).
 */
function payloadAutoSubmitted(payload: Record<string, unknown>): boolean | null {
  const nested = (payload.session as Record<string, unknown> | undefined)
    ?.autoSubmitted;
  const flat = payload.autoSubmitted;
  const value = nested ?? flat;
  if (typeof value === "boolean") return value;
  if (value === "true") return true;
  if (value === "false") return false;
  return null;
}

function csvCell(value: string | number | boolean | null | undefined): string {
  if (value === null || value === undefined) return "";
  const text = String(value);
  return /[",\n]/.test(text) ? `"${text.replaceAll('"', '""')}"` : text;
}

function writeCsv(
  filePath: string,
  header: string[],
  rows: (string | number | boolean | null | undefined)[][],
): void {
  const lines = [header.join(",")];
  for (const row of rows) lines.push(row.map(csvCell).join(","));
  writeFileSync(filePath, `${lines.join("\n")}\n`, "utf8");
}

async function main(): Promise<void> {
  const tutorArg = parseArgValue("tutor", "Aey");
  const allTime = process.argv.includes("--all");
  const todayKey = bangkokDateKey(new Date());
  const fromKey = parseArgValue("from", payoutWindowStartKey(todayKey));
  const toKey = parseArgValue("to", todayKey);
  const outDir = parseArgValue("out", "");

  const db = getDb();
  console.log(`DB host: ${maskedDbHost()}`);
  console.log(
    `Tutor: ${tutorArg} | window: ${allTime ? "ALL TIME" : `${fromKey} → ${toKey}`} (Bangkok, by scheduled end)`,
  );

  const fromUtc = bangkokDateStartUtc(fromKey);
  // Exclusive upper bound: the start of the day after `toKey`.
  const toExclusiveUtc = new Date(
    bangkokDateStartUtc(toKey).getTime() + 24 * 60 * 60 * 1000,
  );

  const windowClause = allTime
    ? undefined
    : and(
        gte(schema.postClassSessions.scheduledEndAt, fromUtc),
        lt(schema.postClassSessions.scheduledEndAt, toExclusiveUtc),
      );

  const sessions = await db
    .select({
      id: schema.postClassSessions.id,
      wiseSessionId: schema.postClassSessions.wiseSessionId,
      className: schema.postClassSessions.className,
      canonicalTutorName: schema.postClassSessions.canonicalTutorName,
      scheduledStartAt: schema.postClassSessions.scheduledStartAt,
      scheduledEndAt: schema.postClassSessions.scheduledEndAt,
      deadlineAt: schema.postClassSessions.deadlineAt,
      finalStatus: schema.postClassSessions.finalStatus,
      timingStatus: schema.postClassSessions.timingStatus,
      deductionStatus: schema.postClassSessions.deductionStatus,
      latestFeedbackVersionId: schema.postClassSessions.latestFeedbackVersionId,
    })
    .from(schema.postClassSessions)
    .where(
      windowClause
        ? and(
            eq(schema.postClassSessions.canonicalTutorKey, tutorArg),
            windowClause,
          )
        : eq(schema.postClassSessions.canonicalTutorKey, tutorArg),
    )
    .orderBy(asc(schema.postClassSessions.scheduledEndAt));

  if (sessions.length === 0) {
    const candidates = await db
      .selectDistinct({
        key: schema.postClassSessions.canonicalTutorKey,
        name: schema.postClassSessions.canonicalTutorName,
      })
      .from(schema.postClassSessions)
      .where(
        or(
          ilike(schema.postClassSessions.canonicalTutorKey, `%${tutorArg}%`),
          ilike(schema.postClassSessions.canonicalTutorName, `%${tutorArg}%`),
        ),
      );
    if (candidates.length === 0) {
      console.log(
        `No post_class_sessions rows match tutor key or name ~ "${tutorArg}".`,
      );
    } else {
      console.log(
        `No sessions for canonical_tutor_key="${tutorArg}" in this window. Candidate keys:`,
      );
      for (const c of candidates) console.log(`  ${c.key}  (${c.name})`);
      console.log(
        "Re-run with --tutor=<exact key>, and/or --all for full history.",
      );
    }
    return;
  }

  const sessionIds = sessions.map((s) => s.id);
  const wiseSessionIds = sessions.map((s) => s.wiseSessionId);

  const [participants, links, versions, deductions, payoutLines, mirrorEvents] =
    await Promise.all([
      db
        .select({
          sessionId: schema.postClassSessionParticipants.sessionId,
          studentName: schema.postClassSessionParticipants.studentName,
        })
        .from(schema.postClassSessionParticipants)
        .where(
          inArray(schema.postClassSessionParticipants.sessionId, sessionIds),
        ),
      db
        .select({
          sessionId: schema.postClassFeedbackEventLinks.sessionId,
          eventTimestamp: schema.postClassFeedbackEventLinks.eventTimestamp,
          autoSubmitted: schema.postClassFeedbackEventLinks.autoSubmitted,
          wiseEventId: schema.postClassFeedbackEventLinks.wiseEventId,
          linkConfidence: schema.postClassFeedbackEventLinks.linkConfidence,
          feedbackVersionId:
            schema.postClassFeedbackEventLinks.feedbackVersionId,
          actorName: schema.wiseActivityEvents.actorName,
          actorRole: schema.wiseActivityEvents.actorRole,
        })
        .from(schema.postClassFeedbackEventLinks)
        .leftJoin(
          schema.wiseActivityEvents,
          eq(
            schema.postClassFeedbackEventLinks.wiseActivityEventId,
            schema.wiseActivityEvents.id,
          ),
        )
        .where(inArray(schema.postClassFeedbackEventLinks.sessionId, sessionIds))
        .orderBy(asc(schema.postClassFeedbackEventLinks.eventTimestamp)),
      db
        .select({
          id: schema.postClassFeedbackVersions.id,
          sessionId: schema.postClassFeedbackVersions.sessionId,
          versionKey: schema.postClassFeedbackVersions.versionKey,
          profile: schema.postClassFeedbackVersions.profile,
          sourceCreatedAt: schema.postClassFeedbackVersions.sourceCreatedAt,
          sourceTimestampTrustworthy:
            schema.postClassFeedbackVersions.sourceTimestampTrustworthy,
          sourceTimestampKind:
            schema.postClassFeedbackVersions.sourceTimestampKind,
          observedAt: schema.postClassFeedbackVersions.observedAt,
          actorName: schema.postClassFeedbackVersions.actorName,
          substantive: schema.postClassFeedbackVersions.substantive,
          compliant: schema.postClassFeedbackVersions.compliant,
          rawCharCount: schema.postClassFeedbackVersions.rawCharCount,
        })
        .from(schema.postClassFeedbackVersions)
        .where(inArray(schema.postClassFeedbackVersions.sessionId, sessionIds))
        .orderBy(asc(schema.postClassFeedbackVersions.observedAt)),
      db
        .select({
          sessionId: schema.postClassDeductions.sessionId,
          status: schema.postClassDeductions.status,
          amountMinor: schema.postClassDeductions.amountMinor,
          defaultFinanceMonth: schema.postClassDeductions.defaultFinanceMonth,
          decisionByEmail: schema.postClassDeductions.decisionByEmail,
          decisionAt: schema.postClassDeductions.decisionAt,
        })
        .from(schema.postClassDeductions)
        .where(inArray(schema.postClassDeductions.sessionId, sessionIds)),
      db
        .select({
          sessionId: schema.postClassPayoutRunLines.sessionId,
          tutorSubmittedAt: schema.postClassPayoutRunLines.tutorSubmittedAt,
          deadlineAt: schema.postClassPayoutRunLines.deadlineAt,
          amountMinor: schema.postClassPayoutRunLines.amountMinor,
          writeStatus: schema.postClassPayoutRunLines.writeStatus,
          writtenAt: schema.postClassPayoutRunLines.writtenAt,
          retiredAt: schema.postClassPayoutRunLines.retiredAt,
          windowStart: schema.postClassPayoutRuns.windowStart,
          windowEnd: schema.postClassPayoutRuns.windowEnd,
          runStatus: schema.postClassPayoutRuns.status,
        })
        .from(schema.postClassPayoutRunLines)
        .innerJoin(
          schema.postClassPayoutRuns,
          eq(
            schema.postClassPayoutRunLines.runId,
            schema.postClassPayoutRuns.id,
          ),
        )
        .where(inArray(schema.postClassPayoutRunLines.sessionId, sessionIds)),
      db
        .select({
          wiseSessionId: schema.wiseActivityEvents.sessionId,
          eventId: schema.wiseActivityEvents.eventId,
          eventTimestamp: schema.wiseActivityEvents.eventTimestamp,
          actorName: schema.wiseActivityEvents.actorName,
          actorRole: schema.wiseActivityEvents.actorRole,
          payload: schema.wiseActivityEvents.payload,
        })
        .from(schema.wiseActivityEvents)
        .where(
          and(
            eq(schema.wiseActivityEvents.eventName, "SessionFeedbackSubmittedEvent"),
            inArray(schema.wiseActivityEvents.sessionId, wiseSessionIds),
          ),
        )
        .orderBy(asc(schema.wiseActivityEvents.eventTimestamp)),
    ]);

  const studentsBySession = new Map<string, string[]>();
  for (const row of participants) {
    const list = studentsBySession.get(row.sessionId) ?? [];
    if (!list.includes(row.studentName)) list.push(row.studentName);
    studentsBySession.set(row.sessionId, list);
  }
  const linksBySession = new Map<string, typeof links>();
  for (const row of links) {
    const list = linksBySession.get(row.sessionId) ?? [];
    list.push(row);
    linksBySession.set(row.sessionId, list);
  }
  const versionsBySession = new Map<string, typeof versions>();
  for (const row of versions) {
    const list = versionsBySession.get(row.sessionId) ?? [];
    list.push(row);
    versionsBySession.set(row.sessionId, list);
  }
  const deductionBySession = new Map(
    deductions.map((row) => [row.sessionId, row]),
  );
  const payoutLinesBySession = new Map<string, typeof payoutLines>();
  for (const row of payoutLines) {
    const list = payoutLinesBySession.get(row.sessionId) ?? [];
    list.push(row);
    payoutLinesBySession.set(row.sessionId, list);
  }
  const mirrorByWiseSession = new Map<string, typeof mirrorEvents>();
  for (const row of mirrorEvents) {
    if (!row.wiseSessionId) continue;
    const list = mirrorByWiseSession.get(row.wiseSessionId) ?? [];
    list.push(row);
    mirrorByWiseSession.set(row.wiseSessionId, list);
  }

  const tutorDisplayName =
    sessions.find((s) => s.canonicalTutorName)?.canonicalTutorName ?? tutorArg;
  console.log(`Resolved tutor: ${tutorDisplayName} (key=${tutorArg})`);
  console.log(`Sessions in scope: ${sessions.length}\n`);

  const summaryRows: (string | number | boolean | null)[][] = [];
  const eventRows: (string | number | boolean | null)[][] = [];
  let deductedCount = 0;
  let editedAfterFirstCount = 0;
  let unlinkedTotal = 0;
  let noSubmissionCount = 0;

  for (const session of sessions) {
    const sessionLinks = linksBySession.get(session.id) ?? [];
    const sessionVersions = [...(versionsBySession.get(session.id) ?? [])].sort(
      (a, b) => {
        const aTime = (a.sourceCreatedAt ?? a.observedAt).getTime();
        const bTime = (b.sourceCreatedAt ?? b.observedAt).getTime();
        if (aTime !== bTime) return aTime - bTime;
        return a.observedAt.getTime() - b.observedAt.getTime();
      },
    );
    const deduction = deductionBySession.get(session.id) ?? null;
    const sessionPayoutLines = payoutLinesBySession.get(session.id) ?? [];
    const mirror = mirrorByWiseSession.get(session.wiseSessionId) ?? [];

    // Human submissions per D-EVT-04: anything not proven auto counts.
    const humanLinkTimes = sessionLinks
      .filter((l) => l.autoSubmitted !== true)
      .map((l) => l.eventTimestamp);
    const linkedEventIds = new Set(sessionLinks.map((l) => l.wiseEventId));
    const unlinked = mirror.filter((e) => !linkedEventIds.has(e.eventId));
    const unlinkedHumanTimes = unlinked
      .filter((e) => payloadAutoSubmitted(e.payload) !== true)
      .map((e) => e.eventTimestamp);
    // The link table drives the system's numbers; the mirror fills gaps only.
    const allHumanTimes = [...humanLinkTimes, ...unlinkedHumanTimes].sort(
      (a, b) => a.getTime() - b.getTime(),
    );
    const firstHuman = allHumanTimes[0] ?? null;
    const latestHuman = allHumanTimes[allHumanTimes.length - 1] ?? null;
    const editedAfterFirst =
      firstHuman !== null &&
      latestHuman !== null &&
      latestHuman.getTime() !== firstHuman.getTime();

    if (deduction) deductedCount += 1;
    if (editedAfterFirst) editedAfterFirstCount += 1;
    unlinkedTotal += unlinked.length;
    if (!firstHuman) noSubmissionCount += 1;

    const students = studentsBySession.get(session.id) ?? [];
    const dedLabel = deduction
      ? `${deduction.status} (฿${(deduction.amountMinor / 100).toFixed(0)})`
      : session.deductionStatus;

    console.log(
      `── ${fmtBkk(session.scheduledEndAt).slice(0, 10)}  ${session.className ?? "(no class name)"}  [wise ${session.wiseSessionId}]`,
    );
    if (students.length > 0) console.log(`   students: ${students.join(", ")}`);
    console.log(`   class end (BKK):        ${fmtBkk(session.scheduledEndAt)}`);
    console.log(`   deadline (BKK):         ${fmtBkk(session.deadlineAt)}`);
    console.log(
      `   FIRST submission:       ${fmtBkk(firstHuman)}${firstHuman ? "   ← the time the system charges on" : ""}`,
    );
    console.log(
      `   LATEST submission:      ${fmtBkk(latestHuman)}${editedAfterFirst ? "   (edited after first)" : ""}`,
    );
    console.log(
      `   verdict: timing=${session.timingStatus}  deduction=${dedLabel}  final_status=${session.finalStatus}`,
    );
    for (const line of sessionPayoutLines) {
      console.log(
        `   sheet line [${line.windowStart}→${line.windowEnd} ${line.runStatus}]: submitted=${fmtBkk(line.tutorSubmittedAt)}  amount=฿${(line.amountMinor / 100).toFixed(0)}  write=${line.writeStatus}${line.retiredAt ? "  RETIRED" : ""}`,
      );
    }
    if (sessionLinks.length > 0 || unlinked.length > 0) {
      console.log("   submission events:");
      for (const l of sessionLinks) {
        const kind = l.autoSubmitted === true ? "AUTO " : "human";
        console.log(
          `     ${fmtBkk(l.eventTimestamp)}  ${kind}  ${l.actorName ?? "(actor unknown)"}${l.actorRole ? ` [${l.actorRole}]` : ""}`,
        );
      }
      for (const e of unlinked) {
        const kind = payloadAutoSubmitted(e.payload) === true ? "AUTO " : "human";
        console.log(
          `     ${fmtBkk(e.eventTimestamp)}  ${kind}  ${e.actorName ?? "(actor unknown)"}${e.actorRole ? ` [${e.actorRole}]` : ""}  ⚠ unlinked (mirror only)`,
        );
      }
    } else {
      console.log("   submission events:      none recorded");
    }
    if (sessionVersions.length > 0) {
      console.log("   stored copies (versions):");
      sessionVersions.forEach((v, i) => {
        const isLatest = v.id === session.latestFeedbackVersionId;
        const stamp = v.sourceCreatedAt
          ? `${fmtBkk(v.sourceCreatedAt)} (wise-${v.sourceTimestampKind ?? "?"}${v.sourceTimestampTrustworthy ? ", trusted" : ""})`
          : `${fmtBkk(v.observedAt)} (first seen by sync)`;
        console.log(
          `     v${i + 1} ${stamp}  chars=${v.rawCharCount}${v.substantive ? " substantive" : ""}${v.compliant ? " compliant" : ""}${isLatest ? "  ← LATEST COPY" : ""}`,
        );
      });
    }
    console.log("");

    summaryRows.push([
      session.wiseSessionId,
      session.className,
      students.join("; "),
      fmtBkk(session.scheduledEndAt),
      fmtBkk(session.deadlineAt),
      fmtBkk(firstHuman),
      fmtBkk(latestHuman),
      editedAfterFirst,
      session.timingStatus,
      deduction?.status ?? session.deductionStatus,
      deduction ? deduction.amountMinor / 100 : null,
      sessionPayoutLines.map((l) => fmtBkk(l.tutorSubmittedAt)).join("; "),
      sessionPayoutLines.map((l) => l.writeStatus).join("; "),
      unlinked.length,
      session.deadlineAt.toISOString(),
      firstHuman?.toISOString() ?? null,
      latestHuman?.toISOString() ?? null,
    ]);
    for (const l of sessionLinks) {
      eventRows.push([
        session.wiseSessionId,
        session.className,
        fmtBkk(l.eventTimestamp),
        l.eventTimestamp.toISOString(),
        l.autoSubmitted === true ? "auto" : "human",
        l.actorName,
        l.actorRole,
        l.wiseEventId,
        l.linkConfidence,
        false,
      ]);
    }
    for (const e of unlinked) {
      eventRows.push([
        session.wiseSessionId,
        session.className,
        fmtBkk(e.eventTimestamp),
        e.eventTimestamp.toISOString(),
        payloadAutoSubmitted(e.payload) === true ? "auto" : "human",
        e.actorName,
        e.actorRole,
        e.eventId,
        null,
        true,
      ]);
    }
  }

  console.log("── Summary");
  console.log(`   sessions:                ${sessions.length}`);
  console.log(`   with deduction row:      ${deductedCount}`);
  console.log(`   edited after first:      ${editedAfterFirstCount}`);
  console.log(`   no human submission:     ${noSubmissionCount}`);
  console.log(`   unlinked mirror events:  ${unlinkedTotal}`);

  if (outDir) {
    mkdirSync(outDir, { recursive: true });
    const slug = tutorArg.toLowerCase().replaceAll(/[^a-z0-9]+/g, "-");
    const range = allTime ? "all-time" : `${fromKey}-to-${toKey}`;
    const summaryPath = path.join(
      outDir,
      `feedback-submissions-${slug}-${range}.csv`,
    );
    const eventsPath = path.join(
      outDir,
      `feedback-submission-events-${slug}-${range}.csv`,
    );
    writeCsv(
      summaryPath,
      [
        "wise_session_id",
        "class_name",
        "students",
        "class_end_bkk",
        "deadline_bkk",
        "first_submission_bkk",
        "latest_submission_bkk",
        "edited_after_first",
        "timing_status",
        "deduction_status",
        "deduction_amount_thb",
        "sheet_tutor_submitted_bkk",
        "sheet_write_status",
        "unlinked_event_count",
        "deadline_utc",
        "first_submission_utc",
        "latest_submission_utc",
      ],
      summaryRows,
    );
    writeCsv(
      eventsPath,
      [
        "wise_session_id",
        "class_name",
        "event_time_bkk",
        "event_time_utc",
        "kind",
        "actor_name",
        "actor_role",
        "wise_event_id",
        "link_confidence",
        "mirror_only",
      ],
      eventRows,
    );
    console.log(`\nWrote ${summaryPath}`);
    console.log(`Wrote ${eventsPath}`);
  }
}

main().catch((err) => {
  console.error(err instanceof Error ? err.message : err);
  process.exitCode = 1;
});
