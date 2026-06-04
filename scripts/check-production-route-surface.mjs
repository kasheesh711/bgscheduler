#!/usr/bin/env node

import fs from "node:fs";
import path from "node:path";

const APP_DIR = path.join(process.cwd(), "src", "app");
const MANIFEST_PATH = path.join(process.cwd(), "docs", "reference", "production-route-surface.json");

function walkRoutes(dir) {
  const entries = fs.readdirSync(dir, { withFileTypes: true });
  const files = [];

  for (const entry of entries) {
    const fullPath = path.join(dir, entry.name);

    if (entry.isDirectory()) {
      files.push(...walkRoutes(fullPath));
      continue;
    }

    if (entry.isFile() && (entry.name === "page.tsx" || entry.name === "route.ts")) {
      files.push(fullPath);
    }
  }

  return files;
}

function routeFromAppFile(filePath) {
  const relativePath = path.relative(APP_DIR, filePath).split(path.sep).join("/");
  const routePath = relativePath.replace(/\/?(page\.tsx|route\.ts)$/, "");
  const segments = routePath
    .split("/")
    .filter(Boolean)
    .filter((segment) => !(segment.startsWith("(") && segment.endsWith(")")))
    .filter((segment) => !segment.startsWith("@"));

  return segments.length === 0 ? "/" : `/${segments.join("/")}`;
}

function discoverRoutes() {
  return [...new Set(walkRoutes(APP_DIR).map(routeFromAppFile))].sort((a, b) =>
    a.localeCompare(b),
  );
}

function readManifest() {
  if (!fs.existsSync(MANIFEST_PATH)) return null;
  return JSON.parse(fs.readFileSync(MANIFEST_PATH, "utf8"));
}

function writeManifest(routes, previousManifest) {
  const manifest = {
    version: 1,
    description:
      "Source route surface that must remain additive for production releases. Update intentionally when removing a route.",
    recordedAt: previousManifest?.recordedAt ?? new Date().toISOString(),
    productionDeployment: previousManifest?.productionDeployment ?? {
      id: "dpl_5S1abfEyBEPRDdd2LZyRb2DNWRWK",
      alias: "https://bgscheduler.vercel.app",
      url: "https://bgscheduler-bl5sz78th-kevins-projects-6ebb4efc.vercel.app",
      outputItems: 362,
    },
    minSourceRouteCount: routes.length,
    criticalRoutes: previousManifest?.criticalRoutes ?? [
      "/leave-requests",
      "/line-review",
      "/payroll",
      "/student-promotions",
      "/api/data-health/jobs/[jobKey]/run",
      "/api/internal/sync-leave-requests",
      "/api/internal/student-promotions/july-1",
    ],
    sourceRoutes: routes,
  };

  fs.mkdirSync(path.dirname(MANIFEST_PATH), { recursive: true });
  fs.writeFileSync(MANIFEST_PATH, `${JSON.stringify(manifest, null, 2)}\n`);
}

function assertManifest(manifest, routes) {
  if (!manifest) {
    throw new Error(
      `Missing production route surface manifest at ${path.relative(process.cwd(), MANIFEST_PATH)}.`,
    );
  }

  const actualRoutes = new Set(routes);
  const missingCriticalRoutes = manifest.criticalRoutes.filter((route) => !actualRoutes.has(route));
  const missingManifestRoutes = manifest.sourceRoutes.filter((route) => !actualRoutes.has(route));
  const routeCount = routes.length;

  if (routeCount < manifest.minSourceRouteCount) {
    throw new Error(
      `Route surface shrank from ${manifest.minSourceRouteCount} to ${routeCount}. Update the manifest only for an intentional production route removal.`,
    );
  }

  if (missingCriticalRoutes.length > 0 || missingManifestRoutes.length > 0) {
    const lines = [
      "Production route surface regression detected.",
      "",
      ...missingCriticalRoutes.map((route) => `Missing critical route: ${route}`),
      ...missingManifestRoutes.map((route) => `Missing manifest route: ${route}`),
      "",
      "If this removal is intentional, update docs/reference/production-route-surface.json in the same PR.",
    ];
    throw new Error(lines.join("\n"));
  }

  console.log(`Production route surface passed: ${routeCount} source routes present.`);
}

function main() {
  const shouldUpdate = process.argv.includes("--update");
  const routes = discoverRoutes();
  const manifest = readManifest();

  if (shouldUpdate) {
    writeManifest(routes, manifest);
    console.log(`Updated production route surface manifest with ${routes.length} routes.`);
    return;
  }

  assertManifest(manifest, routes);
}

try {
  main();
} catch (error) {
  console.error(error instanceof Error ? error.message : String(error));
  process.exit(1);
}
