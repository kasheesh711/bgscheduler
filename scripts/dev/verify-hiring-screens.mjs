#!/usr/bin/env node
// Offline, synthetic acceptance checks of the real hiring screens in Chrome. This is not an app route or auth bypass.
// No candidate data, vendor connection, production database or credentials are used: the fixture below replaces fetch.
// Run: node scripts/dev/verify-hiring-screens.mjs [screenshot-folder]
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { mkdirSync, readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { build } from "esbuild";
import postcss from "postcss";
import tailwind from "@tailwindcss/postcss";
import { chromium } from "playwright-core";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const OUT = process.argv[2];
const CHROME = process.env.CHROME_BIN || "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome";

const ENTRY = `
import { Suspense } from "react";
import { createRoot } from "react-dom/client";
import { baseConfigSchema } from "@/lib/hiring/model";
import { HiringDashboard } from "@/components/hiring/dashboard";

const assessment = (summary: string) => ({
  summary, briefSummary: summary, subjects: [{ subject: "Mathematics", relevant: true, evidence: "Taught IGCSE", reason: "Named in the resume" }],
  criteria: ["degree", "subject", "curriculum", "teaching", "english"].map((id) => ({ id, result: "met", evidence: "Taught IGCSE for 2 years", reason: "Seen in the resume", brief: "Clear evidence" })),
});
const person = (id: string, name: string, patch = {}) => ({
  id, name, email: id + "@example.test", stage: "new", seekApplicationId: "seek-" + id, sourceIds: [], applicantId: null, trackerHash: null,
  previouslyContacted: false, visitSubject: null, subjects: ["Mathematics"], inviteExpiresAt: null, reviewNote: null, revision: 1,
  createdAt: "2026-10-20T00:00:00Z", updatedAt: "2026-11-01T00:00:00Z", workRightsAnswer: "I am a Thai citizen", workRightsAccepted: true,
  resumeName: null, resumeType: "application/pdf", resumeSize: 1000, resumeStoredAt: "2026-10-20T00:00:00Z", resumeState: "available",
  profileHash: "h", profileAssessment: assessment("Degree and subject match."), universityAssessment: { name: "Mahidol University", country: "Thailand", fraction: 0.8, reason: "On the reference list", sources: [] },
  preScreen: null, preScreenHash: null, preScreenAssessment: null, preScreenRepliedAt: null, preScreenResubmitted: false, preScreenScore: null, preScreenParts: null,
  paperPassedSubjects: [], paperPassedAt: null, paperRecordedBy: null, hasSourceText: true, profileScore: 86, queueManual: false, ...patch,
});
const candidates = [
  person("a", "Sample Ann"),
  person("b", "Sample Ben", { profileScore: 91, universityAssessment: { name: "Chulalongkorn University", country: "Thailand", fraction: 0.9, reason: "On the reference list", sources: [] } }),
  person("c", "Sample Cho", { profileScore: 74, subjects: ["Physics"], workRightsAnswer: "I require a visa", workRightsAccepted: false, resumeType: "application/vnd.openxmlformats-officedocument.wordprocessingml.document" }),
  person("d", "Sample Dao", { profileScore: 88, stage: "pre_screen", universityAssessment: { name: "Chulalongkorn University", country: "Thailand", fraction: 0.9, reason: "On the reference list", sources: [] } }),
  person("e", "Sample Eve", { profileScore: null, profileAssessment: null, universityAssessment: null, workRightsAnswer: null, workRightsAccepted: false, resumeState: "none", resumeType: null }),
  person("c2", "Sample Fon", { profileScore: 70 }),
  person("t", "Tracker Only", { seekApplicationId: null }),
];
const config = baseConfigSchema.parse({ connectedEmail: "fixture@example.test", seekJobId: "123456", profileThreshold: 80 });
const payload = {
  config, configSaved: true, configProblems: [], revision: 1, workerAt: new Date(Date.now() - 600000).toISOString(), workerError: null, writeGate: true,
  workerSummary: { scanned: 140, imported: 2, remaining: 8, folders: [{ status: "Inbox", count: 120, imported: 112 }, { status: "Prescreen", count: 34, imported: 34 }, { status: "Shortlist", count: 9, imported: 9 }, { status: "Not Suitable", count: 500, imported: 0 }] },
  usage: { preScreen: { perDay: 1, perWeek: 2, waiting: 1, unbooked: 0, bySubject: {} }, onsite: { perDay: 0, perWeek: 0, waiting: 0, unbooked: 0, bySubject: {} } },
  holds: { b: { funnel: "pre_screen", state: "next", position: 0, limit: null, subject: "Mathematics" }, a: { funnel: "pre_screen", state: "held", position: 2, limit: "perDay", subject: "Mathematics" } },
  preScreenOrder: ["b", "a", "c2"], headMocks: {}, heads: {}, candidates, bookings: [],
  visitClashes: { candidateIds: [], stale: false, clashes: {} },
  outbox: [{ id: "o1", key: "d:pre-screen", candidateId: "d", kind: "email", status: "sent", error: null, sentAt: "2026-11-01T03:00:00Z", workflowStage: "pre_screen" }],
  audit: [], tutors: [], google: { connected: true, email: "fixture@example.test", lastError: null },
};
const realFetch = window.fetch;
(window as unknown as { posted: unknown[] }).posted = [];
window.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
  const url = new URL(String(input), location.origin);
  if (url.pathname === "/api/hiring" && init?.method === "POST") {
    const body = JSON.parse(String(init.body));
    (window as unknown as { posted: unknown[] }).posted.push(body);
    if (body.action === "queue_move") {
      const rest = payload.preScreenOrder.filter((id) => id !== body.id && !body.ahead.includes(id));
      payload.preScreenOrder = [...body.ahead, body.id, ...rest];
      payload.candidates.find((c) => c.id === body.id)!.queueManual = true;
    }
    if (body.action === "queue_reset") {
      payload.preScreenOrder = ["b", "a", "c2"];
      payload.candidates.forEach((c) => { c.queueManual = false; });
    }
    return new Response(JSON.stringify({ ok: true }));
  }
  if (url.pathname === "/api/hiring" && url.searchParams.get("candidateId"))
    return new Response(JSON.stringify({ id: url.searchParams.get("candidateId"), profileText: "Extracted resume text for the fixture." }));
  if (url.pathname === "/api/hiring") return new Response(JSON.stringify(payload));
  return realFetch(input, init);
}) as typeof fetch;
createRoot(document.getElementById("root")!).render(<Suspense fallback="Loading"><HiringDashboard /></Suspense>);
`;

// Only the framework parts that need a Next.js server are replaced. The components stay real.
const NAVIGATION = `
import { useSyncExternalStore } from "react";
const change = "synthetic-url-change";
const push = window.history.pushState.bind(window.history);
window.history.pushState = (...args) => { push(...args); window.dispatchEvent(new Event(change)); };
const subscribe = (fn) => { window.addEventListener(change, fn); window.addEventListener("popstate", fn); return () => { window.removeEventListener(change, fn); window.removeEventListener("popstate", fn); }; };
export const useSearchParams = () => new URLSearchParams(useSyncExternalStore(subscribe, () => location.search));
`;
const bundled = await build({
  stdin: { contents: ENTRY, resolveDir: ROOT, sourcefile: "hiring-synthetic.tsx", loader: "tsx" },
  bundle: true, write: false, outdir: "out", platform: "browser", format: "iife", target: "es2022", jsx: "automatic", tsconfig: path.join(ROOT, "tsconfig.json"),
  define: { "process.env.NODE_ENV": JSON.stringify("production") }, minify: true, logLevel: "error", logOverride: { "module-level-directive": "silent" },
  plugins: [{ name: "synthetic-framework", setup(bundler) {
    bundler.onResolve({ filter: /^next\/navigation$/ }, () => ({ path: "navigation", namespace: "fixture" }));
    bundler.onResolve({ filter: /^next\/font\/google$/ }, () => ({ path: "font", namespace: "fixture" }));
    bundler.onResolve({ filter: /^next-auth\/react$/ }, () => ({ path: "auth", namespace: "fixture" }));
    bundler.onLoad({ filter: /^navigation$/, namespace: "fixture" }, () => ({ contents: NAVIGATION, resolveDir: ROOT }));
    bundler.onLoad({ filter: /^font$/, namespace: "fixture" }, () => ({ contents: "export const Instrument_Serif = () => ({ variable: '' });" }));
    bundler.onLoad({ filter: /^auth$/, namespace: "fixture" }, () => ({ contents: "export const signIn = async () => {};" }));
  } }],
});
const script = bundled.outputFiles.find((f) => f.path.endsWith(".js")).text;
const moduleCss = bundled.outputFiles.find((f) => f.path.endsWith(".css"))?.text ?? "";
const from = path.join(ROOT, "src/app/globals.css");
const globalCss = (await postcss([tailwind({ base: ROOT })]).process(readFileSync(from, "utf8"), { from })).css;
const html = `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><style>${globalCss}${moduleCss}#root{display:flex;flex-direction:column;height:100vh;padding:12px 24px;overflow:hidden}</style></head><body><div id="root"></div><script>${script.replaceAll("</script", "<\\/script")}</script></body></html>`;
const PDF = "%PDF-1.4\n1 0 obj<</Type/Catalog/Pages 2 0 R>>endobj\n2 0 obj<</Type/Pages/Count 1/Kids[3 0 R]>>endobj\n3 0 obj<</Type/Page/Parent 2 0 R/MediaBox[0 0 300 200]>>endobj\ntrailer<</Root 1 0 R>>\n%%EOF";

const resumeRequests = [];
const server = createServer((request, response) => {
  const url = new URL(request.url, "http://localhost");
  if (url.pathname.startsWith("/api/hiring/resume/")) {
    resumeRequests.push(url.pathname.split("/").pop());
    response.writeHead(200, { "Content-Type": "application/pdf" });
    response.end(PDF);
    return;
  }
  response.writeHead(200, { "Content-Type": "text/html" });
  response.end(html);
});
await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
const origin = `http://127.0.0.1:${server.address().port}`;

let browser;
const shot = async (page, name) => {
  if (!OUT) return;
  mkdirSync(OUT, { recursive: true });
  await page.screenshot({ path: path.join(OUT, `${name}.png`) });
};
const check = async (name, action) => {
  await action();
  process.stdout.write(`PASS ${name}\n`);
};
try {
  browser = await chromium.launch({ executablePath: CHROME, headless: true });
  const context = await browser.newContext({ viewport: { width: 1440, height: 900 } });
  await context.route("**/*", (route) => (route.request().url().startsWith(origin) ? route.continue() : route.abort()));
  const page = await context.newPage();
  const errors = [];
  page.on("pageerror", (error) => {
    errors.push(error.message);
    process.stderr.write(`PAGE ERROR ${error.message}\n`);
  });
  const names = () => page.locator("[data-candidate]").allInnerTexts();
  const seekRows = () => page.getByRole("region", { name: "Candidates from SEEK" }).locator("tbody tr");

  await check("the tab opens from the address and changes the address", async () => {
    await page.goto(`${origin}/?view=seek`);
    await page.getByRole("button", { name: "1 Seek intake" }).waitFor();
    assert.equal(await page.getByRole("button", { name: "1 Seek intake" }).getAttribute("aria-pressed"), "true");
    await page.getByRole("button", { name: "Overview" }).click();
    assert.match(page.url(), /view=overview/);
    await page.getByLabel("Filter by stage").waitFor();
    await page.goBack();
    assert.match(page.url(), /view=seek/);
    await page.locator("[data-candidate]").first().waitFor();
  });
  await check("coverage shows SEEK against imported", async () => {
    const coverage = page.getByRole("region", { name: "SEEK coverage" });
    assert.ok(await coverage.getByText("112 / 120").isVisible());
    assert.ok(await coverage.getByText("8 waiting").isVisible());
    assert.equal(await coverage.getByText("Not Suitable").count(), 0);
  });
  await check("the list leaves out tracker-only people and starts with the top score", async () => {
    const all = await names();
    assert.deepEqual(all, ["Sample Ben", "Sample Dao", "Sample Ann", "Sample Cho", "Sample Fon", "Sample Eve"]);
    await shot(page, "seek-all");
  });
  await check("the send queue is numbered, then shows who was sent", async () => {
    await page.getByRole("button", { name: "Send queue" }).click();
    assert.deepEqual(await names(), ["Sample Ben", "Sample Ann", "Sample Fon", "Sample Dao"]);
    const cells = await seekRows().locator("td:first-child").allInnerTexts();
    assert.deepEqual(cells.map((text) => text.replace(/[↑↓\s]/g, "")), ["1", "2", "3", "Sent"]);
    await shot(page, "seek-queue");
  });
  await check("a drag and the arrow buttons change the order and post only the move", async () => {
    const row = (name) => seekRows().filter({ hasText: name });
    await row("Sample Fon").dragTo(row("Sample Ben"));
    await seekRows().first().getByText("Moved by hand").waitFor();
    assert.deepEqual(await names(), ["Sample Fon", "Sample Ben", "Sample Ann", "Sample Dao"]);
    await page.getByRole("button", { name: "Move Sample Ann up" }).click();
    await page.waitForFunction(() => window.posted.length === 2);
    await seekRows().nth(1).filter({ hasText: "Sample Ann" }).waitFor();
    assert.deepEqual((await names()).slice(0, 3), ["Sample Fon", "Sample Ann", "Sample Ben"]);
    await shot(page, "seek-queue-moved");
    const posted = await page.evaluate(() => window.posted);
    assert.deepEqual(posted.map((p) => p.action), ["queue_move", "queue_move"]);
    assert.deepEqual(posted[0], { action: "queue_move", id: "c2", ahead: [] });
    await page.getByRole("button", { name: "Back to automatic order" }).click();
    await page.waitForFunction(() => window.posted.length === 3);
    await page.waitForFunction(() => !document.body.innerText.includes("Moved by hand"));
    assert.deepEqual((await names()).slice(0, 3), ["Sample Ben", "Sample Ann", "Sample Fon"]);
    await page.getByRole("button", { name: "All candidates" }).click();
  });
  await check("university names filter the list, and several can be picked", async () => {
    await page.getByText("University: all").click();
    await page.getByLabel("Search university names").fill("mahidol");
    await page.getByRole("checkbox", { name: /Mahidol/ }).check();
    assert.deepEqual(await names(), ["Sample Ann", "Sample Cho", "Sample Fon"]);
    await page.getByLabel("Search university names").fill("");
    await page.getByRole("checkbox", { name: /Chulalongkorn/ }).check();
    assert.deepEqual(await names(), ["Sample Ben", "Sample Dao", "Sample Ann", "Sample Cho", "Sample Fon"]);
    await shot(page, "seek-university");
    await page.getByRole("button", { name: "Clear filters" }).click();
    await page.getByText(/University: all/).click();
  });
  await check("the exact work rights answer filters the list", async () => {
    await page.getByLabel("Work rights").selectOption("I require a visa");
    assert.deepEqual(await names(), ["Sample Cho"]);
    await page.getByRole("button", { name: "Clear filters" }).click();
  });
  await check("a click opens the resume, and the arrow keys move between people", async () => {
    await seekRows().first().click();
    const panel = page.getByRole("complementary", { name: "Résumé and score of Sample Ben" });
    await panel.waitFor();
    await panel.getByTitle("Original résumé of Sample Ben").waitFor();
    await shot(page, "seek-panel");
    await page.keyboard.press("ArrowDown");
    await page.getByRole("complementary", { name: "Résumé and score of Sample Dao" }).waitFor();
    assert.equal(await page.evaluate(() => document.activeElement?.textContent), "Sample Dao");
    await page.keyboard.press("ArrowUp");
    await page.getByRole("complementary", { name: "Résumé and score of Sample Ben" }).waitFor();
    assert.ok(resumeRequests.includes("d"));
  });
  await check("a Word resume shows a download and the extracted text", async () => {
    await page.locator("[data-candidate]", { hasText: "Sample Cho" }).click();
    const panel = page.getByRole("complementary", { name: "Résumé and score of Sample Cho" });
    await panel.getByRole("link", { name: "Download" }).waitFor();
    await panel.getByText("Extracted resume text for the fixture.").waitFor();
    assert.equal(await panel.locator("iframe").count(), 0);
    assert.ok(await panel.getByText("I require a visa").isVisible());
  });
  await check("the page has no script errors", async () => assert.deepEqual(errors, []));
} finally {
  await browser?.close();
  server.close();
}
