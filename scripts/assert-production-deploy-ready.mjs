#!/usr/bin/env node

import { execFileSync } from "node:child_process";

const REQUIRED_BRANCH = process.env.PRODUCTION_BRANCH ?? "main";

function git(args) {
  return execFileSync("git", args, { encoding: "utf8" }).trim();
}

function fail(message) {
  console.error(message);
  process.exit(1);
}

function main() {
  const branch = git(["branch", "--show-current"]);
  if (branch !== REQUIRED_BRANCH) {
    fail(`Refusing production deploy from '${branch}'. Check out '${REQUIRED_BRANCH}' first.`);
  }

  const status = git(["status", "--porcelain=v1"]);
  if (status.length > 0) {
    fail(
      [
        "Refusing production deploy from a dirty worktree.",
        "",
        status,
        "",
        "Commit, stash, or discard local changes before deploying.",
      ].join("\n"),
    );
  }

  const head = git(["rev-parse", "HEAD"]);
  const originHead = git(["rev-parse", `origin/${REQUIRED_BRANCH}`]);
  if (head !== originHead) {
    fail(
      `Refusing production deploy because HEAD (${head}) does not match origin/${REQUIRED_BRANCH} (${originHead}). Run git fetch/pull and deploy the pushed commit.`,
    );
  }

  console.log(`Production deploy preflight passed for ${REQUIRED_BRANCH} at ${head}.`);
}

main();
