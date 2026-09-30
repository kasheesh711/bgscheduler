import { createHash } from "node:crypto";
import { createAppsScriptScheduleEmailSender, type ScheduleEmailSender } from "@/lib/classrooms/schedule-email";
import { wiseSessionLink } from "@/lib/wise/links";
import { AUTOWRITER_JUDGE_ERRORS_ALERT } from "./config";
import { rosterTutor } from "./roster";
import type { AlertKind, PendingAlert } from "./store";

const KIND_TEXT: Record<AlertKind, string> = {
  held: "Not written — the draft failed checks. Please write this feedback.",
  expired: "Not written before the deadline window. Please write this feedback now.",
  no_summary: "Wise has no AI summary 3 hours after class. The autowriter keeps trying; write it yourself if it stays blank.",
  no_recording: "Wise's recording, or its transcript, is still not ready 3 hours after class (second pass). The autowriter keeps trying until the deadline; write it yourself if you can.",
  judge_failing: `The draft could not be checked ${AUTOWRITER_JUDGE_ERRORS_ALERT} runs in a row (the judge model failed or could not be reached), so nothing has been posted. The autowriter keeps retrying every 10 minutes until the deadline; write it yourself if it stays blank.`,
  unknown_outcome: "The Wise POST outcome is unclear. Autowriter halted — check this class in Wise before resuming.",
  verify_failed: "The Wise POST did not verify. Autowriter halted — check this class in Wise before resuming.",
  rejected: "Wise rejected the POST. Autowriter halted — check this class before resuming.",
};

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
    return {
      text: `- ${tutor} · deadline ${bangkok(alert.deadlineAt)} (Bangkok) · ${KIND_TEXT[alert.kind]}${alert.reason ? ` [${alert.reason.slice(0, 200)}]` : ""}\n  ${link}`,
      html: `<li><b>${escapeHtml(tutor)}</b> · deadline ${escapeHtml(bangkok(alert.deadlineAt))} (Bangkok)<br>${escapeHtml(KIND_TEXT[alert.kind])}${alert.reason ? `<br><small>${escapeHtml(alert.reason.slice(0, 200))}</small>` : ""}<br><a href="${escapeHtml(link)}">${escapeHtml(link)}</a></li>`,
    };
  });
  const haltLine = halt.haltedAt ? `Autowriter is HALTED since ${bangkok(halt.haltedAt)}: ${halt.haltReason ?? ""}` : null;
  const subject = `Feedback autowriter: ${alerts.length} class${alerts.length === 1 ? "" : "es"} need${alerts.length === 1 ? "s" : ""} attention`;
  const text = [haltLine, ...lines.map((line) => line.text)].filter(Boolean).join("\n\n");
  const html = `${haltLine ? `<p><b>${escapeHtml(haltLine)}</b></p>` : ""}<ul>${lines.map((line) => line.html).join("")}</ul>`;
  const idempotencyKey = `feedback-autowriter:${createHash("sha256")
    .update(alerts.map((alert) => `${alert.id}:${alert.kind}`).toSorted().join("|")).digest("hex").slice(0, 32)}`;
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
  const sender = input.sender ?? createAppsScriptScheduleEmailSender("primary", { strictOutcome: true });
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
