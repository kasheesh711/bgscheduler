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
//    (`&open=review|hold|incident|failed_post`). `&theme=dark` shows any of them in the dark theme.
//
// Chrome is taken from CHROME_BIN, or the usual macOS location. The preview page loads Inter from Google Fonts: without
// a network the text falls back to the system's sans-serif and the screenshots differ slightly.

import { spawn } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { crc32, deflateSync, inflateSync } from "node:zlib";
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

const params = new URLSearchParams(window.location.search);
// ?theme=dark: the dark theme, as the app's theme switch sets it.
if (params.get("theme") === "dark") document.documentElement.classList.add("dark");
const name = params.get("view") ?? "owner";
const view = (VIEWS[name] ?? VIEWS.owner)();
createRoot(document.getElementById("root")).render(
  <FeedbackAutowriterDashboard initialData={view.data} initialReview={view.review} initialTrends={view.trends} canControl={view.canControl} />,
);
// ?open=<group>: the drawer on that group's first item, as a click on its button opens it.
const open = params.get("open");
if (open) window.setTimeout(() => document.querySelector('[data-group="' + open + '"] button')?.click(), 500);
// ?details=open: every collapsed section opened.
if (params.get("details") === "open") {
  window.setTimeout(() => document.querySelectorAll("details").forEach((section) => { section.open = true; }), 500);
}
// The page's height once the charts are drawn, for a screenshot of all of it; and the viewport's, which headless Chrome
// makes a little shorter than its window.
window.setTimeout(() => {
  document.documentElement.dataset.pageHeight = String(document.documentElement.scrollHeight);
  document.documentElement.dataset.viewportHeight = String(window.innerHeight);
}, 1500);
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

/** The headless Chromes still running and their profile directories: stopped and removed when the script ends, however it ends. */
const running = new Set();
const profiles = new Set();

function removeProfile(profile) {
  // Chrome's helpers may still be letting go of the profile: removing it is best effort (a leftover one is harmless).
  try {
    rmSync(profile, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 });
    profiles.delete(profile);
  } catch {
    // Tried again when the script ends.
  }
}

process.on("exit", () => {
  for (const child of running) child.kill("SIGKILL");
  for (const profile of profiles) removeProfile(profile);
});
for (const signal of ["SIGINT", "SIGTERM"]) process.on(signal, () => process.exit(1));

/**
 * Runs headless Chrome until `ready(stdout)` says its work is there, then stops it: on some machines a headless Chrome
 * that has written its output never exits on its own. Where it does exit by itself, `present(stdout)` says whether the
 * work is there (`ready` may need two looks, and an exit leaves time for one). Its own profile directory (in the
 * system's temporary folder) keeps it apart from a running Chrome.
 */
function chrome(args, url, ready, present = ready) {
  const profile = mkdtempSync(path.join(os.tmpdir(), "autowriter-preview-"));
  profiles.add(profile);
  return new Promise((resolve, reject) => {
    const child = spawn(CHROME, [
      "--headless=new", "--disable-gpu", "--hide-scrollbars", "--no-first-run", "--no-default-browser-check", "--force-device-scale-factor=1",
      `--user-data-dir=${profile}`, "--virtual-time-budget=8000", ...args, url,
    ], { stdio: ["ignore", "pipe", "ignore"] });
    running.add(child);
    let stdout = "";
    let finished = false;
    const finish = (failure) => {
      if (finished) return;
      finished = true;
      clearInterval(poll);
      clearTimeout(limit);
      clearTimeout(afterExit);
      child.kill("SIGKILL");
      // A helper process may hold the pipe open after the browser is gone: do not wait for it.
      child.stdout.destroy();
      running.delete(child);
      removeProfile(profile);
      if (failure) reject(failure);
      else resolve(stdout);
    };
    const ended = () => finish(present(stdout) ? undefined : new Error(`Chrome exited without its output (${args.join(" ")}).`));
    let afterExit;
    child.stdout.on("data", (chunk) => { stdout += chunk; });
    const poll = setInterval(() => { if (ready(stdout)) finish(); }, 250);
    const limit = setTimeout(() => finish(new Error(`Chrome did not finish within 60 s (${args.join(" ")}).`)), 60_000);
    child.on("error", finish);
    // `close` comes once the output has been read to its end; after an exit it is given a second, no more.
    child.on("close", ended);
    child.on("exit", () => {
      if (!finished) afterExit = setTimeout(ended, 1_000);
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

/** True when a file is there with something in it: what is asked of a Chrome that has exited by itself. */
const written = (file) => () => existsSync(file) && statSync(file).size > 0;

const pageUrl = (query) => `${pathToFileURL(path.join(OUT, "index.html")).href}?${query}`;

const PROBE_HEIGHT = 2400;
/** How much shorter than its window headless Chrome's viewport is (it screenshots the window's full height). */
let windowExtra = 0;

/** The whole page of a view: first the page's own height, then a window that tall. */
async function screenshot(name, query) {
  const url = pageUrl(query);
  const dom = await chrome([`--window-size=${WIDTH},${PROBE_HEIGHT}`, "--dump-dom"], url, (stdout) => stdout.includes("</html>"));
  const height = Number(/data-page-height="(\d+)"/u.exec(dom)?.[1] ?? 0);
  if (!height) throw new Error(`The ${name} view did not render (no page height in the DOM).`);
  const viewport = Number(/data-viewport-height="(\d+)"/u.exec(dom)?.[1] ?? PROBE_HEIGHT);
  windowExtra = Math.max(0, PROBE_HEIGHT - viewport);
  const file = path.join(OUT, `dashboard-${name}.png`);
  rmSync(file, { force: true });
  await chrome([`--window-size=${WIDTH},${height}`, `--screenshot=${file}`], url, settled(file), written(file));
  return { file, height };
}

/**
 * Cuts a PNG down to its top `height` rows. A row of a PNG refers only to the row above it, so the rows kept are
 * written back as they are.
 */
function cropPngHeight(file, height) {
  const png = readFileSync(file);
  const chunks = [];
  for (let at = 8; at < png.length;) {
    const length = png.readUInt32BE(at);
    chunks.push({ type: png.toString("latin1", at + 4, at + 8), data: png.subarray(at + 8, at + 8 + length) });
    at += 12 + length;
  }
  const header = chunks.find((chunk) => chunk.type === "IHDR")?.data;
  if (!header) throw new Error(`${file} is not a PNG.`);
  const [width, fullHeight, depth, colour, interlace] = [header.readUInt32BE(0), header.readUInt32BE(4), header[8], header[9], header[12]];
  if (height >= fullHeight) return;
  if (depth !== 8 || interlace !== 0 || (colour !== 2 && colour !== 6)) throw new Error(`Cannot crop ${file}: not an 8-bit RGB(A) PNG.`);
  const rowBytes = 1 + width * (colour === 6 ? 4 : 3);
  const rows = inflateSync(Buffer.concat(chunks.filter((chunk) => chunk.type === "IDAT").map((chunk) => chunk.data)));
  const chunk = (type, data) => {
    const body = Buffer.concat([Buffer.from(type, "latin1"), data]);
    const size = Buffer.alloc(4);
    size.writeUInt32BE(data.length);
    const check = Buffer.alloc(4);
    check.writeUInt32BE(crc32(body));
    return Buffer.concat([size, body, check]);
  };
  const cropped = Buffer.from(header);
  cropped.writeUInt32BE(height, 4);
  writeFileSync(file, Buffer.concat([
    png.subarray(0, 8), chunk("IHDR", cropped), chunk("IDAT", deflateSync(rows.subarray(0, rowBytes * height))), chunk("IEND", Buffer.alloc(0)),
  ]));
}

/**
 * The owner's drawer on the first item of a group, in a viewport of a laptop's height. The window is taller by what
 * headless Chrome takes off the viewport, and the picture is cut back to the viewport: otherwise the sheet, as tall as
 * the viewport, would stop short of the picture's bottom edge.
 */
async function drawerScreenshot(group) {
  const file = path.join(OUT, `drawer-${group}.png`);
  rmSync(file, { force: true });
  await chrome([`--window-size=${WIDTH},${DRAWER_HEIGHT + windowExtra}`, `--screenshot=${file}`], pageUrl(`view=owner&open=${group}`), settled(file), written(file));
  cropPngHeight(file, DRAWER_HEIGHT);
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
