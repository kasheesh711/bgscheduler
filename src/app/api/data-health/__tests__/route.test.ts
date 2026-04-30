import { describe, it, expect, beforeEach, vi, type Mock } from "vitest";

vi.mock("@/lib/auth", () => ({ auth: vi.fn() }));
vi.mock("@/lib/db", () => ({ getDb: vi.fn() }));

import { auth } from "@/lib/auth";
import { getDb } from "@/lib/db";
import { GET } from "@/app/api/data-health/route";

const authMock = auth as unknown as Mock;

function limitChain(rows: unknown[]) {
  return { limit: vi.fn().mockResolvedValue(rows) };
}

function orderedLimitChain(rows: unknown[]) {
  return { orderBy: vi.fn().mockReturnValue(limitChain(rows)) };
}

function makeDataHealthDb() {
  const lastSuccess = {
    id: "sync-success",
    status: "success",
    startedAt: new Date("2026-04-06T00:00:00.000Z"),
    finishedAt: new Date("2026-04-06T00:05:00.000Z"),
    teacherCount: 131,
    errorSummary: null,
  };
  const lastFailure = {
    id: "sync-failed",
    status: "failed",
    startedAt: new Date("2026-04-05T00:00:00.000Z"),
    finishedAt: new Date("2026-04-05T00:01:00.000Z"),
    teacherCount: 0,
    errorSummary: "Wise failed",
  };
  const activeSnapshot = { id: "snap-1", active: true };
  const snapshotStat = {
    snapshotId: "snap-1",
    totalWiseTeachers: 131,
    totalIdentityGroups: 72,
    resolvedGroups: 70,
    unresolvedGroups: 2,
    totalDataIssues: 3,
    issuesByType: { alias: 1, modality: 1, tag: 1 },
  };
  const issues = [
    { type: "alias", entityName: "Kev", message: "Unresolved alias" },
    { type: "modality", entityName: "Poi", message: "Unresolved modality" },
    { type: "conflict_model", entityName: "Sam", message: "Contradicting modality" },
    { type: "tag", entityName: "Biology", message: "Unmapped tag" },
  ];

  const selectResults = [
    { kind: "where-order-limit", rows: [lastSuccess] },
    { kind: "where-order-limit", rows: [lastFailure] },
    { kind: "where-limit", rows: [activeSnapshot] },
    { kind: "where-limit", rows: [snapshotStat] },
    { kind: "where-promise", rows: issues },
    { kind: "order-limit", rows: [lastSuccess, lastFailure] },
  ];

  const select = vi.fn().mockImplementation(() => {
    const result = selectResults.shift();
    if (!result) throw new Error("Unexpected select");

    const from = vi.fn().mockImplementation(() => {
      if (result.kind === "where-order-limit") {
        return { where: vi.fn().mockReturnValue(orderedLimitChain(result.rows)) };
      }
      if (result.kind === "where-limit") {
        return { where: vi.fn().mockReturnValue(limitChain(result.rows)) };
      }
      if (result.kind === "where-promise") {
        return { where: vi.fn().mockResolvedValue(result.rows) };
      }
      return orderedLimitChain(result.rows);
    });

    return { from };
  });

  return { select };
}

describe("GET /api/data-health", () => {
  beforeEach(() => {
    vi.resetAllMocks();
    authMock.mockResolvedValue({ user: { email: "kevhsh7@gmail.com" } });
    vi.mocked(getDb).mockReturnValue(makeDataHealthDb() as never);
  });

  it("returns 401 when unauthenticated", async () => {
    authMock.mockResolvedValue(null);

    const res = await GET();

    expect(res.status).toBe(401);
    await expect(res.json()).resolves.toEqual({ error: "Unauthorized" });
  });

  it("returns 200 with data-health response shape on success", async () => {
    const res = await GET();

    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body).toMatchObject({
      lastSuccessfulSync: expect.any(String),
      lastFailedSync: expect.any(String),
      lastFailureError: "Wise failed",
      activeSnapshotId: "snap-1",
      stats: {
        totalWiseTeachers: 131,
        totalIdentityGroups: 72,
        resolvedGroups: 70,
        unresolvedGroups: 2,
        totalDataIssues: 3,
      },
      issuesByType: { alias: 1, modality: 1, tag: 1 },
      unresolvedAliases: [{ entityName: "Kev", message: "Unresolved alias" }],
      unresolvedModality: [
        { entityName: "Poi", message: "Unresolved modality", issueType: "modality" },
        { entityName: "Sam", message: "Contradicting modality", issueType: "conflict_model" },
      ],
      unmappedTags: [{ entityName: "Biology", message: "Unmapped tag" }],
      recentSyncs: [
        expect.objectContaining({ id: "sync-success", status: "success" }),
        expect.objectContaining({ id: "sync-failed", status: "failed" }),
      ],
    });
    expect(body.staleAgeMs === null || typeof body.staleAgeMs === "number").toBe(true);
    expect(body.staleMinutes === null || typeof body.staleMinutes === "number").toBe(true);
  });

  it("propagates data errors for the Next.js runtime 500 path", async () => {
    vi.mocked(getDb).mockImplementation(() => {
      throw new Error("DB exploded");
    });

    await expect(GET()).rejects.toThrow("DB exploded");
  });
});
