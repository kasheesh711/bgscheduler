#!/usr/bin/env node

import path from "node:path";
import { execFileSync } from "node:child_process";

const COLLABORATOR_LOGIN = "aoengnatchasmith-spec";
const PROJECT_DIR = path.resolve(process.env.CLAUDE_PROJECT_DIR ?? process.cwd());

const ALLOWED_PREFIXES = [
  "src/app/(app)/sales-dashboard/",
  "src/app/api/sales-dashboard/",
  "src/app/api/internal/sync-sales-dashboard/",
  "src/components/sales-dashboard/",
  "src/lib/sales-dashboard/",
];

const SENSITIVE_PATTERNS = [
  /^\.env(?:\.|$)/,
  /^\.vercel(?:\/|$)/,
  /^.*\.pem$/,
  /^.*\.key$/,
  /^.*\.p12$/,
  /^.*\.xlsx$/,
  /^.*\.xls$/,
  /^Availability\.xlsx$/,
  /^Upcoming Sessions\.xlsx$/,
];

const BLOCKED_COMMANDS = [
  {
    pattern: /\b(?:npx\s+)?vercel\b[\s\S]*\s--prod(?:\s|$)/,
    reason: "Production Vercel deploys must be done by @kasheesh711.",
  },
  {
    pattern: /\bgit\s+push\b[\s\S]*(?:--force|-f|--force-with-lease)/,
    reason: "Force pushes are blocked for collaborator Claude sessions.",
  },
  {
    pattern: /\bgit\s+push\b[\s\S]*(?:\borigin\b[\s\S]*)?\b(?:main|master)\b/,
    reason: "Direct pushes to main/master are blocked. Open a pull request instead.",
  },
  {
    pattern: /\bgit\s+reset\b[\s\S]*\s--hard(?:\s|$)/,
    reason: "Destructive git reset is blocked.",
  },
  {
    pattern: /\bgit\s+checkout\b[\s\S]*(?:\s--\s(?:\.|\*)|\s-f(?:\s|$))/,
    reason: "Destructive git checkout is blocked.",
  },
  {
    pattern: /\bgit\s+clean\b[\s\S]*(?:\s-[a-zA-Z]*f[a-zA-Z]*d|\s-[a-zA-Z]*d[a-zA-Z]*f)/,
    reason: "Destructive git clean is blocked.",
  },
  {
    pattern: /\brm\s+-[a-zA-Z]*r[a-zA-Z]*f[a-zA-Z]*(?:\s+\.\/?\*|\s+\*|\s+\.|\s+\/)(?:\s|$)/,
    reason: "Broad recursive deletion is blocked.",
  },
  {
    pattern: /\bcurl\b[\s\S]*https:\/\/bgscheduler\.vercel\.app\/api\/internal\/sync-[a-z-]+/,
    reason: "Production sync endpoints must not be triggered from collaborator Claude sessions.",
  },
  {
    pattern: /\b(?:cat|sed|grep|rg|awk|head|tail|less|more)\b[\s\S]*(?:\.env(?:\.|\s|$)|\.vercel(?:\/|\s|$))/,
    reason: "Commands that read local secrets or Vercel credentials are blocked.",
  },
];

function normalizeRepoPath(filePath) {
  if (!filePath) return "";

  const resolvedPath = path.isAbsolute(filePath)
    ? path.resolve(filePath)
    : path.resolve(PROJECT_DIR, filePath);

  let relativePath = path.relative(PROJECT_DIR, resolvedPath);
  if (relativePath.startsWith("..") || path.isAbsolute(relativePath)) {
    return resolvedPath.replace(/\\/g, "/");
  }

  return relativePath.replace(/\\/g, "/");
}

function isAllowedEditPath(filePath) {
  const repoPath = normalizeRepoPath(filePath);
  return ALLOWED_PREFIXES.some((prefix) => repoPath.startsWith(prefix));
}

function isSensitivePath(filePath) {
  const repoPath = normalizeRepoPath(filePath);
  return SENSITIVE_PATTERNS.some((pattern) => pattern.test(repoPath));
}

function deny(reason) {
  console.error(reason);
  process.exit(2);
}

function allow() {
  process.exit(0);
}

function reminder() {
  console.log(
    [
      `Claude collaborator guardrail reminder for ${COLLABORATOR_LOGIN}:`,
      "- Read CLAUDE.md and follow AGENTS.md before editing.",
      "- Stay inside Sales Dashboard paths unless @kasheesh711 makes the shared change.",
      "- Do not read local secrets or production credentials.",
      "- Open a pull request; do not push directly to main or deploy production.",
    ].join("\n"),
  );
}

function collectFilePaths(toolName, toolInput) {
  if (toolName === "Edit" || toolName === "MultiEdit" || toolName === "Write" || toolName === "Read") {
    return [toolInput?.file_path].filter(Boolean);
  }

  return [];
}

function checkPreToolUse(payload) {
  const toolName = payload.tool_name;
  const toolInput = payload.tool_input ?? {};

  if (toolName === "Edit" || toolName === "MultiEdit" || toolName === "Write") {
    for (const filePath of collectFilePaths(toolName, toolInput)) {
      if (!isAllowedEditPath(filePath)) {
        deny(
          [
            "This collaborator Claude session can only edit Sales Dashboard paths.",
            `Blocked path: ${normalizeRepoPath(filePath)}`,
            "Ask @kasheesh711 to make shared or out-of-scope changes.",
          ].join("\n"),
        );
      }
    }
  }

  if (toolName === "Read") {
    for (const filePath of collectFilePaths(toolName, toolInput)) {
      if (isSensitivePath(filePath)) {
        deny(`Reading sensitive local files is blocked: ${normalizeRepoPath(filePath)}`);
      }
    }
  }

  if (toolName === "Bash") {
    const command = String(toolInput.command ?? "");

    for (const blocked of BLOCKED_COMMANDS) {
      if (blocked.pattern.test(command)) {
        deny(blocked.reason);
      }
    }

    if (/\bgit\s+push\b/.test(command) && currentBranchIsMain()) {
      deny("git push from main/master is blocked. Open a pull request from a feature branch.");
    }
  }
}

function currentBranchIsMain() {
  try {
    const branch = execFileSync("git", ["branch", "--show-current"], {
      cwd: PROJECT_DIR,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
    }).trim();
    return branch === "main" || branch === "master";
  } catch {
    return false;
  }
}

async function readPayload() {
  let input = "";
  for await (const chunk of process.stdin) {
    input += chunk;
  }

  if (!input.trim()) return {};
  return JSON.parse(input);
}

const payload = await readPayload();

if (payload.hook_event_name === "UserPromptSubmit") {
  reminder();
  allow();
}

if (payload.hook_event_name === "PreToolUse") {
  checkPreToolUse(payload);
}

allow();
