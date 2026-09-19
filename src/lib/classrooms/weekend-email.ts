import { minuteToTimeLabel } from "@/lib/room-capacity/dates";
import type { WeekendReport, WeekendNotificationKind } from "./weekend-readiness";
import type { OverflowAction, OverflowPlan } from "./overflow-types";

const escapeHtml = (value: string) => value.replaceAll("&", "&amp;").replaceAll("<", "&lt;")
  .replaceAll(">", "&gt;").replaceAll('"', "&quot;").replaceAll("'", "&#39;");

function historyLines(action: OverflowAction): string[] {
  const e = action.evidence;
  if (!e || e.tier === "unknown") return ["History: unknown; no verified attendance evidence available."];
  const counts = e.tier === "verified_switches"
    ? `${e.verifiedSwitches} verified onsite-to-online switches / ${e.observedOnsiteLessons} observed onsite opportunities`
    : `${e.onlineAttended} online / ${e.attendedLessons} attended lessons; ${e.tier === "onsite_only" ? "known onsite-only history" : "past online attendance"} is fallback evidence, not a confirmed switching rate`;
  const date = (value: string) => new Date(value).toLocaleDateString("en-GB", { timeZone: "Asia/Bangkok" });
  return [`History: ${counts}. Small-sample-adjusted frequency ${(e.adjustedFrequency * 100).toFixed(1)}%.`,
    `180-day lookback. Observed period: ${e.firstLessonAt && e.lastLessonAt ? `${date(e.firstLessonAt)}–${date(e.lastLessonAt)}` : "unknown"}.`];
}

function overflowLines(plan: OverflowPlan): string[] {
  const status = { minimum_proven: "Minimum proven", best_found: "Best found", no_complete_solution: "No complete solution", unverified: "Unverified" }[plan.status];
  const actions = [...new Map((plan.proposedSwitches ? plan.proposedActions : plan.actualActions).map(action => [action.wiseSessionId, action])).values()];
  const lines = ["", `Overflow: ${plan.baselineOverflow} initially; ${plan.actualRemainingOverflow} after actual-modality room changes; ${plan.predictedRemainingOverflow} after the conditional plan.`,
    `${status}. ${plan.proposedSwitches} proposed student lesson switch(es)${plan.minimumSwitches !== null ? `; minimum ${plan.minimumSwitches}` : "; minimum not proven"}${plan.switchLowerBound !== null ? `; lower bound ${plan.switchLowerBound}` : ""}.`,
    `Final plan: ${actions.filter(action => action.kind === "relocate_online").length} already-online relocation(s), ${actions.filter(action => action.kind === "move_room").length} other room move(s). Each affected lesson is counted once.`,
    "Accommodation is conditional on completing all listed actions. Student switches require agreement and fresh Wise confirmation; suggestions do not clear readiness warnings."];
  const labels = { switch_to_online: "PROPOSED STUDENT SWITCH", relocate_online: "ALREADY ONLINE — RELOCATE", move_room: "ROOM CHANGE", accommodate: "OVERFLOW LESSON ACCOMMODATED" };
  const room = (value: string) => value === "NO_ROOM_AVAILABLE" ? "No room assigned" : value === "REMOTE_NO_ROOM_NEEDED" ? "Teach elsewhere — classroom released" : value;
  for (const action of actions) {
    lines.push("", `${labels[action.kind]} | ${plan.assignmentDate} ${minuteToTimeLabel(action.startMinute)}–${minuteToTimeLabel(action.endMinute)} | ${action.student || "Class"} | ${action.tutor}`,
      `${room(action.originalRoom)} → ${action.teachingLocation === "elsewhere" ? "Teach elsewhere — classroom released" : room(action.room)}.`);
    if (action.released) lines.push("Vacate the onsite classroom for the full lesson, including when adjacent lessons are onsite.");
    if (action.kind === "switch_to_online") lines.push(...historyLines(action));
  }
  const accommodated = new Set(plan.accommodatedSessionIds);
  if (accommodated.size) lines.push("", "Overflow lessons accommodated if the plan is completed:",
    ...plan.predictedAssignments.filter(row => accommodated.has(row.wiseSessionId)).map(row => `${plan.assignmentDate} ${minuteToTimeLabel(row.startMinute)}–${minuteToTimeLabel(row.endMinute)} | ${row.student || "Class"} | ${row.tutor} → ${room(row.room)}`));
  lines.push(...plan.warnings.map(warning => `Review: ${warning}`));
  if (!plan.rankingComplete) lines.push("History ranking or room preferences are not fully verified.");
  lines.push(`Plan generated: ${plan.generatedAt}; source checked: ${plan.sourceCheckedAt ?? "unknown"}; history checked: ${plan.historyCheckedAt ?? "unknown"}.`);
  return lines;
}

export function buildWeekendEmail(report: WeekendReport, checkId: string, kind: WeekendNotificationKind) {
  const base = process.env.APP_BASE_URL?.trim() || "https://bgscheduler.vercel.app";
  const title = kind === "resolved" ? "RESOLVED: weekend classroom warnings cleared"
    : kind === "summary" ? "Wednesday weekend classroom allocation report"
    : report.readiness === "unverified" ? "ACTION REQUIRED: weekend classrooms could not be fully verified"
      : "ACTION REQUIRED: weekend classroom assignments need attention";
  const subject = `${title} — ${report.dates.join(" / ")}`;
  const lines = [title, `Weekend: ${report.dates.join(" and ")}`,
    `Checked: ${new Date(report.checkedAt).toLocaleString("en-GB", { timeZone: "Asia/Bangkok" })} Bangkok`, "",
    kind === "resolved" ? "A fresh check confirms that the previously reported weekend problems have cleared."
      : "Wednesday allocation results are listed below. Normal daily publishing remains separate. No student modality is changed by this report.", ""];
  if (kind === "summary") lines.push("No student switches are needed in this verified assessment.", "");
  for (const day of report.days) {
    const assessed = day.allocation !== "blocked" && day.allocation !== "failed" && !day.allocationError;
    lines.push(`${day.date}: ${day.liveSessions} live classes; ${assessed ? `${day.noRoomCount} classes without a safe room assignment` : "room capacity not verified"}.`);
    if (day.allocation) lines.push(`Allocation: ${day.allocation === "not_requested" ? "fresh preview; no allocation saved by this check" : day.allocation}${day.runId ? `; run ${day.runId}` : ""}${day.allocationCreatedAt ? `; saved ${day.allocationCreatedAt}` : ""}.`);
    if (day.allocationError) lines.push(`Allocation issue: ${day.allocationError}`);
    if (day.publication) lines.push(`Wise publication: ${day.publication.verified} room(s) confirmed by live read-back, ${day.publication.pending} pending, ${day.publication.failed} failed. Checked ${day.publication.checkedAt}.`);
    if (day.overflowPlan) lines.push(...overflowLines(day.overflowPlan));
    else if (assessed) lines.push("No additional student switches suggested for this date.");
    lines.push("");
  }
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
  lines.push("", `Scheduling snapshot: ${report.snapshotId ?? "unavailable"}; sync finished: ${report.snapshotFinishedAt ?? "unknown"}.`,
    "A report is sent every Wednesday. Thursday and Friday warnings repeat while action is needed; one resolved notice follows a verified recovery.");
  const text = lines.join("\n");
  const html = `<html><body style="font-family:Arial,sans-serif;color:#1e293b;max-width:760px;margin:24px auto;padding:16px"><h1 style="font-size:22px;color:${kind === "resolved" ? "#166534" : "#b91c1c"}">${escapeHtml(title)}</h1>${lines.slice(1).map(line => {
    const match = /^(\d{4}-\d{2}-\d{2}): (https?:\/\/.+)$/.exec(line);
    return match ? `<p><a href="${escapeHtml(match[2])}">Review ${escapeHtml(match[1])} assignments</a></p>`
      : `<p style="margin:8px 0;overflow-wrap:anywhere">${escapeHtml(line)}</p>`;
  }).join("")}</body></html>`;
  return { subject, text, html };
}
