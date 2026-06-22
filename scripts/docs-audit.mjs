#!/usr/bin/env node

import fs from "node:fs";
import path from "node:path";
import { execFileSync } from "node:child_process";

const ROOT = process.cwd();
const STRICT = process.argv.includes("--strict");
const JSON_OUTPUT = process.argv.includes("--json");

const HTTP_METHODS = ["GET", "POST", "PATCH", "PUT", "DELETE", "OPTIONS"];
const LOCAL_LINK_EXTENSIONS = new Set([
  ".css",
  ".json",
  ".md",
  ".mjs",
  ".sql",
  ".ts",
  ".tsx",
  ".txt",
  ".yml",
  ".yaml",
]);

function toPosix(filePath) {
  return filePath.split(path.sep).join("/");
}

function relative(filePath) {
  return toPosix(path.relative(ROOT, filePath));
}

function readFileIfExists(filePath) {
  return fs.existsSync(filePath) ? fs.readFileSync(filePath, "utf8") : "";
}

function readJsonIfExists(filePath) {
  if (!fs.existsSync(filePath)) return null;
  return JSON.parse(fs.readFileSync(filePath, "utf8"));
}

function walk(dir, predicate = () => true) {
  if (!fs.existsSync(dir)) return [];

  const entries = fs.readdirSync(dir, { withFileTypes: true });
  const files = [];

  for (const entry of entries) {
    const fullPath = path.join(dir, entry.name);
    const rel = relative(fullPath);

    if (entry.isDirectory()) {
      if (
        entry.name === ".git" ||
        entry.name === ".claude" ||
        entry.name === ".next" ||
        entry.name === "node_modules" ||
        entry.name === "graphify-out"
      ) {
        continue;
      }
      files.push(...walk(fullPath, predicate));
      continue;
    }

    if (entry.isFile() && predicate(fullPath, rel)) {
      files.push(fullPath);
    }
  }

  return files.sort((a, b) => relative(a).localeCompare(relative(b)));
}

function lineForOffset(text, offset) {
  return text.slice(0, offset).split("\n").length;
}

function gitLastCommitDate(filePath) {
  try {
    return execFileSync("git", ["log", "-1", "--format=%cs", "--", filePath], {
      cwd: ROOT,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
    }).trim();
  } catch {
    return "";
  }
}

function appRouteFromFile(filePath) {
  const appDir = path.join(ROOT, "src", "app");
  const relativePath = toPosix(path.relative(appDir, filePath));
  const routePath = relativePath.replace(/\/?(page\.tsx|route\.ts)$/, "");
  const segments = routePath
    .split("/")
    .filter(Boolean)
    .filter((segment) => !(segment.startsWith("(") && segment.endsWith(")")))
    .filter((segment) => !segment.startsWith("@"));

  return segments.length === 0 ? "/" : `/${segments.join("/")}`;
}

function collectRoutes() {
  const appDir = path.join(ROOT, "src", "app");
  const pageFiles = walk(appDir, (_file, rel) => rel.endsWith("/page.tsx") || rel === "src/app/page.tsx");
  const routeFiles = walk(appDir, (_file, rel) => rel.endsWith("/route.ts"));

  const pageRoutes = [...new Set(pageFiles.map(appRouteFromFile))].sort();
  const apiRouteFiles = routeFiles.filter((file) => appRouteFromFile(file).startsWith("/api/"));
  const apiRoutes = [...new Set(apiRouteFiles.map(appRouteFromFile))].sort();

  const apiMethods = [];
  const methodRegexes = [
    new RegExp(`export\\s+(?:async\\s+)?function\\s+(${HTTP_METHODS.join("|")})\\b`, "g"),
    new RegExp(`export\\s+const\\s+(${HTTP_METHODS.join("|")})\\b`, "g"),
    new RegExp(`\\bas\\s+(${HTTP_METHODS.join("|")})\\b`, "g"),
  ];

  for (const file of apiRouteFiles) {
    const text = readFileIfExists(file);
    const methods = new Set();
    for (const regex of methodRegexes) {
      for (const match of text.matchAll(regex)) {
        methods.add(match[1]);
      }
    }

    apiMethods.push({
      file: relative(file),
      route: appRouteFromFile(file),
      methods: [...methods].sort((a, b) => HTTP_METHODS.indexOf(a) - HTTP_METHODS.indexOf(b)),
    });
  }

  return {
    pageRoutes,
    apiRoutes,
    apiMethods,
    counts: {
      pageRoutes: pageRoutes.length,
      apiRouteFiles: apiRouteFiles.length,
      apiRoutes: apiRoutes.length,
      apiMethodHandlers: apiMethods.reduce((sum, route) => sum + route.methods.length, 0),
      apiMethodHandlersExcludingOptions: apiMethods.reduce(
        (sum, route) => sum + route.methods.filter((method) => method !== "OPTIONS").length,
        0,
      ),
    },
  };
}

function collectSchema() {
  const schemaPath = path.join(ROOT, "src", "lib", "db", "schema.ts");
  const text = readFileIfExists(schemaPath);
  const tables = [];
  const enums = [];

  for (const match of text.matchAll(/export\s+const\s+(\w+)\s*=\s*pgTable\(\s*["'`]([^"'`]+)["'`]/g)) {
    tables.push({ exportName: match[1], sqlName: match[2] });
  }

  for (const match of text.matchAll(/export\s+const\s+(\w+)\s*=\s*pgEnum\(\s*["'`]([^"'`]+)["'`]/g)) {
    enums.push({ exportName: match[1], sqlName: match[2] });
  }

  return {
    schemaPath: relative(schemaPath),
    tables: tables.sort((a, b) => a.sqlName.localeCompare(b.sqlName)),
    enums: enums.sort((a, b) => a.sqlName.localeCompare(b.sqlName)),
    counts: {
      tables: tables.length,
      enums: enums.length,
    },
  };
}

function collectCrons() {
  const vercelPath = path.join(ROOT, "vercel.json");
  const vercel = readJsonIfExists(vercelPath);
  const crons = Array.isArray(vercel?.crons) ? vercel.crons : [];

  return {
    vercelPath: relative(vercelPath),
    crons: crons.map((cron) => ({
      path: String(cron.path ?? ""),
      schedule: String(cron.schedule ?? ""),
    })),
    counts: {
      vercelCrons: crons.length,
    },
  };
}

function collectEnvVars() {
  const envPath = path.join(ROOT, "src", "lib", "env.ts");
  const envText = readFileIfExists(envPath);
  const schemaVars = new Set();
  for (const match of envText.matchAll(/\b([A-Z][A-Z0-9_]*)\s*:\s*z\./g)) {
    schemaVars.add(match[1]);
  }

  const sourceFiles = walk(ROOT, (_file, rel) => /\.(?:cjs|js|mjs|ts|tsx)$/.test(rel));
  const processEnvVars = new Set();
  for (const file of sourceFiles) {
    const text = readFileIfExists(file);
    for (const match of text.matchAll(/\bprocess\.env\.([A-Z][A-Z0-9_]*)\b/g)) {
      processEnvVars.add(match[1]);
    }
    for (const match of text.matchAll(/\bprocess\.env\[['"]([A-Z][A-Z0-9_]*)['"]\]/g)) {
      processEnvVars.add(match[1]);
    }
  }

  const examplePath = path.join(ROOT, ".env.example");
  const exampleText = readFileIfExists(examplePath);
  const envExampleVars = new Set();
  for (const line of exampleText.split("\n")) {
    const match = line.match(/^\s*([A-Z][A-Z0-9_]*)\s*=/);
    if (match) envExampleVars.add(match[1]);
  }

  const envDocPath = path.join(ROOT, "docs", "reference", "env.md");
  const envDocText = readFileIfExists(envDocPath);
  const envDocVars = new Set();
  for (const match of envDocText.matchAll(/`([A-Z][A-Z0-9_]*)`/g)) {
    envDocVars.add(match[1]);
  }

  return {
    envPath: relative(envPath),
    envExamplePath: fs.existsSync(examplePath) ? relative(examplePath) : null,
    envDocPath: relative(envDocPath),
    schemaVars: [...schemaVars].sort(),
    processEnvVars: [...processEnvVars].sort(),
    envExampleVars: [...envExampleVars].sort(),
    envDocVars: [...envDocVars].sort(),
    mismatches: {
      schemaVarsMissingFromDocs: [...schemaVars].filter((name) => !envDocVars.has(name)).sort(),
      processEnvVarsMissingFromDocs: [...processEnvVars].filter((name) => !envDocVars.has(name)).sort(),
      envExampleVarsMissingFromDocs: [...envExampleVars].filter((name) => !envDocVars.has(name)).sort(),
      documentedVarsNotSeenInCodeOrExample: [...envDocVars]
        .filter((name) => !schemaVars.has(name) && !processEnvVars.has(name) && !envExampleVars.has(name))
        .sort(),
    },
  };
}

function markdownFiles() {
  const docs = walk(path.join(ROOT, "docs"), (_file, rel) => rel.endsWith(".md"));
  const rootDocs = ["AGENTS.md", "PRD.md", "README.md"]
    .map((name) => path.join(ROOT, name))
    .filter((file) => fs.existsSync(file));
  return [...rootDocs, ...docs].sort((a, b) => relative(a).localeCompare(relative(b)));
}

function normalizeMarkdownTarget(rawTarget) {
  let target = rawTarget.trim();
  if (!target) return "";

  if (target.startsWith("<") && target.endsWith(">")) {
    target = target.slice(1, -1);
  } else {
    const titleIndex = target.search(/\s+["'][^"']*["']\s*$/);
    if (titleIndex >= 0) target = target.slice(0, titleIndex);
  }

  return target.trim();
}

function stripAnchorAndQuery(target) {
  const withoutAnchor = target.split("#")[0];
  return withoutAnchor.split("?")[0];
}

function shouldCheckLocalTarget(target) {
  if (!target || target.startsWith("#")) return false;
  if (/^[a-z][a-z0-9+.-]*:/i.test(target)) return false;
  if (target.startsWith("//")) return false;

  const withoutAnchor = stripAnchorAndQuery(target);
  if (!withoutAnchor) return false;

  if (path.isAbsolute(withoutAnchor)) return true;
  const ext = path.extname(withoutAnchor);
  return !ext || LOCAL_LINK_EXTENSIONS.has(ext);
}

function collectMarkdownLinks() {
  const files = markdownFiles();
  const brokenLinks = [];
  const absoluteLocalLinks = [];
  let checkedLinks = 0;

  for (const file of files) {
    const text = readFileIfExists(file);
    const withoutFencedCode = text.replace(/```[\s\S]*?```/g, "");
    const linkRegex = /!?\[[^\]\n]*\]\(([^)\n]+)\)/g;

    for (const match of withoutFencedCode.matchAll(linkRegex)) {
      const rawTarget = normalizeMarkdownTarget(match[1]);
      if (!shouldCheckLocalTarget(rawTarget)) continue;

      checkedLinks += 1;
      const targetWithoutAnchor = stripAnchorAndQuery(rawTarget);
      let decodedTarget = targetWithoutAnchor;
      try {
        decodedTarget = decodeURI(targetWithoutAnchor);
      } catch {
        // Keep the raw target if it is not URI-encoded.
      }

      const resolved = path.isAbsolute(decodedTarget)
        ? decodedTarget
        : path.resolve(path.dirname(file), decodedTarget);
      const exists = fs.existsSync(resolved);
      const record = {
        file: relative(file),
        line: lineForOffset(withoutFencedCode, match.index ?? 0),
        target: rawTarget,
        resolved,
      };

      if (path.isAbsolute(decodedTarget)) {
        absoluteLocalLinks.push({ ...record, exists });
      }

      if (!exists) {
        brokenLinks.push(record);
      }
    }
  }

  return {
    checkedLinks,
    brokenLinks,
    absoluteLocalLinks,
  };
}

function collectVerificationFooters() {
  const files = markdownFiles().filter((file) => {
    const rel = relative(file);
    if (rel.startsWith("docs/superpowers/")) return false;
    if (/^docs\/ai-scheduler-(?:audit|eval|model|replay)/.test(rel)) return false;
    if (rel === "PRD.md") return false;
    return (
      rel === "AGENTS.md" ||
      rel === "docs/README.md" ||
      rel === "docs/OPEN-QUESTIONS.md" ||
      rel.startsWith("docs/features/") ||
      rel.startsWith("docs/handbook/") ||
      rel.startsWith("docs/operations/") ||
      rel.startsWith("docs/reference/")
    );
  });

  const missing = [];
  const stale = [];
  const footers = [];
  const footerRegex = /_Verified against (?<target>.+?) on (?<date>\d{4}-\d{2}-\d{2})\._/;

  for (const file of files) {
    const text = readFileIfExists(file);
    const match = text.match(footerRegex);
    const lastCommitDate = gitLastCommitDate(file);

    if (!match?.groups) {
      missing.push({ file: relative(file), lastCommitDate });
      continue;
    }

    const footer = {
      file: relative(file),
      target: match.groups.target,
      date: match.groups.date,
      lastCommitDate,
    };
    footers.push(footer);

    if (lastCommitDate && match.groups.date < lastCommitDate) {
      stale.push(footer);
    }
  }

  return { checkedFiles: files.length, missing, stale, footers };
}

function findCountClaims(actualCounts) {
  const targetFiles = [
    "AGENTS.md",
    "docs/README.md",
    "docs/reference/api/index.md",
    "docs/reference/database/index.md",
    "docs/reference/crons.md",
  ]
    .map((name) => path.join(ROOT, name))
    .filter((file) => fs.existsSync(file));

  const patterns = [
    {
      name: "feature-docs",
      actual: actualCounts.featureDocs,
      regexes: [/\b(\d+)\s+feature areas\b/gi, /\ball\s+(\d+)\s+features\b/gi],
    },
    {
      name: "database-tables",
      actual: actualCounts.databaseTables,
      regexes: [/\b(\d+)\s+database tables\b/gi, /Database schema\s*\((\d+)\s+tables\b/gi],
    },
    {
      name: "http-method-handlers-excluding-options",
      actual: actualCounts.apiMethodHandlersExcludingOptions,
      regexes: [/\b(\d+)\s+HTTP endpoints\b/gi],
    },
    {
      name: "application-page-routes",
      actual: actualCounts.pageRoutes,
      regexes: [/\b(\d+)\s+application pages\b/gi],
    },
    {
      name: "vercel-crons",
      actual: actualCounts.vercelCrons,
      regexes: [/\b(\d+)\s+Vercel Cron entries\b/gi],
    },
  ];

  const claims = [];
  const mismatches = [];

  for (const file of targetFiles) {
    const text = readFileIfExists(file);
    for (const pattern of patterns) {
      for (const regex of pattern.regexes) {
        for (const match of text.matchAll(regex)) {
          const claimed = Number(match[1]);
          const record = {
            file: relative(file),
            line: lineForOffset(text, match.index ?? 0),
            kind: pattern.name,
            claimed,
            actual: pattern.actual,
            text: match[0],
          };
          claims.push(record);
          if (Number.isFinite(claimed) && claimed !== pattern.actual) {
            mismatches.push(record);
          }
        }
      }
    }
  }

  return { claims, mismatches };
}

function collectDocs() {
  const docsFiles = walk(path.join(ROOT, "docs"), (_file, rel) => rel.endsWith(".md"));
  const featureDocs = docsFiles.filter((file) => relative(file).startsWith("docs/features/"));
  return {
    markdownFiles: docsFiles.map(relative),
    featureDocs: featureDocs.map(relative),
    counts: {
      markdownFiles: docsFiles.length,
      featureDocs: featureDocs.length,
    },
  };
}

function buildReport() {
  const docs = collectDocs();
  const routes = collectRoutes();
  const schema = collectSchema();
  const crons = collectCrons();
  const env = collectEnvVars();
  const links = collectMarkdownLinks();
  const verificationFooters = collectVerificationFooters();
  const countClaims = findCountClaims({
    featureDocs: docs.counts.featureDocs,
    databaseTables: schema.counts.tables,
    pageRoutes: routes.counts.pageRoutes,
    apiMethodHandlersExcludingOptions: routes.counts.apiMethodHandlersExcludingOptions,
    vercelCrons: crons.counts.vercelCrons,
  });

  const errors = [];
  const warnings = [];

  if (links.brokenLinks.length > 0) {
    errors.push({
      code: "broken-markdown-links",
      message: `${links.brokenLinks.length} local markdown links do not resolve.`,
      details: links.brokenLinks,
    });
  }

  const staleAbsoluteLinks = links.absoluteLocalLinks.filter((link) => !link.resolved.startsWith(ROOT));
  if (staleAbsoluteLinks.length > 0) {
    warnings.push({
      code: "absolute-local-links",
      message: `${staleAbsoluteLinks.length} markdown links use absolute local filesystem paths outside this checkout.`,
      details: staleAbsoluteLinks,
    });
  }

  if (verificationFooters.missing.length > 0) {
    warnings.push({
      code: "missing-verification-footers",
      message: `${verificationFooters.missing.length} canonical docs are missing verification footers.`,
      details: verificationFooters.missing,
    });
  }

  if (verificationFooters.stale.length > 0) {
    warnings.push({
      code: "stale-verification-footers",
      message: `${verificationFooters.stale.length} canonical docs were changed after their verification footer date.`,
      details: verificationFooters.stale,
    });
  }

  if (countClaims.mismatches.length > 0) {
    warnings.push({
      code: "stale-count-claims",
      message: `${countClaims.mismatches.length} high-confidence count claims differ from current code-derived counts.`,
      details: countClaims.mismatches,
    });
  }

  const envMismatchCount = Object.values(env.mismatches).reduce((sum, list) => sum + list.length, 0);
  if (envMismatchCount > 0) {
    warnings.push({
      code: "env-var-doc-drift",
      message: `${envMismatchCount} env-var references differ across code, .env.example, and docs/reference/env.md.`,
      details: env.mismatches,
    });
  }

  return {
    generatedAt: new Date().toISOString(),
    root: ROOT,
    summary: {
      docsMarkdownFiles: docs.counts.markdownFiles,
      featureDocs: docs.counts.featureDocs,
      pageRoutes: routes.counts.pageRoutes,
      apiRoutes: routes.counts.apiRoutes,
      apiRouteFiles: routes.counts.apiRouteFiles,
      apiMethodHandlers: routes.counts.apiMethodHandlers,
      apiMethodHandlersExcludingOptions: routes.counts.apiMethodHandlersExcludingOptions,
      databaseTables: schema.counts.tables,
      databaseEnums: schema.counts.enums,
      vercelCrons: crons.counts.vercelCrons,
      checkedMarkdownLinks: links.checkedLinks,
      brokenMarkdownLinks: links.brokenLinks.length,
      warnings: warnings.length,
      errors: errors.length,
    },
    inventories: {
      docs,
      routes,
      schema,
      crons,
      env,
      links,
      verificationFooters,
      countClaims,
    },
    errors,
    warnings,
  };
}

function printTextReport(report) {
  console.log("Docs audit summary");
  console.log(`- Docs markdown files: ${report.summary.docsMarkdownFiles}`);
  console.log(`- Feature docs: ${report.summary.featureDocs}`);
  console.log(`- Page routes: ${report.summary.pageRoutes}`);
  console.log(
    `- API route files/routes/methods: ${report.summary.apiRouteFiles}/${report.summary.apiRoutes}/${report.summary.apiMethodHandlers} (${report.summary.apiMethodHandlersExcludingOptions} excluding OPTIONS)`,
  );
  console.log(`- Database tables/enums: ${report.summary.databaseTables}/${report.summary.databaseEnums}`);
  console.log(`- Vercel crons: ${report.summary.vercelCrons}`);
  console.log(
    `- Markdown links checked/broken: ${report.summary.checkedMarkdownLinks}/${report.summary.brokenMarkdownLinks}`,
  );
  console.log(`- Errors: ${report.summary.errors}`);
  console.log(`- Warnings: ${report.summary.warnings}`);

  if (report.errors.length > 0) {
    console.log("\nErrors");
    for (const error of report.errors) {
      console.log(`- ${error.code}: ${error.message}`);
      for (const detail of error.details.slice(0, 10)) {
        console.log(`  ${detail.file}:${detail.line} -> ${detail.target}`);
      }
      if (error.details.length > 10) console.log(`  ... ${error.details.length - 10} more`);
    }
  }

  if (report.warnings.length > 0) {
    console.log("\nWarnings");
    for (const warning of report.warnings) {
      console.log(`- ${warning.code}: ${warning.message}`);
      if (Array.isArray(warning.details)) {
        for (const detail of warning.details.slice(0, 8)) {
          const location = detail.file && detail.line ? `${detail.file}:${detail.line}` : detail.file;
          console.log(`  ${location ?? JSON.stringify(detail)}`);
        }
        if (warning.details.length > 8) console.log(`  ... ${warning.details.length - 8} more`);
      } else {
        console.log(`  ${JSON.stringify(warning.details)}`);
      }
    }
  }
}

const report = buildReport();

if (JSON_OUTPUT) {
  console.log(JSON.stringify(report, null, 2));
} else {
  printTextReport(report);
}

if (report.errors.length > 0 || (STRICT && report.warnings.length > 0)) {
  process.exit(1);
}
