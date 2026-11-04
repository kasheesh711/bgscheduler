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
  id, name, email: id + "@example.test", stage: "new", seekApplicationId: "seek-" + id, seekJobId: "123456", sourceIds: [], applicantId: null, trackerHash: null,
  previouslyContacted: false, visitSubject: null, subjects: ["Mathematics"], inviteExpiresAt: null, reviewNote: null, revision: 1,
  createdAt: "2026-10-20T00:00:00Z", updatedAt: "2026-11-01T00:00:00Z", workRightsAnswer: "I am a Thai citizen", workRightsAccepted: true,
  resumeName: null, resumeType: "application/pdf", resumeSize: 1000, resumeStoredAt: "2026-10-20T00:00:00Z", resumeState: "available",
  profileHash: "h", profileAssessment: assessment("Degree and subject match."), universityAssessment: { name: "Mahidol University", country: "Thailand", fraction: 0.8, reason: "On the reference list", sources: [] },
  preScreen: null, preScreenHash: null, preScreenAssessment: null, preScreenRepliedAt: null, preScreenResubmitted: false, preScreenScore: null, preScreenParts: null,
  paperPassedSubjects: [], paperPassedAt: null, paperRecordedBy: null, hasSourceText: true, profileScore: 86, queueManual: false, preScreenOverride: null as unknown, ...patch,
});
const answers = {
  sourceRow: 2, submittedAt: "1/11/2026, 05:00:00", degree: "Bachelor's", field: "Mathematics", subjects: "Mathematics", curricula: "IGCSE", yearGroups: "Year 10", english: "Advanced (C1)", englishEvidence: "",
  experience: "5+ years", portfolio: "", availability: "Weekend Morning", weeklyHours: "20", motivation: "I like teaching.", teachingApproach: "Worked examples, then the student tries one.",
};
const parts = { degree: 10, subject: 10, curriculum: 10, teaching: 10, english: 10, prestige: 10, written: 12, availability: 10, total: 82 };
const candidates = [
  person("a", "Sample Ann"),
  person("b", "Sample Ben", { profileScore: 91, universityAssessment: { name: "Chulalongkorn University", country: "Thailand", fraction: 0.9, reason: "On the reference list", sources: [] } }),
  person("c", "Sample Cho", { profileScore: 74, subjects: ["Physics"], workRightsAnswer: "I require a visa", workRightsAccepted: false, resumeType: "application/vnd.openxmlformats-officedocument.wordprocessingml.document" }),
  person("d", "Sample Dao", { profileScore: 88, stage: "pre_screen", universityAssessment: { name: "Chulalongkorn University", country: "Thailand", fraction: 0.9, reason: "On the reference list", sources: [] } }),
  person("e", "Sample Eve", { seekJobId: "654321", profileScore: null, profileAssessment: null, universityAssessment: null, workRightsAnswer: null, workRightsAccepted: false, resumeState: "none", resumeType: null }),
  person("c2", "Sample Fon", { profileScore: 70 }),
  person("t", "Tracker Only", { seekApplicationId: null }),
  // Kept out of the SEEK list, so the Seek checks below are unchanged. The Calls tab reads callOrder only.
  person("k", "Sample Kim", { seekApplicationId: null, profileScore: 95, callReview: { good: null, tries: [{ at: "2026-11-03T02:00:00Z", by: "hr@example.test" }] } }),
  person("r1", "Reply Passed", { seekApplicationId: null, stage: "onsite_invited", preScreen: answers, preScreenHash: "x", preScreenAssessment: { ...assessment("Clear answers."), universities: [] }, preScreenScore: 82, preScreenParts: parts }),
  person("r2", "Reply Low", { seekApplicationId: null, stage: "review", preScreen: answers, preScreenHash: "y", preScreenAssessment: { ...assessment("Thin answers."), universities: [] }, preScreenScore: 41, preScreenParts: parts }),
  person("r3", "No Reply Yet", { seekApplicationId: null, stage: "pre_screen" }),
];
const config = baseConfigSchema.parse({ connectedEmail: "fixture@example.test", seekJobs: [{ jobId: "123456", label: "Tutor ad", active: false }, { jobId: "654321", label: "Nov ad", active: true }], profileThreshold: 80, preScreenThreshold: 50 });
const payload = {
  config, configSaved: true, configProblems: [], revision: 1, workerAt: new Date(Date.now() - 600000).toISOString(), workerError: null, writeGate: true,
  workerSummary: { scanned: 140, imported: 2, remaining: 8, folders: [{ status: "Inbox", count: 120, imported: 112 }, { status: "Prescreen", count: 34, imported: 34 }, { status: "Shortlist", count: 9, imported: 9 }, { status: "Not Suitable", count: 500, imported: 0 }] },
  usage: { preScreen: { perDay: 1, perWeek: 2, waiting: 1, unbooked: 0, bySubject: {} }, onsite: { perDay: 0, perWeek: 0, waiting: 0, unbooked: 0, bySubject: {} } },
  holds: { b: { funnel: "pre_screen", state: "next", position: 0, limit: null, subject: "Mathematics" }, a: { funnel: "pre_screen", state: "held", position: 2, limit: "perDay", subject: "Mathematics" } },
  preScreenOrder: ["b", "a", "c2"], callOrder: ["k", "b"], headMocks: {}, heads: {}, candidates, bookings: [],
  visitClashes: { candidateIds: [], stale: false, clashes: {} },
  outbox: [
    { id: "o2", key: "r1:visit-invite", candidateId: "r1", kind: "email", status: "sent", error: null, sentAt: "2026-11-02T03:04:00Z", workflowStage: "onsite_invited" },
    { id: "o3", key: "r1:pre-screen", candidateId: "r1", kind: "email", status: "sent", error: null, sentAt: "2026-11-01T03:00:00Z", workflowStage: "pre_screen" },
    { id: "o4", key: "r2:pre-screen", candidateId: "r2", kind: "email", status: "sent", error: null, sentAt: "2026-11-01T03:00:00Z", workflowStage: "pre_screen" },
    { id: "o5", key: "r3:pre-screen", candidateId: "r3", kind: "email", status: "sent", error: null, sentAt: "2026-11-01T03:00:00Z", workflowStage: "pre_screen" },
    { id: "o1", key: "d:pre-screen", candidateId: "d", kind: "email", status: "sent", error: null, sentAt: "2026-11-01T03:00:00Z", workflowStage: "pre_screen" },
  ],
  inviteOutbox: [] as unknown[],
  papers: [] as unknown[], mocks: [] as unknown[], decisions: [] as unknown[], library: [] as unknown[], markingSpend: { usd: 0, complete: true },
  audit: [], tutors: [], google: { connected: true, email: "fixture@example.test", lastError: null },
};
payload.inviteOutbox = payload.outbox;
const markQuestions = (level: string, marks: number[]) => marks.map((value, i) => ({ id: level[0] + (i + 1), level, marks: value, max: 10, reason: "Correct method", attempted: true, readable: true }));
const visitFor = (candidateId: string, visitId: string, startIso: string, head: string, subject: string) => [
  { id: visitId + "e", candidateId, kind: "paper", status: "confirmed", startTime: startIso, endTime: startIso, visitId, interviewerKey: null, subjects: [subject] },
  { id: visitId + "m", candidateId, kind: "mock", status: "confirmed", startTime: new Date(new Date(startIso).getTime() + 7200000).toISOString(), endTime: startIso, visitId, interviewerKey: head, subjects: [subject] },
];
payload.bookings = [...visitFor("r1", "v1", "2026-11-01T03:00:00Z", "Peat", "Mathematics"), ...visitFor("r2", "v2", new Date(Date.now() + 86400000).toISOString(), "Ek", "Physics")] as never[];
payload.tutors = [{ canonicalKey: "Peat", name: "Kru Peat", email: "p@example.test", lineReady: true }, { canonicalKey: "Ek", name: "Kru Ek", email: "e@example.test", lineReady: true }] as never[];
payload.config.interviewers = [{ canonicalKey: "Peat", email: "p@example.test", subjects: ["Mathematics"] }, { canonicalKey: "Ek", email: "e@example.test", subjects: ["Physics"] }] as never[];
payload.config.paperPassRules = [{ subject: "Mathematics", level: "Key Stage 3", percent: 50 }, { subject: "Mathematics", level: "AS / A-Level", percent: 50 }, { subject: "Mathematics", level: "IB SL / HL", percent: 60 }];
payload.papers = [{ id: "p1", candidateId: "r1", bookingId: "v1e", subject: "Mathematics", source: "ai", status: "done", fileId: "f1", updatedAt: "2026-11-02T00:00:00.000Z", markSchemeUsed: false, history: null, error: null, changedBy: null, marks: { missingPages: null, comment: "Strong algebra. Weak on IB vectors.", questions: [...markQuestions("Key Stage 3", [9, 9]), ...markQuestions("AS / A-Level", [6, 5]), ...markQuestions("IB SL / HL", [3, 4])] } }];
payload.mocks = [{ id: "m1", candidateId: "r1", bookingId: "v1m", subject: "Mathematics", source: "ai", status: "done", fileId: "f2", updatedAt: "2026-11-02T00:00:00.000Z", history: null, error: null, changedBy: null, rubric: { comments: "Clear explanations.", items: { accuracy: 10, concepts: 10, clarity: 7, presentation: 7, interaction: 10, pace: 7, organization: 10, materials: 7, formative: 7, feedback: 9 } } }];
const realFetch = window.fetch;
(window as unknown as { posted: unknown[] }).posted = [];
(window as unknown as { uploaded: unknown[] }).uploaded = [];
window.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
  const url = new URL(String(input), location.origin);
  if (url.pathname === "/api/hiring/marking") {
    (window as unknown as { posted: unknown[] }).posted.push({ marking: JSON.parse(String(init?.body)) });
    if (JSON.parse(String(init?.body)).kind === "mock") {
      Object.assign((payload.mocks as Record<string, unknown>[]).find((row) => row.id === "m2")!, { status: "needs_check", rubric: { comments: "Good pace.", items: { accuracy: 10, concepts: 7, clarity: 7, presentation: 7, interaction: 7, pace: 7, organization: 7, materials: 7, formative: 4, feedback: null } } });
      return new Response(JSON.stringify({ status: "needs_check", error: null }));
    }
    const paper = (payload.papers as Record<string, unknown>[]).find((row) => row.id === "p2")!;
    Object.assign(paper, { status: "needs_check", markSchemeUsed: true, marks: { missingPages: "Page 4", comment: "Part could not be read.", questions: [...markQuestions("IGCSE / GCSE", [7]), { id: "Q9", level: "IGCSE / GCSE", marks: null, max: 10, reason: "Unreadable", attempted: true, readable: false }] } });
    return new Response(JSON.stringify({ status: "needs_check", error: null }));
  }
  if (url.pathname === "/api/hiring" && init?.method === "POST") {
    const body = JSON.parse(String(init.body));
    (window as unknown as { posted: unknown[] }).posted.push(body);
    if (body.action === "file_intent" && body.kind !== "mock_rubric") return new Response(JSON.stringify({ id: "f9", pathname: "hiring-assessment/f9.pdf" }));
    if (body.action === "file_intent" && body.kind === "mock_rubric") return new Response(JSON.stringify({ id: "f8", pathname: "hiring-assessment/f8.pdf" }));
    if (body.action === "file_ready" && body.id === "f8") {
      (payload.mocks as Record<string, unknown>[]).push({ id: "m2", candidateId: "r2", bookingId: "v2m", subject: "Physics", source: "ai", status: "uploaded", fileId: "f8", updatedAt: "2026-11-02T00:00:00.000Z", history: null, error: null, changedBy: null, rubric: null });
      return new Response(JSON.stringify({ ok: true, resultId: "m2" }));
    }
    if (body.action === "file_ready") {
      (payload.papers as Record<string, unknown>[]).push({ id: "p2", candidateId: "r2", bookingId: "v2e", subject: "Physics", source: "ai", status: "uploaded", fileId: "f9", updatedAt: "2026-11-02T00:00:00.000Z", markSchemeUsed: null, history: null, error: null, changedBy: null, marks: null });
      return new Response(JSON.stringify({ ok: true, resultId: "p2" }));
    }
    if (body.action === "decision_draft") (payload.decisions as Record<string, unknown>[]).unshift({ id: "d1", candidateId: body.id, decision: body.decision, status: "draft", reason: body.reason, emailSubject: "Your BeGifted tutor application", emailBody: "Dear Reply Passed, we are pleased.", outboxKey: null, decidedBy: "fixture", createdAt: "", sentAt: null });
    if (body.action === "decision_discard") (payload.decisions as Record<string, unknown>[]).splice(0, 1);
    if (body.action === "result_check") ((body.kind === "mock" ? payload.mocks : payload.papers) as Record<string, unknown>[]).find((row) => row.id === body.id)!.status = "done";
    if (body.action === "mock_edit") {
      const mock = (payload.mocks as { id: string; changedBy: string | null; rubric: { comments: string; items: Record<string, number | null> } }[]).find((row) => row.id === body.id)!;
      mock.changedBy = "fixture";
      mock.rubric = { comments: body.comments, items: { ...mock.rubric.items, ...body.items } };
    }
    if (body.action === "paper_edit") {
      const paper = (payload.papers as { id: string; changedBy: string | null; marks: { comment: string; questions: { id: string; marks: number | null; readable: boolean }[] } }[]).find((row) => row.id === body.id)!;
      paper.changedBy = "fixture";
      paper.marks.comment = body.comment;
      paper.marks.questions = paper.marks.questions.map((q) => (q.id in body.marks ? { ...q, marks: body.marks[q.id], readable: true } : q));
    }
    if (body.action === "queue_move") {
      const rest = payload.preScreenOrder.filter((id) => id !== body.id && !body.ahead.includes(id));
      payload.preScreenOrder = [...body.ahead, body.id, ...rest];
      payload.candidates.find((c) => c.id === body.id)!.queueManual = true;
    }
    if (body.action === "pre_screen_score") {
      payload.candidates.find((c) => c.id === body.id)!.preScreenOverride = { score: body.score, reason: body.reason, by: "fixture", at: "" };
    }
    if (body.action === "queue_reset") {
      payload.preScreenOrder = ["b", "a", "c2"];
      payload.candidates.forEach((c) => { c.queueManual = false; });
    }
    return new Response(JSON.stringify({ ok: true }));
  }
  if (url.pathname === "/api/hiring" && url.searchParams.get("candidateId"))
    return new Response(JSON.stringify({ id: url.searchParams.get("candidateId"), profileText: "Extracted resume text for the fixture." }));
  if (url.pathname === "/api/hiring" && url.searchParams.get("head"))
    return new Response(JSON.stringify({ name: "Kru Peat", subjects: ["Mathematics"], days: [0, 1, 2, 3, 4].map((i) => ({ date: "2026-11-0" + (2 + i), office: { start: "09:00", end: "18:00" }, blocks: [] })), visits: [], mocks: 0, limit: 2, stale: false, staleReason: null, weekStart: "2026-11-02", head: "Peat" }));
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
    bundler.onResolve({ filter: /^@vercel\/blob\/client$/ }, () => ({ path: "blob-client", namespace: "fixture" }));
    bundler.onLoad({ filter: /^blob-client$/, namespace: "fixture" }, () => ({ contents: "export const upload = async (pathname) => { window.uploaded.push(pathname); return { pathname }; };" }));
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

  await check("the Calls tab lists HR's queue and posts each result", async () => {
    await page.goto(`${origin}/?view=calls`);
    const calls = page.getByRole("region", { name: "Candidates for HR to call" });
    await calls.getByText("Sample Kim").waitFor();
    assert.ok(await calls.getByText("1 no answer · last 3 Nov, 09:00").isVisible());
    await shot(page, "calls");
    const ben = calls.getByRole("link", { name: "View on SEEK for Sample Ben (opens in a new tab)" });
    assert.match(await ben.getAttribute("href"), /^https:\/\/th\.employer\.seek\.com\/candidates\/\?jobid=\d+&selected=[^&]+&tab=profile$/);
    assert.equal(await ben.getAttribute("target"), "_blank");
    assert.ok(await calls.getByText("Chulalongkorn University").isVisible());
    await calls.getByRole("button", { name: "Good call" }).first().click();
    await page.waitForFunction(() => window.posted.length === 1);
    await calls.getByRole("button", { name: "No answer" }).first().click();
    await page.waitForFunction(() => window.posted.length === 2);
    page.once("dialog", (dialog) => dialog.accept());
    await calls.getByRole("button", { name: "Bad call" }).first().click();
    await page.waitForFunction(() => window.posted.length === 3);
    const posted = await page.evaluate(() => window.posted);
    assert.deepEqual(posted.slice(0, 2), [
      { action: "call_result", id: "k", result: "good" },
      { action: "call_result", id: "k", result: "no_answer" },
    ]);
    assert.equal(posted[2].action, "stop");
    await calls.getByText("Sample Kim").click();
    await page.getByRole("complementary", { name: "Résumé and score of Sample Kim" }).waitFor();
  });
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
  await check("the campaign filter shows one job's applicants, and each row names its campaign", async () => {
    const pick = page.getByRole("region", { name: "Candidates from SEEK" }).getByLabel("Campaign");
    await pick.selectOption("654321");
    assert.deepEqual(await names(), ["Sample Eve"]);
    assert.ok(await seekRows().first().getByText("Nov ad", { exact: false }).isVisible());
    await shot(page, "seek-campaign");
    await pick.selectOption("");
    assert.equal((await names()).length, 6);
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
  await check("the pre-screen tab lists everyone sent a form, with proof of the visit email", async () => {
    await page.getByRole("button", { name: "3 Pre-screen" }).click();
    const list = page.getByRole("region", { name: "Pre-screen responses" });
    const rows = list.locator("tbody tr");
    await rows.first().waitFor();
    assert.deepEqual((await list.locator("tbody button").allInnerTexts()).slice(0, 2), ["Reply Passed", "Reply Low"]);
    assert.ok(!(await list.getByText("Sample Ann").count()));
    await list.getByText("Sent 2 Nov, 10:04").waitFor();
    await list.getByText("Not sent: below pass score").waitFor();
    await list.getByText("Waiting for reply").first().waitFor();
    await shot(page, "prescreen-list");
    await list.getByRole("button", { name: /^Below pass score/ }).click();
    assert.deepEqual(await list.locator("tbody button").allInnerTexts(), ["Reply Low"]);
    await list.getByRole("button", { name: /^All/ }).click();
  });
  await check("the panel shows full answers, AI reasons and actions, and a score change posts only the change", async () => {
    await page.getByRole("region", { name: "Pre-screen responses" }).getByRole("button", { name: "Reply Low" }).click();
    const panel = page.getByRole("complementary", { name: "Pre-screen of Reply Low" });
    await panel.getByText("Worked examples, then the student tries one.").waitFor();
    assert.ok(await panel.getByText("Why the AI scored it this way").isVisible());
    assert.ok(await panel.getByRole("button", { name: "Invite despite low score" }).isDisabled());
    await panel.getByLabel("Reason").fill("Strong in a call");
    await panel.getByLabel("New score").fill("70");
    await panel.getByRole("button", { name: "Change score" }).click();
    await panel.getByText("changed the AI score").waitFor();
    assert.ok(await panel.getByRole("button", { name: "Invite to visit" }).isVisible());
    await shot(page, "prescreen-panel");
    const posted = await page.evaluate(() => window.posted);
    assert.deepEqual(posted.at(-1), { action: "pre_screen_score", id: "r2", revision: 1, score: 70, reason: "Strong in a call" });
  });
  await check("the mock and paper tab lists visits with date, head and results", async () => {
    await page.getByRole("button", { name: "4 Mock and paper" }).click();
    const list = page.getByRole("region", { name: "Mock and paper" });
    await list.locator("tbody tr").first().waitFor();
    assert.deepEqual(await list.locator("tbody button").allInnerTexts(), ["Reply Low", "Reply Passed"]);
    await list.getByRole("cell", { name: "Kru Peat" }).waitFor();
    await list.getByText("Mathematics: 60% · AS / A-Level").waitFor();
    await list.getByText("84 / 100").waitFor();
    await shot(page, "assessment-list");
    await list.getByLabel("Head").selectOption("Peat");
    assert.deepEqual(await list.locator("tbody button").allInnerTexts(), ["Reply Passed"]);
    await list.getByLabel("Head").selectOption("");
    await list.getByRole("button", { name: /^Ready to decide/ }).click();
    assert.deepEqual(await list.locator("tbody button").allInnerTexts(), ["Reply Passed"]);
    await list.getByRole("button", { name: /^Ready to decide/ }).click();
  });
  await check("the panel tabulates the marking sheet and the rubric from the marks", async () => {
    await page.getByRole("region", { name: "Mock and paper" }).getByRole("button", { name: "Reply Passed" }).click();
    const panel = page.getByRole("complementary", { name: "Assessment of Reply Passed" });
    const sheet = panel.getByRole("region", { name: "Paper marking sheet for Mathematics" });
    await sheet.getByRole("row", { name: /Key Stage 3 18 \/ 20 50% Passed/ }).waitFor();
    await sheet.getByRole("row", { name: /IB SL \/ HL 7 \/ 20 60% Not passed/ }).waitFor();
    await sheet.getByRole("row", { name: /IGCSE \/ GCSE – – Not done/ }).waitFor();
    await sheet.getByText("Marked without a mark scheme").waitFor();
    assert.ok(await sheet.getByRole("definition").filter({ hasText: "AS / A-Level" }).isVisible());
    const rubric = panel.getByRole("region", { name: "Mock rubric" });
    await rubric.getByRole("row", { name: /Total 84 \/ 100/ }).waitFor();
    await shot(page, "assessment-panel");
  });
  await check("uploading a scan on the row marks it, and a person clears the check", async () => {
    const list = page.getByRole("region", { name: "Mock and paper" });
    await page.locator("input[type=file][aria-label='Upload PDF for the Physics paper']").setInputFiles({ name: "scan.pdf", mimeType: "application/pdf", buffer: Buffer.from("%PDF-1.4 fixture") });
    await list.getByText("Physics: Needs check").waitFor();
    const posted = await page.evaluate(() => window.posted);
    assert.deepEqual(posted.slice(-3).map((p) => p.action ?? "marking"), ["file_intent", "file_ready", "marking"]);
    assert.deepEqual(posted.at(-1), { marking: { kind: "paper", id: "p2" } });
    assert.deepEqual(posted.at(-3), { action: "file_intent", kind: "paper_scan", subject: "Physics", candidateId: "r2", name: "scan.pdf", size: 16 });
    await list.getByRole("button", { name: /^Needs check/ }).click();
    assert.deepEqual(await list.locator("tbody button").allInnerTexts(), ["Reply Low"]);
    await list.getByRole("button", { name: /^Needs check/ }).click();
    await list.getByRole("button", { name: "Reply Low" }).click();
    const sheet = page.getByRole("region", { name: "Paper marking sheet for Physics" });
    await sheet.getByText("Missing pages: Page 4").waitFor();
    await sheet.getByRole("button", { name: "Change marks" }).click();
    await sheet.getByLabel("Marks for question Q9").fill("6");
    await sheet.getByRole("button", { name: "Save marks" }).click();
    await sheet.getByText("Changed by").waitFor();
    await shot(page, "assessment-needs-check");
    await sheet.getByRole("button", { name: "I have checked this" }).click();
    await list.getByText(/^Physics: \d+%/).waitFor();
    await page.getByRole("complementary", { name: "Assessment of Reply Low" }).getByRole("button", { name: "Close" }).click();
  });
  await check("uploading a mock rubric reads it, a person fills the blank, and the total adds up", async () => {
    const list = page.getByRole("region", { name: "Mock and paper" });
    await page.locator("input[type=file][aria-label='Upload rubric for the mock in Physics']").first().setInputFiles({ name: "rubric.pdf", mimeType: "application/pdf", buffer: Buffer.from("%PDF-1.4 fixture") });
    await list.getByText("Needs check", { exact: true }).first().waitFor();
    const posted = await page.evaluate(() => window.posted);
    assert.deepEqual(posted.at(-1), { marking: { kind: "mock", id: "m2" } });
    await list.getByRole("button", { name: "Reply Low" }).click();
    const rubric = page.getByRole("region", { name: "Mock rubric" });
    await rubric.getByRole("row", { name: /Total 63 \/ 100/ }).waitFor();
    await rubric.getByRole("button", { name: "Change scores" }).click();
    await rubric.getByLabel("Score for Feedback Quality").fill("9");
    await rubric.getByRole("button", { name: "Save scores" }).click();
    await rubric.getByRole("row", { name: /Total 72 \/ 100/ }).waitFor();
    await rubric.getByRole("button", { name: "I have checked this" }).click();
    await list.getByText("72 / 100").waitFor();
    assert.deepEqual((await page.evaluate(() => window.posted)).at(-2).items, { feedback: 9 });
    await page.getByRole("complementary", { name: "Assessment of Reply Low" }).getByRole("button", { name: "Close" }).click();
  });
  await check("a decision saves a draft and previews the email, and Send refuses while the switches are off", async () => {
    const list = page.getByRole("region", { name: "Mock and paper" });
    await list.getByRole("button", { name: "Reply Passed" }).click();
    const panel = page.getByRole("complementary", { name: "Assessment of Reply Passed" });
    const box = panel.getByRole("region", { name: "Decision" });
    assert.ok(await box.getByRole("button", { name: "Reject: preview email" }).isDisabled());
    await box.getByRole("button", { name: "Hire: preview email" }).click();
    await box.getByLabel("Email message").waitFor();
    await list.getByText("Draft: Hire").waitFor();
    await box.getByText("Automation and Messages are off").waitFor();
    await box.getByText("r1@example.test").waitFor();
    await box.getByLabel("Email message").fill("Edited by a person.");
    await box.getByRole("button", { name: "Save draft" }).click();
    await page.waitForFunction(() => window.posted.at(-1).action === "decision_save");
    assert.ok(await box.getByRole("button", { name: "Send email" }).isDisabled());
    await shot(page, "decision-draft");
    assert.ok(!(await page.evaluate(() => window.posted)).some((p) => p.action === "decision_send"));
    await box.getByRole("button", { name: "Discard" }).click();
    await box.getByRole("button", { name: "Hire: preview email" }).waitFor();
    await box.getByLabel("Reason").fill("Not a fit for this level");
    assert.ok(await box.getByRole("button", { name: "Reject: preview email" }).isEnabled());
    await panel.getByRole("button", { name: "Close" }).click();
  });
  await check("the calendar switch opens the head schedule", async () => {
    await page.getByRole("region", { name: "Mock and paper" }).getByRole("group", { name: "View" }).getByRole("button", { name: "Calendar" }).click();
    await page.getByRole("region", { name: "Mock and paper" }).getByRole("group", { name: "View" }).getByRole("button", { name: "List" }).click();
  });
  await check("settings hold the pass marks and the paper library", async () => {
    await page.getByRole("button", { name: "Rules and setup" }).click();
    assert.equal(await page.getByLabel("Mathematics Key Stage 3 pass percentage").inputValue(), "50");
    await page.getByRole("heading", { name: "Paper library" }).waitFor();
    assert.ok((await page.getByText("Missing").count()) > 0);
    await page.getByLabel("Mathematics Key Stage 3 pass percentage").scrollIntoViewIfNeeded();
    await shot(page, "assessment-settings");
    assert.equal(await page.getByLabel("Campaign 2 SEEK job ID").inputValue(), "654321");
    assert.equal(await page.getByLabel("Campaign 1 name").inputValue(), "Tutor ad");
    await page.getByLabel("Campaign 1 name").scrollIntoViewIfNeeded();
    await shot(page, "campaign-settings");
  });
  await check("the page has no script errors", async () => assert.deepEqual(errors, []));
} finally {
  await browser?.close();
  server.close();
}
