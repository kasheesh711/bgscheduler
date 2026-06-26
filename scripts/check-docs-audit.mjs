#!/usr/bin/env node

import fs from "node:fs";
import path from "node:path";

const root = process.cwd();
const vercelPath = path.join(root, "vercel.json");
const cronDocPath = path.join(root, "docs", "reference", "crons.md");
const internalCronDocPath = path.join(root, "docs", "reference", "api", "internal-crons.md");
const internalApiDir = path.join(root, "src", "app", "api", "internal");

function readText(filePath) {
  return fs.readFileSync(filePath, "utf8");
}

function readJson(filePath) {
  return JSON.parse(readText(filePath));
}

function walkRouteFiles(dir) {
  const entries = fs.readdirSync(dir, { withFileTypes: true });
  const files = [];

  for (const entry of entries) {
    const fullPath = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      files.push(...walkRouteFiles(fullPath));
    } else if (entry.isFile() && entry.name === "route.ts") {
      files.push(fullPath);
    }
  }

  return files;
}

function routePathForInternalFile(filePath) {
  const relative = path.relative(internalApiDir, path.dirname(filePath)).split(path.sep).join("/");
  return `/api/internal/${relative}`;
}

function assertIncludes(text, needle, label) {
  if (!text.includes(needle)) {
    throw new Error(`${label} is missing ${needle}`);
  }
}

function assertNotIncludes(text, needle, label) {
  if (text.includes(needle)) {
    throw new Error(`${label} still contains stale text: ${needle}`);
  }
}

function main() {
  const vercel = readJson(vercelPath);
  const cronDoc = readText(cronDocPath);
  const internalCronDoc = readText(internalCronDocPath);
  const scheduledPaths = new Set(vercel.crons.map((cron) => cron.path));
  const internalRoutes = walkRouteFiles(internalApiDir).map(routePathForInternalFile).sort();
  const manualOnlyRoutes = internalRoutes.filter((route) => !scheduledPaths.has(route));

  for (const cron of vercel.crons) {
    assertIncludes(cronDoc, cron.path, "docs/reference/crons.md");
    assertIncludes(cronDoc, cron.schedule, "docs/reference/crons.md");
    assertIncludes(internalCronDoc, cron.path, "docs/reference/api/internal-crons.md");
    assertIncludes(internalCronDoc, cron.schedule, "docs/reference/api/internal-crons.md");
  }

  for (const route of manualOnlyRoutes) {
    assertIncludes(cronDoc, route, "docs/reference/crons.md manual-only section");
  }

  assertIncludes(
    cronDoc,
    "`5 17 30 6 *`",
    "docs/reference/crons.md Student Promotions schedule",
  );
  assertIncludes(
    cronDoc,
    "2026-07-01 00:05 Bangkok",
    "docs/reference/crons.md Student Promotions Bangkok time",
  );
  assertNotIncludes(cronDoc, "eight cron", "docs/reference/crons.md");
  assertNotIncludes(cronDoc, "seven other paths", "docs/reference/crons.md");

  console.log(
    `Docs audit passed: ${vercel.crons.length} scheduled crons and ${manualOnlyRoutes.length} manual-only internal handlers documented.`,
  );
}

try {
  main();
} catch (error) {
  console.error(error instanceof Error ? error.message : String(error));
  process.exit(1);
}
