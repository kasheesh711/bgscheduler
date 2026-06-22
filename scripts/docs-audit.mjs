import { readdirSync, readFileSync, statSync } from "node:fs";
import path from "node:path";

const ROOT = process.cwd();

const failures = [];

function read(relativePath) {
  return readFileSync(path.join(ROOT, relativePath), "utf8");
}

function fail(message) {
  failures.push(message);
}

function walk(relativePath, files = []) {
  const absolutePath = path.join(ROOT, relativePath);
  for (const entry of readdirSync(absolutePath)) {
    const childRelativePath = path.join(relativePath, entry);
    const childAbsolutePath = path.join(ROOT, childRelativePath);
    const stats = statSync(childAbsolutePath);
    if (stats.isDirectory()) {
      if (
        entry === "node_modules" ||
        entry === ".next" ||
        entry === ".git" ||
        entry === "coverage" ||
        entry === "__tests__"
      ) {
        continue;
      }
      walk(childRelativePath, files);
      continue;
    }
    if (
      /\.(?:ts|tsx|js|jsx|mjs|cjs)$/.test(entry) &&
      !/\.test\./.test(entry) &&
      !/\.integration\./.test(entry)
    ) {
      files.push(childRelativePath);
    }
  }
  return files;
}

function isWriteOnlyEnvAccess(line, matchStart, matchEnd) {
  const before = line.slice(0, matchStart);
  const after = line.slice(matchEnd);
  return /\bdelete\s+$/.test(before) || /^\s*=/.test(after);
}

function collectProcessEnvVariables() {
  const candidateFiles = [
    ...walk("src"),
    ...walk("scripts"),
    "drizzle.config.ts",
    "vitest.config.ts",
  ].filter((file, index, all) => all.indexOf(file) === index);

  const variables = new Set();
  const dynamicPatterns = new Set();

  for (const file of candidateFiles) {
    const text = read(file);
    if (!text.includes("process.env") && !text.includes("envNumber(")) continue;

    for (const line of text.split("\n")) {
      let match;
      const dotPattern = /process\.env\.([A-Z0-9_]+)/g;
      while ((match = dotPattern.exec(line)) !== null) {
        if (!isWriteOnlyEnvAccess(line, match.index, dotPattern.lastIndex)) {
          variables.add(match[1]);
        }
      }

      const bracketPattern = /process\.env\[\s*["'`]([A-Z0-9_]+)["'`]\s*\]/g;
      while ((match = bracketPattern.exec(line)) !== null) {
        if (!isWriteOnlyEnvAccess(line, match.index, bracketPattern.lastIndex)) {
          variables.add(match[1]);
        }
      }

      const envNumberPattern = /envNumber\(\s*["'`]([A-Z0-9_]+)["'`]/g;
      while ((match = envNumberPattern.exec(line)) !== null) {
        variables.add(match[1]);
      }

      if (line.includes("process.env[`COMPETITOR_")) {
        dynamicPatterns.add("COMPETITOR_<PROVIDER>_MONTHLY_CAP_USD");
      }
    }
  }

  return {
    variables: [...variables].sort(),
    dynamicPatterns: [...dynamicPatterns].sort(),
  };
}

function collectSchemaEnvVariables() {
  const envSource = read("src/lib/env.ts");
  const schemaBlock = envSource.match(/const envSchema = z\.object\(\{([\s\S]*?)\n\}\);/);
  if (!schemaBlock) {
    fail("Could not locate envSchema in src/lib/env.ts");
    return [];
  }
  return [...schemaBlock[1].matchAll(/^\s*([A-Z0-9_]+):/gm)]
    .map((match) => match[1])
    .sort();
}

function auditEnvironmentDocs() {
  const envDoc = read("docs/reference/env.md");
  const envExample = read(".env.example");
  const { variables, dynamicPatterns } = collectProcessEnvVariables();
  const schemaVariables = collectSchemaEnvVariables();

  for (const variable of [...new Set([...variables, ...schemaVariables])].sort()) {
    if (!envDoc.includes(variable)) {
      fail(`docs/reference/env.md does not mention ${variable}`);
    }
  }

  for (const pattern of dynamicPatterns) {
    if (!envDoc.includes(pattern)) {
      fail(`docs/reference/env.md does not mention dynamic env pattern ${pattern}`);
    }
  }

  const exampleExemptions = new Set([
    "GITHUB_ACTOR",
    "USER",
    "VERCEL_PROJECT_PRODUCTION_URL",
    "VERCEL_URL",
  ]);
  for (const variable of [...new Set([...variables, ...schemaVariables])].sort()) {
    if (exampleExemptions.has(variable)) continue;
    if (!envExample.includes(variable)) {
      fail(`.env.example does not mention ${variable}`);
    }
  }
}

function auditDatabaseDocs() {
  const schema = read("src/lib/db/schema.ts");
  const databaseIndex = read("docs/reference/database/index.md");
  const tableNames = [...schema.matchAll(/export const\s+\w+\s*=\s*pgTable\(\s*["'`]([^"'`]+)["'`]/g)]
    .map((match) => match[1])
    .sort();
  const uniqueTableNames = [...new Set(tableNames)];

  if (tableNames.length !== uniqueTableNames.length) {
    fail("src/lib/db/schema.ts contains duplicate pgTable SQL names");
  }

  const count = uniqueTableNames.length;
  if (!databaseIndex.includes(`All ${count} tables`)) {
    fail(`docs/reference/database/index.md does not state the current ${count}-table schema count`);
  }
  if (!databaseIndex.includes(`| **Total** | **${count}** |`)) {
    fail(`docs/reference/database/index.md domain map total is not ${count}`);
  }

  for (const tableName of uniqueTableNames) {
    if (!databaseIndex.includes(`\`${tableName}\``)) {
      fail(`docs/reference/database/index.md does not list table ${tableName}`);
    }
  }
}

function auditMigrations() {
  const journal = JSON.parse(read("drizzle/meta/_journal.json"));
  const journalTags = journal.entries.map((entry) => entry.tag).sort();
  const sqlTags = readdirSync(path.join(ROOT, "drizzle"))
    .filter((entry) => entry.endsWith(".sql"))
    .map((entry) => entry.replace(/\.sql$/, ""))
    .sort();

  const journalOnly = journalTags.filter((tag) => !sqlTags.includes(tag));
  const sqlOnly = sqlTags.filter((tag) => !journalTags.includes(tag));
  if (journalOnly.length) {
    fail(`Migration journal tags without SQL files: ${journalOnly.join(", ")}`);
  }
  if (sqlOnly.length) {
    fail(`Migration SQL files missing from journal: ${sqlOnly.join(", ")}`);
  }

  const byNumericPrefix = new Map();
  for (const tag of sqlTags) {
    const prefix = tag.match(/^\d+/)?.[0];
    if (!prefix) continue;
    byNumericPrefix.set(prefix, [...(byNumericPrefix.get(prefix) ?? []), tag]);
  }

  const duplicates = [...byNumericPrefix.entries()].filter(([, tags]) => tags.length > 1);
  if (duplicates.length) {
    const openQuestions = read("docs/OPEN-QUESTIONS.md");
    for (const [prefix, tags] of duplicates) {
      if (!openQuestions.includes(prefix) || tags.some((tag) => !openQuestions.includes(tag))) {
        fail(`Duplicate migration prefix ${prefix} is not documented in docs/OPEN-QUESTIONS.md`);
      }
    }
  }
}

auditEnvironmentDocs();
auditDatabaseDocs();
auditMigrations();

if (failures.length) {
  console.error("docs:audit failed:");
  for (const message of failures) {
    console.error(`- ${message}`);
  }
  process.exit(1);
}

console.log("docs:audit passed");
