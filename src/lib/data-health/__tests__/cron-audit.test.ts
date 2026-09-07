import { describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));
vi.mock("@/lib/db", () => ({ getDb: vi.fn() }));

import { getDb } from "@/lib/db";
import { buildResponseDigest, withCronInvocationAudit } from "../cron-audit";

it.each([true, false])("keeps partial syncs visible to alerts despite HTTP 200 (success=%s)", async success => {
  const updates: Record<string, unknown>[] = [];
  vi.mocked(getDb).mockReturnValue({
    insert: () => ({ values: () => ({ returning: async () => [{ id: "invocation-1" }] }) }),
    update: () => ({ set: (value: Record<string, unknown>) => { updates.push(value); return { where: async () => [] }; } }),
  } as never);
  const response = await withCronInvocationAudit({ jobKey: "wise_snapshot", triggerSource: "admin" }, async () => Response.json({
    success, outcome: "partial", promotedSnapshotId: "snapshot-1", errorSummary: "Teacher contact needs review",
  }));
  expect(response.status).toBe(200);
  expect(updates).toEqual([expect.objectContaining({ outcome: "failed", responseStatus: 200, errorSummary: "Teacher contact needs review" })]);
});

describe("buildResponseDigest", () => {
  it("keeps top-level scalars verbatim", () => {
    expect(
      buildResponseDigest({
        ok: true,
        insertedCount: 42,
        stoppedReason: "known_events",
        errorSummary: null,
      }),
    ).toEqual({
      ok: true,
      insertedCount: 42,
      stoppedReason: "known_events",
      errorSummary: null,
    });
  });

  it("truncates long strings to 200 characters plus an ellipsis", () => {
    const digest = buildResponseDigest({ errorSummary: "x".repeat(5_000) });

    expect(digest.errorSummary).toBe(`${"x".repeat(200)}...`);
  });

  it("collapses arrays and objects to their size", () => {
    const digest = buildResponseDigest({
      results: [1, 2, 3, 4],
      result: { syncRunId: "run-1", teacherCount: 131 },
    });

    expect(digest).toEqual({
      results: { arrayLength: 4 },
      result: { keyCount: 2 },
    });
  });

  it("returns an empty digest for a non-object body", () => {
    expect(buildResponseDigest(null)).toEqual({});
    expect(buildResponseDigest("plain text")).toEqual({});
    expect(buildResponseDigest([1, 2, 3])).toEqual({});
  });

  it("caps the serialized digest at 2 KB, marking it truncated", () => {
    // 400 scalar keys blow past 2 KB even after per-string truncation.
    const wide = Object.fromEntries(
      Array.from({ length: 400 }, (_, index) => [`field_${index}`, index]),
    );

    const digest = buildResponseDigest(wide);

    expect(digest.truncated).toBe(true);
    expect(Buffer.byteLength(JSON.stringify(digest), "utf8")).toBeLessThanOrEqual(2_048);
    expect(Object.keys(digest).length).toBeLessThan(400);
  });

  it("leaves a body that already fits untouched by the cap", () => {
    const digest = buildResponseDigest({ ok: true, count: 1 });

    expect(digest).not.toHaveProperty("truncated");
  });
});
