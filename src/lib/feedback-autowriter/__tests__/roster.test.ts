import { describe, expect, it } from "vitest";
import { redactForModel } from "../prompt";
import { AUTOWRITER_ROSTER, AUTOWRITER_TUTORS, rosterAccountIds, rosterWriterArm } from "../roster";

describe("autowriter roster", () => {
  it("lists every Wise account once, and every tutor with both accounts", () => {
    const ids = AUTOWRITER_ROSTER.map((tutor) => tutor.wiseUserId);
    expect(new Set(ids).size).toBe(ids.length);
    for (const id of ids) expect(id).toMatch(/^[0-9a-f]{24}$/u);
    expect(AUTOWRITER_TUTORS).toHaveLength(48);
    for (const tutor of AUTOWRITER_TUTORS) {
      expect(tutor.wiseUserIds).toHaveLength(2);
      expect(rosterAccountIds(tutor.canonicalKey)).toEqual(tutor.wiseUserIds);
    }
  });

  it("gives both of a tutor's accounts the same names and writer", () => {
    for (const tutor of AUTOWRITER_TUTORS) {
      const accounts = AUTOWRITER_ROSTER.filter((account) => account.canonicalKey === tutor.canonicalKey);
      expect(new Set(accounts.map((account) => JSON.stringify(account.tutorNames))).size).toBe(1);
      expect(new Set(accounts.map((account) => account.writer ?? null)).size).toBe(1);
    }
  });

  it("writes the 13 tutors added on 2 Oct with Luna first and the first five with the default writer", () => {
    expect(["Kevin", "Gift", "Ek", "Peat", "Mimi"].map(rosterWriterArm)).toEqual([null, null, null, null, null]);
    const added = ["Ras", "Celeste", "Taki", "Dome", "Mandy", "Grace", "Mint", "Fluke", "Calvin", "Lukas", "A", "Ohm", "Mookie"];
    expect(added.map(rosterWriterArm)).toEqual(added.map(() => "luna"));
    // "Fluke" is Chettaporn; Suphawisit (Fluke-Supha) is not on the roster.
    expect(rosterAccountIds("Fluke")).toEqual(["698bddb3b0e4b23fd50633f2", "698bdcc8b0e4b23fd5055a49"]);
    expect(rosterAccountIds("Fluke-Supha")).toEqual([]);
  });

  it("writes the 9 tutors of cohort 4 (2 Oct) with Luna first", () => {
    const added = ["Aey", "Mikki", "Sagotty", "Buzz", "Linn", "Eng", "Kavin", "Copter", "Amy"];
    expect(added.map(rosterWriterArm)).toEqual(added.map(() => "luna"));
    for (const key of added) expect(rosterAccountIds(key), key).toHaveLength(2);
  });

  it("never redacts a name variant short enough to match ordinary words (redaction is case-insensitive)", () => {
    for (const account of AUTOWRITER_ROSTER) {
      for (const name of account.tutorNames) expect([...name.replace(/\s+/gu, "")].length, name).toBeGreaterThanOrEqual(2);
      for (const name of account.tutorNames) expect(name.toLowerCase(), name).not.toMatch(/^(?:a|i|an|am|as|at|be|by|do|go|he|if|in|is|it|me|my|no|of|on|or|so|to|up|us|we|online)$/u);
    }
    expect(AUTOWRITER_ROSTER.find((account) => account.canonicalKey === "A")?.tutorNames).toEqual(["Anavat Siamwala"]);
    // "Eng" is also shorthand for English: redacting it would garble subject names in summaries.
    expect(AUTOWRITER_ROSTER.find((account) => account.canonicalKey === "Eng")?.tutorNames).toEqual(["Phattadon Sucharittanonta"]);
  });

  it("writes cohort 5 (5 Oct, every remaining online tutor) with Luna first", () => {
    const added = ["Tito", "Petch-Than", "Praew", "Shop", "Tai", "Menika", "Fay", "Pat", "Punlee", "Pech", "Jennie", "Mek-Sila", "Pakgad", "Glai", "Rew", "Win", "Sunday", "Nithit", "Key", "Ayush", "Art"];
    expect(added.map(rosterWriterArm)).toEqual(added.map(() => "luna"));
    for (const key of added) expect(rosterAccountIds(key), key).toHaveLength(2);
    // Mek-Sila's main account spells the surname differently; both spellings are redacted.
    expect(AUTOWRITER_ROSTER.find((account) => account.canonicalKey === "Mek-Sila")?.tutorNames)
      .toEqual(["Sila Phonak", "Sila Phonrak", "Mek-Sila"]);
  });

  it("redacts no ordinary lesson word, though every word of each name variant is redacted", () => {
    const tutorNames = [...new Set(AUTOWRITER_ROSTER.flatMap((account) => account.tutorNames))];
    const lesson = "On Sunday we did a test, then art and Eng Lit: the key idea is to win the shop game rather than "
      + "roll the rod (em units, Jr. level).";
    expect(redactForModel(lesson, { studentFullName: "Krit (Tom.Ka) Kaewmanee", tutorNames })).toBe(lesson);
  });
});
