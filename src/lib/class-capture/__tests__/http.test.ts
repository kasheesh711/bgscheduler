import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { getTableName } from "drizzle-orm";
const mocks = vi.hoisted(() => ({ auth: vi.fn(), db: vi.fn(), work: vi.fn() }));
vi.mock("@/lib/auth", () => ({ auth: mocks.auth }));
vi.mock("@/lib/db", () => ({ getDb: mocks.db }));
vi.mock("../store", () => ({ createCapture: mocks.work, captureForScope: mocks.work, captureView: mocks.work,
  updateCapture: mocks.work, createAsset: mocks.work, markDeleted: mocks.work, assetForScope: mocks.work, discardAsset: mocks.work }));
vi.mock("../files", () => ({ uploadHandler: mocks.work, finalizeAsset: mocks.work, readMediaBytes: mocks.work }));
vi.mock("../processing", () => ({ transcribeCapture: mocks.work, draftCapture: mocks.work }));
vi.mock("../cleanup", () => ({ cleanupCapture: mocks.work }));
import { captureJson, captureRequest, captureError } from "../http";
import { CaptureError } from "../model";
import * as handlers from "../handlers";

beforeEach(() => {
  vi.resetAllMocks();
  vi.stubEnv("ENABLE_CLASS_CAPTURE", "true");
  vi.stubEnv("CLASS_CAPTURE_RETENTION_ENABLED", "true");
  vi.stubEnv("CLASS_CAPTURE_PROCESSING_APPROVED", "true");
  vi.stubEnv("CLASS_CAPTURE_PILOT_EMAILS", "owner@example.test,first-tutor@example.test,second-tutor@example.test");
  vi.stubEnv("CLASS_CAPTURE_PILOT_EMAIL", undefined);
  vi.stubEnv("SUPER_ADMIN_EMAILS", undefined);
  mocks.db.mockImplementation(() => { throw new Error("Unexpected database access before pilot authorization"); });
  vi.spyOn(console, "error").mockImplementation(() => undefined);
});
afterEach(() => { vi.unstubAllEnvs(); vi.restoreAllMocks(); });
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

function accessDatabase(admins: unknown[] = [], contacts: unknown[] = []) {
  const tables: string[] = [];
  mocks.db.mockReturnValue({ select: () => {
    let rows: unknown[] = [];
    const chain = {
      from: (table: Parameters<typeof getTableName>[0]) => {
        const name = getTableName(table); tables.push(name);
        if (name === "admin_users") rows = admins;
        else if (name === "tutor_contacts") rows = contacts;
        else throw new Error("Unexpected session data query");
        return chain;
      },
      where: () => chain, limit: () => chain,
      then: (resolve: (value: unknown[]) => unknown) => Promise.resolve(rows).then(resolve),
    };
    return chain;
  } });
  return tables;
}

describe("tutor pilot gate at every capture HTTP entry point", () => {
  const id = "11111111-1111-4111-8111-111111111111";
  const assetId = "22222222-2222-4222-8222-222222222222";
  const context = { params: Promise.resolve({ id }) };
  const assetContext = { params: Promise.resolve({ id, assetId }) };
  const request = () => new Request(`https://example.invalid/api/class-capture/${id}`, {
    method: "POST", headers: { origin: "https://example.invalid", "content-type": "application/json" }, body: "{}",
  });
  const routes = [
    { name: "session list", run: () => handlers.list(request()) },
    { name: "capture creation", run: () => handlers.create(request()) },
    { name: "capture read", run: () => handlers.read(request(), context) },
    { name: "capture edit", run: () => handlers.patch(request(), context) },
    { name: "capture deletion", run: () => handlers.remove(request(), context) },
    { name: "upload intent", run: () => handlers.addAsset(request(), context) },
    { name: "upload token", run: () => handlers.upload(request()) },
    { name: "upload finalization", run: () => handlers.finalize(request(), assetContext) },
    { name: "private media", run: () => handlers.media(request(), assetContext) },
    { name: "asset deletion", run: () => handlers.removeAsset(request(), assetContext) },
    { name: "paid transcription", run: () => handlers.transcribe(request(), context) },
    { name: "paid draft", run: () => handlers.draft(request(), context) },
  ];
  describe.each([
    { actor: "nonpilot teacher", email: "nonpilot@example.test", role: "teacher" },
    { actor: "unrestricted admin", email: "admin@example.test", role: "admin" },
    { actor: "another designated owner", email: "other-owner@example.test", role: "admin" },
  ])("$actor", ({ email, role }) => {
    it.each(routes)("denies $name before session data, private storage or paid work", async ({ run }) => {
      mocks.auth.mockResolvedValue({ user: { email, role, adminAccessVersion: 3, allowedPages: null } });
      const response = await run();
      expect(response.status).toBe(403);
      expect(response.headers.get("cache-control")).toContain("no-store");
      expect(mocks.db).not.toHaveBeenCalled();
      expect(mocks.work).not.toHaveBeenCalled();
    });
  });

  describe.each([
    { actor: "unbound teacher pilot", role: "teacher", admins: [], contacts: [] },
    { actor: "ambiguous tutor pilot", role: "teacher", admins: [], contacts: [
      { active: true, canonicalKey: "First Tutor", onsiteEmail: "owner@example.test" },
      { active: true, canonicalKey: "Other Tutor", onsiteEmail: "owner@example.test" },
    ] },
    { actor: "teacher with a conflicting admin row", role: "teacher", admins: [{ disabled: false, accessVersion: 3, allowedPages: null }], contacts: [] },
    { actor: "revoked admin pilot", role: "admin", admins: [{ disabled: true, accessVersion: 3, allowedPages: null }], contacts: [] },
    { actor: "deleted admin pilot", role: "admin", admins: [], contacts: [] },
    { actor: "stale admin session", role: "admin", admins: [{ disabled: false, accessVersion: 4, allowedPages: null }], contacts: [] },
  ])("$actor", ({ role, admins, contacts }) => {
    it.each(routes)("denies $name before class data, private storage or paid work", async ({ run }) => {
      mocks.auth.mockResolvedValue({ user: { email: "owner@example.test", role, adminAccessVersion: 3, allowedPages: null } });
      const tables = accessDatabase(admins, contacts);
      expect((await run()).status).toBe(403);
      expect(tables.every(name => name === "admin_users" || name === "tutor_contacts")).toBe(true);
      expect(mocks.work).not.toHaveBeenCalled();
    });
  });

  it.each([
    { email: "owner@example.test", role: "admin", key: "Admin Tutor" },
    { email: "first-tutor@example.test", role: "teacher", key: "First Tutor" },
    { email: "second-tutor@example.test", role: "teacher", key: "Second Tutor" },
  ])("passes only $key to storage for authorized $role recovery", async ({ email, role, key }) => {
    mocks.auth.mockResolvedValue({ user: { email, role, adminAccessVersion: role === "admin" ? 3 : undefined, allowedPages: ["/progress-tests"] } });
    accessDatabase(role === "admin" ? [{ disabled: false, accessVersion: 3, allowedPages: null }] : [],
      [{ active: true, canonicalKey: key, onsiteEmail: email }]);
    expect((await handlers.remove(request(), context)).status).toBe(200);
    expect(mocks.work).toHaveBeenNthCalledWith(1, { email, keys: [key] }, id);
  });

  it.each(["", "2026-09-30", "2026-10-02", "not-a-date"])("rejects tampered list date %j without querying session data", async date => {
    vi.useFakeTimers(); vi.setSystemTime("2026-10-01T04:30:00Z");
    try {
      mocks.auth.mockResolvedValue({ user: { email: "first-tutor@example.test", role: "teacher", allowedPages: ["/progress-tests"] } });
      const tables = accessDatabase([], [{ active: true, canonicalKey: "First Tutor", onsiteEmail: "first-tutor@example.test" }]);
      const response = await handlers.list(new Request(`https://example.invalid/api/class-capture/sessions?date=${date}`));
      expect(response.status).toBe(400);
      expect(tables).toEqual(["admin_users", "tutor_contacts"]);
      expect(mocks.work).not.toHaveBeenCalled();
    } finally { vi.useRealTimers(); }
  });

  it("fails unavailable when a configured pilot's fresh access lookup fails", async () => {
    mocks.auth.mockResolvedValue({ user: { email: "owner@example.test", role: "admin", adminAccessVersion: 3 } });
    const response = await handlers.read(request(), context);
    expect(response.status).toBe(503);
    expect(mocks.work).not.toHaveBeenCalled();
    expect(await response.text()).not.toContain("Unexpected database");
  });
});
