import { readFile } from "node:fs/promises";
import { ITEM_MAX, RUBRIC, type LevelResult } from "./marking-sheet";
import type { ReviewPacket } from "./final-review";
import { VALUE } from "./scoring";

const escape = (value: unknown) => String(value ?? "").replace(/[&<>"']/g, (char) =>
  ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[char]!);
const date = (value: Date | string) => new Date(value).toLocaleDateString("en-GB", {
  timeZone: "Asia/Bangkok", day: "numeric", month: "long", year: "numeric",
});
const points = new Intl.NumberFormat("en-GB", { maximumFractionDigits: 2 });
const percent = (value: number) => Math.min(100, Math.max(0, value));
const chip = (result: LevelResult, passLabel = "Pass") => `<span class="chip ${result === "passed" ? "pass" : result === "not_passed" ? "below" : ""}">${{
  passed: passLabel, not_passed: "Below pass", pass_mark_missing: "No pass mark", not_done: "Not done",
}[result]}</span>`;
const criterionNames = { degree: "Degree", subject: "Subject", curriculum: "Curriculum", teaching: "Teaching", english: "English" };
const criterionResults = { met: "Met", partial: "Partial", not_met: "Not met", unknown: "Unknown" };
const stackColors = ["#2a78d6", "#eb6834", "#199e70", "#c98400", "#d96a97", "#008300"];

function gauge(value: number, unit = " / 100", target: number | null = null, label = String(value)) {
  const arc = "M21 56a45 45 0 0 1 90 0";
  const isPercent = unit === "%";
  const tick = (position: number, target = false) =>
    `<line class="${target ? "target" : "scale-tick"}" x1="${target ? 104 : 107}" y1="56" x2="116" y2="56" transform="rotate(${percent(position) * 1.8 - 180} 66 56)"/>`;
  return `<div class="gauge">
<svg viewBox="0 0 132 76" aria-hidden="true">
<path d="${arc}" class="gauge-track"/>
${value > 0 ? `<path d="${arc}" class="gauge-fill" pathLength="100" stroke-dasharray="${percent(value)} 100"/>` : ""}
${[0, 25, 50, 75, 100].map((value) => tick(value)).join("")}${target === null ? "" : tick(target, true)}
<text x="21" y="72">0</text><text x="111" y="72">100</text>
</svg><p class="gauge-value"><strong>${escape(label)}${isPercent ? "%" : ""}</strong>${isPercent ? "" : escape(unit)}</p>
</div><p class="band">${value >= 80 ? "Strong" : value >= 60 ? "Fair" : "Low"}</p>`;
}

type Criterion = ReviewPacket["evidence"]["ats"]["criteria"][number];

function radar(criteria: Criterion[]) {
  const spokes = Object.entries(criterionNames).map(([id, name], index) => {
    const angle = index * 2 * Math.PI / 5;
    const point = (radius: number) => [
      +(144 + radius * Math.sin(angle)).toFixed(2),
      +(116 - radius * Math.cos(angle)).toFixed(2),
    ] as const;
    const result = criteria.find((entry) => entry.id === id)?.result ?? "unknown";
    return { name, point, result, vertex: point(68 * VALUE[result]) };
  });
  return `<svg class="radar" viewBox="0 0 288 214" role="group" aria-label="ATS criteria radar">
${[17, 34, 51, 68].map((radius) => `<polygon class="radar-grid" points="${spokes.map(({ point }) => point(radius).join(",")).join(" ")}"/>`).join("")}
${spokes.map(({ point }) => {
  const [x, y] = point(68);
  return `<line class="radar-grid" x1="144" y1="116" x2="${x}" y2="${y}"/>`;
}).join("")}
<polygon class="radar-fill" points="${spokes.map(({ vertex }) => vertex.join(",")).join(" ")}"/>
${spokes.map(({ name, point, result, vertex: [x, y] }, index) => {
  const [labelX, labelY] = point(84);
  const anchor = index === 0 ? "middle" : index <= 2 ? "start" : "end";
  return `<circle class="radar-dot" cx="${x}" cy="${y}" r="4.5"/>
<text x="${labelX}" y="${labelY - 9}" text-anchor="${anchor}">${escape(name)}<tspan x="${labelX}" dy="16">${escape(criterionResults[result])}</tspan></text>`;
}).join("")}</svg>`;
}

function atsBreakdown(ats: ReviewPacket["evidence"]["ats"], atsScore: string) {
  const { weights, prestige, penalty } = ats;
  if (!weights || prestige === undefined || penalty === undefined) return "";
  const parts = Object.entries(criterionNames).map(([id, name]) => {
    const max = weights[id as keyof typeof weights];
    const result = ats.criteria.find((entry) => entry.id === id)?.result ?? "unknown";
    return { name, max, earned: max * VALUE[result] };
  });
  parts.push({ name: "School", max: weights.prestige, earned: weights.prestige * prestige });
  const gross = parts.reduce((sum, part) => sum + part.earned, 0);
  const barWidth = 304;
  const barX = (value: number) => 8 + barWidth * percent(value) / 100;
  let cursor = 0;
  const segments = parts.map(({ earned }, index) => {
    if (earned <= 0) return "";
    const start = cursor;
    cursor += earned;
    return `<rect x="${barX(start)}" y="2" width="${barX(cursor) - barX(start)}" height="14" fill="${stackColors[index]}"/>
${start > 0 ? `<path class="stack-gap" d="M${barX(start)} 2v14"/>` : ""}`;
  }).join("");
  const netX = barX(ats.score);
  return `<div class="ats-points"><h3>Weighted points</h3>
<p class="score"><strong>Total</strong><strong class="num">${escape(atsScore)}</strong></p>
<svg class="stack" viewBox="0 0 320 44" aria-hidden="true">
<defs><pattern id="lost-points" width="6" height="6" patternUnits="userSpaceOnUse" patternTransform="rotate(45)"><path d="M0 0v6"/></pattern></defs>
${segments}
${gross < 100 ? `<rect class="stack-ghost" x="${barX(gross)}" y="2" width="${barX(100) - barX(gross)}" height="14"/>
<rect x="${barX(gross)}" y="2" width="${barX(100) - barX(gross)}" height="14" fill="url(#lost-points)"/>
${gross > 0 ? `<path class="stack-gap" d="M${barX(gross)} 2v14"/>` : ""}` : ""}
<text x="8" y="37" text-anchor="start">0</text><text x="312" y="37" text-anchor="end">100</text>
${penalty > 0 ? `<path class="penalty-marker" d="M${netX} 18l-5 7h10z"/>` : ""}
</svg>
<ul class="stack-key">
${parts.map(({ name, earned, max }, index) => `<li><i style="background:${stackColors[index]}"></i><span>${escape(name)}</span><span class="num">${points.format(earned)} / ${points.format(max)}</span></li>`).join("")}
${gross < 100 ? `<li><i class="ghost-key"></i><span>Lost points</span><span class="num">${points.format(100 - gross)}</span></li>` : ""}
${penalty > 0 ? `<li><i class="penalty-key"></i><span>Work-rights penalty</span><span class="num">−${points.format(penalty)}</span></li>` : ""}
</ul></div>`;
}

function bullet(score: number, target: number | null) {
  return `<svg class="bullet" viewBox="0 0 400 16" preserveAspectRatio="none" aria-hidden="true">
<rect class="bullet-base" x="4" y="3" width="392" height="10" rx="2"/>
<path class="bullet-band" d="M239.2 3h78.4v10h-78.4z"/>
<path class="bullet-band strong" d="M317.6 3H394q2 0 2 2v6q0 2-2 2h-76.4z"/>
${score > 0 ? `<rect class="bullet-score" x="4" y="6" width="${percent(score) * 3.92}" height="4" rx="1.5"/>` : ""}
${target === null ? "" : `<line class="target" x1="${4 + percent(target) * 3.92}" x2="${4 + percent(target) * 3.92}" y1="0" y2="16"/>`}
</svg>`;
}

const mockTicks = [1, 4, 7, ITEM_MAX];
const mockX = (value: number) => 8 + (value - 1) * 104 / (ITEM_MAX - 1);
function mockPlot(score: number | null) {
  return `<svg class="dot-plot" viewBox="0 0 120 26" preserveAspectRatio="none" aria-hidden="true">
${mockTicks.map((tick) => `<line class="dot-grid" x1="${mockX(tick)}" x2="${mockX(tick)}" y1="0" y2="26"/>`).join("")}
${score == null ? "" : `<path class="dot-ring" d="M${mockX(score)} 13h0"/><path class="dot" d="M${mockX(score)} 13h0"/>`}
</svg>`;
}

export async function reviewDocument(packet: ReviewPacket, resume: string, paper: string) {
  const logo = await readFile("public/brand/logo-horizontal.png", "base64");
  const font = await readFile("public/brand/hiring/geist-latin-400-normal.woff2", "base64");
  const fontLicense = await readFile("public/brand/hiring/geist.txt", "utf8");
  const value = packet.evidence;
  const { ats, paper: sheet, mock, recommendation } = value;
  const atsScore = Number.isInteger(ats.score) ? String(ats.score) : ats.score.toFixed(1);
  const breakdown = atsBreakdown(ats, `${atsScore} / 100`);
  const paperPercent = sheet.max ? Math.round(sheet.total / sheet.max * 10_000) / 100 : 0;
  const levels = sheet.levels.filter(({ max }) => max > 0);
  const paperTarget = levels.length === 1 ? levels[0].passPercent : null;
  return `<!doctype html>
<html lang="en" data-begifted-look="private-office"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Hiring review | ${escape(value.name)}</title>
<style>
/* ${fontLicense} */
@font-face{font-family:Geist;src:url(data:font/woff2;base64,${font}) format("woff2");font-weight:400;font-display:swap}
:root{--page:#f7f3ec;--surface:#fffcf7;--ink:#17243b;--muted:#515e6d;--line:#ded8ce;--accent:#ff7518}
*{box-sizing:border-box}body{max-width:800px;margin:0 auto;padding:40px 24px 56px;background:var(--page);color:var(--ink);font:15px/1.5 Geist,Arial,sans-serif;overflow-wrap:anywhere}
header{padding-bottom:22px;border-bottom:1px solid var(--line)}
img{width:145px;height:auto}h1{font-size:clamp(32px,7vw,53px);font-weight:400;line-height:1.08;letter-spacing:-.035em;margin:16px 0 8px}em{font-style:normal}
.candidate{font-size:21px}h2{font-size:22px;margin:0 0 12px;break-after:avoid}h3{font-size:15px;margin:0;break-after:avoid}
p{margin:7px 0}section{padding:22px 0;border-bottom:1px solid var(--line)}
.eyebrow{margin-top:20px;color:var(--muted);text-transform:uppercase;letter-spacing:.12em;font-size:12px}
.meta{color:var(--muted)}.copy{white-space:pre-wrap}.num{font-variant-numeric:tabular-nums}
svg{display:block;width:100%;height:auto}
.target{stroke:var(--accent);stroke-width:3;vector-effect:non-scaling-stroke}
.tiles{display:grid;grid-template-columns:repeat(4,minmax(0,1fr));gap:8px;break-inside:avoid}
.tile{padding:10px;background:var(--surface);border:1px solid var(--line);border-radius:9px;text-align:center}
.tile h3{font-weight:600}.tile p{margin:0}
.gauge{position:relative;margin:0 auto;max-width:148px}
.gauge-track,.gauge-fill{fill:none;stroke-width:6}
.gauge-track{stroke:var(--line)}.gauge-fill{stroke:var(--ink)}
.scale-tick{stroke:var(--muted);stroke-width:1}
.gauge text,.stack text{fill:var(--muted);font-size:12px}
.gauge text{text-anchor:middle}
.gauge-value{position:absolute;inset:auto 0 27%;font-size:12px;line-height:1}
.gauge-value strong{font-size:clamp(20px,3.6vw,26px);font-weight:600;letter-spacing:-.05em}
.band{font-size:13px;font-weight:600}
.tile .paper-detail{margin-top:4px;font-size:12px}
.guide{display:flex;flex-wrap:wrap;gap:0 6px;color:var(--muted);font-size:12px}
.head-tile{display:flex;flex-direction:column;align-items:center;justify-content:center;gap:12px}
.head-tile p{padding:5px 9px;background:#fff0e2;border-radius:8px}
.ats-layout{display:grid;grid-template-columns:minmax(0,1fr) minmax(0,1.15fr);align-items:start;gap:16px;break-inside:avoid}
.radar{max-width:340px;margin:auto}
.radar-grid{fill:none;stroke:var(--line);stroke-width:1}
.radar-fill{fill:var(--ink);fill-opacity:.10;stroke:var(--ink);stroke-width:2;stroke-linejoin:round}
.radar-dot{fill:var(--ink);stroke:var(--page);stroke-width:4;paint-order:stroke}
.radar text{fill:var(--ink);font-size:14px;font-weight:600}
.radar tspan{fill:var(--muted);font-size:13px;font-weight:400}
.ats-points{padding:12px 14px;background:var(--surface);border:1px solid var(--line);border-radius:9px}
.score{display:flex;align-items:baseline;justify-content:space-between;gap:6px;flex-wrap:wrap;margin:2px 0 6px}
.score strong:last-child{font-size:32px;font-variant-numeric:normal;font-weight:600;letter-spacing:-.04em;line-height:1.2}
.stack-gap{stroke:var(--surface);stroke-width:2;vector-effect:non-scaling-stroke}
.stack-ghost,.ghost-key{fill:#ede7dd;background:#ede7dd}
#lost-points path{stroke:#b4aa9b;stroke-width:1.2}
.penalty-marker,.penalty-key{fill:var(--accent);background:var(--accent)}
.stack-key{margin:0;padding:0;list-style:none;font-size:13px}
.stack-key li{display:grid;grid-template-columns:10px minmax(0,1fr) auto;align-items:baseline;gap:7px}
.stack-key i{width:8px;height:8px;border-radius:2px}
.stack-key .penalty-key{clip-path:polygon(50% 0,100% 100%,0 100%);border-radius:0}
.evidence-list{display:grid;grid-template-columns:repeat(3,minmax(0,1fr));gap:6px 12px;margin-top:10px}
.evidence-list > div{min-width:0;break-inside:avoid}
.evidence-list > div:has(details[open]){grid-column:1/-1}
.label{display:flex;flex-wrap:wrap;justify-content:space-between;align-items:baseline;gap:2px 12px;margin:0 0 4px}
.metric{padding:6px 0;break-inside:avoid}
.bullet{height:16px}
.bullet-base{fill:#e9e3d9}.bullet-band{fill:#e1d9cc}.bullet-band.strong{fill:#d7cbb9}.bullet-score{fill:var(--ink)}
.chip{display:inline-block;width:fit-content;border-radius:99px;padding:1px 7px;background:#eae5dd;color:var(--ink);font-size:12px}
.chip.pass{background:#e3f1e7}.chip.below{background:#fce6d8}
.paperNote{display:flex;align-items:center;flex-wrap:wrap;gap:4px 8px;margin:2px 0 0;font-size:13px}
.mock-row{display:grid;grid-template-columns:minmax(0,1fr) minmax(90px,37%) 6ch;align-items:center;gap:0 12px}
.mock-row .num{text-align:right;white-space:nowrap}
.mock-axis{break-after:avoid;font-size:14px}
.axis-labels{grid-column:2;position:relative;height:20px;font-size:12px;color:var(--muted);white-space:nowrap}
.axis-labels span{position:absolute;transform:translateX(-50%)}
.rubric-group{break-inside:avoid;padding-bottom:8px}
.rubric-group h3{display:flex;align-items:baseline;justify-content:space-between;flex-wrap:wrap;gap:0 8px;padding:4px 0;border-bottom:1px solid var(--line)}
.rubric-group h3 span{color:var(--muted);font-size:12px;font-weight:400}
.mock-item{min-height:28px;font-size:14px}
.plot{position:relative;align-self:stretch}
.dot-plot{position:absolute;inset:0;height:100%}
.dot-grid{stroke:var(--line);stroke-width:1;vector-effect:non-scaling-stroke}
.dot-ring,.dot{stroke-linecap:round;vector-effect:non-scaling-stroke}
.dot-ring{stroke:var(--page);stroke-width:12}.dot{stroke:var(--ink);stroke-width:8}
.files{display:flex;flex-wrap:wrap;gap:0 8px;margin-top:7px}
a,summary{color:var(--ink);text-underline-offset:3px}a{display:inline-flex;align-items:center;min-height:44px;padding:6px 8px}
summary{width:fit-content;min-height:44px;padding:10px 0;cursor:pointer}details p{margin:0 0 7px}
@media screen and (width < 560px){
  body{padding:24px 16px 40px}.tiles,.evidence-list{grid-template-columns:repeat(2,minmax(0,1fr))}
  .ats-layout{grid-template-columns:minmax(0,1fr);gap:8px}.mock-row{gap:0 8px}
}
@page{size:A4;margin:16mm}@media print{
  body{--page:#fff;background:var(--page);max-width:none;padding:0;font-size:13px;print-color-adjust:exact;-webkit-print-color-adjust:exact}
  header{padding-bottom:8px}section{padding:8px 0}
  p{margin:4px 0}
  h1{font-size:40px;margin-top:8px}.eyebrow{margin-top:8px}h2{font-size:19px;margin-bottom:7px}
  .gauge{max-width:116px}.gauge-value strong{font-size:23px}
  .radar{max-width:260px}.metric{padding:3px 0}.mock-item{min-height:24px}
  .mock-section{break-inside:avoid}
  a,summary{min-height:0;padding:0}a{margin-right:8px}
}
</style>
</head><body><main>
<header><img alt="BeGifted Education" src="data:image/png;base64,${logo}">
<p class="eyebrow">Confidential hiring review</p>
<h1>Hiring <em>review</em></h1>
<p class="candidate">${escape(value.name)}</p><p>${escape(value.subject)} tutor</p><p class="meta">Submitted ${date(packet.at)} by ${escape(packet.author)}</p></header>
<section><h2>Assessment summary</h2><div class="tiles">
<div class="tile"><h3>ATS</h3>${gauge(ats.score, " / 100", null, atsScore)}</div>
<div class="tile"><h3>Paper</h3>${gauge(paperPercent, "%", paperTarget)}
<p class="paper-detail num">${escape(sheet.total)} / ${escape(sheet.max)} · ${chip(sheet.result, levels.length > 1 ? "Passed a level" : "Pass")}</p>
${paperTarget === null ? "" : `<p class="paper-detail meta">Pass mark ${escape(paperTarget)}%</p>`}</div>
<div class="tile"><h3>Mock</h3>${gauge(mock.total)}</div>
<div class="tile head-tile"><h3>Head</h3><p><strong>Yes</strong> · ${escape(recommendation.head)}</p></div>
</div><p class="guide"><span>Score guide</span><span>· Strong ≥80</span><span>· Fair 60 to under 80</span><span>· Low &lt;60</span></p>${recommendation.reason ? `<p class="copy">${escape(recommendation.reason)}</p>` : ""}
<div class="files"><a href="${escape(resume)}">Original résumé</a><a href="${escape(paper)}">Marked exam</a></div></section>
<section><h2>${breakdown ? "ATS breakdown" : "Initial ATS assessment"}</h2>
<div class="${breakdown ? "ats-layout" : ""}">${radar(ats.criteria)}${breakdown}</div>
<div class="evidence-list">
${ats.criteria.map(({ id, result, evidence }) => {
  const name = (criterionNames as Record<string, string>)[id];
  if (!evidence && name) return "";
  const title = escape(name ?? id.replaceAll("_", " "));
  return `<div><strong>${title}</strong>${name ? "" : ` · ${escape(criterionResults[result] ?? result)}`}
${evidence ? `<details aria-label="${title} evidence"><summary>Evidence</summary><p class="copy">${escape(evidence)}</p></details>` : ""}</div>`;
}).join("")}</div></section>
<section><h2>Paper by level</h2>
${levels.map((level) => `<div class="metric">
<p class="label"><span>${escape(level.level)}</span><span class="num">${escape(level.scored)} / ${escape(level.max)} · ${escape(level.percent)}%</span></p>
${bullet(level.scored / level.max * 100, level.passPercent)}
<p class="paperNote">${chip(level.result)}${level.passPercent === null ? "" : `<span class="meta num">Pass mark ${escape(level.passPercent)}%</span>`}</p></div>`).join("")}</section>
<section class="mock-section"><h2>Mock teaching rubric</h2>
<div class="mock-row mock-axis" aria-hidden="true"><div class="axis-labels">
${mockTicks.map((tick) => `<span style="left:${mockX(tick) / 120 * 100}%">${tick}</span>`).join("")}</div></div>
${RUBRIC.map(({ part, items }) => {
  const scored = items.map(([id]) => mock.rubric.items[id]).filter((score) => score != null);
  const average = scored.length ? `${points.format(scored.reduce((sum, score) => sum + score, 0) / scored.length)} / ${ITEM_MAX}` : "—";
  return `<div class="rubric-group"><h3>${escape(part)} <span>Average ${escape(average)}</span></h3>
${items.map(([id, label]) => `<div class="mock-row mock-item">
<span>${escape(label)}</span><div class="plot">${mockPlot(mock.rubric.items[id])}</div><span class="num">${escape(mock.rubric.items[id] ?? "—")} / ${ITEM_MAX}</span>
</div>`).join("")}</div>`;
}).join("")}
<p class="copy">${escape(mock.rubric.comments)}</p></section>
<section><h2>Pre-screen call</h2><p class="meta">${value.call ? `Call result recorded ${date(value.call)}` : "Call notes supplied by HR"}</p>
<p class="copy">${escape(packet.behavioral)}</p></section>
<section><h2>Proposed offer letter</h2><p class="copy">${escape(packet.offer)}</p></section>
</main></body></html>`;
}
