import { createHash, randomBytes } from "node:crypto";
import { z } from "zod";
import { HiringError } from "./model";
import { hiringOrigin, lineUserIdPattern, onboardingEnabled } from "./onboarding-config";

const redirectUri = () => `${hiringOrigin()}/api/hiring/onboarding/line-callback`;
export const onboardingLineCookie = "__Host-hiring-onboarding-line";
export const onboardingLineCookieOptions = {
  httpOnly: true, secure: true, sameSite: "lax" as const, maxAge: 600, path: "/",
};

const sessionSchema = z.object({
  token: z.string().min(1).max(600).regex(/^[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$/),
  state: z.string().length(43),
  nonce: z.string().length(43),
  verifier: z.string().length(43),
  expires: z.number().int(),
}).strict();

export function beginOnboardingLine(token: string, now = Date.now()) {
  const random = () => randomBytes(32).toString("base64url");
  const session = { token, state: random(), nonce: random(), verifier: random(), expires: now + 600_000 };
  const url = new URL("https://access.line.me/oauth2/v2.1/authorize");
  url.search = new URLSearchParams({
    response_type: "code", client_id: process.env.HIRING_LINE_LOGIN_ID!, redirect_uri: redirectUri(),
    scope: "openid profile", state: session.state, nonce: session.nonce,
    code_challenge: createHash("sha256").update(session.verifier).digest("base64url"), code_challenge_method: "S256",
  }).toString();
  return { url, cookie: Buffer.from(JSON.stringify(session)).toString("base64url") };
}

export function readOnboardingLineSession(cookie: string | undefined, state: string | null, now = Date.now()) {
  if (!cookie || !state || !onboardingEnabled()) return null;
  try {
    const session = sessionSchema.parse(JSON.parse(Buffer.from(cookie, "base64url").toString("utf8")));
    return session.state === state && session.expires > now ? session : null;
  } catch {
    return null;
  }
}

export async function verifyOnboardingLine(code: string, session: z.infer<typeof sessionSchema>) {
  const request = (path: string, data: Record<string, string>) => fetch(`https://api.line.me/oauth2/v2.1/${path}`, {
    method: "POST", body: new URLSearchParams(data), signal: AbortSignal.timeout(10_000), redirect: "error",
  });
  const invalid = () => new HiringError(403, "LINE could not verify this account.");
  const clientId = process.env.HIRING_LINE_LOGIN_ID!;
  const exchanged = await request("token", {
    grant_type: "authorization_code", code, redirect_uri: redirectUri(), client_id: clientId,
    client_secret: process.env.HIRING_LINE_LOGIN_SECRET!, code_verifier: session.verifier,
  });
  if (!exchanged.ok) throw invalid();
  const token = z.object({ id_token: z.string().min(1).max(8192) }).safeParse(await exchanged.json());
  if (!token.success) throw invalid();
  const response = await request("verify", { id_token: token.data.id_token, client_id: clientId, nonce: session.nonce });
  if (!response.ok) throw invalid();
  const profile = z.object({
    iss: z.literal("https://access.line.me"), aud: z.literal(clientId), exp: z.number().gt(Date.now() / 1000),
    sub: z.string().regex(lineUserIdPattern), nonce: z.literal(session.nonce), name: z.string().optional(),
  }).safeParse(await response.json());
  if (!profile.success) throw invalid();
  return profile.data;
}
