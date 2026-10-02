import "server-only";
import { and, eq, inArray, sql } from "drizzle-orm";
import { getDb, type Database } from "@/lib/db";
import * as s from "@/lib/db/schema";
import { createWiseClient } from "@/lib/wise/client";
import type { WiseSession } from "@/lib/wise/types";
import { isPreviewEnvironment } from "@/lib/preview-policy";
import { isIsebClass } from "../format";
import { describeClass } from "../prompt";
import { rosterTutor } from "../roster";
import { recordIncident } from "../incidents";
import { sqlStateOf } from "../db-errors";
import { atomSubject, bangkokDate, evidenceHash } from "./evidence";
import { openAtomReadClient, type AtomReadClient } from "./browser";
import { AtomCollectionError } from "./normalize";
import type { AtomLesson } from "./types";
import { fetchAtomLessonTimetable } from "./wise";
import { configuredAtomTrial } from "./trial";

const RUN = s.feedbackAtomSyncRuns;
const PENDING = ["pending", "generating", "would_submit", "awaiting_recording", "transcribing"] as const;
const refId = (ref: unknown) => typeof ref === "string" ? ref
  : ref && typeof ref === "object" && "_id" in ref && typeof ref._id === "string" ? ref._id : null;

export function lessonsFromWise(sessions: WiseSession[]): AtomLesson[] {
  return sessions.flatMap(session => {
    if (/^CANCELLED$|^CANCELED$/iu.test(session.meetingStatus ?? "")) return [];
    // Missing rosters cannot prove absence of overlapping work.
    if (!Array.isArray(session.students)) throw new AtomCollectionError("response_changed");
    return session.students.map(student => {
      const studentId = refId(student);
      if (!studentId) throw new AtomCollectionError("response_changed");
      return { sessionId: session._id, studentId, teacherId: refId(session.userId) ?? "",
        subject: atomSubject(session.title ?? ""), start: session.scheduledStartTime, end: session.scheduledEndTime };
    });
  });
}

export async function runAtomCollector(input: {
  db: Database;
  openClient: () => Promise<AtomReadClient>;
  fetchDays: (dates: string[]) => Promise<WiseSession[]>;
  deadlineMs: number;
  triggerSource: "cron" | "admin";
  deploymentId?: string | null;
  now?: Date;
  /** Owner-only cloud proof. Does not approve a Wise-to-Atom link or generate feedback. */
  probe?: { studentId: string; date: string };
  trial?: boolean;
}) {
  const { db } = input;
  const now = input.now ?? new Date();
  await db.update(RUN).set({ status: "failed", errorCode: "abandoned", finishedAt: now })
    .where(and(eq(RUN.status, "running"), sql`${RUN.startedAt} < now() - interval '14 minutes'`));
  let runId: string;
  try {
    const [row] = await db.insert(RUN).values({ triggerSource: input.triggerSource, deploymentId: input.deploymentId ?? null }).returning({ id: RUN.id });
    runId = row.id;
  } catch (error) {
    if (sqlStateOf(error) === "23505") return { ok: true, skipped: true, reason: "already_running" };
    throw error;
  }
  let client: AtomReadClient | null = null;
  const studentResults: Record<string, string> = {};
  let failure: string | null = null;
  let snapshots = 0;
  let activityCount = 0;
  let catalog: AtomReadClient["catalog"] = [];
  try {
    const pending = await db.select().from(s.feedbackAutowriterSessions).where(and(
      inArray(s.feedbackAutowriterSessions.state, [...PENDING]),
      sql`${s.feedbackAutowriterSessions.deadlineAt} > now()`,
    ));
    // Include the preceding day: a class ending after Bangkok midnight may have begun the day before.
    const dates = [...new Set(pending.flatMap(row => row.scheduledEndAt ? [
      bangkokDate(row.scheduledEndAt.toISOString()), bangkokDate(new Date(row.scheduledEndAt.getTime() - 86400_000).toISOString()),
    ] : []))];
    if (input.probe) dates.push(input.probe.date,
      bangkokDate(new Date(Date.parse(input.probe.date + "T00:00:00+07:00") - 86400_000).toISOString()));
    if (dates.length > 7) throw new AtomCollectionError("collection_failed");
    const wise = await input.fetchDays([...new Set(dates)]);
    const lessons = lessonsFromWise(wise);
    for (const day of new Set(dates)) {
      await db.insert(s.feedbackAtomTimetables).values({ runId, bangkokDate: day,
        observedAt: now, lessons: lessons.filter(lesson => bangkokDate(lesson.start) <= day && bangkokDate(lesson.end) >= day) });
    }
    const pendingIds = new Set(pending.map(row => row.wiseSessionId));
    const relevantIds = new Set(wise.filter(session => {
      const programme = typeof session.classId === "object" ? session.classId.subject : "";
      return pendingIds.has(session._id) && session.type?.toUpperCase() !== "OFFLINE" &&
        isIsebClass(rosterTutor(refId(session.userId))?.canonicalKey, describeClass({ programme, title: session.title }));
    }).map(session => session._id));
    const links = await db.select().from(s.feedbackAtomLinks).where(eq(s.feedbackAtomLinks.active, true));
    if (input.trial && (!input.probe || !links.some(link => link.atomStudentId === input.probe!.studentId))) {
      throw new AtomCollectionError("collection_failed", "trial_link_unapproved");
    }
    const targets = new Map<string, Set<string>>();
    for (const lesson of lessons.filter(lesson => relevantIds.has(lesson.sessionId))) {
      const link = links.find(link => link.wiseStudentId === lesson.studentId);
      if (!link) continue;
      const wanted = targets.get(link.atomStudentId) ?? new Set<string>();
      wanted.add(bangkokDate(lesson.start));
      wanted.add(bangkokDate(lesson.end));
      targets.set(link.atomStudentId, wanted);
    }
    if (input.probe) {
      const wanted = targets.get(input.probe.studentId) ?? new Set<string>();
      wanted.add(input.probe.date);
      targets.set(input.probe.studentId, wanted);
    }
    client = await input.openClient();
    catalog = client.catalog;
    for (const [studentId, wanted] of targets) {
      if (Date.now() > input.deadlineMs - 30_000) {
        studentResults[studentId] = "collection_failed"; failure = "collection_failed"; continue;
      }
      try {
        const activities = await client.collect(studentId, [...wanted]);
        await db.insert(s.feedbackAtomSnapshots).values({
          runId, atomStudentId: studentId, sourceHash: evidenceHash(activities), activities, collectedAt: new Date(),
        });
        studentResults[studentId] = "succeeded";
        snapshots += 1;
        activityCount += activities.length;
      } catch (error) {
        const code = error instanceof AtomCollectionError ? error.code : "collection_failed";
        studentResults[studentId] = code;
        failure = code;
        if (code === "authentication_failed") break;
      }
    }
  } catch (error) {
    failure = error instanceof AtomCollectionError ? error.code : "collection_failed";
  } finally {
    await client?.close().catch(() => undefined);
    await db.update(RUN).set({
      status: failure ? "failed" : "succeeded", finishedAt: new Date(), errorCode: failure,
      counts: { snapshots, activities: activityCount, catalog, studentResults, probe: Boolean(input.probe), trial: Boolean(input.trial) },
    }).where(eq(RUN.id, runId));
  }
  if (failure) {
    await recordIncident(db, {
      dedupeKey: `atom-collection:${bangkokDate(now.toISOString())}:${failure}`,
      kind: "atom_collection_failed", severity: "critical",
      summary: `Atom collection needs attention: ${failure}. Lesson-only feedback remains available.`,
      detail: { runId, code: failure },
    });
  }
  return { ok: !failure, runId, snapshots, activities: activityCount, catalogStudents: catalog.length, errorCode: failure };
}

export async function collectAtomOnServer(triggerSource: "cron" | "admin" = "cron", probe?: { studentId: string; date: string }) {
  if (isPreviewEnvironment() || process.env.FEEDBACK_ATOM_COLLECTOR_ENABLED !== "true") {
    return { ok: true, skipped: true, reason: "collector_disabled" };
  }
  const username = process.env.ATOM_USERNAME;
  const password = process.env.ATOM_PASSWORD;
  const { env } = await import("@/lib/env");
  const deadlineMs = Date.now() + 690_000;
  const wise = createWiseClient();
  const trial = triggerSource === "cron" ? configuredAtomTrial(process.env) : null;
  return runAtomCollector({
    db: getDb(), deadlineMs, triggerSource, deploymentId: process.env.VERCEL_DEPLOYMENT_ID ?? process.env.VERCEL_URL ?? null,
    probe: probe ?? trial ?? undefined, trial: Boolean(trial),
    openClient: () => {
      if (!username || !password) throw new AtomCollectionError("authentication_failed");
      return openAtomReadClient({ username, password, deadlineMs });
    },
    fetchDays: dates => fetchAtomLessonTimetable(wise, env.WISE_INSTITUTE_ID, dates, { deadlineAt: deadlineMs }),
  });
}
