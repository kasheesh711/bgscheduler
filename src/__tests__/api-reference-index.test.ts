import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

const APP_API_DIR = path.join(process.cwd(), "src", "app", "api");
const API_INDEX_PATH = path.join(process.cwd(), "docs", "reference", "api", "index.md");

function walkRouteFiles(dir: string): string[] {
  return fs.readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const fullPath = path.join(dir, entry.name);
    if (entry.isDirectory()) return walkRouteFiles(fullPath);
    return entry.isFile() && entry.name === "route.ts" ? [fullPath] : [];
  });
}

function routePathFromFile(filePath: string): string {
  const relativePath = path
    .relative(APP_API_DIR, filePath)
    .split(path.sep)
    .join("/")
    .replace(/\/route\.ts$/, "");
  return `/api/${relativePath}`;
}

function documentedRoutePaths(markdown: string): Set<string> {
  const routeRowPattern =
    /\|\s*(?:GET|POST|PATCH|DELETE|OPTIONS|PUT)(?:,\s*(?:GET|POST|PATCH|DELETE|OPTIONS|PUT))*\s*\|\s*`([^`]+)`/g;
  return new Set([...markdown.matchAll(routeRowPattern)].map((match) => match[1]));
}

describe("API reference master index", () => {
  it("documents every App Router API route path", () => {
    const sourceRoutes = walkRouteFiles(APP_API_DIR)
      .map(routePathFromFile)
      .sort((a, b) => a.localeCompare(b));
    const documentedRoutes = documentedRoutePaths(fs.readFileSync(API_INDEX_PATH, "utf8"));

    const missing = sourceRoutes.filter((route) => !documentedRoutes.has(route));

    expect(missing).toEqual([]);
  });
});
