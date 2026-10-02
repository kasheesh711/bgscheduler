import { describe, expect, it } from "vitest";
import { withAtomTimeout } from "../atom/deadline";
import { AtomCollectionError } from "../atom/normalize";

describe("withAtomTimeout", () => {
  it("returns the result when the work finishes in time", async () => {
    await expect(withAtomTimeout(Promise.resolve(7), 1_000, "stage")).resolves.toBe(7);
  });
  it("passes through the work's own failure", async () => {
    await expect(withAtomTimeout(Promise.reject(new Error("own")), 1_000, "stage")).rejects.toThrow("own");
  });
  it("throws a labelled collection failure when the work never settles", async () => {
    const error = await withAtomTimeout(new Promise(() => undefined), 20, "catalog_responses").catch(e => e);
    expect(error).toBeInstanceOf(AtomCollectionError);
    expect(error).toMatchObject({ code: "collection_failed", stage: "catalog_responses" });
  });
  it("fails at once when no time is left", async () => {
    await expect(withAtomTimeout(new Promise(() => undefined), -5, "run_deadline")).rejects.toMatchObject({ stage: "run_deadline" });
  });
});
