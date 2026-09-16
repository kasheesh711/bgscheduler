import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { POST } from "./route";
import { EmailCodeLimitError, requestEmailCode } from "@/lib/auth/email-code";
vi.mock("@/lib/auth/email-code", () => ({
  requestEmailCode: vi.fn(), emailCodeSenderKeys: () => ["primary"],
  EmailCodeLimitError: class extends Error { constructor(public retryAfter: number) { super("Please wait before trying again."); } },
}));
const req = (body: unknown, origin = "https://test.local") => new Request("https://test.local/api/auth/email-code/request", { method: "POST", headers: { origin, "Content-Type": "application/json" }, body: JSON.stringify(body) });
beforeEach(() => { vi.clearAllMocks(); vi.stubEnv("AUTH_EMAIL_CODE_ENABLED", "true"); vi.stubEnv("PREVIEW_SANDBOX_ENABLED", "false"); vi.stubEnv("VERCEL_ENV", "production"); vi.mocked(requestEmailCode).mockResolvedValue({ challengeId: "00000000-0000-4000-8000-000000000001", binding: "a".repeat(43) }); });
afterEach(() => vi.unstubAllEnvs());
describe("email login request", () => {
  it("normalizes the email and binds the browser with an HttpOnly cookie", async () => {
    const response = await POST(req({ email: " Apivit.S@Hotmail.com " }));
    expect(response.status).toBe(202); expect(requestEmailCode).toHaveBeenCalledWith("apivit.s@hotmail.com", expect.any(Request));
    expect(response.headers.get("set-cookie")).toContain("HttpOnly"); expect(response.headers.get("set-cookie")).toContain("Secure");
    const data = await response.json(); expect(data).not.toHaveProperty("binding"); expect(data).not.toHaveProperty("code");
  });
  it("rejects cross-site, malformed and oversized requests", async () => {
    expect((await POST(req({ email: "a@example.test" }, "https://evil.example"))).status).toBe(403);
    expect((await POST(req({ email: "broken" }))).status).toBe(400);
    const large = req({ email: "a@example.test" }); large.headers.set("content-length", "9000"); expect((await POST(large)).status).toBe(413);
    expect(requestEmailCode).not.toHaveBeenCalled();
  });
  it("returns a retry time without replacing an existing browser binding", async () => {
    vi.mocked(requestEmailCode).mockRejectedValue(new EmailCodeLimitError(45));
    const response = await POST(req({ email: "a@example.test" })); expect(response.status).toBe(429);
    expect(response.headers.get("Retry-After")).toBe("45"); expect(response.headers.has("set-cookie")).toBe(false);
  });
  it("keeps previews and the disabled release unavailable", async () => {
    vi.stubEnv("VERCEL_ENV", "preview"); expect((await POST(req({ email: "a@example.test" }))).status).toBe(503);
    vi.stubEnv("VERCEL_ENV", "production"); vi.stubEnv("AUTH_EMAIL_CODE_ENABLED", "false"); expect((await POST(req({ email: "a@example.test" }))).status).toBe(503);
    expect(requestEmailCode).not.toHaveBeenCalled();
  });
});
