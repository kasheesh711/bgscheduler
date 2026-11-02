import { describe, expect, it } from "vitest";
import { matchesPreScreenList, preScreenFinalScore, visitEmail, wasSentForm } from "../prescreen-view";

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
    expect(visitEmail(person(), [row("sent", "a:visit-invite", { sentAt: "2026-11-02T03:04:00Z" })], 50)).toEqual({ label: "Sent 2 Nov, 10:04", tone: "good", sent: true });
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
  it("gives the reason when there is no email", () => {
    expect(visitEmail(person({ preScreen: null }), [], 50).label).toBe("Waiting for reply");
    expect(visitEmail(person({ preScreen: null, stage: "no_reply" }), [], 50).label).toBe("Not sent: no reply");
    expect(visitEmail(person({ preScreenAssessment: null, preScreenHash: null }), [], 50).label).toBe("Not scored yet");
    expect(visitEmail(person({ preScreenAssessment: null }), [], 50).label).toBe("Could not score");
    expect(visitEmail(person(), [], null).label).toBe("No pass score set");
    expect(visitEmail(person({ preScreenScore: 40 }), [], 50).label).toBe("Not sent: below pass score");
    expect(visitEmail(person({ stage: "stopped" }), [], 50).label).toBe("Not sent: stopped");
    expect(visitEmail(person({ stage: "paper_booked" }), [], 50).label).toBe("Old flow: Paper booked");
    expect(visitEmail(person(), [], 50, "Onsite queue 2 · weekly limit 3").label).toBe("Onsite queue 2 · weekly limit 3");
    expect(visitEmail(person({ preScreenOverride: { score: 90 } }), [], 50).label).toBe("A person decides");
  });
});

describe("list filters", () => {
  const email = { label: "", tone: "none" as const, sent: false };
  it("uses a person's score in place of the AI's", () => {
    const changed = person({ preScreenScore: 40, preScreenOverride: { score: 70 } });
    expect(preScreenFinalScore(changed)).toBe(70);
    expect(matchesPreScreenList(changed, "Passed", 50, email)).toBe(true);
    expect(matchesPreScreenList(changed, "Below pass score", 50, email)).toBe(false);
  });
  it("keeps unscored people and a missing pass score out of Passed and Below", () => {
    expect(matchesPreScreenList(person({ preScreenScore: null }), "Passed", 50, email)).toBe(false);
    expect(matchesPreScreenList(person({ preScreenScore: null }), "Below pass score", 50, email)).toBe(false);
    expect(matchesPreScreenList(person(), "Passed", null, email)).toBe(false);
  });
  it("filters replies and sent email", () => {
    expect(matchesPreScreenList(person(), "Replied", 50, email)).toBe(true);
    expect(matchesPreScreenList(person({ preScreen: null }), "No reply", 50, email)).toBe(true);
    expect(matchesPreScreenList(person(), "Visit email sent", 50, { ...email, sent: true })).toBe(true);
    expect(matchesPreScreenList(person(), "Visit email sent", 50, email)).toBe(false);
  });
});
