import { describe, expect, it } from "vitest";
import type { HiringConfig, Stage } from "../model";
import type { Assessment } from "../scoring";
import { profileGate } from "../insights";
import { softRejectPlan, type FormCandidate } from "../queue";

// Weights out of 100: degree 10, subject 10, curriculum 20, teaching 20, english 20, prestige 20.
const WEIGHTS = { degree: 10, subject: 10, curriculum: 20, teaching: 20, english: 20, prestige: 20, school: 0 };
const RIGHTS = "I have permanent work rights with no restrictions";
const assessment = (subject: string, english: "met" | "not_met" = "met"): Assessment => ({
  criteria: (["degree", "subject", "curriculum", "teaching", "english"] as const).map((id) => ({
    id,
    result: id === "english" ? english : "met",
    evidence: "quote",
    reason: "reason",
  })),
  subjects: [{ subject: subject as never, evidence: "quote", relevant: true }],
  universities: [],
  summary: "",
});
// prestige 0: met everywhere = 80, English not met = 60.
const row = (id: string, stage: Stage, subject: string, english: "met" | "not_met", over: Partial<FormCandidate> = {}): FormCandidate => ({
  id,
  stage,
  broughtBackAt: null,
  createdAt: new Date("2026-11-01T00:00:00Z"),
  email: `${id}@example.com`,
  previouslyContacted: false,
  workRightsAnswer: RIGHTS,
  profileAssessment: assessment(subject, english),
  universityAssessment: null,
  queueManual: null,
  callReview: null,
  callInvited: false,
  callBooked: false,
  ...over,
});
const config = {
  callThreshold: null,
  profileThreshold: 75,
  bringBackFloor: 50,
  profileWeights: WEIGHTS,
  acceptedWorkRights: [RIGHTS],
  subjectPriority: [
    { subject: "Physics", hiring: true },
    { subject: "Chemistry", hiring: true },
    { subject: "History", hiring: false },
  ],
} as unknown as HiringConfig;

describe("soft reject (Kevin, 25 Nov 2026)", () => {
  it("sets aside never-emailed rows under the pass score, from New and In review", () => {
    const plan = softRejectPlan(
      [
        row("pass", "new", "Physics", "met"),
        row("low-new", "new", "Physics", "not_met"),
        row("low-review", "review", "Chemistry", "not_met"),
        row("back", "new", "Physics", "not_met", { broughtBackAt: new Date() }),
        row("called", "new", "Physics", "not_met", { callReview: { good: { at: "2026-11-02T00:00:00Z", by: "hr" }, tries: [] } as never }),
      ],
      [],
      config,
    );
    expect(plan.reject.map((r) => r.id).sort()).toEqual(["low-new", "low-review"]);
    expect(plan.reject.find((r) => r.id === "low-new")?.score).toBe(60);
  });

  it("brings back the best soft-rejected row for a hiring subject with nobody queued, one a subject", () => {
    const plan = softRejectPlan(
      [row("physics-pass", "new", "Physics", "met")],
      [
        row("chem-a", "soft_rejected", "Chemistry", "not_met", { universityAssessment: { fraction: 0.5 } as never }),
        row("chem-b", "soft_rejected", "Chemistry", "not_met"),
        // Physics still has someone at the pass score, so nobody comes back for it.
        row("phys-low", "soft_rejected", "Physics", "not_met"),
        // History is not hiring: the gate has no open subject.
        row("hist-low", "soft_rejected", "History", "not_met"),
        // A rule the pass score does not cover still holds them.
        row("no-rights", "soft_rejected", "Chemistry", "not_met", { workRightsAnswer: "I require a visa" }),
      ],
      config,
    );
    expect(plan.bringBack).toEqual([{ id: "chem-a", subject: "Chemistry", score: 70 }]);
  });

  it("counts a row soft rejected this cycle as gone, so its subject can bring someone back", () => {
    const plan = softRejectPlan([row("low", "new", "Physics", "not_met")], [row("old", "soft_rejected", "Physics", "not_met")], config);
    expect(plan.reject.map((r) => r.id)).toEqual(["low"]);
    expect(plan.bringBack.map((r) => r.id)).toEqual(["old"]);
  });

  it("brings back nobody with a blank floor, or under the floor", () => {
    const soft = [row("chem", "soft_rejected", "Chemistry", "not_met")];
    expect(softRejectPlan([], soft, { ...config, bringBackFloor: null }).bringBack).toEqual([]);
    expect(softRejectPlan([], soft, { ...config, bringBackFloor: 61 }).bringBack).toEqual([]);
    expect(softRejectPlan([], soft, { ...config, bringBackFloor: 60 }).bringBack.map((r) => r.id)).toEqual(["chem"]);
  });

  it("restores a soft-rejected row that now passes, after the pass score is lowered", () => {
    const soft = [row("chem", "soft_rejected", "Chemistry", "not_met")];
    const plan = softRejectPlan([], soft, { ...config, profileThreshold: 60, bringBackFloor: null });
    expect(plan.restore).toEqual(["chem"]);
    expect(plan.bringBack).toEqual([]);
  });

  it("lets a brought-back candidate past the pass score, and only the pass score", () => {
    const low = row("x", "new", "Physics", "not_met");
    expect(profileGate(low, config).short).toEqual(["Below profile threshold"]);
    expect(profileGate({ ...low, broughtBackAt: new Date() }, config).eligible).toBe(true);
    expect(profileGate({ ...low, broughtBackAt: new Date(), workRightsAnswer: null }, config).short).toEqual(["Work-rights answer not accepted"]);
  });
});
