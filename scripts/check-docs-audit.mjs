#!/usr/bin/env node

import fs from "node:fs";
import path from "node:path";

const ROOT = process.cwd();

function readText(relativePath) {
  return fs.readFileSync(path.join(ROOT, relativePath), "utf8");
}

function fail(message) {
  throw new Error(message);
}

function assertIncludes(text, needle, label) {
  if (!text.includes(needle)) {
    fail(`${label} is missing ${JSON.stringify(needle)}.`);
  }
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

function internalPathFromRouteFile(filePath) {
  const internalRoot = path.join(ROOT, "src", "app", "api", "internal");
  const relativeDir = path.dirname(path.relative(internalRoot, filePath)).split(path.sep).join("/");
  return relativeDir === "." ? "/api/internal" : `/api/internal/${relativeDir}`;
}

function main() {
  const vercel = JSON.parse(readText("vercel.json"));
  const cronEntries = vercel.crons ?? [];
  const scheduledPaths = new Set(cronEntries.map((entry) => entry.path));
  const cronReference = readText("docs/reference/crons.md");
  const internalCronReference = readText("docs/reference/api/internal-crons.md");
  const readme = readText("README.md");

  for (const entry of cronEntries) {
    assertIncludes(cronReference, entry.path, "docs/reference/crons.md");
    assertIncludes(cronReference, entry.schedule, "docs/reference/crons.md");
    assertIncludes(internalCronReference, entry.path, "docs/reference/api/internal-crons.md");
    assertIncludes(internalCronReference, entry.schedule, "docs/reference/api/internal-crons.md");
  }

  assertIncludes(readme, `${cronEntries.length} Vercel crons`, "README.md");
  for (const entry of cronEntries) {
    assertIncludes(readme, entry.schedule, "README.md");
  }

  const internalRoutes = walkRouteFiles(path.join(ROOT, "src", "app", "api", "internal"))
    .map(internalPathFromRouteFile)
    .sort((a, b) => a.localeCompare(b));
  const manualInternalRoutes = internalRoutes.filter((routePath) => !scheduledPaths.has(routePath));

  for (const routePath of manualInternalRoutes) {
    assertIncludes(cronReference, routePath, "docs/reference/crons.md manual-only section");
  }

  console.log(
    `Docs audit passed: ${cronEntries.length} scheduled crons and ${manualInternalRoutes.length} manual internal routes documented.`,
  );
}

try {
  main();
} catch (error) {
  console.error(error instanceof Error ? error.message : String(error));
  process.exit(1);
}
