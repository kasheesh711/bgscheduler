import { beforeEach, describe, expect, it, vi, type Mock } from "vitest";
import { NextRequest } from "next/server";

vi.mock("@/lib/auth", () => ({ auth: vi.fn() }));
vi.mock("@/lib/db", () => ({ getDb: vi.fn(() => ({ mocked: true })) }));
vi.mock("@/lib/leave-requests/data", () => ({ createWiseCancelPreview: vi.fn() }));

import { auth } from "@/lib/auth";
import { createWiseCancelPreview } from "@/lib/leave-requests/data";
import { POST } from "../route";

const authMock = auth as unknown as Mock;

function request(body: unknown): NextRequest {
  return new NextRequest("http://test.local/api/leave-requests/request-1/wise-cancel-preview", {
    method: "POST",
    body: JSON.stringify(body),
    headers: { "Content-Type": "application/json" },
  });
}

describe("POST /api/leave-requests/[requestId]/wise-cancel-preview", () => {
  beforeEach(() => {
    vi.resetAllMocks();
    authMock.mockResolvedValue({ user: { email: "admin@example.com", name: "Admin" }, expires: "2026-06-01T00:00:00.000Z" });
    vi.mocked(createWiseCancelPreview).mockResolvedValue({ request: { id: "request-1" } } as never);
  });

  it("requires auth", async () => {
    authMock.mockResolvedValue(null);

    const res = await POST(request({ affectedSessionIds: ["affected-1"] }), {
      params: Promise.resolve({ requestId: "request-1" }),
    });

    expect(res.status).toBe(401);
    expect(createWiseCancelPreview).not.toHaveBeenCalled();
  });

  it("delegates to preview logging without any Wise client mutation", async () => {
    const res = await POST(request({ affectedSessionIds: ["affected-1", 7, "affected-2"] }), {
      params: Promise.resolve({ requestId: "request-1" }),
    });

    expect(res.status).toBe(200);
    expect(createWiseCancelPreview).toHaveBeenCalledWith(
      { mocked: true },
      "request-1",
      {
        affectedSessionIds: ["affected-1", "affected-2"],
        actorEmail: "admin@example.com",
        actorName: "Admin",
      },
    );
  });
});
