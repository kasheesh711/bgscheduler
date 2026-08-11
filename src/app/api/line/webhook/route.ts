import { after, type NextRequest, NextResponse } from "next/server";
import { getDb } from "@/lib/db";
import { lineChannelSecret, lineSchedulerEnabled } from "@/lib/line/client";
import { handleLineWebhookPost } from "@/lib/line/webhook";

export const maxDuration = 60;

export async function POST(request: NextRequest) {
  if (!lineSchedulerEnabled()) {
    return NextResponse.json({ ok: false, error: "LINE scheduler is not configured" }, { status: 503 });
  }

  const db = getDb();
  const rawBody = await request.text();
  const result = await handleLineWebhookPost({
    db,
    rawBody,
    signature: request.headers.get("x-line-signature"),
    channelSecret: lineChannelSecret(),
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
