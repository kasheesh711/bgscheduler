import { describe, expect, it } from "vitest";
import { preScreenFinalScore, preScreenQueue, sentBetween, visitEmail, wasSentForm } from "../prescreen-view";

const person = (patch = {}) => ({
  id: "a",
  stage: "pre_screen" as const,
  preScreen: { submittedAt: "1/11/2026, 05:00:00" } as { submittedAt: string } | null,
  preScreenAssessment: {} as unknown,
  preScreenHash: "h" as string | null,
  preScreenScore: 82 as number | null,
  preScreenOverride: null as { score: number } | null,
  ...patch,
});
const row = (status: string, key = "a:visit-invite", patch = {}) => ({ key, status, sentAt: null, ...patch });

describe("wasSentForm", () => {
  it("counts a form row that may have left, or a reply, and not a cancelled row", () => {
    expect(wasSentForm(person({ preScreen: null }), [row("pending", "a:pre-screen")])).toBe(true);
    expect(wasSentForm(person({ preScreen: null }), [row("cancelled", "a:pre-screen")])).toBe(false);
    expect(wasSentForm(person({ preScreen: null }), [])).toBe(false);
    expect(wasSentForm(person(), [])).toBe(true);
    expect(wasSentForm(person({ preScreen: null }), [row("sent", "b:pre-screen")])).toBe(false);
  });
});

describe("visitEmail", () => {
  it("reads the proof from the outbox, in Bangkok time", () => {
    expect(visitEmail(person(), [row("sent", "a:visit-invite", { sentAt: "2026-11-02T03:04:00Z" })], 50)).toEqual({ label: "Sent 2 Nov, 10:04", tone: "good", sent: true, sentDays: ["2026-11-02"] });
    expect(visitEmail(person(), [row("pending")], 50).label).toBe("Queued");
    expect(visitEmail(person(), [row("processing")], 50).label).toBe("Queued");
    expect(visitEmail(person(), [row("failed", "a:visit-invite", { error: "Mail down" })], 50)).toMatchObject({ tone: "bad", error: "Mail down" });
    expect(visitEmail(person(), [row("uncertain")], 50).tone).toBe("bad");
  });
  it("uses the newest row, including a new link, and ignores a reminder and another person", () => {
    const rows = [row("pending", "a:visit-invite:7"), row("sent", "a:visit-invite")];
    expect(visitEmail(person(), rows, 50).label).toBe("Queued");
    expect(visitEmail(person(), [row("sent", "a:visit-reminder:3")], 50).label).not.toMatch(/Sent/);
    expect(visitEmail(person(), [row("sent", "ab:visit-invite")], 50).label).not.toMatch(/Sent/);
  });
  it("keeps the proof of a sent email when a newer row is cancelled or failed", () => {
    const sent = row("sent", "a:visit-invite", { sentAt: "2026-11-02T03:04:00Z" });
    expect(visitEmail(person(), [row("cancelled", "a:visit-invite:7"), sent], 50)).toMatchObject({ label: "Sent 2 Nov, 10:04", sent: true });
    expect(visitEmail(person(), [row("failed", "a:visit-invite:7"), sent], 50)).toMatchObject({ label: "Failed, will retry", sent: true });
    expect(visitEmail(person(), [row("cancelled")], 50)).toMatchObject({ label: "Cancelled", sent: false });
  });
  it("says a stage change alone is not a sent email", () => {
    expect(visitEmail(person({ stage: "onsite_invited" }), [], 50).label).not.toMatch(/Sent/);
  });
  it("names a sent decision in place of an old state", () => {
    expect(visitEmail(person({ stage: "rejected", preScreen: null }), [], 50).label).toBe("Rejected");
    expect(visitEmail(person({ stage: "hired" }), [], 50).label).toBe("Hired");
  });
  it("gives the reason when there is no email", () => {
    expect(visitEmail(person({ preScreen: null }), [], 50).label).toBe("Waiting for reply");
    expect(visitEmail(person({ preScreen: null, stage: "no_reply" }), [], 50).label).toBe("Not sent: no reply");
    expect(visitEmail(person({ preScreenAssessment: null, preScreenHash: null }), [], 50).label).toBe("Not scored yet");
    expect(visitEmail(person({ preScreenAssessment: null }), [], 50).label).toBe("Could not score");
    expect(visitEmail(person(), [], null).label).toBe("No pass score set");
    expect(visitEmail(person({ preScreenScore: 40 }), [], 50).label).toBe("Not sent: below pass score");
    expect(visitEmail(person({ stage: "stopped" }), [], 50).label).toBe("Not sent: stopped");
    expect(visitEmail(person({ stage: "paper_booked" }), [], 50).label).toBe("Old flow: Paper booked");
    expect(visitEmail(person({ preScreenOverride: { score: 90 } }), [], 50).label).toBe("A person decides");
  });
});

describe("list filters", () => {
  it("retains a stopped candidate after cancelling their only form email", () => {
    const candidate = { ...person({ preScreen: null }), stage: "stopped" as const };
    const queue = preScreenQueue([{ candidate, outbox: [row("cancelled", "a:pre-screen")], booked: false }], new Date(), 50, {});
    expect(queue.stopped).toMatchObject([{ group: "closed", fact: "Stopped" }]);
    expect(queue.all).toEqual(queue.stopped);
    expect(queue.waiting).toHaveLength(0);
  });
  it("uses a person's score in place of the AI's", () => {
    const changed = person({ preScreenScore: 40, preScreenOverride: { score: 70 } });
    expect(preScreenFinalScore(changed)).toBe(70);
  });
  it("changes reply age at Bangkok midnight and flags waiting only after 72 hours", () => {
    const replied = { candidate: person({ preScreen: { submittedAt: "2026-11-25T16:59:00" } }), outbox: [], booked: false };
    const waiting = {
      candidate: person({ id: "b", preScreen: null }),
      outbox: [row("sent", "b:pre-screen", { sentAt: "2026-11-22T17:01:00Z" })],
      booked: false,
    };
    const atMidnight = preScreenQueue([replied, waiting], new Date("2026-11-25T17:00:00Z"), 50, {});
    expect(atMidnight.decision[0].fact).toBe("Replied 1 day ago");
    expect(atMidnight.waiting[0].overdue).toBe(false);
    const aMinuteLater = preScreenQueue([replied, waiting], new Date("2026-11-25T17:01:00Z"), 50, {});
    expect(aMinuteLater.waiting[0].overdue).toBe(true);
  });
});

describe("sentBetween", () => {
  it("uses the Bangkok day each invitation left", () => {
    // 17:30 UTC on 19 Nov is 00:30 on 20 Nov in Bangkok.
    const rows = [row("pending", "a:visit-invite:2"), row("sent", "a:visit-invite:1", { sentAt: "2026-11-19T17:30:00Z" }), row("sent", "a:visit-invite", { sentAt: "2026-11-05T03:00:00Z" })];
    expect(visitEmail(person(), rows, 50).sentDays).toEqual(["2026-11-20", "2026-11-05"]);
    expect(visitEmail(person(), [row("sent")], 50).sentDays).toEqual([]);
  });
  it("keeps both ends, leaves empty ends open, and counts any send", () => {
    const sent = { sentDays: ["2026-11-20"] };
    expect(sentBetween(sent, "", "")).toBe(true);
    expect(sentBetween({ sentDays: [] }, "", "")).toBe(true);
    expect(sentBetween(sent, "2026-11-20", "2026-11-20")).toBe(true);
    expect(sentBetween(sent, "2026-11-21", "")).toBe(false);
    expect(sentBetween(sent, "", "2026-11-19")).toBe(false);
    expect(sentBetween({ sentDays: [] }, "2026-11-01", "")).toBe(false);
    expect(sentBetween({ sentDays: ["2026-11-20", "2026-11-05"] }, "2026-11-01", "2026-11-10")).toBe(true);
    expect(sentBetween(sent, "2026-11-25", "2026-11-15")).toBe(false);
  });
});
