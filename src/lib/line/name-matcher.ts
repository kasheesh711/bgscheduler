/**
 * Pure-TypeScript deterministic name matcher for LINE student identity resolution.
 *
 * Converts AI-extracted `studentName`/`parentName` strings into scored
 * `NameMatchCandidate[]` against a student directory using a three-tier pipeline:
 *   1. Exact NFKC match (highest confidence)
 *   2. Token subset match (medium confidence)
 *   3. Levenshtein ≤ 2 fuzzy match (low confidence)
 *
 * Fail-closed invariant: this module performs NO DB writes and never auto-confirms a link.
 * It returns scored suggestions only; callers must route them through admin review.
 *
 * No DB imports — all functions are pure transformations.
 */

import type { LineStudentDirectoryRow } from "@/lib/line/student-links";

// ─── Types ────────────────────────────────────────────────────────────────────

export interface NameMatchCandidate {
  student: LineStudentDirectoryRow;
  score: number;
  matchBasis:
    | "student_name_exact"
    | "parent_name_exact"
    | "student_name_token"
    | "parent_name_token"
    | "student_name_fuzzy"
    | "parent_name_fuzzy";
}

// ─── Threshold constants ──────────────────────────────────────────────────────

/** Minimum score to treat as a confident single suggestion (token-level overlap or better). */
export const SUGGEST_SINGLE_MIN_SCORE = 70;

/** Minimum score to include in a shortlist for admin review. */
export const SUGGEST_SHORTLIST_MIN_SCORE = 50;

// ─── Helpers ──────────────────────────────────────────────────────────────────

/**
 * Normalizes a name string for matching. Keeps spaces as token delimiters.
 *
 * - NFKC Unicode normalization (handles fullwidth Latin, Thai tone-mark variants)
 * - Lowercase
 * - Trim and collapse internal whitespace to a single space
 * - Strip characters outside [a-z 0-9 ก-๙] (preserves Thai range and spaces)
 *
 * This is DISTINCT from `normalizeLineStudentCode` which collapses all spaces
 * (correct for dotted enrollment codes, wrong for name token splitting).
 */
export function normalizeForNameMatch(value: string): string {
  if (typeof value !== "string" || value.length === 0) return "";
  return value
    .normalize("NFKC")
    .toLowerCase()
    .replace(/[^a-z0-9ก-๙]/g, " ")
    .trim()
    .replace(/\s+/g, " ");
}

/**
 * Splits a normalized name into tokens on spaces.
 * Filters out empty tokens from leading/trailing/multiple spaces.
 */
function tokenize(normalized: string): string[] {
  return normalized.split(" ").filter((t) => t.length > 0);
}

/**
 * Computes the Levenshtein edit distance between two strings.
 * Verbatim copy of the private function at src/lib/line/data.ts:1090-1107,
 * re-exported as a named export for testability.
 */
export function levenshtein(a: string, b: string): number {
  const rows = a.length + 1;
  const cols = b.length + 1;
  const matrix = Array.from({ length: rows }, () => Array<number>(cols).fill(0));
  for (let i = 0; i < rows; i += 1) matrix[i][0] = i;
  for (let j = 0; j < cols; j += 1) matrix[0][j] = j;
  for (let i = 1; i < rows; i += 1) {
    for (let j = 1; j < cols; j += 1) {
      const cost = a[i - 1] === b[j - 1] ? 0 : 1;
      matrix[i][j] = Math.min(
        matrix[i - 1][j] + 1,
        matrix[i][j - 1] + 1,
        matrix[i - 1][j - 1] + cost,
      );
    }
  }
  return matrix[a.length][b.length];
}

// ─── Score table ──────────────────────────────────────────────────────────────
//
// | Match type                                        | Score |
// |---------------------------------------------------|-------|
// | Exact NFKC match on studentName                   |    90 |
// | Exact NFKC match on parentName only               |    75 |
// | Token subset match on studentName (≥1 token)      |    70 |
// | Token subset match on parentName                  |    55 |
// | Levenshtein ≤ 2 on any studentName token          |    50 |
// | Levenshtein ≤ 2 on any parentName token           |    35 |

// ─── Core matcher ─────────────────────────────────────────────────────────────

/**
 * Matches AI-extracted names against a student directory using a three-tier pipeline.
 *
 * Step 1 — Exact NFKC match: normalizeForNameMatch(input) === normalizeForNameMatch(student field).
 *   Scores: studentName → 90, parentName → 75.
 *
 * Step 2 — Token subset match: at least one token from the normalized input appears verbatim
 *   in the set of tokens from the normalized student field. Thai tokens (all characters ก-๙)
 *   are treated as single atomic units (no sub-word splitting). Romanized tokens use standard
 *   space splitting.
 *   Scores: studentName → 70, parentName → 55.
 *
 * Step 3 — Levenshtein fuzzy match: at least one token from the normalized input is within
 *   edit distance ≤ 2 of any token in the normalized student field.
 *   Scores: studentName → 50, parentName → 35.
 *
 * Step 4 — sibling dominance: a candidate that matched ONLY on parentName is dropped when it
 *   shares the parent name of a student that matched confidently on studentName (score
 *   >= SUGGEST_SINGLE_MIN_SCORE) — that candidate is the named student's sibling, not the named
 *   student. A parent-only match on a student with a DIFFERENT parent (a conflicting signal,
 *   not a sibling) is preserved for review, as is every studentName-based match. With
 *   parent-only input no studentName match exists, so genuine sibling shortlists are preserved.
 *
 * Returns [] when:
 * - Both studentName and parentName are null, undefined, or empty after normalization
 * - students array is empty
 * - No student scores >= SUGGEST_SHORTLIST_MIN_SCORE
 *
 * Deduplicates by studentKey (keeps highest score across all signal sources).
 * Results are sorted descending by score.
 *
 * FAIL-CLOSED INVARIANT: This function never writes to any DB. It returns
 * NameMatchCandidate[] (suggestions only) and never auto-confirms a student link.
 *
 * @param names - AI-extracted student and/or parent name from message content
 * @param students - Student directory rows (from listCurrentLineStudents)
 * @returns Sorted candidates with score >= SUGGEST_SHORTLIST_MIN_SCORE
 */
export function matchNamesToDirectory(
  names: { studentName?: string | null; parentName?: string | null },
  students: LineStudentDirectoryRow[],
): NameMatchCandidate[] {
  if (students.length === 0) return [];

  const inputStudentName = normalizeForNameMatch(names.studentName ?? "");
  const inputParentName = normalizeForNameMatch(names.parentName ?? "");

  if (inputStudentName.length === 0 && inputParentName.length === 0) return [];

  const inputStudentTokens = tokenize(inputStudentName);
  const inputParentTokens = tokenize(inputParentName);

  // Accumulate best score per studentKey across all tiers and signals.
  // candidateMap: studentKey → { student, score, matchBasis }
  const candidateMap = new Map<string, NameMatchCandidate>();

  // Track which students matched via a studentName signal (not parentName-only), plus the
  // parent names of the students that *confidently* matched on studentName. Together these
  // let the sibling-dominance rule (step 4) drop a parent-only candidate that is merely a
  // sibling of the named student (shares that student's parent name).
  const studentNameMatchedKeys = new Set<string>();
  const confidentStudentNameParents = new Set<string>();

  function consider(
    student: LineStudentDirectoryRow,
    score: number,
    matchBasis: NameMatchCandidate["matchBasis"],
    viaStudentName: boolean,
  ): void {
    if (score < SUGGEST_SHORTLIST_MIN_SCORE) return;
    if (viaStudentName) {
      studentNameMatchedKeys.add(student.studentKey);
      if (score >= SUGGEST_SINGLE_MIN_SCORE) {
        const parent = normalizeForNameMatch(student.parentName);
        if (parent.length > 0) confidentStudentNameParents.add(parent);
      }
    }
    const existing = candidateMap.get(student.studentKey);
    if (!existing || score > existing.score) {
      candidateMap.set(student.studentKey, { student, score, matchBasis });
    }
  }

  for (const student of students) {
    const normStudentName = normalizeForNameMatch(student.studentName);
    const normParentName = normalizeForNameMatch(student.parentName);
    const studentNameTokens = tokenize(normStudentName);
    const parentNameTokens = tokenize(normParentName);

    // ── Step 1: Exact NFKC match ──────────────────────────────────────────────

    if (inputStudentName.length > 0 && normStudentName.length > 0 && inputStudentName === normStudentName) {
      consider(student, 90, "student_name_exact", true);
    }

    if (inputParentName.length > 0 && normParentName.length > 0 && inputParentName === normParentName) {
      consider(student, 75, "parent_name_exact", false);
    }

    // ── Step 2: Token subset match ────────────────────────────────────────────
    // For single-token inputs: the token appears verbatim in the student field tokens.
    // For multi-token inputs: ALL input tokens appear in the student field tokens.
    // This intersection requirement prevents a shared first name from generating a
    // high-confidence match against unrelated students when the full name is provided.

    if (inputStudentTokens.length > 0 && studentNameTokens.length > 0) {
      const hasTokenMatch = inputStudentTokens.every((t) => studentNameTokens.includes(t));
      if (hasTokenMatch) {
        consider(student, 70, "student_name_token", true);
      }
    }

    if (inputParentTokens.length > 0 && parentNameTokens.length > 0) {
      const hasTokenMatch = inputParentTokens.every((t) => parentNameTokens.includes(t));
      if (hasTokenMatch) {
        consider(student, 55, "parent_name_token", false);
      }
    }

    // ── Step 3: Levenshtein fuzzy match ───────────────────────────────────────
    // ALL input tokens must have a fuzzy match (edit distance ≤ 2) to some student
    // field token. This mirrors the intersection requirement from Tier 2 — it prevents
    // a partial-overlap input (e.g. "Nicha Suwanprasert") from fuzzy-matching a student
    // that only shares the first-name token ("Nicha Kamolrat"), because "Suwanprasert"
    // has no fuzzy match in "Kamolrat".

    if (inputStudentTokens.length > 0 && studentNameTokens.length > 0) {
      const hasFuzzy = inputStudentTokens.every((it) =>
        studentNameTokens.some((st) => levenshtein(it, st) <= 2),
      );
      if (hasFuzzy) {
        consider(student, 50, "student_name_fuzzy", true);
      }
    }

    if (inputParentTokens.length > 0 && parentNameTokens.length > 0) {
      const hasFuzzy = inputParentTokens.every((it) =>
        parentNameTokens.some((st) => levenshtein(it, st) <= 2),
      );
      if (hasFuzzy) {
        consider(student, 35, "parent_name_fuzzy", false);
      }
    }
  }

  // ── Step 4: sibling dominance ───────────────────────────────────────────────
  // Drop a candidate that matched ONLY on parentName when it is a sibling of a student
  // the input already named confidently — i.e. it shares the parent name of a student
  // that matched via studentName at score >= SUGGEST_SINGLE_MIN_SCORE. Such a candidate
  // is the named student's sibling, not the named student. Candidates whose own name
  // matched are always kept, and a parent-only match on a student with a DIFFERENT parent
  // (a genuinely conflicting signal, not a sibling) is preserved for admin review. With
  // parent-only input no studentName match exists, so sibling shortlists are preserved.
  const results = Array.from(candidateMap.values()).filter((c) => {
    if (studentNameMatchedKeys.has(c.student.studentKey)) return true;
    const parent = normalizeForNameMatch(c.student.parentName);
    return !(parent.length > 0 && confidentStudentNameParents.has(parent));
  });

  // Sort descending by score.
  return results.sort((a, b) => b.score - a.score);
}
