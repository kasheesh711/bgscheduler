#!/usr/bin/env node
/** Synthetic browser/PDF regression for the actual print component. No app auth, DB or Wise calls. */
import assert from "node:assert/strict";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import path from "node:path";
import { build } from "esbuild";
import { chromium, webkit } from "playwright-core";

const root = process.cwd();
const output = path.resolve(process.argv[2] || path.join(tmpdir(), "classroom-print-qa"));
await mkdir(output, { recursive: true });
const block = (id, students, patch = {}) => ({ rowId: id, tutorDisplayName: "Teacher Alice", startMinute: 540, endMinute: 600, startTime: "09:00", endTime: "10:00", room: "Joy", publication: "ready", status: "assigned", roomChange: false, outsideUsualRooms: false, students, rosterStatus: "verified", sessionState: "current", notes: [], ...patch });
const longNames = Array.from({ length: 90 }, (_, i) => `Student ${String(i).padStart(3, "0")} ชื่อภาษาไทยที่ยาวมาก นามสกุลที่ต้องตัดบรรทัด Alexandra Long-Student-Surname`);
function fixture(fresh = false, count = 1) {
  return { generatedAt: "2099-09-11T12:00:00Z", rosterCheckedAt: fresh ? "2099-09-11T12:01:00Z" : "2099-09-11T12:00:00Z", refreshFailed: false,
    days: Array.from({ length: count }, (_, i) => {
      const group = block(`group-${i}`, fresh ? longNames : ["Old roster"]);
      const individual = block(`individual-${i}`, ["Same Name", "Same Name", "นักเรียน แสงดาว"], { startTime: "10:00", endTime: "11:00", startMinute: 600, endMinute: 660 });
      const busy = Array.from({ length: 18 }, (_, j) => block(`busy-${i}-${j}`, [`Busy student ${j}`], { startTime: `${String(7 + Math.floor(j / 2)).padStart(2, "0")}:${j % 2 ? "30" : "00"}`, endTime: `${String(7 + Math.floor((j + 1) / 2)).padStart(2, "0")}:${j % 2 ? "00" : "30"}`, tutorDisplayName: "Teacher Bob", room: "Dream" }));
      const remote = block(`remote-${i}`, ["Remote student"], { status: "remote", publication: "remote", room: "Remote / no room needed", tutorDisplayName: "Teacher Carol" });
      const cancelled = block(`cancelled-${i}`, ["Cancelled student"], { sessionState: "cancelled", notes: ["Cancelled in Wise. Regenerate assignments."] });
      const unassigned = block(`unassigned-${i}`, ["Unassigned student"], { status: "no_room", room: "Room TBC", publication: "needs_review", notes: ["Room not yet assigned — check with the team"] });
      return { runId: `00000000-0000-4000-8000-${String(i + 1).padStart(12, "0")}`, date: `2099-09-${12 + i}`, revision: fresh ? `fresh-${i}` : `old-${i}`, draft: true,
        tutors: [
          { canonicalKey: "alice", tutorDisplayName: "Teacher Alice", usualRooms: ["Joy"], unavailableRooms: [], blocks: [group, individual, unassigned] },
          { canonicalKey: "bob", tutorDisplayName: "Teacher Bob", usualRooms: ["Dream"], unavailableRooms: [], blocks: busy },
          { canonicalKey: "carol", tutorDisplayName: "Teacher Carol", usualRooms: [], unavailableRooms: [], blocks: [remote] },
        ], rooms: [{ id: "joy", name: "Joy", capacity: 100, blocks: [group, individual] }, { id: "dream", name: "Dream", capacity: 10, blocks: busy }, { id: "empty", name: "Empty Room ห้องว่าง", capacity: 4, blocks: [] }], exceptions: [cancelled], roomExceptions: [cancelled, unassigned] };
    }) };
}
const entry = `import React from 'react';
import {createRoot} from 'react-dom/client';
import {ClassroomPrintDocument} from '${root}/src/components/class-assignments/classroom-print-document';
import '@fontsource/sarabun/400.css'; import '@fontsource/sarabun/600.css'; import '@fontsource/sarabun/700.css'; import '@fontsource/cormorant-garamond/600.css';
createRoot(document.getElementById('app')).render(<ClassroomPrintDocument report={window.fixture} view={new URLSearchParams(location.search).get('view') || 'tutors'} />);`;
await build({ stdin: { contents: entry, loader: "tsx", resolveDir: root }, bundle: true, outfile: path.join(output, "app.js"), jsx: "automatic", minify: true,
  alias: { "@": path.join(root, "src") }, loader: { ".woff": "file", ".woff2": "file" }, define: { "process.env.NODE_ENV": '"production"' },
  plugins: [{ name: "standalone-link", setup(api) {
    api.onResolve({ filter: /^next\/link$/ }, () => ({ path: "link", namespace: "fixture" }));
    api.onLoad({ filter: /.*/, namespace: "fixture" }, () => ({ contents: "import React from 'react'; export default function Link(p) { return React.createElement('a', p); }", resolveDir: root }));
  } }],
});
const errors = [];
const server = createServer(async (req, res) => {
  try {
    const url = new URL(req.url, "http://localhost");
    if (url.pathname === "/" || url.pathname === "/class-assignments/report") {
      const initial = fixture(false, url.searchParams.has("seven") ? 7 : 1);
      if (url.searchParams.has("failed")) initial.refreshFailed = true;
      res.setHeader("Content-Type", "text/html; charset=utf-8");
      res.end(`<!doctype html><html><head><style>@page{size:A4;margin:14mm 12mm}</style><link rel="stylesheet" href="/app.css"><style>*{box-sizing:border-box}body{margin:0}html{line-height:1.5;--font-sarabun:'Sarabun';--font-cormorant:'Cormorant Garamond'}button{font:inherit;padding:8px;border:1px solid #126dce;border-radius:6px;background:#126dce;color:white}button:disabled{opacity:.5}main{font-family:'Sarabun',sans-serif}p{margin:0}</style></head><body><div id="app"></div><script>window.fixture=${JSON.stringify(initial)};window.printCount=0;window.print=()=>{window.printCount++}</script><script src="/app.js"></script></body></html>`);
      return;
    }
    const file = url.pathname === "/brand/logo-horizontal.png" ? path.join(root, "public", url.pathname) : path.join(output, path.basename(url.pathname));
    const mime = { ".js": "text/javascript", ".css": "text/css", ".png": "image/png", ".woff2": "font/woff2", ".woff": "font/woff" }[path.extname(file)];
    res.setHeader("Content-Type", mime || "application/octet-stream"); res.end(await readFile(file));
  } catch { res.statusCode = 404; res.end(); }
});
await new Promise(resolve => server.listen(0, "127.0.0.1", resolve));
const useWebkit = process.env.PRINT_BROWSER === "webkit";
const browser = useWebkit
  ? await webkit.launch({ executablePath: process.env.WEBKIT_EXECUTABLE_PATH || undefined, headless: true })
  : await chromium.launch({ executablePath: process.env.CHROME_PATH || "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome", headless: true });
const page = await browser.newPage({ viewport: { width: 1440, height: 1050 } });
page.on("pageerror", error => errors.push(error.message));
const base = `http://127.0.0.1:${server.address().port}`;
let requests = 0, fail = false, seven = false, conflict = false;
await page.route("**/api/class-assignments/print-report?*", async route => {
  requests++;
  const ids = new URL(route.request().url()).searchParams.get("runIds").split(",");
  assert.equal(ids.length, seven ? 7 : 1);
  await route.fulfill({ status: fail ? 503 : conflict ? 409 : 200, contentType: "application/json", body: JSON.stringify(fail ? { error: "Wise unavailable. Retry before printing." } : conflict ? { error: "Assignments changed while loading. Refresh to print the latest saved version." } : fixture(true, seven ? 7 : 1)) });
});
async function ready() { await page.getByRole("button", { name: "Print / Save PDF", exact: true }).waitFor(); }
async function print() {
  const before = await page.evaluate(() => window.printCount);
  await page.getByRole("button", { name: "Print / Save PDF", exact: true }).click();
  await page.waitForFunction(n => window.printCount === n + 1, before);
}
function inspectPdf(pdf, sheets, label) {
  const source = pdf.toString("latin1");
  assert.equal(source.match(/\/Type\s*\/Page\b/g)?.length, sheets, `${label}: one physical page per prepared sheet`);
  const box = source.match(/\/MediaBox\s*\[\s*0\s+0\s+([\d.]+)\s+([\d.]+)\s*\]/);
  assert(box, `${label}: PDF paper dimensions are present`);
  assert(Math.abs(Number(box[1]) - 841.89) < 1 && Math.abs(Number(box[2]) - 595.28) < 1, `${label}: A4 landscape paper`);
}
async function inspect(view, count) {
  const expected = fixture(true, count).days.flatMap(day => (view === "rooms" ? [...day.rooms.flatMap(r => r.blocks), ...day.roomExceptions] : [...day.tutors.flatMap(t => t.blocks), ...day.exceptions])).flatMap(block => block.students).sort();
  const actual = await page.locator("[data-print-sheet] [data-student-list] li").allTextContents();
  assert.deepEqual(actual.sort(), expected, "Every student appears exactly once per class, including identical names");
  const issues = await page.locator("[data-print-sheet]").evaluateAll(sheets => sheets.flatMap((sheet, i) => {
    const issues = [], footer = sheet.querySelector("footer").getBoundingClientRect();
    const right = sheet.getBoundingClientRect().right;
    for (const card of sheet.querySelectorAll("[data-print-card]")) {
      const box = card.getBoundingClientRect();
      if (box.bottom > footer.top - 2) issues.push(`Page ${i + 1}: card overlaps footer`);
      if (box.right > right - 30) issues.push(`Page ${i + 1}: card overflows horizontally`);
      for (const el of card.querySelectorAll("li, td, th")) {
        if (el.scrollWidth > el.clientWidth + 1) issues.push(`Page ${i + 1}: text overflows`);
        if (parseFloat(getComputedStyle(el).fontSize) < 14.66) issues.push(`Page ${i + 1}: text below 11pt`);
      }
    }
    return issues;
  }));
  assert.deepEqual(issues, []);
  assert.equal(await page.locator("[data-print-sheet]").filter({ hasText: "Old roster" }).count(), 0);
  if (view === "rooms") {
    assert.equal(await page.locator("[data-print-sheet]").filter({ hasText: "No classes scheduled." }).count(), count);
    assert.equal(await page.locator("[data-print-sheet]").filter({ hasText: "Remote student" }).count(), 0);
  }
  await page.emulateMedia({ media: "print" });
  const sheets = await page.locator("[data-print-sheet]:visible").count();
  assert(sheets > 0);
  if (!useWebkit) {
    // DOM page counts alone miss Safari's extra footer-only physical pages.
    const pdf = await page.pdf({ path: path.join(output, `${view}-${count}-days.pdf`), preferCSSPageSize: true, printBackground: true });
    inspectPdf(pdf, sheets, "Named page");
    // Exercise the unnamed-page fallback used when named page rules are ignored.
    await page.evaluate(() => {
      document.querySelector("main").dataset.printApproved = "true";
      for (const sheet of document.styleSheets) {
        for (let i = sheet.cssRules.length - 1; i >= 0; i--) {
          const rule = sheet.cssRules[i];
          if (rule instanceof CSSPageRule && rule.selectorText === "classroom-a4") sheet.deleteRule(i);
        }
      }
    });
    const fallback = await page.pdf({ path: path.join(output, `${view}-${count}-days-unnamed.pdf`), preferCSSPageSize: true, printBackground: true });
    inspectPdf(fallback, sheets, "Unnamed page fallback");
  }
  await page.emulateMedia({ media: "screen" });
  await page.locator("[data-print-sheet]").first().screenshot({ path: path.join(output, `${view}-first-page.png`) });
  await page.evaluate(() => window.dispatchEvent(new Event("afterprint")));
  return sheets;
}
try {
  await page.goto(`${base}/class-assignments/report`); await ready();
  await page.emulateMedia({ media: "print" });
  assert.equal(await page.locator("[data-print-sheet]:visible").count(), 0, "Direct browser print cannot silently use an unrefreshed roster");
  await page.emulateMedia({ media: "screen" });
  const beforePages = await page.locator("[data-print-sheet]").count();
  await print(); assert.equal(requests, 1);
  const tutorPages = await inspect("tutors", 1); assert(tutorPages > beforePages, "Refresh repaginates a larger roster");
  await page.getByLabel("Print grouping").selectOption("rooms"); await ready();
  assert.match(page.url(), /view=rooms/);
  await print(); const roomPages = await inspect("rooms", 1);
  fail = true; const beforeFailure = await page.evaluate(() => window.printCount);
  await page.getByRole("button", { name: "Print / Save PDF", exact: true }).click();
  await page.getByRole("alert").filter({ hasText: "Wise unavailable" }).waitFor();
  assert.equal(await page.evaluate(() => window.printCount), beforeFailure);
  fail = false; await page.getByRole("button", { name: "Retry roster refresh" }).click(); await ready();
  conflict = true;
  await page.getByRole("button", { name: "Print / Save PDF", exact: true }).click();
  await page.getByRole("alert").filter({ hasText: "Assignments changed" }).waitFor();
  assert.equal(await page.evaluate(() => window.printCount), beforeFailure); conflict = false;
  await page.goto(`${base}/class-assignments/report?failed=1`); await ready();
  await page.getByRole("alert").filter({ hasText: "could not be refreshed" }).waitFor();
  await page.getByRole("button", { name: "Retry roster refresh" }).click(); await ready();
  assert.equal(await page.getByRole("alert").count(), 0);
  seven = true; await page.goto(`${base}/class-assignments/report?seven=1&view=rooms`); await ready();
  await print(); const sevenRoomPages = await inspect("rooms", 7);
  await page.getByLabel("Print grouping").selectOption("tutors"); await ready();
  await print(); const sevenTutorPages = await inspect("tutors", 7);
  assert.deepEqual(errors, []);
  const result = { browser: useWebkit ? "webkit" : "chromium", tutorPages, roomPages, sevenRoomPages, sevenTutorPages, requests, studentNamesPerLargeClass: longNames.length, checks: `Roster freshness, failure/retry, revision conflict, all names, overflow, 11pt text, empty rooms and both views/day ranges passed.${useWebkit ? "" : " Physical PDF page counts and unnamed-page fallback passed."}` };
  await writeFile(path.join(output, "results.json"), JSON.stringify(result, null, 2));
  console.log(JSON.stringify({ ...result, output }, null, 2));
} finally { await browser.close(); await new Promise(resolve => server.close(resolve)); }
