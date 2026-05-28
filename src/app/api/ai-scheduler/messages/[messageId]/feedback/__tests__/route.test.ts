import { beforeEach, describe, expect, it, vi, type Mock } from "vitest";
import { NextRequest } from "next/server";

vi.mock("@/lib/auth", () => ({ auth: vi.fn() }));
vi.mock("@/lib/db", () => ({ getDb: vi.fn(() => ({ db: true })) }));
vi.mock("@/lib/ai/scheduler-data", () => ({
  createSchedulerFeedback: vi.fn(),
}));

import { auth } from "@/lib/auth";
import { createSchedulerFeedback } from "@/lib/ai/scheduler-data";
import { POST } from "@/app/api/ai-scheduler/messages/[messageId]/feedback/route";

const authMock = auth as unknown as Mock;

const messageId = "11111111-1111-4111-8111-111111111111";
const conversationId = "22222222-2222-4222-8222-222222222222";
const ctx = { params: Promise.resolve({ messageId }) };

function request(body: unknown): NextRequest {
  return new NextRequest(`http://test.local/api/ai-scheduler/messages/${messageId}/feedback`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
}

describe("POST /api/ai-scheduler/messages/[messageId]/feedback", () => {
  beforeEach(() => {
    vi.resetAllMocks();
    authMock.mockResolvedValue({ user: { email: "Admin@Example.com", name: "Admin" } });
    vi.mocked(createSchedulerFeedback).mockResolvedValue({
      id: "33333333-3333-4333-8333-333333333333",
      conversationId,
      messageId,
      schedulerRunId: null,
      action: "accept",
      selectedTutorIds: ["tutor-1"],
      rejectedTutorIds: [],
      editedParentDraft: null,
      rejectionReason: null,
      staffCorrection: null,
      lineReviewId: null,
      classifierConfidence: null,
      timeToReviewMs: null,
      createdByEmail: "admin@example.com",
      createdByName: "Admin",
      createdAt: "2026-05-22T00:00:00.000Z",
    });
  });

  it("returns 401 when unauthenticated", async () => {
    authMock.mockResolvedValue(null);

    const response = await POST(request({ action: "accept" }), ctx);

    expect(response.status).toBe(401);
    await expect(response.json()).resolves.toEqual({ error: "Unauthorized" });
  });

  it("persists accepted scheduler draft feedback", async () => {
    const response = await POST(request({
      action: "accept",
      conversationId,
      selectedTutorIds: ["tutor-1"],
    }), ctx);

    expect(response.status).toBe(200);
    expect(createSchedulerFeedback).toHaveBeenCalledWith(expect.anything(), expect.objectContaining({
      messageId,
      conversationId,
      action: "accept",
      selectedTutorIds: ["tutor-1"],
      actor: { email: "Admin@Example.com", name: "Admin" },
    }));
    await expect(response.json()).resolves.toMatchObject({
      feedback: {
        id: "33333333-3333-4333-8333-333333333333",
        action: "accept",
      },
    });
  });

  it("requires rejection reason and correction for rejected drafts", async () => {
    const response = await POST(request({
      action: "reject",
      conversationId,
      rejectedTutorIds: ["tutor-1"],
    }), ctx);

    expect(response.status).toBe(400);
    expect(createSchedulerFeedback).not.toHaveBeenCalled();
  });
});
