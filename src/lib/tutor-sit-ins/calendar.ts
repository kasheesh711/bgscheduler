import { createHash, randomBytes } from "node:crypto";
import { and, eq, gt, ne, sql } from "drizzle-orm";
import { z } from "zod";
import { getDb, type Database } from "@/lib/db";
import {
  tutorSitInCalendarConnections as connections,
  tutorSitInObservations as observations,
} from "@/lib/db/schema";
import { decryptToken, encryptToken } from "@/lib/sales-dashboard/google-oauth";
import { fromZonedTime } from "date-fns-tz";
import { deliveryEnabled, enabled, SitInError, ZONE } from "./model";

export const CALENDAR_SCOPES = [
  "https://www.googleapis.com/auth/calendar.events.owned",
  "https://www.googleapis.com/auth/calendar.events.freebusy",
  "https://www.googleapis.com/auth/calendar.calendarlist.readonly",
];
export const OAUTH_COOKIE = "sit-in-calendar-oauth";
export const OAUTH_PATH = "/api/tutor-sit-ins/calendar";
export const calendarSelectionSchema = z
  .object({
    calendarId: z.string().min(1).max(1000),
    busyCalendarIds: z.array(z.string().min(1).max(1000)).min(1).max(30),
    expectedRevision: z.number().int().nonnegative(),
  })
  .strict();
const oauthStateSchema = z.object({
  email: z.email(),
  state: z.string(),
  verifier: z.string(),
  origin: z.url(),
  expires: z.number(),
});
const tokenSchema = z.object({
  access_token: z.string(),
  refresh_token: z.string().optional(),
  expires_in: z.number().positive(),
  scope: z.string().optional(),
});
export type GoogleEvent = {
  id: string;
  status?: string;
  etag?: string;
  htmlLink?: string;
  summary?: string;
  description?: string;
  location?: string;
  start?: { dateTime?: string; date?: string; timeZone?: string };
  end?: { dateTime?: string; date?: string; timeZone?: string };
  transparency?: string;
  attendees?: Array<{ email?: string }>;
  extendedProperties?: { private?: Record<string, string> };
};
export type GoogleCalendar = {
  id: string;
  summary: string;
  accessRole: string;
  primary?: boolean;
};
export const appOrigin = () =>
  new URL(process.env.APP_BASE_URL || "https://bgscheduler.vercel.app").origin;
export function assertCalendarDelivery() {
  if (!deliveryEnabled())
    throw new SitInError(
      503,
      "Calendar and email delivery are not enabled. An administrator must complete the delivery setup.",
      "DELIVERY_DISABLED",
    );
}
function assertCalendarAccess() {
  if (
    !enabled() ||
    process.env.VERCEL_ENV === "preview" ||
    process.env.PREVIEW_SANDBOX_ENABLED === "true"
  )
    throw new SitInError(
      503,
      "Calendar connections are unavailable in this environment.",
    );
}
export function beginCalendarOAuth(email: string, origin: string) {
  assertCalendarAccess();
  if (!process.env.AUTH_GOOGLE_ID || !process.env.AUTH_GOOGLE_SECRET)
    throw new SitInError(
      503,
      "Google Calendar credentials are not configured.",
    );
  if (origin !== appOrigin())
    throw new SitInError(
      400,
      "Open Calendar connection from the configured application address.",
    );
  const state = randomBytes(32).toString("base64url"),
    verifier = randomBytes(48).toString("base64url");
  const cookie = encryptToken(
    JSON.stringify({
      email,
      state,
      verifier,
      origin,
      expires: Date.now() + 10 * 60_000,
    }),
  )!;
  const params = new URLSearchParams({
    client_id: process.env.AUTH_GOOGLE_ID,
    redirect_uri: origin + OAUTH_PATH + "/callback",
    response_type: "code",
    scope: ["openid", "email", ...CALENDAR_SCOPES].join(" "),
    access_type: "offline",
    prompt: "consent",
    include_granted_scopes: "true",
    state,
    code_challenge_method: "S256",
    code_challenge: createHash("sha256").update(verifier).digest("base64url"),
  });
  return {
    cookie,
    url: "https://accounts.google.com/o/oauth2/v2/auth?" + params,
  };
}
export function verifyOAuthState(
  cookie: string,
  state: string,
  email: string,
  now = Date.now(),
) {
  try {
    const value = oauthStateSchema.parse(
      JSON.parse(decryptToken(cookie) || "null"),
    );
    if (
      value.email !== email ||
      value.state !== state ||
      value.expires < now ||
      value.origin !== appOrigin()
    )
      throw new Error("Invalid state");
    return value;
  } catch {
    throw new SitInError(
      400,
      "Calendar connection expired or could not be verified. Start again.",
    );
  }
}
async function tokenRequest(body: URLSearchParams) {
  body.set("client_id", process.env.AUTH_GOOGLE_ID || "");
  body.set("client_secret", process.env.AUTH_GOOGLE_SECRET || "");
  const res = await fetch("https://oauth2.googleapis.com/token", {
    method: "POST",
    body,
    signal: AbortSignal.timeout(20_000),
    cache: "no-store",
  });
  if (!res.ok)
    throw new SitInError(
      409,
      "Google Calendar needs to be reconnected.",
      "CALENDAR_RECONNECT",
    );
  return tokenSchema.parse(await res.json());
}
export async function finishCalendarOAuth(
  email: string,
  code: string,
  state: ReturnType<typeof verifyOAuthState>,
  db: Database = getDb(),
) {
  assertCalendarAccess();
  const token = await tokenRequest(
    new URLSearchParams({
      grant_type: "authorization_code",
      code,
      code_verifier: state.verifier,
      redirect_uri: state.origin + OAUTH_PATH + "/callback",
    }),
  );
  if (
    !CALENDAR_SCOPES.every((scope) => token.scope?.split(" ").includes(scope))
  )
    throw new SitInError(
      400,
      "Grant all three Calendar permissions to connect.",
    );
  const response = await fetch(
    "https://openidconnect.googleapis.com/v1/userinfo",
    {
      headers: { Authorization: "Bearer " + token.access_token },
      signal: AbortSignal.timeout(15_000),
      cache: "no-store",
    },
  );
  if (!response.ok)
    throw new SitInError(400, "Google account identity could not be verified.");
  const identity = z
    .object({
      sub: z.string().min(1),
      email: z.email(),
      email_verified: z.literal(true),
    })
    .parse(await response.json());
  const [existing] = await db
    .select()
    .from(connections)
    .where(eq(connections.email, email));
  if (existing && existing.googleSubject !== identity.sub) {
    const pending = await db
      .select({ id: observations.id })
      .from(observations)
      .where(
        and(
          eq(observations.observerEmail, email),
          gt(observations.endTime, new Date()),
          ne(observations.calendarStatus, "cancelled"),
        ),
      );
    if (pending.length)
      throw new SitInError(
        409,
        "Finish or cancel existing observations before connecting a different Google account.",
      );
  }
  const values = {
    email,
    googleEmail: identity.email.toLowerCase(),
    googleSubject: identity.sub,
    accessTokenCiphertext: encryptToken(token.access_token)!,
    refreshTokenCiphertext: token.refresh_token
      ? encryptToken(token.refresh_token)
      : existing?.googleSubject === identity.sub
        ? existing.refreshTokenCiphertext
        : null,
    expiresAt: new Date(Date.now() + token.expires_in * 1000),
    scope: token.scope!,
    ...(existing && existing.googleSubject !== identity.sub
      ? { calendarId: "primary", busyCalendarIds: ["primary"] }
      : {}),
    lastError: null,
    updatedAt: new Date(),
  };
  if (!values.refreshTokenCiphertext)
    throw new SitInError(
      400,
      "Google did not grant offline access. Reconnect and grant Calendar access.",
    );
  await db
    .insert(connections)
    .values(values)
    .onConflictDoUpdate({
      target: connections.email,
      set: { ...values, revision: sql`${connections.revision} + 1` },
    });
}
export async function calendarConnection(
  email: string,
  db: Database = getDb(),
) {
  const [row] = await db
    .select()
    .from(connections)
    .where(eq(connections.email, email));
  if (!row)
    throw new SitInError(
      409,
      "Connect the observer's Google Calendar first.",
      "CALENDAR_RECONNECT",
    );
  return row;
}
async function accessToken(email: string, db: Database) {
  assertCalendarAccess();
  const row = await calendarConnection(email, db);
  if (!CALENDAR_SCOPES.every((scope) => row.scope.split(" ").includes(scope)))
    throw new SitInError(
      409,
      "Reconnect Google Calendar to grant the required permissions.",
    );
  if (row.expiresAt.getTime() > Date.now() + 120_000)
    return decryptToken(row.accessTokenCiphertext)!;
  const refresh = decryptToken(row.refreshTokenCiphertext);
  if (!refresh)
    throw new SitInError(
      409,
      "Reconnect Google Calendar to restore offline access.",
    );
  try {
    const token = await tokenRequest(
      new URLSearchParams({
        grant_type: "refresh_token",
        refresh_token: refresh,
      }),
    );
    const scope = token.scope || row.scope;
    if (!CALENDAR_SCOPES.every((s) => scope.split(" ").includes(s)))
      throw new SitInError(409, "Reconnect Google Calendar to restore access.");
    await db
      .update(connections)
      .set({
        accessTokenCiphertext: encryptToken(token.access_token)!,
        expiresAt: new Date(Date.now() + token.expires_in * 1000),
        scope,
        lastError: null,
        updatedAt: new Date(),
      })
      .where(eq(connections.email, email));
    return token.access_token;
  } catch (error) {
    await db
      .update(connections)
      .set({
        lastError: "Calendar access needs to be reconnected.",
        updatedAt: new Date(),
      })
      .where(eq(connections.email, email));
    throw error;
  }
}
export async function calendarRequest<T>(
  email: string,
  path: string,
  init: RequestInit = {},
  db: Database = getDb(),
): Promise<T> {
  if (
    (init.method && !["GET", "POST"].includes(init.method)) ||
    (init.method === "POST" && path !== "freeBusy")
  )
    assertCalendarDelivery();
  const token = await accessToken(email, db);
  const response = await fetch(
    "https://www.googleapis.com/calendar/v3/" + path,
    {
      ...init,
      headers: {
        Authorization: "Bearer " + token,
        "Content-Type": "application/json",
        ...init.headers,
      },
      cache: "no-store",
      signal: AbortSignal.timeout(20_000),
    },
  );
  if (!response.ok)
    throw new SitInError(
      response.status === 404 || response.status === 410
        ? 404
        : response.status === 409
          ? 409
          : 502,
      "Google Calendar could not complete this operation (" +
        response.status +
        ").",
      "GOOGLE_" + response.status,
    );
  return (response.status === 204 ? null : await response.json()) as T;
}
export async function listCalendars(email: string, db: Database = getDb()) {
  const result: GoogleCalendar[] = [];
  let page: string | undefined;
  do {
    const response: { items?: GoogleCalendar[]; nextPageToken?: string } =
      await calendarRequest(
        email,
        "users/me/calendarList?maxResults=250" +
          (page ? "&pageToken=" + encodeURIComponent(page) : ""),
        {},
        db,
      );
    if (!Array.isArray(response.items))
      throw new SitInError(502, "Google returned an incomplete calendar list.");
    result.push(...response.items);
    page = response.nextPageToken;
    if (result.length > 1000)
      throw new SitInError(400, "Too many calendars to list.");
  } while (page);
  return result;
}
export async function calendarSettings(email: string, db: Database = getDb()) {
  const [row] = await db
    .select()
    .from(connections)
    .where(eq(connections.email, email));
  if (!row)
    return {
      connected: false as const,
      deliveryEnabled: deliveryEnabled(),
      calendars: [] as GoogleCalendar[],
    };
  let calendars: GoogleCalendar[] = [],
    error = row.lastError;
  if (enabled())
    try {
      calendars = await listCalendars(email, db);
    } catch {
      error = "Calendar could not be reached. Reconnect or try again.";
    }
  return {
    connected: true as const,
    deliveryEnabled: deliveryEnabled(),
    googleEmail: row.googleEmail,
    calendarId: row.calendarId,
    busyCalendarIds: row.busyCalendarIds,
    revision: row.revision,
    error,
    calendars,
  };
}
export async function saveCalendarSelection(
  email: string,
  input: z.infer<typeof calendarSelectionSchema>,
  db: Database = getDb(),
) {
  const calendars = await listCalendars(email, db);
  const destination = calendars.find(
    (c) =>
      c.id === input.calendarId ||
      (input.calendarId === "primary" && c.primary),
  );
  if (!destination || destination.accessRole !== "owner")
    throw new SitInError(
      400,
      "Choose a calendar you own for observation events.",
    );
  const busy = [
    ...new Set(["primary", ...input.busyCalendarIds, destination.id]),
  ];
  if (
    busy.some((id) => id !== "primary" && !calendars.some((c) => c.id === id))
  )
    throw new SitInError(400, "A selected calendar is no longer accessible.");
  const changed = await db
    .update(connections)
    .set({
      calendarId: destination.id,
      busyCalendarIds: busy,
      revision: input.expectedRevision + 1,
      updatedAt: new Date(),
    })
    .where(
      and(
        eq(connections.email, email),
        eq(connections.revision, input.expectedRevision),
      ),
    )
    .returning({ email: connections.email });
  if (!changed.length)
    throw new SitInError(
      409,
      "Calendar settings changed. Refresh and try again.",
    );
}
export async function googleBusy(
  email: string,
  start: Date,
  end: Date,
  db: Database = getDb(),
  exclude?: { calendarId: string; eventId: string },
) {
  const connection = await calendarConnection(email, db);
  const calendars = await listCalendars(email, db);
  const primaryId = calendars.find((c) => c.primary)?.id;
  const ids = [
    ...new Set(
      connection.busyCalendarIds.map((id) =>
        id === "primary" ? primaryId || "primary" : id,
      ),
    ),
  ];
  const excludedCalendar =
    exclude?.calendarId === "primary"
      ? primaryId || "primary"
      : exclude?.calendarId;
  const queryIds = ids.filter((id) => !exclude || id !== excludedCalendar);
  const busy: Array<{ start: Date; end: Date }> = [];
  if (queryIds.length) {
    const body = await calendarRequest<{
      calendars?: Record<
        string,
        { busy?: Array<{ start: string; end: string }>; errors?: unknown[] }
      >;
    }>(
      email,
      "freeBusy",
      {
        method: "POST",
        body: JSON.stringify({
          timeMin: start.toISOString(),
          timeMax: end.toISOString(),
          timeZone: ZONE,
          items: queryIds.map((id) => ({ id })),
        }),
      },
      db,
    );
    for (const id of queryIds) {
      const calendar = body.calendars?.[id];
      if (!calendar || calendar.errors?.length || !Array.isArray(calendar.busy))
        throw new SitInError(
          409,
          "Calendar availability is incomplete. Try again before booking.",
        );
      for (const b of calendar.busy) {
        if (
          !Number.isFinite(Date.parse(b.start)) ||
          !Number.isFinite(Date.parse(b.end)) ||
          Date.parse(b.end) <= Date.parse(b.start)
        )
          throw new SitInError(502, "Google returned invalid availability.");
        busy.push({ start: new Date(b.start), end: new Date(b.end) });
      }
    }
  }
  // FreeBusy intervals are merged. Subtracting our own event would hide a
  // simultaneous personal event. Read only the owned destination's time window.
  if (exclude && excludedCalendar && ids.includes(excludedCalendar)) {
    let page: string | undefined;
    let pages = 0;
    do {
      const params = new URLSearchParams({
        timeMin: start.toISOString(),
        timeMax: end.toISOString(),
        singleEvents: "true",
        maxResults: "2500",
      });
      if (page) params.set("pageToken", page);
      const result: {
        items?: GoogleEvent[];
        nextPageToken?: string;
        timeZone?: string;
      } = await calendarRequest(
        email,
        "calendars/" +
          encodeURIComponent(exclude.calendarId) +
          "/events?" +
          params,
        {},
        db,
      );
      if (!Array.isArray(result.items) || ++pages > 10)
        throw new SitInError(502, "Calendar event availability is incomplete.");
      for (const event of result.items) {
        if (
          event.id === exclude.eventId ||
          event.status === "cancelled" ||
          event.transparency === "transparent"
        )
          continue;
        const eventStart = event.start?.dateTime
          ? new Date(event.start.dateTime)
          : event.start?.date && result.timeZone
            ? fromZonedTime(event.start.date + "T00:00:00", result.timeZone)
            : start;
        const eventEnd = event.end?.dateTime
          ? new Date(event.end.dateTime)
          : event.end?.date && result.timeZone
            ? fromZonedTime(event.end.date + "T00:00:00", result.timeZone)
            : end;
        if (
          !Number.isFinite(eventStart.getTime()) ||
          !Number.isFinite(eventEnd.getTime())
        )
          throw new SitInError(502, "Calendar event times are invalid.");
        busy.push({ start: eventStart, end: eventEnd });
      }
      page = result.nextPageToken;
    } while (page);
  }
  return busy;
}
export async function disconnectCalendar(
  email: string,
  db: Database = getDb(),
) {
  const pending = await db
    .select({ id: observations.id })
    .from(observations)
    .where(
      and(
        eq(observations.observerEmail, email),
        gt(observations.endTime, new Date()),
        ne(observations.calendarStatus, "cancelled"),
      ),
    );
  if (pending.length)
    throw new SitInError(
      409,
      "Finish or cancel upcoming observations and let Calendar cancellation finish before disconnecting.",
    );
  // Local disconnection must not revoke the project's separate Sheets grant.
  await db.delete(connections).where(eq(connections.email, email));
}
