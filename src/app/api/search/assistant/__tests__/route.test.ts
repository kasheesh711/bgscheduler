import { beforeEach, describe, expect, it, vi, type Mock } from "vitest";
import { NextRequest } from "next/server";

vi.mock("@/lib/auth", () => ({ auth: vi.fn() }));
vi.mock("@/lib/db", () => ({ getDb: vi.fn(() => ({ db: true })) }));
vi.mock("@/lib/ai/scheduler", async () => {
  const actual = await vi.importActual<typeof import("@/lib/ai/scheduler")>("@/lib/ai/scheduler");
  return {
    ...actual,
    aiSchedulerModel: vi.fn(() => "gpt-5.4-mini"),
    isAiSchedulerConfigured: vi.fn(() => true),
    redactAiSchedulerInput: vi.fn((input: string) => input),
  };
});
vi.mock("@/lib/ai/scheduler-data", () => ({
  logSchedulerRun: vi.fn(),
}));
vi.mock("@/lib/ai/scheduler-service", () => ({
  executeSchedulerTurn: vi.fn(),
  schedulerRunMetadata: vi.fn((latencyBreakdownMs) => ({
    schedulerVersion: "scheduler-test",
    promptVersion: "prompt-test",
    latencyBreakdownMs,
  })),
}));

import { auth } from "@/lib/auth";
import { isAiSchedulerConfigured } from "@/lib/ai/scheduler";
import { logSchedulerRun } from "@/lib/ai/scheduler-data";
import { executeSchedulerTurn } from "@/lib/ai/scheduler-service";
import { POST } from "@/app/api/search/assistant/route";

const authMock = auth as unknown as Mock;

function makeRequest(body: unknown): NextRequest {
  return new NextRequest("http://localhost/api/search/assistant", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
}

function schedulerResult(overrides: Partial<Awaited<ReturnType<typeof executeSchedulerTurn>>["assistantResult"]> = {}) {
  return {
    state: {
      searchMode: "recurring" as const,
      dayOfWeek: 1,
      durationMinutes: 60 as const,
      mode: "either" as const,
      filters: { subject: "English" },
      subjectRequests: [],
      businessRequirements: {},
      requestedSlots: [
        { searchMode: "recurring" as const, dayOfWeek: 1, startTime: "15:00", endTime: "16:00", durationMinutes: 60 as const },
      ],
      explicitUnknownFilters: [],
      explicitUnknownBusinessRequirements: [],
      tutorNames: [],
      tutorExclusions: [],
      negativeFeedback: false,
      assumptions: [],
      unresolvedQuestions: [],
    },
    suggestions: [
      {
        id: "suggestion-1",
        rank: 1,
        searchMode: "recurring" as const,
        dayOfWeek: 1,
        start: "15:00",
        end: "16:00",
        durationMinutes: 60 as const,
        mode: "either" as const,
        confidence: "Best fit" as const,
        tutors: [{ tutorGroupId: "tutor-1", displayName: "Kevin", supportedModes: ["online"] }],
        availableTutorCount: 1,
        reasons: ["1 proven available tutor"],
        parentReady: true,
      },
    ],
    constraintLedger: [
      {
        key: "slot" as const,
        label: "Day/date and time",
        requested: "Monday 15:00",
        normalized: "Monday 15:00-16:00 60 min",
        evidence: "model" as const,
        status: "proven" as const,
        message: "Constraint is represented in normalized scheduler state.",
      },
    ],
    parentMessageDraft: "Draft with Kevin",
    assistantMessage: "I found 1 proven option.",
    snapshotMeta: { snapshotId: "snap-1", syncedAt: "2026-05-18T00:00:00.000Z", stale: false },
    warnings: [],
    questions: [],
    parentReady: true,
    ...overrides,
  };
}

function mockExecution(result = schedulerResult()) {
  vi.mocked(executeSchedulerTurn).mockResolvedValue({
    index: {
      snapshotId: "snap-1",
      profileVersion: "0:",
      builtAt: new Date("2026-05-18T00:00:00.000Z"),
      syncedAt: new Date("2026-05-18T00:00:00.000Z"),
      tutorGroups: [],
      byWeekday: new Map(),
    },
    extraction: { state: result.state, title: "English Monday" },
    mergedState: result.state,
    assistantResult: result,
    latencyBreakdownMs: { totalMs: 12, dbMs: 2, modelMs: 8, searchMs: 2 },
  });
}

describe("POST /api/search/assistant", () => {
  beforeEach(() => {
    vi.resetAllMocks();
    authMock.mockResolvedValue({ user: { email: "admin@example.com" } });
    vi.mocked(isAiSchedulerConfigured).mockReturnValue(true);
    vi.mocked(logSchedulerRun).mockResolvedValue("log-1");
    mockExecution();
  });

  it("returns 401 when unauthenticated", async () => {
    authMock.mockResolvedValue(null);

    const res = await POST(makeRequest({ input: "Need English Monday" }));

    expect(res.status).toBe(401);
    await expect(res.json()).resolves.toEqual({ error: "Unauthorized" });
  });

  it("returns 503 when AI scheduler is not configured", async () => {
    vi.mocked(isAiSchedulerConfigured).mockReturnValue(false);

    const res = await POST(makeRequest({ input: "Need English Monday" }));

    expect(res.status).toBe(503);
    await expect(res.json()).resolves.toEqual({ error: "AI scheduler is not configured" });
    expect(executeSchedulerTurn).not.toHaveBeenCalled();
  });

  it("adapts shared scheduler suggestions to the legacy solved response shape", async () => {
    const res = await POST(makeRequest({ input: "Need English Monday 3pm" }));

    expect(res.status).toBe(200);
    expect(executeSchedulerTurn).toHaveBeenCalledWith(expect.objectContaining({
      currentState: {},
      messages: [{ role: "admin", content: "Need English Monday 3pm" }],
      sourceText: "Need English Monday 3pm",
    }));
    expect(logSchedulerRun).toHaveBeenCalledWith(expect.anything(), expect.objectContaining({
      status: "solved",
      schedulerVersion: "scheduler-test",
      promptVersion: "prompt-test",
      latencyBreakdownMs: { totalMs: 12, dbMs: 2, modelMs: 8, searchMs: 2 },
    }));
    await expect(res.json()).resolves.toMatchObject({
      status: "solved",
      parsedRequest: {
        searchMode: "recurring",
        dayOfWeek: 1,
        startTime: "15:00",
        endTime: "16:00",
      },
      options: [
        {
          start: "15:00",
          tutors: [{ tutorGroupId: "tutor-1", displayName: "Kevin" }],
        },
      ],
      parentMessageDraft: "Draft with Kevin",
      logId: "log-1",
    });
  });

  it("returns clarification when the shared scheduler is not parent-ready", async () => {
    mockExecution(schedulerResult({
      suggestions: [],
      questions: ["Which weekday or exact date should I search for that time?"],
      parentReady: false,
      state: {
        ...schedulerResult().state,
        requestedSlots: [],
        unresolvedQuestions: ["Which weekday or exact date should I search for that time?"],
      },
    }));

    const res = await POST(makeRequest({ input: "Need English 3pm" }));

    expect(res.status).toBe(200);
    await expect(res.json()).resolves.toMatchObject({
      status: "needs_clarification",
      clarifyingQuestions: ["Which weekday or exact date should I search for that time?"],
      logId: "log-1",
    });
  });
});
