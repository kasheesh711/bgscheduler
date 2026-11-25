import { describe, expect, it } from "vitest";
import { OFFER_LETTERS } from "../offer-letters";

describe("OFFER_LETTERS", () => {
  // Gift's sign-off shows the stored letter's third paragraph as the terms beside Approve (final-review.tsx).
  it("puts each letter's terms in its third paragraph", () => {
    for (const letter of Object.values(OFFER_LETTERS))
      expect(letter.text("Ann Example", "Physics").split(/\n\s*\n/)[2]).toBe(letter.terms);
  });
});
