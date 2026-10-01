import { describe, expect, it } from "vitest";
import { captureJson, captureRequest, captureError } from "../http";
import { CaptureError } from "../model";
describe("capture request boundary", () => {
  const request = (body: string, origin = "https://example.invalid") => new Request("https://example.invalid/api/class-capture", { method: "POST", headers: { origin, "content-type": "application/json" }, body });
  it("rejects cross-origin mutations and bounded streaming JSON", async () => {
    await expect(captureRequest(request("{}", "https://other.invalid"))).rejects.toThrow("origin");
    await expect(captureRequest(request(JSON.stringify({ text: "x".repeat(70000) })))).rejects.toThrow("large");
    expect(await captureRequest(request('{"topic":"fractions"}'))).toEqual({ topic: "fractions" });
  });
  it("never caches evidence or returns an unknown private provider error", async () => {
    expect(captureJson({ ok: true }).headers.get("cache-control")).toContain("no-store");
    const response = captureError(new CaptureError(409, "Retry the upload."));
    expect(response.status).toBe(409);
    expect(await response.json()).toEqual({ error: "Retry the upload." });
  });
});
