import "server-only";
import { createHash, randomBytes, timingSafeEqual } from "node:crypto";
import { isPreviewEnvironment } from "@/lib/preview-policy";
import { decryptToken, encryptToken } from "@/lib/sales-dashboard/google-oauth";
import { PostClassValidationError } from "./errors";
import { FEEDBACK_MAILBOX, GMAIL_SEND_SCOPE } from "./gmail";

export const FEEDBACK_OAUTH_COOKIE = "feedback_gmail_oauth";
export const FEEDBACK_OAUTH_PATH = "/api/post-class-feedback/email/callback";
export const FEEDBACK_OAUTH_SCOPES = ["openid", "email", GMAIL_SEND_SCOPE];

export function feedbackEmailConfiguration() {
  return {
    configured: Boolean(process.env.POST_CLASS_GMAIL_CLIENT_ID && process.env.POST_CLASS_GMAIL_CLIENT_SECRET),
    trusted: process.env.POST_CLASS_GMAIL_WORKSPACE_TRUSTED === "true",
    available: !isPreviewEnvironment(),
  };
}

export function requireFeedbackEmailConfiguration() {
  const config = feedbackEmailConfiguration();
  if (!config.available) throw new PostClassValidationError("Gmail connections and sending are disabled in preview environments.");
  if (!config.configured) throw new PostClassValidationError("Configure the dedicated Gmail OAuth client first.");
  if (!config.trusted) throw new PostClassValidationError("A Workspace administrator must mark the dedicated Gmail client Trusted before connecting.");
  return {
    clientId: process.env.POST_CLASS_GMAIL_CLIENT_ID!,
    clientSecret: process.env.POST_CLASS_GMAIL_CLIENT_SECRET!,
    origin: new URL(process.env.APP_BASE_URL || "https://bgscheduler.vercel.app").origin,
  };
}

interface OAuthState { state: string; verifier: string; actor: string; origin: string; clientId: string; expires: number }
export function beginFeedbackEmailOAuth(actorEmail: string, origin: string) {
  const config = requireFeedbackEmailConfiguration();
  if (origin !== config.origin || !origin.startsWith("https://")) throw new PostClassValidationError("Connect Gmail from the production Class Feedback page.");
  const state: OAuthState = { state: randomBytes(32).toString("base64url"), verifier: randomBytes(48).toString("base64url"),
    actor: actorEmail.toLowerCase(), origin, clientId: config.clientId, expires: Date.now() + 600_000 };
  const params = new URLSearchParams({ client_id: config.clientId, redirect_uri: origin + FEEDBACK_OAUTH_PATH,
    response_type: "code", scope: FEEDBACK_OAUTH_SCOPES.join(" "), access_type: "offline", prompt: "consent",
    login_hint: FEEDBACK_MAILBOX, state: state.state, code_challenge_method: "S256",
    code_challenge: createHash("sha256").update(state.verifier).digest("base64url") });
  return { url: `https://accounts.google.com/o/oauth2/v2/auth?${params}`, cookie: encryptToken(JSON.stringify(state))! };
}

export function verifyFeedbackEmailState(cookie: string, returnedState: string, actorEmail: string, now = Date.now()): OAuthState {
  const config = requireFeedbackEmailConfiguration();
  try {
    if (!/^v1:[\w-]+:[\w-]+:[\w-]+$/.test(cookie)) throw new Error();
    const state = JSON.parse(decryptToken(cookie)!) as OAuthState;
    const left = Buffer.from(state.state); const right = Buffer.from(returnedState);
    if (left.length !== right.length || !timingSafeEqual(left, right) || state.actor !== actorEmail.toLowerCase() ||
      state.expires <= now || state.expires > now + 600_000 || state.clientId !== config.clientId || state.origin !== config.origin ||
      !/^[\w-]{64}$/.test(state.verifier)) throw new Error();
    return state;
  } catch { throw new PostClassValidationError("Gmail connection expired or could not be verified. Start again from Class Feedback."); }
}
