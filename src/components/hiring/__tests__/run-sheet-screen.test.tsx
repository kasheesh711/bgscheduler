import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { RunSheetScreen, type RunSheetTab } from "../run-sheet-screen";

const now = new Date("2026-11-18T02:00:00Z");
const data = {
  bookings: [
    { id: "p1", candidateId: "c1", kind: "paper", subjects: ["Mathematics"], interviewerKey: null, startTime: "2026-11-18T03:00:00.000Z", status: "confirmed", visitId: "v1" },
    { id: "m1", candidateId: "c1", kind: "mock", subjects: ["Mathematics"], interviewerKey: "Peat", startTime: "2026-11-18T04:00:00.000Z", status: "confirmed", visitId: "v1" },
    { id: "p2", candidateId: "c2", kind: "paper", subjects: ["English Language"], interviewerKey: null, startTime: "2026-11-19T03:00:00.000Z", status: "confirmed", visitId: null },
  ],
  candidates: [
    { id: "c1", name: "Kim", visitSubject: "Mathematics" },
    { id: "c2", name: "Mai", visitSubject: "English Language" },
  ],
  config: {
    interviewers: [
      { canonicalKey: "Peat", subjects: ["Mathematics"], email: "peat@x.com" },
      { canonicalKey: "Tito", subjects: ["English Language"], email: "tito@x.com" },
    ],
    paperPassRules: [],
  },
  library: [{ id: "qp-m", kind: "question_paper", subject: "Mathematics", name: "Maths QP.pdf", status: "ready" }],
  tutors: [{ canonicalKey: "Peat", name: "Peat Smith", email: null }],
};
const render = (tab: RunSheetTab) => renderToStaticMarkup(<RunSheetScreen data={data} now={now} initialTab={tab} />);

describe("RunSheetScreen", () => {
  it("shows every upcoming visit with head, paper link and a Needs review room", () => {
    const html = render("sheet");
    expect(html).toContain("Kim");
    expect(html).toContain("Mai");
    expect(html).toContain("Peat Smith");
    expect(html).toContain('href="/api/hiring/file/qp-m"');
    expect(html).toContain("Needs review: no question paper for English Language in the paper library");
    expect(html).toContain("Needs review: no room is booked for this visit");
    expect(html).toContain("No pass mark");
    expect(html).toContain("Show past visits");
  });

  it("prints a list per day with the count that needs review", () => {
    const html = render("print");
    expect(html).toContain("1 of 2 visits from today to Thu 26 Nov miss a head or a paper. No visit has a room yet.");
    expect(html).toContain("Today");
    expect(html).toContain("Tomorrow");
  });

  it("gives each head their mocks and paper-only visits", () => {
    const html = render("heads");
    expect(html).toContain("You run the mock");
    expect(html).toContain("Paper only: no mock");
  });

  it("shows previews only, with no send button", () => {
    const html = render("previews");
    expect(html).toContain("Preview only. Nothing is sent.");
    expect(html).toContain("Print list for");
    expect(html).not.toMatch(/>\s*Send/);
  });

  it("shows Needs review for a booked mock with no subject in the Heads view", () => {
    const noSubject = {
      ...data,
      bookings: [{ id: "m9", candidateId: "c9", kind: "mock", subjects: [], interviewerKey: "Peat", startTime: "2026-11-18T05:00:00.000Z", status: "confirmed", visitId: null }],
      candidates: [{ id: "c9", name: "Oat", visitSubject: null }],
    };
    const html = renderToStaticMarkup(<RunSheetScreen data={noSubject} now={now} initialTab="heads" />);
    expect(html).toContain("Oat");
    expect(html).toContain("Needs review: no subject");
  });
});
