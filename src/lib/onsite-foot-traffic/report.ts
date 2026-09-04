import "server-only";

import { readFileSync } from "node:fs";
import { join } from "node:path";

import { formatFootTrafficDate } from "./dates";
import type {
  FootTrafficBreakdownRow,
  FootTrafficDashboardPayload,
  FootTrafficPeriodRow,
  FootTrafficReportSnapshot,
} from "./types";

const REPORT_ASSET_PATHS = {
  logo: join(process.cwd(), "public/brand/logo-horizontal.png"),
  sarabun400: join(
    process.cwd(),
    "node_modules/@fontsource/sarabun/files/sarabun-latin-400-normal.woff2",
  ),
  sarabun600: join(
    process.cwd(),
    "node_modules/@fontsource/sarabun/files/sarabun-latin-600-normal.woff2",
  ),
  sarabunThai400: join(
    process.cwd(),
    "node_modules/@fontsource/sarabun/files/sarabun-thai-400-normal.woff2",
  ),
  cormorant600: join(
    process.cwd(),
    "node_modules/@fontsource/cormorant-garamond/files/cormorant-garamond-latin-600-normal.woff2",
  ),
} as const;

function embeddedFile(path: string, mimeType: string): string {
  return `data:${mimeType};base64,${readFileSync(path).toString("base64")}`;
}

function esc(value: unknown): string {
  return String(value ?? "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#039;");
}

function number(value: number, digits = 0): string {
  return new Intl.NumberFormat("en-US", {
    minimumFractionDigits: digits,
    maximumFractionDigits: digits,
  }).format(value);
}

function percent(part: number, whole: number): string {
  return whole > 0 ? `${number((part / whole) * 100, 1)}%` : "0.0%";
}

function lineChart(rows: FootTrafficPeriodRow[]): string {
  if (rows.length === 0) return '<div class="empty-chart">No weekly observations in this snapshot.</div>';
  const width = 730;
  const height = 260;
  const left = 42;
  const right = 20;
  const top = 26;
  const bottom = 46;
  const chartWidth = width - left - right;
  const chartHeight = height - top - bottom;
  const max = Math.max(1, ...rows.map((row) => row.studentVisits));
  const x = (index: number) => left + (rows.length === 1 ? chartWidth / 2 : index * chartWidth / (rows.length - 1));
  const y = (value: number) => top + chartHeight - value / max * chartHeight;
  const points = rows.map((row, index) => `${x(index)},${y(row.studentVisits)}`).join(" ");
  const peak = rows.reduce((best, row, index) =>
    row.studentVisits > best.row.studentVisits ? { row, index } : best,
  { row: rows[0], index: 0 });
  const grid = [0, .25, .5, .75, 1].map((ratio) => {
    const gridY = top + chartHeight - ratio * chartHeight;
    return `<line x1="${left}" y1="${gridY}" x2="${width - right}" y2="${gridY}" class="grid"/>
      <text x="${left - 8}" y="${gridY + 4}" text-anchor="end" class="axis">${Math.round(max * ratio)}</text>`;
  }).join("");
  const ticks = rows.map((row, index) => {
    if (index % Math.max(1, Math.ceil(rows.length / 8)) !== 0 && index !== rows.length - 1) return "";
    return `<text x="${x(index)}" y="${height - 16}" text-anchor="middle" class="axis">${esc(row.periodStart.slice(5))}</text>`;
  }).join("");
  return `<svg viewBox="0 0 ${width} ${height}" role="img" aria-label="Weekly student visits from ${esc(rows[0].periodStart)} through ${esc(rows.at(-1)?.periodEnd)}">
    ${grid}
    <polyline points="${points}" fill="none" stroke="#126DCE" stroke-width="3" stroke-linejoin="round" stroke-linecap="round"/>
    ${rows.map((row, index) => `<circle cx="${x(index)}" cy="${y(row.studentVisits)}" r="3.5" fill="#126DCE"><title>${esc(row.label)}: ${row.studentVisits} visits</title></circle>`).join("")}
    <circle cx="${x(peak.index)}" cy="${y(peak.row.studentVisits)}" r="6" fill="#FF7518" stroke="#fff" stroke-width="2"/>
    <text x="${x(peak.index)}" y="${Math.max(14, y(peak.row.studentVisits) - 11)}" text-anchor="middle" class="mark-label">${peak.row.studentVisits}</text>
    ${ticks}
  </svg>`;
}

function verticalBars(rows: FootTrafficPeriodRow[]): string {
  if (rows.length === 0) return '<div class="empty-chart">No monthly observations in this snapshot.</div>';
  const width = 730;
  const height = 270;
  const left = 40;
  const right = 18;
  const top = 22;
  const bottom = 48;
  const chartHeight = height - top - bottom;
  const chartWidth = width - left - right;
  const gap = 14;
  const barWidth = Math.max(18, (chartWidth - gap * (rows.length + 1)) / rows.length);
  const max = Math.max(1, ...rows.map((row) => row.studentVisits));
  return `<svg viewBox="0 0 ${width} ${height}" role="img" aria-label="Monthly student visits, with every bar directly labelled">
    <line x1="${left}" y1="${top + chartHeight}" x2="${width - right}" y2="${top + chartHeight}" class="grid strong"/>
    ${rows.map((row, index) => {
      const barHeight = row.studentVisits / max * chartHeight;
      const x = left + gap + index * (barWidth + gap);
      const y = top + chartHeight - barHeight;
      return `<rect x="${x}" y="${y}" width="${barWidth}" height="${barHeight}" rx="3" fill="#FF7518"/>
        <text x="${x + barWidth / 2}" y="${Math.max(14, y - 7)}" text-anchor="middle" class="mark-label">${row.studentVisits}</text>
        <text x="${x + barWidth / 2}" y="${height - 17}" text-anchor="middle" class="axis">${esc(row.label.replace(/ 2026$/, ""))}${row.isPartial ? "*" : ""}</text>`;
    }).join("")}
  </svg>`;
}

function horizontalBars(rows: FootTrafficBreakdownRow[], label: string, limit = 12): string {
  const visible = rows.slice(0, limit);
  if (visible.length === 0) return `<div class="empty-chart">No ${esc(label.toLowerCase())} observations in this snapshot.</div>`;
  const width = 730;
  const labelWidth = 142;
  const chartWidth = width - labelWidth - 64;
  const rowHeight = 29;
  const height = visible.length * rowHeight + 18;
  const max = Math.max(1, ...visible.map((row) => row.studentVisits));
  return `<svg viewBox="0 0 ${width} ${height}" role="img" aria-label="${esc(label)} student visits, directly labelled">
    ${visible.map((row, index) => {
      const y = index * rowHeight + 4;
      const barWidth = row.studentVisits / max * chartWidth;
      return `<text x="${labelWidth - 10}" y="${y + 16}" text-anchor="end" class="bar-label">${esc(row.label)}</text>
        <rect x="${labelWidth}" y="${y}" width="${Math.max(1, barWidth)}" height="20" rx="3" fill="#126DCE" opacity=".92"/>
        <circle cx="${labelWidth + barWidth}" cy="${y + 10}" r="5" fill="#FF7518"/>
        <text x="${Math.min(width - 4, labelWidth + barWidth + 11)}" y="${y + 15}" class="mark-label">${row.studentVisits}</text>`;
    }).join("")}
  </svg>`;
}

function periodTable(rows: FootTrafficPeriodRow[]): string {
  return `<table><thead><tr><th>Period</th><th>Start</th><th>End</th><th class="num">Visits</th><th class="num">Unique</th><th class="num">Classes</th><th class="num">Visits/class</th></tr></thead><tbody>${rows.map((row) =>
    `<tr><td>${esc(row.label)}${row.isPartial ? ' <span class="partial">Partial</span>' : ""}</td><td>${esc(row.periodStart)}</td><td>${esc(row.periodEnd)}</td><td class="num">${number(row.studentVisits)}</td><td class="num">${number(row.uniqueStudents)}</td><td class="num">${number(row.onsiteClasses)}</td><td class="num">${number(row.averageVisitsPerClass, 2)}</td></tr>`,
  ).join("")}</tbody></table>`;
}

function breakdownTable(rows: FootTrafficBreakdownRow[], label: string): string {
  return `<table><thead><tr><th>${esc(label)}</th><th class="num">Visits</th><th class="num">Unique</th><th class="num">Classes</th><th class="num">Visits/class</th></tr></thead><tbody>${rows.map((row) =>
    `<tr><td>${esc(row.label)}</td><td class="num">${number(row.studentVisits)}</td><td class="num">${number(row.uniqueStudents)}</td><td class="num">${number(row.onsiteClasses)}</td><td class="num">${number(row.averageVisitsPerClass, 2)}</td></tr>`,
  ).join("")}</tbody></table>`;
}

function executiveNarrative(payload: FootTrafficDashboardPayload): string {
  if (payload.summary.studentVisits === 0) {
    return "No qualifying attended onsite visits were found for the effective date range and filters. Review source coverage and the data-quality section before interpreting this as zero physical traffic.";
  }
  const peakMonth = payload.monthly.reduce((best, row) => row.studentVisits > best.studentVisits ? row : best);
  const busiestRoom = payload.byRoom[0];
  const roomClause = busiestRoom
    ? ` ${busiestRoom.label} accounted for ${number(busiestRoom.studentVisits)} visits (${percent(busiestRoom.studentVisits, payload.summary.studentVisits)} of the filtered total).`
    : "";
  return `${number(payload.summary.studentVisits)} student-visits were recorded across ${number(payload.summary.onsiteClasses)} qualifying onsite classes, representing ${number(payload.summary.uniqueStudents)} pseudonymous students. ${peakMonth.label}${peakMonth.isPartial ? " (partial)" : ""} was the highest-volume month at ${number(peakMonth.studentVisits)} visits.${roomClause}`;
}

function qualityRows(payload: FootTrafficDashboardPayload): Array<[string, number]> {
  const q = payload.dataQuality;
  return [
    ["Cancelled sessions", q.cancelledSessions],
    ["Missed / no-show sessions", q.missedSessions],
    ["Sessions not ended", q.notEndedSessions],
    ["Non-onsite sessions", q.nonOnsiteSessions],
    ["Missing location", q.missingLocationSessions],
    ["Unknown room", q.unknownRoomSessions],
    ["Online-only room", q.onlineOnlyRoomSessions],
    ["Sessions without positive-credit attendance", q.sessionsWithoutAttendanceEvidence],
    ["Participants without positive-credit evidence", q.participantsWithoutAttendanceEvidence],
    ["Visits without stable student IDs", q.unidentifiedVisits],
  ];
}

function qualityTable(payload: FootTrafficDashboardPayload): string {
  return `<table><thead><tr><th>Quality signal</th><th class="num">Count</th></tr></thead><tbody>${qualityRows(payload).map(([label, count]) =>
    `<tr><td>${esc(label)}</td><td class="num">${number(count)}</td></tr>`,
  ).join("")}</tbody></table>`;
}

export function footTrafficReportFilename(snapshot: FootTrafficReportSnapshot, extension: "html" | "pdf"): string {
  return `begifted-foot-traffic-${snapshot.payload.meta.effectiveStartDate}-to-${snapshot.payload.meta.effectiveEndDate}.${extension}`;
}

export function renderFootTrafficReportHtml(snapshot: FootTrafficReportSnapshot): string {
  const payload = snapshot.payload;
  const logo = embeddedFile(REPORT_ASSET_PATHS.logo, "image/png");
  const sarabun400 = embeddedFile(REPORT_ASSET_PATHS.sarabun400, "font/woff2");
  const sarabun600 = embeddedFile(REPORT_ASSET_PATHS.sarabun600, "font/woff2");
  const sarabunThai400 = embeddedFile(REPORT_ASSET_PATHS.sarabunThai400, "font/woff2");
  const cormorant600 = embeddedFile(REPORT_ASSET_PATHS.cormorant600, "font/woff2");
  const generated = new Intl.DateTimeFormat("en-GB", {
    timeZone: "Asia/Bangkok",
    dateStyle: "medium",
    timeStyle: "short",
  }).format(new Date(snapshot.createdAt));
  const period = `${formatFootTrafficDate(payload.meta.effectiveStartDate)} – ${formatFootTrafficDate(payload.meta.effectiveEndDate)}`;
  const monthTitle = payload.meta.isSeptemberMonthToDate ? "Monthly trend · September MTD" : "Monthly trend";
  const selectedFilters = [
    payload.meta.rooms.length ? `Rooms: ${payload.meta.rooms.join(", ")}` : "All physical classrooms",
    payload.meta.weekdays.length ? `Weekdays: ${payload.meta.weekdays.join(", ")}` : "All weekdays",
  ].join(" · ");

  return `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>BeGifted Onsite Foot Traffic · ${esc(period)}</title>
<style>
@font-face{font-family:Sarabun;src:url('${sarabun400}') format('woff2');font-weight:400;font-style:normal;font-display:block}
@font-face{font-family:Sarabun;src:url('${sarabun600}') format('woff2');font-weight:600;font-style:normal;font-display:block}
@font-face{font-family:Sarabun;src:url('${sarabunThai400}') format('woff2');font-weight:400;font-style:normal;font-display:block;unicode-range:U+0E00-0E7F}
@font-face{font-family:CormorantGaramond;src:url('${cormorant600}') format('woff2');font-weight:600;font-style:normal;font-display:block}
:root{--orange:#FF7518;--blue:#126DCE;--ink:#16203A;--muted:#63708B;--cream:#FFF9F2;--line:#DDE4EE;--pale-blue:#EEF6FF}
*{box-sizing:border-box}html{font-family:Sarabun,Arial,sans-serif;color:var(--ink);font-variant-numeric:tabular-nums}body{margin:0;background:#fff;font-size:10.5pt;line-height:1.48}
@page{size:A4 portrait;margin:14mm 13mm 15mm}header{display:flex;justify-content:space-between;align-items:flex-start;border-bottom:2px solid var(--orange);padding-bottom:8mm;margin-bottom:7mm}header img{width:39mm;height:auto}header .meta{text-align:right;color:var(--muted);font-size:8.5pt}
h1,h2,h3{font-family:CormorantGaramond,Georgia,serif;color:var(--ink);margin:0;line-height:1.05}h1{font-size:32pt;margin-top:4mm}h2{font-size:23pt;margin:10mm 0 2mm;border-left:4px solid var(--orange);padding-left:3mm}h3{font-size:16pt;margin:5mm 0 1.5mm}.eyebrow{color:var(--blue);font-weight:600;text-transform:uppercase;letter-spacing:.12em;font-size:8pt}.lead{font-size:12pt;line-height:1.55;max-width:170mm;margin:2mm 0 5mm}.scope{background:var(--cream);border:1px solid #F6DCC8;border-radius:7px;padding:3mm 4mm;color:#4D5569;font-size:9pt}
.kpis{display:grid;grid-template-columns:repeat(4,1fr);gap:3mm;margin:5mm 0 3mm}.kpi{border-top:3px solid var(--blue);background:var(--pale-blue);padding:4mm;border-radius:4px;min-height:25mm}.kpi.primary{border-color:var(--orange);background:var(--cream)}.kpi b{display:block;font-size:23pt;line-height:1;font-weight:600;color:var(--ink)}.kpi span{display:block;color:var(--muted);font-size:8.5pt;margin-top:2mm}
.note{border-left:3px solid var(--blue);padding:2mm 3mm;background:var(--pale-blue);margin:3mm 0;color:#42506B}.warning{border-color:var(--orange);background:var(--cream)}.chart{break-inside:avoid;margin:3mm 0 4mm}.chart svg{width:100%;height:auto;display:block}.grid{stroke:#DDE4EE;stroke-width:1}.grid.strong{stroke:#AEB9CA}.axis{font:9px Sarabun,Arial;fill:#63708B}.bar-label{font:11px Sarabun,Arial;fill:#16203A}.mark-label{font:600 10px Sarabun,Arial;fill:#FF7518}.empty-chart{border:1px dashed var(--line);padding:12mm;text-align:center;color:var(--muted)}figcaption{font-size:8.5pt;color:var(--muted);margin-top:1mm}
table{width:100%;border-collapse:collapse;margin:3mm 0 7mm;font-size:8.3pt;break-inside:auto}thead{display:table-header-group}tr{break-inside:avoid}th{background:var(--ink);color:#fff;text-align:left;font-weight:600;padding:2mm}td{padding:1.7mm 2mm;border-bottom:1px solid var(--line)}tbody tr:nth-child(even){background:#F8FAFD}.num{text-align:right}.partial{display:inline-block;background:#FFE4D0;color:#9D3F00;border-radius:10px;padding:0 1.5mm;font-size:7pt;text-transform:uppercase;letter-spacing:.05em}
.two-col{display:grid;grid-template-columns:1fr 1fr;gap:5mm;align-items:start}.method{background:#F7F9FC;border:1px solid var(--line);padding:4mm;border-radius:6px}.method ul{margin:2mm 0 0;padding-left:5mm}.method li{margin:1.2mm 0}.source{font-size:8pt;color:var(--muted);border-top:1px solid var(--line);padding-top:3mm;margin-top:8mm}.page-break{break-before:page}.keep{break-inside:avoid}
@media(max-width:720px){body{padding:16px}.kpis,.two-col{grid-template-columns:1fr 1fr}header{display:block}header .meta{text-align:left;margin-top:12px}h1{font-size:28pt}}
@media print{body{padding:0}.page-break{break-before:page}}
</style></head><body>
<header><img src="${logo}" alt="BeGifted logo"><div class="meta"><strong>INTERNAL · DE-IDENTIFIED</strong><br>Generated ${esc(generated)}<br>Snapshot ${esc(snapshot.id)}</div></header>
<main>
<div class="eyebrow">Onsite analytics pack · ${esc(period)}</div><h1>Onsite Foot Traffic</h1>
<h2>Executive Summary</h2><p class="lead">${esc(executiveNarrative(payload))}</p>
<div class="scope">${esc(selectedFilters)} · Bangkok time · Source coverage through ${esc(payload.meta.dataAsOf ?? "not yet available")}${payload.meta.isEndDateCapped ? " · Requested end date capped to available actuals" : ""}</div>
<section class="kpis"><div class="kpi primary"><b>${number(payload.summary.studentVisits)}</b><span>Student-visits</span></div><div class="kpi"><b>${number(payload.summary.uniqueStudents)}</b><span>Unique students</span></div><div class="kpi"><b>${number(payload.summary.onsiteClasses)}</b><span>Onsite classes</span></div><div class="kpi"><b>${number(payload.summary.averageVisitsPerClass, 2)}</b><span>Average visits / class</span></div></section>
<p class="note warning"><strong>Interpretation:</strong> this is a class-attendance proxy for foot traffic, not a physical door-counter measurement. A visit requires an ended onsite session, an active physical classroom, a non-teacher participant, and positive consumed credit.</p>

<section><h2>Weekly trend</h2><p>Monday–Sunday totals show the cadence and week-to-week variation. Orange identifies the highest observed week; partial boundary weeks are marked in the exact table.</p><figure class="chart">${lineChart(payload.weekly)}<figcaption>Weekly student-visits. Hover titles are preserved in HTML; the peak value is directly labelled for print.</figcaption></figure>${periodTable(payload.weekly)}</section>

<section class="page-break"><h2>${esc(monthTitle)}</h2><p>Monthly totals make the March–September research comparison explicit. An asterisk marks a partial month caused by the selected range or source coverage.</p><figure class="chart">${verticalBars(payload.monthly)}<figcaption>Monthly student-visits, directly labelled. * Partial period.</figcaption></figure>${periodTable(payload.monthly)}</section>

<section><h2>Visit patterns</h2><p>The weekday and room views use the same filtered visits and class denominator as the headline KPIs. Room concentration can guide staffing and qualitative follow-up, but does not by itself establish causality.</p><h3>By weekday</h3><figure class="chart">${horizontalBars(payload.byWeekday, "Weekday", 7)}<figcaption>Student-visits by Bangkok weekday, with exact values shown at each mark.</figcaption></figure>${breakdownTable(payload.byWeekday, "Weekday")}
<h3>By room</h3><figure class="chart">${horizontalBars(payload.byRoom, "Room", 12)}<figcaption>Top rooms by student-visits; the complete ranked table follows.</figcaption></figure>${breakdownTable(payload.byRoom, "Room")}</section>

<section class="page-break"><h2>Methodology and data quality</h2><div class="two-col"><div class="method"><h3>Counting method</h3><ul><li>One student with positive consumed credit in one qualifying onsite class equals one student-visit.</li><li>A class counts only when it has at least one qualifying visit.</li><li>Unique students use an HMAC fingerprint of the Wise student ID. Raw IDs and student/class names are never stored in this dataset or report.</li><li>Weeks run Monday–Sunday and all boundaries use Asia/Bangkok.</li><li>Scheduled seats, future sessions, online classes, cancellations, missed sessions and attendance without positive credit are excluded.</li></ul></div><div class="method"><h3>Source health</h3><p><strong>Source:</strong> ${esc(payload.meta.source)}</p><p><strong>Coverage:</strong> ${esc(payload.meta.coverageStartDate ?? "none")} to ${esc(payload.meta.coverageEndDate ?? "none")}</p><p><strong>Last successful sync:</strong> ${esc(payload.meta.lastSuccessfulSyncAt ?? "not available")}</p><p><strong>Counted:</strong> ${number(payload.dataQuality.countedOnsiteSessions)} of ${number(payload.dataQuality.totalPastSessions)} PAST-session rows in the filtered scope.</p></div></div>
${qualityTable(payload)}
<div class="keep"><h3>Recommended next steps</h3><ol><li>Use the visit-level CSV to reconcile representative March and August weeks against Wise before publication.</li><li>Investigate unknown-room and missing-attendance rows when either count changes materially.</li><li>Pair attendance volume with campaign or referral evidence before attributing visits specifically to BeGifted acquisition activity.</li></ol><h3>Further questions</h3><p>Which rooms and weekdays have the strongest repeat-student cadence? Do first-time student visits move with outreach campaigns? How often do late Wise corrections change a previously reported week?</p></div></section>
<p class="source">Provenance: Wise PAST-session feed → immutable de-identified report snapshot. Data as of ${esc(payload.meta.dataAsOf ?? "not available")}. Snapshot expires for regeneration on ${esc(snapshot.expiresAt)}, while this downloaded file is standalone.</p>
</main></body></html>`;
}
