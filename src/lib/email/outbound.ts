import { createResendSender } from "@/lib/email/resend";
import {
  ScheduleEmailRejection,
  type ScheduleEmailSender,
  type ScheduleEmailSenderKey,
  type ScheduleEmailSendInput,
} from "@/lib/classrooms/schedule-email";

/**
 * The relay setting that the remaining Apps Script callers (post-class feedback sender key, classroom backup-relay
 * config checks) still read. It does not pick the sender for `createOutboundEmailSender`, which is fixed per audience.
 */
export type OutboundEmailTransport = "apps_script" | "gmail" | "resend";
/**
 * Who reads the mail. `staff` and `candidate` always leave from the Workspace mailbox admin@begiftededucation.com;
 * `teacher` (the default) always leaves from Resend.
 */
export type OutboundEmailAudience = "staff" | "teacher" | "candidate";

export interface OutboundEmailEnvironment {
  readonly [name: string]: string | undefined;
}

export function outboundEmailTransport(env: OutboundEmailEnvironment = process.env): OutboundEmailTransport {
  const value = env.OUTBOUND_EMAIL_TRANSPORT?.trim().toLowerCase();
  return value === "gmail" || value === "resend" ? value : "apps_script";
}

/**
 * The Apps Script relay a sender key actually lands on. Under `gmail` or `resend` both
 * keys fall back to the primary relay, so configuration checks for a key must
 * look at that relay's env, not the key's own.
 */
export function outboundRelayKey(
  senderKey: ScheduleEmailSenderKey,
  env: OutboundEmailEnvironment = process.env,
): ScheduleEmailSenderKey {
  return outboundEmailTransport(env) === "apps_script" ? senderKey : "primary";
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
async function loadWorkspaceGmailSender(headers: { senderName: string; replyTo: string }): Promise<ScheduleEmailSender> {
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
    return createGmailSender((force) => feedbackGmailAccessToken(force), undefined, headers);
  } catch (error) {
    if (error instanceof ScheduleEmailRejection) throw error;
    throw new ScheduleEmailRejection("The Workspace Gmail sender could not be loaded.");
  }
}

/**
 * Staff and candidate mail always leave as admin@begiftededucation.com through Workspace Gmail, with no other
 * provider: a rejection fails the send rather than changing the sender (owner rule, 26 Nov 2026).
 * Tutor mail always uses the approved Resend identity with no other provider.
 */
export function createOutboundEmailSender(
  _senderKey: ScheduleEmailSenderKey = "primary",
  options: { strictOutcome?: boolean; audience?: OutboundEmailAudience } = {},
  env: OutboundEmailEnvironment = process.env,
): ScheduleEmailSender {
  const { audience = "teacher" } = options;
  if (audience === "teacher") {
    return createResendSender(env, { from: "BeGifted <no-reply@notify.begiftededucation.com>",
      replyTo: env.RESEND_REPLY_TO?.trim() || "admin@begiftededucation.com" });
  }
  return {
    async sendEmail(input) {
      const gmail = await loadWorkspaceGmailSender({ senderName: "BeGifted Education", replyTo: "admin@begiftededucation.com" });
      return gmail.sendEmail(gmailSafeInput(input));
    },
  };
}
