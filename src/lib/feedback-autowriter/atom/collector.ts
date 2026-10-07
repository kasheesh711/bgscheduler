import "server-only";
import { and, eq, inArray, sql } from "drizzle-orm";
import { getDb, type Database } from "@/lib/db";
import * as s from "@/lib/db/schema";
import { createWiseClient, WiseApiError } from "@/lib/wise/client";
import type { WiseSession } from "@/lib/wise/types";
import { isPreviewEnvironment } from "@/lib/preview-policy";
import { isIsebClass } from "../format";
import { describeClass } from "../prompt";
import { rosterTutor } from "../roster";
import { recordIncident, refreshOpenIncident } from "../incidents";
import { sqlStateOf } from "../db-errors";
import { atomSubject, bangkokDate, evidenceHash } from "./evidence";
import { openAtomReadClient, type AtomReadClient } from "./browser";
import type { AtomLesson, AtomSkippedRecord } from "./types";
import { AtomCollectionError } from "./normalize";
import { fetchAtomLessonTimetable, isCancelledWiseSession } from "./wise";
import { configuredAtomTrial } from "./trial";
import { withAtomTimeout } from "./deadline";

const RUN = s.feedbackAtomSyncRuns;
const PENDING = ["pending", "generating", "would_submit", "awaiting_recording", "transcribing"] as const;
const refId = (ref: unknown) => typeof ref === "string" ? ref
  : ref && typeof ref === "object" && "_id" in ref && typeof ref._id === "string" ? ref._id : null;

export function lessonsFromWise(sessions: WiseSession[]): AtomLesson[] {
  return sessions.flatMap(session => {
    if (isCancelledWiseSession(session)) return [];
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

/**
 * A fixed label for why a step failed. Raw error text can carry Wise or Atom payload values, so only these labels
 * are stored on the run and the incident.
 */
export function atomFailureCause(error: unknown): string {
  if (error instanceof AtomCollectionError) return error.stage ?? error.code;
  if (error instanceof WiseApiError) return Number.isInteger(error.status) ? `wise_http_${error.status}` : "wise_http";
  if (!(error instanceof Error)) return "unknown";
  const message = error.message;
  if (/occurrences conflict/iu.test(message)) return "timetable_conflict";
  if (/pagination|advertised session page|page count contradicts/iu.test(message)) return "pagination_incomplete";
  if (/time budget/iu.test(message) || error.name === "TimeoutError" || error.name === "AbortError") return "time_budget";
  if (/invalid, duplicate or out-of-date|duplicate, missing, or invalid session/iu.test(message)) return "invalid_session";
  if (/invalid wise calendar date/iu.test(message)) return "invalid_date";
  return /^[A-Za-z]{1,40}$/u.test(error.name) ? error.name : "unknown";
}

/** What a person does about a failed run, by its code (the alert is pushed, so it says so in one line). */
export function atomNextStep(code: string): string {
  switch (code) {
    case "authentication_failed": return "Next: check the Atom login (ATOM_USERNAME / ATOM_PASSWORD) by signing in to Atom with it.";
    case "response_changed": return "Next: Atom changed a page or response; the collector needs updating before Atom data returns.";
    case "source_contradiction": return "Next: a student's Atom data belongs to someone else or another subject; check that student's Atom link on the Atom review page.";
    default: return "Next: usually passing (Wise or Atom slow); act only if the next runs fail too.";
  }
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
  // Records left out because their list entry and transcript disagree; the student's other activities are kept.
  const skippedRecords: Record<string, AtomSkippedRecord[]> = {};
  // Assigned only through `fail`; the casts keep TS from narrowing these to their initial null.
  let failure = null as string | null;
  // The step in progress and a fixed cause label, so a failed run says where it stopped.
  let stage = "pending_query";
  let failureStage = null as string | null;
  let failureCause = null as string | null;
  // Set once the run deadline passes. Work still in flight after that must not write evidence or change the outcome.
  let stopped = false;
  const fail = (code: string, cause: string) => {
    if (stopped) return;
    failure = code; failureStage = stage; failureCause = cause;
  };
  let snapshots = 0;
  let activityCount = 0;
  let catalog: AtomReadClient["catalog"] = [];
  let recorded = { snapshots: 0, activities: 0 };
  const work = async () => {
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
    if (dates.length > 7) throw new AtomCollectionError("collection_failed", "too_many_dates");
    stage = "wise_timetable";
    const wise = await input.fetchDays([...new Set(dates)]);
    const lessons = lessonsFromWise(wise);
    stage = "timetable_write";
    for (const day of new Set(dates)) {
      if (stopped) return;
      await db.insert(s.feedbackAtomTimetables).values({ runId, bangkokDate: day,
        observedAt: now, lessons: lessons.filter(lesson => bangkokDate(lesson.start) <= day && bangkokDate(lesson.end) >= day) });
    }
    stage = "lesson_scope";
    const pendingIds = new Set(pending.map(row => row.wiseSessionId));
    const relevantIds = new Set(wise.filter(session => {
      const programme = typeof session.classId === "object" ? session.classId.subject : "";
      return pendingIds.has(session._id) && session.type?.toUpperCase() !== "OFFLINE" &&
        isIsebClass(rosterTutor(refId(session.userId))?.canonicalKey, describeClass({ programme, title: session.title }));
    }).map(session => session._id));
    if (stopped) return;
    stage = "link_lookup";
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
    if (stopped) return;
    stage = "atom_open";
    const opened = await input.openClient();
    if (stopped) { await opened.close().catch(() => undefined); return; }
    client = opened;
    catalog = opened.catalog;
    stage = "atom_collect";
    for (const [studentId, wanted] of targets) {
      if (stopped) return;
      if (Date.now() > input.deadlineMs - 30_000) {
        studentResults[studentId] = "collection_failed"; fail("collection_failed", "time_budget"); continue;
      }
      try {
        const { activities, skipped } = await opened.collect(studentId, [...wanted]);
        if (stopped) return;
        await db.insert(s.feedbackAtomSnapshots).values({
          runId, atomStudentId: studentId, sourceHash: evidenceHash(activities), activities, collectedAt: new Date(),
        });
        studentResults[studentId] = "succeeded";
        if (skipped.length) skippedRecords[studentId] = skipped;
        snapshots += 1;
        activityCount += activities.length;
      } catch (error) {
        const code = error instanceof AtomCollectionError ? error.code : "collection_failed";
        studentResults[studentId] = code;
        fail(code, atomFailureCause(error));
        if (code === "authentication_failed") break;
      }
    }
  };
  try {
    // Vercel kills the function at its maxDuration, before `finally` could record why. Stop first.
    await withAtomTimeout(work(), input.deadlineMs - Date.now(), "run_deadline");
  } catch (error) {
    fail(error instanceof AtomCollectionError ? error.code : "collection_failed", atomFailureCause(error));
  } finally {
    stopped = true;
    // Late work can still finish an insert already in flight; the record and the response use these values.
    recorded = { snapshots, activities: activityCount };
    // Record the outcome before closing the browser, whose shutdown can hang. Close even if the write fails.
    try {
      await db.update(RUN).set({
        status: failure ? "failed" : "succeeded", finishedAt: new Date(), errorCode: failure,
        counts: { snapshots: recorded.snapshots, activities: recorded.activities, catalog, studentResults, skipped: skippedRecords, probe: Boolean(input.probe),
          trial: Boolean(input.trial), ...(failure ? { failureStage, failureCause } : {}) },
      }).where(eq(RUN.id, runId));
    } finally {
      await withAtomTimeout((client as AtomReadClient | null)?.close() ?? Promise.resolve(), 10_000, "close").catch(() => undefined);
    }
  }
  if (failure) {
    const incident = {
      dedupeKey: `atom-collection:${bangkokDate(now.toISOString())}:${failure}`,
      summary: `Atom collection needs attention: ${failure} (${failureStage}: ${failureCause}). Lesson-only feedback remains available. ` +
        atomNextStep(failure),
      detail: { runId, code: failure, stage: failureStage, cause: failureCause, studentResults },
    };
    if (!await recordIncident(db, { ...incident, kind: "atom_collection_failed", severity: "critical" })) {
      await refreshOpenIncident(db, incident);
    }
  }
  // One dashboard-only note per skipped record, ever: the data is Atom's to fix, and nothing is held meanwhile. After
  // the critical incident, and never able to lose it.
  try {
    for (const [atomStudentId, records] of Object.entries(skippedRecords)) {
      for (const record of records) {
        await recordIncident(db, {
          dedupeKey: `atom-record-skipped:${record.id}`, kind: "atom_record_skipped", severity: "info",
          summary: `One Atom ${record.kind === "exam_topic" ? "exam topic" : record.kind} was left out: its list entry and transcript ` +
            "disagree. The student's other Atom work is still used; open the record in Atom to check it.",
          detail: { runId, atomStudentId, activityId: record.id, kind: record.kind, cause: record.cause,
            atomUrl: `https://app.atomlearning.com/tutor/transcript/${record.id}` },
        });
      }
    }
  } catch (error) {
    console.error("[feedback-autowriter] Atom skipped-record note failed", error instanceof Error ? error.name : "Error");
  }
  return { ok: !failure, runId, snapshots: recorded.snapshots, activities: recorded.activities, catalogStudents: catalog.length, errorCode: failure,
    ...(failure ? { failureStage, failureCause } : {}) };
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
