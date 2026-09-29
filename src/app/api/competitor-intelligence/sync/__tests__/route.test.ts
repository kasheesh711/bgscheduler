import { afterEach, beforeEach, describe, expect, it, vi, type Mock } from "vitest";

vi.mock("@/lib/auth", () => ({ auth: vi.fn() }));
vi.mock("@/lib/db", () => ({ getDb: vi.fn() }));

import { auth } from "@/lib/auth";
import { getDb } from "@/lib/db";
import { POST } from "../route";

const authMock = auth as unknown as Mock;

/**
 * Just enough Drizzle surface for the real runCompetitorIntelligenceSync to reach
 * (and fail) the run insert: an empty stale sweep, an empty running pre-check,
 * then an insert that rejects with `insertError`.
 */
function makeDb(insertError: unknown) {
  return {
    update: vi.fn(() => ({
      set: () => ({ where: () => ({ returning: vi.fn().mockResolvedValue([]) }) }),
    })),
    select: vi.fn(() => ({
      from: () => ({ where: () => ({ limit: vi.fn().mockResolvedValue([]) }) }),
    })),
    insert: vi.fn(() => ({
      values: () => ({ returning: vi.fn().mockRejectedValue(insertError) }),
    })),
  };
}

describe("POST /api/competitor-intelligence/sync", () => {
  beforeEach(() => {
    vi.resetAllMocks();
    authMock.mockResolvedValue({
      user: {
        email: "marketing@example.com",
        name: "Marketing",
        role: "admin",
        allowedPages: null,
      },
    });
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("returns 409 when the run insert loses the single-flight race", async () => {
    // DrizzleQueryError shape: the SQLSTATE is on `.cause`.
    const lostRace = Object.assign(new Error("Failed query"), { cause: { code: "23505" } });
    vi.mocked(getDb).mockReturnValue(makeDb(lostRace) as never);

    const res = await POST();

    expect(res.status).toBe(409);
    await expect(res.json()).resolves.toEqual({ error: "Competitor intelligence sync is already running" });
  });

  it("keeps a non-unique insert failure as HTTP 500", async () => {
    vi.spyOn(console, "error").mockImplementation(() => {});
    const foreignKey = Object.assign(new Error("Failed query"), { cause: { code: "23503" } });
    vi.mocked(getDb).mockReturnValue(makeDb(foreignKey) as never);

    const res = await POST();

    expect(res.status).toBe(500);
    await expect(res.json()).resolves.toEqual({ error: "Failed query" });
  });
});
