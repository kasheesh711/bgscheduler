import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { averageValues } from "@/lib/hiring/insights";
import type { Assessment } from "@/lib/hiring/scoring";
import { CandidateInspector } from "../candidate-inspector";
import type { HiringCandidate } from "../dashboard";
import { Pentagon } from "../pentagon";
import { AveragePentagon, CRITERION_LABELS } from "../pipeline-charts";

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
const inspect = (profileAssessment: Assessment) =>
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
          preScreenAssessment: null,
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
    expect(html).toContain("Average DSCTE pentagon for 1 scored candidates");
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
  it("draws the profile pentagon", () => {
    expect(inspect(assessment())).toContain("DSCTE pentagon");
  });
});
