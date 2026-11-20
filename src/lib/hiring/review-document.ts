import { readFile } from "node:fs/promises";
import { RUBRIC } from "./marking-sheet";
import type { ReviewPacket } from "./final-review";

const escape = (value: unknown) => String(value ?? "").replace(/[&<>"']/g, (char) =>
  ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[char]!);
const date = (value: Date | string) => new Date(value).toLocaleDateString("en-GB", {
  timeZone: "Asia/Bangkok", day: "numeric", month: "long", year: "numeric",
});

export async function reviewDocument(packet: ReviewPacket, resume: string, paper: string) {
  const logo = await readFile("public/brand/logo-horizontal.png", "base64");
  const font = await readFile("public/brand/hiring/geist-latin-400-normal.woff2", "base64");
  const fontLicense = await readFile("public/brand/hiring/geist.txt", "utf8");
  const value = packet.evidence;
  const lines = (rows: [string, unknown][]) => rows.map(([label, text]) =>
    `<div class="row"><dt>${escape(label)}</dt><dd>${escape(text)}</dd></div>`).join("");
  return `<!doctype html>
<html lang="en" data-begifted-look="private-office"><meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Hiring review | ${escape(value.name)}</title>
<style>
/* ${fontLicense} */
@font-face{font-family:Geist;src:url(data:font/woff2;base64,${font}) format("woff2");font-weight:400;font-display:swap}
*{box-sizing:border-box}body{max-width:760px;margin:0 auto;padding:48px 24px 64px;background:#F6F6F3;color:#101A17;font:15px/1.55 Geist,Arial,sans-serif;overflow-wrap:anywhere}
header{padding-bottom:28px;border-bottom:1px solid #E0E3DD}
img{width:145px;height:auto}h1{font-size:clamp(32px,7vw,53px);font-weight:400;line-height:1.08;letter-spacing:-.035em;margin:16px 0 8px}em{font-style:normal}
.candidate{font-size:21px}h2{font-size:21px;margin:0 0 8px;break-after:avoid}h3{font-size:15px;margin:14px 0 4px;break-after:avoid}
p,dl{margin:7px 0}section{padding:23px 0;border-bottom:1px solid #E0E3DD}
.eyebrow{margin-top:28px;color:#66706B;text-transform:uppercase;letter-spacing:.12em;font-size:12px}
.meta{color:#66706B}.copy{white-space:pre-wrap}.row{display:grid;grid-template-columns:minmax(0,2fr) minmax(0,3fr);gap:14px;padding:6px 0;border-bottom:1px solid #E0E3DD;break-inside:avoid}dd{margin:0;font-variant-numeric:tabular-nums}
a{display:inline-flex;align-items:center;min-height:44px;padding:6px 8px;color:#16302A;text-underline-offset:3px}li{margin:6px 0}
@media screen and (width < 520px){body{padding:24px 16px 40px}.row{grid-template-columns:minmax(0,1fr);gap:2px}}
@page{size:A4;margin:16mm}@media print{body{background:white;max-width:none;padding:0}section{padding:12px 0}a{display:inline;padding:0}}
</style>
<main>
<header><img alt="BeGifted Education" src="data:image/png;base64,${logo}">
<p class="eyebrow">Confidential hiring review</p>
<h1>Hiring <em>review</em></h1>
<p class="candidate">${escape(value.name)}</p><p>${escape(value.subject)} tutor</p><p class="meta">Submitted ${date(packet.at)} by ${escape(packet.author)}</p></header>
<section><h2>Assessment evidence</h2><dl>${lines([
  ["Tutor recommendation", `Yes, ${value.recommendation.head}`],
  ["Application-stage ATS score", `${value.ats.score.toFixed(1)} / 100`],
  ["Paper score", `${value.paper.total} / ${value.paper.max}`],
  ["Mock teaching score", `${value.mock.total} / 100`],
])}</dl>
<p><a href="${escape(resume)}">Original résumé</a></p><p><a href="${escape(paper)}">Marked exam</a></p>
${value.recommendation.reason ? `<p class="copy">${escape(value.recommendation.reason)}</p>` : ""}</section>
<section><h2>Pre-screen call</h2><p class="meta">${value.call ? `Call result recorded ${date(value.call)}` : "Call notes supplied by HR"}</p>
<p class="copy">${escape(packet.behavioral)}</p></section>
<section><h2>Mock teaching rubric</h2>
${RUBRIC.map(({ part, items }) => `<h3>${part}</h3><dl>${lines(items.map(([id, label]) => [label, `${value.mock.rubric.items[id]} / 10`]))}</dl>`).join("")}
<p class="copy">${escape(value.mock.rubric.comments)}</p></section>
<section><h2>Paper by level</h2><dl>${lines(value.paper.levels.filter((level) => level.max).map((level) =>
  [level.level, `${level.scored} / ${level.max}. ${level.percent}%. ${level.passPercent === null ? "Pass mark missing." : `Pass mark ${level.passPercent}%.`}`]))}</dl></section>
<section><h2>Initial ATS assessment</h2><dl>${lines(value.ats.criteria.map((item) => [
  item.id.replaceAll("_", " "), `${item.result}. ${item.evidence ?? ""}`,
]))}</dl></section>
<section><h2>Proposed offer letter</h2><p class="copy">${escape(packet.offer)}</p></section>
</main></html>`;
}
