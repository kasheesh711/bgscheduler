import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";

// The brief fetches itself again with the router; a server render here has no router to give it.
vi.mock("next/navigation", () => ({ useRouter: () => ({ refresh: () => {} }) }));
import { ITEM_MAX, RUBRIC, RUBRIC_ITEMS, type MockRubric } from "@/lib/hiring/marking-sheet";
import { ANSWER_LABELS } from "@/lib/hiring/model";
import { BriefGone, InterviewerBrief } from "../brief";
import { BriefDecision } from "../brief-decision";

const answers = Object.fromEntries(ANSWER_LABELS.map(([key]) => [key, `answer for ${key}`]));
const brief = {
  name: "Ann <Example>",
  subject: "Physics",
  exam: "Monday 2 November at 10:00–12:00",
  mock: "Monday 2 November at 12:00–13:00",
  interviewer: "Peat",
  location: "BeGifted office",
  answers: { sourceRow: 2, submittedAt: "x", ...answers, motivation: "Line one\nLine two", portfolio: "" },
  resume: "pdf",
  rubric: null,
  form: "open",
  mockEnded: true,
} as unknown as Parameters<typeof InterviewerBrief>[0]["brief"];
const html = (patch: Partial<typeof brief> = {}) =>
  renderToStaticMarkup(<InterviewerBrief brief={{ ...brief, ...patch }} resumeUrl="/api/hiring/brief/t/resume" rubricUrl="/api/hiring/brief/t/rubric" decisionUrl="/api/hiring/brief/t/decision" />);
const rubric: MockRubric = {
  items: Object.fromEntries(RUBRIC_ITEMS.map((id) => [id, 9])) as MockRubric["items"],
  comments: "Clear lesson.",
  checksDone: true,
};

describe("InterviewerBrief", () => {
  it("shows the visit facts, every answer with its label, and a résumé link that opens a new tab", () => {
    const page = html();
    expect(page).toContain("Ann &lt;Example&gt;");
    for (const text of ["Physics", "10:00–12:00", "12:00–13:00", "Peat", "BeGifted office"]) expect(page).toContain(text);
    for (const [key, label] of ANSWER_LABELS) {
      expect(page).toContain(label);
      if (key !== "motivation" && key !== "portfolio") expect(page).toContain(`answer for ${key}`);
    }
    expect(page).toContain("Line one\nLine two");
    expect(page).toContain("No answer");
    expect(page).toContain('href="/api/hiring/brief/t/resume" target="_blank" rel="noreferrer"');
    expect(page).toContain("Open résumé (PDF), opens in a new tab");
  });

  it("says so when there is no file, no exam row or no reply, and names a Word file as a download", () => {
    expect(html({ resume: null })).toContain("No résumé file is stored");
    expect(html({ resume: null })).not.toContain("/resume");
    expect(html({ resume: "docx" })).toContain("Download résumé (Word)");
    expect(html()).toContain(">Exam<");
    expect(html({ exam: null })).not.toContain(">Exam<");
    expect(html({ answers: null })).toContain("no pre-screen reply");
  });

  it("shows the score form before and during the mock, and the recommendation only after it, with score choices for each item", () => {
    const wait = html({ form: "wait", mockEnded: false });
    expect(wait).toContain('type="radio"');
    expect(wait).toContain("Send scores during the mock.");
    expect(wait).toContain("Recommend after the mock ends.");
    expect(wait).not.toContain("Yes, send for final review");
    expect(wait.indexOf("Check recommendation")).toBeLessThan(wait.indexOf("Candidate files"));
    // Closed early by admin: no "ask admin" alarm, the same wait for the recommendation.
    const closedEarly = html({ form: "closed", mockEnded: false, recommendationBlock: null });
    expect(closedEarly).not.toContain("Ask BeGifted admin");
    expect(closedEarly).toContain("Recommend after the mock ends.");
    expect(closedEarly).not.toContain("Send scores during the mock");
    expect(closedEarly).not.toContain("Yes, send for final review");
    const closed = html({ form: "closed", recommendationReady: true });
    expect(closed).toContain("Scores are recorded. Ask admin to edit scores.");
    expect(closed).not.toContain('type="radio"');
    expect(closed.indexOf("Yes, send for final review")).toBeLessThan(closed.indexOf("Candidate files"));
    expect(closed).toContain("No queues a rejection email to the candidate.");
    const page = html();
    expect(page).not.toContain("<select");
    for (const { part, items } of RUBRIC) {
      expect(page).toContain(part);
      for (const [, label] of items) {
        expect(page).toContain(`type="range" min="0" max="${ITEM_MAX}" step="1" aria-label="${label}" aria-valuetext="Not scored"`);
        expect(page).toContain(`aria-label="${label}: what each level means"`);
      }
    }
    expect(page.match(/type="range"/g)).toHaveLength(RUBRIC_ITEMS.length);
    expect(page.match(/type="radio"/g)).toHaveLength(2);
    expect(page.match(/type="checkbox"/g)).toHaveLength(3);
    expect(page).not.toContain("Suggested score");
    expect(page).toContain("School&#x27;s required checks completed");
    expect(page).toContain("0/14 scored");
    // The level names show once, above the bars, and no level text shows until the head opens an item.
    expect(page.split("Needs improvement (4)")).toHaveLength(2);
    expect(page).not.toContain("All information provided is accurate");
    expect(page).toContain("Question bank");
    expect(page).toContain("19% on their most recent physics test");
    expect(page).toContain("Send scores");
    expect(page).not.toContain("Scores sent");
    expect(page).toContain("Send your scores first.");
    expect(page).not.toContain("Reason for No (5+ characters)");
    expect(page).not.toContain("Yes, send for final review");
  });

  it.each([
    ["checking", "Scores are being checked.", true],
    ["admin", "Ask BeGifted admin to check the scores.", false],
  ] as const)("shows the %s instruction above the files and hides the recommendation", (recommendationBlock, message, retry) => {
    const page = html({ form: "closed", recommendationReady: false, recommendationBlock });
    expect(page.split(message)).toHaveLength(2);
    expect(page.indexOf(message)).toBeLessThan(page.indexOf("Candidate files"));
    expect(page.includes(">Check again</button>")).toBe(retry);
    expect(page).not.toContain("Yes, send for final review");
    expect(page).not.toContain("No, reject");
  });

  it("shows a summary of the interviewer's sent scores", () => {
    const page = html({ rubric });
    expect(page).toContain("Scores sent · <strong>126/140</strong> · 90%");
    expect(page).toContain("Edit scores");
    expect(page).toContain('id="recommendation"');
    expect(page).toContain("Reason for No (5+ characters)");
    expect(page).not.toContain("Clear lesson.");
    expect(page).not.toContain('type="radio"');
  });

  it("shows the saved total and locks the scores when the recommendation is recorded", () => {
    const page = html({ form: "open", decision: "hire", rubric });
    expect(page).toContain("<strong>126/140</strong> · 90%");
    expect(page).toContain("Ask admin to edit scores.");
    expect(page).not.toContain("Edit scores");
    expect(page).not.toContain("Go to mock scores");
    expect(page).toMatch(/<p role="status"[^>]*tabindex="-1">Recommendation recorded: <strong>Yes<\/strong>/i);
  });

  it("shows the sending status and locks the reason while the recommendation is sent", () => {
    const page = renderToStaticMarkup(
      <BriefDecision sent={null} onSent={() => {}} url="/api/hiring/brief/t/decision" hasScores
        unsent={false} pending="recommendation" setPending={() => {}} />,
    );
    expect(page).toMatch(/<p role="status"[^>]*>Sending recommendation…<\/p>/);
    expect(page).toMatch(/<textarea[^>]*\bdisabled=""/);
  });

  it("shows the résumé score in parts only when the candidate has one, and the paper tab only with a graded paper", () => {
    const page = html({ ats: { score: 72.5, parts: [{ name: "Degree", earned: 7.5, max: 15 }, { name: "University", earned: 15, max: 15 }], penalty: 5 }, gradedPaper: true });
    expect(page).toContain("<strong>72.5/100</strong>");
    expect(page).toContain(">7.5/15<");
    expect(page).toContain(">−5<");
    expect(page).toContain(">Paper</button>");
    expect(html()).not.toContain("ATS score");
    expect(html()).not.toContain(">Paper</button>");
    expect(html({ ats: { score: 80, parts: [], penalty: 0 } })).not.toContain("Work rights");
  });

  it("gives one message for a dead link", () => {
    expect(renderToStaticMarkup(<BriefGone />)).toContain("invalid or has expired");
  });
});
