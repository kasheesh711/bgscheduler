import { describe, expect, it } from "vitest";
import { newReceiptChallenge, checkReceiptChallenge } from "../receipt-evidence";
const now = new Date("2026-10-01T14:00:00Z");
describe("delivery receipt challenges", () => {
  it("requires a provider receipt and a code from the receiving inbox", () => {
    const { code, evidence } = newReceiptChallenge("manager@example.com", "revision-1", now);
    expect(evidence.hash).not.toContain(code);
    expect(checkReceiptChallenge(evidence, code, "manager@example.com", "revision-1", now).confirmedAt).toBeUndefined();
    const accepted = { ...evidence, receipt: "accepted-id", acceptedAt: now.toISOString() };
    expect(checkReceiptChallenge(accepted, code, "manager@example.com", "revision-1", now).confirmedAt).toBe(now.toISOString());
  });
  it("rejects changed connection, wrong manager, expired challenge and too many guesses", () => {
    const { code, evidence } = newReceiptChallenge("manager@example.com", "revision-1", now);
    const accepted = { ...evidence, receipt: "accepted-id", acceptedAt: now.toISOString() };
    for (const [actor, binding, at, tries] of [
      ["other@example.com", "revision-1", now, 0], ["manager@example.com", "revision-2", now, 0],
      ["manager@example.com", "revision-1", new Date(now.getTime() + 86_400_001), 0],
      ["manager@example.com", "revision-1", now, 5],
    ] as const) expect(checkReceiptChallenge({ ...accepted, attempts: tries }, code, actor, binding, at).confirmedAt).toBeUndefined();
    expect(checkReceiptChallenge(accepted, "wrong", "manager@example.com", "revision-1", now).attempts).toBe(1);
  });
});
