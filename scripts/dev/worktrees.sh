#!/usr/bin/env bash
# Worktree hygiene for agent work in this repo (policy: CLAUDE.md "Worktrees").
#
#   scripts/dev/worktrees.sh status                      every worktree: branch, uncommitted, unpushed, PR, size
#   scripts/dev/worktrees.sh new <slot> <branch> [base]  add .claude/worktrees/<slot> (base defaults to origin/main)
#   scripts/dev/worktrees.sh deps <slot>                 (re)create node_modules (clone, else npm ci)
#   scripts/dev/worktrees.sh prune [--yes]               remove clean, pushed worktrees whose PR merged or closed
#
# Slots live in the main checkout's git-ignored .claude/worktrees/, at most MAX_SLOTS of them, reused by
# switching branches. node_modules is an APFS copy-on-write clone from any checkout with the same
# package-lock.json (≈0 extra disk); npm ci runs only when no checkout has that lockfile yet.
set -euo pipefail

COMMON_DIR="$(git rev-parse --path-format=absolute --git-common-dir)"
ROOT="${COMMON_DIR%/.git}"
SLOTS_DIR="$ROOT/.claude/worktrees"
MAX_SLOTS=2
REPO="kasheesh711/bgscheduler"

worktrees() {  # "<path>\t<branch>" per linked worktree (the main checkout excluded)
  git -C "$ROOT" worktree list --porcelain | awk -v root="$ROOT" '
    /^worktree /{ path = substr($0, 10); branch = "(detached)" }
    /^branch /{ branch = substr($0, 8); sub("refs/heads/", "", branch) }
    /^$/{ if (path != root) print path "\t" branch; path = "" }
    END { if (path != "" && path != root) print path "\t" branch }'
}

nuke() {  # rm -rf that survives Finder recreating .DS_Store mid-delete: rename out of the way, then retry
  local target="$1" doomed
  [ -e "$target" ] || return 0
  doomed="${target%/}.deleting-$$"
  mv "$target" "$doomed" 2>/dev/null || doomed="$target"
  for _ in 1 2 3 4 5; do
    rm -rf "$doomed" 2>/dev/null || true
    [ -e "$doomed" ] || return 0
    sleep 1
  done
  echo "could not fully delete $doomed" >&2
}

uncommitted() { git -C "$1" status --porcelain 2>/dev/null | grep -vc '\.DS_Store$' || true; }

unpushed() {  # commits on the branch that origin does not have
  local branch="$1"
  if git -C "$ROOT" show-ref -q "refs/remotes/origin/$branch"; then
    git -C "$ROOT" rev-list --count "origin/$branch..$branch"
  else
    git -C "$ROOT" rev-list --count "origin/main..$branch" 2>/dev/null || echo "?"
  fi
}

pr_state() { command -v gh >/dev/null && gh pr list --repo "$REPO" --head "$1" --state all --json number,state \
  --jq '.[0] | select(.) | "#\(.number) \(.state)"' 2>/dev/null || true; }

status() {
  git -C "$ROOT" fetch -q origin || true
  printf "%-62s %-42s %11s %8s %-12s %6s\n" WORKTREE BRANCH UNCOMMITTED UNPUSHED PR SIZE
  worktrees | while IFS=$'\t' read -r path branch; do
    printf "%-62s %-42s %11s %8s %-12s %6s\n" "${path/#$HOME/~}" "$branch" "$(uncommitted "$path")" \
      "$(unpushed "$branch")" "$(pr_state "$branch")" "$(du -sh "$path" 2>/dev/null | cut -f1)"
  done
}

deps() {  # clone node_modules from any checkout with the same package-lock.json; npm ci only if none has it
  local dir="$1" source="" candidate
  nuke "$dir/node_modules"
  while IFS= read -r candidate; do
    [ "$candidate" = "$dir" ] && continue
    if [ -d "$candidate/node_modules" ] && cmp -s "$candidate/package-lock.json" "$dir/package-lock.json"; then
      source="$candidate"; break
    fi
  done < <(git -C "$ROOT" worktree list --porcelain | awk '/^worktree /{ print substr($0, 10) }')
  if [ -n "$source" ]; then
    cp -cR "$source/node_modules" "$dir/node_modules"
    echo "node_modules: copy-on-write clone of ${source/#$HOME/~}"
  else
    echo "node_modules: no checkout has this package-lock.json yet, running npm ci"
    (cd "$dir" && npm ci --no-audit --no-fund)
  fi
}

new() {
  local slot="${1:?slot name}" branch="${2:?branch}" base="${3:-origin/main}"
  local dir="$SLOTS_DIR/$slot"
  [ -e "$dir" ] && { echo "$dir exists: switch branches inside it instead"; exit 1; }
  mkdir -p "$SLOTS_DIR"
  local count
  count=$(find "$SLOTS_DIR" -mindepth 1 -maxdepth 1 -type d | wc -l | tr -d ' ')
  if [ "$count" -ge "$MAX_SLOTS" ] && [ "${FORCE:-}" != 1 ]; then
    echo "$count slots already in $SLOTS_DIR (max $MAX_SLOTS): reuse one, or prune first"; exit 1
  fi
  git -C "$ROOT" fetch -q origin
  if git -C "$ROOT" show-ref -q "refs/heads/$branch"; then
    git -C "$ROOT" worktree add "$dir" "$branch"
  elif git -C "$ROOT" show-ref -q "refs/remotes/origin/$branch"; then
    git -C "$ROOT" worktree add --track -b "$branch" "$dir" "origin/$branch"
  else
    git -C "$ROOT" worktree add -b "$branch" "$dir" "$base"
  fi
  deps "$dir"
}

remove_worktree() {  # only called for clean, pushed (or merged) worktrees
  local path="$1"
  git -C "$ROOT" worktree remove "$path" 2>/dev/null || true
  nuke "$path"
  git -C "$ROOT" worktree prune
  if [ -e "$path" ]; then echo "could not fully remove: $path"; else echo "removed: $path"; fi
}

prune() {
  local apply="${1:-}"
  git -C "$ROOT" fetch -q --prune origin
  worktrees | while IFS=$'\t' read -r path branch; do
    if [ -d "$path/.feedback-autowriter" ] || [ -e "$path/.keep-worktree" ]; then echo "keep (local tools): $path"; continue; fi
    if [ "$(uncommitted "$path")" != 0 ]; then echo "keep (uncommitted changes): $path"; continue; fi
    if [ "$(unpushed "$branch")" != 0 ]; then echo "keep (unpushed commits): $path"; continue; fi
    local state in_main=no
    state=$(command -v gh >/dev/null && gh pr list --repo "$REPO" --head "$branch" --state all --json state --jq '.[0].state // ""' 2>/dev/null || true)
    git -C "$ROOT" merge-base --is-ancestor "$branch" origin/main 2>/dev/null && in_main=yes
    if [ "$state" = MERGED ] || [ "$state" = CLOSED ] || [ "$in_main" = yes ]; then
      if [ "$apply" = --yes ]; then remove_worktree "$path"; else echo "would remove (PR ${state:-none}, in main: $in_main): $path"; fi
    else
      echo "keep (PR ${state:-none} not merged): $path"
    fi
  done
  [ "$apply" = --yes ] || echo "dry run: rerun with --yes to remove"
}

case "${1:-status}" in
  status) status ;;
  new) shift; new "$@" ;;
  deps) deps "$SLOTS_DIR/${2:?slot name}" ;;
  prune) prune "${2:-}" ;;
  *) sed -n '2,12p' "$0"; exit 1 ;;
esac
