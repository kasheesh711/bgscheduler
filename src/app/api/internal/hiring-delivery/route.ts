import { NextResponse } from "next/server";
import { getDb } from "@/lib/db";
import { createOutboundEmailSender } from "@/lib/email/outbound";
import { pushLineTextMessage } from "@/lib/line/client";
import {
  deliveryRequestSchema,
  verifyDeliveryAuthorization,
} from "@/lib/hiring/dispatch";
import { deliverOutbox } from "@/lib/hiring/worker";
import { audit, settings, type Candidate } from "@/lib/hiring/service";
import { deliverCalendar } from "@/lib/hiring/google";
import { businessDates, instant, HiringError } from "@/lib/hiring/model";
import { hiringError } from "@/lib/hiring/http";
import type { hiringBookings } from "@/lib/db/schema";

export const maxDuration = 120;
export async function POST(request: Request) {
  try {
    const body = await request.text();
    if (
      !verifyDeliveryAuthorization(body, request.headers.get("authorization"))
    )
      throw new HiringError(401, "Hiring worker authentication failed.");
    if (
      process.env.VERCEL_ENV !== "production" ||
      process.env.PREVIEW_SANDBOX_ENABLED === "true"
    )
      throw new HiringError(
        503,
        "Hiring delivery is available only in production.",
      );
    const input = deliveryRequestSchema.parse(JSON.parse(body));
    const db = getDb(),
      { config } = await settings(db);
    if (input.mode !== "test")
      return NextResponse.json({
        sent: await deliverOutbox(db, config, 20, input.mode === "bookings"),
      });
    // Test mail addresses only the organizer; LINE permits a confirmed personal ID, never a group ID.
    const email = config.connectedEmail;
    const text = `This is the approved BeGifted hiring automation delivery test for ${email}. No candidate has been contacted. Test ID: ${input.id}`;
    let receipt: Record<string, unknown>;
    if (input.channel === "email") {
      receipt = await createOutboundEmailSender("primary", {
        strictOutcome: true,
        audience: "teacher",
      }).sendEmail({
        to: email,
        subject: `BeGifted hiring automation delivery test [${input.id.slice(0, 8)}]`,
        text,
        html: `<p>${text}</p>`,
        idempotencyKey: `hiring-self-test:${input.id}`,
      });
    } else if (input.channel === "line") {
      if (!input.lineUserId)
        throw new HiringError(
          400,
          "Confirm the organizer's personal LINE identity first.",
        );
      receipt = {
        ...(await pushLineTextMessage({
          to: input.lineUserId,
          text,
          retryKey: input.id,
          tutorBot: true,
          signal: AbortSignal.timeout(20000),
        })),
      };
    } else {
      const start = instant(businessDates(new Date())[0], 600);
      const booking = {
        id: input.id,
        kind: "mock",
        subjects: ["Mathematics"],
        calendarOwner: email,
        interviewerEmail: email,
        startTime: start,
        endTime: new Date(start.getTime() + 300000),
      } as typeof hiringBookings.$inferSelect;
      const candidate = {
        name: "DELIVERY TEST ONLY — no candidate interview",
        email,
      } as Candidate;
      await deliverCalendar(
        booking,
        candidate,
        "No attendance needed — approved delivery test",
        db,
      );
      receipt = await deliverCalendar(
        booking,
        candidate,
        "No attendance needed — approved delivery test",
        db,
      );
    }
    await audit(db, "authenticated-worker", "delivery-test", null, {
      channel: input.channel,
      id: input.id,
      email,
      receipt,
    });
    return NextResponse.json({ sent: 1, receipt });
  } catch (error) {
    return hiringError(error);
  }
}
