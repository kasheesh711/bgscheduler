import { createHash } from "node:crypto";
import { type ScheduleEmailSender } from "@/lib/classrooms/schedule-email";
import { createOutboundEmailSender } from "@/lib/email/outbound";
import { wiseSessionLink } from "@/lib/wise/links";
import { rosterTutor } from "./roster";
import type { AlertKind, JudgeUnreachedCause, PendingAlert } from "./store";

const KIND_TEXT: Record<Exclude<AlertKind, "judge_failing">, string> = {
  held: "Not written — the draft failed checks. Please write this feedback.",
  expired: "Not written before the deadline window. Please write this feedback now.",
  no_summary: "Wise has no AI summary 3 hours after class. The autowriter keeps trying; write it yourself if it stays blank.",
  no_recording: "Wise's recording, or its transcript, is still not ready 3 hours after class (second pass). The autowriter keeps trying until the deadline; write it yourself if you can.",
  unknown_outcome: "The Wise POST outcome is unclear. Autowriter halted — check this class in Wise before resuming.",
  verify_failed: "The Wise POST did not verify. Autowriter halted — check this class in Wise before resuming.",
  rejected: "Wise rejected the POST. Autowriter halted — check this class before resuming.",
};

/** What kept the judge from being asked, when it was not the judge model that failed. */
const JUDGE_UNREACHED_TEXT: Record<JudgeUnreachedCause, string> = {
  rate_limited: "OpenRouter rate limited the judge's route",
  out_of_time: "our own function ran out of time before the judge could start",
  account_or_connection: "our OpenRouter account or connection refused the call (no credit, a bad key or a network error)",
};

/**
 * `judge_failing`: the draft was written but could not be checked, run after run. The text says why, and blames the
 * judge model only for its own failures — never for a rate limit, our function's time, our account or our connection.
 */
function judgeFailingText(judge: PendingAlert["judge"]): string {
  const { errors = 0, unreached = 0, unreachedCause = null } = judge ?? {};
  const notAsked = unreachedCause ? JUDGE_UNREACHED_TEXT[unreachedCause] : "the judge could not be asked";
  let why = "its check did not finish";
  if (errors > 0 && unreached === 0) why = "the judge model failed: a time-out, no verdict, an answer from the wrong route or a provider error";
  else if (errors === 0 && unreached > 0) why = `not a failure of the judge model: ${notAsked}`;
  else if (errors > 0) why = `failures of the judge model: ${errors}; not its failure: ${unreached} — the last time, ${notAsked}`;
  const runs = errors + unreached;
  return `The draft could not be checked ${runs > 0 ? runs : "several"} runs in a row (${why}), so nothing has been posted. The autowriter keeps retrying every 10 minutes until the deadline; write it yourself if it stays blank.`;
}

function kindText(alert: PendingAlert): string {
  return alert.kind === "judge_failing" ? judgeFailingText(alert.judge) : KIND_TEXT[alert.kind];
}

function bangkok(date: Date | null): string {
  if (!date) return "unknown";
  return new Intl.DateTimeFormat("en-GB", {
    timeZone: "Asia/Bangkok", day: "2-digit", month: "short", hour: "2-digit", minute: "2-digit",
  }).format(date);
}

function escapeHtml(value: string): string {
  return value.replace(/[&<>"']/gu, (char) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[char] ?? char);
}

export function buildAlertDigest(alerts: readonly PendingAlert[], halt: { haltedAt: Date | null; haltReason: string | null }) {
  const lines = alerts.map((alert) => {
    const tutor = rosterTutor(alert.wiseTeacherUserId)?.displayName ?? alert.wiseTeacherUserId ?? "unknown tutor";
    const link = alert.wiseClassId ? wiseSessionLink({ wiseClassId: alert.wiseClassId, wiseSessionId: alert.wiseSessionId }) : alert.wiseSessionId;
    const kind = kindText(alert);
    return {
      text: `- ${tutor} · deadline ${bangkok(alert.deadlineAt)} (Bangkok) · ${kind}${alert.reason ? ` [${alert.reason.slice(0, 200)}]` : ""}\n  ${link}`,
      html: `<li><b>${escapeHtml(tutor)}</b> · deadline ${escapeHtml(bangkok(alert.deadlineAt))} (Bangkok)<br>${escapeHtml(kind)}${alert.reason ? `<br><small>${escapeHtml(alert.reason.slice(0, 200))}</small>` : ""}<br><a href="${escapeHtml(link)}">${escapeHtml(link)}</a></li>`,
    };
  });
  const haltLine = halt.haltedAt ? `Autowriter is HALTED since ${bangkok(halt.haltedAt)}: ${halt.haltReason ?? ""}` : null;
  const subject = `Feedback autowriter: ${alerts.length} class${alerts.length === 1 ? "" : "es"} need${alerts.length === 1 ? "s" : ""} attention`;
  const text = [haltLine, ...lines.map((line) => line.text)].filter(Boolean).join("\n\n");
  const html = `${haltLine ? `<p><b>${escapeHtml(haltLine)}</b></p>` : ""}<ul>${lines.map((line) => line.html).join("")}</ul>`;
  // One key per set of alerts: the relay sends a digest it has already sent only once. A `judge_failing` alert can be
  // raised again on the same class (a new run of failures after the judge answered), so its key carries the time that
  // run reached its mark: a second episode is another digest, not a repeat of the first.
  const idempotencyKey = `feedback-autowriter:${createHash("sha256")
    .update(alerts.map((alert) => `${alert.id}:${alert.kind}${alert.kind === "judge_failing" && alert.judge?.since ? `:${alert.judge.since}` : ""}`)
      .toSorted().join("|")).digest("hex").slice(0, 32)}`;
  return { subject, text, html, idempotencyKey };
}

/**
 * One digest per sweep. Returns true only when every recipient's relay
 * accepted it; the caller marks alerts sent only then (strict outcome).
 */
export async function sendAlertDigest(input: {
  alerts: readonly PendingAlert[];
  recipients: readonly string[];
  halt: { haltedAt: Date | null; haltReason: string | null };
  sender?: ScheduleEmailSender;
}): Promise<{ sent: boolean; error: string | null }> {
  if (input.alerts.length === 0) return { sent: false, error: null };
  if (input.recipients.length === 0) return { sent: false, error: "FEEDBACK_AUTOWRITER_ALERT_EMAILS is empty" };
  const sender = input.sender ?? createOutboundEmailSender("primary", { strictOutcome: true, audience: "staff" },
    { ...process.env, OUTBOUND_EMAIL_TRANSPORT: process.env.OUTBOUND_EMAIL_TRANSPORT?.trim() || "resend" });
  const digest = buildAlertDigest(input.alerts, input.halt);
  try {
    for (const to of input.recipients) {
      await sender.sendEmail({ to, subject: digest.subject, html: digest.html, text: digest.text, idempotencyKey: `${digest.idempotencyKey}:${to}` });
    }
    return { sent: true, error: null };
  } catch (error) {
    return { sent: false, error: error instanceof Error ? error.message.slice(0, 200) : "email relay failed" };
  }
}
