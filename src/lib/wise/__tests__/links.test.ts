import { describe, expect, it } from "vitest";
import { wiseSessionLink } from "../links";

describe("wiseSessionLink", () => {
  it("builds the Wise web-app deep link for a session", () => {
    expect(wiseSessionLink({
      wiseClassId: "6a8ecec94b0b7ea1c9559586",
      wiseSessionId: "6aba47d069f1f327513ac027",
    })).toBe("https://learn.begiftededucation.com/links?type=classroom_entity&entityType=session&entityId=6aba47d069f1f327513ac027&classId=6a8ecec94b0b7ea1c9559586&profile=teacher");
  });

  it("encodes unexpected characters in ids", () => {
    const url = new URL(wiseSessionLink({ wiseClassId: "a&b", wiseSessionId: "c d" }));
    expect(url.searchParams.get("classId")).toBe("a&b");
    expect(url.searchParams.get("entityId")).toBe("c d");
  });
});
