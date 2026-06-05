import { describe, it, expect, vi } from "vitest";

// teacher-access imports @/lib/db (getDb) at module load; stub it so the test
// doesn't pull the real Neon driver. The function under test takes an explicit
// `db`, so we pass a chainable fake directly.
vi.mock("@/lib/db", () => ({ getDb: vi.fn() }));

import { resolveTeacherCanonicalKeys } from "@/lib/progress-tests/teacher-access";

/**
 * Minimal chainable Drizzle stand-in: each db.select() returns a builder whose
 * methods chain and which (when awaited) resolves to the next queued result.
 * Queue order must match the function's query order: [contacts, snapshot, groups].
 */
function fakeDb(queue: unknown[][]) {
  let i = 0;
  function builder(rows: unknown[]) {
    const b: Record<string, unknown> = {};
    for (const method of ["from", "where", "innerJoin", "leftJoin", "orderBy", "limit"]) {
      b[method] = () => b;
    }
    (b as { then: unknown }).then = (
      resolve: (value: unknown) => unknown,
      reject?: (error: unknown) => unknown,
    ) => Promise.resolve(rows).then(resolve, reject);
    return b;
  }
  return { select: () => builder(queue[i++] ?? []) } as never;
}

describe("resolveTeacherCanonicalKeys", () => {
  it("returns the single merged key for a nickname teacher (one key spans onsite + online)", async () => {
    const contacts = [{
      canonicalKey: "Aey",
      displayName: "Usanee (Aey) Tortermpun",
      onsiteEmail: "aey@example.com",
      onlineEmail: "aey.online@example.com",
      sourceNames: ["Usanee (Aey) Tortermpun", "Usanee (Aey) Tortermpun Online"],
    }];
    const snapshot = [{ id: "s1" }];
    const groups = [
      { canonicalKey: "Aey", groupDisplayName: "Aey", memberDisplayName: "Usanee (Aey) Tortermpun" },
      { canonicalKey: "Aey", groupDisplayName: "Aey", memberDisplayName: "Usanee (Aey) Tortermpun Online" },
    ];

    const keys = await resolveTeacherCanonicalKeys("aey@example.com", fakeDb([contacts, snapshot, groups]));

    expect(keys).toEqual(["Aey"]);
  });

  it("bridges a split (no-nickname) identity so the onsite email also covers the online key", async () => {
    const contacts = [{
      canonicalKey: "David Smith",
      displayName: "David Smith",
      onsiteEmail: "david@example.com",
      onlineEmail: "david.online@example.com",
      sourceNames: ["David Smith", "David Smith Online"],
    }];
    const snapshot = [{ id: "s1" }];
    // Wise split this human into two un-merged identity groups (no shared nickname).
    const groups = [
      { canonicalKey: "David Smith", groupDisplayName: "David Smith", memberDisplayName: "David Smith" },
      { canonicalKey: "David Smith Online", groupDisplayName: "David Smith Online", memberDisplayName: "David Smith Online" },
    ];

    const keys = await resolveTeacherCanonicalKeys("david@example.com", fakeDb([contacts, snapshot, groups]));

    // The onsite-email login must surface BOTH the onsite and the online key.
    expect(new Set(keys)).toEqual(new Set(["David Smith", "David Smith Online"]));
  });

  it("matches case-insensitively on the online email too", async () => {
    const contacts = [{
      canonicalKey: "Aey",
      displayName: "Usanee (Aey) Tortermpun",
      onsiteEmail: "aey@example.com",
      onlineEmail: "aey.online@example.com",
      sourceNames: ["Usanee (Aey) Tortermpun"],
    }];

    const keys = await resolveTeacherCanonicalKeys("  AEY.ONLINE@Example.com ", fakeDb([contacts, [{ id: "s1" }], []]));

    expect(keys).toEqual(["Aey"]);
  });

  it("returns [] for an unknown email", async () => {
    const contacts = [{
      canonicalKey: "Aey", displayName: "Usanee (Aey) Tortermpun",
      onsiteEmail: "aey@example.com", onlineEmail: null, sourceNames: [],
    }];

    const keys = await resolveTeacherCanonicalKeys("stranger@example.com", fakeDb([contacts]));

    expect(keys).toEqual([]);
  });

  it("returns [] for an empty email without querying", async () => {
    const keys = await resolveTeacherCanonicalKeys("", fakeDb([]));
    expect(keys).toEqual([]);
  });

  it("still returns the contact key when no active snapshot exists (bridge skipped)", async () => {
    const contacts = [{
      canonicalKey: "Aey", displayName: "Usanee (Aey) Tortermpun",
      onsiteEmail: "aey@example.com", onlineEmail: null,
      sourceNames: ["Usanee (Aey) Tortermpun"],
    }];

    const keys = await resolveTeacherCanonicalKeys("aey@example.com", fakeDb([contacts, []]));

    expect(keys).toEqual(["Aey"]);
  });
});
