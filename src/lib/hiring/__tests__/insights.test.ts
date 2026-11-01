import { describe, expect, it } from "vitest";
import { DEFAULT_WEIGHTS, type Stage } from "../model";
import { buildInsights, criterionValues, readyToInvite } from "../insights";
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
  workRightsAnswer: "I have permanent work rights with no restrictions" as string | null,
  ...overrides,
});
const config = {
  profileThreshold: 60,
  profileWeights: DEFAULT_WEIGHTS,
  acceptedWorkRights: ["I have permanent work rights with no restrictions"],
  subjectPriority: [{ subject: "Physics" as const, hiring: true }],
  interviewers: [{ canonicalKey: "Peat", email: "p@example.com", subjects: ["Physics" as const] }],
};

describe("readyToInvite", () => {
  const strong = { profileAssessment: assessment("met") };
  it("accepts a new profile that meets the worker's gate", () => {
    expect(readyToInvite(candidate("a", "new", strong), config)).toBe(true);
  });
  it("accepts a partial degree, which the old rule refused", () => {
    expect(readyToInvite(candidate("a", "new", { profileAssessment: assessment("met", "partial") }), config)).toBe(true);
  });
  it.each([
    ["a later stage", candidate("a", "review", strong)],
    ["prior contact", candidate("a", "new", { ...strong, previouslyContacted: true })],
    ["a missing work-rights answer", candidate("a", "new", { ...strong, workRightsAnswer: null })],
    ["an unaccepted work-rights answer", candidate("a", "new", { ...strong, workRightsAnswer: "I am a long term / permanent resident with eligibility for a work permit" })],
    ["no email", candidate("a", "new", { ...strong, email: null })],
    ["no assessment", candidate("a", "new")],
    ["a tracker pre-screen, which takes the worker's other path", candidate("a", "new", { ...strong, preScreen: {} })],
    ["a degree that is not met", candidate("a", "new", { profileAssessment: assessment("met", "not_met") })],
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

describe("criterionValues", () => {
  it("maps results to values in DSCTE order", () => {
    const a = assessment("met");
    const set = (id: string, result: Assessment["criteria"][number]["result"]) => {
      a.criteria.find((c) => c.id === id)!.result = result;
    };
    set("subject", "partial");
    set("curriculum", "unknown");
    set("teaching", "not_met");
    expect(criterionValues(a)).toEqual([1, 0.5, 0, 0, 1]);
  });
});

describe("buildInsights with the visit stages", () => {
  const now = new Date("2026-10-31T00:00:00Z");
  const empty = { config, candidates: [], bookings: [], outbox: [] };
  const stage = (result: ReturnType<typeof buildInsights>, name: Stage) => result.stages.find((s) => s.stage === name)!;
  const people = [
    candidate("a", "pre_screen"),
    candidate("b", "onsite_invited"),
    candidate("c", "onsite_booked"),
    candidate("d", "paper_invited"),
    candidate("e", "no_reply"),
    candidate("f", "no_booking"),
  ];

  it("does not count an onsite candidate as having reached a paper step it never takes", () => {
    const result = buildInsights({ ...empty, candidates: people }, now);
    // Only the old-flow candidate is at or past paper invited.
    expect(stage(result, "paper_invited")).toMatchObject({ at: 1, reached: 1 });
    expect(stage(result, "paper_booked").reached).toBe(0);
    expect(stage(result, "mock_booked").reached).toBe(0);
  });

  it("counts a candidate as having reached the onsite invitation when invited, booked or left with no booking", () => {
    const result = buildInsights({ ...empty, candidates: people }, now);
    expect(stage(result, "onsite_invited")).toMatchObject({ at: 1, reached: 3 });
    expect(stage(result, "onsite_booked")).toMatchObject({ at: 1, reached: 1 });
  });

  it("counts a no reply or no booking candidate as past review, because the form or link went out", () => {
    const result = buildInsights({ ...empty, candidates: people }, now);
    expect(result.pastReview).toBe(6);
    expect(stage(result, "pre_screen").reached).toBe(6);
    expect(stage(result, "new").reached).toBe(6);
  });

  it("keeps no reply and no booking in active, and shows how many of the active are parked", () => {
    const result = buildInsights({ ...empty, candidates: [...people, candidate("g", "stopped")] }, now);
    expect(result.active).toBe(6);
    expect(result.parked).toBe(2);
    expect(result.stopped).toBe(1);
    expect(result.byStage).toMatchObject({ no_reply: 1, no_booking: 1, onsite_invited: 1, stopped: 1 });
  });

  it("counts a visit once, not once for the exam and once for the mock", () => {
    const row = (kind: "paper" | "mock", start: string, visitId: string | null, candidateId = "a") => ({
      candidateId,
      kind,
      interviewerKey: kind === "mock" ? "Peat" : null,
      status: "confirmed",
      startTime: start,
      visitId,
    });
    const result = buildInsights(
      {
        ...empty,
        bookings: [
          row("paper", "2026-11-02T03:00:00Z", "v1"),
          row("mock", "2026-11-02T05:00:00Z", "v1"),
          row("paper", "2026-11-03T03:00:00Z", "v2", "b"),
          row("mock", "2026-11-03T05:00:00Z", "v2", "b"),
          // Next week.
          row("paper", "2026-12-03T03:00:00Z", "v3", "c"),
          row("mock", "2026-12-03T05:00:00Z", "v3", "c"),
          // Old flow: two separate appointments, as before.
          row("paper", "2026-11-04T03:00:00Z", null, "d"),
          row("mock", "2026-11-04T08:00:00Z", null, "d"),
        ],
      },
      now,
    );
    expect(result.appointmentsThisWeek).toBe(4);
    // The head is on the mock row only.
    expect(result.upcomingByInterviewer.Peat).toBe(4);
  });
});
