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
const bar = (score: number, max: number, width = 100, passMark: number | null = null) =>
  `<div class="track" aria-hidden="true" style="width:${percent(width)}%"><span class="fill" style="width:${max ? percent(score / max * 100) : 0}%"></span>${
    passMark === null ? "" : `<span class="tick" style="left:${percent(passMark)}%"></span>`}</div>`;
const chip = (result: LevelResult) => `<span class="chip ${result === "passed" ? "pass" : result === "not_passed" ? "below" : ""}">${{
  passed: "Pass", not_passed: "Below pass", pass_mark_missing: "No pass mark", not_done: "Not done",
}[result]}</span>`;
const criterionNames = { degree: "Degree", subject: "Subject", curriculum: "Curriculum", teaching: "Teaching", english: "English" };
const criterionResults = { met: "Met", partial: "Partial", not_met: "Not met", unknown: "Unknown" };

export async function reviewDocument(packet: ReviewPacket, resume: string, paper: string) {
  const logo = await readFile("public/brand/logo-horizontal.png", "base64");
  const font = await readFile("public/brand/hiring/geist-latin-400-normal.woff2", "base64");
  const fontLicense = await readFile("public/brand/hiring/geist.txt", "utf8");
  const value = packet.evidence;
  const { ats, paper: sheet, mock, recommendation } = value;
  const { weights, prestige, penalty } = ats;
  const breakdown = weights && prestige !== undefined && penalty !== undefined;
  const widest = weights ? Math.max(...Object.values(weights)) : 0;
  const atsScore = `${ats.score.toFixed(1)} / 100`;
  const paperPercent = sheet.max ? sheet.total / sheet.max * 100 : 0;
  return `<!doctype html>
<html lang="en" data-begifted-look="private-office"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Hiring review | ${escape(value.name)}</title>
<style>
/* ${fontLicense} */
@font-face{font-family:Geist;src:url(data:font/woff2;base64,${font}) format("woff2");font-weight:400;font-display:swap}
*{box-sizing:border-box}body{max-width:760px;margin:0 auto;padding:48px 24px 64px;background:#F6F6F3;color:#101A17;font:15px/1.55 Geist,Arial,sans-serif;overflow-wrap:anywhere}
header{padding-bottom:28px;border-bottom:1px solid #E0E3DD}
img{width:145px;height:auto}h1{font-size:clamp(32px,7vw,53px);font-weight:400;line-height:1.08;letter-spacing:-.035em;margin:16px 0 8px}em{font-style:normal}
.candidate{font-size:21px}h2{font-size:21px;margin:0 0 8px;break-after:avoid}h3{font-size:15px;margin:14px 0 4px;break-after:avoid}
p{margin:7px 0}section{padding:23px 0;border-bottom:1px solid #E0E3DD}
.eyebrow{margin-top:28px;color:#66706B;text-transform:uppercase;letter-spacing:.12em;font-size:12px}
.meta{color:#59635E}.copy{white-space:pre-wrap}.num{font-variant-numeric:tabular-nums}
.tiles{display:grid;grid-template-columns:repeat(4,minmax(0,1fr));gap:8px;margin:0;break-inside:avoid}
.tile{display:flex;flex-direction:column;gap:4px;padding:10px;background:#FFF;border:1px solid #E0E3DD;border-radius:10px}
.tile p{margin:0}.tile .track{margin-top:auto}
.label{display:flex;flex-wrap:wrap;justify-content:space-between;align-items:baseline;gap:2px 12px;margin:0 0 5px}
.metric{padding:8px 0;break-inside:avoid}.total{margin-top:10px;padding-top:10px;border-top:1px solid #E0E3DD}
.track{position:relative;height:8px;border-radius:999px;background:#E0E3DD}
.fill{display:block;height:100%;border-radius:inherit;background:#16302A}
.tick{position:absolute;top:-2px;bottom:-2px;width:2px;transform:translateX(-1px);background:#101A17;box-shadow:0 0 0 1px white}
.chip{display:inline-block;width:fit-content;border-radius:999px;padding:1px 7px;background:#E9EAE6;font-size:12px}
.chip.pass{background:#E3F1E7;color:#225737}.chip.below{background:#F6E7E4;color:#812E25}
.penalty{padding:5px 8px;background:#E9EAE6;border-radius:6px}
.paperNote{display:flex;align-items:center;flex-wrap:wrap;gap:4px 8px;margin:7px 0 0;font-size:13px}
.rubric{display:grid;grid-template-columns:repeat(2,minmax(0,1fr));gap:0 22px}.rubric > div{break-inside:avoid}.rubric .metric{padding:4px 0}
.files{display:flex;flex-wrap:wrap;gap:0 8px;margin-top:7px}
a,summary{color:#16302A;text-underline-offset:3px}a{display:inline-flex;align-items:center;min-height:44px;padding:6px 8px}
summary{width:fit-content;min-height:44px;padding:10px 0;cursor:pointer}details p{margin:0 0 7px}
@media screen and (width < 520px){body{padding:24px 16px 40px}.tiles{grid-template-columns:repeat(2,minmax(0,1fr))}.rubric{grid-template-columns:minmax(0,1fr)}}
@page{size:A4;margin:16mm}@media print{
  body{background:white;max-width:none;padding:0;print-color-adjust:exact;-webkit-print-color-adjust:exact}
  header,section{padding-bottom:12px}section{padding-top:12px}
  a,summary{min-height:0;padding:0}details::details-content{content-visibility:visible}
}
</style>
</head><body><main>
<header><img alt="BeGifted Education" src="data:image/png;base64,${logo}">
<p class="eyebrow">Confidential hiring review</p>
<h1>Hiring <em>review</em></h1>
<p class="candidate">${escape(value.name)}</p><p>${escape(value.subject)} tutor</p><p class="meta">Submitted ${date(packet.at)} by ${escape(packet.author)}</p></header>
<section><h2>Assessment summary</h2><div class="tiles">
<div class="tile"><p class="meta">ATS</p><p class="num"><strong>${atsScore}</strong></p>${bar(ats.score, 100)}</div>
<div class="tile"><p class="meta">Paper</p><p class="num"><strong>${points.format(paperPercent)}%</strong> · ${escape(sheet.total)} / ${escape(sheet.max)}</p>${chip(sheet.result)}${bar(sheet.total, sheet.max)}</div>
<div class="tile"><p class="meta">Mock</p><p class="num"><strong>${escape(mock.total)} / 100</strong></p>${bar(mock.total, 100)}</div>
<div class="tile"><p class="meta">Head</p><p><strong>Yes</strong> · ${escape(recommendation.head)}</p></div>
</div>${recommendation.reason ? `<p class="copy">${escape(recommendation.reason)}</p>` : ""}
<div class="files"><a href="${escape(resume)}">Original résumé</a><a href="${escape(paper)}">Marked exam</a></div></section>
<section><h2>${breakdown ? "ATS breakdown" : "Initial ATS assessment"}</h2>
${(breakdown
  // Every weighted part gets a row, so a part with no assessment shows as 0 and is not hidden.
  ? Object.keys(weights).filter((id) => id !== "prestige").map((id) => ats.criteria.find((c) => c.id === id) ?? { id, result: "unknown" as const, evidence: "" })
  : ats.criteria).map(({ id, result, evidence }) => {
  const weight = weights?.[id as keyof typeof weights] ?? 0;
  const earned = weight * VALUE[result];
  return `<div class="metric"><p class="label"><span>${escape((criterionNames as Record<string, string>)[id] ?? id.replaceAll("_", " "))}</span><span class="num">${
    breakdown ? `${points.format(earned)} / ${points.format(weight)} · ` : ""}${escape(criterionResults[result] ?? result)}</span></p>
${breakdown ? bar(earned, weight, weight / widest * 100) : ""}
${evidence ? `<details><summary>Evidence</summary><p class="copy">${escape(evidence)}</p></details>` : ""}</div>`;
}).join("")}
${breakdown ? `<div class="metric"><p class="label"><span>School</span><span class="num">${points.format(weights.prestige * prestige)} / ${points.format(weights.prestige)}</span></p>
${bar(weights.prestige * prestige, weights.prestige, weights.prestige / widest * 100)}</div>
${penalty > 0 ? `<p class="label penalty"><span>Work-rights penalty</span><span class="num">−${points.format(penalty)}</span></p>` : ""}
<p class="label total"><strong>Total</strong><strong class="num">${atsScore}</strong></p>` : ""}</section>
<section><h2>Paper by level</h2>
${sheet.levels.filter((level) => level.max).map((level) => `<div class="metric">
<p class="label"><span>${escape(level.level)}</span><span class="num">${escape(level.scored)} / ${escape(level.max)} · ${escape(level.percent)}%</span></p>
${bar(level.scored, level.max, 100, level.passPercent)}
<p class="paperNote">${chip(level.result)}${level.passPercent === null ? "" : `<span class="meta num">Pass mark ${escape(level.passPercent)}%</span>`}</p></div>`).join("")}</section>
<section><h2>Mock teaching rubric</h2><div class="rubric">
${RUBRIC.map(({ part, items }) => `<div><h3>${part}</h3>${items.map(([id, label]) => `<div class="metric">
<p class="label"><span>${label}</span><span class="num">${escape(mock.rubric.items[id])} / ${ITEM_MAX}</span></p>
${bar(mock.rubric.items[id] ?? 0, ITEM_MAX)}</div>`).join("")}</div>`).join("")}</div>
<p class="copy">${escape(mock.rubric.comments)}</p></section>
<section><h2>Pre-screen call</h2><p class="meta">${value.call ? `Call result recorded ${date(value.call)}` : "Call notes supplied by HR"}</p>
<p class="copy">${escape(packet.behavioral)}</p></section>
<section><h2>Proposed offer letter</h2><p class="copy">${escape(packet.offer)}</p></section>
</main></body></html>`;
}
