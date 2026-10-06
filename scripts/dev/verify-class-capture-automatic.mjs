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
const OUT = path.join(ROOT, "docs/assets/class-capture/automatic");
const CHROME = process.env.CHROME_BIN || "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome";
const PNG = await sharp(Buffer.from(`<svg xmlns="http://www.w3.org/2000/svg" width="480" height="640"><rect width="480" height="640" fill="#fffaf0"/><text x="32" y="60" font-family="sans-serif" font-size="26" fill="#075985">Practice worksheet</text><text x="32" y="95" font-family="sans-serif" font-size="16" fill="#64748b">Synthetic example</text><g stroke="#cbd5e1" stroke-width="2"><path d="M32 160H448 M32 230H448 M32 300H448 M32 370H448 M32 440H448 M32 510H448"/></g><g font-family="sans-serif" font-size="22" fill="#334155"><text x="32" y="145">1. 24 + 18 = 42</text><text x="32" y="215">2. 7 × 8 = 56</text><text x="32" y="285">3. 3/4 + 1/4 = 1</text></g></svg>`)).png().toBuffer();
const session = { sessionId: "fictional-session", classId: "fictional-class", studentId: "fictional-student", studentName: "Ari (fictional)", teacherKey: "fictional-tutor", teacherName: "Mali (fictional)", title: "Year 6 Maths", startTime: "2026-10-01T08:00:00Z", endTime: "2026-10-01T09:00:00Z", wiseUrl: "https://wiseapp.live/fictional-class" };
const availability = { automatic: true, enabled: true, storage: true, transcription: true, drafting: true };
let capture = null;
const uploaded = new Set();
const metrics = { creates: 0, assetIntents: 0, uploads: 0, transcriptions: 0, drafts: 0, gets: 0, patches: 0, lists: 0 };
const results = [];

const ENTRY = `
import { createRoot } from "react-dom/client";
import { ClassCaptureWorkspace } from "@/components/class-capture/class-capture-workspace";
import { optimizeWorksheet } from "@/components/class-capture/photo-preparation";
window.__optimize = optimizeWorksheet;
import { LocalRecovery } from "@/lib/class-capture/local-recovery";
const params = new URLSearchParams(location.search);
window.__micMode = "allowed";
window.__micRequests = 0;
window.__trackStops = 0;
window.__wakeReleases = 0;
Object.defineProperty(navigator, "wakeLock", { configurable: true, value: {
  request: async () => Object.assign(new EventTarget(), { released: false, release: async () => { window.__wakeReleases++; } })
} });
window.__uploadAttempts = 0; window.__activePhotos = 0; window.__peakPhotos = 0;
window.__copied = "";
Object.defineProperty(navigator, "clipboard", { value: { write: async items => { window.__copied = await (await items[0].getType("text/plain")).text(); }, writeText: async text => { window.__copied = text; } }, configurable: true });
window.__uploadDelay = 250;
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
  const photo = body.type.startsWith("image/");
  if (photo) window.__peakPhotos = Math.max(window.__peakPhotos, ++window.__activePhotos);
  options.onUploadProgress?.({ percentage: 35, loaded: Math.round(body.size * .35), total: body.size });
  await new Promise(resolve => setTimeout(resolve, window.__uploadDelay));
  if (photo) window.__activePhotos--;
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
const html = `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Synthetic Class Capture verification</title><style>${css}</style><style>:root{--font-inter:ui-sans-serif,system-ui,sans-serif;--font-jetbrains-mono:ui-monospace,monospace}body{margin:0}#root{display:flex;flex:1;min-height:0}.fixture-shell{height:calc(100dvh - 52px);display:flex;flex-direction:column;padding:12px 16px}.fixture-nav{height:52px;display:flex;align-items:center;justify-content:space-between;padding:0 16px;border-bottom:1px solid var(--border);font-size:13px;font-weight:600;background:var(--card)}</style></head><body><div class="fixture-nav"><span>BeGifted Ops</span><span style="color:var(--muted-foreground);font-weight:400;font-size:11px">Synthetic preview</span></div><div class="fixture-shell"><div id="root"></div></div><script>${bundled.outputFiles[0].text.replaceAll("</script", "<\\/script")}</script></body></html>`;

const automatic = () => ({ consented: true, revision: 0, completedRevision: -1, status: "waiting", recording: false, expectedUploads: [], error: null, evidence: null, proposal: null });
const fields = { topicsCovered: "We worked on equivalent fractions and addition.", demonstratedUnderstanding: "The written answers show correct addition of fractions with the same denominator.", difficulties: "", homeworkNextSteps: "Complete the remaining fraction questions." };
let draftTimer;
function scheduleDraft() {
  clearTimeout(draftTimer);
  draftTimer = setTimeout(() => {
    if (!capture?.automatic || capture.automatic.recording || capture.automatic.expectedUploads.some(id => !capture.assets.some(a => a.id === id && a.status !== "pending"))) return;
    const result = { fields: { ...fields }, evidence: { sources: [{ field: "topicsCovered", sourceId: "recording:synthetic-id", quote: "Let's work on fractions", startMs: 2000 }], questions: ["Which practice paper was assigned?"] } };
    capture.automatic.status = "ready"; capture.automatic.completedRevision = capture.automatic.revision;
    if (capture.draft) capture.automatic.proposal = { ...result, revision: capture.automatic.revision };
    else { capture.draft = result.fields; capture.version++; capture.automatic.evidence = result.evidence; }
    metrics.drafts++;
  }, 400); // Accelerated provider/debounce fixture; real debounce is covered by Postgres tests.
}
function json(response, value, status = 200) { response.writeHead(status, { "Content-Type": "application/json", "Cache-Control": "no-store" }); response.end(JSON.stringify(value)); }
const server = createServer(async (request, response) => {
  const url = new URL(request.url, "http://localhost");
  if (url.pathname === "/") { response.writeHead(200, { "Content-Type": "text/html" }); response.end(html); return; }
  const chunks = []; for await (const chunk of request) chunks.push(chunk);
  if (url.pathname === "/__benchmark") { response.writeHead(204); response.end(); return; }
  const raw = Buffer.concat(chunks).toString(); const body = raw ? JSON.parse(raw) : {};
  if (url.pathname === "/__fixture-upload") { metrics.uploads++; uploaded.add(body.pathname); json(response, { ok: true }); return; }
  if (url.pathname === "/api/class-capture") {
    if (request.method === "GET") { json(response, { sessions: [session], availability }); return; }
    capture ??= { id: body.id, session, topic: body.topic, tutorNotes: "", consent: body.consent, assets: [], draft: null, reviewed: false, expiresAt: new Date(Date.now() + 86400000).toISOString(), version: 0 };
    json(response, { capture }); return;
  }
  if (!capture || !url.pathname.startsWith(`/api/class-capture/${capture.id}`)) { json(response, { error: "Missing fixture" }, 404); return; }
  const tail = url.pathname.slice(`/api/class-capture/${capture.id}`.length);
  if (!tail) {
    if (request.method === "PATCH") {
      if (body.version !== capture.version) { json(response, { error: "This capture changed" }, 409); return; }
      capture.draft = body.fields; capture.reviewed = body.reviewed; capture.version++; metrics.patches++;
    }
    metrics.gets++; json(response, { capture }); return;
  }
  if (tail === "/process") {
    if (body.action === "consent") capture.automatic ??= automatic();
    else if (body.action === "stage") { capture.automatic.expectedUploads = [...new Set([...capture.automatic.expectedUploads, ...body.assetIds])]; capture.automatic.revision++; capture.automatic.status = "waiting"; }
    else if (body.action === "recording") capture.automatic.recording = body.active;
    else if (body.action === "forget") capture.automatic.expectedUploads = capture.automatic.expectedUploads.filter(id => id !== body.assetId);
    else if (body.action === "accept") { capture.draft = capture.automatic.proposal.fields; capture.automatic.evidence = capture.automatic.proposal.evidence; capture.automatic.proposal = null; capture.version++; }
    if (!["accept", "consent"].includes(body.action)) scheduleDraft();
    json(response, { capture }); return;
  }
  if (tail === "/assets") {
    let asset = capture.assets.find(a => a.id === body.id);
    if (!asset) { asset = { ...body, pathname: `class-capture/${capture.id}/${body.id}`, status: "pending", transcript: null, error: null }; capture.assets.push(asset); capture.version++; metrics.assetIntents++; }
    json(response, { asset }); return;
  }
  const asset = capture.assets.find(a => tail === `/assets/${a.id}`);
  if (!asset) { json(response, { error: "Missing asset" }, 404); return; }
  if (request.method === "GET") { response.writeHead(200, { "Content-Type": "image/png" }); response.end(PNG); return; }
  if (request.method === "DELETE") { capture.assets = capture.assets.filter(a => a.id !== asset.id); capture.version++; json(response, { capture }); return; }
  if (!uploaded.has(asset.pathname)) { json(response, { error: "Upload missing" }, 409); return; }
  asset.status = asset.kind === "worksheet" ? "ready" : "transcribed";
  if (asset.kind !== "worksheet") { metrics.transcriptions++; asset.transcript = "Let's work on fractions."; }
  capture.automatic.status = "processing"; scheduleDraft(); json(response, { asset });
});
await new Promise(resolve => server.listen(0, "127.0.0.1", resolve));
const origin = `http://127.0.0.1:${server.address().port}`;
let browser;
const check = async (name, action) => { await action(); results.push({ name, passed: true }); process.stdout.write(`PASS ${name}\n`); };
try {
  mkdirSync(OUT, { recursive: true });
  browser = await chromium.launch({ executablePath: CHROME, headless: true });
  const context = await browser.newContext({ viewport: { width: 390, height: 844 }, isMobile: true, deviceScaleFactor: 1 });
  const page = await context.newPage(); const errors = []; page.on("pageerror", e => errors.push(e.message));
  await page.goto(origin);
  await page.getByRole("button", { name: /Ari \(fictional\)/ }).click();
  await page.getByLabel("Today’s lesson topic").fill("Fractions");
  await page.getByLabel("I have explained this recording", { exact: false }).check();
  await page.getByLabel("Guardian permission", { exact: true }).selectOption("confirmed");
  await page.getByLabel("I have permission for private storage", { exact: false }).check();
  await page.getByRole("button", { name: "Prepare class capture" }).click();
  await page.getByRole("button", { name: "Add audio", exact: true }).waitFor();
  await check("Selected M4A automatically uploads, transcribes and produces a draft", async () => {
    await page.getByLabel("Choose audio for automatic feedback").setInputFiles({ name: "class.m4a", mimeType: "audio/mp4", buffer: Buffer.from([0,0,0,24,102,116,121,112,77,52,65,32,0,0,0,0,77,52,65,32,105,115,111,109]) });
    await page.waitForFunction(() => document.querySelector("#auto-topicsCovered")?.value.includes("fractions"));
    assert.equal(metrics.uploads, 1); assert.equal(metrics.transcriptions, 1); assert.equal(metrics.drafts, 1);
    for (const name of ["Upload privately", "Transcribe audio", "Check transcript", "Create draft", "Save reviewed draft"]) assert.equal(await page.getByRole("button", { name, exact: true }).count(), 0);
  });
  await check("Edits autosave and approval copies only feedback", async () => {
    await page.getByLabel("Topics covered", { exact: true }).fill("My reviewed fraction feedback.");
    await page.waitForFunction(() => document.body.textContent.includes("Saved"));
    await page.getByRole("button", { name: "Approve & copy" }).click();
    await page.waitForFunction(() => window.__copied.includes("My reviewed fraction feedback."));
    await page.getByLabel("Feedback draft", { exact: true }).evaluate(element => element.scrollIntoView({ block: "start" }));
    await page.screenshot({ path: path.join(OUT, "mobile-feedback.png") });
    assert.equal(capture.reviewed, true); assert.doesNotMatch(await page.evaluate(() => window.__copied), /synthetic-id|Which practice|unverified/);
  });
  await check("24 photos use three concurrent uploads, compact previews and preserve tutor edits", async () => {
    await page.getByLabel("I have permission to upload and analyse", { exact: false }).check();
    await page.getByLabel("Choose photos for automatic feedback").setInputFiles(Array.from({ length: 24 }, (_, i) => ({ name: `page-${i}.png`, mimeType: "image/png", buffer: PNG })));
    await page.getByRole("button", { name: "Preview worksheet photo 24", exact: true }).waitFor();
    await page.waitForFunction(() => window.__uploadAttempts === 25 && window.__activePhotos === 0);
    await page.getByText("Updated draft available. Your edits are preserved.").waitFor();
    assert.equal(await page.evaluate(() => window.__peakPhotos), 3);
    assert.equal(await page.getByLabel("Topics covered", { exact: true }).inputValue(), "My reviewed fraction feedback.");
    assert.ok((await page.getByLabel("Worksheet photo gallery", { exact: true }).boundingBox()).height <= 321);
    assert.equal(await page.evaluate(() => document.documentElement.scrollWidth > innerWidth), false);
    await page.evaluate(() => { window.scrollTo(0, 0); document.querySelector("main")?.scrollTo(0, 0); });
    await page.screenshot({ path: path.join(OUT, "mobile-24-photos.png"), fullPage: true });
    await page.getByRole("button", { name: "Preview worksheet photo 1", exact: true }).click();
    await page.getByRole("dialog", { name: "Worksheet photo preview" }).waitFor();
    await page.getByRole("button", { name: "Close preview" }).click();
  });
  await check("A failed upload retries independently and reload retains saved edits", async () => {
    await page.evaluate(() => { window.__failNextUpload = true; });
    await page.getByLabel("Choose photos for automatic feedback").setInputFiles({ name: "retry.png", mimeType: "image/png", buffer: PNG });
    await page.getByText("Upload failed. Tap retry.", { exact: true }).waitFor();
    await page.getByRole("button", { name: "Retry upload photo 25", exact: true }).click();
    await page.waitForFunction(() => document.querySelectorAll('[aria-label="Uploaded"]').length === 25);
    await page.reload(); await page.getByRole("button", { name: "Add audio", exact: true }).waitFor();
    assert.equal(await page.getByLabel("Topics covered", { exact: true }).inputValue(), "My reviewed fraction feedback.");
  });
  await check("Stopping a recording starts upload without another processing click", async () => {
    const before = metrics.uploads;
    const attemptsBefore = await page.evaluate(() => window.__uploadAttempts);
    await page.locator("summary").filter({ hasText: "Record in this browser" }).click();
    await page.getByLabel("All participants still agree", { exact: false }).check();
    await page.getByRole("button", { name: "Start class recording", exact: true }).click();
    await page.getByRole("button", { name: "Stop recording", exact: true }).click();
    await page.waitForFunction(n => window.__uploadAttempts > n, attemptsBefore);
    await page.getByText("Updated draft available. Your edits are preserved.").waitFor();
    await page.waitForFunction(() => document.body.textContent.includes("Transcript ready") && !document.body.textContent.includes("Uploading 35%"));
    for (let n = 0; metrics.uploads <= before && n < 50; n++) await new Promise(r => setTimeout(r, 100));
    assert.ok(metrics.uploads > before);
  });
  await check("Conflicting autosave preserves local text and another tab's saved feedback", async () => {
    await page.getByLabel("Topics covered", { exact: true }).fill("Unsaved correction in this tab.");
    capture.draft.topicsCovered = "A different saved correction."; capture.version++;
    await page.getByText("Feedback changed in another tab.", { exact: false }).waitFor();
    assert.equal(await page.getByLabel("Topics covered", { exact: true }).inputValue(), "Unsaved correction in this tab.");
    assert.equal(capture.draft.topicsCovered, "A different saved correction.");
  });
  if (!process.argv.includes("--ui-only")) await check("Image preparation reduces a 12 MP worksheet while keeping a 2560px legible copy", async () => {
    // Deterministic textured worksheet resembles scanner noise; no student data.
    const width = 3000, height = 4000;
    const pixels = Buffer.alloc(width * height * 3);
    for (let i = 0; i < width * height; i++) { const value = 225 + ((i * 1103515245 + 12345) >>> 16) % 31; pixels.fill(value, i * 3, i * 3 + 3); }
    const text = Buffer.from(`<svg width="${width}" height="${height}"><g font-family="sans-serif" font-size="64" fill="#172554">${Array.from({ length: 20 }, (_, i) => `<text x="120" y="${200 + i * 170}">${i + 1}. 3/4 + 1/4 = 1. Explain your working.</text>`).join("")}</g></svg>`);
    const original = await sharp(pixels, { raw: { width, height, channels: 3 } }).composite([{ input: text }]).jpeg({ quality: 98 }).toBuffer();
    const prepared = await page.evaluate(async b64 => {
      const bytes = Uint8Array.from(atob(b64), c => c.charCodeAt(0)); const start = performance.now();
      const blob = await window.__optimize(new File([bytes], "worksheet.jpg", { type: "image/jpeg" }));
      const data = new Uint8Array(await blob.arrayBuffer()); let encoded = ""; for (let i = 0; i < data.length; i += 8192) encoded += String.fromCharCode(...data.slice(i, i + 8192));
      return { ms: performance.now() - start, b64: btoa(encoded), size: blob.size };
    }, original.toString("base64"));
    const output = Buffer.from(prepared.b64, "base64"); const metadata = await sharp(output).metadata();
    assert.equal(metadata.height, 2560); assert.ok(output.length < original.length);
    writeFileSync(path.join(OUT, "optimized-worksheet.jpg"), output);
    // Shared 5 Mbps link, 150ms RTT per request, identical batch. Compute conservative transfer floor.
    const oldMs = 24 * (original.length * 8 / 5000 + 3 * 150);
    const newMs = 24 * output.length * 8 / 5000 + Math.ceil(24 / 3) * 3 * 150 + 24 * prepared.ms;
    const reduction = 1 - newMs / oldMs;
    assert.ok(reduction >= .5);
    results.push({ name: "Photo size reduction", originalBytes: original.length, optimizedBytes: output.length, preparationMs: prepared.ms, modeledImprovementPercent: reduction * 100 });
    process.stdout.write("Benchmarking identical 24-photo batches at 10 Mbps upload and 150 ms latency…\n");
    const cdp = await context.newCDPSession(page);
    await cdp.send("Network.enable");
    await cdp.send("Network.emulateNetworkConditions", { offline: false, latency: 150, downloadThroughput: 1250000, uploadThroughput: 1250000 });
    const benchmark = await page.evaluate(async b64 => {
      const source = Uint8Array.from(atob(b64), c => c.charCodeAt(0));
      const original = new File([source], "worksheet.jpg", { type: "image/jpeg" });
      const baselineStart = performance.now();
      for (let i = 0; i < 24; i++) await fetch("/__benchmark", { method: "POST", body: original });
      const baselineMs = performance.now() - baselineStart;
      const optimizedStart = performance.now(); let next = 0; let prepare = Promise.resolve();
      await Promise.all(Array.from({ length: 3 }, async () => {
        while (next++ < 24) {
          const ready = prepare.then(() => window.__optimize(original)); prepare = ready.then(() => undefined);
          await fetch("/__benchmark", { method: "POST", body: await ready });
        }
      }));
      return { baselineMs, optimizedMs: performance.now() - optimizedStart };
    }, original.toString("base64"));
    await cdp.send("Network.emulateNetworkConditions", { offline: false, latency: 0, downloadThroughput: -1, uploadThroughput: -1 });
    const improvementPercent = 100 * (1 - benchmark.optimizedMs / benchmark.baselineMs);
    assert.ok(improvementPercent >= 50);
    results.push({ name: "Measured 24-photo browser upload benchmark", ...benchmark, improvementPercent, connection: "Chromium network emulation: shared 10 Mbps upload, 150 ms latency", scope: "Actual HTTP uploads to local fixture, includes serial browser image preparation; excludes real Blob validation and AI provider latency. Physical iPhone remains unverified." });
  });
  assert.deepEqual(errors, []);
  writeFileSync(path.join(OUT, process.argv.includes("--ui-only") ? "ui-regression-results.json" : "acceptance-results.json"), JSON.stringify({ syntheticOnly: true, providerCalls: 0, checks: results, metrics, unverified: ["Physical iPhone", "Live providers and upload storage"] }, null, 2) + "\n");
  process.stdout.write(`Saved ${results.length} checks to ${OUT}\n`);
} finally { clearTimeout(draftTimer); await browser?.close(); await new Promise(resolve => server.close(resolve)); }
