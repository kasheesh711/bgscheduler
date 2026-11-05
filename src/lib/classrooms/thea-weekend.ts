import { randomUUID } from "node:crypto";
import { and, asc, eq, gt, isNull, lte, or } from "drizzle-orm";
import { z } from "zod";
import type { Database } from "@/lib/db";
import { withDatabaseTransaction } from "@/lib/db/transaction";
import { theaWeekendJobs as jobs, theaWeekendRequests as requests, classroomPublishJobs } from "@/lib/db/schema";
import { replyLineMessage, pushLineTextMessage, fetchLineGroupSummary } from "@/lib/line/client";
import { runFullSync } from "@/lib/sync/orchestrator";
import { createWiseClient } from "@/lib/wise/client";
import { fetchWiseSessionsForBangkokDates } from "@/lib/wise/day-sessions";
import { isBlockingStatus } from "@/lib/normalization/sessions";
import { addBangkokDays } from "@/lib/room-capacity/dates";
import { getClassroomAssignmentForDate, getClassroomAssignmentByRunId, getFreshClassroomSnapshotForAssignment,
  runIncrementalClassroomAssignment, createClassroomPublishJob, runClassroomPublishJob } from "./data";
import { physicalRoom } from "./room-policy";
import { sessionMatchesLive } from "./overflow-service";
import { classroomTimestampToWiseIso } from "./timestamps";
import { loadClassroomPrintReport } from "./print-report";
import { weekendDates } from "./weekend-config";
import { hashTheaToken, isTheaCommand, THEA_ACTOR_PREFIX, theaEnabled, theaLinkExpiry, theaToken } from "./thea-config";

const eventSchema = z.object({
  type: z.literal("message"), webhookEventId: z.string().min(1), replyToken: z.string().optional(),
  source: z.object({ type: z.literal("group"), groupId: z.string(), userId: z.string().min(1) }),
  message: z.object({ type: z.literal("text"), text: z.string() }),
});
const safeHeaders = { "Cache-Control": "private, no-store", "Referrer-Policy": "no-referrer", "X-Robots-Tag": "noindex, nofollow" };
export { safeHeaders as theaPrivateHeaders };

/** Called only after the tutor channel's raw-body signature has passed. */
export async function receiveTheaCommand(db: Database, raw: unknown): Promise<{ handled: boolean; queued?: boolean }> {
  const text = (raw as { message?: { text?: unknown } } | null)?.message?.text;
  if (typeof text !== "string" || !isTheaCommand(text)) return { handled: false };
  const parsed = eventSchema.safeParse(raw);
  if (!parsed.success) return { handled: true };
  if (!process.env.THEA_LINE_GROUP_ID) {
    // Discovery only: an operator must verify and bind the ID before commands can act.
    const group = await fetchLineGroupSummary(parsed.data.source.groupId, true).catch(() => null);
    if (group) console.info("THEA_GROUP_DISCOVERY", JSON.stringify(group));
    return { handled: true };
  }
  if (!theaEnabled() || parsed.data.source.groupId !== process.env.THEA_LINE_GROUP_ID) return { handled: true };
  const event = parsed.data, saturday = weekendDates(new Date())[0], id = randomUUID();
  const tokenHash = hashTheaToken(theaToken(id));
  const inserted = await withDatabaseTransaction(db, async tx => {
    await tx.insert(jobs).values({ weekendDate: saturday, groupId: event.source.groupId }).onConflictDoNothing();
    const [job] = await tx.select().from(jobs).where(eq(jobs.weekendDate, saturday)).for("update");
    if (job.groupId !== event.source.groupId) throw new Error("The weekend request belongs to a different group.");
    const result = await tx.insert(requests).values({ id, eventId: event.webhookEventId, jobId: job.id,
      groupId: event.source.groupId, lineUserId: event.source.userId, tokenHash, expiresAt: theaLinkExpiry(saturday) })
      .onConflictDoNothing({ target: requests.eventId }).returning({ id: requests.id });
    if (!result.length) return false;
    if (["completed", "failed"].includes(job.status)) await tx.update(jobs).set({ status: "pending", stage: 0,
      attempts: 0, warnings: [], lastError: null, nextAttemptAt: new Date(), updatedAt: new Date() }).where(eq(jobs.id, job.id));
    return true;
  });
  if (inserted && event.replyToken) {
    await replyLineMessage({ tutorBot: true, replyToken: event.replyToken,
      text: `Thea (BOT) กำลังตรวจสอบตารางวันที่ ${saturday} และ ${addBangkokDays(saturday, 1)} ค่ะ เมื่อเสร็จแล้วจะส่งลิงก์ PDF ให้ในกลุ่มนี้` })
      .catch(() => console.error("Thea acknowledgement failed; request remains queued."));
  }
  return { handled: true, queued: inserted };
}

export async function resolveTheaLink(db: Database, token: string, now = new Date()) {
  if (!/^[A-Za-z0-9_-]{43}$/.test(token) || !theaEnabled()) return null;
  const [request] = await db.select().from(requests).where(and(eq(requests.tokenHash, hashTheaToken(token)),
    eq(requests.groupId, process.env.THEA_LINE_GROUP_ID!), gt(requests.expiresAt, now))).limit(1);
  return request?.runIds.length === 2 ? request : null;
}

/** A change to any saved class, or a new class, needs a human allocation review. */
export async function checkTheaDay(db: Database, runId: string) {
  const detail = await getClassroomAssignmentByRunId(db, runId);
  if (!detail.run) throw new Error("Saved classroom plan is missing.");
  const latest = await getClassroomAssignmentForDate(db, detail.run.assignmentDate);
  if (latest.run?.id !== runId) return { detail, changed: true };
  const live = (await fetchWiseSessionsForBangkokDates(createWiseClient(), process.env.WISE_INSTITUTE_ID!,
    [detail.run.assignmentDate], { deadlineAt: Date.now() + 120_000 })).filter(row => isBlockingStatus(row.meetingStatus));
  const byId = new Map(live.map(row => [row._id, row]));
  const changed = live.length !== detail.rows.length || detail.rows.some(row => {
    const source = byId.get(row.wiseSessionId);
    return !sessionMatchesLive(row, source) || (row.status === "assigned" && row.publishStatus === "success"
      && physicalRoom(source?.location ?? "") !== physicalRoom(row.assignedRoom));
  });
  return { detail, changed };
}

export async function loadTheaPrintReport(db: Database, runIds: string[]) {
  const report = await loadClassroomPrintReport(db, runIds);
  if (report.refreshFailed) throw new Error("Student rosters could not be verified. Please retry.");
  const checks = await Promise.all(runIds.map(id => checkTheaDay(db, id)));
  for (const check of checks) {
    if (check.changed) {
      const day = report.days.find(day => day.runId === check.detail.run!.id)!;
      day.draft = true;
    }
  }
  return report;
}

async function deliverTheaRequests(db: Database, job: typeof jobs.$inferSelect) {
  const pending = await db.select().from(requests).where(and(eq(requests.jobId, job.id), isNull(requests.deliveredAt), gt(requests.expiresAt, new Date())));
  for (const request of pending) {
    if (request.groupId !== process.env.THEA_LINE_GROUP_ID) continue;
    const base = process.env.APP_BASE_URL?.replace(/\/+$/, "");
    if (!base || !/^https:\/\//.test(base)) throw new Error("Thea public link address is not configured.");
    const ok = job.status === "completed" && job.runIds.length === 2;
    if (ok) await db.update(requests).set({ runIds: job.runIds }).where(eq(requests.id, request.id));
    const text = ok
      ? `Thea (BOT) ตารางวันที่ ${job.weekendDate} และ ${addBangkokDays(job.weekendDate, 1)}\n${job.warnings.length ? "ต้องตรวจสอบ: " + job.warnings.join("\n") : "ตรวจสอบห้องเรียนกับ Wise แล้วค่ะ"}\nPDF รวมมุมมองตามห้องและตามครู:\n${base}/weekend-schedule/${theaToken(request.id)}\nลิงก์ใช้ได้ถึงสิ้นวันจันทร์ถัดไป`
      : `Thea (BOT) ยังจัดตารางสุดสัปดาห์นี้ไม่สำเร็จค่ะ กรุณาให้ Kevin ตรวจสอบใน Class Assignments แล้วส่ง /จัดตาราง อีกครั้ง`;
    await pushLineTextMessage({ tutorBot: true, to: request.groupId, retryKey: request.id, text, signal: AbortSignal.timeout(15_000) });
    await db.update(requests).set({ deliveredAt: new Date() }).where(eq(requests.id, request.id));
  }
}

/** One durable weekend lease; the recovery cron resumes only work explicitly requested in LINE. */
export async function runTheaWeekendWorker(db: Database) {
  if (!theaEnabled()) return { handled: false };
  const now = new Date(), claimToken = randomUUID();
  const claimed = await withDatabaseTransaction(db, async tx => {
    const [candidate] = await tx.select().from(jobs).where(and(eq(jobs.groupId, process.env.THEA_LINE_GROUP_ID!),
      gt(jobs.weekendDate, addBangkokDays(weekendDates(now)[0], -1)), lte(jobs.nextAttemptAt, now),
      or(eq(jobs.status, "pending"), and(eq(jobs.status, "running"), lte(jobs.leaseExpiresAt, now)))))
      .orderBy(asc(jobs.createdAt)).limit(1).for("update", { skipLocked: true });
    if (!candidate) return null;
    const [job] = await tx.update(jobs).set({ status: "running", claimToken, attempts: candidate.attempts + 1,
      leaseExpiresAt: new Date(now.getTime() + 15 * 60_000), updatedAt: now }).where(eq(jobs.id, candidate.id)).returning();
    return job;
  });
  if (!claimed) return { handled: false };
  let job = claimed;
  const fence = () => and(eq(jobs.id, job.id), eq(jobs.claimToken, claimToken), eq(jobs.status, "running"), gt(jobs.leaseExpiresAt, new Date()));
  const deadline = Date.now() + 700_000;
  const save = async (changes: Partial<typeof jobs.$inferInsert>) => {
    if (!theaEnabled() || job.groupId !== process.env.THEA_LINE_GROUP_ID) throw new Error("Thea was paused or its group changed.");
    const [updated] = await db.update(jobs).set({ ...changes, updatedAt: new Date() }).where(fence()).returning();
    if (!updated) throw new Error("Thea request lease expired.");
    job = updated;
  };
  try {
    while (job.stage < 6) {
      const needed = job.stage === 0 ? 610_000 : job.stage < 3 ? 180_000 : job.stage < 5 ? 230_000 : 150_000;
      if (Date.now() + needed > deadline) break;
      await save({});
      if (job.stage === 0) {
        const existing = await Promise.all(weekendDates(new Date(`${job.weekendDate}T12:00:00+07:00`)).map(date => getClassroomAssignmentForDate(db, date)));
        if (existing.some(day => !day.run)) {
          try { await getFreshClassroomSnapshotForAssignment(db); }
          catch {
            const result = await runFullSync(db, createWiseClient({ signal: AbortSignal.timeout(600_000) }), process.env.WISE_INSTITUTE_ID!);
            if (!result.success) throw new Error(result.errorSummary ?? "Wise sync failed.");
            await getFreshClassroomSnapshotForAssignment(db);
          }
        }
      } else if (job.stage < 3) {
        const date = addBangkokDays(job.weekendDate, job.stage - 1);
        const current = await getClassroomAssignmentForDate(db, date);
        const detail = current.run ? current : await runIncrementalClassroomAssignment(db, {
          date, createOnlyIfMissing: true, forceReassign: false, createdBy: `${THEA_ACTOR_PREFIX}${job.id}`,
        });
        if (!detail.run) throw new Error("Allocation did not return a saved plan.");
        const ids = [...job.runIds]; ids[job.stage - 1] = detail.run.id;
        await save({ runIds: ids });
      } else if (job.stage < 5) {
        const { detail, changed } = await checkTheaDay(db, job.runIds[job.stage - 3]);
        if (changed) {
          await save({ warnings: [...new Set([...job.warnings, `${detail.run!.assignmentDate}: Wise changed; Kevin must review the saved allocation.`])] });
        } else {
          const targets = detail.rows.filter(row => row.status === "assigned" && row.publishStatus !== "success"
            && Date.parse(classroomTimestampToWiseIso(row.startTime)) > Date.now()).map(row => row.id);
          if (targets.length) {
            const progress = await createClassroomPublishJob(db, { runId: detail.run!.id, targetRowIds: targets, createdBy: `${THEA_ACTOR_PREFIX}${job.id}` });
            // A staff command can adopt a pending job, but never take a live writer's lease.
            await db.update(classroomPublishJobs).set({ createdBy: `${THEA_ACTOR_PREFIX}${job.id}` })
              .where(and(eq(classroomPublishJobs.id, progress.jobId), eq(classroomPublishJobs.status, "pending")));
            const result = await runClassroomPublishJob(db, progress.jobId);
            if (["pending", "running"].includes(result.progress.status)) break;
            if (result.progress.status !== "succeeded") await save({ warnings: [...new Set([...job.warnings,
              `${detail.run!.assignmentDate}: Some rooms could not be published; Kevin must review.`])] });
          }
        }
      } else {
        const report = await loadTheaPrintReport(db, job.runIds);
        if (report.days.some(day => day.draft)) await save({ warnings: [...new Set([...job.warnings, "Draft: review the marked classes before use."])] });
      }
      await save({ stage: job.stage + 1, attempts: 0 });
    }
    if (job.stage === 6) {
      // Deliver while retaining the lease, so two invocations cannot send the same receipt.
      await deliverTheaRequests(db, { ...job, status: "completed" });
      await withDatabaseTransaction(db, async tx => {
        await tx.select({ id: jobs.id }).from(jobs).where(fence()).for("update");
        const [pending] = await tx.select({ id: requests.id }).from(requests).where(and(eq(requests.jobId, job.id),
          isNull(requests.deliveredAt), gt(requests.expiresAt, new Date()))).limit(1);
        const [updated] = await tx.update(jobs).set({ status: pending ? "pending" : "completed", claimToken: null,
          leaseExpiresAt: null, lastError: null, nextAttemptAt: new Date(), updatedAt: new Date() }).where(fence()).returning();
        if (!updated) throw new Error("Thea request lease expired before delivery completed.");
        job = updated;
      });
    } else await save({ status: "pending", claimToken: null, leaseExpiresAt: null, nextAttemptAt: new Date(Date.now() + 5 * 60_000) });
    return { handled: true, status: job.status, stage: job.stage };
  } catch (error) {
    const failed = job.attempts >= 3;
    const message = error instanceof Error ? error.message : "Thea weekend request failed.";
    if (failed) await deliverTheaRequests(db, { ...job, status: "failed" }).catch(() => undefined);
    await db.update(jobs).set({ status: failed ? "failed" : "pending", claimToken: null, leaseExpiresAt: null,
      nextAttemptAt: new Date(Date.now() + 5 * 60_000), lastError: message, updatedAt: new Date() }).where(fence());
    return { handled: true, status: failed ? "failed" : "pending" };
  }
}
