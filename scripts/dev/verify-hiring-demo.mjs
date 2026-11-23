#!/usr/bin/env node
// Offline check of the Hiring demo mode (/hiring?demo=1) in Chrome: the real dashboard, with only demo.ts for data.
// No server data, no sign-in, no credentials. A request that demo mode lets through to a server fails this check.
// Run (Node 24): node scripts/dev/verify-hiring-demo.mjs [screenshot-folder]
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
import { HiringDashboard } from "@/components/hiring/dashboard";
createRoot(document.getElementById("root")!).render(<Suspense fallback="Loading"><HiringDashboard /></Suspense>);
`;
// Only the framework parts that need a Next.js server are replaced. The components and demo.ts stay real.
const NAVIGATION = `
import { useSyncExternalStore } from "react";
const change = "synthetic-url-change";
const push = window.history.pushState.bind(window.history);
window.history.pushState = (...args) => { push(...args); window.dispatchEvent(new Event(change)); };
const subscribe = (fn) => { window.addEventListener(change, fn); window.addEventListener("popstate", fn); return () => { window.removeEventListener(change, fn); window.removeEventListener("popstate", fn); }; };
export const useSearchParams = () => new URLSearchParams(useSyncExternalStore(subscribe, () => location.search));
`;
const stub = (bundler, module, name, contents) => {
  bundler.onResolve({ filter: module }, () => ({ path: name, namespace: "fixture" }));
  bundler.onLoad({ filter: new RegExp(`^${name}$`), namespace: "fixture" }, () => ({ contents, resolveDir: ROOT }));
};
const bundled = await build({
  stdin: { contents: ENTRY, resolveDir: ROOT, sourcefile: "hiring-demo.tsx", loader: "tsx" },
  bundle: true, write: false, outdir: "out", platform: "browser", format: "iife", target: "es2022", jsx: "automatic", tsconfig: path.join(ROOT, "tsconfig.json"),
  define: { "process.env.NODE_ENV": JSON.stringify("production") }, logLevel: "error", logOverride: { "module-level-directive": "silent" },
  plugins: [{ name: "synthetic-framework", setup(bundler) {
    stub(bundler, /^next\/navigation$/, "navigation", NAVIGATION);
    stub(bundler, /^next\/font\/google$/, "font", "export const Instrument_Serif = () => ({ variable: '' });");
    stub(bundler, /^next-auth\/react$/, "auth", "export const signIn = async () => {};");
    stub(bundler, /^next\/link$/, "link", "import { createElement } from 'react'; export default function Link({ href, ...rest }) { return createElement('a', { href: String(href), ...rest }); }");
  } }],
});
const script = bundled.outputFiles.find((f) => f.path.endsWith(".js")).text;
const moduleCss = bundled.outputFiles.find((f) => f.path.endsWith(".css"))?.text ?? "";
const from = path.join(ROOT, "src/app/globals.css");
const globalCss = (await postcss([tailwind({ base: ROOT })]).process(readFileSync(from, "utf8"), { from })).css;
const html = `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Hiring demo</title><style>${globalCss}${moduleCss}html{--font-inter:Inter,system-ui;--font-instrument-serif:Georgia}</style></head><body><div id="root"></div><script>${script.replaceAll("</script", "<\\/script")}</script></body></html>`;

// Every request that reaches this server, other than the page itself, is a request that demo mode did not answer.
const leaked = [];
const server = createServer((request, response) => {
  const url = new URL(request.url, "http://localhost");
  // The Capacity tab reads its own endpoint, which demo mode lets through on purpose (read-only).
  // The packet in the real design comes from a demo-only endpoint that reads and saves nothing. Here it is absent, so the page uses its plain packet.
  if (url.pathname !== "/hiring" && url.pathname !== "/favicon.ico" && request.url !== "/api/hiring?capacity=1" && url.pathname !== "/api/hiring/review/demo-packet") leaked.push(`${request.method} ${request.url}`);
  response.writeHead(url.pathname === "/hiring" ? 200 : 404, { "Content-Type": "text/html" });
  response.end(url.pathname === "/hiring" ? html : "");
});
await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
const base = `http://127.0.0.1:${server.address().port}/hiring?demo=1`;
const browser = await chromium.launch({ executablePath: CHROME });
const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
const errors = [];
page.on("pageerror", (error) => errors.push(error.message));
// Gift's sign-off asks "Approve this offer letter…?" in a browser dialog.
page.on("dialog", (dialog) => dialog.accept());
if (OUT) mkdirSync(OUT, { recursive: true });
let shots = 0;
const shot = async (name) => OUT && page.screenshot({ path: path.join(OUT, `${String(++shots).padStart(2, "0")}-${name}.png`), animations: "disabled" });
const bar = page.getByRole("complementary", { name: "Demo mode" });
const current = () => bar.locator("[aria-current=step]").innerText();
const next = () => bar.getByRole("button", { name: "Next", exact: true }).click();
const NAME = "Demo – Nicha Suwan";
const check = async (title, run) => { await run(); console.log(`ok  ${title}`); };

try {
  await page.goto(base);
  await check("1 the application shows with its score", async () => {
    await bar.waitFor();
    assert.match(await current(), /Application and ATS score/);
    await page.getByText(NAME).first().waitFor();
    await shot("apply");
  });
  await check("2 Good call moves the candidate on", async () => {
    await next();
    assert.match(await current(), /HR call/);
    const card = page.locator("article", { hasText: NAME }).first();
    await card.getByRole("button", { name: "Good call" }).click();
    await page.waitForFunction(() => document.querySelector("[aria-current=step]")?.textContent?.includes("Next steps email"));
    await shot("form");
  });
  await check("3 the pre-screen screen lists the candidate", async () => {
    await page.locator(`:text("${NAME}"):visible`).first().waitFor();
  });
  await check("4 Admin sees the visit and the paper to print", async () => {
    await next();
    const card = page.locator("article", { hasText: NAME }).first();
    await card.getByRole("link", { name: "Print the paper" }).waitFor();
    await shot("prepare");
  });
  await check("5 the upload button marks the paper and opens no file dialog", async () => {
    await next();
    const card = page.locator("article", { hasText: NAME }).first();
    let chooser = false;
    page.once("filechooser", () => { chooser = true; });
    await card.getByText("Upload the completed paper").click();
    await card.getByRole("button", { name: "Review paper grade" }).waitFor();
    assert.equal(chooser, false);
    await shot("paper");
  });
  await check("6 the head sends scores and Yes on the candidate page", async () => {
    await next();
    await page.getByRole("button", { name: "Kru Peat" }).click();
    await shot("heads");
    await page.locator(`a[href^="/hiring/brief/demo"]`).first().click();
    const brief = page.getByRole("dialog", { name: "The head’s candidate page" });
    await brief.getByRole("heading", { name: NAME }).waitFor();
    await shot("brief");
    // The top score of every item, then the checks answer.
    for (const group of await brief.locator("#scores fieldset").all()) {
      const first = group.locator("input[type=radio]").first();
      if (await first.count()) await first.check({ force: true });
    }
    await shot("brief-scored");
    await brief.getByRole("button", { name: /^Send/ }).first().click();
    await brief.getByRole("button", { name: /^Yes/ }).first().click();
    await page.waitForFunction(() => document.querySelector("[aria-current=step]")?.textContent?.includes("Final review"));
  });
  await check("7 HR sends the packet and Gift approves", async () => {
    const card = page.locator("article", { hasText: NAME }).first();
    await card.waitFor();
    await shot("review-hr");
    const open = card.getByRole("button", { name: /Open final review/ });
    if (await open.count()) await open.click();
    await card.getByLabel("Offer letter").selectOption("part_time");
    await card.getByRole("button", { name: "Preview packet" }).click();
    await card.frameLocator('iframe[title="Packet preview"]').getByText("part-time Mathematics tutor").waitFor();
    await shot("review-hr-preview");
    await card.getByRole("button", { name: /Send to Gift/ }).click();
    await bar.getByText("This is Gift’s screen now.").waitFor();
    await shot("review-gift");
    const gift = page.locator("article", { hasText: NAME }).first();
    await gift.getByRole("button", { name: /packet/i }).first().click();
    await shot("review-packet");
    await gift.getByRole("button", { name: /Approve and send offer/ }).click();
    await page.waitForFunction(() => document.querySelector("[aria-current=step]")?.textContent?.includes("Offer and signing"));
  });
  await check("8 the offer shows as approved", async () => {
    await page.locator("article", { hasText: NAME }).first().waitFor();
    await shot("offer");
  });
  await check("the pipeline board shows on the Overview", async () => {
    await page.getByRole("button", { name: "Full dashboard" }).click().catch(() => undefined);
    await page.getByRole("navigation", { name: "Hiring tools" }).first().getByRole("button", { name: "Overview" }).click();
    await page.getByRole("heading", { name: "Pipeline from the HR call" }).waitFor();
    await shot("pipeline");
  });
  assert.deepEqual(errors, [], "page errors");
  assert.deepEqual(leaked, [], "requests that left demo mode");
  console.log("Demo mode: all checks passed.");
} catch (error) {
  await shot("failed");
  console.error(errors.length ? `Page errors: ${errors.join(" | ")}` : "", leaked.length ? `Leaked: ${leaked.join(", ")}` : "");
  throw error;
} finally {
  await browser.close();
  server.close();
}
