import { createHash } from "node:crypto";
import {
  ScheduleEmailRejection,
  type ScheduleEmailSender,
} from "@/lib/classrooms/schedule-email";

const RESEND_ENDPOINT = "https://api.resend.com/emails";
const DEFAULT_REPLY_TO = "kevhsh7@gmail.com";
/** Resend caps Idempotency-Key at 256 characters and remembers it for 24 hours. */
const MAX_IDEMPOTENCY_KEY = 256;
/** Statuses Resend returns before it accepts a message: safe to try another provider. */
const REJECTED_STATUSES: ReadonlySet<number> = new Set([400, 401, 403, 404, 422, 429]);

interface ResendEnvironment {
  readonly [name: string]: string | undefined;
}

export interface ResendSenderOptions {
  from?: string;
  replyTo?: string;
  fetchImpl?: typeof fetch;
}

export function resendConfigured(env: ResendEnvironment = process.env): boolean {
  return Boolean(env.RESEND_API_KEY?.trim() && env.RESEND_FROM?.trim());
}

export function resendIdempotencyKey(key: string): string {
  if (key.length <= MAX_IDEMPOTENCY_KEY) return key;
  return `sha256:${createHash("sha256").update(key).digest("hex")}`;
}

/**
 * Sends one message through Resend.
 *
 * Outcome discipline (matches the Gmail and Apps Script senders):
 * - `ScheduleEmailRejection`: definitely not accepted (config missing, 4xx
 *   validation/auth/quota). The caller may try another provider.
 * - plain `Error`: uncertain (network, timeout, 409 idempotency conflict, 5xx,
 *   2xx without an id). The caller must not resend elsewhere; a retry through
 *   Resend with the same Idempotency-Key within 24h is safe.
 * Error messages never carry the recipient, the body or the key.
 */
export function createResendSender(
  env: ResendEnvironment = process.env,
  options: ResendSenderOptions = {},
): ScheduleEmailSender {
  return {
    async sendEmail(input) {
      const apiKey = env.RESEND_API_KEY?.trim();
      const from = options.from?.trim() || env.RESEND_FROM?.trim();
      if (!apiKey) throw new ScheduleEmailRejection("RESEND_API_KEY is not configured");
      if (!from) throw new ScheduleEmailRejection("RESEND_FROM is not configured");
      const replyTo = options.replyTo?.trim()
        || env.RESEND_REPLY_TO?.trim()
        || env.SCHEDULE_EMAIL_REPLY_TO?.trim()
        || DEFAULT_REPLY_TO;

      let response: Response;
      try {
        response = await (options.fetchImpl ?? fetch)(RESEND_ENDPOINT, {
          method: "POST",
          signal: AbortSignal.timeout(15_000),
          headers: {
            "Content-Type": "application/json",
            Authorization: `Bearer ${apiKey}`,
            "Idempotency-Key": resendIdempotencyKey(input.idempotencyKey),
          },
          body: JSON.stringify({
            from,
            to: [input.to.trim()],
            subject: input.subject.replace(/\s+/g, " ").trim(),
            html: input.html,
            text: input.text,
            reply_to: replyTo,
          }),
        });
      } catch (error) {
        const name = error instanceof Error ? error.name : "UnknownError";
        throw new Error(`Resend acceptance is uncertain (${name}). Check the Resend log before resending.`);
      }

      const json = await response.json().catch(() => null) as { id?: unknown; name?: unknown } | null;
      if (REJECTED_STATUSES.has(response.status)) {
        const code = typeof json?.name === "string" ? json.name : "rejected";
        throw new ScheduleEmailRejection(`Resend rejected the message before acceptance (HTTP ${response.status}, ${code}).`);
      }
      if (!response.ok) {
        throw new Error(`Resend acceptance is uncertain (HTTP ${response.status}). Check the Resend log before resending.`);
      }
      if (typeof json?.id !== "string" || !json.id.trim()) {
        throw new Error("Resend returned no acceptance receipt. Check the Resend log before resending.");
      }
      return { id: json.id };
    },
  };
}
