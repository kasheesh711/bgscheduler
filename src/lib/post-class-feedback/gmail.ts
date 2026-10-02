import { createHash } from "node:crypto";
import { ScheduleEmailRejection, type ScheduleEmailSender, type ScheduleEmailSendInput } from "@/lib/classrooms/schedule-email";

export const FEEDBACK_MAILBOX = "admin@begiftededucation.com";
export const GMAIL_SEND_SCOPE = "https://www.googleapis.com/auth/gmail.send";

export class GmailRejection extends ScheduleEmailRejection {
  constructor(message: string, readonly permanent = false, readonly retryAt: Date | null = null) {
    super(message);
  }
}

function encodedSubject(subject: string): string {
  const words: string[] = [];
  let word = "";
  for (const char of subject) {
    if (Buffer.byteLength(word + char) > 42) {
      words.push(`=?UTF-8?B?${Buffer.from(word).toString("base64")}?=`); word = "";
    }
    word += char;
  }
  if (word) words.push(`=?UTF-8?B?${Buffer.from(word).toString("base64")}?=`);
  return words.join("\r\n ");
}

export interface GmailSenderHeaders {
  /** Display name on the From header; defaults to "BeGifted". */
  senderName?: string;
  /** Reply-To address; defaults to the sending mailbox. */
  replyTo?: string;
}

const EMAIL_ADDRESS = /^[^\s<>@,;]+@[^\s<>@,;]+\.[^\s<>@,;]+$/;

function mime(input: ScheduleEmailSendInput, headers: GmailSenderHeaders = {}): string {
  if (!EMAIL_ADDRESS.test(input.to) || /[\r\n]/.test(input.subject) || !input.idempotencyKey) {
    throw new GmailRejection("Invalid reminder email headers.", true);
  }
  const senderName = headers.senderName?.replace(/[\r\n"<>\\]/g, "").trim() || "BeGifted";
  // RFC 5322: a display name with specials (comma, colon, …) must be quoted.
  const displayName = !/^[\x20-\x7e]+$/.test(senderName) ? encodedSubject(senderName)
    : /^[A-Za-z0-9 !#$%&'*+\-/=?^_`{|}~]+$/.test(senderName) ? senderName : `"${senderName}"`;
  const replyTo = headers.replyTo && EMAIL_ADDRESS.test(headers.replyTo) ? headers.replyTo : FEEDBACK_MAILBOX;
  const key = createHash("sha256").update(input.idempotencyKey).digest("hex");
  const boundary = `feedback_${key}`;
  const body = (value: string) => Buffer.from(value, "utf8").toString("base64").match(/.{1,76}/g)?.join("\r\n") ?? "";
  return [
    `From: ${displayName} <${FEEDBACK_MAILBOX}>`, `Reply-To: ${replyTo}`, `To: ${input.to}`,
    `Subject: ${encodedSubject(input.subject)}`, `Message-ID: <${key}@begiftededucation.com>`,
    "MIME-Version: 1.0", `Content-Type: multipart/alternative; boundary="${boundary}"`, "",
    `--${boundary}`, 'Content-Type: text/plain; charset="UTF-8"', "Content-Transfer-Encoding: base64", "", body(input.text),
    `--${boundary}`, 'Content-Type: text/html; charset="UTF-8"', "Content-Transfer-Encoding: base64", "", body(input.html),
    `--${boundary}--`, "",
  ].join("\r\n");
}

/** Only explicit rejections are retryable. A Message-ID is not a Gmail idempotency key. */
export function createGmailSender(
  accessToken: (force?: boolean) => Promise<string>,
  beforeSubmit?: () => Promise<void>,
  headers?: GmailSenderHeaders,
): ScheduleEmailSender {
  return { async sendEmail(input) {
    const raw = Buffer.from(mime(input, headers)).toString("base64url");
    for (let authAttempt = 0; authAttempt < 2; authAttempt++) {
      let token: string;
      try { token = await accessToken(authAttempt === 1); }
      catch (error) {
        if (error instanceof GmailRejection) throw error;
        throw new GmailRejection("Gmail authorization is unavailable. Reconnect the sender.", true);
      }
      // Renewal can take time. Recheck the deadline and worker fence after it.
      try { await beforeSubmit?.(); }
      catch (error) {
        if (error instanceof ScheduleEmailRejection) throw error;
        throw new GmailRejection("Reminder eligibility could not be rechecked before submission.");
      }
      const response = await fetch("https://gmail.googleapis.com/gmail/v1/users/me/messages/send", {
        method: "POST", headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
        body: JSON.stringify({ raw }), signal: AbortSignal.timeout(20_000), cache: "no-store",
      });
      if (response.status === 401 && authAttempt === 0) continue;
      if ([400, 401, 403, 404, 429].includes(response.status)) {
        const payload = await response.json().catch(() => null);
        const reason = payload?.error?.errors?.[0]?.reason;
        const limited = response.status === 429 || ["rateLimitExceeded", "userRateLimitExceeded", "dailyLimitExceeded"].includes(reason);
        const retry = response.headers.get("retry-after");
        const at = retry ? (/^\d+$/.test(retry) ? new Date(Date.now() + Number(retry) * 1000) : new Date(retry)) : null;
        const daily = reason === "dailyLimitExceeded";
        throw new GmailRejection(limited ? `Gmail ${daily ? "daily " : ""}sending limit reached; the queued reminder will retry.`
          : `Gmail rejected the reminder (HTTP ${response.status}). Check the sender authorization and recipient.`,
        !limited, at && Number.isFinite(at.getTime()) ? at : null);
      }
      if (!response.ok) throw new Error(`Gmail acceptance is uncertain (HTTP ${response.status}). Check the sending mailbox.`);
      const result = await response.json();
      if (typeof result?.id !== "string" || !result.id.trim()) throw new Error("Gmail returned no acceptance receipt. Check the sending mailbox.");
      return { id: result.id };
    }
    throw new GmailRejection("Gmail authorization could not be renewed.", true);
  } };
}
