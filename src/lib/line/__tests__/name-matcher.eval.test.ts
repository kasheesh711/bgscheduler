/**
 * Eval fixture test for the name-based student matcher.
 *
 * Provenance: Synthetic-but-realistic patterns drawn from real Thai/English scheduling
 * message categories (scheduling_request, scheduling_change). Names represent common
 * Thai first name structures, nickname patterns, and romanized variants encountered
 * in real LINE OA messages. No row in this fixture is linked to a real production DB row.
 *
 * Production-labeled calibration (against live extracted_state data) is a noted follow-up
 * before the matcher is relied upon at scale. Admin-verify still gates every link, so this
 * gate is about ensuring the matcher does not flood the worklist with garbage suggestions.
 */

import { describe, expect, it } from "vitest";
import { matchNamesToDirectory, SUGGEST_SHORTLIST_MIN_SCORE } from "@/lib/line/name-matcher";
import type { LineStudentDirectoryRow } from "@/lib/line/student-links";

// ─── Mock student directory ────────────────────────────────────────────────────
//
// This directory is constructed BY HAND to include the required distractor categories.
// It is NOT generated from the fixture list.
//
// Expected-match students (6 unique studentKeys referenced by fixtures):
//   nicha.sw::parent  (Nicha Suwanprasert / คุณแม่นิชา)
//   nana.sr::parent   (Nuuna Sripan / หนูนา / คุณแม่สุดา)
//   som.ch::parent    (น้องส้ม Chatchai / คุณแม่ส้ม)
//   kanya.th::parent  (Kanya Thailand / แม่กัญญา)
//   james.bk::parent  (James Bangkok / Parent James)
//   pim.wn::parent    (Pimchanok Wannakorn / คุณพ่อปิม)
//
// Distractor students (>= 3× = >= 18 for 6 expected — we have 20 distractors):
//   Siblings with same parent as an expected match (2)
//   Students sharing a common first name with an expected match (4)
//   Near-Levenshtein neighbors of expected matches (4)
//   Unrelated padding students (10)

const MOCK_DIRECTORY: LineStudentDirectoryRow[] = [
  // ── Expected-match students ──
  {
    wiseStudentId: "wise-nicha",
    studentKey: "nicha.sw::parent",
    studentName: "Nicha Suwanprasert",
    parentName: "คุณแม่นิชา",
    activated: true,
    hasFutureSessions: true,
    hasLivePackage: true,
  },
  {
    wiseStudentId: "wise-nana",
    studentKey: "nana.sr::parent",
    studentName: "Nuuna Sripan",
    parentName: "คุณแม่สุดา",
    activated: true,
    hasFutureSessions: true,
    hasLivePackage: true,
  },
  {
    wiseStudentId: "wise-som",
    studentKey: "som.ch::parent",
    studentName: "น้องส้ม Chatchai",
    parentName: "คุณแม่ส้ม",
    activated: true,
    hasFutureSessions: true,
    hasLivePackage: true,
  },
  {
    wiseStudentId: "wise-kanya",
    studentKey: "kanya.th::parent",
    studentName: "Kanya Thailand",
    parentName: "แม่กัญญา",
    activated: true,
    hasFutureSessions: true,
    hasLivePackage: true,
  },
  {
    wiseStudentId: "wise-james",
    studentKey: "james.bk::parent",
    studentName: "James Bangkok",
    parentName: "Parent James",
    activated: true,
    hasFutureSessions: true,
    hasLivePackage: true,
  },
  {
    wiseStudentId: "wise-pim",
    studentKey: "pim.wn::parent",
    studentName: "Pimchanok Wannakorn",
    parentName: "คุณพ่อปิม",
    activated: true,
    hasFutureSessions: true,
    hasLivePackage: true,
  },

  // ── Distractors: Siblings with same parent (SAME parentName as expected match) ──
  // Sibling of น้องส้ม — same parent "คุณแม่ส้ม"
  {
    wiseStudentId: "wise-pee-som",
    studentKey: "peesom.ch::parent",
    studentName: "พี่ส้ม Chatchai",
    parentName: "คุณแม่ส้ม",
    activated: true,
    hasFutureSessions: false,
    hasLivePackage: true,
  },
  // Another sibling of Nicha — same parent "คุณแม่นิชา"
  {
    wiseStudentId: "wise-nicha-sib",
    studentKey: "nicharat.sw::parent",
    studentName: "Nicharat Suwanprasert",
    parentName: "คุณแม่นิชา",
    activated: true,
    hasFutureSessions: false,
    hasLivePackage: false,
  },

  // ── Distractors: Students sharing a common first name (ambiguous first name) ──
  // Different Nicha (not the expected one)
  {
    wiseStudentId: "wise-nicha2",
    studentKey: "nicha.kh::parent",
    studentName: "Nicha Khunprasit",
    parentName: "Mom Nicha K",
    activated: true,
    hasFutureSessions: true,
    hasLivePackage: false,
  },
  // Different Kanya (not the expected one)
  {
    wiseStudentId: "wise-kanya2",
    studentKey: "kanya.pm::parent",
    studentName: "Kanya Prateep",
    parentName: "แม่พรรณ",
    activated: true,
    hasFutureSessions: false,
    hasLivePackage: false,
  },
  // Different James (not the expected one)
  {
    wiseStudentId: "wise-james2",
    studentKey: "james.cm::parent",
    studentName: "James Chiangmai",
    parentName: "Dad James C",
    activated: true,
    hasFutureSessions: false,
    hasLivePackage: true,
  },
  // Different Pim (not the expected one)
  {
    wiseStudentId: "wise-pim2",
    studentKey: "pim.nt::parent",
    studentName: "Pim Nonthaburi",
    parentName: "คุณพ่อสุรชัย",
    activated: false,
    hasFutureSessions: false,
    hasLivePackage: false,
  },

  // ── Distractors: Near-Levenshtein neighbors (edit distance ≤ 2 from expected match) ──
  // "Nisha" — edit dist 1 from "Nicha"
  {
    wiseStudentId: "wise-nisha",
    studentKey: "nisha.gr::parent",
    studentName: "Nisha Green",
    parentName: "Parent Nisha",
    activated: true,
    hasFutureSessions: false,
    hasLivePackage: false,
  },
  // "Kanaya" — edit dist 1 from "Kanya"
  {
    wiseStudentId: "wise-kanaya",
    studentKey: "kanaya.th::parent",
    studentName: "Kanaya Thomas",
    parentName: "Parent Kanaya",
    activated: false,
    hasFutureSessions: false,
    hasLivePackage: false,
  },
  // "Jamos" — edit dist 1 from "James"
  {
    wiseStudentId: "wise-jamos",
    studentKey: "jamos.bk::parent",
    studentName: "Jamos Bangkok",
    parentName: "Parent Jamos",
    activated: false,
    hasFutureSessions: false,
    hasLivePackage: false,
  },
  // "Pimchanon" — edit dist 1 from "Pimchanok"
  {
    wiseStudentId: "wise-pimchanon",
    studentKey: "pimchanon.wn::parent",
    studentName: "Pimchanon Wannakorn",
    parentName: "คุณพ่อพิม",
    activated: false,
    hasFutureSessions: false,
    hasLivePackage: false,
  },

  // ── Distractors: Unrelated padding (10 students) ──
  {
    wiseStudentId: "wise-p1",
    studentKey: "emma.bt::parent",
    studentName: "Emma Burton",
    parentName: "Sarah Burton",
    activated: true,
    hasFutureSessions: false,
    hasLivePackage: false,
  },
  {
    wiseStudentId: "wise-p2",
    studentKey: "leo.tz::parent",
    studentName: "Leo Tenzin",
    parentName: "Dorji Tenzin",
    activated: true,
    hasFutureSessions: false,
    hasLivePackage: false,
  },
  {
    wiseStudentId: "wise-p3",
    studentKey: "aom.pk::parent",
    studentName: "อ้อม Pakpoom",
    parentName: "คุณแม่อ้อม",
    activated: false,
    hasFutureSessions: false,
    hasLivePackage: false,
  },
  {
    wiseStudentId: "wise-p4",
    studentKey: "fern.sr::parent",
    studentName: "Fern Srisuk",
    parentName: "แม่เฟิร์น",
    activated: false,
    hasFutureSessions: false,
    hasLivePackage: false,
  },
  {
    wiseStudentId: "wise-p5",
    studentKey: "tom.bk::parent",
    studentName: "Tom Bangkok",
    parentName: "Dad Tom",
    activated: true,
    hasFutureSessions: true,
    hasLivePackage: false,
  },
  {
    wiseStudentId: "wise-p6",
    studentKey: "kate.wl::parent",
    studentName: "Kate Wilson",
    parentName: "Mom Kate",
    activated: true,
    hasFutureSessions: false,
    hasLivePackage: false,
  },
  {
    wiseStudentId: "wise-p7",
    studentKey: "arm.th::parent",
    studentName: "อาร์ม Thammarat",
    parentName: "คุณพ่ออาร์ม",
    activated: false,
    hasFutureSessions: false,
    hasLivePackage: false,
  },
  {
    wiseStudentId: "wise-p8",
    studentKey: "sky.lm::parent",
    studentName: "Skyla Lambert",
    parentName: "Parent Skyla",
    activated: false,
    hasFutureSessions: false,
    hasLivePackage: false,
  },
  {
    wiseStudentId: "wise-p9",
    studentKey: "may.ch::parent",
    studentName: "มุ้ย Charoenkul",
    parentName: "แม่มุ้ย",
    activated: true,
    hasFutureSessions: false,
    hasLivePackage: false,
  },
  {
    wiseStudentId: "wise-p10",
    studentKey: "tan.sr::parent",
    studentName: "Tan Srisuphan",
    parentName: "คุณพ่อตั้น",
    activated: false,
    hasFutureSessions: false,
    hasLivePackage: false,
  },
];

// Verify directory requirements:
// Expected-match students: 6 (nicha.sw, nana.sr, som.ch, kanya.th, james.bk, pim.wn)
// Distractor students: 20
// Ratio: 20/6 = 3.33x — meets >= 3x requirement

// ─── Eval fixture ─────────────────────────────────────────────────────────────
//
// Fixture shape:
//   label: human-readable description
//   studentName: AI-extracted student name (may be null)
//   parentName: AI-extracted parent name (may be null)
//   expectedStudentKey: correct student key (null = negative case, expect no match)

const EVAL_FIXTURES = [
  // ── Standard cases: romanized names ──
  {
    label: "Exact full romanized student name",
    studentName: "Nicha Suwanprasert",
    parentName: null,
    expectedStudentKey: "nicha.sw::parent",
  },
  {
    label: "Exact first name only (romanized) — token match",
    studentName: "Nicha",
    parentName: null,
    expectedStudentKey: "nicha.sw::parent",
  },
  {
    label: "Exact last name only (romanized) — token match",
    studentName: "Suwanprasert",
    parentName: null,
    expectedStudentKey: "nicha.sw::parent",
  },
  {
    label: "James exact full name",
    studentName: "James Bangkok",
    parentName: null,
    expectedStudentKey: "james.bk::parent",
  },
  {
    label: "Pimchanok exact full name",
    studentName: "Pimchanok Wannakorn",
    parentName: null,
    expectedStudentKey: "pim.wn::parent",
  },
  {
    label: "Kanya Thailand exact full name",
    studentName: "Kanya Thailand",
    parentName: null,
    expectedStudentKey: "kanya.th::parent",
  },

  // ── Hard cases: Thai nicknames ──
  {
    label: "Thai nickname น้องส้ม — exact Thai token match in student name",
    studentName: "น้องส้ม",
    parentName: null,
    expectedStudentKey: "som.ch::parent",
  },
  {
    label: "Parent uses Thai mom nickname to identify child — คุณแม่ส้ม as parentName",
    studentName: null,
    parentName: "คุณแม่ส้ม",
    expectedStudentKey: "som.ch::parent",
  },
  {
    label: "Thai nickname หนูนา (nickname for Nuuna) — romanized-vs-Thai mismatch (fuzzy expected)",
    studentName: "หนูนา",
    parentName: null,
    // "หนูนา" is a Thai nickname; the directory has "Nuuna Sripan" — this is a hard case
    // where the Thai nickname does NOT appear in the romanized student name.
    // The matcher may NOT produce a match here — this is acceptable (negative outcome is fine).
    // We set expectedStudentKey to null to treat as negative (no forced match required).
    expectedStudentKey: null,
  },

  // ── Hard cases: romanized-vs-Thai of the same name ──
  {
    label: "Romanized 'Nuuna' matching romanized directory entry",
    studentName: "Nuuna",
    parentName: null,
    expectedStudentKey: "nana.sr::parent",
  },
  {
    label: "Thai parentName matches expected contact via parentName exact",
    studentName: null,
    parentName: "คุณแม่สุดา",
    expectedStudentKey: "nana.sr::parent",
  },
  {
    label: "Thai parentName คุณแม่นิชา — exact parentName match",
    studentName: null,
    parentName: "คุณแม่นิชา",
    expectedStudentKey: "nicha.sw::parent",
  },

  // ── Hard cases: ambiguous shared first name — only one is correct ──
  {
    label: "Shared first name 'Nicha' — ambiguous (two directory entries share first name)",
    // Both nicha.sw and nicha.kh have first name "Nicha".
    // Input has parentName that disambiguates to the expected match.
    studentName: "Nicha",
    parentName: "คุณแม่นิชา",
    // parentName is the disambiguator here — nicha.sw has parentName "คุณแม่นิชา"
    expectedStudentKey: "nicha.sw::parent",
  },
  {
    label: "Shared first name 'James' — only parent disambiguates",
    studentName: "James",
    parentName: "Parent James",
    // james.bk has parentName "Parent James"; james.cm has "Dad James C"
    expectedStudentKey: "james.bk::parent",
  },

  // ── Standard cases: parent name only ──
  {
    label: "Parent name แม่กัญญา — exact parentName match for Kanya",
    studentName: null,
    parentName: "แม่กัญญา",
    expectedStudentKey: "kanya.th::parent",
  },
  {
    label: "Parent name คุณพ่อปิม — exact parentName match for Pimchanok",
    studentName: null,
    parentName: "คุณพ่อปิม",
    expectedStudentKey: "pim.wn::parent",
  },

  // ── Standard cases: fuzzy matches ──
  {
    label: "Near-Levenshtein romanized name 'Jomes' (edit dist 1 from James) — fuzzy match",
    studentName: "Jomes Bangkok",
    parentName: null,
    expectedStudentKey: "james.bk::parent",
  },
  {
    label: "Near-Levenshtein 'Pimchanok' with single-char typo 'Pimchaok' — fuzzy match",
    studentName: "Pimchaok",
    parentName: null,
    expectedStudentKey: "pim.wn::parent",
  },
  {
    label: "Near-Levenshtein 'Kanya' partial fuzzy via 'Kanwa' (edit dist 2)",
    studentName: "Kanwa",
    parentName: null,
    expectedStudentKey: "kanya.th::parent",
  },

  // ── Negative cases (expectedStudentKey: null) — matcher must return [] ──
  {
    label: "Negative: gibberish input produces no match",
    studentName: "xyzqwrp",
    parentName: null,
    expectedStudentKey: null,
  },
  {
    label: "Negative: extremely common Thai word not in any name",
    studentName: "สวัสดี",
    parentName: null,
    // "สวัสดี" (hello) is not part of any student/parent name in the directory
    expectedStudentKey: null,
  },
  {
    label: "Negative: parent name that is too generic to match any student",
    studentName: null,
    parentName: "แม่",
    // "แม่" alone is a common word (mother) and too short to uniquely match anything
    expectedStudentKey: null,
  },
  {
    label: "Negative: null + null — no names at all",
    studentName: null,
    parentName: null,
    expectedStudentKey: null,
  },
  {
    label: "Negative: totally unrelated English name with no directory match",
    studentName: "Bartholomew",
    parentName: null,
    expectedStudentKey: null,
  },
] as const;

// ─── Eval test ────────────────────────────────────────────────────────────────

describe("name-matcher eval — precision / recall against distractor-rich directory", () => {
  it("directory has >= 3x more distractor students than expected-match students", () => {
    // Expected: 6 unique student keys in fixtures with non-null expectedStudentKey
    const expectedKeys = new Set(
      EVAL_FIXTURES.filter((f) => f.expectedStudentKey !== null).map((f) => f.expectedStudentKey),
    );
    const expectedCount = expectedKeys.size;

    // Distractors: all students NOT in expectedKeys
    const distractorCount = MOCK_DIRECTORY.filter(
      (s) => !expectedKeys.has(s.studentKey as (typeof expectedKeys extends Set<infer T> ? T : never)),
    ).length;

    expect(distractorCount).toBeGreaterThanOrEqual(expectedCount * 3);
  });

  it("fixture contains >= 3 negative cases", () => {
    const negatives = EVAL_FIXTURES.filter((f) => f.expectedStudentKey === null);
    expect(negatives.length).toBeGreaterThanOrEqual(3);
  });

  it("fixture contains >= 20 total entries", () => {
    expect(EVAL_FIXTURES.length).toBeGreaterThanOrEqual(20);
  });

  it("precision >= 0.90 and recall >= 0.60 on distractor-rich fixture", () => {
    // Suggestion = any candidate returned (score >= SUGGEST_SHORTLIST_MIN_SCORE)
    let totalSuggestions = 0;
    let correctSuggestions = 0;
    let expectedMatchCount = 0;
    let recalledCount = 0;

    for (const fixture of EVAL_FIXTURES) {
      const candidates = matchNamesToDirectory(
        { studentName: fixture.studentName, parentName: fixture.parentName },
        MOCK_DIRECTORY,
      );

      if (fixture.expectedStudentKey === null) {
        // Negative case: any suggestion counts as a precision failure
        totalSuggestions += candidates.length;
        // No correct suggestions possible (expectedStudentKey is null)
        // correctSuggestions unchanged
      } else {
        // Positive case
        expectedMatchCount++;
        totalSuggestions += candidates.length;

        const hasCorrect = candidates.some((c) => c.student.studentKey === fixture.expectedStudentKey);
        if (hasCorrect) {
          correctSuggestions++;
          recalledCount++;
        }
      }
    }

    const precision = totalSuggestions === 0 ? 1 : correctSuggestions / totalSuggestions;
    const recall = expectedMatchCount === 0 ? 0 : recalledCount / expectedMatchCount;

    // Report for SUMMARY.md
    console.log(`\nEval results:`);
    console.log(`  Fixtures: ${EVAL_FIXTURES.length} (${expectedMatchCount} positive, ${EVAL_FIXTURES.length - expectedMatchCount} negative)`);
    console.log(`  Directory: ${MOCK_DIRECTORY.length} students`);
    console.log(`  Total suggestions: ${totalSuggestions}`);
    console.log(`  Correct suggestions: ${correctSuggestions}`);
    console.log(`  Precision: ${precision.toFixed(3)} (required >= 0.90)`);
    console.log(`  Recall: ${recall.toFixed(3)} (required >= 0.60)`);

    expect(precision).toBeGreaterThanOrEqual(0.90);
    expect(recall).toBeGreaterThanOrEqual(0.60);
  });
});
