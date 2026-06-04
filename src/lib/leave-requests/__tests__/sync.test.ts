import { describe, expect, it } from "vitest";
import { selectLeaveRequestsConnectedEmail } from "../sync";

const WRITE_SCOPE = "https://www.googleapis.com/auth/spreadsheets";
const READ_SCOPE = "https://www.googleapis.com/auth/spreadsheets.readonly";
const NOW = new Date("2026-06-02T04:00:00.000Z");

function token(
  email: string,
  overrides: Partial<Parameters<typeof selectLeaveRequestsConnectedEmail>[0]["tokenRows"][number]> = {},
): Parameters<typeof selectLeaveRequestsConnectedEmail>[0]["tokenRows"][number] {
  return {
    email,
    scope: WRITE_SCOPE,
    accessTokenCiphertext: "access-token",
    refreshTokenCiphertext: "refresh-token",
    expiresAt: new Date("2026-06-02T05:00:00.000Z"),
    lastError: null,
    ...overrides,
  };
}

describe("selectLeaveRequestsConnectedEmail", () => {
  it("uses the configured connected email when it is set", () => {
    expect(selectLeaveRequestsConnectedEmail({
      configuredEmail: "Configured@Example.com",
      tokenRows: [
        token("other@example.com"),
      ],
      now: NOW,
    })).toBe("configured@example.com");
  });

  it("skips revoked or expired token rows", () => {
    expect(selectLeaveRequestsConnectedEmail({
      tokenRows: [
        token("revoked@example.com", { lastError: "Token has been expired or revoked." }),
        token("healthy@example.com", { scope: READ_SCOPE }),
      ],
      now: NOW,
    })).toBe("healthy@example.com");
  });

  it("prefers a healthy write-scoped token over a read-only token", () => {
    expect(selectLeaveRequestsConnectedEmail({
      tokenRows: [
        token("readonly@example.com", { scope: READ_SCOPE }),
        token("writer@example.com", { scope: WRITE_SCOPE }),
      ],
      now: NOW,
    })).toBe("writer@example.com");
  });

  it("returns null when no healthy token is available", () => {
    expect(selectLeaveRequestsConnectedEmail({
      tokenRows: [
        token("revoked@example.com", { lastError: "invalid_grant" }),
        token("missing-token@example.com", { accessTokenCiphertext: null }),
      ],
      now: NOW,
    })).toBeNull();
  });
});
