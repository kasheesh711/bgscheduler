import { beforeEach, describe, expect, it, vi, type Mock } from "vitest";
import { NextRequest } from "next/server";

vi.mock("@/lib/auth", () => ({ auth: vi.fn() }));
vi.mock("@/lib/db", () => ({ getDb: vi.fn(() => ({ db: true })) }));
vi.mock("@/lib/line/oa-resolver", () => ({
  commitLineOaResolverRun: vi.fn(async () => ({
    committed: 1,
    skipped: 0,
    run: { id: "run-1" },
  })),
}));

import { auth } from "@/lib/auth";
import { commitLineOaResolverRun } from "@/lib/line/oa-resolver";
import { POST } from "@/app/api/line/contacts/oa-resolver/runs/[runId]/commit/route";

const authMock = auth as unknown as Mock;

function request(body: unknown = {}) {
  return new NextRequest("http://test.local/api/line/contacts/oa-resolver/runs/run-1/commit", {
    method: "POST",
    body: JSON.stringify(body),
  });
}

const ctx = { params: Promise.resolve({ runId: "00000000-0000-4000-8000-000000000001" }) };

describe("LINE OA resolver commit route", () => {
  beforeEach(() => {
    vi.resetAllMocks();
    authMock.mockResolvedValue({ user: { email: "admin@example.com", name: "Admin" } });
    vi.mocked(commitLineOaResolverRun).mockResolvedValue({
      committed: 1,
      skipped: 0,
      run: { id: "run-1" } as never,
    });
  });

  it("requires auth", async () => {
    authMock.mockResolvedValue(null);

    const response = await POST(request(), ctx);

    expect(response.status).toBe(401);
    expect(commitLineOaResolverRun).not.toHaveBeenCalled();
  });

  it("commits matched resolver rows", async () => {
    const response = await POST(request({
      rowIds: ["00000000-0000-4000-8000-000000000002"],
    }), ctx);

    expect(response.status).toBe(200);
    expect(commitLineOaResolverRun).toHaveBeenCalledWith({ db: true }, {
      runId: "00000000-0000-4000-8000-000000000001",
      rowIds: ["00000000-0000-4000-8000-000000000002"],
      selectedCandidates: undefined,
    });
  });

  it("passes selected multi-account candidates to the resolver service", async () => {
    const response = await POST(request({
      selectedCandidates: [{
        rowId: "00000000-0000-4000-8000-000000000002",
        lineUserId: "U9fdc5658d0c2cbfc02d0a2acc89fdb6d",
      }],
    }), ctx);

    expect(response.status).toBe(200);
    expect(commitLineOaResolverRun).toHaveBeenCalledWith({ db: true }, {
      runId: "00000000-0000-4000-8000-000000000001",
      rowIds: undefined,
      selectedCandidates: [{
        rowId: "00000000-0000-4000-8000-000000000002",
        lineUserId: "U9fdc5658d0c2cbfc02d0a2acc89fdb6d",
      }],
    });
  });
});
