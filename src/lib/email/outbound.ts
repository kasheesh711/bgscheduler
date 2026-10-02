import {
  createAppsScriptScheduleEmailSender,
  ScheduleEmailRejection,
  type ScheduleEmailSender,
  type ScheduleEmailSenderKey,
  type ScheduleEmailSendInput,
} from "@/lib/classrooms/schedule-email";

/**
 * Which transport carries BGScheduler's outbound email.
 *
 * - `apps_script` (default): the Apps Script MailApp relay. It runs on a
 *   consumer Gmail account with a ~100 recipients/day quota, shared with every
 *   other script on that account.
 * - `gmail`: the Gmail API as the Workspace mailbox admin@begiftededucation.com
 *   (~2,000/day), using the grant the nightly feedback reminders already use.
 *   App mail and the reminders share that mailbox's daily quota.
 *
 * Read whenever a caller builds its sender (every job run), so setting
 * `OUTBOUND_EMAIL_TRANSPORT` to anything other than `gmail` is the kill switch.
 */
export type OutboundEmailTransport = "apps_script" | "gmail";

export interface OutboundEmailEnvironment {
  readonly [name: string]: string | undefined;
}

export function outboundEmailTransport(env: OutboundEmailEnvironment = process.env): OutboundEmailTransport {
  return env.OUTBOUND_EMAIL_TRANSPORT?.trim().toLowerCase() === "gmail" ? "gmail" : "apps_script";
}

/**
 * The Apps Script relay a sender key actually lands on. Under `gmail` both
 * keys fall back to the primary relay, so configuration checks for a key must
 * look at that relay's env, not the key's own.
 */
export function outboundRelayKey(
  senderKey: ScheduleEmailSenderKey,
  env: OutboundEmailEnvironment = process.env,
): ScheduleEmailSenderKey {
  return outboundEmailTransport(env) === "gmail" ? "primary" : senderKey;
}

/** Gmail permanently rejects CR/LF in a subject; the relay never did. */
function gmailSafeInput(input: ScheduleEmailSendInput): ScheduleEmailSendInput {
  return { ...input, to: input.to.trim(), subject: input.subject.replace(/\s+/g, " ").trim() };
}

/**
 * Lazily build the Workspace Gmail sender. The dynamic imports break the
 * module-evaluation cycle schedule-email → outbound → gmail → schedule-email
 * (GmailRejection extends ScheduleEmailRejection at load time) and keep the
 * pg/OAuth credential stack out of callers that never take this path.
 * Throws a ScheduleEmailRejection when Gmail cannot be used at all.
 */
async function loadWorkspaceGmailSender(env: OutboundEmailEnvironment): Promise<ScheduleEmailSender> {
  try {
    const [{ createGmailSender }, { feedbackGmailAccessToken }, { feedbackEmailConfiguration }] = await Promise.all([
      import("@/lib/post-class-feedback/gmail"),
      import("@/lib/post-class-feedback/gmail-credentials"),
      import("@/lib/post-class-feedback/gmail-connection"),
    ]);
    const config = feedbackEmailConfiguration();
    if (!config.available || !config.configured || !config.trusted) {
      throw new ScheduleEmailRejection("The Workspace Gmail sender is not available in this environment.");
    }
    return createGmailSender((force) => feedbackGmailAccessToken(force), undefined, {
      senderName: env.SCHEDULE_EMAIL_SENDER_NAME?.trim() || "BeGifted",
      replyTo: env.SCHEDULE_EMAIL_REPLY_TO?.trim() || "kevhsh7@gmail.com",
    });
  } catch (error) {
    if (error instanceof ScheduleEmailRejection) throw error;
    throw new ScheduleEmailRejection("The Workspace Gmail sender could not be loaded.");
  }
}

/**
 * Gmail first; any rejection known to precede acceptance (unconfigured or
 * preview environment, reconnect needed, token renewal down, daily limit)
 * retries once through the Apps Script primary relay with the same input and
 * idempotency key. An uncertain Gmail outcome is rethrown, never resent.
 */
function createWorkspaceGmailSender(
  env: OutboundEmailEnvironment,
  relay: ScheduleEmailSender,
): ScheduleEmailSender {
  return {
    async sendEmail(input) {
      try {
        const gmail = await loadWorkspaceGmailSender(env);
        return await gmail.sendEmail(gmailSafeInput(input));
      } catch (error) {
        if (!(error instanceof ScheduleEmailRejection)) throw error;
        // Log only the rejection message: provider errors are pre-acceptance
        // and carry no message content.
        console.error(`Gmail rejected outbound email before acceptance; using the Apps Script relay: ${error.message}`);
        return relay.sendEmail(input);
      }
    },
  };
}

/**
 * The one factory every outbound email path should use instead of
 * `createAppsScriptScheduleEmailSender`.
 *
 * Under `gmail`, `primary` is the Workspace mailbox with a per-message relay
 * fallback, and `backup` is the Apps Script primary relay, so the existing
 * failover paths (tutor schedule quota failover, post-class retry attempts)
 * keep working. Gmail's own outcomes are strict: pre-acceptance failures throw
 * `ScheduleEmailRejection`, uncertain outcomes a plain `Error`.
 */
export function createOutboundEmailSender(
  senderKey: ScheduleEmailSenderKey = "primary",
  options: { strictOutcome?: boolean } = {},
  env: OutboundEmailEnvironment = process.env,
): ScheduleEmailSender {
  const relay = createAppsScriptScheduleEmailSender(outboundRelayKey(senderKey, env), options);
  if (outboundEmailTransport(env) !== "gmail" || senderKey === "backup") return relay;
  return createWorkspaceGmailSender(env, relay);
}
