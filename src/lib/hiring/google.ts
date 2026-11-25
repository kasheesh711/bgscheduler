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
export const VISIT_STAFF = ["people@begiftededucation.com", "admin@begiftededucation.com", "kevhsh7@gmail.com"];
/** A head on a visit event: roster key (shown in the title), email (a guest) and the head's own Google event color. */
export type VisitHead = { key: string | null; email: string; colorId?: string };
export async function deliverCalendar(
  booking: typeof hiringBookings.$inferSelect,
  candidate: Candidate,
  location: string,
  db: Database,
  cancel = false,
  heads: VisitHead[] = [],
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
  // Kevin, 23 Nov 2026: every visit event (test and mock) goes to HR, Admin and Kevin. Kevin, 25 Nov 2026: the head is a
  // guest on the mock teaching only, never on the paper test; the test title and color still name the head.
  // A paper row with no visitId is the old flow or the delivery test, which stay as they were.
  const staff = booking.kind === "mock" ? [...new Set([...VISIT_STAFF, ...heads.map((head) => head.email.toLowerCase())])]
    : booking.kind === "paper" && booking.visitId ? VISIT_STAFF : [];
  // A head invited to a visit's paper test before 25 Nov 2026 is taken off (no email); the mock keeps its head.
  const paperHeads = new Set(booking.kind === "paper" && booking.visitId
    ? heads.map((head) => head.email.toLowerCase()).filter((email) => !staff.includes(email)) : []);
  // R1: HR Interview: the guests are HR (`interviewerEmail`) and the candidate, by the same rule as a visit. Google adds a
  // Meet link (Kevin, 22 Nov 2026), and its own invitation gives the candidate the join button.
  const call = booking.kind === "call";
  const contract = booking.kind === "contract";
  // Kevin, 25 Nov 2026: a test or mock title names the candidate, the subjects and the head, and each head has a color.
  // Google shows an event color only on the organizer's calendar (and to people who can edit it), not on guests' copies.
  const headKeys = [...new Set(heads.flatMap((head) => (head.key ? [head.key] : [])))];
  const summary = contract ? `BeGifted contract signing: ${candidate.name}` : call
    ? `BeGifted R1: HR Interview: ${candidate.name}`
    : [
        `BeGifted ${booking.kind === "mock" ? "mock teaching" : booking.visitId ? "exam" : "paper assessment"}: ${candidate.name}`,
        booking.subjects.join(", "),
        headKeys.length ? `Head: ${headKeys.join(", ")}` : "",
      ].filter(Boolean).join(" · ");
  // A test with two possible heads (no mock booked yet) keeps the calendar's own color.
  const colorId = heads.length === 1 ? heads[0].colorId : undefined;
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
    const existingAttendees = (existing.attendees ?? []) as Array<{ email: string; [key: string]: unknown }>;
    const attendees = existingAttendees.filter((a) => !paperHeads.has(a.email?.toLowerCase()));
    const missing = staff.filter(email => !attendees.some(a => a.email?.toLowerCase() === email));
    // An event made before the current title or color is brought up to date without a new invitation email.
    const changes = {
      ...((missing.length > 0 || attendees.length < existingAttendees.length) && { attendees: [...attendees, ...missing.map(email => ({ email }))] }),
      ...(existing.summary !== summary && { summary }),
      ...(colorId && existing.colorId !== colorId && { colorId }),
    };
    if (Object.keys(changes).length) {
      await calendarRequest(booking.calendarOwner, path + "/" + id + "?sendUpdates=" + (missing.length ? "all" : "none"), {
        method: "PATCH", headers: typeof existing.etag === "string" ? { "If-Match": existing.etag } : {}, body: JSON.stringify(changes),
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
    path + "?sendUpdates=all" + (call ? "&conferenceDataVersion=1" : ""),
    {
      method: "POST",
      body: JSON.stringify({
        id,
        summary,
        ...(colorId && { colorId }),
        description: contract ? "Onsite contract signing with BeGifted." : call
          ? `R1: HR Interview, a ${Math.round((booking.endTime.getTime() - booking.startTime.getTime()) / 60000)}-minute Google Meet video call.\nJoin with the Google Meet link in this invitation.\n\nCandidate: ${candidate.name}\nSubject: ${booking.subjects.join(", ")}\nEmail: ${candidate.email ?? "not recorded"}\nPhone (backup): ${candidate.phone ?? "not recorded"}`
          : `${booking.visitId ? `Candidate: ${candidate.name}\n` : ""}Subjects: ${booking.subjects.join(", ")}\n${booking.kind === "mock" ? `${booking.visitId ? "This session takes place only if the candidate passes the paper. " : ""}The candidate prepares one lesson from an international school syllabus (IGCSE, A Level or IB). The interviewer also selects a topic.` : booking.visitId ? "The 2-hour paper assessment." : "Two hours are allocated per subject."}`,
        location: call ? "Google Meet" : location,
        ...(call && { conferenceData: { createRequest: { requestId: id, conferenceSolutionKey: { type: "hangoutsMeet" } } } }),
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
  // shortcut: a missing Meet link is only logged, while emails point to the invitation; add a review flag if it happens.
  if (call && !result?.hangoutLink)
    console.error("R1 calendar event has no Google Meet link", { bookingId: booking.id, status: (result?.conferenceData as { createRequest?: { status?: unknown } } | undefined)?.createRequest?.status });
  return { id: String(result?.id ?? id) };
}
