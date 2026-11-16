import { describe, expect, it } from "vitest";
import { applicationSchema } from "../model";
import { phoneTier } from "../sources";
import { readWorkRights, redactProfile, removeWorkRights, seekPhone } from "../seek-text";

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

describe("SEEK phone link", () => {
  it("takes the number from the tel link and removes spaces, dots, dashes and brackets", () => {
    expect(seekPhone("tel:+66 812345678")).toBe("+66812345678");
    expect(seekPhone("tel:081-234-5678")).toBe("0812345678");
    expect(seekPhone("tel:(02) 123.4567")).toBe("021234567");
    expect(seekPhone("tel:%2B66%20812345678")).toBe("+66812345678");
  });
  it("stores nothing for a link that is not a usable number", () => {
    for (const href of [null, undefined, "", "mailto:a@b.co", "tel:", "tel:12345", "tel:1234567890123456", "tel:call me", "tel:+66 81 x234", "tel:%E0%A4%A"])
      expect(seekPhone(href)).toBeNull();
  });
  it("is the form the import schema accepts, and an import with no phone still parses", () => {
    const base = { applicationId: "00000000-0000-4000-8000-000000000001", name: "Sample", email: null, profileText: "x", previouslyContacted: false, sourceStatus: "Inbox" };
    expect(applicationSchema.parse(base).phone).toBeNull();
    expect(applicationSchema.parse({ ...base, phone: seekPhone("tel:+66 812345678") }).phone).toBe("+66812345678");
    expect(applicationSchema.safeParse({ ...base, phone: "081 234 5678" }).success).toBe(false);
  });
});

describe("which SEEK applications are opened for a phone number", () => {
  const rows = [
    { id: "call-1", ids: ["a1", "a2"] },
    { id: "call-2", ids: ["b1"] },
    { id: "other", ids: ["c1"] },
    { id: "tracker-only", ids: [] },
  ];
  const toCall = new Set(["call-1", "call-2"]);
  it("takes the people HR must call first, and only them", () => {
    expect([...phoneTier(rows, toCall, new Set())].sort()).toEqual(["a1", "a2", "b1"]);
  });
  it("leaves out a tried application, and moves on when every call candidate is tried", () => {
    expect([...phoneTier(rows, toCall, new Set(["a1", "b1"]))]).toEqual(["a2"]);
    expect([...phoneTier(rows, toCall, new Set(["a1", "a2", "b1"]))]).toEqual(["c1"]);
  });
  it("is empty when nothing is left, and a row with no SEEK application never holds the first place", () => {
    expect(phoneTier(rows, toCall, new Set(["a1", "a2", "b1", "c1"])).size).toBe(0);
    expect([...phoneTier([{ id: "call-1", ids: [] }, { id: "other", ids: ["c1"] }], toCall, new Set())]).toEqual(["c1"]);
  });
});
