import crypto from "node:crypto";
import { revalidateTag } from "next/cache";
import { eq } from "drizzle-orm";
import { getDb, type Database } from "@/lib/db";
import * as schema from "@/lib/db/schema";

export const SHEETS_READONLY_SCOPE = "https://www.googleapis.com/auth/spreadsheets.readonly";
export const SHEETS_WRITE_SCOPE = "https://www.googleapis.com/auth/spreadsheets";
const SALES_DASHBOARD_CACHE_TAG = "sales-dashboard";
const REFRESH_SKEW_MS = 2 * 60 * 1000;

interface GoogleAccountLike {
  provider?: string;
  access_token?: string;
  refresh_token?: string;
  expires_at?: number;
  scope?: string;
  token_type?: string;
}

interface GoogleRefreshResponse {
  access_token?: string;
  expires_in?: number;
  scope?: string;
  token_type?: string;
  error?: string;
  error_description?: string;
}

export class MissingGoogleSheetsTokenError extends Error {
  constructor(message = "Google Sheets access is not connected for this account.") {
    super(message);
    this.name = "MissingGoogleSheetsTokenError";
  }
}

function encryptionKey(): Buffer {
  const secret = process.env.AUTH_SECRET;
  if (!secret) throw new Error("AUTH_SECRET is required to encrypt Google tokens");
  return crypto.createHash("sha256").update(secret).digest();
}

export function encryptToken(value: string | null | undefined): string | null {
  if (!value) return null;
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv("aes-256-gcm", encryptionKey(), iv);
  const encrypted = Buffer.concat([cipher.update(value, "utf8"), cipher.final()]);
  return [
    "v1",
    iv.toString("base64url"),
    cipher.getAuthTag().toString("base64url"),
    encrypted.toString("base64url"),
  ].join(":");
}

export function decryptToken(value: string | null | undefined): string | null {
  if (!value) return null;
  const [version, ivRaw, tagRaw, encryptedRaw] = value.split(":");
  if (version !== "v1" || !ivRaw || !tagRaw || !encryptedRaw) {
    throw new Error("Unsupported encrypted token format");
  }
  const decipher = crypto.createDecipheriv("aes-256-gcm", encryptionKey(), Buffer.from(ivRaw, "base64url"));
  decipher.setAuthTag(Buffer.from(tagRaw, "base64url"));
  return Buffer.concat([
    decipher.update(Buffer.from(encryptedRaw, "base64url")),
    decipher.final(),
  ]).toString("utf8");
}

function expiresAtFromAccount(account: GoogleAccountLike): Date | null {
  return account.expires_at ? new Date(account.expires_at * 1000) : null;
}

function scopeSet(scope: string | null | undefined): Set<string> {
  return new Set(String(scope ?? "").split(/\s+/).filter(Boolean));
}

export function hasSheetsReadScope(scope: string | null | undefined): boolean {
  const scopes = scopeSet(scope);
  return scopes.has(SHEETS_READONLY_SCOPE) || scopes.has(SHEETS_WRITE_SCOPE);
}

export function hasSheetsWriteScope(scope: string | null | undefined): boolean {
  return scopeSet(scope).has(SHEETS_WRITE_SCOPE);
}

export async function storeGoogleOAuthTokenForUser(
  email: string,
  account: GoogleAccountLike | null | undefined,
  db: Database = getDb(),
): Promise<void> {
  if (!account || account.provider !== "google" || !account.access_token) return;
  const normalizedEmail = email.trim().toLowerCase();
  if (!normalizedEmail) return;

  const [existing] = await db
    .select()
    .from(schema.googleOAuthTokens)
    .where(eq(schema.googleOAuthTokens.email, normalizedEmail))
    .limit(1);

  await db
    .insert(schema.googleOAuthTokens)
    .values({
      email: normalizedEmail,
      accessTokenCiphertext: encryptToken(account.access_token),
      refreshTokenCiphertext: account.refresh_token
        ? encryptToken(account.refresh_token)
        : existing?.refreshTokenCiphertext ?? null,
      expiresAt: expiresAtFromAccount(account),
      scope: account.scope ?? existing?.scope ?? null,
      tokenType: account.token_type ?? existing?.tokenType ?? null,
      lastError: null,
      updatedAt: new Date(),
    })
    .onConflictDoUpdate({
      target: schema.googleOAuthTokens.email,
      set: {
        accessTokenCiphertext: encryptToken(account.access_token),
        refreshTokenCiphertext: account.refresh_token
          ? encryptToken(account.refresh_token)
          : existing?.refreshTokenCiphertext ?? null,
        expiresAt: expiresAtFromAccount(account),
        scope: account.scope ?? existing?.scope ?? null,
        tokenType: account.token_type ?? existing?.tokenType ?? null,
        lastError: null,
        updatedAt: new Date(),
      },
    });
  revalidateTag(SALES_DASHBOARD_CACHE_TAG, "max");
}

async function refreshAccessToken(
  email: string,
  refreshToken: string,
  db: Database,
): Promise<string> {
  const response = await fetch("https://oauth2.googleapis.com/token", {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      client_id: process.env.AUTH_GOOGLE_ID ?? "",
      client_secret: process.env.AUTH_GOOGLE_SECRET ?? "",
      grant_type: "refresh_token",
      refresh_token: refreshToken,
    }),
  });
  const body = (await response.json()) as GoogleRefreshResponse;
  if (!response.ok || !body.access_token) {
    const message = body.error_description || body.error || `Google token refresh failed (${response.status})`;
    await db
      .update(schema.googleOAuthTokens)
      .set({ lastError: message, updatedAt: new Date() })
      .where(eq(schema.googleOAuthTokens.email, email));
    throw new MissingGoogleSheetsTokenError(message);
  }

  await db
    .update(schema.googleOAuthTokens)
    .set({
      accessTokenCiphertext: encryptToken(body.access_token),
      expiresAt: body.expires_in ? new Date(Date.now() + body.expires_in * 1000) : null,
      scope: body.scope,
      tokenType: body.token_type,
      lastError: null,
      updatedAt: new Date(),
    })
    .where(eq(schema.googleOAuthTokens.email, email));
  revalidateTag(SALES_DASHBOARD_CACHE_TAG, "max");
  return body.access_token;
}

export async function getGoogleSheetsAccessToken(
  email: string,
  db: Database = getDb(),
): Promise<string> {
  const normalizedEmail = email.trim().toLowerCase();
  const [row] = await db
    .select()
    .from(schema.googleOAuthTokens)
    .where(eq(schema.googleOAuthTokens.email, normalizedEmail))
    .limit(1);
  if (!row?.accessTokenCiphertext) throw new MissingGoogleSheetsTokenError();
  if (!hasSheetsReadScope(row.scope)) {
    throw new MissingGoogleSheetsTokenError("Google Sheets read scope is missing. Reconnect Google Sheets.");
  }

  const accessToken = decryptToken(row.accessTokenCiphertext);
  if (!accessToken) throw new MissingGoogleSheetsTokenError();
  const expiresAt = row.expiresAt?.getTime() ?? 0;
  if (!expiresAt || expiresAt > Date.now() + REFRESH_SKEW_MS) return accessToken;

  const refreshToken = decryptToken(row.refreshTokenCiphertext);
  if (!refreshToken) {
    throw new MissingGoogleSheetsTokenError("Google refresh token is missing. Reconnect Google Sheets.");
  }
  return refreshAccessToken(normalizedEmail, refreshToken, db);
}

export async function getGoogleSheetsWriteAccessToken(
  email: string,
  db: Database = getDb(),
): Promise<string> {
  const normalizedEmail = email.trim().toLowerCase();
  const [row] = await db
    .select()
    .from(schema.googleOAuthTokens)
    .where(eq(schema.googleOAuthTokens.email, normalizedEmail))
    .limit(1);
  if (!row?.accessTokenCiphertext) throw new MissingGoogleSheetsTokenError();
  if (!hasSheetsWriteScope(row.scope)) {
    throw new MissingGoogleSheetsTokenError("Google Sheets write scope is missing. Reconnect Google Sheets.");
  }

  const accessToken = decryptToken(row.accessTokenCiphertext);
  if (!accessToken) throw new MissingGoogleSheetsTokenError();
  const expiresAt = row.expiresAt?.getTime() ?? 0;
  if (!expiresAt || expiresAt > Date.now() + REFRESH_SKEW_MS) return accessToken;

  const refreshToken = decryptToken(row.refreshTokenCiphertext);
  if (!refreshToken) {
    throw new MissingGoogleSheetsTokenError("Google refresh token is missing. Reconnect Google Sheets.");
  }
  return refreshAccessToken(normalizedEmail, refreshToken, db);
}

export async function getGoogleTokenStatus(email: string | null | undefined, db: Database = getDb()) {
  const normalizedEmail = email?.trim().toLowerCase();
  if (!normalizedEmail) {
    return { connected: false, email: null, expiresAt: null, lastError: null };
  }
  const [row] = await db
    .select()
    .from(schema.googleOAuthTokens)
    .where(eq(schema.googleOAuthTokens.email, normalizedEmail))
    .limit(1);
  return {
    connected: Boolean(row?.accessTokenCiphertext && hasSheetsReadScope(row.scope)),
    writeConnected: Boolean(row?.accessTokenCiphertext && hasSheetsWriteScope(row.scope)),
    email: normalizedEmail,
    expiresAt: row?.expiresAt?.toISOString() ?? null,
    lastError: row?.lastError ?? null,
  };
}
