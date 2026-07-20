#!/usr/bin/env node

import fs from "node:fs";
import path from "node:path";

const API_ROOT = path.join(process.cwd(), "src", "app", "api");
const API_INDEX_PATH = path.join(process.cwd(), "docs", "reference", "api", "index.md");
const HTTP_METHODS = ["GET", "POST", "PATCH", "PUT", "DELETE", "OPTIONS", "HEAD"];

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

function apiPathForRouteFile(filePath) {
  const relativeDir = path.relative(API_ROOT, path.dirname(filePath)).split(path.sep).join("/");
  return `/api/${relativeDir}`;
}

function exportedMethods(source) {
  return HTTP_METHODS.filter((method) => {
    const patterns = [
      new RegExp(`export\\s+async\\s+function\\s+${method}\\b`),
      new RegExp(`export\\s+function\\s+${method}\\b`),
      new RegExp(`export\\s+const\\s+${method}\\b`),
      new RegExp(`export\\s+const\\s+\\{[^}]*\\b${method}\\b[^}]*\\}`),
      new RegExp(`export\\s+\\{[^}]*\\b${method}\\b[^}]*\\}`),
    ];
    return patterns.some((pattern) => pattern.test(source));
  });
}

function discoverActualEndpoints() {
  const routeFiles = walkRouteFiles(API_ROOT).sort();
  const endpoints = [];
  const methodlessFiles = [];

  for (const filePath of routeFiles) {
    const source = fs.readFileSync(filePath, "utf8");
    const methods = exportedMethods(source);
    if (methods.length === 0) {
      methodlessFiles.push(path.relative(process.cwd(), filePath));
    }
    for (const method of methods) {
      endpoints.push({
        method,
        path: apiPathForRouteFile(filePath),
        file: path.relative(process.cwd(), filePath),
      });
    }
  }

  endpoints.sort((a, b) => endpointKey(a).localeCompare(endpointKey(b)));
  return { routeFileCount: routeFiles.length, endpoints, methodlessFiles };
}

function readDocumentedEndpoints() {
  const markdown = fs.readFileSync(API_INDEX_PATH, "utf8");
  const rows = [];
  const rowPattern = /^\|\s*([A-Z, ]+)\s*\|\s*`([^`]+)`\s*\|\s*([^|]+)\|\s*([^|]+)\|/gm;
  let match;

  while ((match = rowPattern.exec(markdown))) {
    if (match[1].includes("Method")) continue;
    const pathValue = match[2];
    for (const method of match[1].split(",").map((part) => part.trim()).filter(Boolean)) {
      rows.push({
        method,
        path: pathValue,
        group: match[3].trim(),
        auth: match[4].trim(),
      });
    }
  }

  const countMatch = markdown.match(/Endpoint count:\s+\*\*(\d+)\*\*/);
  return {
    endpoints: rows,
    declaredCount: countMatch ? Number(countMatch[1]) : null,
  };
}

function endpointKey(endpoint) {
  return `${endpoint.method} ${endpoint.path}`;
}

function duplicates(endpoints) {
  const seen = new Set();
  const duplicated = new Set();
  for (const endpoint of endpoints) {
    const key = endpointKey(endpoint);
    if (seen.has(key)) duplicated.add(key);
    seen.add(key);
  }
  return [...duplicated].sort();
}

function formatEndpoint(endpoint) {
  return endpoint.file
    ? `${endpoint.method} ${endpoint.path} (${endpoint.file})`
    : `${endpoint.method} ${endpoint.path}`;
}

function main() {
  const actual = discoverActualEndpoints();
  const documented = readDocumentedEndpoints();
  const actualKeys = new Set(actual.endpoints.map(endpointKey));
  const documentedKeys = new Set(documented.endpoints.map(endpointKey));

  const failures = [];
  if (actual.methodlessFiles.length > 0) {
    failures.push(
      "Route files with no exported HTTP method:",
      ...actual.methodlessFiles.map((file) => `  - ${file}`),
    );
  }

  const missing = actual.endpoints.filter((endpoint) => !documentedKeys.has(endpointKey(endpoint)));
  if (missing.length > 0) {
    failures.push(
      "Endpoints missing from docs/reference/api/index.md:",
      ...missing.map((endpoint) => `  - ${formatEndpoint(endpoint)}`),
    );
  }

  const stale = documented.endpoints.filter((endpoint) => !actualKeys.has(endpointKey(endpoint)));
  if (stale.length > 0) {
    failures.push(
      "Stale endpoints documented in docs/reference/api/index.md:",
      ...stale.map((endpoint) => `  - ${formatEndpoint(endpoint)}`),
    );
  }

  const duplicateRows = duplicates(documented.endpoints);
  if (duplicateRows.length > 0) {
    failures.push(
      "Duplicate endpoint rows in docs/reference/api/index.md:",
      ...duplicateRows.map((endpoint) => `  - ${endpoint}`),
    );
  }

  if (documented.declaredCount !== actual.endpoints.length) {
    failures.push(
      `Endpoint count mismatch: docs declare ${documented.declaredCount ?? "none"}, source exports ${actual.endpoints.length}.`,
    );
  }

  if (failures.length > 0) {
    console.error(failures.join("\n"));
    process.exit(1);
  }

  console.log(
    `Docs audit passed: ${actual.endpoints.length} API method handlers documented across ${actual.routeFileCount} route files.`,
  );
}

main();
