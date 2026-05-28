import { beforeEach, describe, expect, it, vi, type Mock } from "vitest";
import { NextRequest } from "next/server";

vi.mock("@/lib/auth", () => ({ auth: vi.fn() }));
vi.mock("@/lib/db", () => ({ getDb: vi.fn(() => ({ db: true })) }));
vi.mock("@/lib/line/data", () => ({
  listLineFalseNegativeCandidates: vi.fn(),
}));

import { auth } from "@/lib/auth";
import { listLineFalseNegativeCandidates } from "@/lib/line/data";
import { GET } from "@/app/api/line/scheduler-reviews/false-negatives/route";

const authMock = auth as unknown as Mock;

function request(query = ""): NextRequest {
  return new NextRequest(`http://test.local/api/line/scheduler-reviews/false-negatives${query}`);
}

describe("GET /api/line/scheduler-reviews/false-negatives", () => {
  beforeEach(() => {
    vi.resetAllMocks();
    authMock.mockResolvedValue({ user: { email: "admin@example.com", name: "Admin" } });
    vi.mocked(listLineFalseNegativeCandidates).mockResolvedValue([]);
  });

  it("requires auth", async () => {
    authMock.mockResolvedValue(null);

    const response = await GET(request());

    expect(response.status).toBe(401);
    expect(listLineFalseNegativeCandidates).not.toHaveBeenCalled();
  });

  it("returns candidates with the default threshold", async () => {
    const response = await GET(request());

    expect(response.status).toBe(200);
    expect(listLineFalseNegativeCandidates).toHaveBeenCalledWith({ db: true }, { threshold: undefined });
    await expect(response.json()).resolves.toEqual({ candidates: [] });
  });

  it("passes a valid threshold through", async () => {
    const response = await GET(request("?threshold=0.5"));

    expect(response.status).toBe(200);
    expect(listLineFalseNegativeCandidates).toHaveBeenCalledWith({ db: true }, { threshold: 0.5 });
  });

  it("rejects an out-of-range threshold", async () => {
    const response = await GET(request("?threshold=5"));

    expect(response.status).toBe(400);
    expect(listLineFalseNegativeCandidates).not.toHaveBeenCalled();
  });
});
