import { formatInTimeZone, fromZonedTime } from "date-fns-tz";
import { z } from "zod";
import { weekSchema } from "@/lib/tutor-attendance/model";
import { UNIVERSITY_CATALOG, THAI_UNIVERSITIES } from "./university-catalog";
import { BANGKOK_INTERNATIONAL_SCHOOLS, TOP_THAI_SCHOOLS } from "./high-school-catalog";
import { weekHoursSchema, weekHoursText } from "./week-hours";

export const ZONE = "Asia/Bangkok";
export const GOOGLE_SCOPES = [
  "https://www.googleapis.com/auth/spreadsheets",
  "https://www.googleapis.com/auth/calendar.events.owned",
];
// Reads free and busy time on calendars the connected account can see. It is not in GOOGLE_SCOPES: visit calendar
// delivery must keep working before the owner connects Google again. Only the HR call needs it.
export const GOOGLE_FREEBUSY_SCOPE = "https://www.googleapis.com/auth/calendar.events.freebusy";
// R1: HR Interview (Kevin's decisions, 12 and 22 Nov 2026): the people@ calendar, Monday to Friday, 13:15–18:00 Bangkok (R1_DAY_START),
// 30 minutes on Google Meet, starting on any quarter hour. Fixed in code, so an older worker never meets an unknown settings key.
export const HR_CALENDAR = "people@begiftededucation.com";
/** The `interviewer_key` of every call row, so the booking overlap trigger gives HR one call at a time. */
export const HR_CALL_KEY = "hr-call";
export const CALL_MINUTES = 30;
export const CALL_STEP_MINUTES = 15;
export const CONTRACT_MINUTES = 30;
export const CALL_DAY_START = 9 * 60;
export const CALL_DAY_END = 18 * 60;
// Kevin, 23 Nov 2026: HR takes R1 interviews only after lunch. Contract signings keep the whole day.
export const R1_DAY_START = 13 * 60 + 15;
export const CALL_LINK_DAYS = 14;
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
  /** `imported` is the number of that folder's applications on the website. Older saved summaries do not have it. */
  folders: (ReturnType<typeof parseSeekFolderCounts>[number] & { imported?: number })[];
  /** In the last run. Older saved summaries do not have it. */
  resumeUploadsFailed?: number;
  /** New people in the last run whose résumé SEEK would not let us download (a paid upgrade). Older summaries do not have it. */
  resumeLocked?: number;
  /** One entry per SEEK job read in the last run; the fields above are their sums. Older saved summaries do not have it. */
  campaigns?: (Omit<HiringSourceSummary, "campaigns"> & { jobId: string })[];
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
export const PAPER_LEVELS = ["Key Stage 3", "IGCSE / GCSE", "AS / A-Level", "IB SL / HL", "AP", "Other"] as const;
export type PaperLevel = (typeof PAPER_LEVELS)[number];
export type Subject = z.infer<typeof subjectSchema>;
export type InterviewKind = "paper" | "mock";
// `brief` is the interviewer's page for one mock booking: its id is a booking id, not a candidate id.
// `call` is the candidate's link to book the HR pre-screen call.
// `two-day` (Kevin, 24 Nov 2026) books the test (Monday to Sunday) and the final-round mock teaching on the same day or a later day
// (Monday to Friday) together. `visit` (both on one day) and `paper-visit` (test only) are links sent before that.
// Append only: a short link stores the index of its kind (src/lib/hiring/tokens.ts).
export const tokenKindSchema = z.enum(["paper", "mock", "visit", "paper-visit", "two-day", "brief", "call", "contract", "onboarding", "paper-check"]);
/** A booking of the visit flows. A row of kind `call` belongs to the HR call list only. */
export const isVisitBooking = <T extends { kind: string }>(row: T): row is T & { kind: InterviewKind } =>
  row.kind === "paper" || row.kind === "mock";
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
  "hired",
  "rejected",
  // Under the pass score and never emailed (Kevin, 25 Nov 2026). Not stuck; comes back by a click or an empty subject.
  "soft_rejected",
]);
/** A person sent the result. No import, queue or automatic pass may move this stage. */
export const DECIDED_STAGES = ["hired", "rejected"] as const;
export const isDecided = (stage: string) => (DECIDED_STAGES as readonly string[]).includes(stage);
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
    /** The candidate's own high school. 0 for a config saved before this part existed, so its total stays 100. */
    school: z.number().int().min(0).max(100).default(0),
  })
  .strict()
  .refine(
    (v) => Object.values(v).reduce((n, w) => n + w, 0) === 100,
    "Profile weights must total 100.",
  );
export const DEFAULT_WEIGHTS = {
  degree: 10,
  subject: 10,
  curriculum: 15,
  teaching: 20,
  english: 20,
  prestige: 15,
  // Kevin, 24 Nov 2026: 10 points for the high school, 5 taken from university and 5 from curriculum.
  school: 10,
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
/** Staff grade the paper between the exam and the mock (Kevin, 22 Nov 2026: grading takes 5 to 10 minutes). */
export const VISIT_GAP_MINUTES = 15;
/**
 * A mock teaching time can follow a test when it starts after the test ends and the grading gap: on the same day or on a
 * later day (Kevin, 24 Nov 2026, the same day he first asked for a later day only).
 */
export const mockCanFollow = (examEnd: string | Date, mockStart: string | Date) =>
  new Date(mockStart).getTime() >= new Date(examEnd).getTime() + VISIT_GAP_MINUTES * 60000;
const limit = z.number().int().min(0).max(1000);
const followUpSchema = z
  .object({
    remindDays: z.number().int().min(1).max(60),
    expireDays: z.number().int().min(1).max(120),
  })
  .strict();
const seekJobIdSchema = z.string().regex(/^\d{6,12}$/, "A SEEK job ID has 6 to 12 digits.");
/** The only job before campaigns. Rows imported then carry it, and an old stored config converts to it. */
export const LEGACY_SEEK_JOB_ID = "94844236";
/** A config saved before campaigns has one `seekJobId`. It reads as one active campaign until the next save. */
export function withSeekJobs(raw: unknown): unknown {
  if (!raw || typeof raw !== "object" || !("seekJobId" in raw)) return raw;
  const { seekJobId, ...rest } = raw as Record<string, unknown>;
  return "seekJobs" in rest ? rest : { ...rest, seekJobs: [{ jobId: seekJobId, label: "Tutor ad 2026", active: true }] };
}
/**
 * The config shape. Reads use this one, so a stored config that breaks a rule in `configRuleErrors` still loads:
 * the dashboard shows the problem and a save repairs it. Saves use `configSchema`.
 */
export const baseConfigSchema = z
  .object({
    enabled: z.boolean().default(false),
    deliveryEnabled: z.boolean().default(false),
    recruitmentLineGroupId: z.string().regex(/^C[0-9a-f]{32}$/).nullable().default(null),
    /** Only this candidate may test visit booking while Automation is paused. Messages stay gated. */
    bookingTestCandidateId: z.uuid().nullable().default(null),
    rubricApproved: z.boolean().default(true),
    connectedEmail: emailSchema.default("kevhsh7@gmail.com"),
    /** Each SEEK job ad the worker reads. An inactive job keeps its candidates and is not read. */
    seekJobs: z
      .array(
        z
          .object({ jobId: seekJobIdSchema, label: z.string().trim().min(1).max(80), active: z.boolean() })
          .strict(),
      )
      .min(1)
      .max(5)
      .default([{ jobId: LEGACY_SEEK_JOB_ID, label: "Tutor ad 2026", active: true }]),
    profileThreshold: z.number().int().min(0).max(100).default(60),
    /**
     * Soft reject (Kevin, 25 Nov 2026): when a subject has nobody left at the pass score, the worker brings back its best
     * soft-rejected candidate at or above this profile score. Null turns the automatic bring-back off.
     */
    bringBackFloor: z.number().int().min(0).max(100).nullable().default(null),
    /** A gate pass at or above this profile score waits for HR's good call before the form can go. Null turns calls off. */
    callThreshold: z.number().int().min(0).max(100).nullable().default(80),
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
    /** The high schools that earn points: tier 1 gets the full weight, tier 2 half. A school not listed gets none. */
    highSchools: z
      .array(
        z
          .object({
            name: z.string().trim().min(1).max(300),
            aliases: z.array(z.string().trim().min(1).max(300)).max(20),
            tier: z.union([z.literal(1), z.literal(2)]),
          })
          .strict(),
      )
      .max(500)
      .default([...BANGKOK_INTERNATIONAL_SCHOOLS, ...TOP_THAI_SCHOOLS]),
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
            /** Kevin, 24 Nov 2026: this head's hours are their onsite Wise working hours, read at each check. */
            hoursFromWise: z.boolean().optional(),
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
    /**
     * Points taken off the profile score for a work-rights answer. An answer with no row loses nothing.
     * Optional with no default, so the key enters the saved settings only when a person sets a penalty:
     * the schema is strict, and an app or Mac worker on older code cannot read a key it does not know.
     */
    workRightsPenalties: z
      .array(
        z
          .object({ answer: z.string().trim().min(1).max(300), points: z.number().int().min(1).max(100) })
          .strict(),
      )
      .max(200)
      .optional(),
    subjectPriority: z
      .array(z.object({ subject: subjectSchema, hiring: z.boolean() }).strict())
      .max(SUBJECTS.length)
      .default(SUBJECTS.map((subject) => ({ subject, hiring: true }))),
    visitStartMinute: z.number().int().min(0).max(1439).default(600),
    visitEndMinute: z.number().int().min(1).max(1440).default(960),
    resumeRetentionMonths: z.number().int().min(1).max(120).default(12),
    /**
     * The head who checks a near-miss paper (PAPER_CHECK_FROM_PERCENT up to the pass mark) in each subject. A subject
     * with no row goes to its first mock interviewer. Optional with no default, for the same reason as
     * `workRightsPenalties`; `DEFAULT_PAPER_CHECKERS` applies until a person saves a change.
     */
    paperCheckers: z
      .array(z.object({ subject: subjectSchema, canonicalKey: z.string().min(1).max(200) }).strict())
      .max(SUBJECTS.length)
      .optional(),
    /** The pass percentage for each subject and level of the paper. A pair with no row has no pass mark yet. */
    paperPassRules: z
      .array(z.object({ subject: subjectSchema, level: z.enum(PAPER_LEVELS), percent: z.number().min(0).max(100) }).strict())
      .max(SUBJECTS.length * PAPER_LEVELS.length)
      .default([]),
    location: z
      .string()
      .trim()
      .min(1)
      .max(400)
      .default("BeGifted Education, Gaysorn Amarin Tower, 14th floor, Bangkok"),
  })
  .strict();
export type HiringConfig = z.infer<typeof baseConfigSchema>;
/** Kevin, 24 Nov 2026: a failed paper at or above this best-level percent goes to the subject's head for a check first. */
export const PAPER_CHECK_FROM_PERCENT = 70;
/** Kevin, 24 Nov 2026: Tito checks the English papers. Other subjects go to their mock interviewer. */
export const DEFAULT_PAPER_CHECKERS: NonNullable<HiringConfig["paperCheckers"]> = (["EFL/ESL", "English Language", "English Literature", "IELTS"] as const)
  .map((subject) => ({ subject, canonicalKey: "Tito" }));
/** The head who checks a near-miss paper in this subject, or null when nobody covers it. */
export const paperCheckerFor = (config: Pick<HiringConfig, "paperCheckers" | "interviewers">, subject: Subject) =>
  (config.paperCheckers ?? DEFAULT_PAPER_CHECKERS).find((row) => row.subject === subject)?.canonicalKey
  ?? config.interviewers.find((head) => head.subjects.includes(subject))?.canonicalKey ?? null;

/** Rules that link two settings. Plain English, because Kevin reads them on the Rules screen. */
export function configRuleErrors(
  c: Pick<HiringConfig, "visitStartMinute" | "visitEndMinute" | "preScreenFollowUp" | "onsiteFollowUp" | "subjectPriority" | "seekJobs">,
): { path: (string | number)[]; message: string }[] {
  const errors: { path: (string | number)[]; message: string }[] = [];
  const jobs = new Set<string>();
  c.seekJobs.forEach((job, i) => {
    if (jobs.has(job.jobId))
      errors.push({ path: ["seekJobs", i, "jobId"], message: `SEEK job ${job.jobId} is in the campaign list twice.` });
    jobs.add(job.jobId);
  });
  if (!c.seekJobs.some((job) => job.active))
    errors.push({ path: ["seekJobs"], message: "At least one SEEK campaign must be active." });
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
  // The screen shows the first row and the sheet would use the last, so a repeat is refused.
  const rules = value.paperPassRules.map((rule) => `${rule.subject}|${rule.level}`);
  if (new Set(rules).size !== rules.length)
    ctx.addIssue({ code: "custom", path: ["paperPassRules"], message: "A subject and level can have only one pass mark." });
  for (const error of configRuleErrors(value)) ctx.addIssue({ code: "custom", ...error });
});

export const preScreenSchema = z
  .object({
    // The sheet row of a Google Form answer. 0 is an answer given on the booking page (`answersSchema`).
    sourceRow: z.number().int().nonnegative(),
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
    // The subject the candidate chooses to be tested on at the visit (Kevin, 22 Nov 2026). Older answers have none.
    testSubject: z.string().max(500).optional(),
  })
  .strict();
export type PreScreen = z.infer<typeof preScreenSchema>;
/** The form question that sets the visit subject. The sheet column is found by this header, not by its position. */
export const TEST_SUBJECT_QUESTION = "Which subject do you want to be tested on at your onsite visit?";
/**
 * The questions on the booking page (Kevin, 24 Nov 2026: the questions and the booking are one page). The choices are
 * the Google Form's own texts, because `hardStops` and `availabilityFraction` read these words. The subject list is
 * ours, so every tick is a subject the app knows.
 */
export const ANSWER_CHOICES = {
  degree: ["Below Bachelor's", "Bachelor's", "Master's", "PhD"],
  curricula: ["IB (MYP/ DP)", "British (IGCSE/ GCSE/ A-level)", "American (US High School/ AP)", "Thai National Curriculum"],
  yearGroups: ["Year 2-6 (Primary)", "Year 7-9 (Lower Secondary)", "Year 10-11 (IGCSE Level)", "Year 12-13 (A-level/ IB DP)"],
  english: ["Native", "Advanced (C1)", "Upper-Intermediate (B2)", "Intermediate (B1)"],
  experience: ["Less than 1 year", "1-3 years", "3-5 years", "5+ years"],
  availability: [
    "Weekday Morning (before 12:00)",
    "Weekday Afternoon (12:00-17:00)",
    "Weekday Evening (17:00-21:00)",
    "Weekend Morning (before 12:00)",
    "Weekend Afternoon (12:00-17:00)",
    "Weekend Evening (17:00-21:00)",
  ],
  weeklyHours: ["1-10", "11-20", "20-40", "40+"],
} as const;
/** The Art & Design portfolio file of the booking page: one PDF or picture in private storage (`portfolio.ts`). */
export const PORTFOLIO_TYPES = ["application/pdf", "image/jpeg", "image/png"] as const;
export const MAX_PORTFOLIO_BYTES = 25 * 1024 * 1024;
export const portfolioPath = (candidateId: string) => `hiring-portfolios/${candidateId}`;
const ticks = <T extends readonly [string, ...string[]]>(choices: T, message: string) =>
  z.array(z.enum(choices)).min(1, message).max(choices.length);
// No minimum length (Kevin, 24 Nov 2026). An answer is still needed.
const written = (question: string) => z.string().trim().min(1, `Answer the question "${question}".`).max(5000);
export const answersSchema = z
  .object({
    // One choice: "Below Bachelor's" with a higher degree would read as no degree.
    degree: z.enum(ANSWER_CHOICES.degree),
    field: z.string().trim().min(1, "Write your field of study.").max(200),
    subjects: z.array(subjectSchema).min(1, "Choose at least one subject.").max(SUBJECTS.length),
    testSubject: subjectSchema,
    curricula: ticks(ANSWER_CHOICES.curricula, "Choose at least one curriculum."),
    yearGroups: ticks(ANSWER_CHOICES.yearGroups, "Choose at least one year group."),
    english: z.enum(ANSWER_CHOICES.english),
    englishEvidence: z.string().trim().max(500),
    experience: z.enum(ANSWER_CHOICES.experience),
    // An optional link. The file upload is checked on the server (`answerPreScreen`).
    portfolio: z.string().trim().max(500),
    // The week grid (Kevin, 24 Nov 2026). Stored as text, so every later check reads one format.
    availability: weekHoursSchema,
    weeklyHours: z.enum(ANSWER_CHOICES.weeklyHours),
    motivation: written("Why do you want to tutor with BeGifted?"),
    teachingApproach: written("How would you approach it?"),
  })
  .strict()
  .superRefine((value, ctx) => {
    if (!value.subjects.includes(value.testSubject))
      ctx.addIssue({ code: "custom", path: ["testSubject"], message: "Choose a test subject from the subjects you can teach." });
  });
export type Answers = z.infer<typeof answersSchema>;
/** Page answers in the stored shape of a Google Form answer, so every later check reads one format. */
export const answersToPreScreen = (answers: Answers, now: Date, portfolioFile = ""): PreScreen => ({
  ...answers,
  portfolio: [answers.portfolio, portfolioFile].filter(Boolean).join(" · "),
  sourceRow: 0,
  submittedAt: now.toISOString(),
  subjects: answers.subjects.join(", "),
  curricula: answers.curricula.join(", "),
  yearGroups: answers.yearGroups.join(", "),
  availability: weekHoursText(answers.availability),
});
/** The form answers in reading order, for the admin panel and the interviewer's page. */
export const ANSWER_LABELS: [Exclude<keyof PreScreen, "sourceRow" | "submittedAt">, string][] = [
  ["degree", "Degree"],
  ["field", "Field of study"],
  ["subjects", "Subjects"],
  ["testSubject", "Subject to be tested on"],
  ["curricula", "Curricula"],
  ["yearGroups", "Year groups"],
  ["english", "English level"],
  ["englishEvidence", "English evidence"],
  ["experience", "Teaching experience"],
  ["portfolio", "Portfolio"],
  ["availability", "Availability"],
  ["weeklyHours", "Weekly hours"],
  ["motivation", "Motivation"],
  ["teachingApproach", "Teaching approach"],
];
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
    // The SEEK job the worker read it from. Kept on a new row only, for the SEEK link.
    jobId: seekJobIdSchema.nullable().default(null),
    // The number SEEK shows beside the email, already cleaned by `seekPhone`. HR dials it from the Calls tab.
    phone: z.string().regex(/^\+?\d{8,15}$/).nullable().default(null),
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

// Kevin, 24 Nov 2026: candidates said no times were free, so booking opens four weeks (20 business days), not five days.
export const BOOKING_BUSINESS_DAYS = 20;

export function businessDates(
  now: Date,
  holidays: string[] = [],
  count = BOOKING_BUSINESS_DAYS,
  // The test (Kevin, 24 Nov 2026): a candidate with a full-time job can sit it on a Saturday or Sunday. The weekend
  // days between the business dates are added; they do not use up the count.
  weekends = false,
): string[] {
  const dates: string[] = [];
  // Today is excluded. Every candidate receives `count` complete future business dates.
  const cursor = new Date(`${localDate(now)}T12:00:00Z`);
  for (let i = 0, business = 0; business < count && i < 400; i++) {
    cursor.setUTCDate(cursor.getUTCDate() + 1);
    const date = cursor.toISOString().slice(0, 10);
    if (holidays.includes(date)) continue;
    const weekend = cursor.getUTCDay() === 0 || cursor.getUTCDay() === 6;
    if (weekend && !weekends) continue;
    dates.push(date);
    if (!weekend) business++;
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
  examEnd: string;
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
    /** A "two-day" link: the mock teaching time, after the test at `start` (the same day or a later day). */
    mockStart: z.iso.datetime().optional(),
    subject: subjectSchema,
    onsiteConfirmed: z.literal(true),
    teachingCommitmentConfirmed: z.literal(true),
    move: z.boolean().optional(),
  })
  .strict();

/** A phone number as typed: spaces, dots, dashes and brackets go; 8 to 15 digits stay, with an optional leading +. */
export const phoneSchema = z
  .string()
  .trim()
  .max(40)
  .transform((value) => value.replace(/[\s().-]/g, ""))
  .pipe(z.string().regex(/^\+?\d{8,15}$/, "Enter a phone number with 8 to 15 digits."));
export const callBookingSchema = z
  .object({ start: z.iso.datetime(), phone: phoneSchema, move: z.boolean().optional() })
  .strict();

/** An isolated offer and contract test while regular hiring and delivery are paused. */
export function contractTestAllowed(config: Pick<HiringConfig, "enabled" | "deliveryEnabled" | "bookingTestCandidateId">, id: string) {
  return !config.enabled && !config.deliveryEnabled && config.bookingTestCandidateId === id;
}

export function runtimeWritesAllowed() {
  return (
    process.env.HIRING_WRITES_ENABLED === "true" &&
    process.env.VERCEL_ENV !== "preview" &&
    process.env.PREVIEW_SANDBOX_ENABLED !== "true"
  );
}
