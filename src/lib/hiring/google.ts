import { createHash } from "node:crypto";
import { eq } from "drizzle-orm";
import { getDb, type Database } from "@/lib/db";
import { googleOAuthTokens, hiringBookings } from "@/lib/db/schema";
import { getGoogleSheetsAccessToken } from "@/lib/sales-dashboard/google-oauth";
import { GOOGLE_SCOPES, HiringError, ZONE } from "./model";
import type { Candidate } from "./service";

export async function googleConnectionStatus(
  email: string,
  db: Database = getDb(),
) {
  const [row] = await db
    .select()
    .from(googleOAuthTokens)
    .where(eq(googleOAuthTokens.email, email));
  return {
    connected:
      !!row?.refreshTokenCiphertext &&
      GOOGLE_SCOPES.every((scope) => row.scope?.split(" ").includes(scope)),
    email,
    lastError: row?.lastError ?? null,
  };
}
async function calendarRequest(
  email: string,
  path: string,
  init: RequestInit = {},
  db: Database,
) {
  const connection = await googleConnectionStatus(email, db);
  if (!connection.connected)
    throw new HiringError(
      409,
      "Connect the hiring organizer's Google Calendar.",
    );
  const token = await getGoogleSheetsAccessToken(email, db);
  const response = await fetch(
    "https://www.googleapis.com/calendar/v3/" + path,
    {
      ...init,
      headers: {
        Authorization: `Bearer ${token}`,
        "Content-Type": "application/json",
        ...Object.fromEntries(new Headers(init.headers)),
      },
      signal: AbortSignal.timeout(20000),
      cache: "no-store",
    },
  );
  if (response.status === 404 && (!init.method || init.method === "GET"))
    return null;
  if (!response.ok)
    throw new HiringError(
      response.status === 429 ? 429 : 502,
      `Google Calendar returned ${response.status}.`,
    );
  return response.status === 204
    ? null
    : ((await response.json()) as Record<string, unknown>);
}
export async function deliverCalendar(
  booking: typeof hiringBookings.$inferSelect,
  candidate: Candidate,
  location: string,
  db: Database,
  cancel = false,
) {
  const id = createHash("sha256")
    .update("hiring:" + booking.id)
    .digest("hex");
  const path = "calendars/primary/events";
  const existing = await calendarRequest(
    booking.calendarOwner,
    path + "/" + id,
    {},
    db,
  );
  const staff = booking.kind === "mock"
    ? ["people@begiftededucation.com", "admin@begiftededucation.com"] : [];
  if (existing) {
    const properties = existing.extendedProperties as
      | { private?: { hiringBookingId?: string } }
      | undefined;
    if (properties?.private?.hiringBookingId !== booking.id)
      throw new HiringError(
        409,
        "A Calendar event with a conflicting identity needs review.",
      );
    if (cancel) {
      if (existing.status !== "cancelled")
        await calendarRequest(
          booking.calendarOwner,
          path + "/" + id + "?sendUpdates=all",
          { method: "DELETE" },
          db,
        );
      return { id, cancelled: true };
    }
    const start = existing.start as { dateTime?: string } | undefined,
      end = existing.end as { dateTime?: string } | undefined;
    if (
      existing.status === "cancelled" ||
      Date.parse(start?.dateTime ?? "") !== booking.startTime.getTime() ||
      Date.parse(end?.dateTime ?? "") !== booking.endTime.getTime()
    )
      throw new HiringError(
        409,
        "The Calendar copy was changed. Review this appointment.",
      );
    const attendees = (existing.attendees ?? []) as Array<{ email: string; [key: string]: unknown }>;
    const missing = staff.filter(email => !attendees.some(a => a.email?.toLowerCase() === email));
    if (missing.length) {
      await calendarRequest(booking.calendarOwner, path + "/" + id + "?sendUpdates=all", {
        method: "PATCH", headers: typeof existing.etag === "string" ? { "If-Match": existing.etag } : {}, body: JSON.stringify({ attendees: [...attendees, ...missing.map(email => ({ email }))] }),
      }, db);
    }
    return { id, recovered: true };
  }
  if (cancel) return { id, cancelled: true };
  const attendees = [
    ...new Set(
      [booking.interviewerEmail, candidate.email, ...staff].filter(
        (v): v is string => !!v,
      ),
    ),
  ].map((email) => ({ email }));
  const result = await calendarRequest(
    booking.calendarOwner,
    path + "?sendUpdates=all",
    {
      method: "POST",
      body: JSON.stringify({
        id,
        summary: booking.visitId
          ? booking.kind === "mock"
            ? "BeGifted mock teaching"
            : "BeGifted exam"
          : `BeGifted ${booking.kind === "mock" ? "mock teaching" : "paper assessment"}: ${candidate.name}`,
        description: `${booking.visitId ? `Candidate: ${candidate.name}\n` : ""}Subjects: ${booking.subjects.join(", ")}\n${booking.kind === "mock" ? "The candidate prepares one lesson from an international school syllabus (IGCSE, A Level or IB). The interviewer also selects a topic." : booking.visitId ? "The 2-hour exam. The mock teaching session follows it." : "Two hours are allocated per subject."}`,
        location,
        start: { dateTime: booking.startTime.toISOString(), timeZone: ZONE },
        end: { dateTime: booking.endTime.toISOString(), timeZone: ZONE },
        attendees,
        visibility: "private",
        guestsCanModify: false,
        guestsCanInviteOthers: false,
        extendedProperties: { private: { hiringBookingId: booking.id } },
      }),
    },
    db,
  );
  return { id: String(result?.id ?? id) };
}
