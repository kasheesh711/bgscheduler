import { beforeEach, describe, expect, it, vi } from "vitest";
import { NextRequest } from "next/server";

vi.mock("@/lib/db", () => ({ getDb: vi.fn(() => ({ db: true })) }));
vi.mock("@/lib/line/oa-resolver", () => ({
  listLineOaResolverWorklistForToken: vi.fn(async () => ({
    runId: "run-1",
    expiresAt: "2026-05-29T10:00:00.000Z",
    rows: [],
  })),
}));

import { listLineOaResolverWorklistForToken } from "@/lib/line/oa-resolver";
import { GET } from "@/app/api/line/contacts/oa-resolver/worklist/route";

function request(token?: string) {
  return new NextRequest("http://test.local/api/line/contacts/oa-resolver/worklist", {
    headers: token ? { authorization: `Bearer ${token}` } : {},
  });
}

describe("LINE OA resolver worklist route", () => {
  beforeEach(() => {
    vi.resetAllMocks();
    vi.mocked(listLineOaResolverWorklistForToken).mockResolvedValue({
      runId: "run-1",
      expiresAt: "2026-05-29T10:00:00.000Z",
      rows: [],
    });
  });

  it("requires a valid resolver token", async () => {
    vi.mocked(listLineOaResolverWorklistForToken).mockResolvedValue(null);

    const response = await GET(request("bad-token"));

    expect(response.status).toBe(401);
  });

  it("returns pending worklist rows for the token", async () => {
    const response = await GET(request("good-token"));

    expect(response.status).toBe(200);
    expect(listLineOaResolverWorklistForToken).toHaveBeenCalledWith({ db: true }, "good-token");
    await expect(response.json()).resolves.toEqual({
      worklist: {
        runId: "run-1",
        expiresAt: "2026-05-29T10:00:00.000Z",
        rows: [],
      },
    });
  });
});
