import { afterEach, describe, expect, it, vi } from "vitest";
import {
  normalizeAiSchedulerModelParse,
  parseSchedulingRequestWithOpenAi,
  redactAiSchedulerInput,
  resolveAiSchedulerFilters,
  resolveAiSchedulerTutorNames,
} from "@/lib/ai/scheduler";
import type { FilterOptions } from "@/lib/data/filters";
import type { TutorListItem } from "@/lib/data/tutors";

const filterOptions: FilterOptions = {
  subjects: ["English", "Math"],
  curriculums: ["International", "Thai"],
  levels: ["Year 5", "Grade 10"],
};

const tutorList: TutorListItem[] = [
  { tutorGroupId: "tutor-1", displayName: "Kevin", supportedModes: ["online"], subjects: ["English"] },
  { tutorGroupId: "tutor-2", displayName: "Anna", supportedModes: ["onsite"], subjects: ["Math"] },
  { tutorGroupId: "tutor-3", displayName: "Anne", supportedModes: ["online"], subjects: ["English"] },
];

const originalEnv = {
  OPENAI_API_KEY: process.env.OPENAI_API_KEY,
  ENABLE_AI_SCHEDULER: process.env.ENABLE_AI_SCHEDULER,
  OPENAI_SCHEDULER_MODEL: process.env.OPENAI_SCHEDULER_MODEL,
};

function modelParsed(overrides: Record<string, unknown> = {}) {
  return {
    status: "parsed",
    searchMode: "one_time",
    dayOfWeek: null,
    date: "2026-05-19",
    startTime: "17:00",
    endTime: "20:00",
    durationMinutes: 90,
    mode: "online",
    filters: { subject: "English", curriculum: null, level: "Year 5" },
    tutorNames: ["Kevin"],
    assumptions: ["Parent asked for after school, interpreted as 17:00-20:00."],
    parentRequestSummary: "Year 5 English online request",
    warnings: [],
    clarifyingQuestions: [],
    partial: {
      searchMode: null,
      dayOfWeek: null,
      date: null,
      startTime: null,
      endTime: null,
      durationMinutes: null,
      mode: null,
      filters: null,
      tutorNames: null,
      assumptions: null,
      parentRequestSummary: null,
    },
    ...overrides,
  };
}

describe("AI scheduler helpers", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
    for (const [key, value] of Object.entries(originalEnv)) {
      if (value === undefined) {
        delete process.env[key];
      } else {
        process.env[key] = value;
      }
    }
  });

  it("normalizes a valid bounded parent request parse", () => {
    const parsed = normalizeAiSchedulerModelParse(modelParsed());

    expect(parsed.status).toBe("parsed");
    if (parsed.status === "parsed") {
      expect(parsed.searchMode).toBe("one_time");
      expect(parsed.date).toBe("2026-05-19");
      expect(parsed.startTime).toBe("17:00");
      expect(parsed.durationMinutes).toBe(90);
      expect(parsed.tutorNames).toEqual(["Kevin"]);
    }
  });

  it("converts missing day, time, or duration into clarification", () => {
    const missingDuration = normalizeAiSchedulerModelParse(modelParsed({ durationMinutes: null }));
    expect(missingDuration.status).toBe("needs_clarification");
    if (missingDuration.status === "needs_clarification") {
      expect(missingDuration.clarifyingQuestions.join(" ")).toMatch(/How long/);
    }

    const missingDate = normalizeAiSchedulerModelParse(modelParsed({ date: null }));
    expect(missingDate.status).toBe("needs_clarification");

    const missingTime = normalizeAiSchedulerModelParse(modelParsed({ startTime: null }));
    expect(missingTime.status).toBe("needs_clarification");
  });

  it("defaults missing delivery mode to either with a warning", () => {
    const parsed = normalizeAiSchedulerModelParse(modelParsed({ mode: null }));

    expect(parsed.status).toBe("parsed");
    if (parsed.status === "parsed") {
      expect(parsed.mode).toBe("either");
      expect(parsed.warnings[0]).toMatch(/both online and onsite/);
    }
  });

  it("rejects inactive filters and ambiguous tutor names for clarification", () => {
    const filterResult = resolveAiSchedulerFilters({ subject: "Physics", level: "year 5" }, filterOptions);
    expect(filterResult.filters).toEqual({ level: "Year 5" });
    expect(filterResult.issues[0]).toMatch(/not an active Wise qualification/);

    expect(resolveAiSchedulerTutorNames(["Ann"], tutorList).issues[0]).toMatch(/matched multiple/);
    expect(resolveAiSchedulerTutorNames(["Missing"], tutorList).issues[0]).toMatch(/did not match/);
  });

  it("redacts parent contact details in audit previews", () => {
    const redacted = redactAiSchedulerInput(
      "Parent beam@example.com called +66 81 234 5678 about student 123456789 for 2026-05-19",
    );

    expect(redacted).toContain("[email]");
    expect(redacted).toContain("[phone]");
    expect(redacted).toContain("[number]");
    expect(redacted).toContain("2026-05-19");
  });

  it("uses the Responses API with store disabled", async () => {
    process.env.OPENAI_API_KEY = "test-key";
    process.env.ENABLE_AI_SCHEDULER = "true";
    process.env.OPENAI_SCHEDULER_MODEL = "gpt-5.4-mini";
    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({ output_text: JSON.stringify(modelParsed()) }),
    });
    vi.stubGlobal("fetch", fetchMock);

    await expect(parseSchedulingRequestWithOpenAi({
      adminInput: "Need Year 5 English online next Tuesday 5-8pm for 90 minutes",
      todayBangkok: "2026-05-18",
      filterOptions,
      tutorList,
    })).resolves.toMatchObject({ status: "parsed" });

    const body = JSON.parse(fetchMock.mock.calls[0][1].body as string);
    expect(fetchMock.mock.calls[0][0]).toBe("https://api.openai.com/v1/responses");
    expect(body.model).toBe("gpt-5.4-mini");
    expect(body.store).toBe(false);
    expect(body.text.format.type).toBe("json_schema");
  });
});
