import { describe, expect, it } from "vitest";
import { readWorkRights, redactProfile, removeWorkRights } from "../seek-text";

const RIGHTS = "I have permanent work rights with no restrictions";
const OLD_REMOVAL = /Preferred work rights in Thailand\s*\n[^\n]*/i;

describe("SEEK work-rights text", () => {
  it("reads the answer on the next line", () => {
    expect(readWorkRights(`Career history\nPreferred work rights in Thailand\n${RIGHTS}\nExpected monthly salary\n50,000`)).toBe(RIGHTS);
  });
  it("reads the answer after a blank line", () => {
    expect(readWorkRights(`Preferred work rights in Thailand\n\n  ${RIGHTS}  \nExpected monthly salary`)).toBe(RIGHTS);
    expect(readWorkRights(`Preferred work rights in Thailand  \n\n\n${RIGHTS}`)).toBe(RIGHTS);
  });
  it("reads a blank answer followed by a known heading as no answer", () => {
    for (const heading of ["Expected monthly salary", "Employment status", "Application questions", "Career history"]) {
      expect(readWorkRights(`Preferred work rights in Thailand\n\n${heading}\n50,000`)).toBeNull();
      expect(readWorkRights(`Preferred work rights in Thailand\n${heading.toLowerCase()}\n50,000`)).toBeNull();
    }
    expect(readWorkRights("Preferred work rights in Thailand\n")).toBeNull();
    expect(readWorkRights("Preferred work rights in Thailand")).toBeNull();
    expect(readWorkRights("No such section")).toBeNull();
  });
  it("slices a long answer to the 300 characters the import schema allows", () => {
    const long = "A".repeat(500);
    expect(readWorkRights(`Preferred work rights in Thailand\n${long}`)).toBe("A".repeat(300));
  });
  it("removes the heading, any blank lines and the answer, exactly as the old rule did for a page that matched", () => {
    for (const text of [
      `Career history\nX\nPreferred work rights in Thailand\n${RIGHTS}\nExpected monthly salary\n50,000`,
      `Career history\nX\nPreferred work rights in Thailand\n\n${RIGHTS}\nExpected monthly salary\n50,000`,
      `Preferred work rights in Thailand  \n  \n${RIGHTS}\nTail`,
    ]) {
      expect(removeWorkRights(text)).toBe(text.replace(OLD_REMOVAL, ""));
      expect(removeWorkRights(text)).not.toContain(RIGHTS);
    }
  });
  it("keeps the next heading when the answer is blank", () => {
    const text = "Preferred work rights in Thailand\n\nExpected monthly salary\n50,000";
    expect(removeWorkRights(text)).toBe("Expected monthly salary\n50,000");
  });
});

describe("redactProfile", () => {
  it("replaces the name and drops sensitive lines", () => {
    expect(redactProfile("Pat Smith taught.\nNationality: X\nmail pat@example.com", "Pat Smith")).toBe("[candidate] taught.\nmail [email]");
  });
  it("does not change text when the name is empty", () => {
    expect(redactProfile("abc", "")).toBe("abc");
  });
});
