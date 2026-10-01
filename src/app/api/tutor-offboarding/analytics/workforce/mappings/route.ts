import { NextResponse } from "next/server";
import { z } from "zod";
import { getDb } from "@/lib/db";
import { requireTutorOffboardingAdmin } from "@/lib/tutor-offboarding/access";
import { tutorOffboardingErrorResponse } from "@/lib/tutor-offboarding/api";
import { parseWorkforceQuery } from "@/lib/tutor-offboarding/workforce/query";
import { loadWorkforceEvidence } from "@/lib/tutor-offboarding/workforce/source-db";
import { resolveAcademicSubject, saveSubjectMapping } from "@/lib/tutor-offboarding/workforce/subject-mappings";
import type { ReviewedSubjectMapping, WorkforceSession } from "@/lib/tutor-offboarding/workforce/types";
import { formatInTimeZone } from "date-fns-tz";

const bodySchema = z.object({
  id: z.string().uuid().optional(), classId: z.string().trim().min(1).nullable(),
  sourceValue: z.string().min(1).max(300), subject: z.string().trim().min(1).max(120),
  curriculum: z.string().trim().max(120).nullable(), level: z.string().trim().max(120).nullable(),
  expectedRevision: z.number().int().nonnegative(),
}).strict();

function matchesQuery(session: WorkforceSession, query: ReturnType<typeof parseWorkforceQuery>, roles: Map<string, string | null>, mappings: ReviewedSubjectMapping[]): boolean {
  const sessionDay = session.startAt ? formatInTimeZone(new Date(session.startAt), "Asia/Bangkok", "yyyy-MM-dd") : null;
  if (!sessionDay || sessionDay < query.from || sessionDay > query.to) return false;
  if (query.modality !== "all" && session.modality !== query.modality) return false;
  if (query.role !== "all" && !session.canonicalTutorKeys.some(key => roles.get(key) === query.role)) return false;
  const resolution = resolveAcademicSubject({ classId: session.wiseClassId, sourceValue: session.classTitle }, mappings);
  if (query.subject || query.curriculum || query.level) {
    if (query.subject && resolution.subject !== query.subject) return false;
    if (query.curriculum && resolution.curriculum !== query.curriculum) return false;
    if (query.level && resolution.level !== query.level) return false;
  }
  return true;
}

function noStore(response: Response): Response {
  response.headers.set("Cache-Control", "private, no-store");
  return response;
}

export async function GET(request: Request): Promise<Response> {
  let response: Response;
  try {
    await requireTutorOffboardingAdmin();
    const query = parseWorkforceQuery(new URL(request.url).searchParams);
    const db = getDb();
    const evidence = await loadWorkforceEvidence(db, query, new Date());
    const roles = new Map(evidence.people.map(person => [person.canonicalKey, person.role]));
    const mappings = evidence.subjectMappings;
    const classes = new Map<string, { classId: string | null; sourceValue: string; bookedHours: number; sessionsCount: number }>();
    for (const session of evidence.sessions) {
      if (!matchesQuery(session, query, roles, mappings)) continue;
      const sourceValue = session.classTitle ?? "";
      const resolution = resolveAcademicSubject({ classId: session.wiseClassId, sourceValue }, evidence.subjectMappings);
      if (resolution.subject !== null) continue;
      const key = JSON.stringify([session.wiseClassId, sourceValue]);
      const item = classes.get(key) ?? { classId: session.wiseClassId, sourceValue, bookedHours: 0, sessionsCount: 0 };
      item.sessionsCount += 1;
      if (session.scheduledMinutes !== null && Number.isFinite(session.scheduledMinutes) && session.scheduledMinutes > 0) item.bookedHours += session.scheduledMinutes / 60;
      classes.set(key, item);
    }
    response = NextResponse.json({ mappings, unmappedClasses: [...classes.values()].sort((a, b) => b.bookedHours - a.bookedHours || a.sourceValue.localeCompare(b.sourceValue)) });
  } catch (error) {
    response = tutorOffboardingErrorResponse("[workforce] subject mappings failed", error, "Subject mappings could not load.");
  }
  return noStore(response);
}

export async function POST(request: Request): Promise<Response> {
  let response: Response;
  try {
    const db = getDb();
    const viewer = await requireTutorOffboardingAdmin(db);
    const body = bodySchema.parse(await request.json());
    const mapping = await saveSubjectMapping(db, body, viewer.email);
    response = NextResponse.json({ mapping });
  } catch (error) {
    response = tutorOffboardingErrorResponse("[workforce] subject mapping save failed", error, "Subject mapping could not be saved.");
  }
  return noStore(response);
}
