#!/usr/bin/env node

import fs from "node:fs";
import path from "node:path";

const API_DIR = path.join(process.cwd(), "src", "app", "api");
const API_INDEX_PATH = path.join(process.cwd(), "docs", "reference", "api", "index.md");
const HTTP_METHODS = ["GET", "POST", "PATCH", "PUT", "DELETE", "OPTIONS", "HEAD"];

function walkRouteFiles(dir) {
  const entries = fs.readdirSync(dir, { withFileTypes: true });
  const files = [];

  for (const entry of entries) {
    const fullPath = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      files.push(...walkRouteFiles(fullPath));
      continue;
    }
    if (entry.isFile() && entry.name === "route.ts") {
      files.push(fullPath);
    }
  }

  return files;
}

function routePathFromFile(filePath) {
  const relativePath = path.relative(API_DIR, filePath).split(path.sep).join("/");
  return `/api/${relativePath.replace(/\/route\.ts$/, "")}`;
}

function exportedMethods(source) {
  const found = new Set();

  for (const method of HTTP_METHODS) {
    const directExport = new RegExp(
      [
        `export\\s+(?:async\\s+)?function\\s+${method}\\b`,
        `export\\s+const\\s+${method}\\b`,
        `export\\s+let\\s+${method}\\b`,
        `export\\s+var\\s+${method}\\b`,
      ].join("|"),
    );
    if (directExport.test(source)) found.add(method);
  }

  for (const match of source.matchAll(/export\s+const\s*\{([^}]+)\}\s*=\s*[^;]+/g)) {
    for (const part of match[1].split(",")) {
      const name = part.trim().split(/\s*:\s*/).pop()?.trim();
      if (HTTP_METHODS.includes(name)) found.add(name);
    }
  }

  for (const match of source.matchAll(/export\s*\{([^}]+)\}/g)) {
    for (const part of match[1].split(",")) {
      const pieces = part.trim().split(/\s+as\s+/i);
      const name = (pieces[1] ?? pieces[0])?.trim();
      if (HTTP_METHODS.includes(name)) found.add(name);
    }
  }

  return [...found].sort((a, b) => HTTP_METHODS.indexOf(a) - HTTP_METHODS.indexOf(b));
}

function actualApiMethods() {
  return walkRouteFiles(API_DIR)
    .flatMap((filePath) => {
      const source = fs.readFileSync(filePath, "utf8");
      const routePath = routePathFromFile(filePath);
      return exportedMethods(source).map((method) => ({
        method,
        path: routePath,
        file: path.relative(process.cwd(), filePath),
      }));
    })
    .sort(compareEntries);
}

function documentedApiMethods() {
  const markdown = fs.readFileSync(API_INDEX_PATH, "utf8");
  const entries = [];

  for (const line of markdown.split("\n")) {
    if (!line.startsWith("|")) continue;
    const cells = line
      .split("|")
      .slice(1, -1)
      .map((cell) => cell.trim());
    if (cells.length < 5 || cells[0] === "Method" || /^-+$/.test(cells[0])) continue;

    const pathMatch = cells[1].match(/`([^`]+)`/);
    if (!pathMatch) continue;

    const pathValue = pathMatch[1];
    for (const method of cells[0].split(",").map((value) => value.trim()).filter(Boolean)) {
      entries.push({ method, path: pathValue, file: "docs/reference/api/index.md" });
    }
  }

  return entries.sort(compareEntries);
}

function compareEntries(a, b) {
  return (
    a.path.localeCompare(b.path) ||
    HTTP_METHODS.indexOf(a.method) - HTTP_METHODS.indexOf(b.method)
  );
}

function key(entry) {
  return `${entry.method} ${entry.path}`;
}

function main() {
  const actual = actualApiMethods();
  const documented = documentedApiMethods();
  const actualKeys = new Set(actual.map(key));
  const documentedKeys = new Set(documented.map(key));
  const missingFromDocs = actual.filter((entry) => !documentedKeys.has(key(entry)));
  const missingFromCode = documented.filter((entry) => !actualKeys.has(key(entry)));

  if (missingFromDocs.length > 0 || missingFromCode.length > 0) {
    const lines = ["API reference drift detected.", ""];

    if (missingFromDocs.length > 0) {
      lines.push("Exported by route.ts but missing from docs/reference/api/index.md:");
      lines.push(...missingFromDocs.map((entry) => `  - ${key(entry)} (${entry.file})`));
      lines.push("");
    }

    if (missingFromCode.length > 0) {
      lines.push("Documented in docs/reference/api/index.md but not exported by route.ts:");
      lines.push(...missingFromCode.map((entry) => `  - ${key(entry)}`));
      lines.push("");
    }

    throw new Error(lines.join("\n").trimEnd());
  }

  const routeCount = new Set(actual.map((entry) => entry.path)).size;
  console.log(
    `Docs audit passed: ${actual.length} API method handlers documented across ${routeCount} route files.`,
  );
}

try {
  main();
} catch (error) {
  console.error(error instanceof Error ? error.message : String(error));
  process.exit(1);
}
