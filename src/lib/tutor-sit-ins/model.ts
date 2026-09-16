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
  "science",
] as const;
export type Department = (typeof DEPARTMENTS)[number];
export const SCOPES = [
  "physics",
  "maths",
  "english",
  "chemistry",
  "science",
  "iseb_english_vr",
  "iseb_maths_vr",
  "iseb_other",
] as const;
export type CoverageScope = (typeof SCOPES)[number];
export const SCOPE_INFO = [
  {
    scope: "physics",
    department: "physics",
    label: "Physics",
    observers: ["apivit.s@hotmail.com"],
  },
  {
    scope: "maths",
    department: "maths",
    label: "Maths",
    observers: ["kasidej.ju@gmail.com"],
  },
  {
    scope: "english",
    department: "english",
    label: "English",
    observers: ["drxiox@gmail.com"],
  },
  {
    scope: "chemistry",
    department: "chemistry",
    label: "Chemistry",
    observers: ["miieiiem@gmail.com"],
  },
  {
    scope: "science",
    department: "science",
    label: "General Science",
    observers: [
      "kasidej.ju@gmail.com",
      "apivit.s@hotmail.com",
      "miieiiem@gmail.com",
    ],
  },
  {
    scope: "iseb_english_vr",
    department: "iseb",
    label: "ISEB · English VR",
    observers: ["drxiox@gmail.com"],
  },
  {
    scope: "iseb_maths_vr",
    department: "iseb",
    label: "ISEB · Maths VR",
    observers: ["kasidej.ju@gmail.com"],
  },
  {
    scope: "iseb_other",
    department: "iseb",
    label: "ISEB · VR / Non VR",
    observers: ["gift.m@begiftededucation.com"],
  },
] as const;
export function scopeOf(row: {
  coverageScope?: string | null;
  department: string;
}): CoverageScope {
  return (row.coverageScope ||
    (row.department === "iseb"
      ? "iseb_other"
      : row.department)) as CoverageScope;
}
export function coverageScopes(row: {
  scopes?: string[] | null;
  departments: readonly string[];
}): CoverageScope[] {
  return (
    row.scopes ?? row.departments.map((department) => scopeOf({ department }))
  ).filter((v): v is CoverageScope => SCOPES.includes(v as CoverageScope));
}
export function scopeLabel(row: {
  coverageScope?: string | null;
  department: string;
}) {
  return (
    SCOPE_INFO.find((v) => v.scope === scopeOf(row))?.label || row.department
  );
}
export const HEADS = [
  { department: "physics", label: "Physics", email: "apivit.s@hotmail.com" },
  { department: "maths", label: "Maths", email: "kasidej.ju@gmail.com" },
  { department: "english", label: "English", email: "drxiox@gmail.com" },
  { department: "chemistry", label: "Chemistry", email: "miieiiem@gmail.com" },
  { department: "iseb", label: "ISEB", email: "gift.m@begiftededucation.com" },
] as const;
export const DEPARTMENT_INFO = [
  ...HEADS.map(({ department, label }) => ({ department, label })),
  { department: "science", label: "General Science" },
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
export const scopeSchema = z.enum(SCOPES);
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
  return [
    ...new Set(
      titleScopes(title).map(
        (scope) => SCOPE_INFO.find((v) => v.scope === scope)!.department,
      ),
    ),
  ];
}
export function titleScopes(title: string): CoverageScope[] {
  const text = title
    .normalize("NFKC")
    .toLowerCase()
    .replace(/[‐‑–—]/g, "-")
    .replace(/\b(eng(?:lish)?|maths?|mathematics)(?=vr\b)/g, "$1 ")
    .replace(/[^\p{L}\p{N}]+/gu, " ");
  const result: CoverageScope[] = [];
  const reasoning =
    /\b(vr|nvr|non[\s-]*vr|(?:non[\s-]*)?verbal(?:\s+reasoning)?)\b/.test(text);
  const english = /\b(eng|english|efl|esl)\b/.test(text);
  const maths = /\b(math|maths|mathematics)\b/.test(text);
  if (/\bphysics\b/.test(text)) result.push("physics");
  if (/\bchemistry\b/.test(text)) result.push("chemistry");
  if (/\bscience\b/.test(text) && !result.length) result.push("science");
  if (reasoning) {
    if (english) result.push("iseb_english_vr");
    if (maths) result.push("iseb_maths_vr");
    if (!english && !maths) result.push("iseb_other");
  } else {
    if (maths) result.push("maths");
    if (english) result.push("english");
    if (/\biseb\b/.test(text)) result.push("iseb_other");
  }
  return result;
}
export type ReadinessIssue = {
  code: string;
  category:
    | "mapping"
    | "students"
    | "family"
    | "identity"
    | "availability"
    | "calendar";
  message: string;
  action: string;
  retryable: boolean;
};
export function issueFromError(error: unknown): ReadinessIssue {
  const code = error instanceof SitInError ? error.code : "SOURCE_UNAVAILABLE";
  const category = code.startsWith("CALENDAR")
    ? "calendar"
    : code === "STUDENT_ROSTER"
      ? "students"
      : code === "IDENTITY_REVIEW" ||
          code === "SELF_OBSERVATION" ||
          code === "ASSIGN_OBSERVER"
        ? "identity"
        : "availability";
  return {
    code,
    category,
    message:
      error instanceof SitInError
        ? error.message
        : "Source verification is temporarily unavailable.",
    action:
      category === "calendar"
        ? "Connect or reconnect the observer’s Calendar."
        : category === "identity"
          ? "Review the observer assignment."
          : category === "students"
            ? "Verify student IDs on the dated Wise lesson and refresh the source sync."
            : "The next refresh will retry verification.",
    retryable: category !== "identity",
  };
}
export type Participant = {
  wiseStudentId?: string;
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
  scopes?: CoverageScope[];
  issues?: ReadinessIssue[];
  participants: Participant[];
  tutorEmail?: string;
};
export const lessonScopes = (lesson: Lesson): CoverageScope[] =>
  coverageScopes(lesson);
export type Suggestion = {
  sessionId: string;
  title: string;
  start: string;
  end: string;
  location: string | null;
  modality: string | null;
  verification?: "wise_only" | "verified";
  issues?: ReadinessIssue[];
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
      departments: z.array(departmentSchema).max(6),
      scopes: z.array(scopeSchema).max(8).optional(),
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
      departments: z.array(departmentSchema).max(6),
      scopes: z.array(scopeSchema).max(8).optional(),
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
      coverageScope: scopeSchema.optional(),
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
