import { beforeEach, describe, expect, it, vi, type Mock } from "vitest";
import { NextRequest } from "next/server";

vi.mock("@/lib/auth", () => ({ auth: vi.fn() }));
vi.mock("@/lib/db", () => ({ getDb: vi.fn(() => ({ db: true })) }));
vi.mock("@/lib/ai/scheduler-data", () => ({
  createSchedulerConversation: vi.fn(),
  listSchedulerConversations: vi.fn(),
}));

import { auth } from "@/lib/auth";
import {
  createSchedulerConversation,
  listSchedulerConversations,
} from "@/lib/ai/scheduler-data";
import { GET, POST } from "@/app/api/ai-scheduler/conversations/route";

const authMock = auth as unknown as Mock;

function request(url: string, body?: unknown): NextRequest {
  return new NextRequest(url, {
    method: body ? "POST" : "GET",
    headers: body ? { "content-type": "application/json" } : undefined,
    body: body ? JSON.stringify(body) : undefined,
  });
}

describe("/api/ai-scheduler/conversations", () => {
  beforeEach(() => {
    vi.resetAllMocks();
    authMock.mockResolvedValue({ user: { email: "admin@example.com", name: "Admin" } });
    vi.mocked(listSchedulerConversations).mockResolvedValue({ conversations: [], adminFacets: [] });
    vi.mocked(createSchedulerConversation).mockResolvedValue({
      id: "conv-1",
      title: "Ava English",
      status: "active",
      source: "manual",
      pendingLineReviewCount: 0,
      latestLineReviewStatus: null,
      needsStudentLink: false,
      oldestPendingLineReviewAt: null,
      latestLineReviewAt: null,
      customerParentName: null,
      customerStudentName: "Ava",
      customerContact: null,
      notes: "",
      extractedState: {},
      createdByEmail: "admin@example.com",
      createdByName: "Admin",
      archivedAt: null,
      lastMessageAt: "2026-05-18T00:00:00.000Z",
      createdAt: "2026-05-18T00:00:00.000Z",
      updatedAt: "2026-05-18T00:00:00.000Z",
    });
  });

  it("requires auth", async () => {
    authMock.mockResolvedValue(null);

    const response = await GET(request("http://test.local/api/ai-scheduler/conversations"));

    expect(response.status).toBe(401);
  });

  it("lists shared conversations with owner/search/sort filters and admin facets", async () => {
    vi.mocked(listSchedulerConversations).mockResolvedValue({
      conversations: [],
      adminFacets: [{ email: "care@example.com", name: "Care", count: 3, pendingLineCount: 2 }],
    });

    const response = await GET(request("http://test.local/api/ai-scheduler/conversations?ownerEmail=care%40example.com&sort=oldest_pending_line&includeArchived=true&q=ava"));

    expect(response.status).toBe(200);
    expect(listSchedulerConversations).toHaveBeenCalledWith(expect.anything(), {
      includeArchived: true,
      mineOnly: false,
      ownerEmail: "care@example.com",
      sort: "oldest_pending_line",
      query: "ava",
      actor: { email: "admin@example.com", name: "Admin" },
    });
    await expect(response.json()).resolves.toEqual({
      conversations: [],
      adminFacets: [{ email: "care@example.com", name: "Care", count: 3, pendingLineCount: 2 }],
    });
  });

  it("keeps the existing mine filter as the current admin owner shortcut", async () => {
    const response = await GET(request("http://test.local/api/ai-scheduler/conversations?scope=mine"));

    expect(response.status).toBe(200);
    expect(listSchedulerConversations).toHaveBeenCalledWith(expect.anything(), expect.objectContaining({
      mineOnly: true,
      ownerEmail: null,
      sort: "review_priority",
    }));
  });

  it("rejects invalid sort modes", async () => {
    const response = await GET(request("http://test.local/api/ai-scheduler/conversations?sort=random"));

    expect(response.status).toBe(400);
    expect(listSchedulerConversations).not.toHaveBeenCalled();
  });

  it("creates a conversation owned by the current admin", async () => {
    const response = await POST(request("http://test.local/api/ai-scheduler/conversations", {
      title: "Ava English",
      customerStudentName: "Ava",
    }));

    expect(response.status).toBe(201);
    expect(createSchedulerConversation).toHaveBeenCalledWith(
      expect.anything(),
      { email: "admin@example.com", name: "Admin" },
      { title: "Ava English", customerStudentName: "Ava" },
    );
  });
});
