#!/usr/bin/env node

const COLLABORATOR_LOGIN = "aoengnatchasmith-spec";

const ALLOWED_PREFIXES = [
  "src/app/(app)/sales-dashboard/",
  "src/app/api/sales-dashboard/",
  "src/app/api/internal/sync-sales-dashboard/",
  "src/components/sales-dashboard/",
  "src/lib/sales-dashboard/",
];

function parseArgs(argv) {
  let actor = process.env.GITHUB_ACTOR ?? "";
  const files = [];

  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];

    if (arg === "--actor") {
      actor = argv[index + 1] ?? "";
      index += 1;
      continue;
    }

    if (arg.startsWith("--actor=")) {
      actor = arg.slice("--actor=".length);
      continue;
    }

    if (arg === "--") {
      files.push(...argv.slice(index + 1));
      break;
    }

    files.push(arg);
  }

  return { actor, files };
}

function normalizeRepoPath(filePath) {
  return filePath
    .replace(/\\/g, "/")
    .replace(/^\.\//, "")
    .replace(/^\/+/, "")
    .trim();
}

function isAllowedSalesDashboardPath(filePath) {
  const normalizedPath = normalizeRepoPath(filePath);
  return ALLOWED_PREFIXES.some((prefix) => normalizedPath.startsWith(prefix));
}

function formatAllowedPrefixes() {
  return ALLOWED_PREFIXES.map((prefix) => `  - ${prefix}**`).join("\n");
}

async function readStdinFiles() {
  if (process.stdin.isTTY) return [];

  let input = "";
  for await (const chunk of process.stdin) {
    input += chunk;
  }

  return input
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean);
}

async function main() {
  const { actor, files: argFiles } = parseArgs(process.argv.slice(2));
  const files = [...argFiles, ...(await readStdinFiles())]
    .map(normalizeRepoPath)
    .filter(Boolean);

  if (actor !== COLLABORATOR_LOGIN) {
    console.log(`Sales Dashboard scope check skipped for ${actor || "unknown actor"}.`);
    return;
  }

  const blockedFiles = files.filter((filePath) => !isAllowedSalesDashboardPath(filePath));

  if (blockedFiles.length === 0) {
    console.log("Sales Dashboard scope check passed.");
    return;
  }

  console.error(
    [
      `${COLLABORATOR_LOGIN} is limited to Sales Dashboard paths in this repository.`,
      "",
      "Blocked changed files:",
      ...blockedFiles.map((filePath) => `  - ${filePath}`),
      "",
      "Allowed paths:",
      formatAllowedPrefixes(),
      "",
      "Ask @kasheesh711 to make shared or out-of-scope changes.",
    ].join("\n"),
  );
  process.exit(1);
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exit(1);
});
