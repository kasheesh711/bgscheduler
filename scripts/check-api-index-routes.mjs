import fs from "node:fs";
import path from "node:path";

const API_ROOT = path.join(process.cwd(), "src", "app", "api");
const API_INDEX = path.join(process.cwd(), "docs", "reference", "api", "index.md");
const METHODS = ["GET", "POST", "PATCH", "PUT", "DELETE", "OPTIONS"];

function walkRouteFiles(dir, files = []) {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const fullPath = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      walkRouteFiles(fullPath, files);
    } else if (entry.name === "route.ts") {
      files.push(fullPath);
    }
  }
  return files;
}

function sourceRoutePath(routeFile) {
  const routeDir = path.dirname(path.relative(API_ROOT, routeFile)).split(path.sep).join("/");
  return `/api/${routeDir}`;
}

function exportedMethods(source) {
  return METHODS.filter((method) => {
    const patterns = [
      new RegExp(`export\\s+(?:async\\s+)?function\\s+${method}\\b`),
      new RegExp(`export\\s+const\\s+${method}\\b`),
      new RegExp(`export\\s+const\\s+\\{[^}]*\\b${method}\\b[^}]*\\}`),
      new RegExp(`export\\s*\\{[^}]*\\b${method}\\b[^}]*\\}`),
    ];
    return patterns.some((pattern) => pattern.test(source));
  });
}

function sourcePairs() {
  const pairs = [];
  for (const file of walkRouteFiles(API_ROOT)) {
    const routePath = sourceRoutePath(file);
    const source = fs.readFileSync(file, "utf8");
    for (const method of exportedMethods(source)) {
      pairs.push(`${method} ${routePath}`);
    }
  }
  return pairs.sort();
}

function docsPairs() {
  const markdown = fs.readFileSync(API_INDEX, "utf8");
  const pairs = [];
  const rowPattern = /^\|\s*(GET, POST|GET|POST|PATCH|PUT|DELETE|OPTIONS)\s*\|\s*`([^`]+)`\s*\|/gm;
  for (const match of markdown.matchAll(rowPattern)) {
    const methods = match[1].split(",").map((method) => method.trim());
    for (const method of methods) {
      pairs.push(`${method} ${match[2]}`);
    }
  }
  return pairs.sort();
}

function diff(left, right) {
  const rightSet = new Set(right);
  return left.filter((item) => !rightSet.has(item));
}

const source = sourcePairs();
const docs = docsPairs();
const missing = diff(source, docs);
const extra = diff(docs, source);

if (missing.length || extra.length) {
  console.error("API index route surface is out of sync.");
  if (missing.length) {
    console.error("\nMissing from docs/reference/api/index.md:");
    for (const item of missing) console.error(`  - ${item}`);
  }
  if (extra.length) {
    console.error("\nDocumented but not present in src/app/api:");
    for (const item of extra) console.error(`  - ${item}`);
  }
  process.exit(1);
}

console.log(`API index matches source route surface (${source.length} method handlers).`);
