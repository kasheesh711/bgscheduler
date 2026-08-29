import { describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));

import { reassessPostClassSessions } from "../reassess";
import type { Database } from "@/lib/db";
import type { PostClassFeedbackRepository } from "../repository";
import type { FeedbackEventEvidence, FeedbackVersion } from "../types";

// Class ended 2026-08-03 16:00 Bangkok, so the deadline is 2026-08-05
// 23:59:59.999 Bangkok == 16:59:59.999Z. These are the real instants from the
// production session that surfaced the role gate.
const SCHEDULED_END = new Date("2026-08-03T09:00:00.000Z");
const DEADLINE = new Date("2026-08-05T16:59:59.999Z");
const ON_TIME_EVENT_AT = new Date("2026-08-05T16:42:05.728Z");

interface SessionRow {
  id: string;
  wiseSessionId: string;
  canonicalTutorName: string | null;
  scheduledEndAt: Date;
  timingStatus: "not_due" | "on_time" | "late" | "unknown";
  deductionStatus?: "none" | "pending_review" | "approved" | "waived";
}

/**
 * Minimal stand-in for the one `select().from().where().orderBy().limit()`
 * chain the dry-run path issues. `apply: false` never reaches a write, so this
 * is the whole database surface the test needs.
 */
function fakeDb(rows: SessionRow[]): Database {
  const chain = {
    from: () => chain,
    where: () => chain,
    orderBy: () => chain,
    limit: () => Promise.resolve(rows),
  };
  return { select: () => chain } as unknown as Database;
}

function version(input: {
  observedAt: string;
  fields?: { topics: string; performance: string; improvement: string; homework: string };
}): FeedbackVersion {
  return {
    versionKey: `submission-1:${input.observedAt}`,
    submissionId: "submission-1",
    contentHash: input.observedAt,
    profile: "teacher",
    provenance: "unknown",
    sourceCreatedAt: SCHEDULED_END,
    sourceTimestampTrustworthy: false,
    sourceTimestampKind: "created",
    observedAt: new Date(input.observedAt),
    actorWiseUserId: "teacher-1",
    actorName: "Kevin (Kev) Y. Hsieh",
    answers: [],
    fields: input.fields ?? {
      topics: TOPICS,
      performance: PERFORMANCE,
      improvement: IMPROVEMENT,
      homework: "",
    },
  } as unknown as FeedbackVersion;
}

function feedbackEvent(input: { at: Date; role: string | null }): FeedbackEventEvidence {
  return {
    eventId: `event-${input.at.toISOString()}`,
    sessionId: "6a6b1450b03fafaaa1851041",
    eventTimestamp: input.at,
    autoSubmitted: null,
    actorWiseUserId: "teacher-1",
    actorName: "Kevin (Kev) Y. Hsieh",
    actorRole: input.role,
  };
}

function fakeRepository(overrides: {
  versions?: FeedbackVersion[];
  events?: FeedbackEventEvidence[];
  coverageFrom?: Date | null;
}): PostClassFeedbackRepository {
  return {
    loadPolicyContext: async () => ({
      settingsVersion: 1,
      enforcementMode: "live" as const,
      policyEffectiveAt: new Date("2026-01-01T00:00:00.000Z"),
      policyVersion: 1,
      mappingVersion: 1,
      mappings: [],
    }),
    loadSessionEnforcementContext: async () => ({
      enforcementMode: "live" as const,
      policyEffectiveAt: new Date("2026-01-01T00:00:00.000Z"),
    }),
    loadFeedbackEventCoverageFloor: async () =>
      overrides.coverageFrom === undefined
        ? new Date("2026-01-01T00:00:00.000Z")
        : overrides.coverageFrom,
    loadHistoricalFeedbackVersions: async () => overrides.versions ?? [],
    loadFeedbackEvents: async () => overrides.events ?? [],
  } as unknown as PostClassFeedbackRepository;
}

const LATE_SESSION: SessionRow = {
  id: "2bccbb11-52c4-481d-a8a9-95df5ee4c391",
  wiseSessionId: "6a6b1450b03fafaaa1851041",
  canonicalTutorName: "Kevin",
  scheduledEndAt: SCHEDULED_END,
  timingStatus: "late",
};

// Distinct prose per field: repeating one sentence would trip the periodic-unit
// branch of `isPlaceholderFeedback` and fail the content bar for the wrong
// reason, hiding whatever the timing rule actually decided.
const TOPICS = "We worked through factorising quadratics, starting from the difference of two squares and moving on to trinomials where the leading coefficient is greater than one.";
const PERFORMANCE = "She spotted the common factor quickly and only needed a prompt on sign handling when the constant term was negative. Her working was laid out clearly throughout.";
const IMPROVEMENT = "Next session we should drill completing the square, because she still reaches for the formula before checking whether a neater route exists.";

describe("reassessPostClassSessions", () => {
  it("clears a late verdict when a pre-deadline ADMIN-role event exists", async () => {
    const result = await reassessPostClassSessions({
      apply: false,
      now: new Date("2026-08-07T00:00:00.000Z"),
      db: fakeDb([LATE_SESSION]),
      repository: fakeRepository({
        versions: [version({ observedAt: "2026-08-05T17:13:26.912Z" })],
        events: [feedbackEvent({ at: ON_TIME_EVENT_AT, role: "ADMIN" })],
      }),
    });

    expect(result.scanned).toBe(1);
    expect(result.changed).toBe(1);
    expect(result.failed).toBe(0);
    expect(result.outcomes[0]).toMatchObject({
      wiseSessionId: "6a6b1450b03fafaaa1851041",
      from: "late",
      to: "on_time",
      changed: true,
    });
    expect(result.outcomes[0].provenAt?.toISOString()).toBe(ON_TIME_EVENT_AT.toISOString());
    expect(result.outcomes[0].deadlineAt.toISOString()).toBe(DEADLINE.toISOString());
  });

  it("leaves a genuinely late session late when every event is post-deadline", async () => {
    const result = await reassessPostClassSessions({
      apply: false,
      now: new Date("2026-08-07T00:00:00.000Z"),
      db: fakeDb([LATE_SESSION]),
      repository: fakeRepository({
        versions: [version({ observedAt: "2026-08-06T09:00:00.000Z" })],
        events: [feedbackEvent({ at: new Date("2026-08-06T08:00:00.000Z"), role: "TEACHER" })],
      }),
    });

    expect(result.changed).toBe(0);
    expect(result.outcomes[0]).toMatchObject({ from: "late", to: "late", changed: false });
  });

  it("never waives from a dry run", async () => {
    const result = await reassessPostClassSessions({
      apply: false,
      now: new Date("2026-08-07T00:00:00.000Z"),
      db: fakeDb([LATE_SESSION]),
      repository: fakeRepository({
        versions: [version({ observedAt: "2026-08-05T17:13:26.912Z" })],
        events: [feedbackEvent({ at: ON_TIME_EVENT_AT, role: "ADMIN" })],
      }),
    });

    expect(result.deductionsWaived).toBe(0);
    expect(result.outcomes[0].deductionWaived).toBe(false);
  });

  it("keeps timing unknown when the deadline predates event coverage", async () => {
    // D-EVT-01 must survive the widened qualifying rule: absence of an event
    // below the coverage floor still proves nothing.
    const result = await reassessPostClassSessions({
      apply: false,
      now: new Date("2026-08-07T00:00:00.000Z"),
      db: fakeDb([LATE_SESSION]),
      repository: fakeRepository({
        versions: [version({ observedAt: "2026-08-06T09:00:00.000Z" })],
        events: [],
        coverageFrom: new Date("2026-08-06T00:00:00.000Z"),
      }),
    });

    expect(result.outcomes[0].to).toBe("unknown");
  });

  it("detects a content clearance on an unchanged timing verdict (char-count bar)", async () => {
    // Event-proven on_time with an empty improvement field and 300+ combined
    // characters: the old field-required rule deducted it; the char-count bar
    // clears it with no timing flip. The open deduction makes that a change.
    const result = await reassessPostClassSessions({
      apply: false,
      now: new Date("2026-08-07T00:00:00.000Z"),
      db: fakeDb([{
        ...LATE_SESSION,
        timingStatus: "on_time",
        deductionStatus: "pending_review",
      }]),
      repository: fakeRepository({
        versions: [version({
          observedAt: "2026-08-05T17:13:26.912Z",
          fields: { topics: TOPICS, performance: PERFORMANCE, improvement: "", homework: "" },
        })],
        events: [feedbackEvent({ at: ON_TIME_EVENT_AT, role: "TEACHER" })],
      }),
    });

    expect(result.changed).toBe(1);
    expect(result.outcomes[0]).toMatchObject({
      from: "on_time",
      to: "on_time",
      changed: true,
      cleared: "content",
      deductionWaived: false,
    });
  });

  it("does not report a change when timing holds and no deduction is open", async () => {
    const result = await reassessPostClassSessions({
      apply: false,
      now: new Date("2026-08-07T00:00:00.000Z"),
      db: fakeDb([{
        ...LATE_SESSION,
        timingStatus: "on_time",
        deductionStatus: "waived",
      }]),
      repository: fakeRepository({
        versions: [version({ observedAt: "2026-08-05T17:13:26.912Z" })],
        events: [feedbackEvent({ at: ON_TIME_EVENT_AT, role: "TEACHER" })],
      }),
    });

    expect(result.changed).toBe(0);
    expect(result.outcomes[0]).toMatchObject({ changed: false, cleared: null });
  });

  it("reports a per-session failure without aborting the pass", async () => {
    const repository = fakeRepository({});
    repository.loadFeedbackEvents = async () => {
      throw new Error("activity mirror unavailable");
    };

    const result = await reassessPostClassSessions({
      apply: false,
      now: new Date("2026-08-07T00:00:00.000Z"),
      db: fakeDb([LATE_SESSION]),
      repository,
    });

    expect(result.scanned).toBe(1);
    expect(result.failed).toBe(1);
    expect(result.changed).toBe(0);
  });
});
