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
  mockStart: "2026-11-03T05:00:00.000Z",
  mockEnd: "2026-11-03T06:00:00.000Z",
  interviewerKey: "Peat",
  subject: "Mathematics" as const,
};
const view = (patch = {}) => ({
  kind: "visit" as const,
  subject: "Mathematics" as const,
  location: "Gaysorn",
  enabled: true,
  slots: [slot],
  visit: null,
  canMove: false,
  notice: null,
  checkedAt: null as string | null,
  ...patch,
});
const page = (patch = {}) => renderToStaticMarkup(<VisitBooking token="t" view={view(patch)} reload={async () => {}} />);

describe("VisitBooking", () => {
  it("shows one subject, exam and mock times, and both confirmation boxes", () => {
    const html = page();
    expect(html).toContain("Mathematics");
    expect(html).toContain("10:00");
    expect(html).toContain("12:00");
    expect(html).toContain("13:00");
    expect(html).toContain("I will attend onsite");
    expect(html).toContain("I can teach onsite");
    expect(html).not.toContain("Peat");
    // The live-check line shows only when the list came from a live Wise read.
    expect(html).not.toContain("Live schedule");
    expect(page({ checkedAt: "2026-11-02T02:05:00.000Z" })).toContain("Live schedule, checked 09:05");
  });
  it("shows the notice and the LINE contact, and no form, for an empty list or a stale snapshot", () => {
    const html = page({ slots: [], notice: `Times cannot be shown. Contact BeGifted on LINE: ${LINE}` });
    expect(html).toContain("Times cannot be shown");
    expect(html).toContain(`href="${LINE}"`);
    expect(html).not.toContain("I will attend onsite");
    expect(html).not.toContain("Confirm visit");
  });
  it("makes the address in a notice a real link, with no second link in the footer, and renders no HTML from the text", () => {
    const html = page({ slots: [], notice: `<b>Closed</b>. Contact BeGifted on LINE: ${LINE}` });
    expect(html.match(/href="https:\/\/lin\.ee\/OjMHF41"/g)).toHaveLength(1);
    expect(html).toContain(`>${LINE}</a>`);
    expect(html).toContain("&lt;b&gt;Closed&lt;/b&gt;");
    expect(html).not.toContain("For help or changes");
    // With no notice, the footer stays.
    expect(page()).toContain("For help or changes");
  });
  it("shows a fallback and the link for an empty list with no notice, never a blank page", () => {
    const html = page({ slots: [], notice: null });
    expect(html).toContain("no open visit times");
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
    mockStart: slot.mockStart,
    mockEnd: slot.mockEnd,
    head: "Peat",
  };
  it("shows the current booking with a Move button while a move is open", () => {
    const html = page({ visit: booked, canMove: true });
    expect(html).toContain("Your booked visit");
    expect(html).toContain("Peat");
    expect(html).toContain("Move this visit");
    // The times to choose stay hidden until the candidate presses Move.
    expect(html).not.toContain("I will attend onsite");
    expect(html).not.toContain("You cannot move it now");
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
        weights={{ degree: 20, subject: 20, curriculum: 20, teaching: 20, english: 20, prestige: 0 }}
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
        weights={{ degree: 20, subject: 20, curriculum: 20, teaching: 20, english: 20, prestige: 0 }}
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
