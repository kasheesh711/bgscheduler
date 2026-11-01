import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";
import { candidateExtras, type CandidateExtras } from "@/lib/hiring/status";
import { CandidateInspector } from "../candidate-inspector";
import { CandidateTable, matchesFilter } from "../candidate-table";
import { NO_FILTER, type HiringCandidate } from "../dashboard";
import type { Insights } from "../pipeline-charts";

vi.mock("next/font/google", () => ({ Instrument_Serif: () => ({ variable: "" }) }));

const weights = { degree: 20, subject: 20, curriculum: 20, teaching: 20, english: 20, prestige: 0 };
const pre = {
  submittedAt: "31/10/2026, 18:30:05",
  degree: "BSc",
  field: "Physics",
  subjects: "Physics",
  curricula: "IGCSE",
  yearGroups: "Y10",
  english: "C1",
  englishEvidence: "IELTS 8",
  experience: "3 years",
  portfolio: "",
  availability: "Weekday evenings",
  weeklyHours: "12",
  motivation: "MOTIVATION ANSWER",
  teachingApproach: "APPROACH ANSWER",
};
const person = (id: string, extra: Record<string, unknown> = {}) =>
  ({
    id,
    name: `Person ${id}`,
    email: `${id}@example.com`,
    stage: "pre_screen",
    subjects: [],
    sourceIds: [],
    paperPassedSubjects: [],
    previouslyContacted: false,
    workRightsAnswer: "I have permanent work rights with no restrictions",
    workRightsAccepted: true,
    profileScore: 80,
    profileAssessment: null,
    preScreen: null,
    preScreenAssessment: null,
    preScreenScore: null,
    universityAssessment: null,
    updatedAt: "2026-10-30T00:00:00Z",
    ...extra,
  }) as unknown as HiringCandidate;
const job = (candidateId: string, suffix: string, sentAt: string) => ({
  candidateId,
  key: `${candidateId}:${suffix}`,
  status: "sent",
  sentAt,
  workflowStage: "pre_screen",
});
const people = [
  person("a"),
  person("b"),
  person("c", { preScreen: pre, preScreenScore: 71.5, preScreenAssessment: { criteria: [], subjects: [], universities: [], summary: "x" } }),
  person("d", { stage: "new" }),
];
const extras = candidateExtras(
  people,
  [
    job("a", "pre-screen", "2026-10-29T03:00:00Z"),
    job("b", "pre-screen", "2026-10-29T03:00:00Z"),
    job("b", "pre-screen-reminder", "2026-11-01T03:00:00Z"),
    job("c", "pre-screen", "2026-10-29T03:00:00Z"),
  ],
  [{ candidateId: "c", kind: "mock", status: "confirmed", startTime: "2026-11-05T07:00:00Z" }],
  new Set(["d"]),
);
const insights = { total: 4, ready: 1, stopped: 0, stages: [] } as unknown as Insights;
const table = (candidates = people, filter = NO_FILTER, map: Map<string, CandidateExtras> = extras) =>
  renderToStaticMarkup(
    <CandidateTable
      candidates={candidates}
      insights={insights}
      ready={new Set(["d"])}
      extras={map}
      weights={weights}
      threshold={60}
      filter={filter}
      setFilter={() => {}}
      selected={null}
      onSelect={() => {}}
    />,
  );

describe("pre-screen filter", () => {
  const pick = (prescreen: (typeof NO_FILTER)["prescreen"]) =>
    people.filter((c) => matchesFilter(c, { ...NO_FILTER, prescreen }, new Set(["d"]), extras)).map((c) => c.id);
  it("filters each status, and Sent also covers Reminded", () => {
    expect(pick("all")).toEqual(["a", "b", "c", "d"]);
    expect(pick("Queued")).toEqual(["d"]);
    expect(pick("Sent")).toEqual(["a", "b"]);
    expect(pick("Replied")).toEqual(["c"]);
    expect(pick("No reply")).toEqual([]);
    expect(pick("Visit booked")).toEqual(["c"]);
  });
});

describe("CandidateTable pre-screen columns", () => {
  const html = table();
  it("shows the pill and the dates in Bangkok time", () => {
    expect(html).toContain("Pre-screen");
    expect(html).toMatch(/>Reminded</);
    expect(html).toContain("Sent 29 Oct · reminded 1 Nov");
    expect(html).toMatch(/>Replied</);
    expect(html).toContain("Sent 29 Oct · replied 1 Nov");
  });
  it("shows the pre-screen score only when an assessment exists", () => {
    expect(html).toContain("71.5");
    expect(html).toContain("Pre-screen score");
    expect(html.match(/71\.5/g)).toHaveLength(1);
    // With no assessment the column still renders and shows no score.
    const without = table(people.slice(0, 2));
    expect(without).toContain("Pre-screen score");
    expect(without).not.toContain("71.5");
  });
  it("flags a missing and an unaccepted work-rights answer differently", () => {
    const flagged = table([
      person("m", { workRightsAnswer: null, workRightsAccepted: false }),
      person("n", { workRightsAnswer: "Resident", workRightsAccepted: false }),
      person("o"),
    ]);
    expect(flagged.match(/Rights unknown/g)).toHaveLength(1);
    expect(flagged.match(/Rights not accepted/g)).toHaveLength(1);
  });
  it("shows a confirmed booking in the Visit column and a dash otherwise", () => {
    expect(html).toContain("Mock · 5 Nov, 14:00");
  });
  it("has the five filter buttons with counts", () => {
    for (const label of ["Queued", "Sent", "Replied", "No reply", "Visit booked"]) expect(html).toContain(label);
    expect(html).toMatch(/Sent <span[^>]*>2<\/span>/);
  });
});

describe("CandidateInspector pre-screen answers", () => {
  const inspect = (candidate: HiringCandidate) =>
    renderToStaticMarkup(
      <CandidateInspector
        candidate={candidate}
        extras={extras.get(candidate.id)!}
        seekJobId="1"
        weights={weights}
        busy={false}
        error=""
        notice=""
        command={async () => true}
        onClose={() => {}}
      />,
    );
  it("lists every answer inside a details element, with the reply time in Bangkok", () => {
    const html = inspect(people[2]);
    expect(html).toContain("<details");
    expect(html).toContain("Read the full response");
    expect(html).toContain("MOTIVATION ANSWER");
    expect(html).toContain("APPROACH ANSWER");
    expect(html).toContain("Weekday evenings");
    expect(html).toContain("1 Nov, 01:30");
  });
  it("shows the status and dates when there is no response yet", () => {
    const html = inspect(people[1]);
    expect(html).toContain("Reminded");
    expect(html).toContain("Sent 29 Oct, 10:00 · reminded 1 Nov, 10:00");
    expect(html).not.toContain("Read the full response");
  });
});

describe("CandidateInspector pre-screen score parts", () => {
  const parts = { degree: 10, subject: 10, curriculum: 7.5, teaching: 15, english: 15, prestige: 5, written: 7.5, availability: 8, total: 78 };
  const six = {
    criteria: (["degree", "subject", "curriculum", "teaching", "english", "written"] as const).map((id) => ({
      id,
      result: id === "curriculum" || id === "written" ? ("partial" as const) : ("met" as const),
      evidence: "quote",
      reason: "REASON",
    })),
    subjects: [],
    universities: [],
    summary: "SUMMARY",
  };
  const html = renderToStaticMarkup(
    <CandidateInspector
      candidate={person("p", { preScreen: pre, preScreenAssessment: six, preScreenScore: 78, preScreenParts: parts })}
      extras={extras.get("c")!}
      seekJobId="1"
      weights={weights}
      busy={false}
      error=""
      notice=""
      command={async () => true}
      onClose={() => {}}
    />,
  );
  it("lists the eight parts against their weights, and the total", () => {
    for (const label of ["Degree", "Subject", "Curriculum", "Teaching", "English", "University prestige", "Written answers", "Availability"])
      expect(html).toContain(label);
    expect(html).toContain("Pre-screen score parts");
    expect(html).toContain("7.5/15");
    expect(html).toContain("8/10");
    expect(html).toContain("78/100");
  });
  it("shows the work-rights answer and whether it is accepted", () => {
    expect(html).toContain("Accepted: I have permanent work rights with no restrictions");
  });
});
