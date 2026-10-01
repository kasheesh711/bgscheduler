import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
vi.mock("@/lib/sales-dashboard/google-oauth", () => ({ getGoogleSheetsAccessToken: vi.fn() }));
import { getGoogleSheetsAccessToken } from "@/lib/sales-dashboard/google-oauth";
import { startTestDb, stopTestDb, truncateAll } from "@/tests/integration/db-helper";
import type { Database } from "@/lib/db";
import { loadTerminationSnapshot, syncTerminationSource } from "../termination-sync";

let handle: Awaited<ReturnType<typeof startTestDb>>;
let db: Database;
const NOW = new Date("2026-10-01T05:00:00Z");
const headers = ["Tutor Full Name", "Wise Tutor", "Tutor Nickname", "Tutor email", "Tutor email 2"];
function source(terminated = true) {
  return { sheets: [{ properties: { sheetId: 470328060, title: "Tutors" }, data: [{ startColumn: 3, rowData: [
    { values: headers.map((formattedValue) => ({ formattedValue })) },
    { values: ["Aria Smith", "Aria (Ari) Smith", "Ari", "aria@example.com", ""].map((formattedValue) => ({ formattedValue, effectiveFormat: { textFormat: { strikethrough: terminated } } })) },
  ] }] }] };
}
function mockSource(terminated = true) {
  vi.stubGlobal("fetch", vi.fn()
    .mockResolvedValueOnce({ ok: true, json: async () => ({ sheets: [{ properties: { sheetId: 470328060, title: "Tutors", gridProperties: { rowCount: 1060 } } }] }) })
    .mockResolvedValueOnce({ ok: true, json: async () => source(terminated) }));
}
beforeAll(async () => { handle = await startTestDb(); db = handle.db as unknown as Database; });
afterAll(async () => { vi.unstubAllGlobals(); if (handle) await stopTestDb(handle); });
beforeEach(async () => {
  await truncateAll(handle.db); vi.resetAllMocks(); vi.unstubAllGlobals();
  vi.mocked(getGoogleSheetsAccessToken).mockResolvedValue("example-token");
});

describe("termination source snapshots", () => {
  it("starts as not synced, persists a complete source read, then reflects unstriking", async () => {
    expect(await loadTerminationSnapshot(db)).toEqual({ rows: [], checkedAt: null, lastError: null });
    mockSource();
    expect(await syncTerminationSource("owner@example.com", NOW, db)).toEqual({ rows: 1, confirmed: 1 });
    // Compare identity without serializing the database connection into an assertion failure.
    expect(vi.mocked(getGoogleSheetsAccessToken).mock.calls[0]?.[1] === db).toBe(true);
    expect(await loadTerminationSnapshot(db)).toMatchObject({ checkedAt: NOW.toISOString(), lastError: null, rows: [{ sourceRow: 2, terminated: true }] });
    const requests = vi.mocked(fetch).mock.calls;
    expect(requests).toHaveLength(2);
    expect(requests.every(([, options]) => !options?.method || options.method === "GET")).toBe(true);
    expect(decodeURIComponent(String(requests[1][0]))).toContain("D1:H1060");
    mockSource(false);
    await syncTerminationSource("owner@example.com", new Date(NOW.getTime() + 1000), db);
    expect((await loadTerminationSnapshot(db)).rows[0].terminated).toBe(false);
  });
  it("retains good evidence on malformed source or a read failure and stores only safe errors", async () => {
    mockSource(); await syncTerminationSource("owner@example.com", NOW, db);
    vi.stubGlobal("fetch", vi.fn().mockRejectedValue(Object.assign(new Error("private query and params"), { code: "08006" })));
    expect(await syncTerminationSource("owner@example.com", new Date(NOW.getTime() + 1000), db)).toEqual({ error: "Error (08006)" });
    expect(await loadTerminationSnapshot(db)).toMatchObject({ checkedAt: NOW.toISOString(), lastError: "Error (08006)", rows: [{ terminated: true }] });
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue({ ok: true, json: async () => ({ sheets: [] }) }));
    await syncTerminationSource("owner@example.com", NOW, db);
    expect((await loadTerminationSnapshot(db)).rows[0].terminated).toBe(true);
  });
  it("does not call Google without a configured integration account", async () => {
    const fetcher = vi.fn(); vi.stubGlobal("fetch", fetcher);
    const result = await syncTerminationSource("", NOW, db);
    expect(result).toEqual({ error: "NotConfigured (no SQLSTATE)" });
    expect(fetcher).not.toHaveBeenCalled();
    expect((await loadTerminationSnapshot(db)).lastError).toBe("NotConfigured (no SQLSTATE)");
  });
});
