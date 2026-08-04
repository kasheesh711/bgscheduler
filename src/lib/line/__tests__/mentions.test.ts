import { describe, expect, it } from "vitest";

import { mentionsSelf, readMentionees, stripMentions } from "@/lib/line/mentions";

describe("readMentionees", () => {
  it("reads the documented shape", () => {
    const mentionees = readMentionees({
      type: "text",
      text: "@BeGifted Aadhu.Sr",
      mention: { mentionees: [{ index: 0, length: 9, type: "user", isSelf: true }] },
    });
    expect(mentionees).toHaveLength(1);
    expect(mentionees[0].isSelf).toBe(true);
  });

  it("returns [] for anything malformed — never a false mention", () => {
    for (const message of [
      {},
      { mention: null },
      { mention: {} },
      { mention: { mentionees: null } },
      { mention: { mentionees: "nope" } },
      null,
      undefined,
      "string",
    ]) {
      expect(readMentionees(message)).toEqual([]);
    }
  });

  it("drops non-object entries", () => {
    expect(readMentionees({ mention: { mentionees: ["x", 1, null, { isSelf: true }] } }))
      .toHaveLength(1);
  });
});

describe("mentionsSelf", () => {
  it("is true only for an isSelf user mention", () => {
    expect(mentionsSelf([{ index: 0, length: 9, type: "user", isSelf: true }])).toBe(true);
  });

  it("is false for a mention of somebody else", () => {
    expect(mentionsSelf([{ index: 0, length: 5, type: "user", userId: "U1", isSelf: false }]))
      .toBe(false);
    expect(mentionsSelf([{ index: 0, length: 5, type: "user", userId: "U1" }])).toBe(false);
  });

  it("does NOT treat @all as addressing the bot", () => {
    // Otherwise every group-wide announcement would fire a command.
    expect(mentionsSelf([{ index: 0, length: 4, type: "all", isSelf: true }])).toBe(false);
  });

  it("is false for an empty list", () => {
    expect(mentionsSelf([])).toBe(false);
  });

  it("finds the bot among several mentionees", () => {
    expect(mentionsSelf([
      { index: 0, length: 5, type: "user", userId: "U1", isSelf: false },
      { index: 6, length: 9, type: "user", isSelf: true },
    ])).toBe(true);
  });
});

describe("stripMentions", () => {
  it("strips a leading mention and leaves the command", () => {
    const text = "@BeGifted Aadhu.Sr";
    expect(stripMentions(text, [{ index: 0, length: 9, type: "user", isSelf: true }]))
      .toBe("Aadhu.Sr");
  });

  it("strips several mentions without corrupting earlier offsets", () => {
    // Removing left-to-right would shift later indices; the impl goes right-to-left.
    const text = "@Nok @BeGifted Aadhu.Sr";
    const out = stripMentions(text, [
      { index: 0, length: 4, type: "user", userId: "U1" },
      { index: 5, length: 9, type: "user", isSelf: true },
    ]);
    expect(out).toBe("Aadhu.Sr");
  });

  it("strips a mention in the middle of the text", () => {
    const text = "please @BeGifted send Aadhu.Sr";
    expect(stripMentions(text, [{ index: 7, length: 9, type: "user", isSelf: true }]))
      .toBe("please send Aadhu.Sr");
  });

  it("handles Thai text and emoji by UTF-16 offsets", () => {
    const prefix = "สวัสดี ";
    const text = `${prefix}@BeGifted Aadhu.Sr`;
    expect(stripMentions(text, [
      { index: prefix.length, length: 9, type: "user", isSelf: true },
    ])).toBe("สวัสดี Aadhu.Sr");
  });

  it("returns the trimmed text when there are no mentionees", () => {
    expect(stripMentions("  Aadhu.Sr  ", [])).toBe("Aadhu.Sr");
  });

  it("skips ranges that are malformed or out of bounds rather than corrupting the text", () => {
    const text = "@BeGifted Aadhu.Sr";
    expect(stripMentions(text, [{ index: -1, length: 9 }])).toBe(text);
    expect(stripMentions(text, [{ index: 0, length: 999 }])).toBe(text);
    expect(stripMentions(text, [{ index: 5, length: 0 }])).toBe(text);
    expect(stripMentions(text, [{}])).toBe(text);
  });

  it("collapses the whitespace a removed mention leaves behind", () => {
    expect(stripMentions("@BeGifted   Aadhu.Sr   2026-09", [
      { index: 0, length: 9, type: "user", isSelf: true },
    ])).toBe("Aadhu.Sr 2026-09");
  });
});
