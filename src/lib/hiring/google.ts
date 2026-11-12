import { createHash } from "node:crypto";
import { eq } from "drizzle-orm";
import { getDb, type Database } from "@/lib/db";
import { googleOAuthTokens, hiringBookings } from "@/lib/db/schema";
import { getGoogleSheetsAccessToken } from "@/lib/sales-dashboard/google-oauth";
import { GOOGLE_FREEBUSY_SCOPE, GOOGLE_SCOPES, HR_CALENDAR, HiringError, ZONE } from "./model";
import type { Candidate } from "./service";

export async function googleConnectionStatus(
  email: string,
  db: Database = getDb(),
) {
  const [row] = await db
    .select()
    .from(googleOAuthTokens)
    .where(eq(googleOAuthTokens.email, email));
  const scopes = row?.scope?.split(" ") ?? [];
  const connected = !!row?.refreshTokenCiphertext && GOOGLE_SCOPES.every((scope) => scopes.includes(scope));
  return {
    connected,
    // The HR call needs one more permission. It is apart from `connected`, so visit delivery works before the re-connect.
    freeBusy: connected && scopes.includes(GOOGLE_FREEBUSY_SCOPE),
    email,
    lastError: row?.lastError ?? null,
  };
}
/**
 * The busy time on HR's calendar, read live. It throws unless Google returned a complete answer for that calendar, so a
 * caller can never show a time it could not prove free.
 */
export async function readHrBusy(owner: string, from: Date, to: Date, db: Database = getDb()) {
  if (!(await googleConnectionStatus(owner, db)).freeBusy)
    throw new HiringError(409, "Connect Google again to let Hiring read the call calendar.");
  const result = (await calendarRequest(
    owner,
    "freeBusy",
    {
      method: "POST",
      body: JSON.stringify({ timeMin: from.toISOString(), timeMax: to.toISOString(), items: [{ id: HR_CALENDAR }] }),
    },
    db,
  ).catch((error) => {
    // A timeout or a network failure is also "no answer": the caller shows no times and says so.
    if (error instanceof HiringError) throw error;
    console.error("Hiring call calendar read failed", error instanceof Error ? error.name : "UnknownError");
    throw new HiringError(502, "Google did not answer for the call calendar.");
  })) as { calendars?: Record<string, { errors?: unknown[]; busy?: { start?: string; end?: string }[] }> } | null;
  const calendar = result?.calendars?.[HR_CALENDAR];
  if (!calendar || calendar.errors?.length || !Array.isArray(calendar.busy))
    throw new HiringError(502, "Google did not return the call calendar.");
  return calendar.busy.map((entry) => {
    const range = { start: new Date(entry.start ?? ""), end: new Date(entry.end ?? "") };
    if (!(range.end > range.start)) throw new HiringError(502, "Google returned a busy time that cannot be read.");
    return range;
  });
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
  // The HR call: the guests are HR (`interviewerEmail`) and the candidate, by the same rule as a visit.
  const call = booking.kind === "call";
  const result = await calendarRequest(
    booking.calendarOwner,
    path + "?sendUpdates=all",
    {
      method: "POST",
      body: JSON.stringify({
        id,
        summary: call
          ? `BeGifted pre-screen call: ${candidate.name}`
          : booking.visitId
          ? booking.kind === "mock"
            ? "BeGifted mock teaching"
            : "BeGifted exam"
          : `BeGifted ${booking.kind === "mock" ? "mock teaching" : "paper assessment"}: ${candidate.name}`,
        description: call
          ? `Candidate: ${candidate.name}\nSubject: ${booking.subjects.join(", ")}\nPhone: ${candidate.phone ?? "not recorded"}\nEmail: ${candidate.email ?? "not recorded"}\nBeGifted calls the candidate at this time.`
          : `${booking.visitId ? `Candidate: ${candidate.name}\n` : ""}Subjects: ${booking.subjects.join(", ")}\n${booking.kind === "mock" ? "The candidate prepares one lesson from an international school syllabus (IGCSE, A Level or IB). The interviewer also selects a topic." : booking.visitId ? "The 2-hour exam. The mock teaching session follows it." : "Two hours are allocated per subject."}`,
        location: call ? "Phone call" : location,
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
