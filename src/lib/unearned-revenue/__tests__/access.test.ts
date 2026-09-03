import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));
vi.mock("@/lib/auth", () => ({ auth: vi.fn() }));
vi.mock("@/lib/db", () => ({ getDb: vi.fn() }));

import { auth } from "@/lib/auth";
import {
  assertUnearnedRevenueCapabilityReplacementAllowed,
  getUnearnedRevenueCapabilities,
  nextUnearnedRevenueCapabilityVersion,
  normalizeUnearnedRevenueCapabilities,
  requireUnearnedRevenueCapability,
} from "@/lib/unearned-revenue/access";

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
      builder.then = (resolve: (value: unknown) => unknown, reject?: (error: unknown) => unknown) => (
        Promise.resolve(rows).then(resolve, reject)
      );
      return builder;
    },
  } as never;
}

describe("unearned revenue capability policy", () => {
  beforeEach(() => vi.resetAllMocks());

  it("deduplicates grants and makes access-manager imply viewer", () => {
    expect(normalizeUnearnedRevenueCapabilities(["access_manager", "unknown", "access_manager"]))
      .toEqual(["viewer", "access_manager"]);
    expect(normalizeUnearnedRevenueCapabilities([])).toEqual([]);
  });

  it("prevents self-removal and removal of the final access manager", () => {
    const common = {
      actorCapabilities: ["viewer", "access_manager"] as const,
      currentCapabilities: ["viewer", "access_manager"] as const,
      nextCapabilities: ["viewer"] as const,
      currentVersion: 10,
      expectedVersion: 10,
    };
    expect(() => assertUnearnedRevenueCapabilityReplacementAllowed({
      ...common, actorEmail: "OWNER@example.com", targetEmail: "owner@example.com", accessManagerCount: 2,
    })).toThrow(/another access manager/i);
    expect(() => assertUnearnedRevenueCapabilityReplacementAllowed({
      ...common, actorEmail: "other@example.com", targetEmail: "owner@example.com", accessManagerCount: 1,
    })).toThrow(/at least one access manager/i);
  });

  it("rejects stale matrix writes even in the same second", () => {
    const first = nextUnearnedRevenueCapabilityVersion(100, 100_001);
    expect(first).toBe(101);
    expect(() => assertUnearnedRevenueCapabilityReplacementAllowed({
      actorEmail: "a@example.com",
      targetEmail: "b@example.com",
      actorCapabilities: ["viewer", "access_manager"],
      currentCapabilities: ["viewer"],
      nextCapabilities: [],
      accessManagerCount: 1,
      currentVersion: first,
      expectedVersion: 100,
    })).toThrow(/changed since/i);
  });

  it("reads each capability request freshly and joins the admin allowlist", async () => {
    const calls: string[] = [];
    const db = selectOnlyDb([
      [{ capability: "viewer" }],
      [{ capability: "access_manager" }],
    ], calls);

    await expect(getUnearnedRevenueCapabilities("admin@example.com", db)).resolves.toEqual(["viewer"]);
    await expect(getUnearnedRevenueCapabilities("admin@example.com", db)).resolves.toEqual(["viewer", "access_manager"]);
    expect(calls.filter((call) => call === "innerJoin")).toHaveLength(2);
  });

  it("denies a non-admin even if a malformed grant exists", async () => {
    vi.mocked(auth).mockResolvedValue({
      user: { email: "teacher@example.com", name: "Teacher", role: "teacher" },
      expires: new Date(Date.now() + 60_000).toISOString(),
    } as never);

    await expect(requireUnearnedRevenueCapability("viewer", selectOnlyDb([[{ capability: "viewer" }]])))
      .rejects.toMatchObject({ status: 403 });
  });
});
