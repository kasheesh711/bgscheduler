#!/usr/bin/env node

import fs from "node:fs";
import path from "node:path";

const API_DIR = path.join(process.cwd(), "src", "app", "api");
const API_INDEX_PATH = path.join(process.cwd(), "docs", "reference", "api", "index.md");
const HTTP_METHODS = ["GET", "POST", "PATCH", "DELETE", "PUT", "OPTIONS", "HEAD"];
const INDEXED_METHODS = HTTP_METHODS.filter((method) => method !== "OPTIONS");

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

function apiPathFromRouteFile(filePath) {
  const relativePath = path.relative(API_DIR, filePath).split(path.sep).join("/");
  return `/api/${relativePath.replace(/\/route\.ts$/, "")}`;
}

function exportsMethod(source, method) {
  const patterns = [
    new RegExp(`export\\s+(?:async\\s+)?function\\s+${method}\\b`),
    new RegExp(`export\\s+const\\s+${method}\\b`),
    new RegExp(`export\\s+const\\s+\\{[^}]*\\b${method}\\b[^}]*\\}\\s*=`),
    new RegExp(`export\\s*\\{[^}]*\\b${method}\\b[^}]*\\}`),
    new RegExp(`export\\s*\\{[^}]*\\b\\w+\\s+as\\s+${method}\\b[^}]*\\}`),
  ];

  return patterns.some((pattern) => pattern.test(source));
}

function discoverApiMethods() {
  const rows = [];

  for (const filePath of walkRouteFiles(API_DIR).sort()) {
    const source = fs.readFileSync(filePath, "utf8");
    const apiPath = apiPathFromRouteFile(filePath);
    for (const method of HTTP_METHODS) {
      if (exportsMethod(source, method)) {
        rows.push({ method, path: apiPath, filePath });
      }
    }
  }

  return rows;
}

function parseApiIndex() {
  const markdown = fs.readFileSync(API_INDEX_PATH, "utf8");
  const endpointCountMatch = markdown.match(/Endpoint count:\s+\*\*(\d+)\*\*/);
  const endpointCount = endpointCountMatch ? Number(endpointCountMatch[1]) : null;
  const rows = [];

  for (const line of markdown.split("\n")) {
    const match = line.match(
      /^\|\s*([^|]+?)\s*\|\s*`([^`]+)`\s*\|\s*([^|]+?)\s*\|\s*([^|]+?)\s*\|/,
    );
    if (!match || match[1].trim() === "Method") continue;

    const methods = match[1].split(",").map((method) => method.trim());
    for (const method of methods) {
      rows.push({
        method,
        path: match[2],
        group: match[3].trim(),
        auth: match[4].trim(),
      });
    }
  }

  return { endpointCount, rows };
}

function key(row) {
  return `${row.method} ${row.path}`;
}

function countByMethod(rows) {
  return rows.reduce((counts, row) => {
    counts[row.method] = (counts[row.method] ?? 0) + 1;
    return counts;
  }, {});
}

function main() {
  const actualRows = discoverApiMethods();
  const indexedActualRows = actualRows.filter((row) => INDEXED_METHODS.includes(row.method));
  const { endpointCount, rows: documentedRows } = parseApiIndex();
  const actualSet = new Set(actualRows.map(key));
  const documentedSet = new Set(documentedRows.map(key));

  const missingRows = indexedActualRows.filter((row) => !documentedSet.has(key(row)));
  const staleRows = documentedRows.filter((row) => !actualSet.has(key(row)));
  const errors = [];

  if (endpointCount === null) {
    errors.push("docs/reference/api/index.md is missing an `Endpoint count: **N**` line.");
  } else if (endpointCount !== indexedActualRows.length) {
    errors.push(
      `API endpoint count drift: docs say ${endpointCount}, route handlers export ${indexedActualRows.length} non-OPTIONS methods.`,
    );
  }

  if (documentedRows.length !== indexedActualRows.length) {
    errors.push(
      `API index row drift: docs list ${documentedRows.length} method rows, route handlers export ${indexedActualRows.length} non-OPTIONS methods.`,
    );
  }

  if (missingRows.length > 0) {
    errors.push(
      [
        "API index is missing route handlers:",
        ...missingRows.map((row) => `- ${key(row)} (${path.relative(process.cwd(), row.filePath)})`),
      ].join("\n"),
    );
  }

  if (staleRows.length > 0) {
    errors.push(
      [
        "API index documents handlers that are not exported:",
        ...staleRows.map((row) => `- ${key(row)}`),
      ].join("\n"),
    );
  }

  if (errors.length > 0) {
    console.error(errors.join("\n\n"));
    process.exit(1);
  }

  const corsPreflightCount = actualRows.filter((row) => row.method === "OPTIONS").length;
  console.log(
    `API docs audit passed: ${indexedActualRows.length} indexed endpoints, ${corsPreflightCount} CORS preflights excluded.`,
  );
  console.log(`Method counts: ${JSON.stringify(countByMethod(indexedActualRows))}`);
}

try {
  main();
} catch (error) {
  console.error(error instanceof Error ? error.message : String(error));
  process.exit(1);
}
