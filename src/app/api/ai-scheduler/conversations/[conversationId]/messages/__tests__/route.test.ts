import { beforeEach, describe, expect, it, vi, type Mock } from "vitest";
import { NextRequest } from "next/server";

vi.mock("@/lib/auth", () => ({ auth: vi.fn() }));
vi.mock("@/lib/db", () => ({ getDb: vi.fn(() => ({ db: true })) }));
vi.mock("@/lib/ai/scheduler", () => ({
  aiSchedulerModel: vi.fn(() => "gpt-5.4-mini"),
  bangkokTodayIso: vi.fn(() => "2026-05-18"),
  isAiSchedulerConfigured: vi.fn(() => true),
  redactAiSchedulerInput: vi.fn((input: string) => input),
}));
vi.mock("@/lib/ai/scheduler-conversation", () => ({
  buildConversationTitle: vi.fn(() => "Ava English"),
  extractSchedulerStateWithOpenAi: vi.fn(),
  filterOptionsFromIndex: vi.fn(() => ({ subjects: ["English"], curriculums: ["International"], levels: ["Year 5"] })),
  mergeSchedulerState: vi.fn((_existing, incoming) => incoming),
  solveSchedulerTurn: vi.fn(),
  tutorListFromIndex: vi.fn(() => [{ tutorGroupId: "tutor-1", displayName: "Kevin", supportedModes: ["online"], subjects: ["English"] }]),
}));
vi.mock("@/lib/ai/scheduler-data", () => ({
  createSchedulerMessage: vi.fn(),
  getSchedulerConversationWithMessages: vi.fn(),
  logSchedulerRun: vi.fn(),
  touchSchedulerConversationAfterMessage: vi.fn(),
}));
vi.mock("@/lib/search/index", () => ({ ensureIndex: vi.fn() }));
vi.mock("@/lib/proposals/data", () => ({ listActiveProposalHolds: vi.fn() }));

import { auth } from "@/lib/auth";
import {
  extractSchedulerStateWithOpenAi,
  solveSchedulerTurn,
} from "@/lib/ai/scheduler-conversation";
import {
  createSchedulerMessage,
  getSchedulerConversationWithMessages,
  logSchedulerRun,
  touchSchedulerConversationAfterMessage,
} from "@/lib/ai/scheduler-data";
import { ensureIndex } from "@/lib/search/index";
import { listActiveProposalHolds } from "@/lib/proposals/data";
import { POST } from "@/app/api/ai-scheduler/conversations/[conversationId]/messages/route";

const authMock = auth as unknown as Mock;

const conversation = {
  id: "conv-1",
  title: "Untitled scheduler chat",
  status: "active" as const,
  customerParentName: null,
  customerStudentName: null,
  customerContact: null,
  notes: "",
  extractedState: {},
  createdByEmail: "owner@example.com",
  createdByName: "Owner",
  archivedAt: null,
  lastMessageAt: "2026-05-18T00:00:00.000Z",
  createdAt: "2026-05-18T00:00:00.000Z",
  updatedAt: "2026-05-18T00:00:00.000Z",
};

function request(body: unknown): NextRequest {
  return new NextRequest("http://test.local/api/ai-scheduler/conversations/conv-1/messages", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
}

const ctx = { params: Promise.resolve({ conversationId: "conv-1" }) };

describe("POST /api/ai-scheduler/conversations/[conversationId]/messages", () => {
  beforeEach(() => {
    vi.resetAllMocks();
    authMock.mockResolvedValue({ user: { email: "admin@example.com", name: "Admin" } });
    vi.mocked(getSchedulerConversationWithMessages).mockResolvedValue({ conversation, messages: [] });
    vi.mocked(ensureIndex).mockResolvedValue({
      snapshotId: "snap-1",
      profileVersion: "0:",
      builtAt: new Date("2026-05-18T00:00:00.000Z"),
      syncedAt: new Date("2026-05-18T00:00:00.000Z"),
      tutorGroups: [],
      byWeekday: new Map(),
    });
    vi.mocked(listActiveProposalHolds).mockResolvedValue([]);
    vi.mocked(extractSchedulerStateWithOpenAi).mockResolvedValue({
      state: { dayOfWeek: 1, filters: { subject: "English" } },
      title: "Ava English",
    });
    vi.mocked(solveSchedulerTurn).mockReturnValue({
      state: {
        searchMode: "recurring",
        dayOfWeek: 1,
        durationMinutes: 60,
        mode: "either",
        filters: { subject: "English" },
        subjectRequests: [],
        businessRequirements: {},
        dateRange: undefined,
        requestedSlots: [],
        explicitUnknownFilters: [],
        explicitUnknownBusinessRequirements: [],
        tutorNames: [],
        tutorExclusions: [],
        negativeFeedback: false,
        assumptions: [],
        unresolvedQuestions: [],
      },
      suggestions: [],
      parentMessageDraft: "Draft",
      assistantMessage: "I found options.",
      snapshotMeta: { snapshotId: "snap-1", syncedAt: "2026-05-18T00:00:00.000Z", stale: false },
      warnings: [],
      questions: [],
      parentReady: true,
    });
    vi.mocked(createSchedulerMessage)
      .mockResolvedValueOnce({
        id: "msg-admin",
        conversationId: "conv-1",
        role: "admin",
        content: "Need English Monday",
        structuredPayload: null,
        model: null,
        latencyMs: null,
        createdByEmail: "admin@example.com",
        createdByName: "Admin",
        createdAt: "2026-05-18T00:00:00.000Z",
      })
      .mockResolvedValueOnce({
        id: "msg-assistant",
        conversationId: "conv-1",
        role: "assistant",
        content: "I found options.",
        structuredPayload: {},
        model: "gpt-5.4-mini",
        latencyMs: 10,
        createdByEmail: null,
        createdByName: "AI Scheduler",
        createdAt: "2026-05-18T00:00:01.000Z",
      });
    vi.mocked(touchSchedulerConversationAfterMessage).mockResolvedValue({ ...conversation, title: "Ava English" });
    vi.mocked(logSchedulerRun).mockResolvedValue("run-1");
  });

  it("persists admin and assistant messages around a solved scheduler turn", async () => {
    const response = await POST(request({ content: "Need English Monday" }), ctx);

    expect(response.status).toBe(200);
    expect(createSchedulerMessage).toHaveBeenNthCalledWith(1, expect.anything(), expect.objectContaining({
      conversationId: "conv-1",
      role: "admin",
      content: "Need English Monday",
      actor: { email: "admin@example.com", name: "Admin" },
    }));
    expect(createSchedulerMessage).toHaveBeenNthCalledWith(2, expect.anything(), expect.objectContaining({
      conversationId: "conv-1",
      role: "assistant",
      content: "I found options.",
      model: "gpt-5.4-mini",
    }));
    expect(logSchedulerRun).toHaveBeenCalledWith(expect.anything(), expect.objectContaining({
      conversationId: "conv-1",
      messageId: "msg-assistant",
      status: "solved",
    }));
    await expect(response.json()).resolves.toMatchObject({
      logId: "run-1",
      messages: [{ id: "msg-admin" }, { id: "msg-assistant" }],
    });
  });
});
