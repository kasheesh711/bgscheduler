import fs from "node:fs";
import path from "node:path";

const ROOT = process.cwd();
const FAILURES = [];
const WARNINGS = [];

function read(file) {
  return fs.readFileSync(path.join(ROOT, file), "utf8");
}

function listFiles(dir, predicate, files = []) {
  for (const entry of fs.readdirSync(path.join(ROOT, dir), { withFileTypes: true })) {
    if (["node_modules", ".next", ".git", "coverage"].includes(entry.name)) continue;
    const rel = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      listFiles(rel, predicate, files);
    } else if (predicate(rel)) {
      files.push(rel);
    }
  }
  return files;
}

function fail(message) {
  FAILURES.push(message);
}

function warn(message) {
  WARNINGS.push(message);
}

function uniqSorted(values) {
  return [...new Set(values)].sort();
}

function parseSchemaEnvVars() {
  return uniqSorted([...read("src/lib/env.ts").matchAll(/^\s*([A-Z0-9_]+):/gm)].map((match) => match[1]));
}

function parseExampleEnvVars() {
  return uniqSorted(read(".env.example").split(/\r?\n/)
    .map((line) => line.match(/^([A-Z0-9_]+)=/))
    .filter(Boolean)
    .map((match) => match[1]));
}

function parseSourceEnvVars() {
  const files = listFiles("src", (file) => /\.(ts|tsx)$/.test(file) && !file.includes("__tests__"));
  const vars = [];

  for (const file of files) {
    const source = read(file);
    const stringConstants = new Map(
      [...source.matchAll(/const\s+([A-Z0-9_]+)\s*=\s*"([A-Z0-9_]+)"/g)]
        .map((match) => [match[1], match[2]]),
    );

    for (const match of source.matchAll(/process\.env(?:\.([A-Z0-9_]+)|\[['"]([A-Z0-9_]+)['"]\]|\[([A-Z0-9_]+)\])/g)) {
      const literal = match[1] || match[2];
      const constantName = match[3];
      const resolved = literal || stringConstants.get(constantName);
      if (resolved) vars.push(resolved);
    }
  }

  return uniqSorted(vars);
}

function auditEnvDocs() {
  const schemaVars = parseSchemaEnvVars();
  const exampleVars = parseExampleEnvVars();
  const sourceVars = parseSourceEnvVars();
  const envDoc = read("docs/reference/env.md");
  const documentedVars = uniqSorted([...envDoc.matchAll(/`([A-Z][A-Z0-9_]+)`/g)].map((match) => match[1]));
  const exampleExempt = new Set(["VERCEL_PROJECT_PRODUCTION_URL", "VERCEL_URL"]);

  const missingFromDocs = sourceVars.filter((envVar) => !documentedVars.includes(envVar));
  if (missingFromDocs.length) {
    fail(`docs/reference/env.md is missing runtime env vars: ${missingFromDocs.join(", ")}`);
  }

  const missingFromExample = sourceVars.filter((envVar) => !exampleExempt.has(envVar) && !exampleVars.includes(envVar));
  if (missingFromExample.length) {
    fail(`.env.example is missing runtime env vars: ${missingFromExample.join(", ")}`);
  }

  const schemaMissingFromDocs = schemaVars.filter((envVar) => !documentedVars.includes(envVar));
  if (schemaMissingFromDocs.length) {
    fail(`docs/reference/env.md is missing schema env vars: ${schemaMissingFromDocs.join(", ")}`);
  }
}

function parseSchemaTables() {
  const schema = read("src/lib/db/schema.ts");
  return [...schema.matchAll(/export\s+const\s+(\w+)\s*=\s*pgTable\(\s*"([^"]+)"/g)]
    .map((match) => ({ constName: match[1], tableName: match[2] }));
}

function auditDatabaseIndex() {
  const tables = parseSchemaTables();
  const dbIndex = read("docs/reference/database/index.md");
  const documentedRows = [...dbIndex.matchAll(/^\| `([^`]+)` \| `([^`]+)` \|/gm)]
    .map((match) => ({ tableName: match[1], constName: match[2] }));
  const documentedTables = documentedRows.map((row) => row.tableName);
  const schemaTables = tables.map((table) => table.tableName);

  const missingFromIndex = schemaTables.filter((tableName) => !documentedTables.includes(tableName));
  if (missingFromIndex.length) {
    fail(`docs/reference/database/index.md is missing tables: ${missingFromIndex.join(", ")}`);
  }

  const extraInIndex = documentedTables.filter((tableName) => !schemaTables.includes(tableName));
  if (extraInIndex.length) {
    fail(`docs/reference/database/index.md lists tables not in schema.ts: ${extraInIndex.join(", ")}`);
  }

  const countMatch = dbIndex.match(/All (\d+) tables/);
  if (!countMatch || Number(countMatch[1]) !== tables.length) {
    fail(`docs/reference/database/index.md header count is ${countMatch?.[1] ?? "missing"}; schema.ts has ${tables.length} pgTable exports`);
  }

  const totalRowMatch = dbIndex.match(/\| \*\*Total\*\* \| \*\*(\d+)\*\* \|/);
  if (!totalRowMatch || Number(totalRowMatch[1]) !== tables.length) {
    fail(`docs/reference/database/index.md domain total is ${totalRowMatch?.[1] ?? "missing"}; schema.ts has ${tables.length} pgTable exports`);
  }
}

function auditEnumReference() {
  const schema = read("src/lib/db/schema.ts");
  const schemaEnums = [...schema.matchAll(/export\s+const\s+\w+\s*=\s*pgEnum\(\s*"([^"]+)"/g)].map((match) => match[1]);
  const enumDoc = read("docs/reference/database/enums.md");
  const documentedEnums = [...enumDoc.matchAll(/^## `([^`]+)`/gm)].map((match) => match[1]);

  const missingEnums = schemaEnums.filter((enumName) => !documentedEnums.includes(enumName));
  if (missingEnums.length) {
    fail(`docs/reference/database/enums.md is missing enums: ${missingEnums.join(", ")}`);
  }
}

function auditMigrations() {
  const journal = JSON.parse(read("drizzle/meta/_journal.json"));
  const journalTags = journal.entries.map((entry) => entry.tag);
  const sqlTags = fs.readdirSync(path.join(ROOT, "drizzle"))
    .filter((file) => file.endsWith(".sql"))
    .map((file) => file.replace(/\.sql$/, ""));

  const missingSql = journalTags.filter((tag) => !sqlTags.includes(tag));
  if (missingSql.length) {
    fail(`drizzle/meta/_journal.json entries without SQL files: ${missingSql.join(", ")}`);
  }

  const untrackedSql = sqlTags.filter((tag) => !journalTags.includes(tag));
  if (untrackedSql.length) {
    fail(`drizzle SQL files absent from _journal.json: ${untrackedSql.join(", ")}`);
  }

  const prefixMap = new Map();
  for (const tag of journalTags) {
    const prefix = tag.match(/^\d+/)?.[0] ?? tag;
    prefixMap.set(prefix, [...(prefixMap.get(prefix) ?? []), tag]);
  }
  const duplicates = [...prefixMap.values()].filter((tags) => tags.length > 1);
  if (duplicates.length) {
    warn(`duplicate Drizzle numeric migration prefixes remain: ${duplicates.map((tags) => tags.join(" / ")).join("; ")}`);
  }
}

auditEnvDocs();
auditDatabaseIndex();
auditEnumReference();
auditMigrations();

for (const message of WARNINGS) {
  console.warn(`docs:audit warning: ${message}`);
}

if (FAILURES.length) {
  for (const message of FAILURES) {
    console.error(`docs:audit failure: ${message}`);
  }
  process.exit(1);
}

console.log("docs:audit passed");
