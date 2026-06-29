#!/usr/bin/env node

import fs from "node:fs";
import path from "node:path";

const API_DIR = path.join(process.cwd(), "src", "app", "api");
const API_INDEX_PATH = path.join(process.cwd(), "docs", "reference", "api", "index.md");
const MIDDLEWARE_PATH = path.join(process.cwd(), "src", "middleware.ts");

const METHOD_ORDER = ["GET", "POST", "PUT", "PATCH", "DELETE", "HEAD", "OPTIONS"];
const DOCUMENTED_METHODS = new Set(METHOD_ORDER.filter((method) => method !== "OPTIONS"));

function walkRouteFiles(dir) {
  const files = [];
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const fullPath = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      files.push(...walkRouteFiles(fullPath));
    } else if (entry.isFile() && entry.name === "route.ts") {
      files.push(fullPath);
    }
  }
  return files;
}

function apiPathFromRouteFile(filePath) {
  const relativePath = path.relative(API_DIR, filePath).split(path.sep).join("/");
  return `/api/${relativePath.replace(/\/route\.ts$/, "")}`;
}

function exportedMethods(source) {
  return METHOD_ORDER.filter((method) => {
    const patterns = [
      new RegExp(`export\\s+(?:async\\s+)?function\\s+${method}\\b`),
      new RegExp(`export\\s+const\\s+${method}\\b`),
      new RegExp(`export\\s+const\\s*\\{[^}]*\\b${method}\\b[^}]*\\}\\s*=`, "s"),
      new RegExp(`export\\s*\\{[^}]*\\b${method}\\b[^}]*\\}`, "s"),
      new RegExp(`\\b${method}\\s+as\\s+${method}\\b`),
    ];
    return patterns.some((pattern) => pattern.test(source));
  });
}

function sourceMethodEntries() {
  return walkRouteFiles(API_DIR)
    .flatMap((filePath) => {
      const source = fs.readFileSync(filePath, "utf8");
      const apiPath = apiPathFromRouteFile(filePath);
      return exportedMethods(source)
        .filter((method) => DOCUMENTED_METHODS.has(method))
        .map((method) => ({ method, path: apiPath }));
    })
    .sort(compareEntries);
}

function documentedRows() {
  const markdown = fs.readFileSync(API_INDEX_PATH, "utf8");
  const rows = [];
  for (const line of markdown.split("\n")) {
    const match = line.match(
      /^\|\s*([A-Z, ]+)\s*\|\s*`([^`]+)`\s*\|\s*([^|]+?)\s*\|\s*([^|]+?)\s*\|/,
    );
    if (!match || match[1].includes("Method")) continue;
    rows.push({
      methods: match[1].split(",").map((method) => method.trim()),
      path: match[2],
      group: match[3].trim(),
      auth: match[4].trim(),
    });
  }
  return rows;
}

function documentedMethodEntries(rows) {
  return rows
    .flatMap((row) => row.methods.map((method) => ({ method, path: row.path, auth: row.auth })))
    .filter((entry) => DOCUMENTED_METHODS.has(entry.method))
    .sort(compareEntries);
}

function publicApiPathsFromMiddleware() {
  const source = fs.readFileSync(MIDDLEWARE_PATH, "utf8");
  const publicRouteStart = source.indexOf("function isPublicRoute");
  const publicRouteEnd = source.indexOf("function isPathAllowed");
  const publicRouteSource =
    publicRouteStart >= 0 && publicRouteEnd > publicRouteStart
      ? source.slice(publicRouteStart, publicRouteEnd)
      : source;
  const paths = new Set();

  for (const match of publicRouteSource.matchAll(/pathname === "([^"]+)"/g)) {
    if (match[1].startsWith("/api/")) paths.add(match[1]);
  }

  if (publicRouteSource.includes('pathname.startsWith("/api/auth")')) {
    paths.add("/api/auth/[...nextauth]");
  }

  if (
    publicRouteSource.includes("oa-resolver/runs") ||
    publicRouteSource.includes("oa-resolver\\/runs")
  ) {
    paths.add("/api/line/contacts/oa-resolver/runs/[runId]/rows");
  }

  return paths;
}

function compareEntries(a, b) {
  const pathCompare = a.path.localeCompare(b.path);
  if (pathCompare !== 0) return pathCompare;
  return METHOD_ORDER.indexOf(a.method) - METHOD_ORDER.indexOf(b.method);
}

function entryKey(entry) {
  return `${entry.method} ${entry.path}`;
}

function assertApiIndexHeader(rows) {
  const markdown = fs.readFileSync(API_INDEX_PATH, "utf8");
  const match = markdown.match(/Endpoint inventory rows:\s+\*\*(\d+)\*\*/);
  if (!match) {
    throw new Error("Missing `Endpoint inventory rows: **N**` declaration in API index.");
  }
  const declared = Number.parseInt(match[1], 10);
  if (declared !== rows.length) {
    throw new Error(`API index declares ${declared} inventory rows but contains ${rows.length}.`);
  }
}

function assertRouteInventory(sourceEntries, docEntries) {
  const sourceKeys = new Set(sourceEntries.map(entryKey));
  const docKeys = new Set(docEntries.map(entryKey));
  const missing = sourceEntries.map(entryKey).filter((key) => !docKeys.has(key));
  const extra = docEntries.map(entryKey).filter((key) => !sourceKeys.has(key));

  if (missing.length > 0 || extra.length > 0) {
    const lines = ["API index route inventory drift detected.", ""];
    if (missing.length > 0) {
      lines.push("Missing from docs/reference/api/index.md:");
      lines.push(...missing.map((key) => `  - ${key}`));
      lines.push("");
    }
    if (extra.length > 0) {
      lines.push("Documented but not exported by src/app/api/**/route.ts:");
      lines.push(...extra.map((key) => `  - ${key}`));
      lines.push("");
    }
    throw new Error(lines.join("\n"));
  }
}

function assertPublicAuthLabels(rows) {
  const publicApiPaths = publicApiPathsFromMiddleware();
  const failures = [];

  for (const row of rows) {
    if (row.path.startsWith("/api/internal/")) {
      if (!row.auth.startsWith("cron")) {
        failures.push(`${row.path} should be documented as cron auth, found ${row.auth}`);
      }
      continue;
    }

    const isPublic = publicApiPaths.has(row.path);
    if (isPublic && !row.auth.startsWith("public")) {
      failures.push(`${row.path} is public in middleware but documented as ${row.auth}`);
    }
    if (!isPublic && row.auth.startsWith("public")) {
      failures.push(`${row.path} is documented public but is not public in middleware`);
    }
  }

  if (failures.length > 0) {
    throw new Error(["API index public/auth label drift detected.", "", ...failures].join("\n"));
  }
}

function main() {
  const rows = documentedRows();
  const sourceEntries = sourceMethodEntries();
  const docEntries = documentedMethodEntries(rows);

  assertApiIndexHeader(rows);
  assertRouteInventory(sourceEntries, docEntries);
  assertPublicAuthLabels(rows);

  console.log(
    `Docs audit passed: ${docEntries.length} documented non-OPTIONS method entries across ${rows.length} API inventory rows.`,
  );
}

try {
  main();
} catch (error) {
  console.error(error instanceof Error ? error.message : String(error));
  process.exit(1);
}
