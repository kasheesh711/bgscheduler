import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { CaptureError } from "../model";
const mocks = vi.hoisted(() => ({ scope: vi.fn(), current: vi.fn(), record: vi.fn(), view: vi.fn(), deleted: vi.fn(), cleanup: vi.fn(), asset: vi.fn(), upload: vi.fn(), transcribe: vi.fn(), draft: vi.fn() }));
vi.mock("../sessions", () => ({ requireCaptureScope: mocks.scope, assertCaptureSessionCurrent: mocks.current, listCaptureSessions: vi.fn(), requireCaptureSession: vi.fn() }));
vi.mock("../store", () => ({ captureForScope: mocks.record, captureView: mocks.view, markDeleted: mocks.deleted, assetForScope: mocks.asset, createCapture: vi.fn(), createAsset: vi.fn(), updateCapture: vi.fn(), discardAsset: vi.fn() }));
vi.mock("../files", () => ({ uploadHandler: mocks.upload, finalizeAsset: vi.fn(), readMediaBytes: vi.fn() }));
vi.mock("../processing", () => ({ transcribeCapture: mocks.transcribe, draftCapture: mocks.draft }));
vi.mock("../cleanup", () => ({ cleanupCapture: mocks.cleanup }));
import { read, remove, transcribe, draft, upload } from "../handlers";

const id = "11111111-1111-4111-8111-111111111111";
const assetId = "22222222-2222-4222-8222-222222222222";
const scope = { email: "synthetic@example.invalid", keys: ["tutor"] };
const context = { params: Promise.resolve({ id }) };
const request = (method = "POST", body: unknown = {}) => new Request(`https://example.invalid/api/class-capture/${id}`, {
  method, headers: { origin: "https://example.invalid", "content-type": "application/json" }, body: JSON.stringify(body),
});
beforeEach(() => {
  vi.resetAllMocks();
  vi.stubEnv("ENABLE_CLASS_CAPTURE", "true"); vi.stubEnv("CLASS_CAPTURE_RETENTION_ENABLED", "true"); vi.stubEnv("BLOB_READ_WRITE_TOKEN", "synthetic");
  mocks.scope.mockResolvedValue(scope); mocks.record.mockResolvedValue({ session: { sessionId: "synthetic" } });
  mocks.view.mockResolvedValue({ id }); mocks.cleanup.mockResolvedValue({ purged: false });
  mocks.asset.mockResolvedValue({ id: assetId, captureId: id });
});
afterEach(() => vi.unstubAllEnvs());

describe("capture HTTP permission and recovery boundaries", () => {
  it("deletes without a JSON body even when capture is paused, and reports pending physical cleanup", async () => {
    vi.stubEnv("ENABLE_CLASS_CAPTURE", "false");
    const response = await remove(new Request(`https://example.invalid/api/class-capture/${id}`, { method: "DELETE", headers: { origin: "https://example.invalid" } }), context);
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ deleted: true, cleanupPending: true });
    expect(mocks.deleted).toHaveBeenCalledWith(scope, id);
    expect(mocks.current).not.toHaveBeenCalled();
    expect(response.headers.get("cache-control")).toContain("no-store");
  });
  it("denies cross-origin deletion before mutation", async () => {
    const response = await remove(new Request(`https://example.invalid/api/class-capture/${id}`, { method: "DELETE", headers: { origin: "https://attacker.invalid" } }), context);
    expect(response.status).toBe(403); expect(mocks.deleted).not.toHaveBeenCalled();
  });
  it("does not claim immediate cleanup when storage is unavailable", async () => {
    mocks.cleanup.mockRejectedValue(new Error("private storage unavailable"));
    expect(await (await remove(request("DELETE"), context)).json()).toEqual({ deleted: true, cleanupPending: true });
  });
  it("checks ownership and expiry before current-session lookup or reading content", async () => {
    mocks.record.mockRejectedValue(new CaptureError(404, "Capture not found."));
    expect((await read(new Request("https://example.invalid"), context)).status).toBe(404);
    expect(mocks.current).not.toHaveBeenCalled(); expect(mocks.view).not.toHaveBeenCalled();
  });
  it("denies known schedule changes before reading or starting a paid action", async () => {
    mocks.current.mockRejectedValue(new CaptureError(403, "The class changed."));
    expect((await read(new Request("https://example.invalid"), context)).status).toBe(403);
    expect((await transcribe(request("POST", { assetId }), context)).status).toBe(403);
    expect((await draft(request(), context)).status).toBe(403);
    expect(mocks.view).not.toHaveBeenCalled(); expect(mocks.transcribe).not.toHaveBeenCalled(); expect(mocks.draft).not.toHaveBeenCalled();
  });
  it("requires the independent retention gate for reads and processing", async () => {
    vi.stubEnv("CLASS_CAPTURE_RETENTION_ENABLED", "false");
    expect((await read(new Request("https://example.invalid"), context)).status).toBe(503);
    expect(mocks.record).not.toHaveBeenCalled();
  });
  it("revalidates the asset's current class before issuing an upload token", async () => {
    mocks.current.mockRejectedValue(new CaptureError(403, "The class changed."));
    const response = await upload(request("POST", { type: "blob.generate-client-token", payload: { pathname: `class-capture/${id}/${assetId}`, clientPayload: assetId, multipart: true } }));
    expect(response.status).toBe(403); expect(mocks.upload).not.toHaveBeenCalled();
  });
  it("authenticates before parsing a malformed processing request", async () => {
    mocks.scope.mockRejectedValue(new CaptureError(401, "Sign in."));
    const response = await transcribe(new Request("https://example.invalid", { method: "POST", body: "bad json" }), context);
    expect(response.status).toBe(401); expect(mocks.transcribe).not.toHaveBeenCalled();
  });
});
