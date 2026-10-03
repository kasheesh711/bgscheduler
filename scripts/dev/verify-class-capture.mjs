#!/usr/bin/env node
// Offline, synthetic acceptance checks of the real React components. This is not an app route or auth bypass.
// No microphone, student data, vendor connection, production database or credentials are used.
// Run: node scripts/dev/verify-class-capture.mjs
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { build } from "esbuild";
import postcss from "postcss";
import tailwind from "@tailwindcss/postcss";
import { chromium } from "playwright-core";
import sharp from "sharp";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const OUT = path.join(ROOT, "docs/assets/class-capture");
const CHROME = process.env.CHROME_BIN || "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome";
const PNG = await sharp(Buffer.from(`<svg xmlns="http://www.w3.org/2000/svg" width="480" height="640"><rect width="480" height="640" fill="#fffaf0"/><text x="32" y="60" font-family="sans-serif" font-size="26" fill="#075985">Practice worksheet</text><text x="32" y="95" font-family="sans-serif" font-size="16" fill="#64748b">Synthetic example</text><g stroke="#cbd5e1" stroke-width="2"><path d="M32 160H448 M32 230H448 M32 300H448 M32 370H448 M32 440H448 M32 510H448"/></g><g font-family="sans-serif" font-size="22" fill="#334155"><text x="32" y="145">1. 24 + 18 = 42</text><text x="32" y="215">2. 7 × 8 = 56</text><text x="32" y="285">3. 3/4 + 1/4 = 1</text></g></svg>`)).png().toBuffer();
const session = { sessionId: "fictional-session", classId: "fictional-class", studentId: "fictional-student", studentName: "Ari (fictional)", teacherKey: "fictional-tutor", teacherName: "Mali (fictional)", title: "Year 6 Maths", startTime: "2026-10-01T08:00:00Z", endTime: "2026-10-01T09:00:00Z", wiseUrl: "https://wiseapp.live/fictional-class" };
const availability = { enabled: true, storage: true, transcription: true, drafting: true };
let capture = null;
let transcriptionOutcome = "success";
const uploaded = new Set();
const metrics = { creates: 0, assetIntents: 0, uploads: 0, transcriptions: 0, drafts: 0, gets: 0, patches: 0, lists: 0 };
const results = [];

const ENTRY = `
import { createRoot } from "react-dom/client";
import { ClassCaptureWorkspace } from "@/components/class-capture/class-capture-workspace";
import { LocalRecovery } from "@/lib/class-capture/local-recovery";
const params = new URLSearchParams(location.search);
window.__micMode = "allowed";
window.__micRequests = 0;
window.__trackStops = 0;
window.__wakeReleases = 0;
Object.defineProperty(navigator, "wakeLock", { configurable: true, value: {
  request: async () => Object.assign(new EventTarget(), { released: false, release: async () => { window.__wakeReleases++; } })
} });
window.__uploadAttempts = 0;
window.__uploadDelay = 100;
window.__failNextUpload = false;
window.__owner = params.get("owner") === "second" ? "second@example.test" : "fictional-tutor@example.test";
window.__listLocal = () => new LocalRecovery().list(window.__owner);
const stream = () => {
  const track = new EventTarget();
  track.stop = () => { window.__trackStops++; };
  return { getTracks: () => [track] };
};
Object.defineProperty(navigator, "mediaDevices", { value: {
  getUserMedia: async () => {
    window.__micRequests++;
    if (window.__micMode === "denied") throw new DOMException("Synthetic permission denial", "NotAllowedError");
    if (window.__micMode === "pending") return new Promise(resolve => { window.__resolveMic = () => resolve(stream()); });
    return stream();
  }
}, configurable: true });
class SyntheticRecorder {
  static isTypeSupported() { return true; }
  state = "inactive"; mimeType = "audio/webm;codecs=opus";
  constructor() { window.__recorder = this; }
  start() { this.state = "recording"; }
  emit() { this.ondataavailable?.({ data: new Blob([new Uint8Array([0x1a,0x45,0xdf,0xa3]), "Fictional audio fixture. No people were recorded."], { type: this.mimeType }) }); }
  stop() { this.state = "inactive"; queueMicrotask(() => { this.emit(); this.onstop?.(); }); }
}
window.MediaRecorder = SyntheticRecorder;
window.__fakeUpload = async (pathname, body, options) => {
  window.__uploadAttempts++;
  options.onUploadProgress?.({ percentage: 35, loaded: Math.round(body.size * .35), total: body.size });
  await new Promise(resolve => setTimeout(resolve, window.__uploadDelay));
  if (options.abortSignal?.aborted) throw new DOMException("Cancelled", "AbortError");
  if (window.__failNextUpload) { window.__failNextUpload = false; throw new Error("Synthetic connection loss. Retry upload to continue."); }
  const response = await fetch("/__fixture-upload", { method: "POST", body: JSON.stringify({ pathname }) });
  if (!response.ok) throw new Error("Synthetic upload failed");
  options.onUploadProgress?.({ percentage: 100, loaded: body.size, total: body.size });
  return { pathname };
};
createRoot(document.getElementById("root")).render(<ClassCaptureWorkspace ownerEmail={window.__owner} enabled={params.get("paused") !== "true"} />);
`;

const bundled = await build({
  stdin: { contents: ENTRY, resolveDir: ROOT, sourcefile: "class-capture-synthetic.tsx", loader: "tsx" },
  bundle: true, write: false, platform: "browser", format: "iife", target: "es2022", jsx: "automatic", tsconfig: path.join(ROOT, "tsconfig.json"),
  define: { "process.env.NODE_ENV": JSON.stringify("production") }, minify: true,
  logOverride: { "module-level-directive": "silent" },
  plugins: [{ name: "synthetic-upload-only", setup(bundler) {
    bundler.onResolve({ filter: /^@vercel\/blob\/client$/ }, () => ({ path: "synthetic-upload", namespace: "fixture" }));
    bundler.onLoad({ filter: /.*/, namespace: "fixture" }, () => ({ contents: "export const upload = (...args) => window.__fakeUpload(...args);", loader: "js" }));
  } }],
});
const from = path.join(ROOT, "src/app/globals.css");
const css = (await postcss([tailwind({ base: ROOT })]).process(readFileSync(from, "utf8"), { from })).css;
const html = `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Synthetic Class Capture verification</title><style>${css}</style><style>:root{--font-inter:ui-sans-serif,system-ui,sans-serif;--font-jetbrains-mono:ui-monospace,monospace}body{margin:0}#root{display:flex;flex:1;min-height:0}main{height:calc(100dvh - 52px);display:flex;flex-direction:column;padding:12px 16px}.fixture-nav{height:52px;display:flex;align-items:center;justify-content:space-between;padding:0 16px;border-bottom:1px solid var(--border);font-size:13px;font-weight:600;background:var(--card)}</style></head><body><div class="fixture-nav"><span>BeGifted Ops</span><span style="color:var(--muted-foreground);font-weight:400;font-size:11px">Synthetic preview</span></div><main><div id="root"></div></main><script>${bundled.outputFiles[0].text.replaceAll("</script", "<\\/script")}</script></body></html>`;

function json(response, value, status = 200) { response.writeHead(status, { "Content-Type": "application/json", "Cache-Control": "no-store" }); response.end(JSON.stringify(value)); }
const server = createServer(async (request, response) => {
  const url = new URL(request.url, "http://localhost");
  if (url.pathname === "/") { response.writeHead(200, { "Content-Type": "text/html" }); response.end(html); return; }
  const chunks = [];
  for await (const chunk of request) chunks.push(chunk);
  const raw = Buffer.concat(chunks).toString();
  const body = raw ? JSON.parse(raw) : {};
  if (url.pathname === "/__fixture-upload") { metrics.uploads++; uploaded.add(body.pathname); json(response, { ok: true }); return; }
  if (url.pathname === "/api/class-capture") {
    if (request.method === "GET") { metrics.lists++; assert.equal(url.search, "", "The browser must not choose a listing date"); json(response, { sessions: [session], availability }); return; }
    metrics.creates++;
    capture ??= { id: body.id, session, topic: body.topic, tutorNotes: "", consent: body.consent, assets: [], draft: null, reviewed: false, expiresAt: new Date(Date.now() + 24 * 60 * 60 * 1000).toISOString(), version: 0 };
    json(response, { capture }); return;
  }
  if (!capture || !url.pathname.startsWith(`/api/class-capture/${capture.id}`)) { json(response, { error: "Synthetic route unavailable" }, 404); return; }
  const suffix = url.pathname.slice(`/api/class-capture/${capture.id}`.length);
  if (!suffix) {
    if (request.method === "DELETE") { capture = null; json(response, { deleted: true }); return; }
    if (request.method === "PATCH") {
      metrics.patches++;
      if (body.version !== capture.version) { json(response, { error: "This draft changed in another tab. Reload it." }, 409); return; }
      capture = { ...capture, topic: body.topic, tutorNotes: body.tutorNotes, draft: body.resetDraft ? null : body.fields ?? capture.draft, reviewed: body.reviewed ?? false, version: capture.version + 1 };
    } else metrics.gets++;
    json(response, { capture }); return;
  }
  if (suffix === "/assets") {
    if (body.kind === "worksheet" && body.worksheetPermission !== true) { json(response, { error: "Confirm worksheet permission." }, 400); return; }
    let asset = capture.assets.find(asset => asset.id === body.id);
    if (!asset) { metrics.assetIntents++; asset = { id: body.id, kind: body.kind, mime: body.mime, size: body.size, pathname: `class-capture/synthetic/${body.id}`, status: "pending", transcript: null, error: null }; capture.assets.push(asset); capture.version++; }
    json(response, { asset }); return;
  }
  if (suffix.startsWith("/assets/")) {
    const asset = capture.assets.find(asset => asset.id === suffix.slice("/assets/".length));
    if (request.method === "DELETE" && asset) { uploaded.delete(asset.pathname); capture.assets = capture.assets.filter(item => item.id !== asset.id); capture.draft = null; capture.reviewed = false; capture.version++; json(response, { deleted: true }); return; }
    if (!asset || !uploaded.has(asset.pathname)) { json(response, { error: "Upload has not finished yet." }, 404); return; }
    if (request.method === "GET") { response.writeHead(200, { "Content-Type": asset.mime, "Cache-Control": "private, no-store" }); response.end(asset.kind === "worksheet" ? PNG : Buffer.from("Synthetic audio container only")); return; }
    asset.status = "ready"; capture.version++;
    json(response, { capture }); return;
  }
  if (suffix === "/transcribe") {
    metrics.transcriptions++;
    const asset = capture.assets.find(asset => asset.id === body.assetId);
    if (transcriptionOutcome === "uncertain") { asset.status = "failed"; asset.error = "Transcription outcome uncertain."; capture.version++; json(response, { error: "The provider outcome is uncertain. Remove this evidence or ask operations to review it." }, 503); return; }
    asset.status = "transcribed";
    asset.transcript = asset.kind === "debrief" ? "Tutor observation: Ari independently completed two written fraction examples." : "Equivalent fractions were discussed. A voice said: two fourths is one half. Speaker identity is not established by this transcript.";
    capture.version++; json(response, { capture }); return;
  }
  if (suffix === "/draft") {
    if (capture.draft) { json(response, { capture }); return; }
    metrics.drafts++;
    capture.draft = { topicsCovered: "Equivalent fractions: comparing halves, quarters and eighths using fraction diagrams.", demonstratedUnderstanding: "Tutor observation: Ari independently completed two written examples. The class transcript contains a correct fraction equivalence, but does not establish who said it.", difficulties: "Tutor observation: Ari needed a reminder to keep the numerator and denominator in proportion. Silent work cannot be assessed from this recording.", homeworkNextSteps: "Practise the four fraction-diagram questions agreed with the tutor. Review equivalent fractions at the next class." };
    capture.reviewed = false; capture.version++;
    json(response, { capture }); return;
  }
  json(response, { error: "Unexpected synthetic route" }, 404);
});
await new Promise(resolve => server.listen(0, "127.0.0.1", resolve));
const origin = `http://127.0.0.1:${server.address().port}`;
mkdirSync(OUT, { recursive: true });
let browser;

async function waitFor(page, predicate, message) { await page.waitForFunction(predicate, undefined, { timeout: 10_000 }).catch(() => { throw new Error(message); }); }
async function check(name, action) { await action(); results.push({ name, passed: true }); process.stdout.write(`PASS ${name}\n`); }

try {
  browser = await chromium.launch({ executablePath: CHROME, headless: true });
  const context = await browser.newContext({ viewport: { width: 390, height: 844 }, deviceScaleFactor: 1, permissions: ["clipboard-read", "clipboard-write"] });
  await context.route("**/*", route => route.request().url().startsWith(origin) ? route.continue() : route.abort());
  const page = await context.newPage();
  await page.clock.setFixedTime(new Date("2026-10-01T16:00:00Z"));
  const pageErrors = [];
  page.on("pageerror", error => pageErrors.push(error.message));
  await page.goto(origin);

  await check("Consent gates preparation and microphone access", async () => {
    await page.getByRole("button", { name: /Ari \(fictional\)/ }).waitFor();
    assert.equal(await page.getByRole("button", { name: "Prepare class capture" }).isDisabled(), true);
    assert.equal(await page.evaluate(() => window.__micRequests), 0);
    assert.equal(await page.locator('input[type="date"]').count(), 0);
    await page.getByText("Today · Bangkok", { exact: true }).waitFor();
    await page.screenshot({ path: path.join(OUT, "mobile-select-class.png") });
    await page.getByRole("button", { name: /Ari \(fictional\)/ }).click();
    await page.getByLabel("Today’s lesson topic").fill("Equivalent fractions");
    await page.getByRole("heading", { name: "Permission comes first." }).evaluate(element => element.closest("section").scrollIntoView({ block: "start" }));
    await page.screenshot({ path: path.join(OUT, "mobile-consent.png") });
    await page.getByLabel("I have explained this recording", { exact: false }).check();
    await page.getByLabel("Guardian permission", { exact: true }).selectOption("confirmed");
    await page.getByLabel("I have permission to use private Vercel Blob storage", { exact: false }).check();
    await page.getByRole("button", { name: "Prepare class capture" }).click();
    await page.getByRole("button", { name: "Start class recording" }).waitFor();
    assert.equal(await page.getByRole("button", { name: "Start class recording" }).isDisabled(), true);
    assert.equal(metrics.creates, 1);
    assert.equal(await page.evaluate(() => window.__micRequests), 0);
  });

  await check("Permission denial offers settings and file fallback", async () => {
    await page.evaluate(() => { window.__micMode = "denied"; });
    await page.getByLabel("All participants still agree", { exact: false }).check();
    await page.getByRole("button", { name: "Start class recording" }).click();
    await page.getByText("Microphone access was denied.", { exact: false }).waitFor();
    assert.equal(await page.getByRole("button", { name: "Choose an audio file" }).isEnabled(), true);
  });

  await check("Cancelling pending permission releases a late microphone", async () => {
    await page.evaluate(() => { window.__micMode = "pending"; });
    await page.getByRole("button", { name: "Start class recording" }).click();
    await page.getByRole("button", { name: "Cancel this recording" }).click();
    await page.evaluate(() => { window.__resolveMic(); });
    await waitFor(page, () => window.__trackStops > 0, "Late microphone was not stopped");
    assert.equal(await page.getByText("Recording class audio", { exact: true }).count(), 0);
  });

  await check("Visible recording stops on background and keeps recoverable audio", async () => {
    await page.clock.setFixedTime(new Date("2026-10-01T16:59:58Z"));
    await page.evaluate(() => { window.__micMode = "allowed"; });
    await page.getByLabel("All participants still agree", { exact: false }).check();
    await page.getByRole("button", { name: "Start class recording" }).click();
    await page.getByText("Recording class audio", { exact: true }).waitFor();
    await page.getByText("Screen stay-awake is on.", { exact: false }).waitFor();
    await page.evaluate(() => window.__recorder.emit());
    const stoppedBeforeMidnight = await page.evaluate(() => window.__trackStops);
    await page.clock.setFixedTime(new Date("2026-10-01T17:00:00Z"));
    await Promise.all([
      page.waitForResponse(response => response.url() === `${origin}/api/class-capture` && response.request().method() === "GET"),
      page.evaluate(() => window.dispatchEvent(new Event("focus"))),
    ]);
    await page.getByText("Recording class audio", { exact: true }).waitFor();
    assert.equal(await page.evaluate(() => window.__trackStops), stoppedBeforeMidnight, "Refreshing today's list must not stop an active recording");
    await page.locator("[data-class-capture]").evaluate(element => { element.scrollTop = 0; });
    await page.screenshot({ path: path.join(OUT, "mobile-recording.png") });
    await page.evaluate(() => {
      Object.defineProperty(document, "visibilityState", { value: "hidden", configurable: true });
      document.dispatchEvent(new Event("visibilitychange"));
      Object.defineProperty(document, "visibilityState", { value: "visible", configurable: true });
    });
    await page.getByText("Recording stopped when this page left the foreground.", { exact: false }).waitFor();
    await page.getByRole("button", { name: "Upload privately" }).waitFor();
    assert.ok(await page.evaluate(() => window.__wakeReleases > 0));
    await waitFor(page, async () => (await window.__listLocal()).some(record => record.size > 0), "Local IndexedDB recovery missing");
    assert.equal(metrics.transcriptions, 0);
    assert.equal(metrics.uploads, 0);
    await page.reload();
    await page.getByText("Capture reopened.", { exact: false }).waitFor();
    assert.equal(await page.evaluate(() => window.__micRequests), 0);
    assert.equal(await page.getByRole("button", { name: "Upload privately" }).count(), 1);
  });

  await check("Lost upload retries the same intent and requires explicit transcription", async () => {
    await page.evaluate(() => { window.__failNextUpload = true; });
    await page.getByRole("button", { name: "Upload privately" }).click();
    await page.getByText("Synthetic connection loss.", { exact: false }).waitFor();
    assert.equal(metrics.assetIntents, 1);
    await page.getByRole("button", { name: "Upload privately" }).click();
    await page.getByRole("button", { name: "Transcribe audio" }).waitFor();
    assert.equal(metrics.assetIntents, 1);
    assert.equal(metrics.uploads, 1);
    assert.equal(metrics.transcriptions, 0);
    await page.getByRole("button", { name: "Transcribe audio" }).click();
    await page.getByText("Class transcript · audible evidence").waitFor();
    assert.equal(metrics.transcriptions, 1);
    assert.equal(metrics.drafts, 0);
  });

  await check("Photos upload on selection and show a tappable thumbnail", async () => {
    await page.clock.setFixedTime(new Date("2026-10-01T16:59:58Z"));
    assert.equal(await page.getByLabel("Tutor observations", { exact: false }).count(), 0);
    assert.equal(await page.getByRole("button", { name: "Add worksheet photos" }).isDisabled(), true);
    await page.getByLabel("I have permission to upload these worksheets", { exact: false }).check();
    await page.getByLabel("Choose worksheet photos").setInputFiles({ name: "fictional-worksheet.png", mimeType: "image/png", buffer: PNG });
    await page.getByText("1 of 1 photos uploaded.", { exact: false }).waitFor();
    await page.getByRole("button", { name: "Preview worksheet photo 1", exact: true }).click();
    await page.getByRole("dialog", { name: "Worksheet photo preview" }).waitFor();
    await page.getByRole("button", { name: "Close preview" }).click();
    assert.equal(metrics.drafts, 0);
  });

  await check("Review and a saved acknowledgement gate Copy and Wise handoff", async () => {
    await page.getByRole("button", { name: "Create feedback draft" }).click();
    await page.getByRole("heading", { name: "Your judgment. Your feedback." }).waitFor();
    assert.equal(await page.getByRole("button", { name: "Copy reviewed feedback" }).isDisabled(), true);
    assert.equal(await page.getByRole("link", { name: "Open Wise to submit" }).count(), 0);
    await page.getByLabel("Difficulties", { exact: true }).fill("Tutor observation: Ari needed one reminder about scaling both parts of a fraction.");
    await page.getByLabel("I reviewed the evidence", { exact: false }).check();
    await page.getByRole("button", { name: "Save reviewed draft" }).click();
    await page.getByRole("link", { name: "Open Wise to submit" }).waitFor();
    assert.equal(capture.reviewed, true);
    await page.getByRole("button", { name: "Copy reviewed feedback" }).click();
    await page.getByText("Reviewed feedback copied.", { exact: false }).waitFor();
    assert.match(await page.evaluate(() => navigator.clipboard.readText()), /Tutor observation/);
    await page.locator('[aria-labelledby="draft-heading"]').evaluate(element => element.scrollIntoView({ block: "start" }));
    await page.screenshot({ path: path.join(OUT, "mobile-review.png") });
    await page.getByRole("button", { name: "Save reviewed draft" }).scrollIntoViewIfNeeded();
    await page.screenshot({ path: path.join(OUT, "mobile-handoff.png") });
    await page.setViewportSize({ width: 1440, height: 1080 });
    await page.locator("[data-class-capture]").evaluate(element => { element.scrollTop = 0; });
    await page.screenshot({ path: path.join(OUT, "desktop-capture.png") });
    await page.getByRole("heading", { name: "Your judgment. Your feedback." }).scrollIntoViewIfNeeded();
    await page.screenshot({ path: path.join(OUT, "desktop-review.png") });
    await page.getByLabel("Difficulties", { exact: true }).fill("A new tutor edit requires another review.");
    assert.equal(await page.getByRole("button", { name: "Copy reviewed feedback" }).isDisabled(), true);
    assert.equal(await page.getByRole("link", { name: "Open Wise to submit" }).count(), 0);
  });

  await check("Focus and a new Bangkok day preserve active draft edits, review and local media", async () => {
    const difficulty = "Unsaved difficulty: preserve this edited draft field.";
    await page.getByLabel("Difficulties", { exact: true }).fill(difficulty);
    await page.getByLabel("I reviewed the evidence", { exact: false }).check();
    const id = capture.id;
    const previousGets = metrics.gets;
    const previousLocal = await page.evaluate(() => window.__listLocal());
    await page.clock.setFixedTime(new Date("2026-10-01T17:00:01Z"));
    await Promise.all([
      page.waitForResponse(response => response.url() === `${origin}/api/class-capture` && response.request().method() === "GET"),
      page.evaluate(() => window.dispatchEvent(new Event("focus"))),
    ]);
    assert.equal(await page.getByLabel("Difficulties", { exact: true }).inputValue(), difficulty);
    assert.equal(await page.getByLabel("I reviewed the evidence", { exact: false }).isChecked(), true);
    assert.equal(capture.id, id);
    assert.equal(metrics.gets, previousGets, "List refresh must not reload the active capture over unsaved fields");
    assert.deepEqual((await page.evaluate(() => window.__listLocal())).map(record => record.assetId), previousLocal.map(record => record.assetId));
    await page.clock.setFixedTime(new Date("2026-10-01T17:00:01Z"));
  });

  await check("Regeneration resets the existing draft before an explicit new generation", async () => {
    await page.getByRole("button", { name: "Regenerate draft" }).click();
    await page.getByText("Draft ready for your review.", { exact: false }).waitFor();
    assert.equal(metrics.drafts, 2);
    assert.equal(capture.reviewed, false);
    assert.equal(capture.tutorNotes, "");
    assert.equal(await page.getByRole("button", { name: "Copy reviewed feedback" }).isDisabled(), true);
  });

  await check("Uncertain transcription can be removed before drafting from the remaining transcript", async () => {
    await page.getByLabel("All participants still agree", { exact: false }).check();
    await page.getByRole("button", { name: /Record a tutor debrief/ }).click();
    await page.getByText("Recording tutor debrief", { exact: true }).waitFor();
    await page.getByText("Screen stay-awake is on.", { exact: false }).waitFor();
    await page.evaluate(() => window.__recorder.emit());
    await page.getByRole("button", { name: "Stop recording now", exact: true }).click();
    const debrief = page.locator("article").filter({ has: page.getByRole("heading", { name: "Tutor voice debrief", exact: true }) });
    await debrief.getByRole("button", { name: "Upload privately" }).click();
    await debrief.getByRole("button", { name: "Transcribe audio" }).waitFor();
    transcriptionOutcome = "uncertain";
    await debrief.getByRole("button", { name: "Transcribe audio" }).click();
    await debrief.getByText("Transcription outcome uncertain.", { exact: true }).waitFor();
    assert.equal(await debrief.getByRole("button", { name: "Retry transcription" }).count(), 0);
    await debrief.getByRole("button", { name: "Remove evidence" }).click();
    await page.getByText("Evidence and its local recovery copy removed.", { exact: true }).waitFor();
    assert.equal(capture.assets.some(asset => asset.kind === "debrief"), false);
    await page.getByRole("button", { name: "Create feedback draft" }).click();
    await page.getByText("Draft ready for your review.", { exact: false }).waitFor();
    assert.equal(metrics.drafts, 3);
    transcriptionOutcome = "success";
  });

  await check("Mobile layout fits 390px and touch controls are at least 44px", async () => {
    await page.setViewportSize({ width: 390, height: 844 });
    const layout = await page.evaluate(() => ({
      pageWidth: document.documentElement.scrollWidth,
      viewportWidth: innerWidth,
      undersized: [...document.querySelectorAll("button")].filter(button => button.getBoundingClientRect().height > 0 && button.getBoundingClientRect().height < 44).map(button => button.textContent),
    }));
    assert.ok(layout.pageWidth <= layout.viewportWidth, JSON.stringify(layout));
    assert.deepEqual(layout.undersized, []);
  });

  await check("Automatic photo upload cancellation retains a retryable local copy", async () => {
    await page.evaluate(() => { window.__uploadDelay = 1000; });
    await page.getByLabel("Choose worksheet photos").setInputFiles({ name: "cancelled-photo.png", mimeType: "image/png", buffer: PNG });
    await waitFor(page, () => !!document.querySelector('[aria-label^="Uploading"]'), "Automatic upload did not start");
    await page.getByRole("button", { name: "Cancel remaining uploads" }).click();
    await page.getByText("0 of 1 photos uploaded.", { exact: false }).waitFor();
    assert.ok((await page.evaluate(() => window.__listLocal())).some(record => record.kind === "worksheet"));
    await page.evaluate(() => { window.__uploadDelay = 100; });
    await page.getByRole("button", { name: "Retry upload photo 2" }).click();
    await waitFor(page, () => document.querySelectorAll('[aria-label="Worksheet photo gallery"] [aria-label="Uploaded"]').length === 2, "Photo retry did not finish");
    await page.evaluate(() => { window.__failNextUpload = true; });
    await page.getByLabel("Choose worksheet photos").setInputFiles({ name: "failed-photo.png", mimeType: "image/png", buffer: PNG });
    await page.getByText("0 of 1 photos uploaded.", { exact: false }).waitFor();
    await waitFor(page, async () => (await window.__listLocal()).some(record => record.kind === "worksheet"), "Failed photo must stay available for recovery");
  });

  await check("A different login cannot recover the prior account’s local media", async () => {
    assert.ok((await page.evaluate(() => window.__listLocal())).length > 0);
    await page.route(`**/api/class-capture/${capture.id}`, route => route.fulfill({ status: 403, contentType: "application/json", body: JSON.stringify({ error: "Synthetic account is not authorized for that class." }) }));
    await page.goto(`${origin}/?owner=second`);
    await page.getByRole("button", { name: /Ari \(fictional\)/ }).waitFor();
    assert.deepEqual(await page.evaluate(() => window.__listLocal()), []);
    assert.equal(await page.getByText("Worksheet photo", { exact: true }).count(), 0);
    assert.equal(await page.getByRole("button", { name: "Start class recording" }).count(), 0);
  });

  await check("Default pause is visible with no microphone request", async () => {
    await page.goto(`${origin}/?paused=true`);
    await page.getByRole("heading", { name: "Class capture is paused" }).waitFor();
    assert.equal(await page.evaluate(() => window.__micRequests), 0);
    await page.screenshot({ path: path.join(OUT, "mobile-paused.png") });
  });

  await check("iPhone M4A upload and manual retrospective feedback work without AI", async () => {
    capture = null;
    const manualContext = await browser.newContext({ viewport: { width: 390, height: 844 } });
    await manualContext.route("**/*", route => route.request().url().startsWith(origin) ? route.continue() : route.abort());
    const manualPage = await manualContext.newPage();
    manualPage.on("pageerror", error => pageErrors.push(error.message));
    await manualPage.goto(origin);
    await manualPage.getByRole("button", { name: /Ari \(fictional\)/ }).click();
    await manualPage.getByLabel("Today’s lesson topic").fill("Retrospective feedback");
    await manualPage.getByLabel("I have explained this recording", { exact: false }).check();
    await manualPage.getByLabel("Guardian permission", { exact: true }).selectOption("confirmed");
    await manualPage.getByLabel("I have permission to use private Vercel Blob storage", { exact: false }).check();
    await manualPage.getByRole("button", { name: "Prepare class capture" }).click();
    await manualPage.getByRole("button", { name: "Upload saved audio" }).waitFor();
    const providerBefore = { transcriptions: metrics.transcriptions, drafts: metrics.drafts };
    await manualPage.getByLabel("I have permission to upload these worksheets", { exact: false }).check();
    await manualPage.getByLabel("Choose worksheet photos").setInputFiles(Array.from({ length: 24 }, (_, i) => ({ name: `Worksheet-${i}.png`, mimeType: "image/png", buffer: PNG })));
    await manualPage.getByText("24 of 24 photos uploaded.", { exact: false }).waitFor({ timeout: 30000 });
    const gallery = manualPage.getByLabel("Worksheet photo gallery", { exact: true });
    assert.equal(await gallery.getByRole("article").count(), 24);
    const geometry = await gallery.evaluate(el => ({ height: el.getBoundingClientRect().height, content: el.scrollHeight }));
    assert.ok(geometry.height <= 321 && geometry.content > geometry.height, JSON.stringify(geometry));
    await gallery.scrollIntoViewIfNeeded();
    await manualPage.screenshot({ path: path.join(OUT, "mobile-photo-gallery.png") });
    await manualPage.reload();
    await manualPage.getByText("Capture reopened.", { exact: false }).waitFor();
    await manualPage.getByRole("button", { name: "Preview worksheet photo 1", exact: true }).click();
    await manualPage.getByRole("dialog", { name: "Worksheet photo preview" }).waitFor();
    assert.ok(await manualPage.getByAltText("Full worksheet photo").evaluate(el => el.complete && el.naturalWidth > 0));
    await manualPage.keyboard.press("Escape");

    await manualPage.getByLabel("Choose existing class audio").setInputFiles({ name: "Voice Memo.m4a", mimeType: "audio/x-m4a", buffer: Buffer.from([0,0,0,24,102,116,121,112,77,52,65,32]) });
    await manualPage.getByRole("button", { name: "Upload privately" }).waitFor();
    await manualPage.reload();
    await manualPage.getByText("Capture reopened.", { exact: false }).waitFor();
    await manualPage.getByRole("button", { name: "Upload privately" }).click();
    await manualPage.getByRole("button", { name: "Transcribe audio" }).waitFor();
    assert.equal(capture.assets.find(asset => asset.kind === "recording").mime, "audio/mp4");
    await manualPage.getByRole("button", { name: "Write feedback myself" }).click();
    await manualPage.getByLabel("Topics covered", { exact: true }).fill("Practised equivalent fractions.");
    await manualPage.getByLabel("Demonstrated understanding", { exact: true }).fill("Completed two written examples independently.");
    await manualPage.getByLabel("I reviewed the evidence", { exact: false }).check();
    await manualPage.getByRole("button", { name: "Save reviewed draft" }).click();
    await manualPage.getByRole("link", { name: "Open Wise to submit" }).waitFor();
    assert.equal(metrics.transcriptions, providerBefore.transcriptions);
    assert.equal(metrics.drafts, providerBefore.drafts);
    assert.equal(await manualPage.evaluate(() => window.__micRequests), 0);
    assert.equal(capture.draft.topicsCovered, "Practised equivalent fractions.");
    await manualPage.screenshot({ path: path.join(OUT, "mobile-manual-feedback.png") });
    await manualContext.close();
  });

  const todayContext = await browser.newContext({ viewport: { width: 390, height: 844 }, deviceScaleFactor: 1 });
  await todayContext.route("**/*", route => route.request().url().startsWith(origin) ? route.continue() : route.abort());
  const todayPage = await todayContext.newPage();
  todayPage.on("pageerror", error => pageErrors.push(error.message));
  await todayPage.clock.install({ time: new Date("2026-10-01T16:59:00Z") });
  let listDay = "2026-10-01";
  let listName = "Today pupil (fictional)";
  let failList = false;
  let holdNextList = false;
  let heldResponse;
  let heldArrival;
  let heldFinished;
  let todayRequests = 0;
  const listed = () => ({ sessions: [{ ...session, sessionId: `${listDay}-own-session`, studentName: listName, startTime: `${listDay}T08:00:00Z`, endTime: `${listDay}T09:00:00Z` }], availability });
  await todayPage.route(`${origin}/api/class-capture`, async route => {
    assert.equal(new URL(route.request().url()).search, "");
    assert.equal(route.request().method(), "GET", "Calendar checks must not create a capture");
    todayRequests++;
    const body = JSON.stringify(listed());
    if (holdNextList) {
      holdNextList = false;
      heldArrival();
      await new Promise(resolve => { heldResponse = resolve; });
      await route.fulfill({ status: 200, contentType: "application/json", body });
      heldFinished();
    } else await route.fulfill({ status: failList ? 503 : 200, contentType: "application/json", body: failList ? JSON.stringify({ error: "Synthetic schedule refresh failure." }) : body });
  });
  await todayPage.goto(origin);

  await check("Bangkok midnight clears pending choices and consent and loads today's list", async () => {
    await todayPage.getByRole("button", { name: /Today pupil/ }).click();
    await todayPage.getByLabel("Today’s lesson topic").fill("Synthetic lesson");
    await todayPage.getByLabel("I have explained this recording", { exact: false }).check();
    await todayPage.getByLabel("Guardian permission", { exact: true }).selectOption("confirmed");
    await todayPage.getByLabel("I have permission to use private Vercel Blob storage", { exact: false }).check();
    assert.equal(await todayPage.getByRole("button", { name: "Prepare class capture" }).isEnabled(), true);
    listDay = "2026-10-02";
    listName = "New day pupil (fictional)";
    await todayPage.clock.fastForward(61_000);
    await todayPage.getByRole("button", { name: /New day pupil/ }).waitFor();
    assert.equal(await todayPage.getByRole("button", { name: /Today pupil/ }).count(), 0);
    assert.equal(await todayPage.getByRole("button", { name: "Prepare class capture" }).isDisabled(), true);
    assert.equal(await todayPage.getByLabel("I have explained this recording", { exact: false }).isChecked(), false);
    assert.equal(await todayPage.getByLabel("Guardian permission", { exact: true }).inputValue(), "");
    assert.equal(await todayPage.getByLabel("I have permission to use private Vercel Blob storage", { exact: false }).isChecked(), false);
    await todayPage.getByRole("heading", { name: "Your classes today" }).evaluate(element => element.closest("section").scrollIntoView({ block: "start" }));
    await todayPage.screenshot({ path: path.join(OUT, "mobile-today-rollover.png") });
  });

  await check("A late older response cannot restore a superseded class list", async () => {
    listName = "Obsolete response pupil (fictional)";
    holdNextList = true;
    const arrived = new Promise(resolve => { heldArrival = resolve; });
    const finished = new Promise(resolve => { heldFinished = resolve; });
    await todayPage.evaluate(() => window.dispatchEvent(new Event("focus")));
    await arrived;
    listName = "Newest response pupil (fictional)";
    await todayPage.evaluate(() => window.dispatchEvent(new Event("focus")));
    await todayPage.getByRole("button", { name: /Newest response pupil/ }).waitFor();
    heldResponse();
    await finished;
    await todayPage.evaluate(() => new Promise(resolve => requestAnimationFrame(() => resolve())));
    assert.equal(await todayPage.getByRole("button", { name: /Obsolete response pupil/ }).count(), 0);
    assert.equal(await todayPage.getByRole("button", { name: /Newest response pupil/ }).count(), 1);
  });

  await check("Visible return after suspended timers refreshes today and recovers a failed refresh", async () => {
    await todayPage.getByRole("button", { name: /Newest response pupil/ }).click();
    await todayPage.getByLabel("I have explained this recording", { exact: false }).check();
    const previousRequests = todayRequests;
    await todayPage.evaluate(() => { Object.defineProperty(document, "visibilityState", { value: "hidden", configurable: true }); document.dispatchEvent(new Event("visibilitychange")); });
    assert.equal(todayRequests, previousRequests);
    await todayPage.clock.setSystemTime(new Date("2026-10-02T17:00:01Z"));
    listDay = "2026-10-03";
    listName = "Returned pupil (fictional)";
    failList = true;
    await todayPage.evaluate(() => { Object.defineProperty(document, "visibilityState", { value: "visible", configurable: true }); document.dispatchEvent(new Event("visibilitychange")); });
    await todayPage.getByText("Synthetic schedule refresh failure.", { exact: false }).waitFor();
    assert.equal(await todayPage.getByRole("button", { name: /Newest response pupil/ }).count(), 0);
    assert.equal(await todayPage.getByLabel("I have explained this recording", { exact: false }).isChecked(), false);
    failList = false;
    await todayPage.getByRole("button", { name: "Retry today’s classes" }).click();
    await todayPage.getByRole("button", { name: /Returned pupil/ }).waitFor();
    assert.equal(await todayPage.locator('time[datetime="2026-10-03"]').count(), 1);
    assert.equal(await todayPage.locator('input[type="date"]').count(), 0);
  });
  await todayContext.close();
  assert.deepEqual(pageErrors, [], `Unexpected browser errors: ${pageErrors.join(", ")}`);
  writeFileSync(path.join(OUT, "acceptance-results.json"), `${JSON.stringify({ syntheticOnly: true, providerCalls: 0, checks: results, metrics, unverified: ["Real iOS Safari and Android Chrome hardware, phone calls, lockscreen and OS termination", "Live private Blob upload, Soniox transcription and OpenRouter draft generation", "Production account grants, scheduling snapshots and Wise submission", "Reliable recovery after abrupt browser/process termination is not guaranteed"] }, null, 2)}\n`);
  process.stdout.write(`Saved ${results.length} passing synthetic acceptance checks and screenshots to ${OUT}\n`);
} finally {
  await browser?.close();
  await new Promise(resolve => server.close(resolve));
}
