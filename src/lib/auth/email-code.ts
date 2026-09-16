import { randomBytes, randomInt, randomUUID } from "node:crypto";
import { and, eq, inArray, lt, sql } from "drizzle-orm";
import { getDb, type Database } from "@/lib/db";
import { withDatabaseTransaction } from "@/lib/db/transaction";
import { adminUsers, admissionsCaseMembers, authEmailChallenges, authEmailRateLimits } from "@/lib/db/schema";
import { resolveUserAccess } from "@/lib/auth-access";
import { createAppsScriptScheduleEmailSender } from "@/lib/classrooms/schedule-email";
import { renderTeacherEmail } from "@/lib/teacher-emails/render";
import { teacherEmailLogoUrl } from "@/lib/teacher-emails/brand";
import { teacherEmailPublicBaseUrl } from "@/lib/teacher-emails/config";
import {
  EMAIL_CODE_MAX_ATTEMPTS, EMAIL_CODE_RESEND_MS, EMAIL_CODE_TTL_MS, EMAIL_CODE_WINDOW_MS,
  emailCodeBinding, emailCodeCredentials, emailCodeEnabled, emailCodeHash, emailCodeIp, equalDigest,
} from "./email-code-policy";

export class EmailCodeLimitError extends Error {
  constructor(public retryAfter: number) { super("Please wait before trying again."); }
}

/** Read-only eligibility. Asking for a code must never activate an invitation. */
export async function canRequestEmailCode(email: string, db: Database = getDb()) {
  const [admin] = await db.select({ disabled: adminUsers.disabled }).from(adminUsers)
    .where(sql`lower(btrim(${adminUsers.email})) = ${email}`).limit(1);
  if (admin?.disabled) return false;
  if (await resolveUserAccess(email, db)) return true;
  const [invite] = await db.select({ id: admissionsCaseMembers.id }).from(admissionsCaseMembers)
    .where(and(eq(admissionsCaseMembers.email, email), inArray(admissionsCaseMembers.status, ["invited", "bounced"]))).limit(1);
  return !!invite;
}

async function takeLimit(tx: Database, key: string, limit: number, now: Date) {
  const expiresAt = new Date(now.getTime() + EMAIL_CODE_WINDOW_MS);
  const [row] = await tx.insert(authEmailRateLimits).values({ key, count: 1, expiresAt })
    .onConflictDoUpdate({ target: authEmailRateLimits.key, set: {
      count: sql`case when ${authEmailRateLimits.expiresAt} <= ${now} then 1 else ${authEmailRateLimits.count} + 1 end`,
      expiresAt: sql`case when ${authEmailRateLimits.expiresAt} <= ${now} then ${expiresAt} else ${authEmailRateLimits.expiresAt} end`,
    } }).returning();
  return row.count <= limit;
}

export function emailCodeSenderKeys(): Array<"primary" | "backup"> {
  const keys: Array<"primary" | "backup"> = [];
  if (process.env.SCHEDULE_EMAIL_APPS_SCRIPT_URL?.trim() && process.env.SCHEDULE_EMAIL_APPS_SCRIPT_SECRET?.trim()) keys.push("primary");
  if (process.env.SCHEDULE_EMAIL_BACKUP_APPS_SCRIPT_URL?.trim() && process.env.SCHEDULE_EMAIL_BACKUP_APPS_SCRIPT_SECRET?.trim()) keys.push("backup");
  return keys;
}

export async function sendEmailCode(email: string, code: string, challengeId: string) {
  if (!emailCodeEnabled()) throw new Error("Email login is unavailable");
  const content = renderTeacherEmail({
    subject: "Your BeGifted sign-in code", preheader: "Your code expires in 10 minutes.",
    category: "Account access", title: "Your sign-in code", greeting: "Hello,",
    paragraphs: ["Enter this code in the BeGifted sign-in window you just opened."],
    sections: [{ heading: code, paragraphs: ["This code expires in 10 minutes and works once. Keep it private.", "If you did not request this code, you can ignore this email."] }],
    logoUrl: teacherEmailLogoUrl(teacherEmailPublicBaseUrl()),
  });
  for (const key of emailCodeSenderKeys()) {
    try {
      await createAppsScriptScheduleEmailSender(key).sendEmail({ to: email, ...content, idempotencyKey: "auth-code:" + challengeId });
      return;
    } catch {
      // Retry the SAME code through the backup. Provider errors can contain private data.
    }
  }
  throw new Error("Sign-in email delivery failed");
}

export async function requestEmailCode(
  email: string, request: Request,
  options: { db?: Database; now?: Date; send?: typeof sendEmailCode; eligible?: typeof canRequestEmailCode } = {},
) {
  const db = options.db ?? getDb(), now = options.now ?? new Date();
  const id = randomUUID(), binding = randomBytes(32).toString("base64url");
  const code = randomInt(0, 1_000_000).toString().padStart(6, "0");
  const result = await withDatabaseTransaction(db, async (tx) => {
    // Locked rate rows serialize cross-instance requests, including first requests for an email.
    if (!await takeLimit(tx, emailCodeHash("request-ip", emailCodeIp(request)), 50, now)) return { retry: 900 };
    if (!await takeLimit(tx, emailCodeHash("request-email", email), 5, now)) return { retry: 900 };
    const [previous] = await tx.select().from(authEmailChallenges).where(eq(authEmailChallenges.email, email)).for("update");
    if (previous && now.getTime() - previous.createdAt.getTime() < EMAIL_CODE_RESEND_MS)
      return { retry: Math.ceil((EMAIL_CODE_RESEND_MS - (now.getTime() - previous.createdAt.getTime())) / 1000) };
    const values = { email, id, codeHash: emailCodeHash("code", id, email, code), bindingHash: emailCodeHash("binding", binding),
      createdAt: now, expiresAt: new Date(now.getTime() + EMAIL_CODE_TTL_MS), attempts: 0, ready: false, consumedAt: null };
    await tx.insert(authEmailChallenges).values(values).onConflictDoUpdate({ target: authEmailChallenges.email, set: values });
    return { retry: 0 };
  });
  if (result.retry) throw new EmailCodeLimitError(result.retry);
  try {
    if (await (options.eligible ?? canRequestEmailCode)(email, db)) {
      await (options.send ?? sendEmailCode)(email, code, id);
      await db.update(authEmailChallenges).set({ ready: true }).where(eq(authEmailChallenges.id, id));
    } else {
      await db.update(authEmailChallenges).set({ consumedAt: now }).where(eq(authEmailChallenges.id, id));
    }
  } catch {
    await db.update(authEmailChallenges).set({ ready: false, consumedAt: new Date() }).where(eq(authEmailChallenges.id, id));
    console.error("Email login delivery or eligibility failed");
  }
  // Bounded retention; expiry is always checked independently during verification.
  await db.delete(authEmailChallenges).where(lt(authEmailChallenges.expiresAt, new Date(now.getTime() - 86_400_000)));
  await db.delete(authEmailRateLimits).where(lt(authEmailRateLimits.expiresAt, new Date(now.getTime() - 86_400_000)));
  return { challengeId: id, binding };
}

export async function verifyEmailCode(
  credentials: unknown, request: Request,
  options: { db?: Database; now?: Date; eligible?: typeof canRequestEmailCode } = {},
) {
  if (!emailCodeEnabled()) return null;
  const parsed = emailCodeCredentials.safeParse(credentials), binding = emailCodeBinding(request);
  const db = options.db ?? getDb(), now = options.now ?? new Date();
  const verified = await withDatabaseTransaction(db, async (tx) => {
    if (!await takeLimit(tx, emailCodeHash("verify-ip", emailCodeIp(request)), 100, now)) return null;
    if (!parsed.success || !binding) return null;
    const { email, challengeId, code } = parsed.data;
    const [row] = await tx.select().from(authEmailChallenges).where(and(eq(authEmailChallenges.email, email), eq(authEmailChallenges.id, challengeId))).for("update");
    if (!row || !row.ready || row.consumedAt || row.expiresAt <= now || row.attempts >= EMAIL_CODE_MAX_ATTEMPTS) return null;
    if (!equalDigest(row.bindingHash, emailCodeHash("binding", binding))) return null;
    const matches = equalDigest(row.codeHash, emailCodeHash("code", challengeId, email, code));
    await tx.update(authEmailChallenges).set({ attempts: row.attempts + 1, ...(matches ? { consumedAt: now } : {}) }).where(eq(authEmailChallenges.id, challengeId));
    return matches ? email : null;
  });
  if (!verified || !await (options.eligible ?? canRequestEmailCode)(verified, db)) return null;
  return { id: emailCodeHash("user", verified), email: verified };
}
