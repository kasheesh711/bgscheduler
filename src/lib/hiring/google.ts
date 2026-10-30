import { createHash, randomBytes } from "node:crypto";
import { eq } from "drizzle-orm";
import { z } from "zod";
import { getDb, type Database } from "@/lib/db";
import { googleOAuthTokens, hiringBookings } from "@/lib/db/schema";
import {
  decryptToken,
  encryptToken,
  getGoogleSheetsAccessToken,
  SHEETS_WRITE_SCOPE,
  storeGoogleOAuthTokenForUser,
} from "@/lib/sales-dashboard/google-oauth";
import { HiringError, ZONE } from "./model";
import type { Candidate } from "./service";

export const GOOGLE_SCOPES = [
  SHEETS_WRITE_SCOPE,
  "https://www.googleapis.com/auth/calendar.events.owned",
];
export const GOOGLE_COOKIE = "hiring-google-state";
const oauthState = z.object({
  email: z.email(),
  nonce: z.string(),
  verifier: z.string(),
  expires: z.number(),
  origin: z.url(),
});
export const appOrigin = () =>
  new URL(process.env.APP_BASE_URL || "https://bgscheduler.vercel.app").origin;
export function beginGoogleConnection(email: string, origin: string) {
  if (origin !== appOrigin())
    throw new HiringError(
      400,
      "Use the configured Scheduling address to connect Google.",
    );
  if (!process.env.AUTH_GOOGLE_ID || !process.env.AUTH_GOOGLE_SECRET)
    throw new HiringError(503, "Google connection is not configured.");
  const state = {
    email,
    nonce: randomBytes(32).toString("base64url"),
    verifier: randomBytes(48).toString("base64url"),
    expires: Date.now() + 600000,
    origin,
  };
  const params = new URLSearchParams({
    client_id: process.env.AUTH_GOOGLE_ID,
    redirect_uri: origin + "/api/hiring/google/callback",
    response_type: "code",
    scope: ["openid", "email", ...GOOGLE_SCOPES].join(" "),
    access_type: "offline",
    prompt: "consent",
    include_granted_scopes: "true",
    state: state.nonce,
    code_challenge_method: "S256",
    code_challenge: createHash("sha256")
      .update(state.verifier)
      .digest("base64url"),
  });
  return {
    cookie: encryptToken(JSON.stringify(state))!,
    url: "https://accounts.google.com/o/oauth2/v2/auth?" + params,
  };
}
export async function finishGoogleConnection(
  email: string,
  code: string,
  nonce: string,
  cookie: string,
  db: Database = getDb(),
) {
  const parsed = oauthState.safeParse(
    JSON.parse(decryptToken(cookie) || "null"),
  );
  if (
    !parsed.success ||
    parsed.data.email !== email ||
    parsed.data.nonce !== nonce ||
    parsed.data.expires < Date.now() ||
    parsed.data.origin !== appOrigin()
  )
    throw new HiringError(400, "Google connection expired. Start again.");
  const state = parsed.data;
  const response = await fetch("https://oauth2.googleapis.com/token", {
    method: "POST",
    body: new URLSearchParams({
      client_id: process.env.AUTH_GOOGLE_ID!,
      client_secret: process.env.AUTH_GOOGLE_SECRET!,
      code,
      code_verifier: state.verifier,
      grant_type: "authorization_code",
      redirect_uri: state.origin + "/api/hiring/google/callback",
    }),
    signal: AbortSignal.timeout(20000),
  });
  if (!response.ok)
    throw new HiringError(502, "Google could not complete the connection.");
  const token = z
    .object({
      access_token: z.string().min(1),
      refresh_token: z.string().optional(),
      expires_in: z.number().positive(),
      scope: z.string(),
      token_type: z.string(),
    })
    .parse(await response.json());
  if (!GOOGLE_SCOPES.every((scope) => token.scope.split(" ").includes(scope)))
    throw new HiringError(
      400,
      "Google Sheets and Calendar permissions are both required.",
    );
  const identity = await fetch(
    "https://openidconnect.googleapis.com/v1/userinfo",
    {
      headers: { Authorization: `Bearer ${token.access_token}` },
      signal: AbortSignal.timeout(20000),
    },
  );
  const user = identity.ok
    ? ((await identity.json()) as { email?: string; email_verified?: boolean })
    : null;
  if (
    !user?.email_verified ||
    user.email?.toLowerCase() !== email.toLowerCase()
  )
    throw new HiringError(
      400,
      "Connect the same Google account that is signed in to Scheduling.",
    );
  await storeGoogleOAuthTokenForUser(
    email,
    {
      provider: "google",
      ...token,
      expires_at: Math.floor(Date.now() / 1000) + token.expires_in,
    },
    db,
  );
}
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
    return { id, recovered: true };
  }
  if (cancel) return { id, cancelled: true };
  const attendees = [
    ...new Set(
      [booking.interviewerEmail, candidate.email].filter(
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
        summary: `BeGifted ${booking.kind === "mock" ? "mock teaching" : "paper assessment"}: ${candidate.name}`,
        description: `Subjects: ${booking.subjects.join(", ")}\n${booking.kind === "mock" ? "Prepare an IGCSE topic of your choice and a topic selected by the interviewer." : "Two hours are allocated per subject."}`,
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
