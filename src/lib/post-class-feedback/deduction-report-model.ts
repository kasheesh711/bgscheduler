import { addBangkokDays, bangkokDateStartUtc, todayBangkok } from "@/lib/room-capacity/dates";

export const DEDUCTION_REPORT_RECIPIENTS = ["kevhsh7@gmail.com", "pakwalaan@gmail.com", "k.waritpariya@gmail.com"] as const;
export interface DeductionReportRow {
  sessionId: string; tutor: string; students: string; subject: string; classTime: string; deadline: string;
  reason: string; amountMinor: number; status: string; payout: string; screenshot: string;
}
export function previousReportDay(now: Date) {
  const date = addBangkokDays(todayBangkok(now), -1);
  return { date, start: bangkokDateStartUtc(date), end: bangkokDateStartUtc(addBangkokDays(date, 1)) };
}
export function reportDeliveryCanSend(status: string) { return status === "pending" || status === "failed"; }
const escapeHtml = (value: string) => value.replace(/[&<>"']/g, char => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[char]!);
const amount = (minor: number) => `THB ${(minor / 100).toFixed(2)}`;

export function buildDeductionReport(date: string, rows: DeductionReportRow[], limits: string[]) {
  const lines = [`New post-class feedback deductions — ${date}`, "Period: 00:00–24:00 Asia/Bangkok.",
    `New candidates: ${rows.length}. Pending candidates are not confirmed charges.`,
    ...(limits.length ? ["INCOMPLETE: " + limits.join("; ")] : []), ""];
  if (!rows.length) lines.push("No new deduction candidates were recorded for this period.");
  for (const [tutor, classes] of Map.groupBy(rows, row => row.tutor)) {
    lines.push(tutor);
    for (const [status, group] of Map.groupBy(classes, row => row.status)) lines.push(`${status}: ${group.length}, ${amount(group.reduce((sum, row) => sum + row.amountMinor, 0))}`);
    for (const row of classes) lines.push(
      `${row.students} — ${row.subject} — ${row.classTime}`,
      `Deadline: ${row.deadline}. Reason: ${row.reason}. Amount: ${amount(row.amountMinor)}. Status: ${row.status}.`,
      `Payout: ${row.payout}. Screenshot: ${row.screenshot}.`,
      `https://bgscheduler.vercel.app/post-class-feedback/evidence?sessionId=${encodeURIComponent(row.sessionId)}`, "",
    );
  }
  lines.push("Screenshots show the state at their recorded time. Missing evidence does not mean missing feedback.");
  const text = lines.join("\n");
  const html = `<div style="font-family:Arial,sans-serif;white-space:pre-wrap">${escapeHtml(text).replace(/https:\/\/bgscheduler\.vercel\.app\/post-class-feedback\/evidence\?sessionId=([A-Za-z0-9%-]+)/g, url => `<a href="${url}">Open class evidence</a>`)}</div>`;
  return { text, html, metadata: { date, rows, limits } };
}
