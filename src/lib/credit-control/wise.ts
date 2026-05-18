import { z } from "zod";
import type { WiseClient } from "@/lib/wise/client";

const PAGE_SIZE = 100;
const DATE_WINDOW_DAYS = 31;

export const WiseCreditStudentSchema = z.object({
  _id: z.string(),
  name: z.string(),
  email: z.string().optional(),
  activated: z.coerce.boolean().default(false),
  parents: z.array(z.object({
    _id: z.string().optional(),
    name: z.string().optional(),
  }).passthrough()).default([]),
  classrooms: z.array(z.object({
    _id: z.string(),
    name: z.string().optional(),
    subject: z.string().optional(),
    classType: z.string().optional(),
  }).passthrough()).default([]),
}).passthrough();

export const WiseCreditSessionSchema = z.object({
  _id: z.string(),
  classId: z.object({
    _id: z.string(),
    name: z.string().optional(),
    subject: z.string().optional(),
    classType: z.string().optional(),
  }).passthrough(),
  scheduledStartTime: z.coerce.date(),
  scheduledEndTime: z.coerce.date().optional(),
  meetingStatus: z.string(),
  duration: z.coerce.number().optional(),
  students: z.array(z.string()).default([]),
}).passthrough();

export const WiseSessionCreditsSchema = z.object({
  data: z.object({
    credits: z.object({
      total: z.coerce.number().default(0),
      consumed: z.coerce.number().default(0),
      bookedSessions: z.coerce.number().default(0),
      remaining: z.coerce.number().default(0),
      available: z.coerce.number().default(0),
    }),
    sessionCreditHistory: z.array(z.object({
      _id: z.string(),
      createdAt: z.coerce.date().optional(),
      duration: z.coerce.number().optional(),
      credit: z.coerce.number().default(0),
      type: z.string().optional(),
      meetingStatus: z.string().optional(),
      classroom: z.object({
        _id: z.string().optional(),
        name: z.string().optional(),
        subject: z.string().optional(),
        classType: z.string().optional(),
      }).passthrough().optional(),
    }).passthrough()).default([]),
  }),
}).passthrough();

const WiseStudentsEnvelopeSchema = z.object({
  data: z.object({
    students: z.array(WiseCreditStudentSchema).default([]),
    count: z.coerce.number().optional(),
  }),
}).passthrough();

const WiseSessionsEnvelopeSchema = z.object({
  data: z.object({
    sessions: z.array(WiseCreditSessionSchema).default([]),
    count: z.coerce.number().optional(),
    totalRecords: z.coerce.number().optional(),
  }),
}).passthrough();

const WiseSessionDetailSchema = z.object({
  data: z.object({
    teacherFeedback: z.string().optional(),
  }).passthrough(),
}).passthrough();

export type WiseCreditStudent = z.infer<typeof WiseCreditStudentSchema>;
export type WiseCreditSession = z.infer<typeof WiseCreditSessionSchema>;
export type WiseSessionCredits = z.infer<typeof WiseSessionCreditsSchema>["data"];

function isoDate(value: Date): string {
  return value.toISOString().slice(0, 10);
}

function addUtcDays(value: Date, days: number): Date {
  const next = new Date(value);
  next.setUTCDate(next.getUTCDate() + days);
  return next;
}

function minDate(a: Date, b: Date): Date {
  return a.getTime() <= b.getTime() ? a : b;
}

export function durationMsToMinutes(durationMs: number | undefined): number {
  if (!durationMs || !Number.isFinite(durationMs) || durationMs <= 0) return 0;
  return Math.round(durationMs / 60_000);
}

export async function fetchCreditStudents(
  client: WiseClient,
  instituteId: string,
): Promise<WiseCreditStudent[]> {
  const all: WiseCreditStudent[] = [];
  for (let page = 1; ; page += 1) {
    const response = await client.get<unknown>(`/institutes/v3/${instituteId}/students`, {
      page_number: String(page),
      page_size: String(PAGE_SIZE),
      showParents: "true",
    });
    const parsed = WiseStudentsEnvelopeSchema.parse(response);
    const students = parsed.data.students;
    all.push(...students);
    if (students.length < PAGE_SIZE) break;
  }
  return all;
}

export async function fetchCreditSessions(
  client: WiseClient,
  instituteId: string,
  status: "PAST" | "FUTURE",
  startDate: Date,
  endDate: Date,
): Promise<WiseCreditSession[]> {
  const all: WiseCreditSession[] = [];
  for (let windowStart = startDate; windowStart <= endDate; windowStart = addUtcDays(windowStart, DATE_WINDOW_DAYS)) {
    const windowEnd = minDate(addUtcDays(windowStart, DATE_WINDOW_DAYS - 1), endDate);
    for (let page = 1; ; page += 1) {
      const response = await client.get<unknown>(`/institutes/${instituteId}/sessions`, {
        status,
        paginateBy: "DATE",
        startDate: isoDate(windowStart),
        endDate: isoDate(windowEnd),
        page_number: String(page),
        page_size: String(PAGE_SIZE),
      });
      const parsed = WiseSessionsEnvelopeSchema.parse(response);
      const sessions = parsed.data.sessions;
      all.push(...sessions);
      if (sessions.length < PAGE_SIZE) break;
    }
  }
  return all;
}

export async function fetchSessionCredits(
  client: WiseClient,
  instituteId: string,
  classId: string,
  studentId: string,
): Promise<WiseSessionCredits> {
  const response = await client.get<unknown>(
    `/institutes/${instituteId}/classes/${classId}/students/${studentId}/sessionCredits`,
    { fetchHistory: "true" },
  );
  return WiseSessionCreditsSchema.parse(response).data;
}

export async function fetchSessionTeacherFeedback(
  client: WiseClient,
  classId: string,
  sessionId: string,
): Promise<string> {
  const response = await client.get<unknown>(
    `/user/classes/${classId}/sessions/${sessionId}`,
    {
      showFeedbackConfig: "true",
      showFeedbackSubmission: "true",
    },
  );
  return WiseSessionDetailSchema.parse(response).data.teacherFeedback ?? "";
}
