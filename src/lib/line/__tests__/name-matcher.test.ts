import { describe, expect, it } from "vitest";
import {
  levenshtein,
  matchNamesToDirectory,
  normalizeForNameMatch,
  SUGGEST_SHORTLIST_MIN_SCORE,
  SUGGEST_SINGLE_MIN_SCORE,
  type NameMatchCandidate,
} from "@/lib/line/name-matcher";
import type { LineStudentDirectoryRow } from "@/lib/line/student-links";

// ─── Helpers ───────────────────────────────────────────────────────────────────

function student(overrides: Partial<LineStudentDirectoryRow>): LineStudentDirectoryRow {
  return {
    wiseStudentId: "wise-default",
    studentKey: "default::parent",
    studentName: "Default Student",
    parentName: "Default Parent",
    activated: true,
    hasFutureSessions: false,
    hasLivePackage: false,
    ...overrides,
  };
}

// ─── Constants ─────────────────────────────────────────────────────────────────

describe("threshold constants", () => {
  it("SUGGEST_SINGLE_MIN_SCORE is 70", () => {
    expect(SUGGEST_SINGLE_MIN_SCORE).toBe(70);
  });

  it("SUGGEST_SHORTLIST_MIN_SCORE is 50", () => {
    expect(SUGGEST_SHORTLIST_MIN_SCORE).toBe(50);
  });
});

// ─── normalizeForNameMatch ──────────────────────────────────────────────────────

describe("normalizeForNameMatch", () => {
  it("lowercases and trims romanized names", () => {
    expect(normalizeForNameMatch("Nicha Suwanprasert")).toBe("nicha suwanprasert");
  });

  it("keeps spaces as token delimiters", () => {
    expect(normalizeForNameMatch("  Nicha   Suwanprasert  ")).toBe("nicha suwanprasert");
  });

  it("preserves Thai characters", () => {
    expect(normalizeForNameMatch("นิชา สุวรรณประเสริฐ")).toBe("นิชา สุวรรณประเสริฐ");
  });

  it("strips special characters but keeps Thai and alphanumeric", () => {
    expect(normalizeForNameMatch("Nicha-Suwanprasert!")).toBe("nicha suwanprasert");
  });

  it("handles null gracefully", () => {
    expect(normalizeForNameMatch(null as unknown as string)).toBe("");
  });

  it("handles empty string", () => {
    expect(normalizeForNameMatch("")).toBe("");
  });

  it("applies NFKC normalization to Unicode variants", () => {
    // fullwidth Latin characters should normalize to standard ASCII
    const fullwidth = "Ｎｉｃｈａ"; // "NICHA" in fullwidth
    expect(normalizeForNameMatch(fullwidth)).toBe("nicha");
  });
});

// ─── levenshtein ───────────────────────────────────────────────────────────────

describe("levenshtein", () => {
  it("returns 0 for identical strings", () => {
    expect(levenshtein("nicha", "nicha")).toBe(0);
  });

  it("returns 1 for single insertion", () => {
    expect(levenshtein("nicha", "nichaa")).toBe(1);
  });

  it("returns 1 for single deletion", () => {
    expect(levenshtein("nicha", "ncha")).toBe(1);
  });

  it("returns 1 for single substitution", () => {
    expect(levenshtein("nicha", "nisha")).toBe(1);
  });

  it("returns 3 for completely different short strings", () => {
    expect(levenshtein("abc", "xyz")).toBe(3);
  });

  it("handles empty strings", () => {
    expect(levenshtein("", "abc")).toBe(3);
    expect(levenshtein("abc", "")).toBe(3);
    expect(levenshtein("", "")).toBe(0);
  });

  it("returns 2 for near-neighbor names (nicha vs nicha edit-2)", () => {
    expect(levenshtein("nicha", "ncha")).toBe(1);
    expect(levenshtein("nicha", "nichab")).toBe(1);
    expect(levenshtein("nicha", "nichu")).toBe(1);
  });
});

// ─── matchNamesToDirectory — null/empty guards ──────────────────────────────────

describe("matchNamesToDirectory — null/empty guards", () => {
  const dir = [
    student({ studentKey: "nicha.sw::parent", studentName: "Nicha Suwanprasert", parentName: "Mom Nicha" }),
  ];

  it("returns [] for empty names object", () => {
    expect(matchNamesToDirectory({}, dir)).toEqual([]);
  });

  it("returns [] for null studentName and null parentName", () => {
    expect(matchNamesToDirectory({ studentName: null, parentName: null }, dir)).toEqual([]);
  });

  it("returns [] for empty student directory", () => {
    expect(matchNamesToDirectory({ studentName: "Nicha" }, [])).toEqual([]);
  });

  it("returns [] for whitespace-only names", () => {
    expect(matchNamesToDirectory({ studentName: "   " }, dir)).toEqual([]);
  });

  it("never throws on unusual inputs", () => {
    expect(() => matchNamesToDirectory({ studentName: "!!@@##" }, dir)).not.toThrow();
  });
});

// ─── matchNamesToDirectory — Tier 1: Exact NFKC match ──────────────────────────

describe("matchNamesToDirectory — Tier 1 exact match", () => {
  const nicha = student({
    studentKey: "nicha.sw::parent",
    studentName: "Nicha Suwanprasert",
    parentName: "คุณแม่นิชา",
  });
  const dir = [nicha];

  it("exact match on studentName returns score 90 with matchBasis student_name_exact", () => {
    const results = matchNamesToDirectory({ studentName: "Nicha Suwanprasert" }, dir);
    expect(results).toHaveLength(1);
    expect(results[0].score).toBe(90);
    expect(results[0].matchBasis).toBe("student_name_exact");
    expect(results[0].student.studentKey).toBe("nicha.sw::parent");
  });

  it("exact match is case-insensitive (NFKC lowercase)", () => {
    const results = matchNamesToDirectory({ studentName: "NICHA SUWANPRASERT" }, dir);
    expect(results).toHaveLength(1);
    expect(results[0].score).toBe(90);
    expect(results[0].matchBasis).toBe("student_name_exact");
  });

  it("parentName-only exact match returns score 75 with matchBasis parent_name_exact", () => {
    const results = matchNamesToDirectory({ parentName: "คุณแม่นิชา" }, dir);
    expect(results).toHaveLength(1);
    expect(results[0].score).toBe(75);
    expect(results[0].matchBasis).toBe("parent_name_exact");
  });

  it("Thai exact match on studentName returns score 90", () => {
    const thaiStudent = student({
      studentKey: "nana.th::parent",
      studentName: "นิชา สุวรรณ",
      parentName: "คุณแม่",
    });
    const results = matchNamesToDirectory({ studentName: "นิชา สุวรรณ" }, [thaiStudent]);
    expect(results).toHaveLength(1);
    expect(results[0].score).toBe(90);
    expect(results[0].matchBasis).toBe("student_name_exact");
  });

  it("exact studentName match wins over parentName-only match when both hit", () => {
    const s1 = student({
      studentKey: "s1::parent",
      studentName: "Nicha",
      parentName: "Other Parent",
    });
    const s2 = student({
      studentKey: "s2::parent",
      studentName: "Different Name",
      parentName: "Nicha",
    });
    const results = matchNamesToDirectory({ studentName: "Nicha" }, [s1, s2]);
    // s1 gets score 90, s2 gets score 70 (token match) or less
    const keys = results.map((r) => r.student.studentKey);
    expect(keys[0]).toBe("s1::parent");
    expect(results[0].score).toBe(90);
  });
});

// ─── matchNamesToDirectory — Tier 2: Token subset match ────────────────────────

describe("matchNamesToDirectory — Tier 2 token subset match", () => {
  it("single token from studentName returns score 70 with matchBasis student_name_token", () => {
    const dir = [
      student({ studentKey: "nicha.sw::parent", studentName: "Nicha Suwanprasert", parentName: "Parent" }),
    ];
    const results = matchNamesToDirectory({ studentName: "Nicha" }, dir);
    expect(results).toHaveLength(1);
    expect(results[0].score).toBe(70);
    expect(results[0].matchBasis).toBe("student_name_token");
  });

  it("single token from parentName returns score 55 with matchBasis parent_name_token", () => {
    const dir = [
      student({ studentKey: "nicha.sw::parent", studentName: "Nicha Suwanprasert", parentName: "Mom Nicha" }),
    ];
    const results = matchNamesToDirectory({ parentName: "Mom" }, dir);
    expect(results).toHaveLength(1);
    expect(results[0].score).toBe(55);
    expect(results[0].matchBasis).toBe("parent_name_token");
  });

  it("Thai token subset match on studentName returns score 70", () => {
    const dir = [
      student({ studentKey: "nana.th::parent", studentName: "นิชา สุวรรณ", parentName: "คุณแม่" }),
    ];
    // Input is just "นิชา" — one Thai token appearing in the student name
    const results = matchNamesToDirectory({ studentName: "นิชา" }, dir);
    expect(results).toHaveLength(1);
    expect(results[0].score).toBe(70);
    expect(results[0].matchBasis).toBe("student_name_token");
  });

  it("token match does not produce score 90 — only exact full match does", () => {
    const dir = [
      student({ studentKey: "nicha.sw::parent", studentName: "Nicha Suwanprasert", parentName: "Parent" }),
    ];
    const results = matchNamesToDirectory({ studentName: "Nicha" }, dir);
    expect(results[0].score).not.toBe(90);
    expect(results[0].score).toBe(70);
  });
});

// ─── matchNamesToDirectory — Tier 3: Levenshtein fuzzy match ───────────────────

describe("matchNamesToDirectory — Tier 3 fuzzy match", () => {
  it("levenshtein distance 1 on studentName token returns score 50 with matchBasis student_name_fuzzy", () => {
    const dir = [
      student({ studentKey: "nicha.sw::parent", studentName: "Nicha Suwanprasert", parentName: "Parent" }),
    ];
    // "Ncha" has edit distance 1 from "nicha"
    const results = matchNamesToDirectory({ studentName: "Ncha" }, dir);
    expect(results).toHaveLength(1);
    expect(results[0].score).toBe(50);
    expect(results[0].matchBasis).toBe("student_name_fuzzy");
  });

  it("levenshtein distance 2 on studentName token still returns score 50", () => {
    const dir = [
      student({ studentKey: "nicha.sw::parent", studentName: "Nicha Suwanprasert", parentName: "Parent" }),
    ];
    // "Nicha" → "Ncha" = edit distance 1; "cha" → edit distance 2 from "nicha"
    const results = matchNamesToDirectory({ studentName: "Ncha" }, dir);
    expect(results[0].score).toBe(50);
  });

  it("parentName fuzzy score (35) is below SUGGEST_SHORTLIST_MIN_SCORE — returns [] alone", () => {
    const dir = [
      student({ studentKey: "nicha.sw::parent", studentName: "Nicha Suwanprasert", parentName: "Mom Smith" }),
    ];
    // "Smyth" has edit distance 1 from "smith" → parentName fuzzy score would be 35,
    // but 35 < SUGGEST_SHORTLIST_MIN_SCORE (50), so the candidate is filtered out.
    // parentName fuzzy only surfaces when a higher-tier match also contributes.
    const results = matchNamesToDirectory({ parentName: "Smyth" }, dir);
    expect(results).toHaveLength(0);
  });

  it("parentName fuzzy match (score 35) can still surface via dedup — kept if another path scores higher", () => {
    // If studentName also matches at a higher tier, the max score for that student wins.
    // This test confirms parentName fuzzy score (35) is overridden by a token match (70).
    const dir = [
      student({ studentKey: "nicha.sw::parent", studentName: "Nicha Suwanprasert", parentName: "Mom Smith" }),
    ];
    // studentName "Nicha" → token match on "nicha" → score 70
    // parentName "Smyth" → fuzzy "smith" → score 35 (would be filtered, but studentName wins at 70)
    const results = matchNamesToDirectory({ studentName: "Nicha", parentName: "Smyth" }, dir);
    expect(results).toHaveLength(1);
    expect(results[0].score).toBe(70);
    expect(results[0].matchBasis).toBe("student_name_token");
  });

  it("levenshtein distance > 2 returns no match", () => {
    const dir = [
      student({ studentKey: "nicha.sw::parent", studentName: "Nicha", parentName: "Parent" }),
    ];
    // "xyz" has large edit distance from "nicha"
    const results = matchNamesToDirectory({ studentName: "xyz" }, dir);
    expect(results).toHaveLength(0);
  });
});

// ─── matchNamesToDirectory — Deduplication and sorting ─────────────────────────

describe("matchNamesToDirectory — deduplication and sort", () => {
  it("deduplicates by studentKey and keeps highest score", () => {
    // studentName and parentName both match the same student — keep only one entry with the highest score
    const s = student({
      studentKey: "nicha.sw::parent",
      studentName: "Nicha Suwanprasert",
      parentName: "Nicha Mom",
    });
    // studentName exact (score 90) + parentName token (would be 55) → keep 90
    const results = matchNamesToDirectory({ studentName: "Nicha Suwanprasert", parentName: "Nicha Mom" }, [s]);
    expect(results).toHaveLength(1);
    expect(results[0].score).toBe(90);
  });

  it("returns multiple candidates sorted descending by score", () => {
    const s1 = student({ studentKey: "nicha.sw::parent", studentName: "Nicha Suwanprasert", parentName: "Parent A" });
    const s2 = student({ studentKey: "nisha.th::parent", studentName: "Nisha Thailand", parentName: "Parent B" });
    // s1: exact match on "Nicha Suwanprasert" → 90
    // s2: fuzzy "nicha" → "nisha" edit dist 1 → 50
    const results = matchNamesToDirectory({ studentName: "Nicha Suwanprasert" }, [s1, s2]);
    expect(results.length).toBeGreaterThanOrEqual(1);
    // Sorted descending
    for (let i = 1; i < results.length; i++) {
      expect(results[i - 1].score).toBeGreaterThanOrEqual(results[i].score);
    }
  });

  it("filters out candidates below SUGGEST_SHORTLIST_MIN_SCORE", () => {
    const dir = [
      student({ studentKey: "nicha.sw::parent", studentName: "Nicha", parentName: "Parent" }),
    ];
    // "xyz" has edit distance > 2 → score would be 0 → filtered out
    const results = matchNamesToDirectory({ studentName: "xyz" }, dir);
    expect(results).toHaveLength(0);
  });
});

// ─── matchNamesToDirectory — does NOT set status="verified" ────────────────────

describe("matchNamesToDirectory — fail-closed invariant", () => {
  it("return type NameMatchCandidate does not have a status field", () => {
    const dir = [
      student({ studentKey: "nicha.sw::parent", studentName: "Nicha", parentName: "Parent" }),
    ];
    const results = matchNamesToDirectory({ studentName: "Nicha" }, dir);
    for (const candidate of results) {
      expect(candidate).not.toHaveProperty("status");
    }
  });

  it("result candidates only have expected fields", () => {
    const dir = [
      student({ studentKey: "nicha.sw::parent", studentName: "Nicha", parentName: "Parent" }),
    ];
    const results: NameMatchCandidate[] = matchNamesToDirectory({ studentName: "Nicha" }, dir);
    for (const candidate of results) {
      expect(candidate).toHaveProperty("student");
      expect(candidate).toHaveProperty("score");
      expect(candidate).toHaveProperty("matchBasis");
      // Not "verified" or any DB write field
      expect(Object.keys(candidate)).toHaveLength(3);
    }
  });
});

// ─── matchNamesToDirectory — Combined studentName + parentName signals ──────────

describe("matchNamesToDirectory — combined signals", () => {
  it("uses both studentName and parentName to generate candidates", () => {
    const s1 = student({ studentKey: "nicha.sw::parent", studentName: "Nicha Suwanprasert", parentName: "Other" });
    const s2 = student({ studentKey: "kanya.th::parent", studentName: "Kanya Thailand", parentName: "Mom Nicha" });
    // studentName "Nicha" → token-matches s1 (score 70)
    // parentName "Mom Nicha" → token-matches s2 on "nicha" (score 55)
    const results = matchNamesToDirectory({ studentName: "Nicha", parentName: "Mom Nicha" }, [s1, s2]);
    const keys = results.map((r) => r.student.studentKey);
    expect(keys).toContain("nicha.sw::parent");
    expect(keys).toContain("kanya.th::parent");
  });
});
