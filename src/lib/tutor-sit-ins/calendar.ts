import { createHash, randomBytes } from "node:crypto";
import { and, eq, gt, inArray, ne, or, sql } from "drizzle-orm";
import { z } from "zod";
import { getDb, type Database } from "@/lib/db";
import {
  tutorSitInCalendarConnections as connections,
  tutorSitInObservations as observations,
  tutorSitInJobs as jobs,
} from "@/lib/db/schema";
import { decryptToken, encryptToken } from "@/lib/sales-dashboard/google-oauth";
import { deliveryEnabled, enabled, SitInError } from "./model";
import { googleCalendarProvider } from "./calendar-google";
import {
  MICROSOFT_SCOPES,
  microsoftCalendarProvider,
} from "./calendar-microsoft";
import type {
  CalendarProviderName,
  CalendarSummary,
  CalendarBusyOptions,
} from "./calendar-provider";
export const CALENDAR_SCOPES = [
  "https://www.googleapis.com/auth/calendar.events.owned",
  "https://www.googleapis.com/auth/calendar.events.freebusy",
  "https://www.googleapis.com/auth/calendar.calendarlist.readonly",
];
export const OAUTH_COOKIE = "sit-in-calendar-oauth",
  OAUTH_PATH = "/api/tutor-sit-ins/calendar";
export const calendarConnectSchema = z
  .object({ provider: z.enum(["google", "microsoft"]).default("google") })
  .strict();
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
  provider: z.enum(["google", "microsoft"]).default("google"),
});
const tokenSchema = z.object({
  access_token: z.string(),
  refresh_token: z.string().optional(),
  expires_in: z.number().positive(),
  scope: z.string().optional(),
});
const microsoftTokenUrl =
  "https://login.microsoftonline.com/common/oauth2/v2.0/token";
export const appOrigin = () =>
  new URL(process.env.APP_BASE_URL || "https://bgscheduler.vercel.app").origin;
export const microsoftEnabled = () =>
  process.env.TUTOR_SIT_INS_MICROSOFT_ENABLED === "true" &&
  process.env.VERCEL_ENV !== "preview" &&
  process.env.PREVIEW_SANDBOX_ENABLED !== "true";
export function assertCalendarBooking(provider: CalendarProviderName) {
  if (provider === "microsoft" && !microsoftEnabled())
    throw new SitInError(
      503,
      "Outlook booking is not enabled yet.",
      "MICROSOFT_DISABLED",
    );
}
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
const callbackPath = (provider: CalendarProviderName) =>
  OAUTH_PATH + (provider === "microsoft" ? "/microsoft/callback" : "/callback");
function clientCredentials(provider: CalendarProviderName) {
  return provider === "google"
    ? { id: process.env.AUTH_GOOGLE_ID, secret: process.env.AUTH_GOOGLE_SECRET }
    : {
        id: process.env.TUTOR_SIT_INS_MICROSOFT_CLIENT_ID,
        secret: process.env.TUTOR_SIT_INS_MICROSOFT_CLIENT_SECRET,
      };
}
export function beginCalendarOAuth(
  email: string,
  origin: string,
  provider: CalendarProviderName = "google",
) {
  assertCalendarAccess();
  assertCalendarBooking(provider);
  const client = clientCredentials(provider);
  if (!client.id || !client.secret)
    throw new SitInError(503, "Calendar credentials are not configured.");
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
      provider,
      expires: Date.now() + 600_000,
    }),
  )!;
  const params = new URLSearchParams({
    client_id: client.id,
    redirect_uri: origin + callbackPath(provider),
    response_type: "code",
    scope: [
      "openid",
      "email",
      ...(provider === "google" ? CALENDAR_SCOPES : MICROSOFT_SCOPES),
    ].join(" "),
    state,
    code_challenge_method: "S256",
    code_challenge: createHash("sha256").update(verifier).digest("base64url"),
  });
  if (provider === "google") {
    params.set("access_type", "offline");
    params.set("prompt", "consent");
    params.set("include_granted_scopes", "true");
  } else {
    params.set("response_mode", "query");
    params.set("prompt", "select_account");
  }
  return {
    cookie,
    url:
      (provider === "google"
        ? "https://accounts.google.com/o/oauth2/v2/auth?"
        : "https://login.microsoftonline.com/common/oauth2/v2.0/authorize?") +
      params,
  };
}
export function verifyOAuthState(
  cookie: string,
  state: string,
  email: string,
  now = Date.now(),
  provider: CalendarProviderName = "google",
) {
  try {
    const value = oauthStateSchema.parse(
      JSON.parse(decryptToken(cookie) || "null"),
    );
    if (
      value.email !== email ||
      value.state !== state ||
      value.expires <= now ||
      value.origin !== appOrigin() ||
      value.provider !== provider
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
async function tokenRequest(
  provider: CalendarProviderName,
  body: URLSearchParams,
) {
  const client = clientCredentials(provider);
  body.set("client_id", client.id || "");
  body.set("client_secret", client.secret || "");
  const res = await fetch(
    provider === "google"
      ? "https://oauth2.googleapis.com/token"
      : microsoftTokenUrl,
    {
      method: "POST",
      body,
      signal: AbortSignal.timeout(20_000),
      cache: "no-store",
    },
  );
  if (!res.ok)
    throw new SitInError(
      res.status >= 500 || res.status === 429 ? 502 : 409,
      "Calendar authorization could not be refreshed. Try again or reconnect.",
      "CALENDAR_RECONNECT",
    );
  return tokenSchema.parse(await res.json());
}
function hasScopes(provider: CalendarProviderName, scope: string) {
  const scopes = scope
    .split(" ")
    .map((s) => s.toLowerCase().replace("https://graph.microsoft.com/", ""));
  return (
    provider === "google"
      ? CALENDAR_SCOPES
      : MICROSOFT_SCOPES.filter((s) => s !== "offline_access")
  ).every((s) => scopes.includes(s.toLowerCase()));
}
/** Includes unfinished jobs even after the observation date. Run under the observer lease. */
async function assertCanSwitch(email: string, db: Database) {
  const [dependent] = await db
    .select({ id: observations.id })
    .from(observations)
    .leftJoin(jobs, eq(jobs.observationId, observations.id))
    .where(
      and(
        eq(observations.observerEmail, email),
        or(
          and(
            gt(observations.endTime, new Date()),
            ne(observations.calendarStatus, "cancelled"),
          ),
          and(
            inArray(jobs.kind, ["calendar_upsert", "calendar_delete"]),
            inArray(jobs.status, ["pending", "running", "failed"]),
          ),
        ),
      ),
    )
    .limit(1);
  if (dependent)
    throw new SitInError(
      409,
      "Finish or cancel existing observations and let calendar jobs finish before changing or disconnecting accounts.",
    );
}
export async function finishCalendarOAuth(
  email: string,
  code: string,
  state: ReturnType<typeof verifyOAuthState>,
  db: Database = getDb(),
) {
  assertCalendarAccess();
  assertCalendarBooking(state.provider);
  const provider = state.provider;
  const token = await tokenRequest(
    provider,
    new URLSearchParams({
      grant_type: "authorization_code",
      code,
      code_verifier: state.verifier,
      redirect_uri: state.origin + callbackPath(provider),
    }),
  );
  if (!hasScopes(provider, token.scope || ""))
    throw new SitInError(
      400,
      "Grant all requested calendar permissions to connect.",
    );
  const response = await fetch(
    provider === "google"
      ? "https://openidconnect.googleapis.com/v1/userinfo"
      : "https://graph.microsoft.com/v1.0/me?$select=id,mail,userPrincipalName",
    {
      headers: { Authorization: "Bearer " + token.access_token },
      signal: AbortSignal.timeout(15_000),
      cache: "no-store",
    },
  );
  if (!response.ok)
    throw new SitInError(
      400,
      "Calendar account identity could not be verified.",
    );
  const raw = await response.json();
  let accountId: string, accountEmail: string;
  if (provider === "google") {
    const identity = z
      .object({
        sub: z.string().min(1),
        email: z.email(),
        email_verified: z.literal(true),
      })
      .parse(raw);
    accountId = identity.sub;
    accountEmail = identity.email.toLowerCase();
  } else {
    const identity = z
      .object({
        id: z.string().min(1),
        mail: z.string().nullable().optional(),
        userPrincipalName: z.string().optional(),
      })
      .parse(raw);
    accountId = identity.id;
    accountEmail = z
      .email()
      .parse(identity.mail || identity.userPrincipalName)
      .toLowerCase();
  }
  const { withObserverOperation } = await import("./repository");
  await withObserverOperation(db, email, async (assertLease) => {
    const [existing] = await db
      .select()
      .from(connections)
      .where(eq(connections.email, email));
    const same =
      !!existing &&
      existing.provider === provider &&
      (existing.provider === "google" ? existing.googleSubject : existing.providerAccountId) === accountId;
    if (existing && !same) await assertCanSwitch(email, db);
    const refresh = token.refresh_token
      ? encryptToken(token.refresh_token)
      : same
        ? existing.refreshTokenCiphertext
        : null;
    if (!refresh)
      throw new SitInError(
        400,
        "Offline calendar access was not granted. Reconnect and grant all permissions.",
      );
    const values = {
      email,
      provider,
      providerAccountId: accountId,
      accountEmail,
      googleEmail: provider === "google" ? accountEmail : null,
      googleSubject: provider === "google" ? accountId : null,
      accessTokenCiphertext: encryptToken(token.access_token)!,
      refreshTokenCiphertext: refresh,
      expiresAt: new Date(Date.now() + token.expires_in * 1000),
      scope: token.scope!,
      ...(!same ? { calendarId: "primary", busyCalendarIds: ["primary"] } : {}),
      lastError: null,
      updatedAt: new Date(),
    };
    await assertLease();
    await db
      .insert(connections)
      .values(values)
      .onConflictDoUpdate({
        target: connections.email,
        set: { ...values, revision: sql`${connections.revision} + 1` },
      });
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
      "Connect the observer's Google or Outlook calendar first.",
      "CALENDAR_RECONNECT",
    );
  // Legacy Google releases can still update their original identity columns
  // during an additive migration rollout. These remain authoritative for Google.
  const providerAccountId = row.provider === "google" ? row.googleSubject : row.providerAccountId;
  const accountEmail = row.provider === "google" ? row.googleEmail : row.accountEmail;
  if (!providerAccountId || !accountEmail)
    throw new SitInError(
      409,
      "Calendar account identity needs to be reconnected.",
      "CALENDAR_RECONNECT",
    );
  return { ...row, providerAccountId, accountEmail };
}
type Connection = Awaited<ReturnType<typeof calendarConnection>>;
async function accessToken(row: Connection, db: Database) {
  assertCalendarAccess();
  if (!hasScopes(row.provider, row.scope))
    throw new SitInError(
      409,
      "Reconnect Calendar to grant the required permissions.",
    );
  if (row.expiresAt.getTime() > Date.now() + 120_000)
    return decryptToken(row.accessTokenCiphertext)!;
  const refresh = decryptToken(row.refreshTokenCiphertext);
  if (!refresh)
    throw new SitInError(409, "Reconnect Calendar to restore offline access.");
  const token = await tokenRequest(
    row.provider,
    new URLSearchParams({
      grant_type: "refresh_token",
      refresh_token: refresh,
    }),
  );
  const scope = token.scope || row.scope;
  if (!hasScopes(row.provider, scope))
    throw new SitInError(409, "Reconnect Calendar to restore access.");
  // Refreshes rotate Microsoft credentials. A stale response must not overwrite
  // a reconnect or another refresh's newly rotated token.
  await db
    .update(connections)
    .set({
      accessTokenCiphertext: encryptToken(token.access_token)!,
      refreshTokenCiphertext: token.refresh_token
        ? encryptToken(token.refresh_token)
        : row.refreshTokenCiphertext,
      expiresAt: new Date(Date.now() + token.expires_in * 1000),
      scope,
      lastError: null,
      updatedAt: new Date(),
    })
    .where(
      and(
        eq(connections.email, row.email),
        eq(connections.provider, row.provider),
        eq(connections.accessTokenCiphertext, row.accessTokenCiphertext),
        eq(connections.revision, row.revision),
      ),
    );
  return token.access_token;
}
async function providerRequest<T>(
  connection: Connection,
  path: string,
  init: RequestInit,
  db: Database,
): Promise<T> {
  const method = init.method || "GET";
  if (
    method !== "GET" &&
    !(
      connection.provider === "google" &&
      method === "POST" &&
      path === "freeBusy"
    )
  )
    assertCalendarDelivery();
  const token = await accessToken(
    await calendarConnection(connection.email, db).then((fresh) => {
      if (
        fresh.provider !== connection.provider ||
        fresh.providerAccountId !== connection.providerAccountId
      )
        throw new SitInError(409, "The connected calendar account changed.");
      return fresh;
    }),
    db,
  );
  const base =
    connection.provider === "google"
      ? "https://www.googleapis.com/calendar/v3/"
      : "https://graph.microsoft.com/v1.0/";
  const url = new URL(path, base);
  if (!url.href.startsWith(base) || path.startsWith("/"))
    throw new SitInError(400, "Invalid calendar operation.");
  const response = await fetch(url, {
    ...init,
    headers: {
      Authorization: "Bearer " + token,
      "Content-Type": "application/json",
      ...(connection.provider === "microsoft"
        ? {
            Prefer:
              'IdType="ImmutableId", outlook.timezone="UTC", outlook.body-content-type="text"',
          }
        : {}),
      ...init.headers,
    },
    cache: "no-store",
    signal: AbortSignal.timeout(20_000),
  });
  if (!response.ok)
    throw new SitInError(
      response.status === 404 || response.status === 410
        ? 404
        : response.status === 409
          ? 409
          : 502,
      "Calendar could not complete this operation (" + response.status + ").",
      (connection.provider === "google" ? "GOOGLE_" : "MICROSOFT_") +
        response.status,
    );
  return (response.status === 204 ? null : await response.json()) as T;
}
export async function calendarProvider(
  email: string,
  db: Database = getDb(),
  expected?: {
    calendarProvider: CalendarProviderName;
    calendarAccountId: string | null;
  },
) {
  const connection = await calendarConnection(email, db);
  if (
    expected &&
    (connection.provider !== expected.calendarProvider ||
      (expected.calendarAccountId &&
        connection.providerAccountId !== expected.calendarAccountId))
  )
    throw new SitInError(
      409,
      "This observation belongs to a different calendar account.",
    );
  const request = <T>(path: string, init: RequestInit = {}) =>
    providerRequest<T>(connection, path, init, db);
  return {
    connection,
    provider:
      connection.provider === "google"
        ? googleCalendarProvider(request)
        : microsoftCalendarProvider(request),
  };
}
export async function listCalendars(email: string, db: Database = getDb()) {
  return (await calendarProvider(email, db)).provider.list();
}
export async function calendarSettings(email: string, db: Database = getDb()) {
  const availableProviders: CalendarProviderName[] = [
    "google",
    ...(microsoftEnabled() ? ["microsoft" as const] : []),
  ];
  const [row] = await db
    .select()
    .from(connections)
    .where(eq(connections.email, email));
  if (!row)
    return {
      connected: false as const,
      deliveryEnabled: deliveryEnabled(),
      availableProviders,
      calendars: [] as CalendarSummary[],
    };
  let calendars: CalendarSummary[] = [],
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
    availableProviders,
    provider: row.provider,
    accountEmail: row.provider === "google" ? row.googleEmail : row.accountEmail,
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
  const { withObserverOperation } = await import("./repository");
  await withObserverOperation(db, email, async (assertLease) => {
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
    await assertLease();
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
  });
}
export async function calendarBusy(
  email: string,
  start: Date,
  end: Date,
  db: Database = getDb(),
  exclude?: CalendarBusyOptions["exclude"],
) {
  const { provider, connection } = await calendarProvider(email, db);
  return provider.busy(start, end, {
    calendarId: connection.calendarId,
    busyCalendarIds: connection.busyCalendarIds,
    exclude,
  });
}
export async function disconnectCalendar(
  email: string,
  db: Database = getDb(),
) {
  const { withObserverOperation } = await import("./repository");
  await withObserverOperation(db, email, async (assertLease) => {
    await assertCanSwitch(email, db);
    await assertLease();
    await db.delete(connections).where(eq(connections.email, email));
  });
}
