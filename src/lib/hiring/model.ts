import { formatInTimeZone, fromZonedTime } from "date-fns-tz";
import { z } from "zod";
import { weekSchema } from "@/lib/tutor-attendance/model";
import { UNIVERSITY_CATALOG, THAI_UNIVERSITIES } from "./university-catalog";

export const ZONE = "Asia/Bangkok";
export const GOOGLE_SCOPES = [
  "https://www.googleapis.com/auth/spreadsheets",
  "https://www.googleapis.com/auth/calendar.events.owned",
];
export const subscriptionAuthSchema = z.object({
  loggedIn: z.literal(true),
  authMethod: z.literal("claude.ai"),
  subscriptionType: z.enum(["max", "pro", "team", "enterprise"]),
});
const SEEK_STAGES = [
  "Inbox",
  "Prescreen",
  "Shortlist",
  "Interview",
  "Offer",
  "Accept",
  "Not Suitable",
] as const;
export function parseSeekFolderCounts(labels: string[]) {
  const counts = SEEK_STAGES.map((status) => {
    const rows = labels.filter((label) =>
      label.trim().toLowerCase().startsWith(status.toLowerCase()),
    );
    const numbers = rows[0]?.match(/\d[\d,]*/g);
    if (rows.length !== 1 || !numbers)
      throw new Error("SEEK folder counts could not be verified.");
    return {
      status,
      count: Number(numbers[numbers.length - 1].replaceAll(",", "")),
    };
  });
  return counts;
}
export type HiringSourceSummary = {
  scanned: number;
  imported: number;
  remaining: number;
  folders: ReturnType<typeof parseSeekFolderCounts>;
  /** In the last run. Older saved summaries do not have it. */
  resumeUploadsFailed?: number;
};
export const TRACKER_ID = "12bXS1Fnx0BTwrSZXzMU7fWzOgTDfA6-P6rT0v1zDF3M";
export const PRE_SCREEN_URL =
  "https://docs.google.com/forms/d/e/1FAIpQLSfaa3GKRhHK3QgdH8ILbw798tL1PAyN3IfDHve1clPUXUKdZA/viewform";
export const SUBJECTS = [
  "Mathematics",
  "Physics",
  "Chemistry",
  "Biology",
  "Computer Science",
  "ICT",
  "EFL/ESL",
  "English Language",
  "English Literature",
  "IELTS",
  "Economics",
  "Business Studies",
  "Psychology",
  "Geography",
  "History",
  "Thai",
  "French",
  "Art & Design Technology",
] as const;
export const subjectSchema = z.enum(SUBJECTS);
export type Subject = z.infer<typeof subjectSchema>;
export type InterviewKind = "paper" | "mock";
export const tokenKindSchema = z.enum(["paper", "mock", "visit"]);
export const stageSchema = z.enum([
  "new",
  "review",
  "pre_screen",
  "paper_invited",
  "paper_booked",
  "paper_passed",
  "mock_booked",
  "onsite_invited",
  "onsite_booked",
  "no_reply",
  "no_booking",
  "stopped",
]);
export type Stage = z.infer<typeof stageSchema>;
export class HiringError extends Error {
  constructor(
    public status: number,
    message: string,
  ) {
    super(message);
  }
}
export const emailSchema = z.email().trim().toLowerCase().max(254);
export const normalizeEmail = (value: unknown) =>
  emailSchema.safeParse(String(value ?? "").trim()).data ?? null;
export const localDate = (date: Date) =>
  formatInTimeZone(date, ZONE, "yyyy-MM-dd");
export const instant = (date: string, minute: number) =>
  fromZonedTime(
    `${date}T${String(Math.floor(minute / 60)).padStart(2, "0")}:${String(minute % 60).padStart(2, "0")}:00`,
    ZONE,
  );
/** Adds whole days to a yyyy-MM-dd date. Bangkok has no daylight saving, so noon UTC is safe. */
export const shiftDate = (date: string, days: number) => {
  const d = new Date(`${date}T12:00:00Z`);
  d.setUTCDate(d.getUTCDate() + days);
  return d.toISOString().slice(0, 10);
};
/** Monday of the Bangkok week that holds the date. */
export const weekStart = (date: string) =>
  shiftDate(date, -((new Date(`${date}T12:00:00Z`).getUTCDay() + 6) % 7));
export const overlap = (
  a: { start: Date; end: Date },
  b: { start: Date; end: Date },
) => a.start < b.end && b.start < a.end;

export const profileWeightsSchema = z
  .object({
    degree: z.number().int().min(0).max(100),
    subject: z.number().int().min(0).max(100),
    curriculum: z.number().int().min(0).max(100),
    teaching: z.number().int().min(0).max(100),
    english: z.number().int().min(0).max(100),
    prestige: z.number().int().min(0).max(100),
  })
  .strict()
  .refine(
    (v) => Object.values(v).reduce((n, w) => n + w, 0) === 100,
    "Profile weights must total 100.",
  );
export const DEFAULT_WEIGHTS = {
  degree: 10,
  subject: 10,
  curriculum: 20,
  teaching: 20,
  english: 20,
  prestige: 20,
};
export const preScreenWeightsSchema = z
  .object({
    degree: z.number().int().min(0).max(100),
    subject: z.number().int().min(0).max(100),
    curriculum: z.number().int().min(0).max(100),
    teaching: z.number().int().min(0).max(100),
    english: z.number().int().min(0).max(100),
    prestige: z.number().int().min(0).max(100),
    written: z.number().int().min(0).max(100),
    availability: z.number().int().min(0).max(100),
  })
  .strict()
  .refine(
    (v) => Object.values(v).reduce((n, w) => n + w, 0) === 100,
    "Pre-screen weights must total 100.",
  );
export const DEFAULT_PRE_SCREEN_WEIGHTS = {
  degree: 10,
  subject: 10,
  curriculum: 15,
  teaching: 15,
  english: 15,
  prestige: 10,
  written: 15,
  availability: 10,
};
/** A visit link lives this long. Tokens and the onsite expiry rule both read it. */
export const VISIT_LINK_DAYS = 30;
const limit = z.number().int().min(0).max(1000);
const followUpSchema = z
  .object({
    remindDays: z.number().int().min(1).max(60),
    expireDays: z.number().int().min(1).max(120),
  })
  .strict();
/**
 * The config shape. Reads use this one, so a stored config that breaks a rule in `configRuleErrors` still loads:
 * the dashboard shows the problem and a save repairs it. Saves use `configSchema`.
 */
export const baseConfigSchema = z
  .object({
    enabled: z.boolean().default(false),
    deliveryEnabled: z.boolean().default(false),
    rubricApproved: z.boolean().default(true),
    connectedEmail: emailSchema.default("kevhsh7@gmail.com"),
    seekJobId: z
      .string()
      .regex(/^\d{6,12}$/)
      .default("94844236"),
    profileThreshold: z.number().int().min(0).max(100).default(60),
    profileWeights: profileWeightsSchema.default(DEFAULT_WEIGHTS),
    universities: z
      .array(
        z
          .object({
            name: z.string().trim().min(1).max(300),
            aliases: z.array(z.string().trim().min(1).max(300)).max(20),
            country: z.string().regex(/^[A-Z]{2}$/),
            rank: z.number().int().min(1).max(10000).nullable(),
            edition: z.string().regex(/^20\d\d-20\d\d$/),
            sourceUrl: z.url().refine((v) => v.startsWith("https://")),
          })
          .strict(),
      )
      .max(3000)
      .default([...UNIVERSITY_CATALOG, ...THAI_UNIVERSITIES]),
    requireWeekendAndWeekday: z.literal(true).default(true),
    holidays: z.array(z.iso.date()).max(366).default([]),
    interviewers: z
      .array(
        z
          .object({
            canonicalKey: z.string().min(1).max(200),
            subjects: z.array(subjectSchema).min(1),
            email: emailSchema,
            fallbackWeek: weekSchema.optional(),
          })
          .strict(),
      )
      .max(30)
      .default([]),
    paperCapacity: z.number().int().min(1).max(10).default(1),
    paperOfficeHours: z
      .array(
        z
          .object({
            weekday: z.number().int().min(0).max(6),
            startMinute: z.number().int().min(0).max(1439),
            endMinute: z.number().int().min(1).max(1440),
            lastArrivalMinute: z.number().int().min(0).max(1439),
          })
          .refine(
            (v) =>
              v.startMinute < v.endMinute &&
              v.lastArrivalMinute >= v.startMinute &&
              v.lastArrivalMinute < v.endMinute,
          ),
      )
      .max(7)
      .default(
        [1, 2, 3, 4, 5].map((weekday) => ({
          weekday,
          startMinute: 540,
          endMinute: 1080,
          lastArrivalMinute: 959,
        })),
      ),
    preScreenLimits: z
      .object({ perDay: limit, perWeek: limit, waiting: limit, perSubject: limit })
      .strict()
      .default({ perDay: 5, perWeek: 15, waiting: 15, perSubject: 3 }),
    onsiteLimits: z
      .object({ perWeek: limit, unbooked: limit, perHeadPerWeek: limit, perSubject: limit })
      .strict()
      .default({ perWeek: 3, unbooked: 2, perHeadPerWeek: 2, perSubject: 2 }),
    preScreenFollowUp: followUpSchema.default({ remindDays: 3, expireDays: 7 }),
    onsiteFollowUp: followUpSchema.default({ remindDays: 3, expireDays: 7 }),
    preScreenThreshold: z.number().int().min(0).max(100).nullable().default(null),
    preScreenWeights: preScreenWeightsSchema.default(DEFAULT_PRE_SCREEN_WEIGHTS),
    acceptedWorkRights: z
      .array(z.string().trim().min(1).max(300))
      .max(50)
      .default(["I have permanent work rights with no restrictions"]),
    seenWorkRights: z.array(z.string().trim().min(1).max(300)).max(200).default([]),
    subjectPriority: z
      .array(z.object({ subject: subjectSchema, hiring: z.boolean() }).strict())
      .max(SUBJECTS.length)
      .default(SUBJECTS.map((subject) => ({ subject, hiring: true }))),
    visitStartMinute: z.number().int().min(0).max(1439).default(600),
    visitEndMinute: z.number().int().min(1).max(1440).default(960),
    resumeRetentionMonths: z.number().int().min(1).max(120).default(12),
    location: z
      .string()
      .trim()
      .min(1)
      .max(400)
      .default("BeGifted Education, Gaysorn Amarin Tower, 14th floor, Bangkok"),
  })
  .strict();
export type HiringConfig = z.infer<typeof baseConfigSchema>;

/** Rules that link two settings. Plain English, because Kevin reads them on the Rules screen. */
export function configRuleErrors(
  c: Pick<HiringConfig, "visitStartMinute" | "visitEndMinute" | "preScreenFollowUp" | "onsiteFollowUp" | "subjectPriority">,
): { path: (string | number)[]; message: string }[] {
  const errors: { path: (string | number)[]; message: string }[] = [];
  if (c.visitEndMinute <= c.visitStartMinute)
    errors.push({ path: ["visitEndMinute"], message: "Visits must end after they start." });
  if (c.preScreenFollowUp.remindDays >= c.preScreenFollowUp.expireDays)
    errors.push({
      path: ["preScreenFollowUp", "remindDays"],
      message: "The pre-screen reminder must come before the no-reply day.",
    });
  if (c.onsiteFollowUp.remindDays >= c.onsiteFollowUp.expireDays)
    errors.push({
      path: ["onsiteFollowUp", "remindDays"],
      message: "The onsite reminder must come before the link ends.",
    });
  if (c.onsiteFollowUp.expireDays > VISIT_LINK_DAYS)
    errors.push({
      path: ["onsiteFollowUp", "expireDays"],
      message: `The booking link lasts ${VISIT_LINK_DAYS} days, so the onsite link can end after ${VISIT_LINK_DAYS} days at most.`,
    });
  const seen = new Set<string>();
  c.subjectPriority.forEach((p, i) => {
    if (seen.has(p.subject))
      errors.push({ path: ["subjectPriority", i], message: `${p.subject} is in the priority list twice.` });
    seen.add(p.subject);
  });
  return errors;
}
export const configSchema = baseConfigSchema.superRefine((value, ctx) => {
  for (const error of configRuleErrors(value)) ctx.addIssue({ code: "custom", ...error });
});

export const preScreenSchema = z
  .object({
    sourceRow: z.number().int().positive(),
    submittedAt: z.string().max(100),
    degree: z.string().max(500),
    field: z.string().max(2000),
    subjects: z.string().max(2000),
    curricula: z.string().max(4000),
    yearGroups: z.string().max(2000),
    english: z.string().max(1000),
    englishEvidence: z.string().max(5000),
    experience: z.string().max(3000),
    portfolio: z.string().max(2000),
    availability: z.string().max(3000),
    weeklyHours: z.string().max(500),
    motivation: z.string().max(10000),
    teachingApproach: z.string().max(10000),
  })
  .strict();
export type PreScreen = z.infer<typeof preScreenSchema>;
/** The only types a stored résumé can have. Type comes from file bytes, never from a name. */
export const RESUME_TYPES = {
  pdf: "application/pdf",
  docx: "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
} as const;
export type ResumeExtension = keyof typeof RESUME_TYPES;

export const applicationSchema = z
  .object({
    applicationId: z.uuid(),
    name: z.string().trim().min(1).max(300),
    email: emailSchema.nullable(),
    profileText: z.string().min(1).max(120000),
    resumeText: z.string().max(120000).default(""),
    previouslyContacted: z.boolean(),
    sourceStatus: z.string().max(100),
    // The exact SEEK answer. Whether it is accepted comes from the settings list, not from the import.
    workRightsAnswer: z.string().trim().min(1).max(300).nullable().default(null),
  })
  .strict();
export type Application = z.infer<typeof applicationSchema>;

export function normalizeSubjects(value: string): Subject[] {
  const aliases: Record<string, Subject> = {
    math: "Mathematics",
    maths: "Mathematics",
    mathematics: "Mathematics",
    business: "Business Studies",
    "business studies": "Business Studies",
    "efl/esl": "EFL/ESL",
    "english (efl/esl)": "EFL/ESL",
    art: "Art & Design Technology",
    "art & design technology": "Art & Design Technology",
  };
  return [
    ...new Set(
      value.split(/[,;\n]+/).flatMap((part) => {
        const key = part
          .trim()
          .replace(/\s*\/\s*/g, "/")
          .toLowerCase();
        const found =
          aliases[key] ?? SUBJECTS.find((s) => s.toLowerCase() === key);
        return found ? [found] : [];
      }),
    ),
  ];
}

export function businessDates(
  now: Date,
  holidays: string[] = [],
  count = 5,
): string[] {
  const dates: string[] = [];
  // Today is excluded. Every candidate receives five complete future business dates.
  const cursor = new Date(`${localDate(now)}T12:00:00Z`);
  for (let i = 0; dates.length < count && i < 400; i++) {
    cursor.setUTCDate(cursor.getUTCDate() + 1);
    const date = cursor.toISOString().slice(0, 10);
    if (
      cursor.getUTCDay() !== 0 &&
      cursor.getUTCDay() !== 6 &&
      !holidays.includes(date)
    )
      dates.push(date);
  }
  return dates;
}

export type Slot = {
  date: string;
  start: string;
  end: string;
  interviewerKey: string | null;
  subjects: Subject[];
};
export type VisitSlot = {
  date: string;
  examStart: string;
  mockStart: string;
  mockEnd: string;
  interviewerKey: string;
  subject: Subject;
};
export const bookingSchema = z
  .object({
    start: z.iso.datetime(),
    interviewerKey: z.string().min(1).max(200).nullable(),
    subjects: z.array(subjectSchema).min(1).max(5),
    onsiteConfirmed: z.literal(true),
    teachingCommitmentConfirmed: z.literal(true),
  })
  .strict();

// The server assigns the head, so a booking names no interviewer.
export const visitBookingSchema = z
  .object({
    start: z.iso.datetime(),
    subject: subjectSchema,
    onsiteConfirmed: z.literal(true),
    teachingCommitmentConfirmed: z.literal(true),
    move: z.boolean().optional(),
  })
  .strict();

export function runtimeWritesAllowed() {
  return (
    process.env.HIRING_WRITES_ENABLED === "true" &&
    process.env.VERCEL_ENV !== "preview" &&
    process.env.PREVIEW_SANDBOX_ENABLED !== "true"
  );
}
