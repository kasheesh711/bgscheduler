import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));
vi.mock("@/lib/auth", () => ({ auth: vi.fn() }));
vi.mock("@/lib/db", () => ({ getDb: vi.fn(() => ({})) }));
vi.mock("@/lib/tutor-offboarding/grants", async (importOriginal) => ({
  ...await importOriginal<typeof import("@/lib/tutor-offboarding/grants")>(),
  hasRemovalGrant: vi.fn(async () => false),
}));
vi.mock("@/lib/tutor-offboarding/service", () => ({ loadCurrentTutorList: vi.fn() }));

import { auth } from "@/lib/auth";
import { loadCurrentTutorList } from "@/lib/tutor-offboarding/service";
import { GET } from "../route";

// Made-up people and @example.com addresses only: never real tutors.

const authMock = vi.mocked(auth as unknown as () => Promise<unknown>);
const listMock = vi.mocked(loadCurrentTutorList);
const BASE = "http://localhost/api/tutor-offboarding/current-tutors";
const LIST = {
  available: true as const,
  generatedAt: "2026-10-12T05:00:00.000Z",
  snapshotCreatedAt: "2026-10-12T04:30:00.000Z",
  stale: false,
  recipients: [
    { name: 'Ana "A" Lee', email: "ana@example.com", reason: "upcoming" as const },
    { name: "=SUM(1)", email: "sum@example.com", reason: "recent" as const },
  ],
  needsEmail: [],
  excludedConfirmed: [],
  unmatchedSheetRows: 0,
};

async function bytes(response: Response): Promise<string> {
  // Response.text() strips a leading BOM; decode the raw bytes to see exactly what is downloaded.
  return new TextDecoder("utf-8", { ignoreBOM: true }).decode(await response.arrayBuffer());
}

beforeEach(() => {
  vi.clearAllMocks();
  authMock.mockResolvedValue({ user: { email: "admin@example.com", role: "admin" } });
  listMock.mockResolvedValue(LIST);
});

describe("GET /api/tutor-offboarding/current-tutors", () => {
  it("requires an admin session", async () => {
    authMock.mockResolvedValueOnce(null);
    expect((await GET(new Request(BASE))).status).toBe(401);
    authMock.mockResolvedValueOnce({ user: { email: "parent@example.com", role: "parent" } });
    const forbidden = await GET(new Request(BASE));
    expect(forbidden.status).toBe(403);
    expect(forbidden.headers.get("Cache-Control")).toBe("private, no-store");
    expect(listMock).not.toHaveBeenCalled();
  });

  it("returns the JSON list, never cached", async () => {
    const response = await GET(new Request(BASE));
    expect(response.status).toBe(200);
    expect(response.headers.get("Cache-Control")).toBe("private, no-store");
    expect(await response.json()).toEqual(LIST);
    expect(listMock).toHaveBeenCalledWith(expect.objectContaining({ email: "admin@example.com" }));
  });

  it("passes an unavailable list through as JSON", async () => {
    listMock.mockResolvedValueOnce({ available: false, reason: "no_snapshot" });
    const response = await GET(new Request(BASE));
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ available: false, reason: "no_snapshot" });
  });

  it("downloads recipients as an escaped CSV named for the Bangkok date", async () => {
    const response = await GET(new Request(`${BASE}?format=csv`));
    expect(response.status).toBe(200);
    expect(response.headers.get("Content-Type")).toBe("text/csv; charset=utf-8");
    expect(response.headers.get("Content-Disposition")).toBe('attachment; filename="current-tutors-2026-10-12.csv"');
    expect(response.headers.get("Cache-Control")).toBe("private, no-store");
    expect(await bytes(response)).toBe(
      '\uFEFF"name","email","reason"\r\n"Ana ""A"" Lee","ana@example.com","upcoming"\r\n"\'=SUM(1)","sum@example.com","recent"',
    );
  });

  it("refuses a CSV when the list is unavailable", async () => {
    listMock.mockResolvedValueOnce({ available: false, reason: "not_set_up" });
    const response = await GET(new Request(`${BASE}?format=csv`));
    expect(response.status).toBe(503);
    expect(await response.json()).toEqual({ error: "The tutor list is unavailable (not_set_up)." });
  });

  it("rejects any other query", async () => {
    for (const query of ["?format=json", "?format=csv&format=csv", "?x=1"]) {
      const response = await GET(new Request(`${BASE}${query}`));
      expect(response.status).toBe(400);
      expect(response.headers.get("Cache-Control")).toBe("private, no-store");
    }
    expect(listMock).not.toHaveBeenCalled();
  });

  it("never serializes an unexpected error", async () => {
    listMock.mockRejectedValueOnce(new Error("select … ana@example.com"));
    const log = vi.spyOn(console, "error").mockImplementation(() => undefined);
    const response = await GET(new Request(BASE));
    expect(response.status).toBe(500);
    expect(await response.json()).toEqual({ error: "The current tutor list could not load." });
    log.mockRestore();
  });
});
