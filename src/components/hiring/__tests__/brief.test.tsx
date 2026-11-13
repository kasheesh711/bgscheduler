import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { RUBRIC, RUBRIC_ITEMS } from "@/lib/hiring/marking-sheet";
import { ANSWER_LABELS } from "@/lib/hiring/model";
import { BriefGone, InterviewerBrief } from "../brief";

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
  formOpen: true,
} as unknown as Parameters<typeof InterviewerBrief>[0]["brief"];
const html = (patch = {}) =>
  renderToStaticMarkup(<InterviewerBrief brief={{ ...brief, ...patch }} resumeUrl="/api/hiring/brief/t/resume" rubricUrl="/api/hiring/brief/t/rubric" />);

describe("InterviewerBrief", () => {
  it("shows the visit facts, every answer with its label, and a résumé link that opens a new tab", () => {
    const page = html();
    expect(page).toContain("Ann &lt;Example&gt;");
    for (const text of ["Physics", "10:00–12:00 (Bangkok)", "12:00–13:00 (Bangkok)", "Peat", "BeGifted office"]) expect(page).toContain(text);
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
    expect(html({ resume: "docx" })).toContain("Download the résumé (Word file)");
    expect(html()).toContain(">Exam<");
    expect(html({ exam: null })).not.toContain(">Exam<");
    expect(html({ answers: null })).toContain("no pre-screen reply");
  });

  it("shows the score form only after the mock starts, with one choice for each of the 10 items", () => {
    expect(html({ formOpen: false })).toContain("opens here when the mock lesson starts");
    expect(html({ formOpen: false })).not.toContain("<select");
    const page = html();
    expect(page.match(/<select/g)).toHaveLength(RUBRIC_ITEMS.length);
    for (const { part, items } of RUBRIC) for (const text of [part, ...items.map(([, label]) => label)]) expect(page).toContain(text);
    expect(page).toContain("Send scores");
    expect(page).not.toContain("Scores sent");
  });

  it("shows the interviewer's own sent scores again, with the total", () => {
    const rubric = { items: Object.fromEntries(RUBRIC_ITEMS.map((id) => [id, 7])), comments: "Clear lesson." };
    const page = html({ rubric });
    expect(page).toContain("Scores sent. Total 70 / 100");
    expect(page).toContain("Clear lesson.");
    expect(page.match(/<option[^>]*selected=""[^>]*>7</g)).toHaveLength(RUBRIC_ITEMS.length);
  });

  it("gives one message for a dead link", () => {
    expect(renderToStaticMarkup(<BriefGone />)).toContain("invalid or has expired");
  });
});
