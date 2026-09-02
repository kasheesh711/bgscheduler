import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));
vi.mock("@/lib/auth", () => ({ auth: vi.fn() }));
vi.mock("@/lib/db", () => ({ getDb: vi.fn() }));

import { auth } from "@/lib/auth";
import {
  PostClassAccessError,
  assertPostClassCapabilityReplacementAllowed,
  getPostClassCapabilities,
  nextPostClassCapabilityVersion,
  normalizePostClassCapabilities,
  replacePostClassCapabilities,
  requirePostClassCapability,
} from "@/lib/post-class-feedback/access";

function selectOnlyDb(rowsByQuery: unknown[][], methodCalls?: string[]) {
  let index = 0;
  return {
    select() {
      const rows = rowsByQuery[index++] ?? [];
      const builder: Record<string, unknown> = {};
      for (const method of ["from", "innerJoin", "where", "orderBy", "limit"]) {
        builder[method] = () => {
          methodCalls?.push(method);
          return builder;
        };
      }
      builder.then = (
        resolve: (value: unknown) => unknown,
        reject?: (error: unknown) => unknown,
      ) => Promise.resolve(rows).then(resolve, reject);
      return builder;
    },
  } as never;
}

describe("post-class capability policy", () => {
  beforeEach(() => {
    vi.resetAllMocks();
  });

  it("deduplicates, orders, rejects unknown values, and makes action roles viewable", () => {
    expect(normalizePostClassCapabilities([
      "finance",
      "not_a_role",
      "reviewer",
      "finance",
    ])).toEqual(["viewer", "reviewer", "finance"]);
  });

  it("allows an empty set so another manager can revoke all feature access", () => {
    expect(normalizePostClassCapabilities([])).toEqual([]);
  });

  it("rejects a mutation by a non-access-manager", () => {
    expect(() => assertPostClassCapabilityReplacementAllowed({
      actorEmail: "reviewer@example.com",
      targetEmail: "other@example.com",
      actorCapabilities: ["viewer", "reviewer"],
      currentCapabilities: ["viewer"],
      nextCapabilities: ["viewer", "finance"],
      activeAccessManagerCount: 1,
      currentVersion: 10,
      expectedVersion: 10,
    })).toThrowError(new PostClassAccessError("Access manager capability required", 403));
  });

  it("prevents an access manager from removing their own manager role", () => {
    expect(() => assertPostClassCapabilityReplacementAllowed({
      actorEmail: "OWNER@example.com",
      targetEmail: " owner@example.com ",
      actorCapabilities: ["viewer", "access_manager"],
      currentCapabilities: ["viewer", "access_manager"],
      nextCapabilities: ["viewer"],
      activeAccessManagerCount: 2,
      currentVersion: 10,
      expectedVersion: 10,
    })).toThrowError(/another access manager/i);
  });

  it("prevents removal of the last access manager", () => {
    expect(() => assertPostClassCapabilityReplacementAllowed({
      actorEmail: "actor@example.com",
      targetEmail: "target@example.com",
      actorCapabilities: ["viewer", "access_manager"],
      currentCapabilities: ["viewer", "access_manager"],
      nextCapabilities: ["viewer"],
      activeAccessManagerCount: 1,
      currentVersion: 10,
      expectedVersion: 10,
    })).toThrowError(/at least one access manager/i);
  });

  it("rejects a stale role-matrix edit", () => {
    expect(() => assertPostClassCapabilityReplacementAllowed({
      actorEmail: "actor@example.com",
      targetEmail: "target@example.com",
      actorCapabilities: ["viewer", "access_manager"],
      currentCapabilities: ["viewer", "reviewer"],
      nextCapabilities: ["viewer", "finance"],
      activeAccessManagerCount: 2,
      currentVersion: 11,
      expectedVersion: 10,
    })).toThrowError(/changed since/i);
  });

  it("permits one manager to change another while a manager remains", () => {
    expect(() => assertPostClassCapabilityReplacementAllowed({
      actorEmail: "actor@example.com",
      targetEmail: "target@example.com",
      actorCapabilities: ["viewer", "access_manager"],
      currentCapabilities: ["viewer", "access_manager"],
      nextCapabilities: ["finance"],
      activeAccessManagerCount: 2,
      currentVersion: 10,
      expectedVersion: 10,
    })).not.toThrow();
  });

  it("requires an optimistic version for every replacement", async () => {
    await expect(replacePostClassCapabilities({
      actorEmail: "actor@example.com",
      targetEmail: "target@example.com",
      capabilities: ["viewer"],
      expectedVersion: undefined,
      db: {} as never,
    } as never)).rejects.toMatchObject({ status: 409 });
  });

  it("rejects a rapid same-second stale save with a strictly monotonic token", () => {
    const initialVersion = 1_721_234_567;
    const sameMillisecond = initialVersion * 1_000 + 321;
    const firstSaveVersion = nextPostClassCapabilityVersion(initialVersion, sameMillisecond);
    const secondSaveVersion = nextPostClassCapabilityVersion(firstSaveVersion, sameMillisecond);

    expect(firstSaveVersion).toBe(initialVersion + 1);
    expect(secondSaveVersion).toBe(initialVersion + 2);
    expect(() => assertPostClassCapabilityReplacementAllowed({
      actorEmail: "actor@example.com",
      targetEmail: "target@example.com",
      actorCapabilities: ["viewer", "access_manager"],
      currentCapabilities: ["viewer", "reviewer"],
      nextCapabilities: ["viewer", "finance"],
      activeAccessManagerCount: 2,
      currentVersion: firstSaveVersion,
      expectedVersion: initialVersion,
    })).toThrowError(/changed since/i);
  });

  it("reads capabilities afresh on every request instead of caching JWT state", async () => {
    const db = selectOnlyDb([
      [{ capability: "viewer" }],
      [{ capability: "viewer" }, { capability: "reviewer" }],
    ]);

    await expect(getPostClassCapabilities(" Admin@Example.com ", db)).resolves.toEqual(["viewer"]);
    await expect(getPostClassCapabilities("admin@example.com", db)).resolves.toEqual([
      "viewer",
      "reviewer",
    ]);
  });

  it("joins every grant lookup to the current admin allowlist", async () => {
    const calls: string[] = [];
    const db = selectOnlyDb([[{ capability: "viewer" }]], calls);

    await expect(getPostClassCapabilities("admin@example.com", db)).resolves.toEqual(["viewer"]);
    expect(calls).toContain("innerJoin");
  });

  it("returns no capabilities when a removed admin has only stale grant rows", async () => {
    await expect(getPostClassCapabilities(
      "removed@example.com",
      selectOnlyDb([[]]),
    )).resolves.toEqual([]);
  });

  it("requires an admin session and the requested fresh capability", async () => {
    vi.mocked(auth).mockResolvedValue({
      user: {
        email: "KEVHSH7@gmail.com",
        name: "Kevin",
        role: "admin",
      },
      expires: new Date(Date.now() + 60_000).toISOString(),
    } as never);

    const capableDb = selectOnlyDb([[
      { capability: "viewer" },
      { capability: "finance" },
    ]]);

    await expect(requirePostClassCapability("finance", capableDb)).resolves.toMatchObject({
      email: "kevhsh7@gmail.com",
      capabilities: ["viewer", "finance"],
    });
  });

  it("accepts a legacy session without a role only when the fresh grant exists", async () => {
    vi.mocked(auth).mockResolvedValue({
      user: {
        email: "viewer@example.com",
        name: "Viewer",
      },
      expires: new Date(Date.now() + 60_000).toISOString(),
    } as never);

    await expect(requirePostClassCapability("viewer", selectOnlyDb([[
      { capability: "viewer" },
    ]]))).resolves.toMatchObject({
      email: "viewer@example.com",
      role: "admin",
    });
  });

  it("denies a teacher even if a malformed grant row were present", async () => {
    vi.mocked(auth).mockResolvedValue({
      user: {
        email: "teacher@example.com",
        name: "Teacher",
        role: "teacher",
      },
      expires: new Date(Date.now() + 60_000).toISOString(),
    } as never);

    await expect(requirePostClassCapability("viewer", selectOnlyDb([
      [{ capability: "viewer" }],
    ]))).rejects.toMatchObject({ status: 403 });
  });
});
