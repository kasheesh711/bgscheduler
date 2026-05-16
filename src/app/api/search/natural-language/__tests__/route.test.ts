import { beforeEach, describe, expect, it, vi, type Mock } from "vitest";
import { NextRequest } from "next/server";

vi.mock("@/lib/auth", () => ({ auth: vi.fn() }));
vi.mock("@/lib/db", () => ({ getDb: vi.fn() }));
vi.mock("@/lib/data/filters", () => ({ loadFilterOptions: vi.fn() }));
vi.mock("@/lib/data/tutors", () => ({ loadTutorList: vi.fn() }));
vi.mock("@/lib/ai/natural-language-search", () => ({
  isNaturalLanguageSearchConfigured: vi.fn(),
  naturalLanguageSearchModel: vi.fn(),
  parseNaturalLanguageSearchWithOpenAi: vi.fn(),
}));

import { auth } from "@/lib/auth";
import { getDb } from "@/lib/db";
import { loadFilterOptions } from "@/lib/data/filters";
import { loadTutorList } from "@/lib/data/tutors";
import {
  isNaturalLanguageSearchConfigured,
  naturalLanguageSearchModel,
  parseNaturalLanguageSearchWithOpenAi,
} from "@/lib/ai/natural-language-search";
import { POST } from "@/app/api/search/natural-language/route";

const authMock = auth as unknown as Mock;

function makeRequest(body: unknown): NextRequest {
  return new NextRequest("http://localhost/api/search/natural-language", {
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

const filters = {
  subjects: ["English", "Math"],
  curriculums: ["International", "Thai"],
  levels: ["Year 5", "Grade 10"],
};

const tutors = [
  { tutorGroupId: "tutor-1", displayName: "Kevin", supportedModes: ["online"], subjects: ["English"] },
  { tutorGroupId: "tutor-2", displayName: "Anna", supportedModes: ["online"], subjects: ["Math"] },
  { tutorGroupId: "tutor-3", displayName: "Anne", supportedModes: ["onsite"], subjects: ["English"] },
];

const parsedResult = {
  status: "parsed" as const,
  searchMode: "one_time" as const,
  date: "2026-05-19",
  startTime: "17:00",
  endTime: "20:00",
  durationMinutes: 90 as const,
  mode: "online" as const,
  filters: { subject: "english" },
  tutorNames: ["Kevin"],
  warnings: ["Mode inferred from request."],
};

describe("POST /api/search/natural-language", () => {
  beforeEach(() => {
    vi.resetAllMocks();
    authMock.mockResolvedValue({ user: { email: "admin@example.com" } });
    vi.mocked(isNaturalLanguageSearchConfigured).mockReturnValue(true);
    vi.mocked(naturalLanguageSearchModel).mockReturnValue("gpt-5.4-mini");
    vi.mocked(loadFilterOptions).mockResolvedValue(filters);
    vi.mocked(loadTutorList).mockResolvedValue(tutors);
    const { db } = makeDb();
    vi.mocked(getDb).mockReturnValue(db as never);
    vi.mocked(parseNaturalLanguageSearchWithOpenAi).mockResolvedValue(parsedResult);
  });

  it("returns 401 when unauthenticated", async () => {
    authMock.mockResolvedValue(null);

    const res = await POST(makeRequest({ input: "next Tuesday 5-8pm English online 90 min" }));

    expect(res.status).toBe(401);
    await expect(res.json()).resolves.toEqual({ error: "Unauthorized" });
  });

  it("returns 400 for invalid or overlong input", async () => {
    const res = await POST(makeRequest({ input: "" }));

    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.error).toBe("Invalid request");
  });

  it("returns 503 when OpenAI is not configured", async () => {
    vi.mocked(isNaturalLanguageSearchConfigured).mockReturnValue(false);

    const res = await POST(makeRequest({ input: "next Tuesday 5-8pm English online 90 min" }));

    expect(res.status).toBe(503);
    await expect(res.json()).resolves.toEqual({ error: "Natural language search is not configured" });
    expect(parseNaturalLanguageSearchWithOpenAi).not.toHaveBeenCalled();
  });

  it("returns parsed fields with deterministically matched tutor IDs", async () => {
    const res = await POST(makeRequest({ input: "next Tuesday 5-8pm English online 90 min with Kevin" }));

    expect(res.status).toBe(200);
    await expect(res.json()).resolves.toMatchObject({
      status: "parsed",
      parsed: {
        searchMode: "one_time",
        date: "2026-05-19",
        startTime: "17:00",
        endTime: "20:00",
        durationMinutes: 90,
        mode: "online",
        filters: { subject: "English" },
        tutorGroupIds: ["tutor-1"],
        matchedTutors: [{ tutorGroupId: "tutor-1", displayName: "Kevin" }],
      },
      warnings: ["Mode inferred from request."],
      logId: "log-1",
    });
  });

  it("returns clarification when model tutor names are ambiguous", async () => {
    vi.mocked(parseNaturalLanguageSearchWithOpenAi).mockResolvedValue({
      ...parsedResult,
      tutorNames: ["Ann"],
    });

    const res = await POST(makeRequest({ input: "next Tuesday 5-8pm English online 90 min with Ann" }));

    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.status).toBe("needs_clarification");
    expect(body.clarifyingQuestions[0]).toMatch(/matched multiple/);
    expect(body.partial).not.toHaveProperty("tutorGroupIds");
  });

  it("passes through clarification responses without tutor IDs", async () => {
    vi.mocked(parseNaturalLanguageSearchWithOpenAi).mockResolvedValue({
      status: "needs_clarification",
      clarifyingQuestions: ["Do you mean this Tuesday or every Tuesday?"],
      partial: { dayOfWeek: 2, tutorNames: ["Kevin"] },
      warnings: [],
    });

    const res = await POST(makeRequest({ input: "Tuesday with Kevin" }));

    expect(res.status).toBe(200);
    await expect(res.json()).resolves.toMatchObject({
      status: "needs_clarification",
      clarifyingQuestions: ["Do you mean this Tuesday or every Tuesday?"],
      partial: { dayOfWeek: 2, tutorNames: ["Kevin"] },
      logId: "log-1",
    });
  });

  it("returns 502 and logs when model output validation or OpenAI fails", async () => {
    const { db, values } = makeDb();
    vi.mocked(getDb).mockReturnValue(db as never);
    vi.mocked(parseNaturalLanguageSearchWithOpenAi).mockRejectedValue(new Error("Invalid model payload"));

    const res = await POST(makeRequest({ input: "next Tuesday 5-8pm English online 90 min" }));

    expect(res.status).toBe(502);
    await expect(res.json()).resolves.toMatchObject({
      error: "Natural language parsing failed",
      detail: "Invalid model payload",
      logId: "log-1",
    });
    expect(values).toHaveBeenCalledWith(expect.objectContaining({
      status: "failed",
      errorMessage: "Invalid model payload",
      inputPreviewRedacted: expect.any(String),
    }));
  });
});
