import { z } from "zod";
import { after, NextResponse } from "next/server";
import { requireHiringAdmin } from "@/lib/hiring/access";
import { createFileIntent, finishFile } from "@/lib/hiring/assessment-files";
import { hiringError, requireSameOrigin } from "@/lib/hiring/http";
import { changePaperMarks, changePaperSubject, changeRubric, clearResultCheck } from "@/lib/hiring/marking";
import { RUBRIC_ITEMS, type RubricItem } from "@/lib/hiring/marking-sheet";
import { configSchema, localDate, subjectSchema } from "@/lib/hiring/model";
import { headWeek } from "@/lib/hiring/head-schedule";
import { callCalendarState, candidateById, changePreScreenScore, dashboard, reviewCandidate, saveHeadDays, saveSettings, settings } from "@/lib/hiring/service";
import { moveInQueue, recordCall, resetQueueOrder } from "@/lib/hiring/queue";
import { discardDecision, draftDecision, saveDraft, sendDecision } from "@/lib/hiring/decisions";
import { deliverBookingMessages, deliverOutbox } from "@/lib/hiring/worker";
import { getDb } from "@/lib/db";
import { googleConnectionStatus } from "@/lib/hiring/google";

// A dashboard or head-schedule load can trigger a cold Wise index build.
export const maxDuration = 120;
const headQuery = z.object({
  head: z.string().trim().min(1).max(200),
  weekStart: z.iso.date().optional(),
});
const command = z.discriminatedUnion("action", [
  z
    .object({
      action: z.literal("settings"),
      revision: z.number().int().nonnegative(),
      config: configSchema,
    })
    .strict(),
  z
    .object({
      action: z.literal("head_days"),
      key: z.string().trim().min(1).max(200),
      // Monday to Friday.
      days: z.array(z.boolean()).length(5),
      revision: z.number().int().nonnegative(),
    })
    .strict(),
  z
    .object({
      action: z.literal("queue_move"),
      id: z.uuid(),
      // Far above any real queue. The job has hundreds of applications.
      ahead: z.array(z.uuid()).max(20000),
    })
    .strict(),
  z.object({ action: z.literal("queue_reset") }).strict(),
  z.object({ action: z.literal("call_result"), id: z.uuid(), result: z.enum(["good", "no_answer"]) }).strict(),
  z
    .object({
      action: z.literal("file_intent"),
      kind: z.enum(["question_paper", "mark_scheme", "paper_scan", "mock_rubric"]),
      subject: subjectSchema.nullable(),
      candidateId: z.uuid().nullable(),
      name: z.string().trim().min(1).max(300),
      size: z.number().int().positive(),
    })
    .strict(),
  z.object({ action: z.literal("file_ready"), id: z.uuid() }).strict(),
  z
    .object({
      action: z.literal("paper_edit"),
      id: z.uuid(),
      updatedAt: z.iso.datetime(),
      marks: z.record(z.string().max(60), z.number().min(0).nullable()),
      comment: z.string().trim().max(4000),
    })
    .strict(),
  z
    .object({
      action: z.literal("mock_edit"),
      id: z.uuid(),
      updatedAt: z.iso.datetime(),
      items: z.partialRecord(z.enum(RUBRIC_ITEMS as [RubricItem, ...RubricItem[]]), z.number().nullable()),
      comments: z.string().trim().max(4000),
    })
    .strict(),
  z
    .object({
      action: z.literal("decision_draft"),
      id: z.uuid(),
      decision: z.enum(["hire", "reject"]),
      reason: z.string().trim().max(2000),
    })
    .strict(),
  z.object({ action: z.literal("decision_discard"), id: z.uuid() }).strict(),
  z
    .object({
      action: z.literal("decision_save"),
      id: z.uuid(),
      emailSubject: z.string().trim().min(1).max(200),
      emailBody: z.string().trim().min(1).max(10000),
    })
    .strict(),
  z
    .object({
      action: z.literal("decision_send"),
      id: z.uuid(),
      emailSubject: z.string().trim().min(1).max(200),
      emailBody: z.string().trim().min(1).max(10000),
    })
    .strict(),
  z.object({ action: z.literal("paper_subject"), id: z.uuid(), updatedAt: z.iso.datetime(), subject: subjectSchema }).strict(),
  z.object({ action: z.literal("result_check"), kind: z.enum(["paper", "mock"]), id: z.uuid() }).strict(),
  z
    .object({
      action: z.literal("pre_screen_score"),
      id: z.uuid(),
      revision: z.number().int().nonnegative(),
      score: z.number().min(0).max(100),
      reason: z.string().trim().min(5).max(2000),
    })
    .strict(),
  z
    .object({
      action: z.enum(["advance", "paper_pass", "stop", "invite_onsite", "send_new_link", "cancel_visit", "mark_no_show"]),
      id: z.uuid(),
      revision: z.number().int().nonnegative(),
      subjects: z.array(subjectSchema).max(18),
      reason: z.string().trim().min(5).max(2000),
    })
    .strict(),
]);
export async function GET(request: Request) {
  try {
    await requireHiringAdmin();
    const params = new URL(request.url).searchParams;
    if (params.has("head")) {
      const query = headQuery.parse({
        head: params.get("head"),
        weekStart: params.get("weekStart") ?? undefined,
      });
      const db = getDb();
      const { config } = await settings(db);
      return NextResponse.json(
        await headWeek(db, config, query.head, query.weekStart ?? localDate(new Date())),
        { headers: { "Cache-Control": "no-store" } },
      );
    }
    const id = params.get("candidateId");
    if (id !== null) {
      const candidate = await candidateById(getDb(), z.uuid().parse(id));
      return NextResponse.json(
        { id: candidate.id, profileText: candidate.profileText },
        { headers: { "Cache-Control": "no-store" } },
      );
    }
    const data = await dashboard();
    // The read of the people@ calendar that the call page uses (kept 60 seconds). A slow Google must not hold the
    // dashboard, so it gets 4 seconds here; the read itself goes on and the next load finds its answer.
    let timer: ReturnType<typeof setTimeout> | undefined;
    const callCalendar = await Promise.race([
      callCalendarState(getDb(), data.config),
      new Promise<"unreadable">((resolve) => (timer = setTimeout(() => resolve("unreadable"), 4000))),
    ]).finally(() => clearTimeout(timer));
    return NextResponse.json(
      {
        ...data,
        google: { ...(await googleConnectionStatus(data.config.connectedEmail)), callCalendar },
      },
      { headers: { "Cache-Control": "no-store" } },
    );
  } catch (error) {
    return hiringError(error);
  }
}
export async function POST(request: Request) {
  try {
    const actor = await requireHiringAdmin();
    requireSameOrigin(request);
    const input = command.parse(await request.json());
    if (input.action === "settings") {
      await saveSettings(input.config, input.revision, actor);
      return NextResponse.json({ ok: true });
    }
    if (input.action === "head_days") {
      const saved = await saveHeadDays(input.key, input.days, input.revision, actor);
      return NextResponse.json({ ok: true, ...saved });
    }
    if (input.action === "queue_move") {
      await moveInQueue(input.id, input.ahead, actor, getDb());
      return NextResponse.json({ ok: true });
    }
    if (input.action === "queue_reset") {
      await resetQueueOrder(actor, getDb());
      return NextResponse.json({ ok: true });
    }
    if (input.action === "call_result") {
      await recordCall(input.id, input.result, actor, getDb());
      return NextResponse.json({ ok: true });
    }
    if (input.action === "file_intent") {
      return NextResponse.json(await createFileIntent(input, actor, getDb()));
    }
    if (input.action === "file_ready") {
      const file = await finishFile(input.id, actor, getDb());
      return NextResponse.json({ ok: true, resultId: file.resultId });
    }
    if (input.action === "paper_edit") {
      await changePaperMarks(input.id, input, actor, getDb());
      return NextResponse.json({ ok: true });
    }
    if (input.action === "paper_subject") return NextResponse.json({ ok: true, ...(await changePaperSubject(input.id, input, actor, getDb())) });
    if (input.action === "mock_edit") {
      await changeRubric(input.id, input, actor, getDb());
      return NextResponse.json({ ok: true });
    }
    if (input.action === "decision_draft") {
      await draftDecision(input.id, input, actor, getDb());
      return NextResponse.json({ ok: true });
    }
    if (input.action === "decision_save") {
      await saveDraft(input.id, input, actor, getDb());
      return NextResponse.json({ ok: true });
    }
    if (input.action === "decision_discard") {
      await discardDecision(input.id, actor, getDb());
      return NextResponse.json({ ok: true });
    }
    if (input.action === "decision_send") {
      const db = getDb();
      const key = await sendDecision(input.id, input, actor, db);
      // The row is safe in the outbox, so a failed delivery here is a later retry, not a failed save.
      await settings(db)
        .then(({ config }) => deliverOutbox(db, config, 1, false, key))
        .catch((error) => console.error("Hiring result email delivery failed", error instanceof Error ? error.name : "UnknownError"));
      return NextResponse.json({ ok: true });
    }
    if (input.action === "result_check") {
      await clearResultCheck(input.kind, input.id, actor, getDb());
      return NextResponse.json({ ok: true });
    }
    if (input.action === "pre_screen_score") {
      await changePreScreenScore(input.id, input, actor);
      return NextResponse.json({ ok: true });
    }
    await reviewCandidate(input.id, input, actor);
    after(() => deliverBookingMessages());
    return NextResponse.json({ ok: true });
  } catch (error) {
    return hiringError(error);
  }
}
