import { describe, expect, it } from "vitest";
import { preScreenQueue } from "../prescreen-view";

const NOW = new Date("2026-11-25T05:00:00Z");
type Entry = Parameters<typeof preScreenQueue>[0][number];
const reply = (id: string, change: Partial<Entry["candidate"]> = {}): Entry => ({
  candidate: {
    id, stage: "review", preScreen: { submittedAt: "22/11/2026, 05:00:00" }, preScreenRepliedAt: null,
    preScreenAssessment: {}, preScreenHash: "scored", preScreenScore: 75, preScreenOverride: null, ...change,
  },
  booked: false,
  outbox: [],
});
const form = (id: string, sentAt: string | null, status = "sent") => ({ key: `${id}:pre-screen`, status, sentAt });
const invite = (id: string, status: string) => ({ key: `${id}:visit-invite:2`, status, sentAt: null });
const waiting = (id: string, ...outbox: Entry["outbox"]): Entry => ({
  ...reply(id, { stage: "pre_screen", preScreen: null }), outbox,
});

describe("preScreenQueue", () => {
  it("sorts unresolved replies by age and then ID, regardless of score", () => {
    const queue = preScreenQueue([
      reply("newer", { preScreen: { submittedAt: "2026-11-24T05:00:00Z" }, preScreenScore: 95 }),
      reply("tie-b"),
      reply("first", { preScreenRepliedAt: new Date("2026-11-20T05:00:00Z"), preScreenScore: 44 }),
      reply("tie-a", { preScreenScore: 21, preScreenOverride: { score: 88 } }),
      reply("unknown", { preScreen: { submittedAt: "unknown" } }),
    ], NOW, 50, {});
    expect(queue.decision.map((row) => [row.candidate.id, row.score, row.fact])).toEqual([
      ["first", 44, "Below pass score"], ["tie-a", 88, "Replied 3 days ago"], ["tie-b", 75, "Replied 3 days ago"],
      ["newer", 95, "Replied 1 day ago"], ["unknown", 75, "Reply received"],
    ]);
  });

  it("counts waiting days from the successful form send, with an inclusive three-day cutoff", () => {
    const queue = preScreenQueue([
      waiting("recent", form("recent", "2026-11-22T05:01:00Z")),
      waiting("overdue", form("overdue", "2026-11-22T05:00:00Z")),
      waiting("failed", form("failed", null, "failed")),
      waiting("queued", form("queued", null, "pending")),
      waiting("never"),
    ], NOW, 50, {});
    expect(queue.waiting.map((row) => [row.candidate.id, row.days, row.overdue])).toEqual([["overdue", 3, true], ["recent", 2, false]]);
    expect(queue.all.find((row) => row.candidate.id === "failed")).toMatchObject({ fact: "Email failed", emailLogKey: "failed:pre-screen" });
    expect(queue.all.map((row) => row.candidate.id)).toEqual(["overdue", "recent", "failed", "queued"]);
  });

  it("keeps invitations, bookings, set-asides, holds and closed records out of decisions", () => {
    const queue = preScreenQueue([
      { ...reply("booked", { preScreen: null }), booked: true },
      reply("stage-booked", { stage: "onsite_booked", preScreen: null }),
      { ...reply("invited"), outbox: [invite("invited", "sent")] },
      { ...reply("queued"), outbox: [invite("queued", "pending")] },
      { ...reply("failed"), outbox: [invite("failed", "failed")] },
      { ...reply("cancelled"), outbox: [invite("cancelled", "cancelled")] },
      reply("aside", { stage: "soft_rejected", preScreenScore: 41 }),
      reply("held"),
      reply("next"),
      { ...reply("stopped", { stage: "stopped" }), booked: true, outbox: [invite("stopped", "uncertain")] },
      reply("closed", { stage: "hired" }),
    ], NOW, 50, { held: { state: "held" }, next: { state: "next" } });
    const ids = (group: typeof queue.all) => group.map(({ candidate }) => candidate.id);
    expect(ids(queue.decision)).toEqual(["cancelled", "next"]);
    expect(ids(queue.invited)).toEqual(["booked", "stage-booked", "invited", "queued", "failed"]);
    expect(ids(queue.aside)).toEqual(["aside"]);
    expect(ids(queue.held)).toEqual(["held"]);
    expect(ids(queue.closed)).toEqual(["stopped", "closed"]);
    expect(queue.closed[0]).toMatchObject({ fact: "Stopped", booked: true, emailLogKey: "stopped:visit-invite:2" });
    expect(queue.invited.at(-1)).toMatchObject({ fact: "Email failed", pendingVisitEmail: true, emailLogKey: "failed:visit-invite:2" });
  });
});
