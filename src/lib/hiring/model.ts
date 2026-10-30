import { formatInTimeZone, fromZonedTime } from "date-fns-tz";
import { z } from "zod";
import { UNIVERSITY_CATALOG, THAI_UNIVERSITIES } from "./university-catalog";

export const ZONE = "Asia/Bangkok";
export const subscriptionAuthSchema = z.object({
  loggedIn: z.literal(true),
  authMethod: z.literal("claude.ai"),
  subscriptionType: z.enum(["max", "pro", "team", "enterprise"]),
});
export const SEEK_STAGES = [
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
    const rows = labels.filter(
      (label) => label.split("\n")[0].trim() === status,
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
export const kindSchema = z.enum(["paper", "mock"]);
export type InterviewKind = z.infer<typeof kindSchema>;
export const stageSchema = z.enum([
  "new",
  "review",
  "pre_screen",
  "paper_invited",
  "paper_booked",
  "paper_passed",
  "mock_booked",
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
export const configSchema = z
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
    location: z
      .string()
      .trim()
      .min(1)
      .max(400)
      .default("BeGifted Education, Gaysorn Amarin Tower, 14th floor, Bangkok"),
  })
  .strict();
export type HiringConfig = z.infer<typeof configSchema>;

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
export const applicationSchema = z
  .object({
    applicationId: z.uuid(),
    name: z.string().trim().min(1).max(300),
    email: emailSchema.nullable(),
    profileText: z.string().min(1).max(120000),
    resumeText: z.string().max(120000).default(""),
    previouslyContacted: z.boolean(),
    sourceStatus: z.string().max(100),
    workRightsConfirmed: z.boolean().nullable().default(null),
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
export const bookingSchema = z
  .object({
    start: z.iso.datetime(),
    interviewerKey: z.string().min(1).max(200).nullable(),
    subjects: z.array(subjectSchema).min(1).max(5),
    onsiteConfirmed: z.literal(true),
    teachingCommitmentConfirmed: z.literal(true),
  })
  .strict();

export function runtimeWritesAllowed() {
  return (
    process.env.HIRING_WRITES_ENABLED === "true" &&
    process.env.VERCEL_ENV !== "preview" &&
    process.env.PREVIEW_SANDBOX_ENABLED !== "true"
  );
}
