import { describe, expect, it } from "vitest";
import { LocalRecovery, type RecoveryBackend, type RecoveryRecord } from "../local-recovery";

function memoryBackend(): RecoveryBackend {
  const records = new Map<string, RecoveryRecord>();
  const chunks = new Map<string, Blob[]>();
  return {
    list: async () => [...records.values()],
    get: async (key) => records.get(key) ?? null,
    create: async (record) => { records.set(record.key, record); chunks.set(record.key, []); },
    append: async (key, blob) => {
      const record = records.get(key)!;
      records.set(key, { ...record, size: record.size + blob.size, mime: blob.type || record.mime });
      chunks.get(key)!.push(blob);
    },
    finish: async (key) => { records.set(key, { ...records.get(key)!, complete: true }); },
    chunks: async (key) => chunks.get(key) ?? [],
    remove: async (key) => { records.delete(key); chunks.delete(key); },
  };
}

const input = { captureId: "capture-1", assetId: "asset-1", kind: "recording" as const, name: "Class audio", mime: "audio/webm" };

describe("local recording recovery", () => {
  it("recovers ordered chunks only for the signed-in owner", async () => {
    const recovery = new LocalRecovery(memoryBackend(), () => 1_000);
    await recovery.create(" Tutor@Example.test ", input);
    await recovery.append("tutor@example.test", "asset-1", new Blob(["first"], { type: "audio/webm" }));
    await recovery.append("tutor@example.test", "asset-1", new Blob(["last"], { type: "audio/webm" }));
    await recovery.finish("tutor@example.test", "asset-1");
    expect(await (await recovery.load("tutor@example.test", "asset-1"))?.blob.text()).toBe("firstlast");
    expect(await recovery.load("another@example.test", "asset-1")).toBeNull();
  });

  it("purges expired recordings and another login's copies when loading recovery", async () => {
    let now = 0;
    const recovery = new LocalRecovery(memoryBackend(), () => now);
    await recovery.create("first@example.test", input);
    expect(await recovery.list("second@example.test")).toEqual([]);
    expect(await recovery.load("first@example.test", "asset-1")).toBeNull();
    await recovery.create("second@example.test", input);
    now = 24 * 60 * 60 * 1_000 + 1;
    expect(await recovery.list("second@example.test")).toEqual([]);
  });

  it("refuses empty owner identities and chunks above the allowed limit", async () => {
    const recovery = new LocalRecovery(memoryBackend(), () => 1_000);
    await expect(recovery.create("", input)).rejects.toThrow(/owner/i);
    await recovery.create("tutor@example.test", { ...input, kind: "worksheet", mime: "image/png" });
    await expect(recovery.append("tutor@example.test", "asset-1", new Blob([new Uint8Array(8 * 1024 * 1024 + 1)]))).rejects.toThrow(/limit/i);
  });

  it("removes every local asset when a capture is discarded", async () => {
    const recovery = new LocalRecovery(memoryBackend(), () => 1_000);
    await recovery.create("tutor@example.test", input);
    await recovery.create("tutor@example.test", { ...input, assetId: "asset-2" });
    await recovery.deleteCapture("tutor@example.test", "capture-1");
    expect(await recovery.list("tutor@example.test")).toEqual([]);
  });
});
