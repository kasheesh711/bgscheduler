import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { CaptureError } from "../model";
const mocks = vi.hoisted(() => ({ scope: vi.fn(), current: vi.fn(), record: vi.fn(), view: vi.fn(), action: vi.fn(), kick: vi.fn(), after: vi.fn() }));
vi.mock("next/server", async original => ({ ...await original<typeof import("next/server")>(), after: mocks.after }));
vi.mock("../sessions", () => ({ requireCaptureScope: mocks.scope, assertCaptureSessionCurrent: mocks.current }));
vi.mock("../store", () => ({ captureForScope: mocks.record, captureView: mocks.view }));
vi.mock("../automatic", () => ({ automaticAction: mocks.action, kickAutomaticCapture: mocks.kick }));
import { processCapture } from "../automatic-handler";
const id = "11111111-1111-4111-8111-111111111111";
const scope = { email: "synthetic@example.invalid", keys: ["tutor"] };
const context = { params: Promise.resolve({ id }) };
const request = (origin = "https://example.invalid") => new Request(`https://example.invalid/api/class-capture/${id}/process`, { method: "POST", headers: { origin, "content-type": "application/json" }, body: JSON.stringify({ action: "consent" }) });
beforeEach(() => {
  vi.resetAllMocks(); vi.stubEnv("ENABLE_CLASS_CAPTURE", "true"); vi.stubEnv("CLASS_CAPTURE_RETENTION_ENABLED", "true");
  mocks.scope.mockResolvedValue(scope); mocks.record.mockResolvedValue({ session: {} }); mocks.view.mockResolvedValue({ id });
});
afterEach(() => vi.unstubAllEnvs());
describe("automatic processing endpoint", () => {
  it("authorizes, persists the action, and starts background work after the response", async () => {
    const response = await processCapture(request(), context); expect(response.status).toBe(200);
    expect(mocks.action).toHaveBeenCalledWith(scope, id, { action: "consent" }); expect(mocks.after).toHaveBeenCalledTimes(1);
    expect(mocks.kick).not.toHaveBeenCalled(); await mocks.after.mock.calls[0][0](); expect(mocks.kick).toHaveBeenCalledWith(id);
    expect(response.headers.get("cache-control")).toContain("no-store");
  });
  it.each(["scope", "record", "current"] as const)("fails closed at the %s boundary before mutation", async boundary => {
    mocks[boundary].mockRejectedValue(new CaptureError(403, "Access changed"));
    expect((await processCapture(request(), context)).status).toBe(403); expect(mocks.action).not.toHaveBeenCalled(); expect(mocks.after).not.toHaveBeenCalled();
  });
  it("rejects cross-origin actions and disabled retention", async () => {
    expect((await processCapture(request("https://other.invalid"), context)).status).toBe(403);
    vi.stubEnv("CLASS_CAPTURE_RETENTION_ENABLED", "false"); expect((await processCapture(request(), context)).status).toBe(503);
    expect(mocks.action).not.toHaveBeenCalled();
  });
});
