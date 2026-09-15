import { describe, expect, it, vi } from "vitest";
import { attendanceError, attendanceRequest } from "../http";
import { AttendanceError, punchSchema } from "../model";
import { storeGoogleOAuthTokenForUser } from "@/lib/sales-dashboard/google-oauth";
vi.mock("next/cache", () => ({ revalidateTag: vi.fn() }));

describe("attendance HTTP boundaries", () => {
  const request = (
    origin: string | null,
    body = "{}",
    type = "application/json",
  ) =>
    new Request("https://example.test/api/tutor-attendance/punch", {
      method: "POST",
      body,
      headers: { "content-type": type, ...(origin ? { origin } : {}) },
    });
  it("accepts same-origin JSON and rejects cross-origin, missing origin and oversized requests", async () => {
    await expect(
      attendanceRequest(request("https://example.test", '{"kind":"in"}')),
    ).resolves.toEqual({ kind: "in" });
    for (const origin of [null, "https://other.test"])
      await expect(attendanceRequest(request(origin))).rejects.toMatchObject({
        status: 403,
      });
    await expect(
      attendanceRequest(request("https://example.test", "invalid")),
    ).rejects.toMatchObject({ status: 400 });
    await expect(
      attendanceRequest(
        request("https://example.test", '"' + "x".repeat(16000) + '"'),
      ),
    ).rejects.toMatchObject({ status: 413 });
    await expect(
      attendanceRequest(request("https://example.test", "{}", "text/plain")),
    ).rejects.toMatchObject({ status: 415 });
  });
  it("rejects client-supplied time and network evidence", () => {
    expect(
      punchSchema.safeParse({
        kind: "in",
        date: "2026-09-15",
        idempotencyKey: crypto.randomUUID(),
        timestamp: "2026-09-15T03:00:00Z",
        ip: "8.8.8.8",
      }).success,
    ).toBe(false);
  });
  it("returns private errors without exposing database details", async () => {
    const log = vi.spyOn(console, "error").mockImplementation(() => undefined);
    const result = attendanceError(new Error("private database details"));
    expect(result.status).toBe(500);
    expect(result.headers.get("cache-control")).toBe("private, no-store");
    expect(JSON.stringify(await result.json())).not.toContain(
      "database details",
    );
    expect(attendanceError(new AttendanceError(403, "Denied")).status).toBe(
      403,
    );
    log.mockRestore();
  });
});
describe("attendance Google identity-only login", () => {
  it.each(["openid email profile", undefined, ""])(
    "does not read or overwrite integration tokens with scope %s",
    async (scope) => {
      const db = { select: vi.fn(), insert: vi.fn() };
      await storeGoogleOAuthTokenForUser(
        "admin@example.test",
        { provider: "google", access_token: "identity-token", scope },
        db as never,
      );
      expect(db.select).not.toHaveBeenCalled();
      expect(db.insert).not.toHaveBeenCalled();
    },
  );
});
