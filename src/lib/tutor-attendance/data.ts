import { and, eq, gte, lte, desc } from "drizzle-orm";
import { getDb, type Database } from "@/lib/db";
import * as s from "@/lib/db/schema";
import {
  freshAttendanceAccess,
  requireAttendanceAdmin,
  type AttendanceAccess,
} from "./access";
import {
  attendanceEnabled,
  attendanceStatus,
  datesBetween,
  localDate,
  requirementFor,
} from "./model";
import { networkStatus } from "./network";

export async function attendanceConfig(db: Database) {
  const [config] = await db
    .select()
    .from(s.tutorAttendanceConfig)
    .where(eq(s.tutorAttendanceConfig.id, "office"));
  return config ?? { id: "office", networks: [], revision: 0, updatedAt: null };
}
export async function attendanceSettings(
  access: AttendanceAccess,
  db: Database = getDb(),
) {
  requireAttendanceAdmin(await freshAttendanceAccess(access, db));
  const [config, enrollments, tutors, schedules, exceptions] =
    await Promise.all([
      attendanceConfig(db),
      db.select().from(s.tutorAttendanceEnrollments),
      db
        .select({
          canonicalKey: s.tutorContacts.canonicalKey,
          displayName: s.tutorContacts.displayName,
          active: s.tutorContacts.active,
          onsiteEmail: s.tutorContacts.onsiteEmail,
          onlineEmail: s.tutorContacts.onlineEmail,
        })
        .from(s.tutorContacts),
      db
        .select()
        .from(s.tutorAttendanceSchedules)
        .orderBy(desc(s.tutorAttendanceSchedules.revision)),
      db
        .select()
        .from(s.tutorAttendanceExceptions)
        .orderBy(desc(s.tutorAttendanceExceptions.revision)),
    ]);
  return {
    config,
    enrollments,
    tutors,
    schedules,
    exceptions,
    enabled: attendanceEnabled(),
  };
}
export async function attendanceOverview(
  access: AttendanceAccess,
  query: { start?: string; end?: string; canonicalKey?: string },
  address: string | null,
  db: Database = getDb(),
  now = new Date(),
) {
  access = await freshAttendanceAccess(access, db);
  const today = localDate(now);
  const start = query.start ?? `${today.slice(0, 8)}01`;
  const end = query.end ?? today;
  const dates = datesBetween(start, end);
  const key = access.admin ? query.canonicalKey : access.canonicalKey!;
  const [config, enrollments, schedules, exceptions, days, corrections] =
    await Promise.all([
      attendanceConfig(db),
      db
        .select({
          enrollment: s.tutorAttendanceEnrollments,
          name: s.tutorContacts.displayName,
        })
        .from(s.tutorAttendanceEnrollments)
        .leftJoin(
          s.tutorContacts,
          eq(
            s.tutorContacts.canonicalKey,
            s.tutorAttendanceEnrollments.canonicalKey,
          ),
        )
        .where(
          key ? eq(s.tutorAttendanceEnrollments.canonicalKey, key) : undefined,
        ),
      db
        .select()
        .from(s.tutorAttendanceSchedules)
        .where(
          key ? eq(s.tutorAttendanceSchedules.canonicalKey, key) : undefined,
        ),
      // Office closures and tutor overrides are needed to derive the authorized rows; never returned as a global dataset.
      db
        .select()
        .from(s.tutorAttendanceExceptions)
        .where(
          and(
            gte(s.tutorAttendanceExceptions.date, start),
            lte(s.tutorAttendanceExceptions.date, end),
          ),
        ),
      db
        .select()
        .from(s.tutorAttendanceDays)
        .where(
          and(
            gte(s.tutorAttendanceDays.date, start),
            lte(s.tutorAttendanceDays.date, end),
            key ? eq(s.tutorAttendanceDays.canonicalKey, key) : undefined,
          ),
        ),
      db
        .select({
          correction: s.tutorAttendanceCorrections,
          currentRevision: s.tutorAttendanceDays.revision,
          recordedIn: s.tutorAttendanceDays.recordedIn,
          recordedOut: s.tutorAttendanceDays.recordedOut,
          effectiveIn: s.tutorAttendanceDays.effectiveIn,
          effectiveOut: s.tutorAttendanceDays.effectiveOut,
        })
        .from(s.tutorAttendanceCorrections)
        .leftJoin(
          s.tutorAttendanceDays,
          and(
            eq(
              s.tutorAttendanceDays.canonicalKey,
              s.tutorAttendanceCorrections.canonicalKey,
            ),
            eq(s.tutorAttendanceDays.date, s.tutorAttendanceCorrections.date),
          ),
        )
        .where(
          key ? eq(s.tutorAttendanceCorrections.canonicalKey, key) : undefined,
        )
        .orderBy(desc(s.tutorAttendanceCorrections.createdAt)),
    ]);
  const index = new Map(days.map((d) => [`${d.canonicalKey}:${d.date}`, d]));
  const rows = enrollments
    .flatMap(({ enrollment, name }) =>
      dates.flatMap((date) => {
        const day = index.get(`${enrollment.canonicalKey}:${date}`);
        const inPeriod =
          date >= enrollment.startDate &&
          (!enrollment.endDate || date <= enrollment.endDate);
        if (!inPeriod && !day) return [];
        const requirement = inPeriod
          ? requirementFor(date, enrollment.canonicalKey, schedules, exceptions)
          : null;
        return [
          {
            canonicalKey: enrollment.canonicalKey,
            name: name ?? enrollment.canonicalKey,
            date,
            requirement,
            recordedIn: day?.recordedIn?.toISOString() ?? null,
            recordedOut: day?.recordedOut?.toISOString() ?? null,
            clockIn: day?.effectiveIn?.toISOString() ?? null,
            clockOut: day?.effectiveOut?.toISOString() ?? null,
            revision: day?.revision ?? 0,
            corrected: day?.corrected ?? false,
            ...attendanceStatus(
              date,
              requirement,
              day?.effectiveIn ?? null,
              day?.effectiveOut ?? null,
              now,
            ),
          },
        ];
      }),
    )
    .sort(
      (a, b) => b.date.localeCompare(a.date) || a.name.localeCompare(b.name),
    );
  const visibleCorrections = corrections.map(
    ({
      correction: c,
      currentRevision,
      recordedIn,
      recordedOut,
      effectiveIn,
      effectiveOut,
    }) => ({
      ...c,
      currentRevision: currentRevision ?? 0,
      recordedIn: recordedIn?.toISOString() ?? null,
      recordedOut: recordedOut?.toISOString() ?? null,
      currentIn: effectiveIn?.toISOString() ?? null,
      currentOut: effectiveOut?.toISOString() ?? null,
      proposedIn: c.proposedIn?.toISOString() ?? null,
      proposedOut: c.proposedOut?.toISOString() ?? null,
      createdAt: c.createdAt.toISOString(),
      reviewedAt: c.reviewedAt?.toISOString() ?? null,
    }),
  );
  return {
    access,
    today,
    start,
    end,
    now: now.toISOString(),
    enabled: attendanceEnabled(),
    network: networkStatus(address, config.networks),
    rows,
    corrections: visibleCorrections,
    tutors: enrollments.map((e) => ({
      canonicalKey: e.enrollment.canonicalKey,
      name: e.name ?? e.enrollment.canonicalKey,
    })),
  };
}
export type AttendanceOverview = Awaited<ReturnType<typeof attendanceOverview>>;
export type AttendanceSettings = Awaited<ReturnType<typeof attendanceSettings>>;
export function attendanceCsv(overview: AttendanceOverview): string {
  const cell = (value: unknown) => {
    let text = value === null || value === undefined ? "" : String(value);
    if (/^[=+\-@\t\r]/.test(text)) text = `'${text}`;
    return `"${text.replaceAll('"', '""')}"`;
  };
  return [
    [
      "Tutor",
      "Bangkok date",
      "Required start",
      "Required end",
      "Status",
      "Recorded arrival (UTC)",
      "Recorded departure (UTC)",
      "Effective arrival (UTC)",
      "Effective departure (UTC)",
      "Late minutes",
      "Early departure minutes",
      "Attendance span minutes (includes breaks)",
      "Corrected",
    ],
    ...overview.rows.map((r) => [
      r.name,
      r.date,
      r.requirement && "start" in r.requirement ? r.requirement.start : "",
      r.requirement && "end" in r.requirement ? r.requirement.end : "",
      r.status,
      r.recordedIn,
      r.recordedOut,
      r.clockIn,
      r.clockOut,
      r.lateMinutes,
      r.earlyMinutes,
      r.spanMinutes,
      r.corrected,
    ]),
  ]
    .map((row) => row.map(cell).join(","))
    .join("\r\n");
}
