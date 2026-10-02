import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Database } from "@/lib/db";
import { assetForScope, captureForScope, captureView, createAsset, createCapture, discardAsset, markDeleted, updateCapture } from "../store";
import type { CaptureScope, CaptureSession } from "../model";

const id = "11111111-1111-4111-8111-111111111111";
const assetId = "22222222-2222-4222-8222-222222222222";
const scope = { email: "pilot@example.test", keys: ["Own Tutor"] };
const session: CaptureSession = { sessionId: "class-session", classId: "class", studentId: "student", studentName: "Synthetic Student", teacherKey: "Own Tutor", teacherName: "Own Tutor", title: "Onsite maths", startTime: "2026-10-01T10:00:00Z", endTime: "2026-10-01T11:00:00Z", wiseUrl: "https://example.invalid/class" };
const input = { id, sessionId: session.sessionId, studentId: session.studentId, topic: "Fractions", consent: { participants: true as const, guardian: "confirmed" as const, processing: true as const } };
const asset = { id: assetId, kind: "recording" as const, mime: "audio/webm" as const, size: 8 };
const edit = { version: 0, topic: "Fractions", tutorNotes: "Synthetic notes" };

beforeEach(() => { vi.useFakeTimers(); vi.setSystemTime("2026-10-01T16:59:59Z"); });
afterEach(() => vi.useRealTimers());

describe("strict storage scope before private work", () => {
  const operations = [
    { name: "capture read", run: (s: CaptureScope, db: Database) => captureForScope(s, id, db) },
    { name: "capture view", run: (s: CaptureScope, db: Database) => captureView(s, id, db) },
    { name: "capture create", run: (s: CaptureScope, db: Database) => createCapture(s, input, session, db) },
    { name: "capture edit", run: (s: CaptureScope, db: Database) => updateCapture(s, id, edit, db) },
    { name: "capture delete", run: (s: CaptureScope, db: Database) => markDeleted(s, id, db) },
    { name: "asset create", run: (s: CaptureScope, db: Database) => createAsset(s, id, asset, db) },
    { name: "asset/media read", run: (s: CaptureScope, db: Database) => assetForScope(s, assetId, db) },
    { name: "asset delete", run: (s: CaptureScope, db: Database) => discardAsset(s, id, assetId, db) },
  ];
  describe.each([
    { email: scope.email, keys: null }, { email: scope.email, keys: undefined },
    { email: scope.email, keys: [] }, { email: scope.email, keys: ["Own Tutor", "Other Tutor"] },
    { email: scope.email, keys: [""] }, { email: scope.email, keys: [" "] },
    { email: scope.email, keys: [7] }, { email: scope.email, keys: "Own Tutor" },
    { email: "", keys: scope.keys }, { email: "PILOT@EXAMPLE.TEST", keys: scope.keys },
  ])("malformed scope $email / $keys", invalid => {
    it.each(operations)("denies $name before any query or lock", async ({ run }) => {
      const query = vi.fn(() => { throw new Error("Private work must not run"); });
      const db = { select: query, transaction: query, execute: query, update: query } as unknown as Database;
      await expect(run(invalid as CaptureScope, db)).rejects.toMatchObject({ status: 403 });
      expect(query).not.toHaveBeenCalled();
    });
  });

  it("rejects a new capture if a slow transaction crosses Bangkok midnight", async () => {
    const insert = vi.fn();
    let reads = 0;
    const tx = { execute: vi.fn(async () => undefined), insert, select: () => {
      const chain = { from: () => chain, where: () => chain, then: (resolve: (rows: never[]) => unknown) => {
        if (++reads === 2) vi.setSystemTime("2026-10-01T17:00:00Z");
        return Promise.resolve([]).then(resolve);
      } };
      return chain;
    } };
    const db = { transaction: (callback: (db: typeof tx) => unknown) => callback(tx) } as unknown as Database;
    await expect(createCapture(scope, input, session, db)).rejects.toMatchObject({ status: 400 });
    expect(insert).not.toHaveBeenCalled();
  });
});
