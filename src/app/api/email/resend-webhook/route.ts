import { type NextRequest, NextResponse } from "next/server";
import { getDb } from "@/lib/db";
import * as schema from "@/lib/db/schema";
import {
  RESEND_WEBHOOK_MAX_BODY_BYTES,
  isDeliveryProblem,
  parseResendEvent,
  verifyResendSignature,
} from "@/lib/email/resend-webhook";

/**
 * Resend delivery webhook. Public route (proxy allowlist); authenticated
 * in-handler by Svix signature. Stores one row per svix-id (replays are
 * no-ops) and logs bounces/complaints by type + message id only.
 */
export async function POST(request: NextRequest) {
  const secret = process.env.RESEND_WEBHOOK_SECRET?.trim();
  if (!secret) return NextResponse.json({ ok: false, error: "Not configured" }, { status: 503 });
  if (Number(request.headers.get("content-length") ?? "0") > RESEND_WEBHOOK_MAX_BODY_BYTES) {
    return NextResponse.json({ ok: false, error: "Payload too large" }, { status: 413 });
  }
  const body = await request.text();
  const svixId = request.headers.get("svix-id");
  const verified = verifyResendSignature({
    secret,
    id: svixId,
    timestamp: request.headers.get("svix-timestamp"),
    signature: request.headers.get("svix-signature"),
    body,
  });
  if (!verified || !svixId) return NextResponse.json({ ok: false, error: "Unauthorized" }, { status: 401 });

  const event = parseResendEvent(body);
  if (!event) return NextResponse.json({ ok: true, ignored: true });
  try {
    await getDb()
      .insert(schema.emailDeliveryEvents)
      .values({
        svixId,
        providerMessageId: event.messageId,
        eventType: event.type,
        bounceType: event.bounceType,
        occurredAt: event.occurredAt,
      })
      .onConflictDoNothing();
  } catch (error) {
    console.error("[resend-webhook] store failed:", error instanceof Error ? error.name : "UnknownError");
    // 500 makes Svix retry with backoff.
    return NextResponse.json({ ok: false }, { status: 500 });
  }
  if (isDeliveryProblem(event.type)) {
    console.error(`[resend-webhook] ${event.type} ${event.bounceType ?? ""} message=${event.messageId ?? "unknown"}`);
  }
  return NextResponse.json({ ok: true });
}
