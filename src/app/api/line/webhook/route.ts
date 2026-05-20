import { after, type NextRequest, NextResponse } from "next/server";
import { getDb } from "@/lib/db";
import { lineChannelSecret, lineSchedulerEnabled } from "@/lib/line/client";
import { handleLineWebhookPost } from "@/lib/line/webhook";
import { processLineMessageForScheduler } from "@/lib/line/review-service";

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
          await processLineMessageForScheduler(db, lineMessageId);
        } catch (error) {
          console.error("LINE scheduler processing failed", error);
        }
      });
    },
  });

  return NextResponse.json(result.body, { status: result.status });
}
