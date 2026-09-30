import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { NextRequest } from "next/server";

vi.mock("server-only", () => ({}));
vi.mock("@/lib/auth", () => ({ auth: vi.fn() }));
vi.mock("@/lib/db", () => ({ getDb: vi.fn(() => ({})) }));
vi.mock("@/lib/feedback-autowriter/trends", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/feedback-autowriter/trends")>();
  return { ...actual, loadAutowriterTrends: vi.fn() };
});

import { auth } from "@/lib/auth";
import { loadAutowriterTrends } from "@/lib/feedback-autowriter/trends";
import { GET } from "../trends/route";

const authMock = vi.mocked(auth as unknown as () => Promise<unknown>);
const loadMock = vi.mocked(loadAutowriterTrends);

function get(query = "") {
  return GET(new NextRequest(`http://localhost/api/feedback-autowriter/trends${query}`));
}

beforeEach(() => {
  vi.clearAllMocks();
  authMock.mockResolvedValue({ user: { email: "admin@example.com", role: "admin" } });
  loadMock.mockImplementation(async (_db, input) => ({ tutorKey: input.tutorKey, range: { days: input.days } }) as never);
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe("GET /api/feedback-autowriter/trends", () => {
  it("requires a session, and an admin one", async () => {
    authMock.mockResolvedValue(null);
    expect((await get("?days=14&tutor=*")).status).toBe(401);
    authMock.mockResolvedValue({ user: { email: "parent@example.com", role: "parent" } });
    const forbidden = await get("?days=14&tutor=*");
    expect(forbidden.status).toBe(403);
    expect(await forbidden.json()).toEqual({ error: "Forbidden" });
    expect(loadMock).not.toHaveBeenCalled();
  });

  it("serves the requested range for all tutors or one roster tutor", async () => {
    const all = await get("?days=30&tutor=*");
    expect(all.status).toBe(200);
    expect(await all.json()).toEqual({ tutorKey: "*", range: { days: 30 } });
    expect((await get("?days=90&tutor=Mimi")).status).toBe(200);
    expect((await get("?days=14&tutor=%2A")).status).toBe(200);
    // Both are optional: 14 days, all tutors.
    expect((await get()).status).toBe(200);
    expect((await get("?tutor=Ek")).status).toBe(200);
    expect(loadMock.mock.calls.map(([, input]) => input)).toEqual([
      { days: 30, tutorKey: "*" },
      { days: 90, tutorKey: "Mimi" },
      { days: 14, tutorKey: "*" },
      { days: 14, tutorKey: "*" },
      { days: 14, tutorKey: "Ek" },
    ]);
  });

  it("refuses a range that is not 14, 30 or 90 days", async () => {
    for (const query of ["?days=7", "?days=0", "?days=abc", "?days=", "?days=14.5", "?days=-14", "?days=900", "?days=14&days=15"]) {
      const response = await get(query);
      expect(response.status, query).toBe(400);
      expect(await response.json(), query).toMatchObject({ error: { fieldErrors: { days: expect.any(Array) } } });
    }
    expect(loadMock).not.toHaveBeenCalled();
  });

  it("refuses a tutor that is not on the roster", async () => {
    // A roster account id is not a tutor key; keys are matched as written.
    for (const query of ["?tutor=Nobody", "?tutor=", "?tutor=mimi", "?tutor=696e2c4343579bbada2340f8", "?days=30&tutor=**"]) {
      const response = await get(query);
      expect(response.status, query).toBe(400);
      expect(await response.json(), query).toMatchObject({ error: { fieldErrors: { tutor: expect.any(Array) } } });
    }
    expect(loadMock).not.toHaveBeenCalled();
  });

  it("answers a failed load with a plain 500 and logs only the error's name and SQLSTATE", async () => {
    const logged = vi.spyOn(console, "error").mockImplementation(() => undefined);
    loadMock.mockRejectedValue(Object.assign(new Error("select … where performance = 'the lesson text'"), { code: "42703" }));
    const response = await get("?days=14&tutor=*");
    expect(response.status).toBe(500);
    expect(await response.json()).toEqual({ error: "The autowriter trends could not load." });
    expect(logged).toHaveBeenCalledWith("[feedback-autowriter] trends load failed", { errorName: "Error", sqlState: "42703" });
    expect(JSON.stringify(logged.mock.calls)).not.toContain("lesson text");
  });

  it("answers missing review tables (migration 0101 not applied) with the typed payload and HTTP 200, as the review route", async () => {
    const logged = vi.spyOn(console, "error").mockImplementation(() => undefined);
    // The driver's error, and the same error as drizzle 0.45 wraps it (its SQLSTATE on `cause`).
    const missing = Object.assign(new Error('relation "feedback_autowriter_reviews" does not exist'), { code: "42P01" });
    for (const error of [missing, Object.assign(new Error("Failed query: select …"), { cause: missing })]) {
      loadMock.mockRejectedValueOnce(error);
      const response = await get("?days=30&tutor=Mimi");
      expect(response.status).toBe(200);
      expect(await response.json()).toEqual({ available: false, reason: "review_tables_missing" });
    }
    // An optional table, not a failure: nothing is logged.
    expect(logged).not.toHaveBeenCalled();
  });

  it("still refuses a signed-out caller before it reads anything, missing tables or not", async () => {
    authMock.mockResolvedValue(null);
    loadMock.mockRejectedValue(Object.assign(new Error("missing"), { code: "42P01" }));
    expect((await get("?days=14&tutor=*")).status).toBe(401);
    expect(loadMock).not.toHaveBeenCalled();
  });

  it("lets Next's hanging-promise rejection through", async () => {
    const hanging = Object.assign(new Error("hanging"), { digest: "HANGING_PROMISE_REJECTION" });
    loadMock.mockRejectedValue(hanging);
    await expect(get("?days=14&tutor=*")).rejects.toBe(hanging);
  });
});
