import "server-only";
import { and, eq, sql } from "drizzle-orm";
import { getDb, type Database } from "@/lib/db";
import * as schema from "@/lib/db/schema";
import { decryptToken, encryptToken } from "@/lib/sales-dashboard/google-oauth";
import { FEEDBACK_MAILBOX, GMAIL_SEND_SCOPE, GmailRejection, createGmailSender } from "./gmail";
import { FEEDBACK_OAUTH_PATH, feedbackEmailConfiguration, requireFeedbackEmailConfiguration, type verifyFeedbackEmailState } from "./gmail-connection";
import { PostClassValidationError } from "./errors";
import { withPostClassTransaction } from "./transaction";
import { newReceiptChallenge, checkReceiptChallenge } from "./receipt-evidence";
import { assertFeedbackConnectionPaused } from "./reminder-connection-state";
export { assertFeedbackConnectionPaused } from "./reminder-connection-state";

const table = schema.postClassEmailConnection;
const singleton = eq(table.id, "gmail");
const hasScope = (value: string) => value.split(/\s+/).includes(GMAIL_SEND_SCOPE);
const binding = (row: typeof table.$inferSelect) => `${row.clientId}:${row.googleSubject}:${row.revision}`;

async function tokenRequest(params: Record<string, string>) {
  const response = await fetch("https://oauth2.googleapis.com/token", {
    method: "POST", headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams(params), signal: AbortSignal.timeout(20_000), cache: "no-store",
  });
  const data = await response.json() as { access_token?: string; refresh_token?: string; expires_in?: number; scope?: string; error?: string };
  if (!response.ok || !data.access_token || !Number.isFinite(data.expires_in) || data.expires_in! <= 0) {
    const permanent = ["invalid_grant", "invalid_client", "unauthorized_client", "access_denied"].includes(data.error ?? "");
    throw new GmailRejection(permanent ? "Reconnect Gmail: Google rejected this authorization." : "Gmail token renewal is temporarily unavailable.", permanent);
  }
  return data as typeof data & { access_token: string; expires_in: number };
}

/** Pin every production submission to the previously verified grant. */
export async function feedbackReminderGrant(db: Database): Promise<number> {
  requireFeedbackEmailConfiguration();
  const [row] = await db.select().from(table).where(singleton);
  if (!row || row.clientId !== process.env.POST_CLASS_GMAIL_CLIENT_ID || row.mailbox !== FEEDBACK_MAILBOX || !hasScope(row.scope) ||
    !row.refreshedAt || row.lastError?.startsWith("Reconnect") || row.testEvidence?.binding !== binding(row) ||
    !row.testEvidence?.confirmedAt || !row.testEvidence.receipt) {
    throw new GmailRejection("The current Gmail grant must be verified before sending tutor reminders.", true);
  }
  return row.revision;
}

export async function connectFeedbackMailbox(code: string, state: ReturnType<typeof verifyFeedbackEmailState>, db: Database = getDb()) {
  const config = requireFeedbackEmailConfiguration();
  await assertFeedbackConnectionPaused(db);
  if (state.clientId !== config.clientId || state.origin !== config.origin) throw new PostClassValidationError("Gmail client changed. Start the connection again.");
  const token = await tokenRequest({ client_id: config.clientId, client_secret: config.clientSecret,
    grant_type: "authorization_code", code, code_verifier: state.verifier, redirect_uri: state.origin + FEEDBACK_OAUTH_PATH });
  if (!token.refresh_token || !hasScope(token.scope ?? "")) throw new PostClassValidationError("Grant Gmail sending and offline access, then connect again.");
  const response = await fetch("https://openidconnect.googleapis.com/v1/userinfo", {
    headers: { Authorization: `Bearer ${token.access_token}` }, signal: AbortSignal.timeout(20_000), cache: "no-store",
  });
  const user = await response.json() as { email?: string; email_verified?: boolean; sub?: string };
  if (!response.ok || user.email?.toLowerCase() !== FEEDBACK_MAILBOX || user.email_verified !== true || !user.sub) {
    throw new PostClassValidationError(`Connect only the verified ${FEEDBACK_MAILBOX} mailbox.`);
  }
  const values = { clientId: config.clientId, mailbox: FEEDBACK_MAILBOX, googleSubject: user.sub,
    accessTokenCiphertext: encryptToken(token.access_token)!, refreshTokenCiphertext: encryptToken(token.refresh_token)!,
    expiresAt: new Date(Date.now() + token.expires_in * 1000), scope: token.scope!, connectedBy: state.actor,
    connectedAt: new Date(), refreshedAt: null, checkedAt: null, lastError: null, testEvidence: null, updatedAt: new Date() };
  await withPostClassTransaction(db, async (tx) => {
    await assertFeedbackConnectionPaused(tx, true);
    const [row] = await tx.insert(table).values({ id: "gmail", ...values }).onConflictDoUpdate({ target: table.id,
      set: { ...values, revision: sql`${table.revision} + 1` } }).returning({ revision: table.revision });
    await tx.insert(schema.postClassConfigAuditLog).values({ entityType: "feedback_gmail", entityKey: "gmail", action: "connected",
      actorEmail: state.actor, afterValue: { mailbox: FEEDBACK_MAILBOX, clientId: config.clientId, revision: row.revision } });
  });
  return feedbackMailboxStatus(db);
}

/** Serialize refreshes with reconnection; tokens from another grant cannot overwrite the current one. */
export async function feedbackGmailAccessToken(force = false, db: Database = getDb(), expectedRevision?: number): Promise<string> {
  let config: ReturnType<typeof requireFeedbackEmailConfiguration>;
  try { config = requireFeedbackEmailConfiguration(); }
  catch (error) { throw new GmailRejection(error instanceof Error ? error.message : "Gmail is not configured.", true); }
  const result = await withPostClassTransaction(db, async (tx) => {
    await tx.execute(sql`select id from post_class_email_connection where id = 'gmail' for update`);
    const [row] = await tx.select().from(table).where(singleton);
    if (!row || row.clientId !== config.clientId || row.mailbox !== FEEDBACK_MAILBOX || !hasScope(row.scope) ||
      (expectedRevision !== undefined && row.revision !== expectedRevision) || row.lastError?.startsWith("Reconnect")) {
      return { error: new GmailRejection("Reconnect the dedicated Gmail sender before sending reminders.", true) };
    }
    if (!force && !row.lastError && row.expiresAt.getTime() > Date.now() + 120_000) {
      return { token: decryptToken(row.accessTokenCiphertext)! };
    }
    try {
      const token = await tokenRequest({ client_id: config.clientId, client_secret: config.clientSecret,
        grant_type: "refresh_token", refresh_token: decryptToken(row.refreshTokenCiphertext)! });
      if (token.scope && !hasScope(token.scope)) throw new GmailRejection("Reconnect Gmail: sending permission was removed.", true);
      await tx.update(table).set({ accessTokenCiphertext: encryptToken(token.access_token)!,
        ...(token.refresh_token ? { refreshTokenCiphertext: encryptToken(token.refresh_token)! } : {}),
        expiresAt: new Date(Date.now() + token.expires_in * 1000), scope: token.scope ?? row.scope,
        refreshedAt: new Date(), checkedAt: new Date(), lastError: null, updatedAt: new Date() }).where(singleton);
      return { token: token.access_token };
    } catch (cause) {
      const error = cause instanceof GmailRejection ? cause : new GmailRejection("Gmail token renewal is temporarily unavailable.");
      await tx.update(table).set({ lastError: error.message, checkedAt: new Date(), updatedAt: new Date(),
        ...(error.permanent ? { expiresAt: new Date(0), testEvidence: null } : {}) }).where(singleton);
      // Return the error so the diagnostic write commits before it is thrown.
      return { error };
    }
  });
  if (result.error) throw result.error;
  return result.token!;
}

export async function feedbackMailboxStatus(db: Database = getDb()) {
  const config = feedbackEmailConfiguration();
  const [row] = await db.select().from(table).where(singleton);
  const connected = Boolean(config.configured && config.trusted && config.available && row &&
    row.clientId === process.env.POST_CLASS_GMAIL_CLIENT_ID && row.mailbox === FEEDBACK_MAILBOX && hasScope(row.scope) && !row.lastError?.startsWith("Reconnect"));
  return { ...config, mailbox: FEEDBACK_MAILBOX, connected, revision: row?.revision ?? null,
    connectedAt: row?.connectedAt.toISOString() ?? null, refreshedAt: row?.refreshedAt?.toISOString() ?? null,
    checkedAt: row?.checkedAt?.toISOString() ?? null, lastError: row?.lastError ?? null,
    testAcceptedAt: row?.testEvidence?.acceptedAt ?? null, testConfirmedAt: row?.testEvidence?.confirmedAt ?? null };
}

export async function sendFeedbackMailboxTest(actor: string, db: Database = getDb()) {
  await assertFeedbackConnectionPaused(db);
  // A successful fresh renewal is an explicit launch prerequisite.
  await feedbackGmailAccessToken(true, db);
  const { row, challenge } = await withPostClassTransaction(db, async tx => {
    await assertFeedbackConnectionPaused(tx, true);
    const [row] = await tx.select().from(table).where(singleton).for("update");
    if (!row) throw new PostClassValidationError("Connect the dedicated Gmail sender first.");
    const challenge = newReceiptChallenge(actor, binding(row));
    await tx.update(table).set({ testEvidence: challenge.evidence }).where(singleton);
    return { row, challenge };
  });
  const sender = createGmailSender(force => feedbackGmailAccessToken(force, db, row.revision));
  const content = `BeGifted reminder email test.\n\nYour verification code is ${challenge.code}.\n\nEnter this code in Class Feedback to confirm receipt. This is a test; no tutor reminders have been enabled.`;
  const receipt = await sender.sendEmail({ to: actor, subject: "BeGifted feedback email verification", text: content,
    html: `<p>${content.replaceAll("\n", "<br>")}</p>`, idempotencyKey: `gmail-test:${challenge.evidence.hash}` });
  await db.update(table).set({ testEvidence: { ...challenge.evidence, receipt: receipt.id, acceptedAt: new Date().toISOString() } })
    .where(and(singleton, eq(table.revision, row.revision), sql`${table.testEvidence}->>'hash' = ${challenge.evidence.hash}`));
  return { accepted: true, message: "Google accepted the test. Enter the code from your receiving inbox to confirm delivery." };
}

export async function confirmFeedbackMailboxTest(actor: string, code: string, db: Database = getDb()) {
  const confirmed = await withPostClassTransaction(db, async tx => {
    await tx.execute(sql`select id from post_class_email_connection where id = 'gmail' for update`);
    const [row] = await tx.select().from(table).where(singleton);
    if (!row?.testEvidence || row.clientId !== process.env.POST_CLASS_GMAIL_CLIENT_ID) return false;
    const evidence = checkReceiptChallenge(row.testEvidence, code, actor, binding(row));
    await tx.update(table).set({ testEvidence: evidence }).where(singleton);
    if (!evidence.confirmedAt) return false;
    await tx.insert(schema.postClassConfigAuditLog).values({ entityType: "feedback_gmail", entityKey: "gmail", action: "receipt_confirmed",
      actorEmail: actor, afterValue: { revision: row.revision, receipt: evidence.receipt } });
    return true;
  });
  if (!confirmed) throw new PostClassValidationError("The receipt code is invalid or expired. Use the latest test sent to your inbox.");
  return { confirmed: true };
}

/** Called inside the settings transaction; does not request or expose tokens. */
export async function requireFeedbackMailboxReadiness(db: Database, now: Date) {
  requireFeedbackEmailConfiguration();
  await db.execute(sql`select id from post_class_email_connection where id = 'gmail' for update`);
  const [row] = await db.select().from(table).where(singleton);
  const since = now.getTime() - 86_400_000;
  if (!row || row.clientId !== process.env.POST_CLASS_GMAIL_CLIENT_ID || row.mailbox !== FEEDBACK_MAILBOX || !hasScope(row.scope) || row.lastError ||
    !row.refreshedAt || row.refreshedAt.getTime() < since || row.testEvidence?.binding !== binding(row) || !row.testEvidence?.confirmedAt ||
    new Date(row.testEvidence.confirmedAt).getTime() < since || !row.testEvidence.receipt) {
    throw new PostClassValidationError("Connect Gmail, renew its token, and confirm a test email in the receiving inbox within 24 hours before activation.");
  }
}
