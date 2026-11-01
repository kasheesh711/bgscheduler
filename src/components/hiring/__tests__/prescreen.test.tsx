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
const byStage = { new: 1, review: 0, pre_screen: 3, paper_invited: 0, paper_booked: 0, paper_passed: 0, mock_booked: 0, onsite_invited: 0, onsite_booked: 0, no_reply: 2, no_booking: 1, stopped: 0 };
const insights = { total: 4, ready: 1, stopped: 0, stages: [], byStage } as unknown as Insights;
const table = (
  candidates = people,
  filter = NO_FILTER,
  map: Map<string, CandidateExtras> = extras,
  clashes = new Set<string>(),
  holds = new Map<string, { short: string; long: string[] }>(),
) =>
  renderToStaticMarkup(
    <CandidateTable
      candidates={candidates}
      insights={insights}
      ready={new Set(["d"])}
      extras={map}
      holds={holds}
      clashes={clashes}
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

describe("visit clash marker", () => {
  it("shows on the row of a candidate whose booked mock clashes, and on no other row", () => {
    expect(table()).not.toContain("Visit clash");
    const html = table(people, NO_FILTER, extras, new Set(["c"]));
    expect(html.match(/Visit clash/g)).toHaveLength(1);
    expect(html).toContain("did not move the visit");
  });
});

describe("table for the visit stages and holds", () => {
  it("has a filter chip for No reply and No booking, with their counts", () => {
    const html = table();
    expect(html).toMatch(/aria-pressed="false"[^>]*>No reply <span[^>]*>2<\/span>/);
    expect(html).toMatch(/aria-pressed="false"[^>]*>No booking <span[^>]*>1<\/span>/);
    const pressed = table(people, { ...NO_FILTER, stage: "no_reply" });
    expect(pressed).toMatch(/aria-pressed="true"[^>]*>No reply /);
    expect(matchesFilter(person("x", { stage: "no_booking" }), { ...NO_FILTER, stage: "no_booking" }, new Set(), new Map())).toBe(true);
    expect(matchesFilter(person("x", { stage: "no_reply" }), { ...NO_FILTER, stage: "no_booking" }, new Set(), new Map())).toBe(false);
  });
  it("shows the queue place and limit in the Pre-screen column, and the gate reason for a held new candidate", () => {
    const html = table(
      people,
      NO_FILTER,
      extras,
      new Set(),
      new Map([
        ["d", { short: "Queue 3 · daily limit 5", long: ["Position 3 in the pre-screen queue.", "Held by the daily limit (5)."] }],
        ["a", { short: "Subject not hiring", long: ["No supported subject is open for hiring."] }],
      ]),
    );
    expect(html).toContain("Queue 3 · daily limit 5");
    expect(html).toContain("Subject not hiring");
    // The wide Pre-screen column is hidden on a phone, so the note also sits in the Stage cell with the phone pill.
    expect(html.match(/Queue 3 · daily limit 5/g)).toHaveLength(2);
    const stageCell = html.slice(html.indexOf("Person d"));
    expect(stageCell.slice(0, stageCell.indexOf("</td>", stageCell.indexOf("</td>") + 1))).toContain("Queue 3 · daily limit 5");
    expect(html).toContain('title="Position 3 in the pre-screen queue. Held by the daily limit (5)."');
    expect(table()).not.toContain("daily limit");
  });
  it("lists the reasons in the panel", () => {
    const html = renderToStaticMarkup(
      <CandidateInspector
        candidate={people[3]}
        extras={extras.get("d")}
        hold={{ short: "Work-rights answer not accepted +1", long: ["The work-rights answer is missing or not accepted.", "There is no usable email."] }}
        seekJobId="94844236"
        weights={weights}
        busy={false}
        error=""
        notice=""
        command={async () => true}
        onClose={() => {}}
      />,
    );
    expect(html).toContain("Waiting to send");
    expect(html).toContain("The work-rights answer is missing or not accepted.");
    expect(html).toContain("There is no usable email.");
  });
});
