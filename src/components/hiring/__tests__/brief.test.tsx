import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
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
    expect(page).toContain("Open the résumé (PDF)");
  });

  it("says so when there is no file, no exam row or no reply, and names a Word file as a download", () => {
    expect(html({ resume: null })).toContain("No résumé file is stored");
    expect(html({ resume: null })).not.toContain("/resume");
    expect(html({ resume: "docx" })).toContain("Download résumé (Word)");
    expect(html()).toContain(">Exam<");
    expect(html({ exam: null })).not.toContain(">Exam<");
    expect(html({ answers: null })).toContain("no pre-screen reply");
  });

  it("shows the score form only after the mock ends, with score choices for each item", () => {
    const wait = html({ form: "wait" });
    expect(wait).toContain("Scores open after the mock.");
    expect(wait.indexOf("Check again")).toBeLessThan(wait.indexOf("Candidate files"));
    expect(wait).not.toContain('type="radio"');
    const closed = html({ form: "closed", recommendationReady: true });
    expect(closed).toContain("Scores are recorded. Ask admin to change them.");
    expect(closed).not.toContain('type="radio"');
    expect(closed.indexOf("Yes, send to HR")).toBeLessThan(closed.indexOf("Candidate files"));
    expect(closed).toContain("No sends the candidate a rejection email.");
    const page = html();
    expect(page).not.toContain("<select");
    for (const { part, items } of RUBRIC) {
      expect(page).toContain(part);
      for (const [, label] of items) {
        expect(page).toContain(`<legend>${label}</legend>`);
        expect(page).toContain(`aria-label="What each score means for ${label}">Guide</summary>`);
      }
    }
    expect(page.match(/type="radio"/g)).toHaveLength(ITEM_MAX * RUBRIC_ITEMS.length + 2);
    expect(page.match(/type="checkbox"/g)).toHaveLength(3);
    expect(page).toContain("Suggested: 1");
    expect(page).toContain("School&#x27;s required checks completed");
    expect(page).toContain("0 of 14 scored");
    expect(page).toContain("Interviewer guide");
    expect(page).toContain("19% on their most recent physics test");
    expect(page).toContain("Send scores");
    expect(page).not.toContain("Scores sent");
    expect(page).toContain("Send your scores first.");
    expect(page).not.toContain("Reason (needed for No, 5+ characters)");
    expect(page).not.toContain("Yes, send to HR");
  });

  it.each([
    ["checking", "Scores are being checked.", true],
    ["admin", "Ask BeGifted admin to check the scores.", false],
  ] as const)("shows the %s instruction above the files and hides the recommendation", (recommendationBlock, message, retry) => {
    const page = html({ form: "closed", recommendationReady: false, recommendationBlock });
    expect(page.split(message)).toHaveLength(2);
    expect(page.indexOf(message)).toBeLessThan(page.indexOf("Candidate files"));
    expect(page.includes(">Check again</button>")).toBe(retry);
    expect(page).not.toContain("Yes, send to HR");
    expect(page).not.toContain("No, reject");
  });

  it("shows a summary of the interviewer's sent scores", () => {
    const page = html({ rubric });
    expect(page).toContain("Scores sent · <strong>126 / 140</strong> · 90%");
    expect(page).toContain("Edit scores");
    expect(page).toContain('id="recommendation"');
    expect(page).toContain("Reason (needed for No, 5+ characters)");
    expect(page).not.toContain("Clear lesson.");
    expect(page).not.toContain('type="radio"');
  });

  it("shows the saved total and locks the scores when the recommendation is recorded", () => {
    const page = html({ form: "open", decision: "hire", rubric });
    expect(page).toContain("<strong>126/140</strong> · 90%");
    expect(page).toContain("Recorded. Ask admin to change them.");
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

  it("gives one message for a dead link", () => {
    expect(renderToStaticMarkup(<BriefGone />)).toContain("invalid or has expired");
  });
});
