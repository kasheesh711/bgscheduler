import { after, type NextRequest, NextResponse } from "next/server";
import { getDb } from "@/lib/db";
import { lineChannelSecret, lineSchedulerEnabled } from "@/lib/line/client";
import { handleLineWebhookPost } from "@/lib/line/webhook";

export const maxDuration = 800;

export async function POST(request: NextRequest) {
  const bot = request.nextUrl.searchParams.get("bot");
  if (bot !== null && bot !== "tutors") {
    return NextResponse.json({ ok: false, error: "Unknown LINE bot" }, { status: 400 });
  }
  const tutorBot = bot === "tutors";
  if (!lineSchedulerEnabled(tutorBot)) {
    return NextResponse.json({ ok: false, error: "LINE scheduler is not configured" }, { status: 503 });
  }

  const db = getDb();
  const rawBody = await request.text();
  const result = await handleLineWebhookPost({
    db,
    rawBody,
    signature: request.headers.get("x-line-signature"),
    channelSecret: lineChannelSecret(tutorBot),
    progressOnly: tutorBot,
    handleWeekendCommand: tutorBot ? async event => {
      const text = (event as { message?: { text?: unknown } } | null)?.message?.text;
      if (typeof text !== "string" || !["/จัดตะราง", "/จัดตาราง"].includes(text.trim())) return false;
      const { receiveTheaCommand, runTheaWeekendWorker } = await import("@/lib/classrooms/thea-weekend");
      const result = await receiveTheaCommand(db, event);
      if (result.queued) after(async () => { await runTheaWeekendWorker(db); });
      return result.handled;
    } : undefined,
    handleTeacherQuery: tutorBot ? async event => {
      const { receiveRecruitmentSetup } = await import("@/lib/hiring/recruitment");
      if (await receiveRecruitmentSetup(db, event)) return true;
      const mentions = (event as { message?: { mention?: { mentionees?: Array<{ isSelf?: boolean }> } } } | null)?.message?.mention?.mentionees;
      const text = (event as { message?: { text?: unknown } } | null)?.message?.text;
      if ((!Array.isArray(mentions) || !mentions.some(m => m?.isSelf === true))
        && !(typeof text === "string" && text.trimStart().toLowerCase().startsWith("@thea"))) return false;
      const { receiveTheaQuery, runTheaQueryWorker } = await import("@/lib/line/thea-query-queue");
      const result = await receiveTheaQuery(db, event);
      if (result.queued) after(async () => { await runTheaQueryWorker(db); });
      return result.handled;
    } : undefined,
    scheduleRoomCommand: (eventId) => {
      after(async () => {
        const { processRoomEvent } = await import("@/lib/room-booking/bot");
        await processRoomEvent(db, eventId);
      });
    },
    scheduleProcessing: (lineMessageId) => {
      after(async () => {
        try {
          // Loaded lazily: this drags in the AI-scheduler and search subtrees,
          // which are only ever needed after the 200 has gone back to LINE.
          const { processLineMessageForScheduler } = await import("@/lib/line/review-service");
          await processLineMessageForScheduler(db, lineMessageId);
        } catch (error) {
          console.error("LINE scheduler processing failed", error);
        }
      });
    },
    scheduleGroupCommand: (command) => {
      after(async () => {
        try {
          // Loaded lazily for the same reason — keeps the pre-response cold
          // start to the ingest path only.
          const { handleFeedbackGroupCommand } = await import("@/lib/line/feedback-bot");
          if (await handleFeedbackGroupCommand({ db, ...command, tutorBot })) return;
          const { handleProgressGroupCommand } = await import("@/lib/line/progress-reminders");
          if (await handleProgressGroupCommand({ db, ...command, tutorBot }) || tutorBot) return;
          const { handleScheduleBotGroupCommand } = await import("@/lib/line/schedule-bot-group");
          await handleScheduleBotGroupCommand({ db, ...command });
        } catch (error) {
          console.error("LINE group command processing failed", error);
        }
      });
    },
  });

  return NextResponse.json(result.body, { status: result.status });
}
