#!/usr/bin/env node

// Visual check of the Feedback Autowriter dashboard, for comparing the page with its mockup
// (docs/superpowers/specs/assets/2026-09-30-autowriter-dashboard-mockup-a.png). Dev only: not an app route, no
// server, no database, nothing but the made-up fixtures of src/components/feedback-autowriter/__tests__/fixtures.ts.
//
//   node scripts/dev/render-autowriter-dashboard.mjs            build the preview and take the three screenshots
//   node scripts/dev/render-autowriter-dashboard.mjs --no-shot  build the preview only (open index.html yourself)
//
// 1. Bundles a small entry that mounts <FeedbackAutowriterDashboard> with the fixtures (esbuild, tsconfig paths).
// 2. Compiles src/app/globals.css with @tailwindcss/postcss, scanning the repository as the app's build does.
// 3. Writes one self-contained index.html (script and styles inline, so no stray .js for ESLint to find) to the
//    git-ignored .feedback-autowriter/preview/.
// 4. Screenshots three views with headless Chrome: the owner's, an admin's (read-only), and an empty to-do list
//    early in the pilot (`index.html?view=owner|admin|empty` shows each one in a browser), the owner's view with
//    every detail section open (`&details=open`), and the drawer on the first item of each group of the to-do list
//    (`&open=review|hold|incident|failed_post`).
//
// Chrome is taken from CHROME_BIN, or the usual macOS location.

import { spawn } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import tailwind from "@tailwindcss/postcss";
import { build } from "esbuild";
import postcss from "postcss";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const OUT = path.join(ROOT, ".feedback-autowriter", "preview");
const CHROME = process.env.CHROME_BIN || "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome";
const VIEWS = ["owner", "admin", "empty"];
const DRAWERS = ["review", "hold", "incident", "failed_post"];
const WIDTH = 1440;
const DRAWER_HEIGHT = 900;

const ENTRY = `
import { createRoot } from "react-dom/client";
import { FeedbackAutowriterDashboard } from "@/components/feedback-autowriter/feedback-autowriter-dashboard";
import {
  dashboardFixture,
  quietDashboardFixture,
  quietReviewFixture,
  reviewFixture,
  shortHistoryTrendsFixture,
  trendsFixture,
} from "@/components/feedback-autowriter/__tests__/fixtures";

const VIEWS = {
  owner: () => ({ data: dashboardFixture(), review: reviewFixture(), trends: trendsFixture(), canControl: true }),
  admin: () => ({ data: dashboardFixture(), review: reviewFixture(), trends: trendsFixture(), canControl: false }),
  empty: () => ({ data: quietDashboardFixture(), review: quietReviewFixture(), trends: shortHistoryTrendsFixture(), canControl: true }),
};

// A preview has no server: a request the page makes (its polling, a click) waits forever instead of failing.
window.fetch = () => new Promise(() => undefined);

const name = new URLSearchParams(window.location.search).get("view") ?? "owner";
const view = (VIEWS[name] ?? VIEWS.owner)();
createRoot(document.getElementById("root")).render(
  <FeedbackAutowriterDashboard initialData={view.data} initialReview={view.review} initialTrends={view.trends} canControl={view.canControl} />,
);
// ?open=<group>: the drawer on that group's first item, as a click on its button opens it.
const open = new URLSearchParams(window.location.search).get("open");
if (open) window.setTimeout(() => document.querySelector('[data-group="' + open + '"] button')?.click(), 500);
// ?details=open: every collapsed section opened.
if (new URLSearchParams(window.location.search).get("details") === "open") {
  window.setTimeout(() => document.querySelectorAll("details").forEach((section) => { section.open = true; }), 500);
}
// The page's height once the charts are drawn, for a screenshot of all of it.
window.setTimeout(() => { document.documentElement.dataset.pageHeight = String(document.documentElement.scrollHeight); }, 1500);
`;

/** The preview page: the app's fonts and shell paddings around the dashboard, everything inline. */
function html(script, css) {
  return `<!doctype html>
<html lang="en" class="h-full antialiased">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Feedback Autowriter · preview with made-up data</title>
<link rel="preconnect" href="https://fonts.googleapis.com">
<link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>
<link href="https://fonts.googleapis.com/css2?family=Inter:wght@100..900&display=swap" rel="stylesheet">
<style>:root{--font-inter:"Inter",ui-sans-serif,system-ui,sans-serif;--font-jetbrains-mono:ui-monospace,monospace}</style>
<style>${css.replaceAll("</style", "<\\/style")}</style>
</head>
<body class="flex min-h-full flex-col">
<main class="flex flex-1 flex-col px-4 py-3 lg:px-6"><div id="root" class="flex flex-1 flex-col"></div></main>
<script>${script.replaceAll("</script", "<\\/script")}</script>
</body>
</html>
`;
}

async function bundle() {
  const result = await build({
    stdin: { contents: ENTRY, resolveDir: ROOT, loader: "tsx", sourcefile: "autowriter-preview-entry.tsx" },
    write: false,
    bundle: true,
    format: "iife",
    platform: "browser",
    target: "es2022",
    jsx: "automatic",
    tsconfig: path.join(ROOT, "tsconfig.json"),
    define: { "process.env.NODE_ENV": JSON.stringify("production") },
    minify: true,
    // "use client" means nothing to a plain bundle.
    logOverride: { "module-level-directive": "silent" },
    logLevel: "warning",
  });
  return result.outputFiles[0].text;
}

async function styles() {
  const from = path.join(ROOT, "src", "app", "globals.css");
  // Tailwind 4 finds its classes by scanning `base` (the working directory by default), as the app's build does from
  // the repository root; git-ignored files, this preview among them, are left out.
  const result = await postcss([tailwind({ base: ROOT, optimize: false })]).process(readFileSync(from, "utf8"), { from });
  return result.css;
}

/**
 * Runs headless Chrome until `done(stdout)` says its work is there, then stops it: on some machines a headless Chrome
 * that has written its output never exits on its own. Its own profile directory keeps it apart from a running Chrome.
 */
function chrome(args, url, done) {
  const profile = mkdtempSync(path.join(os.tmpdir(), "autowriter-preview-"));
  return new Promise((resolve, reject) => {
    const child = spawn(CHROME, [
      "--headless=new", "--disable-gpu", "--hide-scrollbars", "--no-first-run", "--no-default-browser-check", "--force-device-scale-factor=1",
      `--user-data-dir=${profile}`, "--virtual-time-budget=8000", ...args, url,
    ], { stdio: ["ignore", "pipe", "ignore"] });
    let stdout = "";
    let failure = null;
    child.stdout.on("data", (chunk) => { stdout += chunk; });
    const poll = setInterval(() => { if (done(stdout)) child.kill("SIGKILL"); }, 250);
    const limit = setTimeout(() => {
      failure = new Error(`Chrome did not finish within 60 s (${args.join(" ")}).`);
      child.kill("SIGKILL");
    }, 60_000);
    child.on("error", (error) => { failure = error; });
    child.on("close", () => {
      clearInterval(poll);
      clearTimeout(limit);
      // Chrome's helpers may still be letting go of the profile: removing it is best effort.
      try {
        rmSync(profile, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 });
      } catch {
        // A leftover temporary profile is harmless.
      }
      if (failure) reject(failure);
      else if (done(stdout)) resolve(stdout);
      else reject(new Error(`Chrome exited without its output (${args.join(" ")}).`));
    });
  });
}

/** True once a file exists and has stopped growing between two looks. */
function settled(file) {
  let last = -1;
  return () => {
    if (!existsSync(file)) return false;
    const { size } = statSync(file);
    const same = size > 0 && size === last;
    last = size;
    return same;
  };
}

const pageUrl = (query) => `${pathToFileURL(path.join(OUT, "index.html")).href}?${query}`;

/** The whole page of a view: first the page's own height, then a window that tall. */
async function screenshot(name, query) {
  const url = pageUrl(query);
  const dom = await chrome([`--window-size=${WIDTH},2400`, "--dump-dom"], url, (stdout) => stdout.includes("</html>"));
  const height = Number(/data-page-height="(\d+)"/u.exec(dom)?.[1] ?? 0);
  if (!height) throw new Error(`The ${name} view did not render (no page height in the DOM).`);
  const file = path.join(OUT, `dashboard-${name}.png`);
  rmSync(file, { force: true });
  await chrome([`--window-size=${WIDTH},${height}`, `--screenshot=${file}`], url, settled(file));
  return { file, height };
}

/** The owner's drawer on the first item of a group, in a window of a laptop's height. */
async function drawerScreenshot(group) {
  const file = path.join(OUT, `drawer-${group}.png`);
  rmSync(file, { force: true });
  await chrome([`--window-size=${WIDTH},${DRAWER_HEIGHT}`, `--screenshot=${file}`], pageUrl(`view=owner&open=${group}`), settled(file));
  return file;
}

mkdirSync(OUT, { recursive: true });
const [script, css] = await Promise.all([bundle(), styles()]);
writeFileSync(path.join(OUT, "index.html"), html(script, css));
console.log(`Preview written to ${path.relative(ROOT, OUT)}/ (index.html?view=${VIEWS.join("|")})`);

if (!process.argv.includes("--no-shot")) {
  for (const [name, query] of [...VIEWS.map((view) => [view, `view=${view}`]), ["details", "view=owner&details=open"]]) {
    const { file, height } = await screenshot(name, query);
    console.log(`${path.relative(ROOT, file)}  ${WIDTH}x${height}`);
  }
  for (const group of DRAWERS) {
    console.log(`${path.relative(ROOT, await drawerScreenshot(group))}  ${WIDTH}x${DRAWER_HEIGHT}`);
  }
}
