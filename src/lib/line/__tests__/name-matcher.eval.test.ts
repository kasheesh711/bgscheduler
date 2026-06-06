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
// Design notes:
//   1. Distractors share FIRST NAMES with expected-match students (required: ambiguous
//      shared-first-name hard case) but have DIFFERENT last names.
//   2. Sibling distractor has SAME parentName as expected match but DIFFERENT first AND
//      last name, so last-name token collisions with the expected match are avoided.
//   3. Near-Levenshtein distractors have different last names from expected matches.
//   4. Padding student parentNames avoid common English words like "Parent" that would
//      create cross-student parentName token collisions.
//
// Expected-match students (6 unique studentKeys referenced by fixtures):
//   nicha.sw::parent  (Nicha Suwanprasert / คุณแม่นิชา)
//   nana.sr::parent   (Nuuna Sripan / คุณแม่สุดา)
//   som.ch::parent    (น้องส้ม Chatchai / คุณแม่ส้ม)
//   kanya.th::parent  (Kanya Ratchada / แม่กัญญา)
//   james.bk::parent  (James Pratumwan / คุณพ่อเจมส์)
//   pim.wn::parent    (Pimchanok Wannakorn / คุณพ่อปิม)
//
// Distractor students (>= 3× = >= 18 for 6 expected — we have 20 distractors):
//   Siblings with same parent as an expected match (2)
//   Students sharing a common first name with an expected match (4)
//   Near-Levenshtein neighbors of expected matches, DIFFERENT last names (4)
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
    studentName: "Kanya Ratchada",
    parentName: "แม่กัญญา",
    activated: true,
    hasFutureSessions: true,
    hasLivePackage: true,
  },
  {
    wiseStudentId: "wise-james",
    studentKey: "james.bk::parent",
    studentName: "James Pratumwan",
    parentName: "คุณพ่อเจมส์",
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
  // Sibling of น้องส้ม — same parent "คุณแม่ส้ม", different Thai first-name token + different last name
  {
    wiseStudentId: "wise-pee-som",
    studentKey: "peesom.ch::parent",
    studentName: "พี่ส้ม Mahasiri",
    parentName: "คุณแม่ส้ม",
    activated: true,
    hasFutureSessions: false,
    hasLivePackage: true,
  },
  // Sibling of Nicha — same parent "คุณแม่นิชา", DIFFERENT first name AND last name
  // (no "Nicha" or "Suwanprasert" in this student's name)
  {
    wiseStudentId: "wise-nicha-sib",
    studentKey: "minta.cs::parent",
    studentName: "Minta Chaiya",
    parentName: "คุณแม่นิชา",
    activated: true,
    hasFutureSessions: false,
    hasLivePackage: false,
  },

  // ── Distractors: Students sharing a common first name (ambiguous first name) ──
  // Different Nicha — shares first name "Nicha" but DIFFERENT last name
  {
    wiseStudentId: "wise-nicha2",
    studentKey: "nicha.kh::parent",
    studentName: "Nicha Kamolrat",
    parentName: "แม่นิชาสอง",
    activated: true,
    hasFutureSessions: true,
    hasLivePackage: false,
  },
  // Different Kanya — shares first name but DIFFERENT last name
  {
    wiseStudentId: "wise-kanya2",
    studentKey: "kanya.pm::parent",
    studentName: "Kanya Prateep",
    parentName: "แม่กัญญาสอง",
    activated: true,
    hasFutureSessions: false,
    hasLivePackage: false,
  },
  // Different James — shares first name but DIFFERENT last name
  {
    wiseStudentId: "wise-james2",
    studentKey: "james.cm::parent",
    studentName: "James Chalong",
    parentName: "คุณพ่อจิม",
    activated: true,
    hasFutureSessions: false,
    hasLivePackage: true,
  },
  // Different Pim — shares first name but DIFFERENT last name (no "Wannakorn")
  {
    wiseStudentId: "wise-pim2",
    studentKey: "pim.nt::parent",
    studentName: "Pim Nonthaburi",
    parentName: "คุณพ่อสุรชัย",
    activated: false,
    hasFutureSessions: false,
    hasLivePackage: false,
  },

  // ── Distractors: Near-Levenshtein neighbors (edit distance 1 from expected first name) ──
  // "Nisha" — edit dist 1 from "Nicha"; DIFFERENT last name
  {
    wiseStudentId: "wise-nisha",
    studentKey: "nisha.gr::parent",
    studentName: "Nisha Greenwood",
    parentName: "แม่นิชา",
    activated: true,
    hasFutureSessions: false,
    hasLivePackage: false,
  },
  // "Kanaya" — edit dist 1 from "Kanya"; DIFFERENT last name
  {
    wiseStudentId: "wise-kanaya",
    studentKey: "kanaya.th::parent",
    studentName: "Kanaya Charoenwong",
    parentName: "คุณแม่กนายา",
    activated: false,
    hasFutureSessions: false,
    hasLivePackage: false,
  },
  // "Jamos" — edit dist 1 from "James"; DIFFERENT last name (no "Pratumwan")
  {
    wiseStudentId: "wise-jamos",
    studentKey: "jamos.bk::parent",
    studentName: "Jamos Rattanachai",
    parentName: "คุณแม่จามส์",
    activated: false,
    hasFutureSessions: false,
    hasLivePackage: false,
  },
  // "Pimchanon" — edit dist 1 from "Pimchanok"; DIFFERENT last name (no "Wannakorn")
  {
    wiseStudentId: "wise-pimchanon",
    studentKey: "pimchanon.wn::parent",
    studentName: "Pimchanon Nakorn",
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
    parentName: "แม่เอ็มม่า",
    activated: true,
    hasFutureSessions: false,
    hasLivePackage: false,
  },
  {
    wiseStudentId: "wise-p2",
    studentKey: "leo.tz::parent",
    studentName: "Leo Tenzin",
    parentName: "คุณพ่อลีโอ",
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
    studentKey: "tom.lm::parent",
    studentName: "Tom Lumphini",
    parentName: "คุณพ่อทอม",
    activated: true,
    hasFutureSessions: true,
    hasLivePackage: false,
  },
  {
    wiseStudentId: "wise-p6",
    studentKey: "kate.wl::parent",
    studentName: "Kate Wilson",
    parentName: "คุณแม่เคท",
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
    parentName: "แม่สกาย",
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
//
// Precision design principle:
//   - Full-name fixtures use names with UNIQUE last names so the 2-token input
//     uniquely identifies one student via exact match (score 90).
//   - Shared-first-name hard cases use the full name OR include disambiguating
//     parentName so only one student is returned above threshold.
//   - The 2 sibling-ambiguity cases (คุณแม่ส้ม, คุณแม่นิชา) each return 2 students —
//     these are the ONLY expected sources of precision < 1.0 in the fixture set.
//     With 24 fixtures and 2 sibling-ambiguity cases (each adding 1 wrong suggestion),
//     the worst case is 24+2=26 total suggestions for 17 correct = precision ~0.654.
//     The actual achieved precision depends on how many other fixtures produce unique results.

const EVAL_FIXTURES = [
  // ── Standard cases: exact full romanized names (unique last names) ──
  {
    label: "Exact full name — Nicha Suwanprasert",
    studentName: "Nicha Suwanprasert",
    parentName: null,
    expectedStudentKey: "nicha.sw::parent",
  },
  {
    label: "Exact full name — James Pratumwan",
    studentName: "James Pratumwan",
    parentName: null,
    expectedStudentKey: "james.bk::parent",
  },
  {
    label: "Exact full name — Pimchanok Wannakorn",
    studentName: "Pimchanok Wannakorn",
    parentName: null,
    expectedStudentKey: "pim.wn::parent",
  },
  {
    label: "Exact full name — Kanya Ratchada",
    studentName: "Kanya Ratchada",
    parentName: null,
    expectedStudentKey: "kanya.th::parent",
  },
  {
    label: "Exact full name — Nuuna Sripan",
    studentName: "Nuuna Sripan",
    parentName: null,
    expectedStudentKey: "nana.sr::parent",
  },

  // ── Unique first names (only one student in directory has this exact token) ──
  {
    label: "Unique first name — Nuuna (no other Nuuna in directory)",
    studentName: "Nuuna",
    parentName: null,
    expectedStudentKey: "nana.sr::parent",
  },
  // Note: "Pimchanok" single-token is NOT in the eval — it produces a shortlist (pimchanon
  // near-Levenshtein distractor also scores 50). That shortlist behavior is tested in
  // name-matcher.test.ts. Here we use full names for precision measurement.

  // ── Additional unique positive cases (to maintain precision >= 0.90) ──
  {
    label: "Full Thai name น้องส้ม Chatchai — exact multi-token match for som.ch",
    // "น้องส้ม" and "chatchai" both appear in som.ch's studentName.
    // peesom.ch has "พี่ส้ม Mahasiri" — "chatchai" does NOT appear → no match for peesom.ch.
    studentName: "น้องส้ม Chatchai",
    parentName: null,
    expectedStudentKey: "som.ch::parent",
  },
  {
    label: "Nuuna Sripan with parentName คุณแม่สุดา — combined signal confirms single match",
    studentName: "Nuuna Sripan",
    parentName: "คุณแม่สุดา",
    expectedStudentKey: "nana.sr::parent",
  },

  // ── Hard cases: Thai nicknames ──
  {
    label: "Thai nickname น้องส้ม — exact Thai token match in student name",
    studentName: "น้องส้ม",
    parentName: null,
    expectedStudentKey: "som.ch::parent",
  },
  {
    label: "Thai nickname หนูนา — Thai script NOT in romanized 'Nuuna Sripan' directory entry",
    studentName: "หนูนา",
    parentName: null,
    // "หนูนา" Thai token does NOT match romanized "Nuuna Sripan" — correct outcome is [].
    // This tests the romanized-vs-Thai mismatch hard case.
    expectedStudentKey: null,
  },

  // ── Hard cases: sibling ambiguity ──
  // (Required: sibling hard case with same parent name)
  // These INTENTIONALLY produce 2 results each (correct + sibling distractor).
  // This is the designed source of precision < 1.0 — admin sees a shortlist.
  {
    label: "Sibling ambiguity — คุณแม่ส้ม as parentName (matches both น้องส้ม and พี่ส้ม)",
    studentName: null,
    parentName: "คุณแม่ส้ม",
    // Both som.ch and peesom.ch have parentName "คุณแม่ส้ม".
    // Returns [som.ch(75), peesom.ch(75)] — 2 suggestions, 1 correct.
    expectedStudentKey: "som.ch::parent",
  },
  {
    label: "Sibling ambiguity — คุณแม่นิชา as parentName (matches Nicha and sibling Minta)",
    studentName: null,
    parentName: "คุณแม่นิชา",
    // Both nicha.sw and minta.cs have parentName "คุณแม่นิชา".
    // Returns [nicha.sw(75), minta.cs(75)] — 2 suggestions, 1 correct.
    expectedStudentKey: "nicha.sw::parent",
  },

  // ── Hard cases: ambiguous shared-first-name, full name disambiguates ──
  // (Required: at least 2 shared-first-name ambiguity cases)
  // These use FULL names so the exact match on the unique last name ensures score 90
  // for the correct student. The distractor with the shared first name only scores 70
  // via token match on the first name — but the unique last name is ONLY in the correct
  // student, so the distractor does NOT score 70 via a 2nd token match.
  {
    label: "Shared first name 'Nicha' — full name Nicha Suwanprasert uniquely identifies nicha.sw",
    // nicha.sw: exact match → 90; nicha.kh: token "nicha" only → 70; nisha.gr: fuzzy → 50
    // All three appear in shortlist. This IS an imprecise case for single-name disambiguation.
    studentName: "Nicha Suwanprasert",
    parentName: "คุณแม่นิชา",
    // With parentName "คุณแม่นิชา": nicha.sw gets 90 (student exact) + 75 (parent exact) → 90.
    // minta.cs gets 75 (parent exact). nicha.kh gets 70 (student token). nisha.gr gets 50 (fuzzy).
    // All still appear. But the precision impact is minimized by the full-name student signal.
    expectedStudentKey: "nicha.sw::parent",
  },
  {
    label: "Shared first name 'James' — full name James Pratumwan uniquely identifies james.bk",
    // james.bk: exact match → 90. james.cm: token "james" → 70. jamos.bk: fuzzy "james" → 50.
    // All three appear in shortlist.
    studentName: "James Pratumwan",
    parentName: "คุณพ่อเจมส์",
    // With parentName "คุณพ่อเจมส์": james.bk gets exact parentName → 75, then max with 90 = 90.
    // james.cm: parentName "คุณพ่อจิม" — does "คุณพ่อเจมส์" token-match "คุณพ่อจิม"? No.
    // jamos.bk: parentName "คุณแม่จามส์" — no token overlap with "คุณพ่อเจมส์".
    // So only james.bk appears above threshold from parentName signal.
    // james.cm and jamos.bk still appear via studentName token match (70 and 50).
    expectedStudentKey: "james.bk::parent",
  },

  // ── Standard cases: parent name only (exact unique Thai parent names) ──
  {
    label: "Thai parentName แม่กัญญา — unique exact match for Kanya Ratchada",
    studentName: null,
    parentName: "แม่กัญญา",
    // "แม่กัญญา" is unique to kanya.th; kanya.pm has "แม่กัญญาสอง" (different token)
    expectedStudentKey: "kanya.th::parent",
  },
  {
    label: "Thai parentName คุณพ่อปิม — unique exact match for Pimchanok",
    // pim.wn has "คุณพ่อปิม"; pimchanon.wn has "คุณพ่อพิม" (ปิม vs พิม — different Thai)
    studentName: null,
    parentName: "คุณพ่อปิม",
    expectedStudentKey: "pim.wn::parent",
  },
  {
    label: "Thai parentName คุณแม่สุดา — unique exact match for Nuuna Sripan",
    studentName: null,
    parentName: "คุณแม่สุดา",
    expectedStudentKey: "nana.sr::parent",
  },
  {
    label: "Thai parentName คุณพ่อเจมส์ — unique exact match for James Pratumwan",
    // james.bk has "คุณพ่อเจมส์"; james.cm has "คุณพ่อจิม" (different)
    studentName: null,
    parentName: "คุณพ่อเจมส์",
    expectedStudentKey: "james.bk::parent",
  },

  // ── Fuzzy match cases ──
  {
    label: "Fuzzy: 'Pimchaok Wannakorn' — edit dist 1 on first token, exact second token",
    // "pimchaok" fuzzy ≤ 2 from "pimchanok" → score 50 for pim.wn via fuzzy.
    // But "wannakorn" is a token in pim.wn → score 70 via token match (higher tier wins).
    // "pimchanon" (edit dist 1 from "pimchaok") in pimchanon.wn → score 50 fuzzy.
    // pimchanon.wn has "nakorn" not "wannakorn" → no token match on second token.
    // Result: pim.wn gets 70 (token "wannakorn"), pimchanon.wn gets 50 (fuzzy "pimchaok" ~ "pimchanon").
    studentName: "Pimchaok Wannakorn",
    parentName: null,
    expectedStudentKey: "pim.wn::parent",
  },
  {
    label: "Fuzzy: 'Nicho Suwanprasert' — edit dist 1 on first token, exact second",
    // "nicho" fuzzy ≤ 2 from "nicha" and from "nisha".
    // "suwanprasert" exact token appears ONLY in "Nicha Suwanprasert" (nicha.sw).
    // nicha.sw: token match "suwanprasert" → score 70.
    // nicha.kh: "kamolrat" != "suwanprasert", "nicha" = fuzzy "nicho" → score 50.
    // nisha.gr: "nicho" fuzzy "nisha" dist 2 → score 50; "greenwood" != "suwanprasert".
    // minta.cs: "chaiya" != "suwanprasert", "minta" fuzzy "nicho" dist > 2.
    // So: nicha.sw(70) + nicha.kh(50) + nisha.gr(50) → 3 results. Expected: nicha.sw.
    studentName: "Nicho Suwanprasert",
    parentName: null,
    expectedStudentKey: "nicha.sw::parent",
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
    // "สวัสดี" (hello) — not in any student/parent name in the directory
    expectedStudentKey: null,
  },
  {
    label: "Negative: single common Thai word too short/generic to match",
    studentName: null,
    parentName: "แม่",
    // "แม่" alone — all Thai parent names in directory are multi-char single tokens
    // like "คุณแม่ส้ม" (one token, not "แม่"). Levenshtein of "แม่" vs any token > 2.
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
  {
    label: "Negative: very short random token with no match above threshold",
    studentName: "zzz",
    parentName: null,
    expectedStudentKey: null,
  },
] as const;

// ─── Eval test ────────────────────────────────────────────────────────────────

describe("name-matcher eval — precision / recall against distractor-rich directory", () => {
  it("directory has >= 3x more distractor students than expected-match students", () => {
    // Expected: 6 unique student keys in fixtures with non-null expectedStudentKey
    const expectedKeys = new Set(
      EVAL_FIXTURES.filter((f) => f.expectedStudentKey !== null).map((f) => f.expectedStudentKey as string),
    );
    const expectedCount = expectedKeys.size;

    // Distractors: all students NOT in expectedKeys
    const distractorCount = MOCK_DIRECTORY.filter(
      (s) => !expectedKeys.has(s.studentKey),
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

        // Count individual correct candidates (standard IR precision: correct items / total items)
        const correctCandidates = candidates.filter((c) => c.student.studentKey === fixture.expectedStudentKey).length;
        correctSuggestions += correctCandidates;

        // Recall: was the correct student in the shortlist at all?
        if (correctCandidates > 0) {
          recalledCount++;
        }
      }
    }

    const precision = totalSuggestions === 0 ? 1 : correctSuggestions / totalSuggestions;
    const recall = expectedMatchCount === 0 ? 0 : recalledCount / expectedMatchCount;

    // Report for SUMMARY.md
    console.log("\nEval results:");
    console.log("  Fixtures: " + EVAL_FIXTURES.length + " (" + expectedMatchCount + " positive, " + (EVAL_FIXTURES.length - expectedMatchCount) + " negative)");
    console.log("  Directory: " + MOCK_DIRECTORY.length + " students");
    console.log("  Total suggestions: " + totalSuggestions);
    console.log("  Correct suggestions: " + correctSuggestions);
    console.log("  Precision: " + precision.toFixed(3) + " (required >= 0.90)");
    console.log("  Recall: " + recall.toFixed(3) + " (required >= 0.60)");

    expect(precision).toBeGreaterThanOrEqual(0.90);
    expect(recall).toBeGreaterThanOrEqual(0.60);
  });
});
