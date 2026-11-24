import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";
import type { CandidateExtras } from "@/lib/hiring/status";
import { VisitBooking, VisitConfirm } from "../booking";
import { CandidateInspector } from "../candidate-inspector";
import type { HiringCandidate } from "../dashboard";

vi.mock("next/font/google", () => ({ Instrument_Serif: () => ({ variable: "" }) }));

const LINE = "https://lin.ee/OjMHF41";
const slot = {
  date: "2026-11-03",
  examStart: "2026-11-03T03:00:00.000Z",
  examEnd: "2026-11-03T05:00:00.000Z",
  mockStart: "2026-11-03T05:00:00.000Z",
  mockEnd: "2026-11-03T06:00:00.000Z",
  interviewerKey: "Peat",
  subject: "Mathematics" as const,
};
const view = (patch = {}) => ({
  kind: "visit" as const,
  paired: true,
  subject: "Mathematics" as const,
  location: "Gaysorn",
  enabled: true,
  slots: [slot],
  visit: null,
  canMove: false,
  notice: null,
  checkedAt: null as string | null,
  twoDay: false,
  mockSlots: [] as { date: string; start: string; end: string }[],
  waiting: null as "answers" | null,
  portfolioPath: null as string | null,
  knownDegree: null as { degree: "Bachelor's" | "Master's" | "PhD"; field: string } | null,
  testSubjects: [] as "Mathematics"[],
  timeRuleMet: false,
  liveDates: ["2026-11-03"] as string[],
  ...patch,
});
const page = (patch = {}) => renderToStaticMarkup(<VisitBooking token="t" view={view(patch)} reload={async () => {}} />);

describe("VisitBooking", () => {
  it("asks the questions on the page first on a Next steps link, with no Google Form and no booking form", () => {
    const html = page({ waiting: "answers", slots: [], enabled: false, subject: "", notice: "Please answer the questions on this page first. Then you can choose your times." });
    expect(html).toContain("Questions");
    expect(html).toContain('aria-current="step"');
    expect(html).not.toContain("docs.google.com");
    for (const question of ["Highest degree", "Field of study", "Subjects you teach confidently", "English level", "Tap hours", "Why do you want to tutor with BeGifted?", "Next: Highest degree"])
      expect(html).toContain(question);
    expect(html).toContain("1 hour, only if you pass");
    expect(html).not.toContain("I will come to this address.");
  });
  it("shows the résumé's degree as one line to confirm, in place of the two degree questions", () => {
    const html = page({ waiting: "answers", slots: [], enabled: false, subject: "", knownDegree: { degree: "Bachelor's", field: "English" } });
    expect(html).toContain("Bachelor&#x27;s · English");
    expect(html).toContain("Yes, that&#x27;s right");
    expect(html).toContain("Edit");
    expect(html).not.toContain("Highest completed degree");
    expect(html).not.toContain("Field of study");
  });
  it("lists the subjects a visit can be in first and keeps the rest behind one button", () => {
    const html = page({ waiting: "answers", slots: [], enabled: false, subject: "", testSubjects: ["Mathematics"] });
    expect(html).toContain("Mathematics");
    expect(html).not.toContain("Psychology");
    expect(html).toContain("17 more subjects");
  });
  it("a two-day link asks for the test time first and says the mock teaching is on the same day or a later day", () => {
    const html = page({ twoDay: true, mockSlots: [{ date: "2026-11-03", start: "2026-11-03T04:00:00.000Z", end: "2026-11-03T05:00:00.000Z" }] });
    expect(html).toContain("Test time");
    expect(html).toContain("Confirm both times");
    // The mock teaching list opens after a test time is chosen; until then its section says what comes first.
    expect(html).toContain("1 hour, if you pass.");
    expect(html).not.toContain('id="mock-start"');
    expect(page({ twoDay: true, waiting: "answers", formUrl: "https://forms.gle/x", slots: [], enabled: false, subject: "", notice: "Answer first." })).toContain("Next: Highest degree");
  });
  it("shows one subject, exam and mock times, and both confirmation boxes", () => {
    const html = page();
    expect(html).toContain("Mathematics");
    expect(html).toContain("10:00");
    expect(html).toContain("10:00–13:00");
    expect(html).toContain("with mock teaching");
    expect(html).toContain("I will come to this address.");
    expect(html).toContain("I can teach onsite");
    expect(html).not.toContain("Peat");
    // The live-check line shows only when the list came from a live Wise read.
    expect(html).not.toContain("Checked at");
    expect(page({ checkedAt: "2026-11-02T02:05:00.000Z" })).toContain("Times checked at 09:05");
    // A day outside the live read never says "checked live".
    expect(page({ checkedAt: "2026-11-02T02:05:00.000Z", liveDates: ["2026-11-04"] })).not.toContain("Checked at");
  });
  it("shows the notice and the LINE contact, and no form, for an empty list or a stale snapshot", () => {
    const html = page({ slots: [], notice: `Times cannot be shown. Contact BeGifted on LINE: ${LINE}` });
    expect(html).toContain("Times cannot be shown");
    expect(html).toContain(`href="${LINE}"`);
    expect(html).not.toContain("I will come to this address.");
    expect(html).not.toContain("Confirm visit");
  });
  it("makes the address in a notice a real link, with no second link in the footer, and renders no HTML from the text", () => {
    const html = page({ slots: [], notice: `<b>Closed</b>. Contact BeGifted on LINE: ${LINE}` });
    expect(html.match(/href="https:\/\/lin\.ee\/OjMHF41"/g)).toHaveLength(1);
    expect(html).toContain(">Contact BeGifted on LINE</a>");
    expect(html).toContain("&lt;b&gt;Closed&lt;/b&gt;");
    expect(html.match(/Contact BeGifted on LINE/g)).toHaveLength(1);
    // With no notice, the footer stays.
    expect(page({ visit: { examStart: slot.examStart, examEnd: slot.examEnd, mockStart: slot.mockStart, mockEnd: slot.mockEnd, head: "Peat" } })).toContain("Contact BeGifted on LINE");
  });
  it("shows a fallback and the link for an empty list with no notice, never a blank page", () => {
    const html = page({ slots: [], notice: null });
    expect(html).toContain("No test times are open");
    expect(html).toContain(`href="${LINE}"`);
    expect(html).not.toContain("Confirm visit");
  });
  it("puts the error directly above the confirm button", () => {
    const html = renderToStaticMarkup(<VisitConfirm error="That time is gone." disabled={false} label="Confirm visit" onConfirm={() => {}} />);
    expect(html).toMatch(/role="alert"[^>]*>That time is gone\.<\/p><button/);
    expect(renderToStaticMarkup(<VisitConfirm error="" disabled={false} label="Confirm visit" onConfirm={() => {}} />)).not.toContain("alert");
  });
  const booked = {
    examStart: slot.examStart,
    examEnd: slot.examEnd,
    mockStart: slot.mockStart,
    mockEnd: slot.mockEnd,
    head: "Peat",
  };
  const later = { ...slot, date: "2026-11-04", examStart: "2026-11-04T03:00:00.000Z", examEnd: "2026-11-04T05:00:00.000Z", mockStart: "2026-11-04T05:00:00.000Z", mockEnd: "2026-11-04T06:00:00.000Z" };
  it("shows the current booking with a Move button while a move is open", () => {
    const html = page({ visit: booked, canMove: true, slots: [slot, later] });
    expect(html).toContain("Your booked visit");
    expect(html).toContain("Peat");
    expect(html).toContain("Move this visit");
    // The times to choose stay hidden until the candidate presses Move.
    expect(html).not.toContain("I will come to this address.");
    expect(html).not.toContain("You cannot move it now");
  });
  it("does not open Move when the only open time is the booked one", () => {
    const html = page({ visit: booked, canMove: true, slots: [slot] });
    expect(html).toMatch(/disabled[^>]*>Move this visit<\/button><p[^>]*>You cannot move it now/);
  });
  it("gives the reason beside a disabled Move button", () => {
    const html = page({ visit: booked, canMove: true, slots: [], notice: `Try again later. Contact BeGifted on LINE: ${LINE}` });
    expect(html).toMatch(/disabled[^>]*>Move this visit<\/button><p[^>]*>You cannot move it now/);
  });
  it("shows no Move button when the move is used", () => {
    const html = page({ visit: booked, slots: [], canMove: false, notice: `Contact BeGifted on LINE: ${LINE}` });
    expect(html).toContain("Your booked visit");
    expect(html).not.toContain("Move this visit");
    expect(html).toContain(LINE);
  });
});

describe("CandidateInspector visit details", () => {
  const facts: [string, string][] = [
    ["Exam", "5 Nov, 10:00"],
    ["Mock", "5 Nov, 12:00"],
    ["Head", "Peat"],
    ["Subject", "Mathematics"],
    ["Status", "Confirmed"],
  ];
  const render = (extras: Partial<CandidateExtras>) =>
    renderToStaticMarkup(
      <CandidateInspector
        candidate={{ id: "a", name: "A", stage: "onsite_booked", subjects: [], sourceIds: [], paperPassedSubjects: [], preScreen: null } as unknown as HiringCandidate}
        extras={{ pre: { status: "Replied", sentAt: null, remindedAt: null, repliedAt: null }, visit: null, visitFacts: [], onsiteQueued: false, ...extras }}
        seekJobId="1"
        weights={{ degree: 20, subject: 20, curriculum: 20, teaching: 20, english: 20, prestige: 0, school: 0 }}
        busy={false}
        error=""
        notice=""
        command={async () => true}
        onClose={() => {}}
      />,
    );
  it("lists the exam, mock, head, subject and status of a visit", () => {
    const html = render({ visit: { kind: "paper", startTime: "2026-11-05T03:00:00Z", visitId: "v1" }, visitFacts: facts });
    for (const [label, value] of facts) expect(html).toContain(`<dt>${label}</dt><dd>${value}</dd>`);
    expect(html).not.toContain("Booked:");
  });
  it("keeps one line for an old-flow booking", () => {
    const html = render({ visit: { kind: "mock", startTime: "2026-11-05T05:00:00Z" } });
    expect(html).toContain("Booked: Mock");
    expect(html).not.toContain("<dt>Exam</dt>");
  });
});

describe("CandidateInspector actions", () => {
  const pre = { degree: "BSc" };
  const panel = (extra: Record<string, unknown>, visit: CandidateExtras["visit"] = null) =>
    renderToStaticMarkup(
      <CandidateInspector
        candidate={
          {
            id: "a",
            name: "A",
            email: "a@example.com",
            subjects: [],
            sourceIds: [],
            paperPassedSubjects: [],
            previouslyContacted: false,
            profileScore: null,
            profileAssessment: null,
            preScreen: null,
            preScreenAssessment: null,
            universityAssessment: null,
            ...extra,
          } as unknown as HiringCandidate
        }
        extras={{ pre: { status: "Replied", sentAt: null, remindedAt: null, repliedAt: null }, visit, visitFacts: [], onsiteQueued: false }}
        seekJobId="94844236"
        weights={{ degree: 20, subject: 20, curriculum: 20, teaching: 20, english: 20, prestige: 0, school: 0 }}
        busy={false}
        error=""
        notice=""
        command={async () => true}
        onClose={() => {}}
      />,
    );
  const buttons = (html: string) =>
    [...html.matchAll(/<button[^>]*>([^<]+)<\/button>/g)].map((m) => m[1]).filter((v) => v !== "Close");
  const ahead = { kind: "paper" as const, startTime: "2099-01-01T03:00:00Z", visitId: "v" };
  const started = { ...ahead, startTime: "2020-01-01T03:00:00Z" };
  it.each<[string, Record<string, unknown>, CandidateExtras["visit"], string[]]>([
    ["new, no response", { stage: "new" }, null, ["Invite to pre-screen", "Stop processing"]],
    ["review, no response", { stage: "review" }, null, ["Invite to pre-screen", "Stop processing"]],
    ["review, response", { stage: "review", preScreen: pre }, null, ["Invite to onsite visit", "Stop processing"]],
    ["form sent", { stage: "pre_screen" }, null, ["Stop processing"]],
    ["replied", { stage: "pre_screen", preScreen: pre }, null, ["Invite to onsite visit", "Stop processing"]],
    ["no reply", { stage: "no_reply" }, null, ["Stop processing"]],
    ["late reply", { stage: "no_reply", preScreen: pre }, null, ["Invite to onsite visit", "Stop processing"]],
    ["invited", { stage: "onsite_invited", preScreen: pre }, null, ["Send new link", "Stop processing"]],
    ["booked, ahead", { stage: "onsite_booked", preScreen: pre }, ahead, ["Cancel visit"]],
    ["booked, started", { stage: "onsite_booked", preScreen: pre }, started, ["Mark no-show", "Stop processing"]],
    ["booked, ended", { stage: "onsite_booked", preScreen: pre }, null, ["Mark no-show", "Stop processing"]],
    ["no booking", { stage: "no_booking", preScreen: pre }, null, ["Send new link", "Stop processing"]],
    ["stopped, response", { stage: "stopped", preScreen: pre }, null, ["Invite to onsite visit", "Stop processing"]],
    ["stopped, no response", { stage: "stopped" }, null, ["Stop processing"]],
    ["old paper", { stage: "paper_booked" }, { kind: "paper", startTime: "2099-01-01T03:00:00Z" }, ["Record paper pass and invite to mock", "Stop processing"]],
  ])("%s", (_name, candidate, visit, expected) => {
    expect(buttons(panel(candidate, visit))).toEqual(expected);
  });
  it("tells staff to clear SEEK before inviting a stopped candidate", () => {
    const hint = "Move this candidate out of Not Suitable in SEEK first.";
    expect(panel({ stage: "stopped", preScreen: pre })).toContain(hint);
    expect(panel({ stage: "stopped" })).not.toContain(hint);
    expect(panel({ stage: "review", preScreen: pre })).not.toContain(hint);
  });
  it("asks for subjects only for an action that uses them", () => {
    expect(panel({ stage: "review" })).toContain("<legend>Subjects</legend>");
    expect(panel({ stage: "no_booking", preScreen: pre })).not.toContain("<legend>Subjects</legend>");
  });
});
