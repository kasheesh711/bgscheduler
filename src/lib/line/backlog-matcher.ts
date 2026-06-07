/**
 * Pure-TypeScript distinctive-token matcher for LINE backlog identity recovery (IDENT-07).
 *
 * Matches LINE follower display names against human-verified OA-resolver targets (~662 rows)
 * using distinctive tokens (≥4-char lastnames, parent names, nickname-codes via (…) regex).
 * Exactly-one-student match → high-confidence; multiple → ambiguous shortlist (never collapsed).
 *
 * Fail-closed invariant: this module performs NO DB writes and never auto-confirms a link.
 * It returns match results only; callers must route them through admin review.
 *
 * No DB imports — all functions are pure transformations.
 */

import { normalizeForNameMatch } from "@/lib/line/name-matcher";
import { normalizeLineStudentCode } from "@/lib/line/student-links";
import type { LineProfile } from "@/lib/line/client";

// ─── Types ────────────────────────────────────────────────────────────────────

/**
 * A human-verified OA-resolver row — input shape for `buildTargetTokenIndex`.
 * Matches the columns returned by `listVerifiedResolverTargets` (Plan 03).
 */
export interface VerifiedResolverTarget {
  studentName: string;
  parentName: string;
  searchCode: string | null;
  lineChatUrl: string | null;
  wiseStudentId: string;
  studentKey: string;
}

/**
 * A single matching result per follower-to-student association.
 * `confidence: "high"` means exactly one student key matched across all tokens.
 * `confidence: "ambiguous"` means multiple student keys matched — one result per key,
 * never collapsed. Callers must not auto-select from an ambiguous shortlist.
 */
export interface BacklogMatchResult {
  lineUserId: string;
  displayName: string;
  matchedStudentKey: string;
  studentName: string;
  lineChatUrl: string | null;
  confidence: "high" | "ambiguous";
  /** The distinctive tokens that triggered the match. */
  tokens: string[];
}

// ─── Constants ────────────────────────────────────────────────────────────────

/** Minimum normalized token length to be considered distinctive. */
const MIN_DISTINCTIVE_TOKEN_LENGTH = 4;

// ─── Helpers ──────────────────────────────────────────────────────────────────

/**
 * Extracts nickname-codes from parenthesized text in a name string.
 * E.g. "Ploychompu (Kaimook.Ka) Kaewkhampholkul" → ["kaimook.ka"].
 * Uses `normalizeLineStudentCode` to normalize extracted codes.
 *
 * Inlined from `nicknameCodes` in student-links.ts (unexported in Wave-1;
 * exported in Wave-2 Plan 03 and imported directly from there).
 */
function extractNicknameCodes(value: string): string[] {
  const matches = [...value.matchAll(/\(([^)]+)\)/g)];
  return matches.map((m) => normalizeLineStudentCode(m[1] ?? "")).filter(Boolean);
}

// ─── Core functions ───────────────────────────────────────────────────────────

/**
 * Extracts distinctive tokens (≥4 chars) from a name string.
 *
 * Steps:
 *   1. Normalize via `normalizeForNameMatch` (preserves spaces for splitting).
 *   2. Split on spaces → normalize each token via `normalizeLineStudentCode`.
 *   3. Keep tokens with length >= MIN_DISTINCTIVE_TOKEN_LENGTH.
 *   4. Also extract nickname-codes from `(…)` regions (already normalized).
 *   5. Deduplicate and return.
 *
 * Examples:
 *   - "OIL PinyavorakuL" → ["pinyavorakul"]
 *   - "Ploychompu (Kaimook.Ka) Kaewkhampholkul" → ["kaewkhampholkul", "kaimook.ka"]
 *   - "Oil" → [] (3 chars, below threshold)
 *   - "" → []
 *
 * @param name - Raw name string (follower display name or target field)
 * @returns Deduplicated array of ≥4-char normalized tokens
 */
export function distinctiveTokens(name: string): string[] {
  const normalized = normalizeForNameMatch(name);
  if (normalized.length === 0) return [];

  const spaceTokens = normalized
    .split(" ")
    .map((t) => normalizeLineStudentCode(t))
    .filter((t) => t.length >= MIN_DISTINCTIVE_TOKEN_LENGTH);

  const codeTokens = extractNicknameCodes(name).filter(
    (t) => t.length >= MIN_DISTINCTIVE_TOKEN_LENGTH,
  );

  // Deduplicate while preserving order (space tokens first, then code tokens)
  const seen = new Set<string>();
  const result: string[] = [];
  for (const t of [...spaceTokens, ...codeTokens]) {
    if (!seen.has(t)) {
      seen.add(t);
      result.push(t);
    }
  }
  return result;
}

/**
 * Builds a token index from a set of verified resolver targets.
 *
 * For each target:
 *   - Tokenize `studentName` via `distinctiveTokens` → index[token].add(studentKey)
 *   - Tokenize `parentName` via `distinctiveTokens` → index[token].add(studentKey)
 *   - Extract nickname-codes from `searchCode` → filter ≥4 chars → index[code].add(studentKey)
 *
 * @param targets - Verified resolver rows (human-confirmed admin ground truth)
 * @returns Map from normalized token to the set of student keys that carry it
 */
export function buildTargetTokenIndex(
  targets: VerifiedResolverTarget[],
): Map<string, Set<string>> {
  const index = new Map<string, Set<string>>();

  function addToIndex(token: string, studentKey: string): void {
    let entry = index.get(token);
    if (!entry) {
      entry = new Set<string>();
      index.set(token, entry);
    }
    entry.add(studentKey);
  }

  for (const target of targets) {
    for (const token of distinctiveTokens(target.studentName)) {
      addToIndex(token, target.studentKey);
    }
    for (const token of distinctiveTokens(target.parentName)) {
      addToIndex(token, target.studentKey);
    }
    // Extract nickname-codes from searchCode (already handles null via ?? "")
    for (const code of extractNicknameCodes(target.searchCode ?? "")) {
      if (code.length >= MIN_DISTINCTIVE_TOKEN_LENGTH) {
        addToIndex(code, target.studentKey);
      }
    }
  }

  return index;
}

/**
 * Matches LINE follower display names against the token index.
 *
 * For each follower with a non-empty `displayName`:
 *   1. Extract distinctive tokens from the display name.
 *   2. Union all student keys from index hits across all tokens.
 *   3. Exactly 1 matched key → one `BacklogMatchResult` with `confidence: "high"`.
 *   4. 2+ matched keys → one `BacklogMatchResult` per key with `confidence: "ambiguous"`.
 *      Never auto-collapsed. Callers must not assume a single result means a single student.
 *   5. 0 matched keys → no result for this follower.
 *
 * FAIL-CLOSED INVARIANT: This function never writes to any DB and never sets
 * `status: "verified"`. Callers must insert results as `status: "suggested"` only (IDENT-02).
 *
 * @param followers - LINE follower profiles (LINE-API-provided, untrusted display names)
 * @param index - Token index from `buildTargetTokenIndex`
 * @param targetsByStudentKey - Map from studentKey to full target row (for studentName + lineChatUrl)
 * @returns All match results (high-confidence and ambiguous combined)
 */
export function matchFollowersToTargets(
  followers: LineProfile[],
  index: Map<string, Set<string>>,
  targetsByStudentKey: Map<string, VerifiedResolverTarget>,
): BacklogMatchResult[] {
  const results: BacklogMatchResult[] = [];

  for (const follower of followers) {
    const displayName = follower.displayName ?? "";
    if (displayName.trim().length === 0) continue;

    const tokens = distinctiveTokens(displayName);
    if (tokens.length === 0) continue;

    // Collect union of all student keys matched by any token
    const matchedKeys = new Set<string>();
    for (const token of tokens) {
      const keys = index.get(token);
      if (keys) {
        for (const key of keys) {
          matchedKeys.add(key);
        }
      }
    }

    if (matchedKeys.size === 0) continue;

    const confidence: "high" | "ambiguous" = matchedKeys.size === 1 ? "high" : "ambiguous";

    for (const studentKey of matchedKeys) {
      const target = targetsByStudentKey.get(studentKey);
      if (!target) continue;

      results.push({
        lineUserId: follower.userId,
        displayName,
        matchedStudentKey: studentKey,
        studentName: target.studentName,
        lineChatUrl: target.lineChatUrl,
        confidence,
        tokens,
      });
    }
  }

  return results;
}
