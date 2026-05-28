import { beforeEach, describe, expect, it, vi, type Mock } from "vitest";
import { NextRequest } from "next/server";

vi.mock("@/lib/auth", () => ({ auth: vi.fn() }));
vi.mock("@/lib/db", () => ({ getDb: vi.fn(() => ({ db: true })) }));
vi.mock("@/lib/line/data", () => ({
  updateLineMessageClassificationFeedback: vi.fn(),
}));

import { auth } from "@/lib/auth";
import { updateLineMessageClassificationFeedback } from "@/lib/line/data";
import { PATCH } from "@/app/api/line/messages/[messageId]/classification-feedback/route";

const authMock = auth as unknown as Mock;
const messageId = "11111111-1111-4111-8111-111111111111";
const ctx = { params: Promise.resolve({ messageId }) };

function request(body: unknown): NextRequest {
  return new NextRequest(`http://test.local/api/line/messages/${messageId}/classification-feedback`, {
    method: "PATCH",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
}

describe("PATCH /api/line/messages/[messageId]/classification-feedback", () => {
  beforeEach(() => {
    vi.resetAllMocks();
    authMock.mockResolvedValue({ user: { email: "Admin@Example.com", name: "Admin" } });
    vi.mocked(updateLineMessageClassificationFeedback).mockResolvedValue({
      id: messageId,
      classifierCategory: "scheduling_request",
      classificationReviewedCategory: "non_scheduling",
      classificationReviewedCorrect: false,
    });
  });

  it("requires auth", async () => {
    authMock.mockResolvedValue(null);

    const response = await PATCH(request({ reviewedCategory: "non_scheduling" }), ctx);

    expect(response.status).toBe(401);
    expect(updateLineMessageClassificationFeedback).not.toHaveBeenCalled();
  });

  it("logs reviewed classification category", async () => {
    const response = await PATCH(request({ reviewedCategory: "non_scheduling" }), ctx);

    expect(response.status).toBe(200);
    expect(updateLineMessageClassificationFeedback).toHaveBeenCalledWith(expect.anything(), {
      messageId,
      reviewedCategory: "non_scheduling",
      actor: { email: "Admin@Example.com", name: "Admin" },
    });
    await expect(response.json()).resolves.toMatchObject({
      feedback: {
        classificationReviewedCorrect: false,
        classificationReviewedCategory: "non_scheduling",
      },
    });
  });

  it("rejects unknown categories", async () => {
    const response = await PATCH(request({ reviewedCategory: "billing" }), ctx);

    expect(response.status).toBe(400);
    expect(updateLineMessageClassificationFeedback).not.toHaveBeenCalled();
  });
});
