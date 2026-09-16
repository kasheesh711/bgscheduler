import { formatInTimeZone, fromZonedTime } from "date-fns-tz";
import { z } from "zod";

export const SIT_INS_ROUTE = "/tutor-sit-ins";
export const ZONE = "Asia/Bangkok";
export const FIRST_QUARTER = "2026-Q4";
export const NOTICE_MS = 24 * 60 * 60_000;
export const REPORT_WINDOW_MS = 48 * 60 * 60_000;
export const SOURCE_MAX_AGE_MS = 90 * 60_000;
export const DEPARTMENTS = [
  "physics",
  "maths",
  "english",
  "chemistry",
  "iseb",
] as const;
export type Department = (typeof DEPARTMENTS)[number];
export const HEADS = [
  { department: "physics", label: "Physics", email: "apivit.s@hotmail.com" },
  { department: "maths", label: "Maths", email: "kasidej.ju@gmail.com" },
  { department: "english", label: "English", email: "drxiox@gmail.com" },
  { department: "chemistry", label: "Chemistry", email: "miieiiem@gmail.com" },
  { department: "iseb", label: "ISEB", email: "gift.m@begiftededucation.com" },
] as const;
export const OPERATIONS = [
  { name: "Petchy", email: "panida.wiya@gmail.com" },
  { name: "Care", email: "kittiya.carekt@gmail.com" },
  { name: "Palm", email: "chiraya.work@gmail.com" },
  { name: "Aya", email: "pakwalaan@gmail.com" },
  { name: "Muk", email: "suphitsaramanosamrit@gmail.com" },
];
export class SitInError extends Error {
  constructor(
    public status: number,
    message: string,
    public code = "SIT_IN_ERROR",
  ) {
    super(message);
  }
}
export const enabled = () => process.env.TUTOR_SIT_INS_ENABLED === "true";
export const deliveryEnabled = () =>
  enabled() &&
  process.env.TUTOR_SIT_INS_DELIVERY_ENABLED === "true" &&
  process.env.VERCEL_ENV !== "preview" &&
  process.env.PREVIEW_SANDBOX_ENABLED !== "true";
export const quarterSchema = z
  .string()
  .regex(/^\d{4}-Q[1-4]$/)
  .refine(
    (q) => q >= FIRST_QUARTER && q <= "2100-Q4",
    "Observation coverage starts in Q4 2026.",
  );
export const departmentSchema = z.enum(DEPARTMENTS);
export const emailSchema = z.string().trim().toLowerCase().email();
export const revisionSchema = z.number().int().nonnegative();
export const reasonSchema = z.string().trim().min(3).max(1000);
export function localDate(date = new Date()) {
  return formatInTimeZone(date, ZONE, "yyyy-MM-dd");
}
export function currentQuarter(date = new Date()) {
  const [year, month] = localDate(date).split("-").map(Number);
  return year + "-Q" + Math.ceil(month / 3);
}
export function defaultQuarter(date = new Date()) {
  return [FIRST_QUARTER, currentQuarter(date)].sort().at(-1)!;
}
export function quarterBounds(quarter: string) {
  quarterSchema.parse(quarter);
  const year = Number(quarter.slice(0, 4)),
    month = (Number(quarter.at(-1)) - 1) * 3;
  const start = fromZonedTime(
    new Date(Date.UTC(year, month, 1)).toISOString().slice(0, 10) + "T00:00:00",
    ZONE,
  );
  const end = fromZonedTime(
    new Date(Date.UTC(year, month + 3, 1)).toISOString().slice(0, 10) +
      "T00:00:00",
    ZONE,
  );
  return { start, end };
}
export const overlap = (
  a: { start: Date; end: Date },
  b: { start: Date; end: Date },
) => a.start < b.end && b.start < a.end;
export function requireNotice(start: Date, now = new Date()) {
  if (start.getTime() - now.getTime() < NOTICE_MS)
    throw new SitInError(
      409,
      "Choose a lesson at least 24 hours ahead.",
      "INSUFFICIENT_NOTICE",
    );
}
export function isCancelled(status: string) {
  return /^(cancelled|canceled)$/i.test(status);
}
export function isUpcoming(status: string) {
  return /^(scheduled|upcoming|future|not_started|not started)$/i.test(status);
}
export function titleDepartments(title: string): Department[] {
  const result: Department[] = [];
  if (/\bphysics\b/i.test(title)) result.push("physics");
  if (/\b(math|maths|mathematics)\b/i.test(title)) result.push("maths");
  if (/\b(english|efl|esl)\b/i.test(title)) result.push("english");
  if (/\bchemistry\b/i.test(title)) result.push("chemistry");
  if (/\biseb\b/i.test(title)) result.push("iseb");
  return result;
}
export type Participant = {
  studentKey: string;
  studentName: string;
  familyKey: string | null;
  parentName: string | null;
};
export type Lesson = {
  id: string;
  classId: string;
  tutorKey: string | null;
  tutorName: string;
  title: string;
  start: string;
  end: string;
  status: string;
  location: string | null;
  modality: string | null;
  departments: Department[];
  participants: Participant[];
  tutorEmail?: string;
};
export type Suggestion = {
  sessionId: string;
  title: string;
  start: string;
  end: string;
  location: string | null;
  modality: string | null;
};
export const bookingSchema = z
  .object({
    sessionId: z.string().min(1).max(200),
    expectedRevision: revisionSchema,
  })
  .strict();
export const assignmentCommandSchema = z.discriminatedUnion("action", [
  z
    .object({
      action: z.literal("reassign"),
      email: emailSchema,
      expectedRevision: revisionSchema,
      reason: reasonSchema,
    })
    .strict(),
  z
    .object({
      action: z.literal("exempt"),
      expectedRevision: revisionSchema,
      reason: reasonSchema,
    })
    .strict(),
  z
    .object({
      action: z.literal("cancel"),
      expectedRevision: revisionSchema,
      reason: reasonSchema,
    })
    .strict(),
  z
    .object({
      action: z.literal("reopen"),
      expectedRevision: revisionSchema,
      reason: reasonSchema,
    })
    .strict(),
]);
export const settingsSchema = z.discriminatedUnion("action", [
  z
    .object({
      action: z.literal("grant"),
      email: emailSchema,
      role: z.enum(["observer", "coordinator", "manager"]),
      departments: z.array(departmentSchema).max(5),
      canonicalKey: z.string().min(1).max(200).nullable(),
      active: z.boolean(),
      expectedRevision: revisionSchema,
      reason: reasonSchema,
    })
    .strict(),
  z
    .object({
      action: z.literal("mapping"),
      classId: z.string().min(1).max(200),
      departments: z.array(departmentSchema).max(5),
      expectedRevision: revisionSchema,
      reason: reasonSchema,
    })
    .strict(),
  z
    .object({
      action: z.literal("assignment"),
      quarter: quarterSchema,
      canonicalKey: z.string().min(1).max(200),
      department: departmentSchema,
      reason: reasonSchema,
    })
    .strict(),
]);

/** Optional isolated rollout allowlist; never rewrites or redirects a recipient. */
export function assertDeliveryRecipients(recipients: string[]) {
  const configured = process.env.TUTOR_SIT_INS_TEST_RECIPIENTS;
  if (!configured) return;
  const allowed = new Set(
    configured
      .split(",")
      .map((v) => v.trim().toLowerCase())
      .filter(Boolean),
  );
  if (
    !recipients.length ||
    recipients.some((r) => !allowed.has(r.toLowerCase()))
  )
    throw new SitInError(
      409,
      "Delivery is restricted to isolated test recipients.",
      "TEST_RECIPIENT_ONLY",
    );
}
export function tutorInvitationEmail(
  contact:
    | { onsiteEmail: string | null; onlineEmail: string | null }
    | undefined,
  modality: string | null,
) {
  const candidates = [
    ...new Set(
      [contact?.onsiteEmail, contact?.onlineEmail]
        .filter((v): v is string => !!v)
        .map((v) => v.trim().toLowerCase()),
    ),
  ];
  const email =
    (modality === "online" ? contact?.onlineEmail : contact?.onsiteEmail)
      ?.trim()
      .toLowerCase() || (candidates.length === 1 ? candidates[0] : null);
  if (!email || !emailSchema.safeParse(email).success)
    throw new SitInError(
      409,
      "The tutor's invitation email needs administrator review.",
    );
  return email;
}
