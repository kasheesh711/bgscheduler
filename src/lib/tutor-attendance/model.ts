import { formatInTimeZone, fromZonedTime } from "date-fns-tz";
import { z } from "zod";

export const ATTENDANCE_ROUTE = "/tutor-attendance";
export const ATTENDANCE_ZONE = "Asia/Bangkok";
export class AttendanceError extends Error {
  constructor(
    public status: number,
    message: string,
    public code = "ATTENDANCE_ERROR",
  ) {
    super(message);
  }
}
export const attendanceEnabled = () =>
  process.env.TUTOR_ATTENDANCE_ENABLED === "true";
export const localDate = (now = new Date()) =>
  formatInTimeZone(now, ATTENDANCE_ZONE, "yyyy-MM-dd");
export const dateSchema = z.iso.date();
export const timeSchema = z
  .string()
  .regex(/^([01]\d|2[0-3]):[0-5]\d$/, "Use a time between 00:00 and 23:59.");
const windowSchema = z
  .object({ start: timeSchema, end: timeSchema })
  .refine((v) => v.end > v.start, "End time must be after start time.");
export const weekSchema = z.array(windowSchema.nullable()).length(7);
export type Week = z.infer<typeof weekSchema>;
export const DEFAULT_WEEK: Week = [
  null,
  ...Array.from({ length: 4 }, () => ({ start: "10:00", end: "16:00" })),
  null,
  null,
];
export type OfficeNetwork = { label: string; cidr: string };
export type Requirement =
  | { start: string; end: string; source: string }
  | { excused: true; reason: string }
  | null;
export type ScheduleVersion = {
  id: string;
  canonicalKey: string;
  effectiveFrom: string;
  week: Week;
  revision: number;
};
export type ExceptionVersion = {
  id: string;
  canonicalKey: string | null;
  date: string;
  kind: string;
  start: string | null;
  end: string | null;
  reason: string;
  revision: number;
};
export const reasonSchema = z
  .string()
  .trim()
  .min(3, "Please give a reason.")
  .max(1000);
const revisionSchema = z.number().int().nonnegative();
export const settingsCommandSchema = z.discriminatedUnion("action", [
  z.object({
    action: z.literal("enrollment"),
    canonicalKey: z.string().min(1).max(200),
    loginEmail: z.string().trim().toLowerCase().email(),
    startDate: dateSchema,
    endDate: dateSchema.nullable(),
    active: z.boolean(),
    expectedRevision: revisionSchema,
    reason: reasonSchema,
  }),
  z.object({
    action: z.literal("schedule"),
    canonicalKey: z.string().min(1).max(200),
    effectiveFrom: dateSchema,
    week: weekSchema,
    reason: reasonSchema,
    expectedRevision: revisionSchema,
  }),
  z.object({
    action: z.literal("exception"),
    canonicalKey: z.string().min(1).max(200).nullable(),
    date: dateSchema,
    kind: z.enum(["hours", "excused", "reset"]),
    start: timeSchema.nullable(),
    end: timeSchema.nullable(),
    reason: reasonSchema,
    expectedRevision: revisionSchema,
  }),
  z.object({
    action: z.literal("networks"),
    networks: z
      .array(
        z.object({
          label: z.string().trim().min(1).max(80),
          cidr: z.string().trim().min(1).max(100),
        }),
      )
      .max(12),
    verifiedOfficeConnection: z.literal(true),
    reason: reasonSchema,
    expectedRevision: revisionSchema,
  }),
]);
export const punchSchema = z
  .object({
    kind: z.enum(["in", "out"]),
    date: dateSchema,
    idempotencyKey: z.uuid(),
  })
  .strict();
export const correctionSchema = z
  .object({
    date: dateSchema,
    proposedIn: timeSchema.nullable(),
    proposedOut: timeSchema.nullable(),
    reason: reasonSchema,
    expectedRevision: revisionSchema,
    idempotencyKey: z.uuid(),
  })
  .strict();
export const reviewSchema = z
  .object({
    decision: z.enum(["approved", "rejected"]),
    reason: reasonSchema,
    expectedRevision: revisionSchema,
  })
  .strict();
export function instant(date: string, time: string) {
  return fromZonedTime(`${date}T${time}:00`, ATTENDANCE_ZONE);
}
export function datesBetween(start: string, end: string): string[] {
  dateSchema.parse(start);
  dateSchema.parse(end);
  const result: string[] = [];
  if (start > end)
    throw new AttendanceError(400, "Start date must be on or before end date.");
  for (
    let cursor = new Date(`${start}T12:00:00Z`);
    localDate(cursor) <= end;
    cursor = new Date(cursor.getTime() + 86400000)
  ) {
    result.push(localDate(cursor));
    if (result.length > 366)
      throw new AttendanceError(
        400,
        "Choose a date range of at most one year.",
      );
  }
  return result;
}
export function applicableSchedule(
  date: string,
  key: string,
  schedules: ScheduleVersion[],
) {
  return schedules
    .filter((s) => s.canonicalKey === key && s.effectiveFrom <= date)
    .sort(
      (a, b) =>
        b.effectiveFrom.localeCompare(a.effectiveFrom) ||
        b.revision - a.revision,
    )[0];
}
export function requirementFor(
  date: string,
  key: string,
  schedules: ScheduleVersion[],
  exceptions: ExceptionVersion[],
): Requirement {
  const latest = <T extends { revision: number }>(rows: T[]) =>
    rows.sort((a, b) => b.revision - a.revision)[0];
  const closure = latest(
    exceptions.filter((e) => e.date === date && e.canonicalKey === null),
  );
  if (closure && closure.kind !== "reset")
    return { excused: true, reason: closure.reason };
  const override = latest(
    exceptions.filter((e) => e.date === date && e.canonicalKey === key),
  );
  if (override?.kind === "excused")
    return { excused: true, reason: override.reason };
  if (override?.kind === "hours" && override.start && override.end)
    return { start: override.start, end: override.end, source: override.id };
  const version = applicableSchedule(date, key, schedules);
  const window = version?.week[new Date(`${date}T12:00:00Z`).getUTCDay()];
  return window ? { ...window, source: version.id } : null;
}
export function attendanceStatus(
  date: string,
  requirement: Requirement,
  clockIn: Date | null,
  clockOut: Date | null,
  now: Date,
) {
  const scheduled = requirement && "start" in requirement ? requirement : null;
  const today = localDate(now);
  const complete = !!clockIn && !!clockOut;
  const status = complete
    ? "complete"
    : clockOut
      ? "missing_in"
      : clockIn
        ? date < today
          ? "missing_out"
          : "clocked_in"
        : requirement && "excused" in requirement
          ? "excused"
          : !scheduled
            ? "unscheduled"
            : now < instant(date, scheduled.start)
              ? "expected"
              : date < today || now >= instant(date, scheduled.end)
                ? "missing"
                : "awaiting_arrival";
  return {
    status,
    lateMinutes:
      scheduled && clockIn
        ? Math.max(
            0,
            Math.ceil(
              (clockIn.getTime() - instant(date, scheduled.start).getTime()) /
                60000,
            ),
          )
        : 0,
    earlyMinutes:
      scheduled && clockOut
        ? Math.max(
            0,
            Math.ceil(
              (instant(date, scheduled.end).getTime() - clockOut.getTime()) /
                60000,
            ),
          )
        : 0,
    spanMinutes: complete
      ? Math.floor((clockOut!.getTime() - clockIn!.getTime()) / 60000)
      : null,
  };
}
