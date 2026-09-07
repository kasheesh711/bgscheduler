import { minuteToTimeLabel } from "@/lib/room-capacity/dates";
import type { WeekendReport } from "./weekend-readiness";

const escapeHtml = (value: string) => value.replaceAll("&", "&amp;").replaceAll("<", "&lt;")
  .replaceAll(">", "&gt;").replaceAll('"', "&quot;").replaceAll("'", "&#39;");

export function buildWeekendEmail(report: WeekendReport, checkId: string, kind: "warning" | "resolved") {
  const base = process.env.APP_BASE_URL?.trim() || "https://bgscheduler.vercel.app";
  const title = kind === "resolved" ? "RESOLVED: weekend classroom warnings cleared"
    : report.readiness === "unverified" ? "ACTION REQUIRED: weekend classrooms could not be fully verified"
      : "ACTION REQUIRED: weekend classroom assignments need attention";
  const subject = `${title} — ${report.dates.join(" / ")}`;
  const lines = [title, `Weekend: ${report.dates.join(" and ")}`,
    `Checked: ${new Date(report.checkedAt).toLocaleString("en-GB", { timeZone: "Asia/Bangkok" })} Bangkok`, "",
    kind === "resolved" ? "A fresh check confirms that the previously reported weekend problems have cleared."
      : "Please resolve the findings below before the weekend. This check does not change bookings.", ""];
  for (const day of report.days) lines.push(`${day.date}: ${day.liveSessions} live classes; ${day.noRoomCount} classes without a safe room assignment.`);
  for (const finding of report.findings) {
    const time = finding.startMinute === undefined ? "" : ` ${minuteToTimeLabel(finding.startMinute)}–${minuteToTimeLabel(finding.endMinute ?? finding.startMinute)}`;
    const requirements = finding.requiredCapacity === undefined ? "" : ` Needs ${finding.requiredCapacity} seat(s)${finding.needsTv ? " and a TV" : ""}.`;
    lines.push(`${finding.date}${time} | ${finding.tutor || "Teacher requires verification"}${finding.className ? ` | ${finding.className}` : ""}`,
      `${finding.message}${requirements}${finding.wiseSessionId ? ` Session: ${finding.wiseSessionId}.` : ""}`);
  }
  lines.push("", "Review assignments:");
  for (const date of report.dates) {
    const url = new URL("/class-assignments", base);
    url.searchParams.set("date", date);
    url.searchParams.set("weekendCheck", checkId);
    lines.push(`${date}: ${url.toString()}`);
  }
  lines.push("", "Warnings repeat Wednesday, Thursday and Friday while action is needed. One resolved notice follows a verified recovery.");
  const text = lines.join("\n");
  const html = `<html><body style="font-family:Arial,sans-serif;color:#1e293b;max-width:760px;margin:24px auto;padding:16px"><h1 style="font-size:22px;color:${kind === "resolved" ? "#166534" : "#b91c1c"}">${escapeHtml(title)}</h1>${lines.slice(1).map(line => {
    const match = /^(\d{4}-\d{2}-\d{2}): (https?:\/\/.+)$/.exec(line);
    return match ? `<p><a href="${escapeHtml(match[2])}">Review ${escapeHtml(match[1])} assignments</a></p>`
      : `<p style="margin:8px 0;overflow-wrap:anywhere">${escapeHtml(line)}</p>`;
  }).join("")}</body></html>`;
  return { subject, text, html };
}
