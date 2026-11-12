import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";
import { BAD_CALL_REASON, CallsScreen, callCommand, callState, callSubjects, triesText } from "../calls-screen";
import type { HiringData } from "../dashboard";

vi.mock("next/font/google", () => ({ Instrument_Serif: () => ({ variable: "" }) }));

const PRIORITY = [
  { subject: "Mathematics", hiring: true },
  { subject: "Physics", hiring: true },
  { subject: "Chemistry", hiring: true },
];
const candidate = (patch = {}) => ({
  id: "a",
  name: "Sample A",
  revision: 3,
  subjects: ["Mathematics"],
  profileScore: 86,
  profileAssessment: {
    briefSummary: "Strong maths tutor.",
    subjects: [
      { subject: "Physics", relevant: true },
      { subject: "Mathematics", relevant: true },
      { subject: "Chemistry", relevant: false },
    ],
  },
  universityAssessment: { name: "Chulalongkorn University" },
  seekApplicationId: "app-1",
  sourceIds: [],
  seekJobId: "95633167",
  callReview: null,
  ...patch,
});
const data = (patch = {}) =>
  ({
    candidates: [candidate(), candidate({ id: "b", name: "Sample B", profileScore: 92 }), candidate({ id: "c", name: "Not Listed" })],
    callOrder: ["b", "a"],
    calls: [],
    inviteOutbox: [],
    config: { callThreshold: 80, subjectPriority: PRIORITY, seekJobs: [{ jobId: "95633167" }] },
    ...patch,
  }) as unknown as HiringData;
const screen = (d = data()) =>
  renderToStaticMarkup(<CallsScreen data={d} extras={new Map()} holds={new Map()} onOpenRecord={() => {}} command={async () => true} busy={false} />);

describe("CallsScreen", () => {
  it("lists only the call queue, in the server's order, with the three results", () => {
    const html = screen();
    expect(html.indexOf("Sample B")).toBeLessThan(html.indexOf("Sample A"));
    expect(html).not.toContain("Not Listed");
    for (const word of ["Good call", "No answer", "Bad call", "2 to call", "Strong maths tutor.", "Not called yet", "Chulalongkorn University", "Also Physics"])
      expect(html).toContain(word);
    expect(html).toContain('href="https://th.employer.seek.com/candidates/?jobid=95633167&amp;selected=app-1&amp;tab=profile"');
    expect(html).toContain('target="_blank"');
  });
  it("shows the booked time and the phone number that the candidate gave", () => {
    const html = screen(
      data({
        candidates: [candidate({ phone: "+66812345678" }), candidate({ id: "b", name: "Sample B" })],
        calls: [{ candidateId: "a", start: "2026-11-16T03:15:00.000Z", end: "2026-11-16T03:30:00.000Z" }],
        inviteOutbox: [{ key: "b:call-invite", candidateId: "b", status: "sent", sentAt: "2026-11-12T02:00:00.000Z", error: null }],
      }),
    );
    expect(html).toContain("Booked Mon 16 Nov, 10:15");
    expect(html).toContain('href="tel:+66812345678"');
    expect(html).toContain("Invited 12 Nov");
    expect(html).toContain("Call booking");
  });
  it("says so when nobody is waiting, and when calls are off", () => {
    expect(screen(data({ callOrder: [] }))).toContain("Nobody is waiting for a call.");
    expect(screen(data({ callOrder: [], config: { callThreshold: null } }))).toContain("Calls are off.");
  });
});

describe("callState", () => {
  const invite = (status: string, sentAt: string | null = null) => [{ key: "a:call-invite", status, sentAt }];
  it("names the newest booked call first, then the state of the link email", () => {
    const calls = [
      { candidateId: "a", start: "2026-11-17T02:00:00.000Z" },
      { candidateId: "a", start: "2026-11-16T03:15:00.000Z" },
    ];
    expect(callState("a", calls, invite("sent", "2026-11-12T02:00:00.000Z"))).toBe("Booked Tue 17 Nov, 09:00");
    expect(callState("a", [], [])).toBe("Not invited");
    expect(callState("a", [], invite("cancelled"))).toBe("Not invited");
    expect(callState("a", [], invite("pending"))).toBe("Invitation queued");
    expect(callState("a", [], invite("uncertain"))).toBe("Invitation not confirmed");
    expect(callState("a", [], invite("failed"))).toBe("Invitation not confirmed");
    // Another candidate's rows never show.
    expect(callState("b", calls, invite("sent", "2026-11-12T02:00:00.000Z"))).toBe("Not invited");
  });
});

describe("callSubjects", () => {
  it("names the subject the form goes for first, then the other supported subjects", () => {
    expect(callSubjects(candidate() as never, PRIORITY as never)).toEqual({ main: "Mathematics", other: ["Physics"] });
  });
  it("says so when the profile supports no hiring subject", () => {
    expect(callSubjects({ profileAssessment: null }, PRIORITY as never)).toEqual({ main: "None found", other: [] });
  });
});

describe("callCommand", () => {
  const c = { id: "a", revision: 3, subjects: ["Mathematics" as const] };
  it("records a good call or a no answer, and stops on a bad call", () => {
    expect(callCommand(c, "good")).toEqual({ action: "call_result", id: "a", result: "good" });
    expect(callCommand(c, "no_answer")).toEqual({ action: "call_result", id: "a", result: "no_answer" });
    expect(callCommand(c, "bad")).toEqual({ action: "stop", id: "a", revision: 3, subjects: ["Mathematics"], reason: BAD_CALL_REASON });
  });
});

describe("triesText", () => {
  it("counts the no answers and gives the last one in Bangkok time", () => {
    const tries = [
      { at: "2026-11-04T02:00:00.000Z", by: "hr" },
      { at: "2026-11-04T09:30:00.000Z", by: "hr" },
    ];
    expect(triesText({ good: null, tries })).toBe("2 no answers · last 4 Nov, 16:30");
    expect(triesText({ good: null, tries: tries.slice(0, 1) })).toBe("1 no answer · last 4 Nov, 09:00");
  });
});
