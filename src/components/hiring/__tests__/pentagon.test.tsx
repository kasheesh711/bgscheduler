import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";
import { averageValues } from "@/lib/hiring/insights";
import type { Assessment, PreScreenAssessment } from "@/lib/hiring/scoring";
import { CandidateInspector } from "../candidate-inspector";
import type { HiringCandidate } from "../dashboard";
import { Pentagon } from "../pentagon";
import { NO_FILTER } from "../dashboard";
import { AveragePentagon, CRITERION_LABELS, KpiStrip, SubjectChart, type Insights } from "../pipeline-charts";

vi.mock("next/font/google", () => ({ Instrument_Serif: () => ({ variable: "" }) }));

const DSCTE = Object.values(CRITERION_LABELS);
const assessment = (extra: { brief?: string; briefSummary?: string } = {}): Assessment => ({
  criteria: (["degree", "subject", "curriculum", "teaching", "english"] as const).map((id) => ({
    id,
    result: "met" as const,
    evidence: "quote",
    reason: "LONG REASON TEXT",
    brief: extra.brief,
  })),
  subjects: [],
  universities: [],
  summary: "LONG SUMMARY TEXT",
  briefSummary: extra.briefSummary,
});
const inspect = (profileAssessment: Assessment, preScreenAssessment: PreScreenAssessment | null = null) =>
  renderToStaticMarkup(
    <CandidateInspector
      candidate={
        {
          id: "c1",
          name: "Sam",
          stage: "new",
          email: "s@example.com",
          subjects: [],
          sourceIds: [],
          paperPassedSubjects: [],
          profileScore: 80,
          profileAssessment,
          preScreenAssessment,
          universityAssessment: null,
        } as unknown as HiringCandidate
      }
      seekJobId="1"
      weights={{ degree: 20, subject: 20, curriculum: 20, teaching: 20, english: 20, prestige: 0 }}
      busy={false}
      error=""
      notice=""
      command={async () => true}
      onClose={() => {}}
    />,
  );
// Closed <details> bodies: everything between </summary> and </details>.
const visibleWhenClosed = (html: string) => html.replace(/<\/summary>[\s\S]*?<\/details>/g, "");

describe("Pentagon", () => {
  it("draws one polygon per shape and labels every corner", () => {
    const html = renderToStaticMarkup(
      <Pentagon
        shapes={[
          { label: "Profile", values: [1, 1, 1, 1, 1], tone: "profile" },
          { label: "Pre-screen", values: [1, 0.5, 0, 0, 1], tone: "preScreen" },
        ]}
        labels={DSCTE.map((name) => ({ name, value: "Met" }))}
      />,
    );
    // Two shapes plus the two guide rings.
    expect(html.match(/<polygon/g)).toHaveLength(4);
    for (const name of DSCTE) expect(html).toContain(`>${name}</text>`);
    expect(html).toContain('role="img"');
    expect(html).toContain("Degree: Met");
  });
  it("puts a changed result on its own lines so the longest pair stays inside the chart", () => {
    const html = renderToStaticMarkup(
      <Pentagon
        shapes={[]}
        labels={DSCTE.map((name) => ({ name, value: "No evidence → Partial" }))}
      />,
    );
    expect(html).toContain("Degree: No evidence → Partial");
    for (const line of ["No evidence", "→ Partial"]) expect(html.match(new RegExp(`>${line}</text>`, "g"))).toHaveLength(5);
    expect(html).not.toContain(">No evidence → Partial</text>");
  });
  it("keeps two-line text clear of the top apex and inside the view box", () => {
    const html = renderToStaticMarkup(
      <Pentagon shapes={[]} labels={DSCTE.map((name) => ({ name, value: "No evidence → Partial" }))} />,
    );
    const view = html.match(/viewBox="(\S+) (\S+) (\S+) (\S+)"/)!.slice(1).map(Number);
    const ys = [...html.matchAll(/<text [^>]*y="([\d.-]+)"/g)].map((m) => Number(m[1]));
    // Texts come in corner order: name, then two value lines. The apex is at y = 28.
    expect(ys.slice(0, 3)).toHaveLength(3);
    expect(Math.max(...ys.slice(0, 3))).toBeLessThanOrEqual(28 - 6);
    // 13px names rise about 10 units above their baseline, and 12px values drop about 3 below it.
    expect(Math.min(...ys) - 10).toBeGreaterThanOrEqual(view[1]);
    expect(Math.max(...ys) + 3).toBeLessThanOrEqual(view[1] + view[3]);
  });
});

describe("averageValues", () => {
  it("averages candidates with an assessment and ignores the rest", () => {
    const partial = assessment();
    partial.criteria[0].result = "not_met";
    partial.criteria[1].result = "partial";
    expect(averageValues([{ profileAssessment: assessment() }, { profileAssessment: partial }, { profileAssessment: null }])).toEqual([0.5, 0.75, 1, 1, 1]);
    expect(averageValues([])).toEqual([0, 0, 0, 0, 0]);
  });
});

describe("AveragePentagon", () => {
  it("shows a percentage at each corner", () => {
    const html = renderToStaticMarkup(<AveragePentagon candidates={[{ profileAssessment: assessment() }]} />);
    expect(html).toContain("Degree: 100%");
    expect(html).toContain("Average DSCTE pentagon for 1 scored candidate in this filter");
    expect(html).toContain("1 scored candidate in this filter");
  });
  it("uses the plural for several candidates", () => {
    const html = renderToStaticMarkup(
      <AveragePentagon candidates={[{ profileAssessment: assessment() }, { profileAssessment: assessment() }]} />,
    );
    expect(html).toContain("2 scored candidates in this filter");
  });
  it("shows a message, not a chart at 0%, when no candidate in the filter is scored", () => {
    const html = renderToStaticMarkup(<AveragePentagon candidates={[{ profileAssessment: null }]} />);
    expect(html).toContain("No scored candidates in this filter");
    expect(html).not.toContain("<svg");
    expect(html).not.toContain("0%");
  });
});

describe("SubjectChart", () => {
  const chart = (subjects: { subject: string; interviewers: string[] }[]) =>
    renderToStaticMarkup(
      <SubjectChart
        insights={
          {
            subjects: subjects.map((s) => ({ candidates: 3, passed: 0, ...s })),
            uncoveredSubjects: subjects.filter((s) => !s.interviewers.length).length,
          } as unknown as Insights
        }
        filter={NO_FILTER}
        setFilter={() => {}}
      />,
    );
  it("tags only a subject that has no interviewer, with visible text", () => {
    const html = chart([
      { subject: "Physics", interviewers: ["Peat"] },
      { subject: "Biology", interviewers: [] },
    ]);
    expect(html.match(/No head/g)).toHaveLength(1);
    expect(html).toMatch(/Biology<\/span><span[^>]*>No head</);
    expect(html).not.toMatch(/Physics<\/span><span[^>]*>No head</);
    expect(html).toContain("1 subject has no interviewer");
    expect(html).not.toContain("amber");
    expect(html).not.toContain("sr-only");
  });
  it("shows no tag when every subject has an interviewer", () => {
    const html = chart([{ subject: "Physics", interviewers: ["Peat"] }]);
    expect(html).not.toContain("No head");
    expect(html).toContain("Every subject has an interviewer");
  });
});

describe("CandidateInspector evidence", () => {
  it("shows a result label and keeps the long reason closed when a brief is missing", () => {
    const html = inspect(assessment());
    const closed = visibleWhenClosed(html);
    // The pentagon has its own "Met" corner labels, so look at the criterion row itself.
    expect(closed.match(/criterionResult[^>]*>Met</g)).toHaveLength(5);
    expect(closed).not.toContain("LONG REASON TEXT");
    expect(html).toContain("LONG REASON TEXT");
  });
  it("shows the short lines when present", () => {
    const html = inspect(assessment({ brief: "BSc Physics, completed", briefSummary: "Strong physics tutor" }));
    expect(visibleWhenClosed(html)).toContain("BSc Physics, completed");
    expect(visibleWhenClosed(html)).toContain("Strong physics tutor");
  });
  it("falls back from the short summary to the long one", () => {
    const html = inspect(assessment());
    expect(visibleWhenClosed(html)).toContain("LONG SUMMARY TEXT");
    expect(visibleWhenClosed(inspect(assessment({ briefSummary: "SHORT ONE" })))).not.toContain("LONG SUMMARY TEXT");
  });
  it("shows Partial → Met at a corner where the pre-screen differs from the profile", () => {
    const profile = assessment();
    profile.criteria[0].result = "partial";
    const html = inspect(profile, assessment() as unknown as PreScreenAssessment);
    expect(html).toContain("Degree: Partial → Met");
    expect(html).toContain(">Partial</text>");
    expect(html).toContain(">→ Met</text>");
  });
  it("draws the profile pentagon", () => {
    expect(inspect(assessment())).toContain("DSCTE pentagon");
  });
  it("shows a key that names both shapes, and says in the label which side of the arrow is which", () => {
    const profile = assessment();
    profile.criteria[0].result = "partial";
    const html = inspect(profile, assessment() as unknown as PreScreenAssessment);
    expect(html).toMatch(/<li><i[^>]*><\/i>Profile \(grey\)<\/li>/);
    expect(html).toMatch(/<li><i[^>]*><\/i>Pre-screen \(orange outline\)<\/li>/);
    expect(html).toContain("A change reads Profile → Pre-screen");
    expect(html).toMatch(/aria-label="DSCTE pentagon with a Profile shape and a Pre-screen shape\. Where a corner reads[^"]*the first is the Profile result and the second is the Pre-screen result\./);
    expect(html).toContain("Degree: Partial → Met");
  });
  it("shows no key when only one shape exists", () => {
    expect(inspect(assessment())).not.toContain("Profile (grey)");
  });
  it("says when a pre-screen answer could not be scored, and only then", () => {
    const render = (extra: Record<string, unknown>) =>
      renderToStaticMarkup(
        <CandidateInspector
          candidate={
            { id: "c1", name: "Sam", stage: "review", email: "s@example.com", subjects: [], sourceIds: [], paperPassedSubjects: [], profileScore: null, profileAssessment: null, preScreenAssessment: null, universityAssessment: null, preScreen: {}, preScreenHash: "h", ...extra } as unknown as HiringCandidate
          }
          seekJobId="1"
          weights={{ degree: 20, subject: 20, curriculum: 20, teaching: 20, english: 20, prestige: 0 }}
          busy={false}
          error=""
          notice=""
          command={async () => true}
          onClose={() => {}}
        />,
      );
    expect(render({})).toContain("Pre-screen could not be scored");
    expect(render({ preScreenHash: null })).not.toContain("could not be scored");
    expect(render({ preScreenAssessment: assessment() })).not.toContain("could not be scored");
    expect(render({ preScreen: null })).not.toContain("could not be scored");
  });
  it("draws the pentagon when only a pre-screen assessment exists", () => {
    const html = renderToStaticMarkup(
      <CandidateInspector
        candidate={
          {
            id: "c1",
            name: "Sam",
            stage: "stopped",
            email: "s@example.com",
            subjects: [],
            sourceIds: [],
            paperPassedSubjects: [],
            profileScore: null,
            profileAssessment: null,
            preScreenAssessment: assessment() as unknown as PreScreenAssessment,
            universityAssessment: null,
          } as unknown as HiringCandidate
        }
        seekJobId="1"
        weights={{ degree: 20, subject: 20, curriculum: 20, teaching: 20, english: 20, prestige: 0 }}
        busy={false}
        error=""
        notice=""
        command={async () => true}
        onClose={() => {}}
      />,
    );
    expect(html).toContain("DSCTE pentagon for the Pre-screen");
    expect(html).toContain("Degree: Met");
    expect(html).not.toContain("Profile (grey)");
  });
});

describe("the Scored tile", () => {
  it("counts people with source text only, and says how many have none", () => {
    const html = renderToStaticMarkup(
      <KpiStrip
        insights={{ total: 10, active: 10, parked: 0, scored: 4, scorable: 5, ready: 0, median: null, aboveThreshold: 0, pastReview: 0, appointmentsThisWeek: 0, messages: { sent: 0, waiting: 0, problems: 0 } } as unknown as Insights}
        threshold={60}
        onShowReady={() => {}}
      />,
    );
    expect(html).toContain("80%");
    expect(html).toContain("4 of 5, 5 with no source text");
  });
});
