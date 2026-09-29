import { describe, expect, it } from "vitest";
import { resolveBilling, scheduledDurationCredits } from "../billing";

const autoBlank = (sessionStatus: string | null, creditsConsumed: number | null) =>
  ({ kind: "auto_blank", submissionId: "s1", sessionStatus, creditsConsumed }) as const;

describe("scheduledDurationCredits", () => {
  it("rounds up to 15-minute blocks like the Wise web app", () => {
    expect(scheduledDurationCredits(60)).toBe(1);
    expect(scheduledDurationCredits(90)).toBe(1.5);
    expect(scheduledDurationCredits(50)).toBe(1);
    expect(scheduledDurationCredits(61)).toBe(1.25);
  });
});

describe("resolveBilling", () => {
  it("re-sends an auto-submission's own status and credits and expects no new charge", () => {
    expect(resolveBilling({ submission: autoBlank("COMPLETED", 1), scheduledMinutes: 60 })).toEqual({
      ok: true,
      plan: { sessionStatus: "COMPLETED", creditsConsumed: 1, source: "auto_blank_reuse", expectedConsumedDelta: 0 },
    });
  });

  it("refuses an auto-submission whose credits disagree with the schedule", () => {
    expect(resolveBilling({ submission: autoBlank("COMPLETED", 2), scheduledMinutes: 60 }).ok).toBe(false);
    expect(resolveBilling({ submission: autoBlank("NOT_COMPLETED", 0), scheduledMinutes: 60 }).ok).toBe(false);
    expect(resolveBilling({ submission: autoBlank("COMPLETED", null), scheduledMinutes: 60 }).ok).toBe(false);
  });

  it("needs two agreeing priors and enough balance for an unsubmitted session", () => {
    const priors = [
      { sessionStatus: "COMPLETED", creditsConsumed: 1, scheduledMinutes: 60 },
      { sessionStatus: "COMPLETED", creditsConsumed: 1, scheduledMinutes: 60 },
    ];
    const credits = { available: 5, sessionAlreadyCharged: false };
    expect(resolveBilling({ submission: { kind: "none" }, scheduledMinutes: 60, priors, studentCredits: credits })).toEqual({
      ok: true,
      plan: { sessionStatus: "COMPLETED", creditsConsumed: 1, source: "prior_submissions", expectedConsumedDelta: 1 },
    });
    expect(resolveBilling({ submission: { kind: "none" }, scheduledMinutes: 60, priors: priors.slice(0, 1), studentCredits: credits }))
      .toEqual({ ok: false, reason: "too_few_prior_submissions" });
    expect(resolveBilling({
      submission: { kind: "none" },
      scheduledMinutes: 60,
      priors: [...priors.slice(0, 1), { sessionStatus: "COMPLETED", creditsConsumed: 0.5, scheduledMinutes: 60 }],
      studentCredits: credits,
    })).toEqual({ ok: false, reason: "prior_credits_disagree" });
    expect(resolveBilling({ submission: { kind: "none" }, scheduledMinutes: 60, priors, studentCredits: { available: 0.5, sessionAlreadyCharged: false } }))
      .toEqual({ ok: false, reason: "insufficient_student_credits" });
    expect(resolveBilling({ submission: { kind: "none" }, scheduledMinutes: 60, priors, studentCredits: { available: 5, sessionAlreadyCharged: true } }))
      .toEqual({ ok: false, reason: "session_already_charged" });
  });

  it("never bills over human feedback", () => {
    expect(resolveBilling({ submission: { kind: "human", submissionId: "s", blank: false }, scheduledMinutes: 60 }))
      .toEqual({ ok: false, reason: "submission_human" });
  });
});
