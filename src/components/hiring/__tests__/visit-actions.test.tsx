import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";
import type { CandidateExtras } from "@/lib/hiring/status";
import { VisitBooking } from "../booking";
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
  });
  it("shows the notice and the LINE contact, and no form, for an empty list or a stale snapshot", () => {
    const html = page({ slots: [], notice: `Times cannot be shown. Contact BeGifted on LINE: ${LINE}` });
    expect(html).toContain("Times cannot be shown");
    expect(html).toContain(`href="${LINE}"`);
    expect(html).not.toContain("I will attend onsite");
    expect(html).not.toContain("Confirm visit");
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
  });
  it("shows no Move button when the move is used", () => {
    const html = page({ visit: booked, slots: [], canMove: false, notice: `Contact BeGifted on LINE: ${LINE}` });
    expect(html).toContain("Your booked visit");
    expect(html).not.toContain("Move this visit");
    expect(html).toContain(LINE);
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
        extras={{ pre: { status: "Replied", sentAt: null, remindedAt: null, repliedAt: null }, visit }}
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
    ["invited", { stage: "onsite_invited", preScreen: pre }, null, ["Stop processing"]],
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
