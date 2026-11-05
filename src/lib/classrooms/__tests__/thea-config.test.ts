import { afterEach, describe, expect, it, vi } from "vitest";
import { hashTheaToken, isTheaCommand, theaEnabled, theaLinkExpiry, theaToken } from "../thea-config";
import { weekendDates } from "../weekend-config";

afterEach(() => vi.unstubAllEnvs());
describe("Thea command and expiring capabilities", () => {
  it("accepts both spellings, but cannot act without the exact group and explicit switch", () => {
    expect(isTheaCommand(" /จัดตะราง ")).toBe(true);
    expect(isTheaCommand("/จัดตาราง")).toBe(true);
    expect(isTheaCommand("/จัดตาราง tomorrow")).toBe(false);
    vi.stubEnv("THEA_WEEKEND_COMMANDS_ENABLED", "true");
    vi.stubEnv("THEA_LINE_GROUP_ID", "BG The Loop");
    expect(theaEnabled()).toBe(false);
    vi.stubEnv("THEA_LINE_GROUP_ID", `C${"a".repeat(32)}`);
    expect(theaEnabled()).toBe(true);
    vi.stubEnv("THEA_WEEKEND_COMMANDS_ENABLED", "false");
    expect(theaEnabled()).toBe(false);
  });
  it("keeps Sunday in the current weekend, rolls over Monday, and expires after Monday Bangkok", () => {
    expect(weekendDates(new Date("2026-11-08T16:59:59Z"))).toEqual(["2026-11-07", "2026-11-08"]);
    expect(weekendDates(new Date("2026-11-08T17:00:00Z"))).toEqual(["2026-11-14", "2026-11-15"]);
    expect(theaLinkExpiry("2026-11-07").toISOString()).toBe("2026-11-09T17:00:00.000Z");
  });
  it("reconstructs only keyed, request-specific tokens for retry-safe delivery", () => {
    vi.stubEnv("AUTH_SECRET", "a".repeat(32));
    const first = theaToken("one");
    expect(first).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(theaToken("one")).toBe(first);
    expect(theaToken("two")).not.toBe(first);
    expect(hashTheaToken(first)).toHaveLength(64);
    vi.stubEnv("AUTH_SECRET", "b".repeat(32));
    expect(theaToken("one")).not.toBe(first);
    vi.stubEnv("AUTH_SECRET", "");
    expect(() => theaToken("one")).toThrow();
  });
});
