import "server-only";
import { createHash, randomUUID } from "node:crypto";
import { and, asc, desc, eq, ne, sql } from "drizzle-orm";
import { getDb, type Database } from "@/lib/db";
import * as schema from "@/lib/db/schema";
import { isPreviewEnvironment } from "@/lib/preview-policy";
import { PostClassValidationError } from "./errors";
import { withPostClassTransaction } from "./transaction";
import { newReceiptChallenge, checkReceiptChallenge } from "./receipt-evidence";

const channel = schema.postClassReminderLineChannel;
const alerts = schema.postClassReminderAlerts;
const singleton = eq(channel.id, "private");
function configuration() {
  const recipient = process.env.POST_CLASS_REMINDER_LINE_USER_ID?.trim() ?? "";
  const token = process.env.LINE_CHANNEL_ACCESS_TOKEN?.trim() ?? "";
  if (isPreviewEnvironment() || !/^U[a-f0-9]{32}$/.test(recipient) || !token) {
    throw new PostClassValidationError("Configure Kevin's private LINE user ID and channel token in production before testing alerts.");
  }
  return { recipient, token, binding: createHash("sha256").update(`${recipient}:${token}`).digest("hex") };
}
class LineRejection extends Error {
  constructor(message: string, readonly permanent = false) { super(message); }
}
async function push(text: string, id: string, expectedBinding: string) {
  const config = configuration();
  if (config.binding !== expectedBinding) throw new LineRejection("LINE destination changed. Verify the destination and reconcile queued alerts.", true);
  const response = await fetch("https://api.line.me/v2/bot/message/push", {
    method: "POST", headers: { Authorization: `Bearer ${config.token}`, "Content-Type": "application/json", "X-Line-Retry-Key": id },
    body: JSON.stringify({ to: config.recipient, messages: [{ type: "text", text }] }), signal: AbortSignal.timeout(15_000), cache: "no-store",
  });
  const receipt = response.status === 409 ? response.headers.get("x-line-accepted-request-id") : response.headers.get("x-line-request-id");
  if ((response.ok || response.status === 409) && receipt) return receipt;
  if (response.status >= 400 && response.status < 500 && ![409, 429].includes(response.status)) {
    throw new LineRejection(`LINE rejected the alert (HTTP ${response.status}). Check the private destination and channel authorization.`, true);
  }
  throw new LineRejection(`LINE acceptance was not confirmed (HTTP ${response.status}).`);
}
export async function sendReminderLineTest(actor: string, db: Database = getDb()) {
  const config = configuration();
  const challenge = newReceiptChallenge(actor, config.binding);
  await db.insert(channel).values({ id: "private", recipientId: config.recipient, binding: config.binding, testEvidence: challenge.evidence })
    .onConflictDoUpdate({ target: channel.id, set: { recipientId: config.recipient, binding: config.binding, testEvidence: challenge.evidence, updatedAt: new Date() } });
  const receipt = await push(`BeGifted connection test. Your verification code is ${challenge.code}. Enter it in Class Feedback to confirm this private LINE destination.`, randomUUID(), config.binding);
  await db.update(channel).set({ testEvidence: { ...challenge.evidence, receipt, acceptedAt: new Date().toISOString() } })
    .where(and(singleton, eq(channel.binding, config.binding), sql`${channel.testEvidence}->>'hash' = ${challenge.evidence.hash}`));
  return { accepted: true, message: "LINE accepted the generic test. Enter the code received in Kevin's private chat." };
}
export async function confirmReminderLineTest(actor: string, code: string, db: Database = getDb()) {
  const config = configuration();
  const confirmed = await withPostClassTransaction(db, async tx => {
    await tx.execute(sql`select id from post_class_reminder_line_channel where id = 'private' for update`);
    const [row] = await tx.select().from(channel).where(singleton);
    if (!row?.testEvidence || row.binding !== config.binding) return false;
    const evidence = checkReceiptChallenge(row.testEvidence, code, actor, config.binding);
    await tx.update(channel).set({ testEvidence: evidence, updatedAt: new Date() }).where(singleton);
    if (!evidence.confirmedAt) return false;
    await tx.insert(schema.postClassConfigAuditLog).values({ entityType: "feedback_line", entityKey: "private", action: "receipt_confirmed",
      actorEmail: actor, afterValue: { recipientId: config.recipient, receipt: evidence.receipt } });
    return true;
  });
  if (!confirmed) throw new PostClassValidationError("The LINE receipt code is invalid or expired. Use the latest private test message.");
  return { confirmed: true };
}
export async function reminderLineStatus(db: Database = getDb()) {
  let config: ReturnType<typeof configuration> | null = null;
  try { config = configuration(); } catch { /* Expose configuration state without credentials. */ }
  const [row] = await db.select().from(channel).where(singleton);
  const pending = await db.select({ lastError: alerts.lastError }).from(alerts).where(ne(alerts.status, "accepted"));
  const [last] = await db.select({ at: alerts.acceptedAt }).from(alerts).where(eq(alerts.status, "accepted")).orderBy(desc(alerts.acceptedAt)).limit(1);
  return { configured: Boolean(config), verified: Boolean(config && row?.binding === config.binding && row.testEvidence?.confirmedAt && row.testEvidence?.receipt),
    testAcceptedAt: row?.testEvidence?.acceptedAt ?? null, testConfirmedAt: row?.testEvidence?.confirmedAt ?? null,
    pending: pending.length, alertError: pending.find(p => p.lastError)?.lastError ?? null, lastAcceptedAt: last?.at?.toISOString() ?? null };
}
export async function requireReminderLineReadiness(db: Database) {
  const status = await reminderLineStatus(db);
  if (!status.verified || status.alertError) throw new PostClassValidationError("Verify Kevin's private LINE test receipt and resolve alert delivery failures before activation.");
}

/** The database transition and outbox insertion commit together. */
export async function queueReminderAlert(healthy: boolean, detail: string, db: Database = getDb(), now = new Date()) {
  let config: ReturnType<typeof configuration>;
  try { config = configuration(); } catch { return; }
  await withPostClassTransaction(db, async tx => {
    await tx.execute(sql`select id from post_class_reminder_line_channel where id = 'private' for update`);
    const [row] = await tx.select().from(channel).where(singleton);
    if (!row || row.binding !== config.binding || !row.testEvidence?.confirmedAt || !row.testEvidence?.receipt) return;
    const health = healthy ? "healthy" : "failing";
    let episodeId = row.episodeId;
    const transition = row.health !== health && (!healthy || row.health === "failing");
    if (!healthy && transition) episodeId = randomUUID();
    if (transition && episodeId) {
      const kind = healthy ? "recovery" : "failure";
      await tx.insert(alerts).values({ episodeId, kind, recipientId: row.recipientId, binding: row.binding,
        message: `BeGifted feedback reminders ${healthy ? "recovered" : "need attention"}.\n${detail.slice(0, 2000)}\nhttps://bgscheduler.vercel.app/post-class-feedback`,
        createdAt: now, nextAttemptAt: now, updatedAt: now }).onConflictDoNothing();
    }
    await tx.update(channel).set({ health, episodeId, detail: detail.slice(0, 2000), checkedAt: now, updatedAt: now }).where(singleton);
  });
}

/** One oldest alert at a time preserves failure/recovery order across concurrent watchdogs. */
export async function dispatchReminderAlerts(db: Database = getDb(), now = new Date()) {
  const leaseToken = randomUUID();
  const claimed = await withPostClassTransaction(db, async tx => {
    await tx.execute(sql`select id from post_class_reminder_line_channel where id = 'private' for update`);
    const [row] = await tx.select().from(alerts).where(ne(alerts.status, "accepted")).orderBy(asc(alerts.createdAt), asc(alerts.id)).limit(1);
    if (!row || row.status === "blocked" || row.nextAttemptAt > now || (row.leaseUntil && row.leaseUntil > now)) return null;
    if (row.firstAttemptAt && now.getTime() - row.firstAttemptAt.getTime() >= 23 * 60 * 60_000) {
      await tx.update(alerts).set({ status: "blocked", lastError: "LINE alert needs manual reconciliation: its retry window has expired.", updatedAt: now }).where(eq(alerts.id, row.id));
      return null;
    }
    const [result] = await tx.update(alerts).set({ status: "sending", attempts: row.attempts + 1,
      firstAttemptAt: row.firstAttemptAt ?? now, leaseToken, leaseUntil: new Date(now.getTime() + 120_000), updatedAt: now }).where(eq(alerts.id, row.id)).returning();
    return result;
  });
  if (!claimed) return false;
  try {
    const status = await reminderLineStatus(db);
    if (!status.verified) throw new LineRejection("LINE destination is no longer verified. Reconnect and reconcile queued alerts.", true);
    const receipt = await push(claimed.message, claimed.id, claimed.binding);
    await db.update(alerts).set({ status: "accepted", receipt, acceptedAt: now, lastError: null, leaseUntil: null, updatedAt: now })
      .where(and(eq(alerts.id, claimed.id), eq(alerts.leaseToken, leaseToken)));
    return true;
  } catch (error) {
    const permanent = error instanceof LineRejection && error.permanent;
    await db.update(alerts).set({ status: permanent ? "blocked" : "pending", leaseUntil: null,
      nextAttemptAt: new Date(now.getTime() + Math.min(180, 30 * 2 ** (claimed.attempts - 1)) * 60_000),
      lastError: error instanceof LineRejection ? error.message : "LINE alert delivery is unconfirmed; a retry is queued.", updatedAt: now })
      .where(and(eq(alerts.id, claimed.id), eq(alerts.leaseToken, leaseToken)));
    return false;
  }
}
