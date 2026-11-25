import { describe, expect, it } from "vitest";
import type { Stage } from "../model";
import type { Assessment } from "../scoring";
import { buildGems } from "../gems";
import { buildNextEmails } from "../next-emails";
import { buildForecast } from "../forecast";

const WEIGHTS = { degree: 10, subject: 10, curriculum: 20, teaching: 20, english: 20, prestige: 20, school: 0 };
const met = (degree: Assessment["criteria"][number]["result"] = "met"): Assessment => ({
  criteria: (["degree", "subject", "curriculum", "teaching", "english"] as const).map((id) => ({ id, result: id === "degree" ? degree : "met", evidence: "q", reason: "r" })),
  subjects: [{ subject: "Physics", evidence: "q", relevant: true }],
  universities: [],
  summary: "",
});
const RIGHTS = "I have permanent work rights with no restrictions";
const config = {
  callThreshold: null,
  profileThreshold: 75,
  profileWeights: WEIGHTS,
  acceptedWorkRights: [RIGHTS],
  subjectPriority: [{ subject: "Physics" as const, hiring: true }],
};
const person = (id: string, stage: Stage, over: Record<string, unknown> = {}) => ({
  id,
  name: id,
  stage,
  email: `${id}@example.com`,
  previouslyContacted: false,
  workRightsAnswer: RIGHTS as string | null,
  profileAssessment: met() as Assessment | null,
  universityAssessment: null as { fraction: number } | null,
  profileScore: 80 as number | null,
  ...over,
});

describe("buildGems", () => {
  it("finds the three kinds and leaves ordinary rows out", () => {
    const gems = buildGems(
      [
        person("school", "new", { profileScore: 60, universityAssessment: { fraction: 0.9 } }),
        person("weak-school", "new", { profileScore: 60, universityAssessment: { fraction: 0.5 } }),
        person("busy", "pre_screen", { profileScore: 60, universityAssessment: { fraction: 0.9 } }),
        person("rights", "review", { workRightsAnswer: "I require a visa" }),
        person("two-rules", "review", { workRightsAnswer: "I require a visa", email: null }),
        person("low", "new", { profileScore: 50, workRightsAnswer: "I require a visa" }),
        person("idle", "onsite_invited"),
        person("closed-idle", "rejected"),
        person("fresh", "onsite_invited"),
        person("booked", "onsite_booked"),
        person("both", "review", { workRightsAnswer: "I require a visa" }),
      ] as never,
      config as never,
      { idle: { stageKey: "onsite_invited", daysInStage: 20, stuck: true }, "closed-idle": { stageKey: "rejected", daysInStage: 30, stuck: false }, fresh: { stageKey: "onsite_invited", daysInStage: 2, stuck: false }, booked: { stageKey: "onsite_booked", daysInStage: 20, stuck: false }, both: { stageKey: "review", daysInStage: 30, stuck: true } },
      new Set(["booked"]),
    );
    expect(gems.school.map((g) => g.id)).toEqual(["school"]);
    // "both" is blocked and idle: it shows once, as blocked.
    expect(gems.blocker.map((g) => g.id).sort()).toEqual(["both", "rights"]);
    expect(gems.blocker[0]).toMatchObject({ reason: "Work-rights answer not accepted" });
    expect(gems.idle).toEqual([expect.objectContaining({ id: "idle", reason: "20 d in visit invite" })]);
  });
});

describe("buildNextEmails", () => {
  // Wed 25 Nov 2026, 10:00 Bangkok.
  const now = new Date("2026-11-25T03:00:00Z");
  const cfg = { preScreenFollowUp: { remindDays: 3, expireDays: 7 }, onsiteFollowUp: { remindDays: 3, expireDays: 7 } };
  it("orders queue sends and reminders by when they go", () => {
    const rows = buildNextEmails(
      {
        candidates: [
          { id: "n", name: "Next", stage: "new", preScreen: null },
          { id: "d", name: "Daily", stage: "new", preScreen: null },
          { id: "w", name: "Weekly", stage: "review", preScreen: null },
          { id: "s", name: "Subject", stage: "new", preScreen: null },
          { id: "r", name: "Reminder", stage: "pre_screen", preScreen: null, subjects: ["Physics"] },
          { id: "done", name: "Reminded", stage: "pre_screen", preScreen: null },
          { id: "v", name: "Visit", stage: "onsite_invited", preScreen: {}, inviteExpiresAt: "2026-12-20T00:00:00Z" },
          { id: "nolink", name: "No link expiry", stage: "onsite_invited", preScreen: {} },
          { id: "q", name: "Queued form", stage: "new", preScreen: null },
          { id: "f", name: "Failed reminder", stage: "pre_screen", preScreen: null },
          { id: "old", name: "Expired", stage: "pre_screen", preScreen: null },
          { id: "dead", name: "Dead link", stage: "onsite_invited", preScreen: {}, inviteExpiresAt: "2026-11-24T00:00:00Z" },
          { id: "p", name: "Pending", stage: "pre_screen", preScreen: null },
          { id: "n2", name: "Aaa first by name", stage: "new", preScreen: null },
          { id: "seek", name: "Contacted on SEEK", stage: "pre_screen", preScreen: null, previouslyContacted: true },
          { id: "nomail", name: "No address", stage: "pre_screen", preScreen: null, email: null },
        ],
        preScreenOrder: ["n", "n2"],
        holds: {
          n: { funnel: "pre_screen", state: "next", position: 0, limit: null, subject: "Physics" },
          n2: { funnel: "pre_screen", state: "next", position: 0, limit: null, subject: "Physics" },
          d: { funnel: "pre_screen", state: "held", position: 2, limit: "perDay", subject: "Physics" },
          w: { funnel: "onsite", state: "held", position: 1, limit: "perWeek", subject: "Physics" },
          s: { funnel: "pre_screen", state: "held", position: 3, limit: "perSubject", subject: "Biology" },
        },
        outbox: [
          { key: "done:pre-screen-reminder", status: "sent", sentAt: "2026-11-24T03:00:00Z" },
          { key: "p:pre-screen-reminder", status: "pending", sentAt: null },
          { key: "f:pre-screen-reminder", status: "failed", sentAt: null, workflowStage: "pre_screen" },
          { key: "q:pre-screen", status: "pending", sentAt: null, workflowStage: "new" },
          // Stale: written for pre_screen, the person moved on to review.
          { key: "w:pre-screen", status: "pending", sentAt: null, workflowStage: "pre_screen" },
          // Duplicate: n is next in the queue and also has a written form row.
          { key: "n:pre-screen", status: "pending", sentAt: null, workflowStage: "new" },
        ],
        inviteOutbox: [
          { key: "r:pre-screen", status: "sent", sentAt: "2026-11-24T03:00:00Z" },
          { key: "done:pre-screen", status: "sent", sentAt: "2026-11-20T03:00:00Z" },
          { key: "v:visit-invite:3", status: "cancelled", sentAt: null },
          { key: "v:visit-invite:2", status: "sent", sentAt: "2026-11-20T03:00:00Z" },
          { key: "nolink:visit-invite:1", status: "sent", sentAt: "2026-11-20T03:00:00Z" },
          { key: "f:pre-screen", status: "sent", sentAt: "2026-11-21T03:00:00Z" },
          { key: "old:pre-screen", status: "sent", sentAt: "2026-11-10T03:00:00Z" },
          { key: "dead:visit-invite:1", status: "sent", sentAt: "2026-11-20T03:00:00Z" },
          { key: "seek:pre-screen", status: "sent", sentAt: "2026-11-24T03:00:00Z" },
          { key: "nomail:pre-screen", status: "sent", sentAt: "2026-11-24T03:00:00Z" },
        ],
        config: cfg,
      },
      now,
    );
    expect(rows.map((r) => [r.id, r.kind, r.why, r.at?.toISOString() ?? null])).toEqual([
      ["p", "form_reminder", "sending", now.toISOString()],
      ["q", "form", "sending", now.toISOString()],
      ["n", "form", "next_run", now.toISOString()],
      ["n2", "form", "next_run", now.toISOString()],
      ["v", "visit_reminder", "due", now.toISOString()],
      ["d", "form", "perDay", "2026-11-25T17:00:00.000Z"],
      ["r", "form_reminder", "due", "2026-11-27T03:00:00.000Z"],
      ["w", "visit_link", "perWeek", "2026-11-29T17:00:00.000Z"],

      ["f", "form_reminder", "retry", null],
      ["s", "form", "perSubject", null],
    ]);
  });
});

describe("buildForecast", () => {
  it("weights each person by the chance to reach Offer and compares with need", () => {
    // Each step keeps half of the people of the step before.
    const atLeast = { applied: 64, contacted: 32, replied: 16, onsite_invited: 8, visit_booked: 4, visited: 2, offer: 1 };
    const rows = buildForecast(
      [
        { id: "p1", stage: "onsite_booked", visitSubject: "Physics" },
        { id: "p2", stage: "onsite_booked", visitSubject: "Physics" },
        { id: "m1", stage: "new", subjects: ["Mathematics"] },
        { id: "m2", stage: "stopped", subjects: ["Mathematics"] },
      ],
      { atLeast },
      [{ subject: "Mathematics", hire: 2 }, { subject: "Chemistry", hire: 1 }],
    );
    expect(rows.map((r) => r.subject)).toEqual(["Mathematics", "Chemistry", "Physics"]);
    const physics = rows.find((r) => r.subject === "Physics")!;
    expect(physics.expected).toBeCloseTo(0.5);
    expect(rows[0]).toMatchObject({ pipeline: 1, need: 2 });
    expect(rows[0].expected).toBeCloseTo(0.5 ** 6);
    expect(rows[0].ids).toEqual(["m1"]);
    // Chemistry has a need and nobody in the pipeline: no chance.
    expect(rows[1]).toMatchObject({ subject: "Chemistry", chance: 0 });
    // Two people at 0.25 each: P(0) = 0.5625, P(≤1) = 0.9375, so the 10th–90th range is 0 to 1.
    expect([physics.low, physics.high]).toEqual([0, 1]);
  });
});

describe("buildFunnel stage clock", () => {
  it("starts the onsite-invited clock at a re-sent visit link", async () => {
    const { buildFunnel } = await import("../funnel");
    const now = new Date("2026-11-25T03:00:00Z");
    const report = buildFunnel(
      {
        candidates: [{ id: "v", stage: "onsite_invited", createdAt: "2026-10-01T00:00:00Z", seekJobId: null, preScreenRepliedAt: null, callReview: null }],
        bookings: [],
        calls: [],
        inviteOutbox: [
          { key: "v:visit-invite:2", status: "sent", sentAt: "2026-11-24T03:00:00Z" },
          { key: "v:visit-invite", status: "sent", sentAt: "2026-10-20T03:00:00Z" },
        ],
        decisions: [],
        funnelEvents: [],
      },
      now,
    );
    expect(report.byCandidate.v.daysInStage).toBeCloseTo(1);
  });
});
