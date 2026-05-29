import { beforeEach, describe, expect, it, vi, type Mock } from "vitest";
import { NextRequest } from "next/server";

vi.mock("@/lib/auth", () => ({ auth: vi.fn() }));
vi.mock("@/lib/db", () => ({ getDb: vi.fn(() => ({ db: true })) }));
vi.mock("@/lib/line/data", () => ({
  getLineReviewChatContext: vi.fn(),
}));

import { auth } from "@/lib/auth";
import { getLineReviewChatContext } from "@/lib/line/data";
import { GET } from "@/app/api/line/scheduler-reviews/[reviewId]/context/route";

const authMock = auth as unknown as Mock;

function request(): NextRequest {
  return new NextRequest("http://test.local/api/line/scheduler-reviews/review-1/context");
}

function ctx(reviewId = "review-1") {
  return { params: Promise.resolve({ reviewId }) };
}

const contextPayload = {
  reviewId: "review-1",
  threadId: "thread-1",
  conversationId: "conversation-1",
  lineMessages: [
    {
      id: "line-old",
      source: "line" as const,
      roleLabel: "LINE parent",
      text: "ขอหยุดคลาสค่ะ",
      timestamp: "2026-05-29T01:00:00.000Z",
      direction: "inbound" as const,
      role: null,
      messageType: "text",
      isRetracted: false,
      createdByEmail: null,
      createdByName: null,
    },
  ],
  websiteMessages: [
    {
      id: "web-new",
      source: "website" as const,
      roleLabel: "Website AI",
      text: "I classified this as a cancellation.",
      timestamp: "2026-05-29T01:01:00.000Z",
      direction: null,
      role: "assistant" as const,
      messageType: null,
      isRetracted: false,
      createdByEmail: null,
      createdByName: "AI Scheduler",
    },
  ],
  combinedTimeline: [
    {
      id: "line-old",
      source: "line" as const,
      roleLabel: "LINE parent",
      text: "ขอหยุดคลาสค่ะ",
      timestamp: "2026-05-29T01:00:00.000Z",
      direction: "inbound" as const,
      role: null,
      messageType: "text",
      isRetracted: false,
      createdByEmail: null,
      createdByName: null,
    },
    {
      id: "web-new",
      source: "website" as const,
      roleLabel: "Website AI",
      text: "I classified this as a cancellation.",
      timestamp: "2026-05-29T01:01:00.000Z",
      direction: null,
      role: "assistant" as const,
      messageType: null,
      isRetracted: false,
      createdByEmail: null,
      createdByName: "AI Scheduler",
    },
  ],
};

describe("GET /api/line/scheduler-reviews/[reviewId]/context", () => {
  beforeEach(() => {
    vi.resetAllMocks();
    authMock.mockResolvedValue({ user: { email: "admin@example.com", name: "Admin" } });
    vi.mocked(getLineReviewChatContext).mockResolvedValue(contextPayload);
  });

  it("requires auth", async () => {
    authMock.mockResolvedValue(null);

    const response = await GET(request(), ctx());

    expect(response.status).toBe(401);
    expect(getLineReviewChatContext).not.toHaveBeenCalled();
  });

  it("returns combined LINE and website context for the requested review", async () => {
    const response = await GET(request(), ctx("review-1"));

    expect(response.status).toBe(200);
    expect(getLineReviewChatContext).toHaveBeenCalledWith({ db: true }, "review-1");
    await expect(response.json()).resolves.toEqual({ context: contextPayload });
  });

  it("preserves oldest-to-newest timeline ordering and website messages", async () => {
    const response = await GET(request(), ctx());
    const body = await response.json();

    expect(body.context.combinedTimeline.map((message: { id: string }) => message.id)).toEqual([
      "line-old",
      "web-new",
    ]);
    expect(body.context.websiteMessages).toHaveLength(1);
  });

  it("returns 404 when the review is missing", async () => {
    vi.mocked(getLineReviewChatContext).mockResolvedValue(null);

    const response = await GET(request(), ctx("missing"));

    expect(response.status).toBe(404);
  });
});
