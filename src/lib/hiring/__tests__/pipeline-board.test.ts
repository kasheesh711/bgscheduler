import { describe, expect, it } from "vitest";
import { buildPipelineBoard, NEEDS_REVIEW, type PipelineBoardInput } from "../pipeline-board";

const NOW = new Date("2026-11-20T05:00:00Z"); // 20 Nov 12:00 Bangkok
const at = (d: string) => `2026-11-${d}T03:00:00Z`; // 10:00 Bangkok
type Candidate = PipelineBoardInput["candidates"][number];
const candidate = (id: string, stage: string, patch: Partial<Candidate> = {}): Candidate => ({
  id,
  name: `Name ${id}`,
  stage,
  createdAt: at("01"),
  seekJobId: null,
  preScreenRepliedAt: null,
  callReview: null,
  subjects: ["Physics", "Mathematics"],
  visitSubject: null,
  ...patch,
});
const good = (d: string) => ({ callReview: { good: { at: at(d) } } });
const visit = (candidateId: string, d: string, patch: Partial<PipelineBoardInput["bookings"][number]> = {}) => ({
  candidateId,
  kind: "mock",
  status: "confirmed",
  startTime: at(d),
  createdAt: at("10"),
  interviewerKey: "Peat",
  ...patch,
});
const headDecision = (candidateId: string, decision: "hire" | "reject", d: string) => ({
  candidateId,
  decision,
  reason: "",
  head: "Peat",
  draftProblem: null,
  at: at(d),
});
const empty: PipelineBoardInput = { candidates: [], bookings: [], calls: [], inviteOutbox: [], decisions: [], funnelEvents: [], headDecisions: [] };
const build = (patch: Partial<PipelineBoardInput>) => buildPipelineBoard({ ...empty, ...patch }, NOW);
const column = (board: ReturnType<typeof build>, key: string) => board.columns.find((c) => c.key === key)!;
const where = (board: ReturnType<typeof build>, id: string) => board.columns.find((c) => c.cards.some((card) => card.id === id))?.key ?? null;

describe("buildPipelineBoard", () => {
  it("puts a booked call in HR call booked, and marks a passed call with no result", () => {
    const board = build({
      candidates: [candidate("ahead", "new"), candidate("late", "new"), candidate("before", "new")],
      calls: [{ candidateId: "ahead", start: at("21") }, { candidateId: "late", start: at("15") }],
      funnelEvents: [{ candidateId: "ahead", action: "call-booked", at: at("18") }],
    });
    const cards = column(board, "call").cards;
    // The stuck card comes first.
    expect(cards.map((c) => c.id)).toEqual(["late", "ahead"]);
    expect(cards[0]).toMatchObject({ days: 5, stuck: true, owner: "HR", note: "Call was 15 Nov 10:00. Result not recorded." });
    expect(cards[1]).toMatchObject({ days: 2, stuck: false, note: "Call 21 Nov 10:00", subject: "Physics" });
    // No call yet: before the HR call, so not on the board.
    expect(where(board, "before")).toBeNull();
  });

  it("puts a good call with no visit in Form and visit link, with the wait named", () => {
    const board = build({
      candidates: [
        candidate("unsent", "new", good("19")),
        candidate("form", "pre_screen", good("05")),
        candidate("place", "pre_screen", { ...good("05"), preScreenRepliedAt: at("18") }),
        candidate("book", "onsite_invited"),
        candidate("odd", "review", good("19")),
      ],
      inviteOutbox: [
        { key: "form:pre-screen", status: "sent", sentAt: at("10") },
        { key: "place:pre-screen", status: "sent", sentAt: at("17") },
        { key: "book:visit-invite", status: "sent", sentAt: at("18") },
      ],
    });
    const cards = Object.fromEntries(column(board, "form").cards.map((c) => [c.id, c]));
    expect(cards.unsent).toMatchObject({ days: 1, stuck: false, note: "Next steps email not sent yet", owner: "HR" });
    // 10 days after the form went: over the 7-day limit.
    expect(cards.form).toMatchObject({ days: 10, stuck: true, note: "Waits for the form", owner: "Candidate" });
    expect(cards.place).toMatchObject({ days: 3, stuck: false, owner: "Kevin" });
    expect(cards.book).toMatchObject({ days: 2, stuck: false, note: "Waits for a visit booking" });
    // Fail closed: a good call at a stage with no known next step stays on the board.
    expect(cards.odd.note).toBe(NEEDS_REVIEW);
  });

  it("splits booked visits by the visit time", () => {
    const board = build({
      candidates: [
        candidate("soon", "onsite_booked", { visitSubject: "Chemistry" }),
        candidate("done", "onsite_booked"),
        candidate("fresh", "onsite_booked"),
        candidate("lost", "onsite_booked"),
      ],
      bookings: [
        visit("soon", "22"),
        visit("soon", "22", { kind: "paper", interviewerKey: null }),
        visit("done", "15"),
        visit("fresh", "19"),
        visit("lost", "22", { status: "cancelled" }),
      ],
    });
    expect(column(board, "visit").cards.find((c) => c.id === "soon")).toMatchObject({
      subject: "Chemistry",
      days: 10,
      stuck: false,
      note: "Visit 22 Nov 10:00 · Peat",
    });
    const marking = column(board, "marking");
    expect(marking.cards.map((c) => c.id)).toEqual(["done", "fresh"]);
    expect(marking.cards[0]).toMatchObject({ days: 5, stuck: true, owner: "Peat", note: "Visited 15 Nov. No head decision." });
    expect(marking.cards[1]).toMatchObject({ days: 1, stuck: false });
    expect(marking).toMatchObject({ count: 2, stuck: 1, medianDays: 3 });
    // Fail closed: the stage says a visit is booked, but no confirmed visit is in the data.
    expect(column(board, "visit").cards.find((c) => c.id === "lost")?.note).toBe(NEEDS_REVIEW);
  });

  it("moves a head decision to Final review until the result is sent, then to Offer and signing", () => {
    const board = build({
      candidates: [
        candidate("yes", "onsite_booked"),
        candidate("no", "onsite_booked"),
        candidate("offer", "hired"),
        candidate("bare", "hired"),
      ],
      bookings: [visit("yes", "15"), visit("no", "15")],
      headDecisions: [headDecision("yes", "hire", "19"), headDecision("no", "reject", "16"), headDecision("offer", "hire", "12")],
      decisions: [{ candidateId: "offer", decision: "hire", status: "sent", sentAt: at("14") }],
    });
    const review = Object.fromEntries(column(board, "review").cards.map((c) => [c.id, c]));
    expect(review.yes).toMatchObject({ days: 1, stuck: false, note: "Peat said Yes", owner: "HR, then Gift" });
    expect(review.no).toMatchObject({ days: 4, stuck: true, note: "Peat said No", owner: "HR" });
    const offer = Object.fromEntries(column(board, "offer").cards.map((c) => [c.id, c]));
    expect(offer.offer).toMatchObject({ days: 6, stuck: false, note: "Offer sent 14 Nov" });
    // Fail closed: hired with no sent offer on record.
    expect(offer.bare.note).toBe(NEEDS_REVIEW);
  });

  it("keeps a form or old-flow invitation with no HR call on the board", () => {
    // A score below the call score gets the form with no call.
    const board = build({ candidates: [candidate("form", "pre_screen"), candidate("old", "paper_invited")] });
    expect(where(board, "form")).toBe("form");
    expect(where(board, "old")).toBe("form");
  });

  it("leaves closed and parked candidates out", () => {
    const board = build({
      candidates: ["rejected", "stopped", "no_reply", "no_booking"].map((stage) => candidate(stage, stage, good("05"))),
      bookings: [visit("rejected", "15")],
      headDecisions: [headDecision("stopped", "hire", "19")],
    });
    expect(board.columns.every((c) => c.count === 0 && c.medianDays === null)).toBe(true);
    expect(board.bottleneck).toBeNull();
  });

  it("names the column with the most stuck cards, and the larger median on a tie", () => {
    const stuckCall = { candidates: [candidate("late", "new")], calls: [{ candidateId: "late", start: at("15") }] };
    expect(build(stuckCall).bottleneck).toBe("call");
    // One stuck card each: marking waits 9 days, the call 5.
    const tie = build({
      candidates: [...stuckCall.candidates, candidate("done", "onsite_booked")],
      calls: stuckCall.calls,
      bookings: [visit("done", "11")],
    });
    expect(tie.bottleneck).toBe("marking");
  });

  it("with nobody stuck, names a column only when it holds 3 more than every other", () => {
    const waiting = (n: number) => Array.from({ length: n }, (_, i) => candidate(`w${i}`, "new", good("19")));
    expect(build({ candidates: waiting(2) }).bottleneck).toBeNull();
    expect(build({ candidates: waiting(3) }).bottleneck).toBe("form");
    // The offer column has no end mark, so its size alone never makes it the bottleneck.
    const hired = Array.from({ length: 4 }, (_, i) => candidate(`h${i}`, "hired"));
    expect(build({ candidates: hired }).bottleneck).toBeNull();
  });
});
