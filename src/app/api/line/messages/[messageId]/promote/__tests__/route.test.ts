import { beforeEach, describe, expect, it, vi, type Mock } from "vitest";
import { NextRequest } from "next/server";

vi.mock("@/lib/auth", () => ({ auth: vi.fn() }));
vi.mock("@/lib/db", () => ({ getDb: vi.fn(() => ({ db: true })) }));
vi.mock("@/lib/line/review-service", () => ({
  promoteLineMessageToReview: vi.fn(),
}));

import { auth } from "@/lib/auth";
import { promoteLineMessageToReview } from "@/lib/line/review-service";
import { POST } from "@/app/api/line/messages/[messageId]/promote/route";

const authMock = auth as unknown as Mock;
const messageId = "11111111-1111-4111-8111-111111111111";
const ctx = { params: Promise.resolve({ messageId }) };

function request(): NextRequest {
  return new NextRequest(`http://test.local/api/line/messages/${messageId}/promote`, { method: "POST" });
}

describe("POST /api/line/messages/[messageId]/promote", () => {
  beforeEach(() => {
    vi.resetAllMocks();
    authMock.mockResolvedValue({ user: { email: "Admin@Example.com", name: "Admin" } });
    vi.mocked(promoteLineMessageToReview).mockResolvedValue({
      review: { id: "review-9" } as never,
      alreadyExisted: false,
    });
  });

  it("requires auth", async () => {
    authMock.mockResolvedValue(null);

    const response = await POST(request(), ctx);

    expect(response.status).toBe(401);
    expect(promoteLineMessageToReview).not.toHaveBeenCalled();
  });

  it("promotes the message and returns the review", async () => {
    const response = await POST(request(), ctx);

    expect(response.status).toBe(200);
    expect(promoteLineMessageToReview).toHaveBeenCalledWith({
      db: { db: true },
      lineMessageId: messageId,
      actor: { email: "Admin@Example.com", name: "Admin" },
    });
    await expect(response.json()).resolves.toMatchObject({ review: { id: "review-9" }, alreadyExisted: false });
  });

  it("returns 404 when the message is missing", async () => {
    vi.mocked(promoteLineMessageToReview).mockResolvedValue({ review: null, alreadyExisted: false });

    const response = await POST(request(), ctx);

    expect(response.status).toBe(404);
  });
});
