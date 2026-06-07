import { describe, expect, it } from "vitest";
import {
  distinctiveTokens,
  buildTargetTokenIndex,
  matchFollowersToTargets,
  type BacklogMatchResult,
  type VerifiedResolverTarget,
} from "@/lib/line/backlog-matcher";
import type { LineProfile } from "@/lib/line/client";

// ─── Helpers ───────────────────────────────────────────────────────────────────

function target(overrides: Partial<VerifiedResolverTarget>): VerifiedResolverTarget {
  return {
    studentName: "Default Student",
    parentName: "Default Parent",
    searchCode: null,
    lineChatUrl: "https://chat.line.biz/placeholder",
    wiseStudentId: "wise-default",
    studentKey: "default::parent",
    ...overrides,
  };
}

function follower(overrides: Partial<LineProfile>): LineProfile {
  return {
    userId: "Udefault",
    displayName: "Default Display",
    raw: {},
    ...overrides,
  };
}

// ─── distinctiveTokens ─────────────────────────────────────────────────────────

describe("distinctiveTokens", () => {
  it("extracts romanized lastname (≥4 chars) from a two-word name", () => {
    const tokens = distinctiveTokens("OIL PinyavorakuL");
    expect(tokens).toContain("pinyavorakul");
  });

  it("excludes short tokens (≤3 chars) from romanized names", () => {
    const tokens = distinctiveTokens("OIL PinyavorakuL");
    expect(tokens).not.toContain("oil");
  });

  it("extracts nickname-code via (…) regex", () => {
    const tokens = distinctiveTokens("Ploychompu (Kaimook.Ka) Kaewkhampholkul");
    expect(tokens).toContain("kaimook.ka");
    expect(tokens).toContain("kaewkhampholkul");
  });

  it("returns [] for a name with only short tokens (≤3 chars)", () => {
    expect(distinctiveTokens("Oil")).toEqual([]);
  });

  it("returns [] for an empty string", () => {
    expect(distinctiveTokens("")).toEqual([]);
  });

  it("returns [] for whitespace-only string", () => {
    expect(distinctiveTokens("   ")).toEqual([]);
  });

  it("handles mixed Thai/English name — extracts only ≥4-char tokens", () => {
    // English part "Smith" is 5 chars; Thai tokens pass through normalizeForNameMatch
    const tokens = distinctiveTokens("นิ Smith");
    expect(tokens).toContain("smith");
    expect(tokens).not.toContain("นิ");
  });

  it("deduplicates tokens that appear in both space and nickname positions", () => {
    // If the same code appears as a space token and inside (…), only one copy appears
    const tokens = distinctiveTokens("Kaimook.Ka (Kaimook.Ka) Smith");
    const count = tokens.filter((t) => t === "kaimook.ka").length;
    expect(count).toBe(1);
  });

  it("handles names with no parenthesized sections — no nickname-codes extracted", () => {
    const tokens = distinctiveTokens("Nicha Suwanprasert");
    expect(tokens).toContain("suwanprasert");
    // No (…) in this name — extractNicknameCodes produces nothing
    expect(tokens).not.toContain("kaimook.ka");
  });

  it("nickname-code shorter than 4 chars is excluded", () => {
    // "(abc)" → normalized "abc" = 3 chars → excluded
    const tokens = distinctiveTokens("Ploychompu (abc) Suwanprasert");
    expect(tokens).not.toContain("abc");
    expect(tokens).toContain("suwanprasert");
  });
});

// ─── buildTargetTokenIndex ────────────────────────────────────────────────────

describe("buildTargetTokenIndex", () => {
  it("builds index from studentName tokens", () => {
    const targets = [
      target({ studentKey: "stu-1", studentName: "Nicha Suwanprasert", parentName: "Parent" }),
    ];
    const index = buildTargetTokenIndex(targets);
    expect(index.get("suwanprasert")).toEqual(new Set(["stu-1"]));
  });

  it("builds index from parentName tokens", () => {
    const targets = [
      target({ studentKey: "stu-1", studentName: "Nicha", parentName: "Kaur Pavan" }),
    ];
    const index = buildTargetTokenIndex(targets);
    expect(index.get("pavan")).toEqual(new Set(["stu-1"]));
    expect(index.get("kaur")).toEqual(new Set(["stu-1"]));
  });

  it("extracts searchCode nickname-codes and indexes them", () => {
    const targets = [
      target({
        studentKey: "stu-1",
        studentName: "Ploychompu Kaewkham",
        parentName: "Parent",
        searchCode: "(Kaimook.Ka)",
      }),
    ];
    const index = buildTargetTokenIndex(targets);
    expect(index.get("kaimook.ka")).toEqual(new Set(["stu-1"]));
  });

  it("short tokens (≤3 chars) are excluded from the index", () => {
    const targets = [
      target({ studentKey: "stu-1", studentName: "Oil Mig", parentName: "Bo" }),
    ];
    const index = buildTargetTokenIndex(targets);
    // "oil" (3 chars), "mig" (3 chars), "bo" (2 chars) — all below threshold
    expect(index.has("oil")).toBe(false);
    expect(index.has("mig")).toBe(false);
    expect(index.has("bo")).toBe(false);
  });

  it("maps the same token to multiple student keys when shared", () => {
    const targets = [
      target({ studentKey: "stu-1", studentName: "Nicha Suwanprasert", parentName: "Parent" }),
      target({ studentKey: "stu-2", studentName: "Natcha Suwanprasert", parentName: "Parent" }),
    ];
    const index = buildTargetTokenIndex(targets);
    // Both share the "suwanprasert" token
    expect(index.get("suwanprasert")).toEqual(new Set(["stu-1", "stu-2"]));
  });

  it("handles null searchCode gracefully — no index entries from null", () => {
    const targets = [
      target({ studentKey: "stu-1", studentName: "Nicha Suwanprasert", parentName: "Parent", searchCode: null }),
    ];
    // Should not throw; index built from name tokens only
    expect(() => buildTargetTokenIndex(targets)).not.toThrow();
  });

  it("returns an empty Map for empty targets array", () => {
    const index = buildTargetTokenIndex([]);
    expect(index.size).toBe(0);
  });
});

// ─── matchFollowersToTargets ───────────────────────────────────────────────────

describe("matchFollowersToTargets", () => {
  it("unambiguous match (exactly one student key) returns confidence 'high'", () => {
    const t1 = target({
      studentKey: "stu-1",
      studentName: "Nicha Suwanprasert",
      parentName: "Parent One",
      lineChatUrl: "https://chat.line.biz/abc123",
    });
    const index = buildTargetTokenIndex([t1]);
    const targetsByKey = new Map([["stu-1", t1]]);

    const results = matchFollowersToTargets(
      [follower({ userId: "U001", displayName: "OIL Suwanprasert" })],
      index,
      targetsByKey,
    );

    expect(results).toHaveLength(1);
    expect(results[0].confidence).toBe("high");
    expect(results[0].matchedStudentKey).toBe("stu-1");
    expect(results[0].lineChatUrl).toBe("https://chat.line.biz/abc123");
    expect(results[0].lineUserId).toBe("U001");
    expect(results[0].studentName).toBe("Nicha Suwanprasert");
  });

  it("ambiguous match (two student keys share a token) returns two results both 'ambiguous'", () => {
    const t1 = target({
      studentKey: "stu-1",
      studentName: "Nicha Suwanprasert",
      parentName: "Parent One",
    });
    const t2 = target({
      studentKey: "stu-2",
      studentName: "Natcha Suwanprasert",
      parentName: "Parent Two",
    });
    const index = buildTargetTokenIndex([t1, t2]);
    const targetsByKey = new Map([["stu-1", t1], ["stu-2", t2]]);

    const results = matchFollowersToTargets(
      [follower({ userId: "U002", displayName: "OIL Suwanprasert" })],
      index,
      targetsByKey,
    );

    // Both t1 and t2 share "suwanprasert" → ambiguous, never collapsed
    expect(results).toHaveLength(2);
    for (const r of results) {
      expect(r.confidence).toBe("ambiguous");
      expect(r.lineUserId).toBe("U002");
    }
    const keys = results.map((r) => r.matchedStudentKey);
    expect(keys).toContain("stu-1");
    expect(keys).toContain("stu-2");
  });

  it("follower with no token match in index returns zero results", () => {
    const t1 = target({
      studentKey: "stu-1",
      studentName: "Nicha Suwanprasert",
      parentName: "Parent One",
    });
    const index = buildTargetTokenIndex([t1]);
    const targetsByKey = new Map([["stu-1", t1]]);

    // "Jon" is 3 chars — below threshold → no tokens → no match
    const results = matchFollowersToTargets(
      [follower({ userId: "U003", displayName: "Jon" })],
      index,
      targetsByKey,
    );

    expect(results).toHaveLength(0);
  });

  it("follower with empty displayName returns zero results without crashing", () => {
    const t1 = target({ studentKey: "stu-1", studentName: "Nicha Suwanprasert", parentName: "Parent" });
    const index = buildTargetTokenIndex([t1]);
    const targetsByKey = new Map([["stu-1", t1]]);

    const results = matchFollowersToTargets(
      [follower({ userId: "U004", displayName: "" })],
      index,
      targetsByKey,
    );

    expect(results).toHaveLength(0);
  });

  it("follower with undefined displayName returns zero results without crashing", () => {
    const t1 = target({ studentKey: "stu-1", studentName: "Nicha Suwanprasert", parentName: "Parent" });
    const index = buildTargetTokenIndex([t1]);
    const targetsByKey = new Map([["stu-1", t1]]);

    // LineProfile.displayName is optional
    const noDisplayName: LineProfile = { userId: "U005", raw: {} };
    const results = matchFollowersToTargets([noDisplayName], index, targetsByKey);

    expect(results).toHaveLength(0);
  });

  it("null lineChatUrl passes through to BacklogMatchResult.lineChatUrl", () => {
    const t1 = target({
      studentKey: "stu-1",
      studentName: "Nicha Suwanprasert",
      parentName: "Parent",
      lineChatUrl: null,
    });
    const index = buildTargetTokenIndex([t1]);
    const targetsByKey = new Map([["stu-1", t1]]);

    const results = matchFollowersToTargets(
      [follower({ userId: "U006", displayName: "OIL Suwanprasert" })],
      index,
      targetsByKey,
    );

    expect(results).toHaveLength(1);
    expect(results[0].lineChatUrl).toBeNull();
    expect(results[0].confidence).toBe("high");
  });

  it("returns the matched tokens that triggered the match", () => {
    const t1 = target({
      studentKey: "stu-1",
      studentName: "Nicha Suwanprasert",
      parentName: "Parent",
    });
    const index = buildTargetTokenIndex([t1]);
    const targetsByKey = new Map([["stu-1", t1]]);

    const results = matchFollowersToTargets(
      [follower({ userId: "U007", displayName: "OIL Suwanprasert" })],
      index,
      targetsByKey,
    );

    expect(results[0].tokens).toContain("suwanprasert");
  });

  it("does not produce a 'status' field — fail-closed invariant", () => {
    const t1 = target({ studentKey: "stu-1", studentName: "Nicha Suwanprasert", parentName: "Parent" });
    const index = buildTargetTokenIndex([t1]);
    const targetsByKey = new Map([["stu-1", t1]]);

    const results: BacklogMatchResult[] = matchFollowersToTargets(
      [follower({ displayName: "OIL Suwanprasert" })],
      index,
      targetsByKey,
    );

    for (const r of results) {
      expect(r).not.toHaveProperty("status");
    }
  });

  it("handles empty followers array without error", () => {
    const index = new Map<string, Set<string>>();
    const targetsByKey = new Map<string, VerifiedResolverTarget>();
    const results = matchFollowersToTargets([], index, targetsByKey);
    expect(results).toEqual([]);
  });

  it("handles empty index (no targets) — zero matches for any follower", () => {
    const index = new Map<string, Set<string>>();
    const targetsByKey = new Map<string, VerifiedResolverTarget>();

    const results = matchFollowersToTargets(
      [follower({ displayName: "Nicha Suwanprasert" })],
      index,
      targetsByKey,
    );

    expect(results).toHaveLength(0);
  });

  it("whitespace-only displayName returns zero results", () => {
    const t1 = target({ studentKey: "stu-1", studentName: "Nicha Suwanprasert", parentName: "Parent" });
    const index = buildTargetTokenIndex([t1]);
    const targetsByKey = new Map([["stu-1", t1]]);

    const results = matchFollowersToTargets(
      [follower({ userId: "U008", displayName: "   " })],
      index,
      targetsByKey,
    );

    expect(results).toHaveLength(0);
  });
});
