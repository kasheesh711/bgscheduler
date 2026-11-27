import { describe, expect, it } from "vitest";
import { ApiError, failure } from "../booking";

describe("failure (what a failed request says)", () => {
  it("shows the server's own refusal as it is", () => {
    expect(failure(new ApiError("That time was just taken."), "Could not confirm.")).toBe("That time was just taken.");
  });
  it("turns network errors, non-JSON replies and empty refusals into one sentence with the LINE way out", () => {
    for (const e of [new TypeError("Failed to fetch"), new SyntaxError("Unexpected token '<'"), new ApiError(""), "odd"])
      expect(failure(e, "Could not confirm.")).toBe("Could not confirm. Try again. Contact BeGifted on LINE: https://line.me/R/ti/p/@699fovgg");
  });
});
