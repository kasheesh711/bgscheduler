import { describe, expect, it } from "vitest";
import { DEFAULT_WEIGHTS, type Stage } from "../model";
import { buildInsights, readyToInvite } from "../insights";
import type { Assessment } from "../scoring";

const assessment = (
  result: Assessment["criteria"][number]["result"],
  degree = result,
): Assessment => ({
  criteria: (["degree", "subject", "curriculum", "teaching", "english"] as const).map((id) => ({
    id,
    result: id === "degree" ? degree : result,
    evidence: "quote",
    reason: "reason",
  })),
  subjects: [{ subject: "Physics", evidence: "quote", relevant: true }],
  universities: [],
  summary: "",
});
const candidate = (id: string, stage: Stage, overrides = {}) => ({
  id,
  stage,
  email: `${id}@example.com`,
  preScreen: null as unknown,
  profileScore: null as number | null,
  profileAssessment: null as Assessment | null,
  universityAssessment: null,
  subjects: [],
  paperPassedSubjects: [],
  previouslyContacted: false,
  workRightsConfirmed: true as boolean | null,
  ...overrides,
});
const config = {
  profileThreshold: 60,
  profileWeights: DEFAULT_WEIGHTS,
  interviewers: [{ canonicalKey: "Peat", email: "p@example.com", subjects: ["Physics" as const] }],
};

describe("readyToInvite", () => {
  const strong = { profileAssessment: assessment("met") };
  it("accepts a new profile that meets the worker's gate", () => {
    expect(readyToInvite(candidate("a", "new", strong), config)).toBe(true);
  });
  it.each([
    ["a later stage", candidate("a", "review", strong)],
    ["prior contact", candidate("a", "new", { ...strong, previouslyContacted: true })],
    ["unconfirmed work rights", candidate("a", "new", { ...strong, workRightsConfirmed: null })],
    ["no email", candidate("a", "new", { ...strong, email: null })],
    ["no assessment", candidate("a", "new")],
    ["a tracker pre-screen, which takes the worker's other path", candidate("a", "new", { ...strong, preScreen: {} })],
    ["a partial degree", candidate("a", "new", { profileAssessment: assessment("met", "partial") })],
  ])("rejects %s", (_name, value) => {
    expect(readyToInvite(value, config)).toBe(false);
  });
});

describe("buildInsights", () => {
  const now = new Date("2026-10-31T00:00:00Z");
  const empty = { config, candidates: [], bookings: [], outbox: [] };

  it("has no median or weakest criterion without scores", () => {
    const result = buildInsights(empty, now);
    expect(result.median).toBeNull();
    expect(result.weakest).toBeNull();
    expect(result.total).toBe(0);
  });

  it("counts stages as current and reached, excluding stopped candidates", () => {
    const result = buildInsights(
      {
        ...empty,
        candidates: [
          candidate("a", "new"),
          candidate("b", "review"),
          candidate("c", "paper_invited"),
          candidate("d", "mock_booked"),
          candidate("e", "stopped"),
        ],
      },
      now,
    );
    expect(result.active).toBe(4);
    expect(result.stopped).toBe(1);
    expect(result.pastReview).toBe(2);
    expect(result.stages.find((s) => s.stage === "new")).toMatchObject({ at: 1, reached: 4 });
    expect(result.stages.find((s) => s.stage === "paper_invited")).toMatchObject({ at: 1, reached: 2 });
  });

  it("buckets scores, keeps 100 in the top bucket and takes the even median", () => {
    const scored = [0, 59.5, 60, 100].map((profileScore, i) =>
      candidate(String(i), "review", { profileScore }),
    );
    const result = buildInsights({ ...empty, candidates: scored }, now);
    expect(result.histogram.map((b) => b.count)).toEqual([1, 0, 0, 0, 0, 1, 1, 0, 0, 1]);
    expect(result.aboveThreshold).toBe(2);
    expect(result.median).toBe(59.75);
    expect(result.unscored).toBe(0);
  });

  it("names the criterion with the lowest share met", () => {
    const result = buildInsights(
      {
        ...empty,
        candidates: [
          candidate("a", "review", { profileScore: 80, profileAssessment: assessment("met", "not_met") }),
        ],
      },
      now,
    );
    expect(result.weakest?.id).toBe("degree");
    expect(result.evidence[1].counts.met).toBe(1);
  });

  it("flags booked stages with no reservation and only counts future confirmed appointments", () => {
    const bookings = [
      { candidateId: "a", kind: "mock" as const, interviewerKey: "Peat", status: "confirmed", startTime: "2026-11-02T03:00:00Z" },
      { candidateId: "c", kind: "paper" as const, interviewerKey: "Peat", status: "confirmed", startTime: "2026-12-02T03:00:00Z" },
      { candidateId: "d", kind: "mock" as const, interviewerKey: "Peat", status: "confirmed", startTime: "2026-10-01T03:00:00Z" },
      { candidateId: "b", kind: "paper" as const, interviewerKey: "Peat", status: "cancelled", startTime: "2026-11-02T03:00:00Z" },
    ];
    const result = buildInsights(
      {
        ...empty,
        bookings,
        // c holds a paper booking only, so its mock stage has no reservation.
        candidates: [candidate("a", "mock_booked"), candidate("b", "paper_booked"), candidate("c", "mock_booked")],
        outbox: [{ status: "sent" }, { status: "failed" }, { status: "uncertain" }, { status: "pending" }],
      },
      now,
    );
    expect(result.appointmentsThisWeek).toBe(1);
    expect(result.upcomingByInterviewer.Peat).toBe(2);
    expect(result.bookedWithoutAppointment).toBe(2);
    expect(result.messages).toEqual({ sent: 1, waiting: 1, problems: 2 });
  });

  it("reports subjects with no interviewer", () => {
    const result = buildInsights({ ...empty, candidates: [] }, now);
    expect(result.uncoveredSubjects).toBe(17);
    expect(result.subjects.find((s) => s.subject === "Physics")?.interviewers).toEqual(["Peat"]);
  });
});
