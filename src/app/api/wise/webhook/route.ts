import { after, type NextRequest, NextResponse } from "next/server";
import { getDb } from "@/lib/db";
import * as schema from "@/lib/db/schema";
import {
  AUTOWRITER_TRIGGER_EVENTS,
  WISE_WEBHOOK_MAX_BODY_BYTES,
  parseWiseWebhookBody,
  verifyWiseWebhookAuth,
  wiseWebhookAuthHeader,
  wiseWebhookDedupeKey,
  wiseWebhooksEnabled,
} from "@/lib/feedback-autowriter/webhook";

// `after()` work (the autowriter for one session) runs under this ceiling.
export const maxDuration = 800;

/**
 * Wise webhook receiver. Authenticates the shared key, stores the delivery,
 * answers 200 well inside Wise's 5-second budget, and only then hands
 * lesson-ended events to the feedback autowriter. The body is a hint: the
 * session is always re-read from Wise before anything is written.
 */
export async function POST(request: NextRequest) {
  const secret = process.env.WISE_WEBHOOK_SECRET;
  const headerName = wiseWebhookAuthHeader();
  if (!verifyWiseWebhookAuth(request.headers.get(headerName), secret)) {
    // Names only, never values: this is how the header name is learned at setup.
    console.error("[wise-webhook] unauthorized delivery; header names:", [...request.headers.keys()].join(","));
    return NextResponse.json({ ok: false, error: "Unauthorized" }, { status: 401 });
  }
  if (Number(request.headers.get("content-length") ?? "0") > WISE_WEBHOOK_MAX_BODY_BYTES) {
    return NextResponse.json({ ok: false, error: "Payload too large" }, { status: 413 });
  }
  const raw = await request.text();
  if (Buffer.byteLength(raw) > WISE_WEBHOOK_MAX_BODY_BYTES) {
    return NextResponse.json({ ok: false, error: "Payload too large" }, { status: 413 });
  }
  if (!wiseWebhooksEnabled()) return NextResponse.json({ ok: true, ignored: true });

  const parsed = parseWiseWebhookBody(raw);
  const db = getDb();
  const inserted = await db.insert(schema.wiseWebhookEvents).values({
    dedupeKey: wiseWebhookDedupeKey(raw),
    eventName: parsed?.eventName ?? null,
    wiseSessionId: parsed?.sessionId ?? null,
    payload: parsed?.json ?? { unparsed: raw.slice(0, 10_000) },
  }).onConflictDoNothing({ target: schema.wiseWebhookEvents.dedupeKey })
    .returning({ id: schema.wiseWebhookEvents.id });

  const eventId = inserted[0]?.id;
  const sessionId = parsed?.sessionId;
  if (eventId && sessionId && parsed?.eventName && AUTOWRITER_TRIGGER_EVENTS.has(parsed.eventName)) {
    after(async () => {
      try {
        // Loaded lazily so the pre-response path stays auth + one insert.
        const { processWebhookTrigger } = await import("@/lib/feedback-autowriter/dispatch");
        await processWebhookTrigger(db, eventId, sessionId);
      } catch (error) {
        console.error("[wise-webhook] autowriter dispatch failed", error instanceof Error ? error.name : "Error");
      }
    });
  }
  return NextResponse.json({ ok: true, duplicate: !eventId });
}
