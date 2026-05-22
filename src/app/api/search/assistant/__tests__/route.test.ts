import { beforeEach, describe, expect, it, vi, type Mock } from "vitest";
import { NextRequest } from "next/server";

vi.mock("@/lib/auth", () => ({ auth: vi.fn() }));
vi.mock("@/lib/db", () => ({ getDb: vi.fn() }));
vi.mock("@/lib/data/filters", () => ({ loadFilterOptions: vi.fn() }));
vi.mock("@/lib/data/tutors", () => ({ loadTutorList: vi.fn() }));
vi.mock("@/lib/search/range-search", () => ({ executeRangeSearch: vi.fn() }));
vi.mock("@/lib/search/index", () => ({ ensureIndex: vi.fn() }));
vi.mock("@/lib/proposals/data", () => ({ listActiveProposalHolds: vi.fn() }));
vi.mock("@/lib/ai/scheduler-conversation", () => ({
  filterOptionsFromIndex: vi.fn(),
  solveSchedulerTurn: vi.fn(),
  tutorListFromIndex: vi.fn(),
}));
vi.mock("@/lib/ai/scheduler", async () => {
  const actual = await vi.importActual<typeof import("@/lib/ai/scheduler")>("@/lib/ai/scheduler");
  return {
    ...actual,
    aiSchedulerModel: vi.fn(),
    bangkokTodayIso: vi.fn(),
    isAiSchedulerConfigured: vi.fn(),
    parseSchedulingRequestWithOpenAi: vi.fn(),
  };
});

import { auth } from "@/lib/auth";
import { getDb } from "@/lib/db";
import { loadFilterOptions } from "@/lib/data/filters";
import { loadTutorList } from "@/lib/data/tutors";
import { executeRangeSearch } from "@/lib/search/range-search";
import { ensureIndex } from "@/lib/search/index";
import { listActiveProposalHolds } from "@/lib/proposals/data";
import {
  filterOptionsFromIndex,
  solveSchedulerTurn,
  tutorListFromIndex,
} from "@/lib/ai/scheduler-conversation";
import {
  aiSchedulerModel,
  bangkokTodayIso,
  isAiSchedulerConfigured,
  parseSchedulingRequestWithOpenAi,
} from "@/lib/ai/scheduler";
import { POST } from "@/app/api/search/assistant/route";

const authMock = auth as unknown as Mock;

const filters = {
  subjects: ["English", "Math", "EFL", "ESL", "Literature"],
  curriculums: ["International", "Thai"],
  levels: ["Year 5", "Grade 10", "Y2-8"],
};

const tutors = [
  { tutorGroupId: "tutor-1", displayName: "Kevin", supportedModes: ["online"], subjects: ["English"] },
  { tutorGroupId: "tutor-2", displayName: "Anna", supportedModes: ["onsite"], subjects: ["Math"] },
  { tutorGroupId: "tutor-3", displayName: "Anne", supportedModes: ["online"], subjects: ["English"] },
  { tutorGroupId: "tutor-4", displayName: "Eng", supportedModes: ["online", "onsite"], subjects: ["EFL", "ESL"] },
];

const index = {
  snapshotId: "snap-1",
  profileVersion: "67:2026-05-21 16:21:35.042+00",
  builtAt: new Date("2026-05-18T00:00:00.000Z"),
  syncedAt: new Date("2026-05-18T00:00:00.000Z"),
  tutorGroups: [],
  byWeekday: new Map(),
};

const parsedRequest = {
  status: "parsed" as const,
  searchMode: "one_time" as const,
  date: "2026-05-19",
  startTime: "17:00",
  endTime: "20:00",
  durationMinutes: 90 as const,
  mode: "online" as const,
  filters: { subject: "english", level: "year 5" },
  tutorNames: ["Kevin"],
  assumptions: ["Interpreted after school as 17:00-20:00."],
  parentRequestSummary: "Year 5 English online request",
  warnings: [],
};

const rangeResponse = {
  snapshotMeta: { snapshotId: "snap-1", syncedAt: "2026-05-18T00:00:00.000Z", stale: false },
  subSlots: [
    { start: "17:00", end: "18:30" },
    { start: "18:30", end: "20:00" },
  ],
  grid: [
    {
      tutorGroupId: "tutor-1",
      tutorCanonicalKey: "kevin",
      displayName: "Kevin",
      supportedModes: ["online"],
      qualifications: [{ subject: "English", curriculum: "International", level: "Year 5" }],
      availability: [true, []],
    },
  ],
  needsReview: [],
  latencyMs: 8,
  warnings: [],
};

function makeRequest(body: unknown): NextRequest {
  return new NextRequest("http://localhost/api/search/assistant", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
}

function makeDb() {
  const returning = vi.fn().mockResolvedValue([{ id: "log-1" }]);
  const values = vi.fn(() => ({ returning }));
  const insert = vi.fn(() => ({ values }));
  return { db: { insert }, insert, values, returning };
}

describe("POST /api/search/assistant", () => {
  beforeEach(() => {
    vi.resetAllMocks();
    authMock.mockResolvedValue({ user: { email: "admin@example.com" } });
    vi.mocked(isAiSchedulerConfigured).mockReturnValue(true);
    vi.mocked(aiSchedulerModel).mockReturnValue("gpt-5.4-mini");
    vi.mocked(bangkokTodayIso).mockReturnValue("2026-05-18");
    vi.mocked(loadFilterOptions).mockResolvedValue(filters);
    vi.mocked(loadTutorList).mockResolvedValue(tutors);
    vi.mocked(ensureIndex).mockResolvedValue(index as never);
    vi.mocked(filterOptionsFromIndex).mockReturnValue(filters);
    vi.mocked(tutorListFromIndex).mockReturnValue(tutors);
    vi.mocked(listActiveProposalHolds).mockResolvedValue([]);
    vi.mocked(solveSchedulerTurn).mockReturnValue({
      state: {
        searchMode: "recurring",
        durationMinutes: 60,
        mode: "either",
        filters: {},
        subjectRequests: [],
        businessRequirements: {},
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
      parentMessageDraft: "",
      assistantMessage: "",
      snapshotMeta: { snapshotId: "snap-1", syncedAt: "2026-05-18T00:00:00.000Z", stale: false },
      warnings: [],
      questions: [],
      parentReady: false,
    });
    vi.mocked(parseSchedulingRequestWithOpenAi).mockResolvedValue(parsedRequest);
    vi.mocked(executeRangeSearch).mockResolvedValue(rangeResponse as never);
    const { db } = makeDb();
    vi.mocked(getDb).mockReturnValue(db as never);
  });

  it("returns 401 when unauthenticated", async () => {
    authMock.mockResolvedValue(null);

    const res = await POST(makeRequest({ input: "Need English next Tuesday 5-8pm for 90 minutes" }));

    expect(res.status).toBe(401);
    await expect(res.json()).resolves.toEqual({ error: "Unauthorized" });
  });

  it("returns 503 when AI scheduler is not configured", async () => {
    vi.mocked(isAiSchedulerConfigured).mockReturnValue(false);

    const res = await POST(makeRequest({ input: "Need English next Tuesday 5-8pm for 90 minutes" }));

    expect(res.status).toBe(503);
    await expect(res.json()).resolves.toEqual({ error: "AI scheduler is not configured" });
    expect(parseSchedulingRequestWithOpenAi).not.toHaveBeenCalled();
  });

  it("runs deterministic range search and returns only proven available options", async () => {
    const res = await POST(makeRequest({ input: "Need Year 5 English online next Tuesday 5-8pm for 90 minutes with Kevin" }));

    expect(res.status).toBe(200);
    expect(executeRangeSearch).toHaveBeenCalledWith(expect.anything(), expect.objectContaining({
      searchMode: "one_time",
      date: "2026-05-19",
      startTime: "17:00",
      endTime: "20:00",
      durationMinutes: 90,
      mode: "online",
      filters: { subject: "English", level: "Year 5" },
      tutorGroupIds: ["tutor-1"],
    }));
    await expect(res.json()).resolves.toMatchObject({
      status: "solved",
      parsedRequest: {
        tutorGroupIds: ["tutor-1"],
        matchedTutors: [{ tutorGroupId: "tutor-1", displayName: "Kevin" }],
      },
      options: [
        expect.objectContaining({
          start: "17:00",
          tutors: [{ tutorGroupId: "tutor-1", displayName: "Kevin", supportedModes: ["online"] }],
        }),
      ],
      parentMessageDraft: expect.stringContaining("Kevin"),
      logId: "log-1",
    });
  });

  it("returns broad deterministic availability summaries without asking for day/time", async () => {
    vi.mocked(solveSchedulerTurn).mockReturnValue({
      state: {
        searchMode: "recurring",
        durationMinutes: 60,
        mode: "either",
        filters: { subject: "EFL", curriculum: "International", level: "Y2-8" },
        subjectIntent: {
          family: "english",
          label: "English-family",
          canonicalSubjects: ["EFL", "ESL", "Literature"],
          skillTags: ["writing"],
          curriculum: "International",
          level: "Y2-8",
          source: "deterministic",
        },
        subjectRequests: [
          { subject: "EFL", curriculum: "International", level: "Y2-8" },
          { subject: "ESL", curriculum: "International", level: "Y2-8" },
          { subject: "Literature", curriculum: "International", level: "Y2-8" },
        ],
        businessRequirements: {},
        dateRange: { startDate: "2026-07-01", endDate: "2026-07-07" },
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
      availabilitySummary: {
        dateRange: { startDate: "2026-07-01", endDate: "2026-07-07" },
        filters: { subject: "EFL", curriculum: "International", level: "Y2-8" },
        searchedFilters: [
          { subject: "EFL", curriculum: "International", level: "Y2-8" },
          { subject: "ESL", curriculum: "International", level: "Y2-8" },
          { subject: "Literature", curriculum: "International", level: "Y2-8" },
        ],
        subjectIntent: {
          family: "english",
          label: "English-family",
          canonicalSubjects: ["EFL", "ESL", "Literature"],
          skillTags: ["writing"],
          curriculum: "International",
          level: "Y2-8",
          source: "deterministic",
        },
        durationMinutes: 60,
        mode: "either",
        searchProvenance: {
          snapshotId: "snap-1",
          profileVersion: "67:2026-05-21 16:21:35.042+00",
          activeProposalHoldCount: 0,
        },
        tutors: [
          {
            tutorGroupId: "tutor-4",
            displayName: "Eng",
            supportedModes: ["online", "onsite"],
            matchedSubjects: ["EFL", "ESL"],
            windows: [
              { date: "2026-07-01", weekday: 3, start: "10:00", end: "11:00", mode: "either" },
            ],
          },
        ],
        needsReview: [],
      },
      parentMessageDraft: "Hi! I found confirmed English-family availability.",
      assistantMessage: "I searched EFL, ESL, Literature Y2-8 International and found 1 qualified tutor.",
      snapshotMeta: { snapshotId: "snap-1", syncedAt: "2026-05-18T00:00:00.000Z", stale: false },
      warnings: [],
      questions: [],
      parentReady: true,
    });

    const res = await POST(makeRequest({ input: "หาครูสอนวิชา writing y6 ช่วง Week แรกของ July" }));

    expect(res.status).toBe(200);
    expect(parseSchedulingRequestWithOpenAi).not.toHaveBeenCalled();
    expect(executeRangeSearch).not.toHaveBeenCalled();
    await expect(res.json()).resolves.toMatchObject({
      status: "availability_summary",
      availabilitySummary: {
        searchedFilters: [
          { subject: "EFL", curriculum: "International", level: "Y2-8" },
          { subject: "ESL", curriculum: "International", level: "Y2-8" },
          { subject: "Literature", curriculum: "International", level: "Y2-8" },
        ],
        tutors: [{ displayName: "Eng" }],
      },
      parentMessageDraft: expect.stringContaining("English-family"),
      logId: "log-1",
    });
  });

  it("returns clarification when parsed tutor names are ambiguous", async () => {
    vi.mocked(parseSchedulingRequestWithOpenAi).mockResolvedValue({
      ...parsedRequest,
      tutorNames: ["Ann"],
    });

    const res = await POST(makeRequest({ input: "Need English next Tuesday 5-8pm with Ann" }));

    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.status).toBe("needs_clarification");
    expect(body.clarifyingQuestions[0]).toMatch(/matched multiple/);
    expect(executeRangeSearch).not.toHaveBeenCalled();
  });

  it("returns 502 and logs when OpenAI parsing fails", async () => {
    const { db, values } = makeDb();
    vi.mocked(getDb).mockReturnValue(db as never);
    vi.mocked(parseSchedulingRequestWithOpenAi).mockRejectedValue(new Error("OpenAI returned HTTP 500"));

    const res = await POST(makeRequest({ input: "Need English next Tuesday 5-8pm" }));

    expect(res.status).toBe(502);
    await expect(res.json()).resolves.toMatchObject({
      error: "AI scheduling failed",
      detail: "OpenAI returned HTTP 500",
      logId: "log-1",
    });
    expect(values).toHaveBeenCalledWith(expect.objectContaining({
      status: "failed",
      errorMessage: "OpenAI returned HTTP 500",
      inputPreviewRedacted: expect.any(String),
    }));
  });
});
