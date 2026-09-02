// ----------------------------------------------------------------------------
// One-off per-student class report, read from the ACTIVE credit-control
// snapshot. Read-only: issues SELECTs only, never writes, never calls Wise.
//
// `credit_control_sessions` is the only table carrying (student × session)
// rows with the date, teacher, title and applied credit together, and it holds
// the past 120 days — so any window inside ~4 months is answerable locally.
//
// "Attended" uses the repo's own definition (src/lib/progress-tests/db.ts:90):
// sessionKind='past' AND meetingStatus='ENDED' AND creditApplied > 0. An ENDED
// session with no credit (free / make-up / trial) is reported in its own
// bucket rather than folded into attendance, and an unrecognised status is
// surfaced verbatim instead of being guessed into a bucket.
//
// Usage:
//   npx tsx scripts/report-student-classes.ts \
//     --match=Leila.Ea,Finn.Ea --from=2026-05-15 --out=/some/dir
// ----------------------------------------------------------------------------

import { mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";

import { loadEnvConfig } from "@next/env";
import { and, asc, eq, gte, ilike, inArray, or } from "drizzle-orm";

import { getDb, type Database } from "@/lib/db";
import * as schema from "@/lib/db/schema";
import { BANGKOK_TIME_ZONE } from "@/lib/bangkok-time";
import { bangkokDateKey, bangkokDateStartUtc } from "@/lib/room-capacity/dates";
import {
  deriveDisplaySubject,
  deriveSessionModality,
} from "@/lib/student-schedule/data";
import { TEACHER_TBC } from "@/lib/student-schedule/types";

loadEnvConfig(process.cwd());

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

type SessionBucket =
  | "attended"
  | "ended-no-credit"
  | "cancelled"
  | "upcoming"
  | string;

interface ReportRow {
  studentName: string;
  studentCode: string;
  dateKey: string;
  weekday: string;
  startTime: string;
  durationMinutes: number;
  classLabel: string;
  modality: string;
  teacher: string;
  packageName: string;
  subjectBand: string;
  meetingStatus: string;
  sessionKind: string;
  creditApplied: number;
  bucket: SessionBucket;
  hasFeedback: boolean;
  wiseSessionId: string;
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

/** The bracketed nickname code inside a Wise student name, casing preserved. */
function studentCode(studentName: string): string {
  return /\(([^)]+)\)/.exec(studentName)?.[1]?.trim() ?? "";
}

/**
 * Which bucket a session row falls into. Cancellation wins over everything —
 * a cancelled future class is cancelled, not upcoming — and an unrecognised
 * status becomes its own labelled bucket rather than being absorbed.
 */
function classify(row: {
  meetingStatus: string;
  sessionKind: string;
  creditApplied: number;
}): SessionBucket {
  if (CANCELLED_PATTERN.test(row.meetingStatus.trim())) return "cancelled";
  if (row.sessionKind === "future") return "upcoming";
  if (row.meetingStatus.trim().toUpperCase() === "ENDED") {
    return row.creditApplied > 0 ? "attended" : "ended-no-credit";
  }
  return `other:${row.meetingStatus.trim() || "(blank)"}`;
}

function toCsv(header: string[], rows: (string | number)[][]): string {
  const escape = (value: string | number): string => {
    const text = String(value ?? "");
    return /[",\n]/.test(text) ? `"${text.replace(/"/g, '""')}"` : text;
  };
  return [header, ...rows].map((row) => row.map(escape).join(",")).join("\n") + "\n";
}

/** Renders a markdown table for console output. */
function markdownTable(header: string[], rows: (string | number)[][]): string {
  const body = rows.map((row) => `| ${row.map((cell) => String(cell ?? "")).join(" | ")} |`);
  return [
    `| ${header.join(" | ")} |`,
    `| ${header.map(() => "---").join(" | ")} |`,
    ...body,
  ].join("\n");
}

function round2(value: number): number {
  return Math.round(value * 100) / 100;
}

async function main() {
  const matchArg = parseArgValue("match", "");
  const fromArg = parseArgValue("from", "");
  const outDir = parseArgValue("out", path.join(process.cwd(), "tmp"));

  if (!matchArg || !fromArg) {
    throw new Error("Both --match=<a,b> and --from=YYYY-MM-DD are required.");
  }
  if (!/^\d{4}-\d{2}-\d{2}$/.test(fromArg)) {
    throw new Error(`--from must be YYYY-MM-DD, got "${fromArg}".`);
  }

  const matches = matchArg.split(",").map((value) => value.trim()).filter(Boolean);
  const fromInstant = bangkokDateStartUtc(fromArg);
  const db: Database = getDb();

  console.log(`# Student class report`);
  console.log(`Database host : ${maskedDbHost()}`);
  console.log(`Window        : ${fromArg} 00:00 Asia/Bangkok → now (${fromInstant.toISOString()})`);
  console.log(`Match terms   : ${matches.join(", ")}`);
  console.log("");

  // -- Snapshot provenance ---------------------------------------------------
  const [snapshot] = await db
    .select({
      id: schema.creditControlSnapshots.id,
      generatedAt: schema.creditControlSnapshots.generatedAt,
    })
    .from(schema.creditControlSnapshots)
    .where(eq(schema.creditControlSnapshots.active, true))
    .limit(1);

  if (!snapshot) {
    throw new Error("No active credit-control snapshot. Nothing can be reported.");
  }

  const ageMinutes = Math.round((Date.now() - snapshot.generatedAt.getTime()) / 60_000);
  console.log(`Active snapshot : ${snapshot.id}`);
  console.log(`Generated at    : ${snapshot.generatedAt.toISOString()} (${ageMinutes} min ago)`);
  console.log("");

  // -- Resolve students ------------------------------------------------------
  const students = await db
    .select({
      wiseStudentId: schema.creditControlStudents.wiseStudentId,
      studentKey: schema.creditControlStudents.studentKey,
      studentName: schema.creditControlStudents.studentName,
      parentName: schema.creditControlStudents.parentName,
      email: schema.creditControlStudents.email,
      activated: schema.creditControlStudents.activated,
    })
    .from(schema.creditControlStudents)
    .where(
      and(
        eq(schema.creditControlStudents.snapshotId, snapshot.id),
        or(...matches.map((term) => ilike(schema.creditControlStudents.studentName, `%${term}%`))),
      ),
    );

  console.log("## Resolved students");
  console.log(
    markdownTable(
      ["Wise student id", "Student name", "Parent", "Email", "Activated", "studentKey"],
      students.map((student) => [
        student.wiseStudentId,
        student.studentName,
        student.parentName || "(none)",
        student.email ?? "(none)",
        String(student.activated),
        student.studentKey,
      ]),
    ),
  );
  console.log("");

  if (students.length === 0) {
    throw new Error(`No students matched ${matches.join(", ")} on the active snapshot.`);
  }
  if (students.length !== matches.length) {
    console.log(
      `!! WARNING: ${matches.length} match term(s) but ${students.length} student(s) resolved. Verify the table above before trusting the numbers.`,
    );
    console.log("");
  }

  const studentIds = students.map((student) => student.wiseStudentId);
  const nameById = new Map(students.map((student) => [student.wiseStudentId, student.studentName]));

  // -- Sessions --------------------------------------------------------------
  const sessions = await db
    .select({
      wiseSessionId: schema.creditControlSessions.wiseSessionId,
      wiseStudentId: schema.creditControlSessions.wiseStudentId,
      studentName: schema.creditControlSessions.studentName,
      packageName: schema.creditControlSessions.packageName,
      subject: schema.creditControlSessions.subject,
      title: schema.creditControlSessions.title,
      scheduledStartTime: schema.creditControlSessions.scheduledStartTime,
      durationMinutes: schema.creditControlSessions.durationMinutes,
      meetingStatus: schema.creditControlSessions.meetingStatus,
      sessionKind: schema.creditControlSessions.sessionKind,
      creditApplied: schema.creditControlSessions.creditApplied,
      teacherName: schema.creditControlSessions.teacherName,
      teacherFeedback: schema.creditControlSessions.teacherFeedback,
    })
    .from(schema.creditControlSessions)
    .where(
      and(
        eq(schema.creditControlSessions.snapshotId, snapshot.id),
        inArray(schema.creditControlSessions.wiseStudentId, studentIds),
        gte(schema.creditControlSessions.scheduledStartTime, fromInstant),
      ),
    )
    .orderBy(asc(schema.creditControlSessions.scheduledStartTime));

  const rows: ReportRow[] = sessions.map((session) => {
    const name = nameById.get(session.wiseStudentId) ?? session.studentName;
    return {
      studentName: name,
      studentCode: studentCode(name),
      dateKey: bangkokDateKey(session.scheduledStartTime),
      weekday: WEEKDAY_FORMATTER.format(session.scheduledStartTime),
      startTime: TIME_FORMATTER.format(session.scheduledStartTime),
      durationMinutes: session.durationMinutes,
      classLabel: deriveDisplaySubject({
        title: session.title,
        subject: session.subject,
        packageName: session.packageName,
      }),
      modality: deriveSessionModality(session.title),
      teacher: session.teacherName?.trim() || TEACHER_TBC,
      packageName: session.packageName,
      subjectBand: session.subject,
      meetingStatus: session.meetingStatus,
      sessionKind: session.sessionKind,
      creditApplied: session.creditApplied,
      bucket: classify(session),
      hasFeedback: Boolean(session.teacherFeedback?.trim()),
      wiseSessionId: session.wiseSessionId,
    };
  });

  // -- Per-class list --------------------------------------------------------
  const classHeader = [
    "Student",
    "Date",
    "Day",
    "Time",
    "Mins",
    "Class",
    "Mode",
    "Teacher",
    "Status",
    "Credit",
    "Feedback",
  ];
  const classRows = rows.map((row) => [
    row.studentCode || row.studentName,
    row.dateKey,
    row.weekday,
    row.startTime,
    row.durationMinutes,
    row.classLabel,
    row.modality,
    row.teacher,
    row.bucket,
    row.creditApplied,
    row.hasFeedback ? "yes" : "no",
  ]);

  console.log(`## Per-class list (${rows.length} rows)`);
  console.log(markdownTable(classHeader, classRows));
  console.log("");

  // -- Summary ---------------------------------------------------------------
  interface SummaryLine {
    student: string;
    dimension: string;
    key: string;
    sessions: number;
    hours: number;
    credits: number;
  }
  const summary: SummaryLine[] = [];

  const groupBy = (
    student: string,
    subset: ReportRow[],
    dimension: string,
    keyOf: (row: ReportRow) => string,
  ) => {
    const buckets = new Map<string, ReportRow[]>();
    for (const row of subset) {
      const key = keyOf(row);
      const existing = buckets.get(key);
      if (existing) existing.push(row);
      else buckets.set(key, [row]);
    }
    for (const [key, group] of [...buckets.entries()].sort((a, b) => b[1].length - a[1].length)) {
      summary.push({
        student,
        dimension,
        key,
        sessions: group.length,
        hours: round2(group.reduce((sum, row) => sum + row.durationMinutes, 0) / 60),
        credits: round2(group.reduce((sum, row) => sum + row.creditApplied, 0)),
      });
    }
  };

  for (const student of students) {
    const label = studentCode(student.studentName) || student.studentName;
    const mine = rows.filter((row) => row.studentName === student.studentName);
    const delivered = mine.filter((row) => row.bucket === "attended");

    groupBy(label, mine, "status", (row) => row.bucket);
    groupBy(label, delivered, "class", (row) => row.classLabel);
    groupBy(label, delivered, "teacher", (row) => row.teacher);
    groupBy(label, delivered, "month", (row) => row.dateKey.slice(0, 7));
    groupBy(label, delivered, "modality", (row) => row.modality);
  }

  const summaryHeader = ["Student", "Dimension", "Key", "Sessions", "Hours", "Credits"];
  const summaryRows = summary.map((line) => [
    line.student,
    line.dimension,
    line.key,
    line.sessions,
    line.hours,
    line.credits,
  ]);

  console.log("## Summary");
  console.log(markdownTable(summaryHeader, summaryRows));
  console.log("");

  // -- Credits / packages ----------------------------------------------------
  const packages = await db
    .select({
      wiseStudentId: schema.creditControlPackages.wiseStudentId,
      studentName: schema.creditControlPackages.studentName,
      packageName: schema.creditControlPackages.packageName,
      subject: schema.creditControlPackages.subject,
      classType: schema.creditControlPackages.classType,
      totalCredits: schema.creditControlPackages.totalCredits,
      consumedCredits: schema.creditControlPackages.consumedCredits,
      remainingCredits: schema.creditControlPackages.remainingCredits,
      availableCredits: schema.creditControlPackages.availableCredits,
      bookedSessions: schema.creditControlPackages.bookedSessions,
      excludedReason: schema.creditControlPackages.excludedReason,
    })
    .from(schema.creditControlPackages)
    .where(
      and(
        eq(schema.creditControlPackages.snapshotId, snapshot.id),
        inArray(schema.creditControlPackages.wiseStudentId, studentIds),
      ),
    );

  const creditHeader = [
    "Student",
    "Package",
    "Subject",
    "Type",
    "Total",
    "Consumed",
    "Remaining",
    "Available",
    "Booked",
    "Excluded",
  ];
  const creditRows = packages.map((pkg) => [
    studentCode(nameById.get(pkg.wiseStudentId) ?? pkg.studentName) || pkg.studentName,
    pkg.packageName,
    pkg.subject || "(none)",
    pkg.classType ?? "(none)",
    round2(pkg.totalCredits),
    round2(pkg.consumedCredits),
    round2(pkg.remainingCredits),
    round2(pkg.availableCredits),
    round2(pkg.bookedSessions),
    pkg.excludedReason ?? "",
  ]);

  console.log(`## Credits / packages (${packages.length} rows, point-in-time)`);
  console.log(markdownTable(creditHeader, creditRows));
  console.log("");

  // Window-scoped credit movement, so the balance reads against activity.
  const history = await db
    .select({
      wiseStudentId: schema.creditControlCreditHistory.wiseStudentId,
      packageKey: schema.creditControlCreditHistory.packageKey,
      credit: schema.creditControlCreditHistory.credit,
      type: schema.creditControlCreditHistory.type,
      meetingStatus: schema.creditControlCreditHistory.meetingStatus,
      createdAtWise: schema.creditControlCreditHistory.createdAtWise,
    })
    .from(schema.creditControlCreditHistory)
    .where(
      and(
        eq(schema.creditControlCreditHistory.snapshotId, snapshot.id),
        inArray(schema.creditControlCreditHistory.wiseStudentId, studentIds),
        gte(schema.creditControlCreditHistory.createdAtWise, fromInstant),
      ),
    );

  const historyByStudent = new Map<string, { entries: number; credit: number }>();
  for (const entry of history) {
    const current = historyByStudent.get(entry.wiseStudentId) ?? { entries: 0, credit: 0 };
    current.entries += 1;
    current.credit += entry.credit;
    historyByStudent.set(entry.wiseStudentId, current);
  }

  console.log(`## Credit movement since ${fromArg} (${history.length} ledger entries)`);
  console.log(
    markdownTable(
      ["Student", "Ledger entries", "Net credit change"],
      students.map((student) => {
        const totals = historyByStudent.get(student.wiseStudentId) ?? { entries: 0, credit: 0 };
        return [
          studentCode(student.studentName) || student.studentName,
          totals.entries,
          round2(totals.credit),
        ];
      }),
    ),
  );
  console.log("");

  // -- CSV output ------------------------------------------------------------
  mkdirSync(outDir, { recursive: true });
  const files: Array<[string, string]> = [
    ["eastwood-classes.csv", toCsv([...classHeader, "Package", "Level band", "Wise session id"], rows.map((row) => [
      row.studentCode || row.studentName,
      row.dateKey,
      row.weekday,
      row.startTime,
      row.durationMinutes,
      row.classLabel,
      row.modality,
      row.teacher,
      row.bucket,
      row.creditApplied,
      row.hasFeedback ? "yes" : "no",
      row.packageName,
      row.subjectBand,
      row.wiseSessionId,
    ]))],
    ["eastwood-summary.csv", toCsv(summaryHeader, summaryRows)],
    ["eastwood-credits.csv", toCsv(creditHeader, creditRows)],
  ];

  for (const [name, contents] of files) {
    const target = path.join(outDir, name);
    writeFileSync(target, contents, "utf8");
    console.log(`Wrote ${target}`);
  }
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : error);
  process.exitCode = 1;
});
