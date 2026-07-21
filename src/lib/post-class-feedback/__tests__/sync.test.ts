import { describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));
import type { WiseClient } from "@/lib/wise/client";
import type { FeedbackVersion, PostClassSessionObservation } from "../types";
import type { PostClassFeedbackRepository } from "../repository";
import {
  assertPostClassObservationSnapshot,
  isKnownPostClassIneligibleReason,
  planPostClassReminderCheckpointCandidates,
  postClassAssessmentKey,
  postClassBangkokDateBounds,
  postClassRetryCandidateFromIssueDetails,
  postClassSourceIssueWiseSessionId,
  postClassSourceStatusForIssue,
  prioritizeUnseenRollingCandidates,
  projectPostClassDeductionStatus,
  resolvedPostClassSessionIssueUpdate,
  shouldFetchPostClassCandidate,
} from "../repository";
import {
  buildPostClassSyncCandidates,
  fourDayBangkokWindow,
  mergeFeedbackVersionHistory,
  reminderCheckpointBangkokDate,
  resolvePostClassSyncWindow,
  selectCurrentFeedbackProjection,
  syncPostClassFeedback,
} from "../sync";

describe("post-class feedback sync planning", () => {
  it("enumerates four inclusive Bangkok calendar dates", () => {
    expect(fourDayBangkokWindow(new Date("2026-08-01T00:30:00.000Z"))).toEqual({
      startDate: "2026-07-29",
      endDate: "2026-08-01",
    });
    // Still 31 July in Bangkok at 16:30Z.
    expect(fourDayBangkokWindow(new Date("2026-07-31T16:30:00.000Z"))).toEqual({
      startDate: "2026-07-28",
      endDate: "2026-07-31",
    });
  });

  it("accepts an explicit inclusive manual-backfill window and rejects partial or invalid ranges", () => {
    const now = new Date("2026-08-01T00:30:00.000Z");
    expect(resolvePostClassSyncWindow(now, {
      startDate: "2026-06-01",
      endDate: "2026-06-30",
    })).toEqual({ startDate: "2026-06-01", endDate: "2026-06-30" });
    expect(() => resolvePostClassSyncWindow(now, { startDate: "2026-06-01" }))
      .toThrow(/requires both/u);
    expect(() => resolvePostClassSyncWindow(now, {
      startDate: "2026-06-31",
      endDate: "2026-07-01",
    })).toThrow(/valid YYYY-MM-DD/u);
    expect(() => resolvePostClassSyncWindow(now, {
      startDate: "2026-07-02",
      endDate: "2026-07-01",
    })).toThrow(/must not be after/u);
  });

  it("prioritizes feedback events, retains old incomplete rechecks, and deduplicates sessions", () => {
    const candidates = buildPostClassSyncCandidates({
      cap: 3,
      eventCandidates: [{ sessionId: "event", classId: "c1", reason: "feedback_event" }],
      incompleteCandidates: [
        { sessionId: "old", classId: "c2", reason: "incomplete_recheck", scheduledEndAt: new Date("2026-01-01") },
        { sessionId: "event", classId: "c1", reason: "incomplete_recheck" },
      ],
      rollingCandidates: [
        { sessionId: "new", classId: "c3", reason: "rolling_window" },
        { sessionId: "extra", classId: "c4", reason: "rolling_window" },
      ],
    });
    expect(candidates.map((candidate) => [candidate.sessionId, candidate.reason])).toEqual([
      ["event", "feedback_event"],
      ["old", "incomplete_recheck"],
      ["new", "rolling_window"],
    ]);
  });

  it("hard-caps a run at 50 detail candidates", () => {
    const candidates = buildPostClassSyncCandidates({
      cap: 500,
      eventCandidates: Array.from({ length: 80 }, (_, index) => ({
        sessionId: `s-${index}`,
        classId: "class",
        reason: "feedback_event" as const,
      })),
      incompleteCandidates: [],
      rollingCandidates: [],
    });
    expect(candidates).toHaveLength(50);
  });

  it("targets the exact Bangkok class date for each reminder checkpoint", () => {
    // 16:30Z is still 23:30 on 31 July in Bangkok.
    const now = new Date("2026-07-31T16:30:00.000Z");
    expect(reminderCheckpointBangkokDate(now, "day_after")).toBe("2026-07-30");
    expect(reminderCheckpointBangkokDate(now, "deadline")).toBe("2026-07-29");
    // Thirty minutes later is already 1 August locally.
    expect(reminderCheckpointBangkokDate(
      new Date("2026-07-31T17:30:00.000Z"),
      "day_after",
    )).toBe("2026-07-31");
  });

  it("builds exact UTC bounds for a persisted Bangkok checkpoint date", () => {
    expect(postClassBangkokDateBounds("2026-08-01")).toEqual({
      start: new Date("2026-07-31T17:00:00.000Z"),
      end: new Date("2026-08-01T17:00:00.000Z"),
    });
  });

  it("rotates more than 50 checkpoint sessions while retaining failed attempts", () => {
    const freshAfter = new Date("2026-07-21T01:40:00.000Z");
    const candidates = Array.from({ length: 80 }, (_, index) => ({
      sessionId: `checkpoint-${String(index).padStart(2, "0")}`,
      classId: "class",
      reason: "rolling_window" as const,
      scheduledEndAt: new Date(`2026-07-20T${String(Math.floor(index / 60)).padStart(2, "0")}:${String(index % 60).padStart(2, "0")}:00.000Z`),
    }));
    const firstPlan = planPostClassReminderCheckpointCandidates({
      candidates,
      freshAfter,
      lastObservedBySession: new Map(),
    });
    const firstBatch = firstPlan.slice(0, 50);
    const firstSuccessful = firstBatch.slice(0, 45);
    const firstFailed = firstBatch.slice(45);
    const secondPlan = planPostClassReminderCheckpointCandidates({
      candidates,
      freshAfter,
      lastObservedBySession: new Map(firstSuccessful.map((candidate) => [
        candidate.sessionId,
        new Date("2026-07-21T01:55:00.000Z"),
      ])),
      lastAttemptBySession: new Map(firstFailed.map((candidate) => [
        candidate.sessionId,
        new Date("2026-07-21T02:00:00.000Z"),
      ])),
    });
    const secondBatch = secondPlan.slice(0, 50);
    expect(secondPlan).toHaveLength(35);
    expect(secondBatch.slice(0, 30).every((candidate) =>
      !firstBatch.some((first) => first.sessionId === candidate.sessionId)))
      .toBe(true);
    expect(new Set([...firstBatch, ...secondBatch].map((candidate) => candidate.sessionId)).size)
      .toBe(80);
  });

  it("refreshes event-dirty checkpoint sessions even inside the freshness window", () => {
    const candidate = {
      sessionId: "dirty",
      classId: "class",
      reason: "rolling_window" as const,
    };
    expect(planPostClassReminderCheckpointCandidates({
      candidates: [candidate],
      freshAfter: new Date("2026-07-21T01:40:00.000Z"),
      lastObservedBySession: new Map([["dirty", new Date("2026-07-21T01:59:00.000Z")]]),
      eventDirtySessionIds: new Set(["dirty"]),
    })).toEqual([{ ...candidate, reason: "feedback_event" }]);
    expect(planPostClassReminderCheckpointCandidates({
      candidates: [{ ...candidate, sessionId: "past-omitted", forceDetailRefresh: true }],
      freshAfter: new Date("2026-07-21T01:40:00.000Z"),
      checkpointStartedAt: new Date("2026-07-21T02:00:00.000Z"),
      lastObservedBySession: new Map([[
        "past-omitted",
        new Date("2026-07-21T01:59:00.000Z"),
      ]]),
    })).toEqual([expect.objectContaining({
      sessionId: "past-omitted",
      reason: "feedback_event",
      forceDetailRefresh: true,
    })]);
  });

  it("lets more than 50 PAST-omitted obligations drain after this checkpoint observes them", () => {
    const checkpointStartedAt = new Date("2026-07-21T02:00:00.000Z");
    const candidates = Array.from({ length: 80 }, (_, index) => ({
      sessionId: `omitted-${index}`,
      classId: "class",
      reason: "rolling_window" as const,
      forceDetailRefresh: true,
    }));
    const firstPlan = planPostClassReminderCheckpointCandidates({
      candidates,
      freshAfter: new Date("2026-07-21T01:40:00.000Z"),
      checkpointStartedAt,
      lastObservedBySession: new Map(candidates.map((candidate) => [
        candidate.sessionId,
        new Date("2026-07-21T01:42:00.000Z"),
      ])),
    });
    const firstBatch = firstPlan.slice(0, 50);
    const secondPlan = planPostClassReminderCheckpointCandidates({
      candidates,
      freshAfter: new Date("2026-07-21T01:40:00.000Z"),
      checkpointStartedAt,
      lastObservedBySession: new Map(candidates.map((candidate) => [
        candidate.sessionId,
        firstBatch.some((selected) => selected.sessionId === candidate.sessionId)
          ? checkpointStartedAt
          : new Date("2026-07-21T01:42:00.000Z"),
      ])),
    });
    expect(firstPlan).toHaveLength(80);
    expect(secondPlan).toHaveLength(30);
  });

  it("changes the immutable assessment key when Wise corrects schedule context", () => {
    const base = {
      syncRunId: "sync-1",
      assessedAt: new Date("2026-07-05T00:00:00.000Z"),
      wiseSessionId: "session",
      policyVersion: 1,
      mappingVersion: 1,
      enforcementMode: "live" as const,
      sourceStatus: "ready",
      contentStatus: "missing",
      timingStatus: "late",
      governingVersionKey: null,
      violation: true,
      adjustedCompliant: false,
    };
    const firstEnd = new Date("2026-07-01T10:00:00.000Z");
    const correctedEnd = new Date("2026-07-02T10:00:00.000Z");
    expect(postClassAssessmentKey({
      ...base,
      scheduledEndAt: firstEnd,
      deadlineAt: new Date("2026-07-03T16:59:59.999Z"),
    })).not.toBe(postClassAssessmentKey({
      ...base,
      scheduledEndAt: correctedEnd,
      deadlineAt: new Date("2026-07-04T16:59:59.999Z"),
    }));
  });

  it("rejects an observation evaluated against a superseded settings snapshot", () => {
    expect(() => assertPostClassObservationSnapshot({
      settingsVersion: 4,
      policyVersion: 2,
      mappingVersion: 7,
    }, {
      settingsVersion: 4,
      policyVersion: 2,
      mappingVersion: 7,
    })).not.toThrow();
    expect(() => assertPostClassObservationSnapshot({
      settingsVersion: 4,
      policyVersion: 2,
      mappingVersion: 7,
    }, {
      settingsVersion: 5,
      policyVersion: 2,
      mappingVersion: 8,
    })).toThrow(/configuration changed during collection/iu);
  });

  it("appends the restored final state in an A-to-B-to-A assessment sequence", () => {
    const stateA = {
      wiseSessionId: "session",
      policyVersion: 1,
      mappingVersion: 1,
      scheduledEndAt: new Date("2026-07-01T10:00:00.000Z"),
      deadlineAt: new Date("2026-07-03T16:59:59.999Z"),
      enforcementMode: "live" as const,
      sourceStatus: "ready",
      contentStatus: "missing",
      timingStatus: "not_due",
      governingVersionKey: null,
      violation: false,
      adjustedCompliant: false,
    };
    const firstA = postClassAssessmentKey({
      ...stateA,
      syncRunId: "sync-a1",
      assessedAt: new Date("2026-07-02T00:00:00.000Z"),
    });
    const middleB = postClassAssessmentKey({
      ...stateA,
      syncRunId: "sync-b",
      assessedAt: new Date("2026-07-02T01:00:00.000Z"),
      sourceStatus: "unavailable",
    });
    const finalA = postClassAssessmentKey({
      ...stateA,
      syncRunId: "sync-a2",
      assessedAt: new Date("2026-07-02T02:00:00.000Z"),
    });
    expect(new Set([firstA, middleB, finalA]).size).toBe(3);
    expect(finalA).not.toBe(firstA);
  });

  it("preserves immutable historical versions while preferring the newest observation of the same version", () => {
    const version = (contentHash: string, observedAt: string): FeedbackVersion => ({
      submissionId: "submission-1",
      profile: "teacher",
      answers: [],
      fields: { topics: "", performance: "", improvement: "", homework: "" },
      contentHash,
      sourceCreatedAt: new Date("2026-07-20T10:00:00.000Z"),
      sourceTimestampTrustworthy: true,
      observedAt: new Date(observedAt),
      actorWiseUserId: null,
      provenance: "unknown",
    });
    const historical = version("old-content", "2026-07-20T10:05:00.000Z");
    const staleDuplicate = version("current-content", "2026-07-20T10:06:00.000Z");
    const currentDuplicate = version("current-content", "2026-07-20T10:07:00.000Z");

    expect(mergeFeedbackVersionHistory(
      [historical, staleDuplicate],
      [currentDuplicate],
    )).toEqual([historical, currentDuplicate]);
  });

  it("does not trust an original creation timestamp for a later mutable-submission edit", () => {
    const base: FeedbackVersion = {
      submissionId: "mutable-1",
      profile: "teacher",
      answers: [],
      fields: { topics: "", performance: "", improvement: "", homework: "" },
      contentHash: "before",
      sourceCreatedAt: new Date("2026-07-20T10:00:00.000Z"),
      sourceTimestampTrustworthy: true,
      sourceTimestampKind: "created",
      observedAt: new Date("2026-07-20T10:05:00.000Z"),
      actorWiseUserId: null,
      provenance: "unknown",
    };
    const edited = {
      ...base,
      contentHash: "after",
      observedAt: new Date("2026-07-24T10:05:00.000Z"),
    };
    const merged = mergeFeedbackVersionHistory([base], [edited]);
    expect(merged).toHaveLength(2);
    expect(merged[1]).toMatchObject({
      contentHash: "after",
      sourceTimestampTrustworthy: false,
      sourceTimestampKind: "created",
    });
  });

  it("reserves bounded capacity for old incomplete rechecks during an event burst", () => {
    const candidates = buildPostClassSyncCandidates({
      cap: 50,
      eventCandidates: Array.from({ length: 80 }, (_, index) => ({
        sessionId: `event-${index}`,
        classId: "class",
        reason: "feedback_event" as const,
      })),
      incompleteCandidates: Array.from({ length: 3 }, (_, index) => ({
        sessionId: `old-${index}`,
        classId: "class",
        reason: "incomplete_recheck" as const,
      })),
      rollingCandidates: [],
    });
    expect(candidates).toHaveLength(50);
    expect(candidates.filter((candidate) => candidate.reason === "incomplete_recheck"))
      .toHaveLength(3);
  });

  it("reserves canonical rolling reconciliation during a persistent activity-event burst", () => {
    const candidates = buildPostClassSyncCandidates({
      cap: 50,
      eventCandidates: Array.from({ length: 80 }, (_, index) => ({
        sessionId: `event-${index}`,
        classId: "class",
        reason: "feedback_event" as const,
      })),
      incompleteCandidates: [],
      rollingCandidates: Array.from({ length: 12 }, (_, index) => ({
        sessionId: `rolling-${index}`,
        classId: "class",
        reason: "rolling_window" as const,
        scheduledEndAt: new Date(2026, 6, 21, 0, index),
      })),
    });
    expect(candidates).toHaveLength(50);
    expect(candidates.filter((candidate) => candidate.reason === "feedback_event"))
      .toHaveLength(40);
    expect(candidates.filter((candidate) => candidate.reason === "rolling_window"))
      .toHaveLength(10);
  });

  it("prefers unseen sessions inside the rolling reconciliation lane", () => {
    const prioritized = prioritizeUnseenRollingCandidates([
      { sessionId: "event", classId: "class", reason: "feedback_event" },
      { sessionId: "seen-newer", classId: "class", reason: "rolling_window" },
      { sessionId: "unseen", classId: "class", reason: "rolling_window" },
      { sessionId: "seen-older", classId: "class", reason: "rolling_window" },
    ], new Set(["seen-newer", "seen-older"]));
    expect(prioritized.map((candidate) => candidate.sessionId)).toEqual([
      "event",
      "unseen",
      "seen-newer",
      "seen-older",
    ]);
  });

  it("rotates beyond 50 rolling candidates instead of starving older unseen sessions", () => {
    const rolling = Array.from({ length: 80 }, (_, index) => ({
      sessionId: `rolling-${index}`,
      classId: "class",
      reason: "rolling_window" as const,
      scheduledEndAt: new Date(2026, 6, 20, 0, index),
    }));
    const firstRun = buildPostClassSyncCandidates({
      cap: 50,
      eventCandidates: [],
      incompleteCandidates: [],
      rollingCandidates: rolling,
    });
    const secondRun = buildPostClassSyncCandidates({
      cap: 50,
      eventCandidates: [],
      incompleteCandidates: firstRun.map((candidate, index) => ({
        ...candidate,
        reason: "incomplete_recheck" as const,
        recheckPriorityAt: new Date(2026, 6, 21, 0, index),
      })),
      rollingCandidates: rolling,
    });
    expect(new Set([...firstRun, ...secondRun].map((candidate) => candidate.sessionId)).size)
      .toBe(80);
  });

  it("rechecks current canonical details while avoiding hot-looping fresh completed rows", () => {
    const existing = {
      eligibilityReason: "ended_positive_credits",
      sourceStatus: "ready",
      contentStatus: "substantive",
      timingStatus: "on_time",
      updatedAt: new Date("2026-07-20T00:00:00.000Z"),
    };
    expect(shouldFetchPostClassCandidate({
      candidateReason: "rolling_window",
      now: new Date("2026-07-20T01:00:00.000Z"),
      existing,
    })).toBe(false);
    expect(shouldFetchPostClassCandidate({
      candidateReason: "rolling_window",
      now: new Date("2026-07-20T07:00:00.000Z"),
      existing,
    })).toBe(true);
    expect(shouldFetchPostClassCandidate({
      candidateReason: "feedback_event",
      now: new Date("2026-07-20T01:00:00.000Z"),
      existing: { ...existing, eligibilityReason: "missed_or_no_show" },
    })).toBe(true);
  });

  it("keeps immutable history without letting deleted Wise submissions govern current content", () => {
    const historical: FeedbackVersion = {
      submissionId: "deleted",
      profile: "teacher",
      answers: [],
      fields: { topics: "T".repeat(100), performance: "P".repeat(100), improvement: "I".repeat(100), homework: "" },
      contentHash: "deleted-content",
      sourceCreatedAt: null,
      sourceTimestampTrustworthy: false,
      observedAt: new Date("2026-07-20T00:00:00.000Z"),
      actorWiseUserId: null,
      provenance: "unknown",
    };
    const history = mergeFeedbackVersionHistory([historical], []);
    expect(history).toEqual([historical]);
    expect(selectCurrentFeedbackProjection([], history)).toEqual([]);
  });

  it("restores durable detail retries and identifies terminal ineligible projections", () => {
    expect(postClassRetryCandidateFromIssueDetails({
      retryCandidate: {
        sessionId: "aged-out-session",
        classId: "class-1",
        scheduledStartAt: "2026-06-01T09:00:00.000Z",
        scheduledEndAt: "2026-06-01T10:00:00.000Z",
      },
    })).toMatchObject({
      sessionId: "aged-out-session",
      classId: "class-1",
      reason: "incomplete_recheck",
      scheduledEndAt: new Date("2026-06-01T10:00:00.000Z"),
    });
    expect(postClassRetryCandidateFromIssueDetails({ retryCandidate: { sessionId: "bad" } }))
      .toBeNull();
    expect(isKnownPostClassIneligibleReason("complimentary_or_trial")).toBe(true);
    expect(isKnownPostClassIneligibleReason("billing_evidence_missing")).toBe(false);
  });

  it("attaches an orphaned retry issue to the canonical session when resolving it", () => {
    const resolvedAt = new Date("2026-07-21T02:00:00.000Z");
    expect(resolvedPostClassSessionIssueUpdate("session-row-id", resolvedAt)).toEqual({
      sessionId: "session-row-id",
      status: "resolved",
      resolvedAt,
      resolvedByEmail: "system:post-class-feedback",
      lastSeenAt: resolvedAt,
    });
  });

  it("never treats an internal source-issue UUID as a Wise session ID", () => {
    const internalUuid = "99de5888-6e32-471f-9bb1-50aad6a7ee57";
    expect(postClassSourceIssueWiseSessionId({
      sourceIssueSessionId: internalUuid,
      linkedWiseSessionId: "wise-linked-session",
      details: {},
    })).toBe("wise-linked-session");
    expect(postClassSourceIssueWiseSessionId({
      sourceIssueSessionId: internalUuid,
      linkedWiseSessionId: null,
      details: {
        retryCandidate: {
          sessionId: "wise-unprojected-session",
          classId: "wise-class",
        },
      },
    })).toBe("wise-unprojected-session");
    expect(postClassSourceIssueWiseSessionId({
      sourceIssueSessionId: internalUuid,
      linkedWiseSessionId: null,
      details: {},
    })).toBeNull();
  });

  it("preserves identity-review as an orthogonal source projection", () => {
    expect(postClassSourceStatusForIssue({
      scope: "session",
      issueType: "identity_ambiguous",
    })).toBe("identity_review");
    expect(postClassSourceStatusForIssue({
      scope: "session",
      issueType: "billing_evidence_missing",
    })).toBe("unavailable");
    expect(postClassSourceStatusForIssue({
      scope: "global",
      issueType: "wise_transient",
    })).toBe("unavailable");
  });

  it("keeps the reversed projection when immutable processed deductions have an offset", () => {
    expect(projectPostClassDeductionStatus("processed", true)).toBe("reversed");
    expect(projectPostClassDeductionStatus("processed", false)).toBe("processed");
    expect(projectPostClassDeductionStatus(null, false)).toBe("none");
  });

  it("collects only ended sessions with at most four concurrent detail calls", async () => {
    let activeDetails = 0;
    let maxActiveDetails = 0;
    const sessions = [
      ...Array.from({ length: 6 }, (_, index) => ({
        _id: `ended-${index}`,
        classId: { _id: "class-1", name: "Math" },
        userId: "teacher-1",
        scheduledStartTime: `2026-07-20T0${index}:00:00.000Z`,
        scheduledEndTime: `2026-07-20T0${index}:45:00.000Z`,
        meetingStatus: "ENDED",
      })),
      {
        _id: "missed",
        classId: { _id: "class-1", name: "Math" },
        userId: "teacher-1",
        scheduledStartTime: "2026-07-20T10:00:00.000Z",
        scheduledEndTime: "2026-07-20T11:00:00.000Z",
        meetingStatus: "MISSED",
      },
    ];
    const fakeClient = {
      async get(_path: string, params?: Record<string, string>) {
        if (params?.status === "PAST") {
          return { data: { sessions, page_count: 1 } };
        }
        activeDetails += 1;
        maxActiveDetails = Math.max(maxActiveDetails, activeDetails);
        await new Promise((resolve) => setTimeout(resolve, 2));
        activeDetails -= 1;
        const sessionId = _path.split("/").at(-1) ?? "unknown";
        const listSession = sessions.find((session) => session._id === sessionId)!;
        return {
          data: {
            ...listSession,
            feedbackForm: {
              questions: [
                { _id: "q1", questionText: "Topics covered" },
                { _id: "q2", questionText: "How the student did in class" },
                { _id: "q3", questionText: "Need more work on" },
                { _id: "q4", questionText: "Homework and due date" },
              ],
            },
            feedbackSubmissions: [{
              _id: `auto-${sessionId}`,
              profile: "teacher",
              creditsConsumed: 1,
              createdAt: "2026-07-20T12:00:00.000Z",
              answers: [],
            }],
          },
        };
      },
    } as unknown as WiseClient;
    const observations: PostClassSessionObservation[] = [];
    let completed: Parameters<PostClassFeedbackRepository["completeSync"]>[0] | null = null;
    const repository: PostClassFeedbackRepository = {
      beginSync: async () => "run-1",
      completeSync: async (input) => { completed = input; },
      failSync: async () => undefined,
      loadPolicyContext: async () => ({
        settingsVersion: 1,
        enforcementMode: "shadow",
        policyEffectiveAt: null,
        policyVersion: 1,
        mappingVersion: 1,
        mappings: [
          { field: "topics", questionText: "Topics covered" },
          { field: "performance", questionText: "How the student did in class" },
          { field: "improvement", questionText: "Need more work on" },
          { field: "homework", questionText: "Homework and due date" },
        ],
      }),
      loadSessionEnforcementContext: async () => ({
        enforcementMode: "shadow",
        policyEffectiveAt: new Date("2026-07-19T00:00:00.000Z"),
      }),
      listFeedbackEventCandidates: async () => [],
      listIncompleteRecheckCandidates: async () => [],
      listReminderCheckpointPersistedCandidates: async () => [],
      loadFeedbackEvents: async () => [],
      loadHistoricalFeedbackVersions: async () => [],
      loadPreviousComplianceLock: async () => null,
      saveObservation: async (_runId, observation) => {
        observations.push(observation);
        return { versionsInserted: 1, assessmentInserted: true };
      },
      recordSourceIssue: async () => undefined,
      pauseForFormDrift: async () => undefined,
    };

    const result = await syncPostClassFeedback({
      repository,
      client: fakeClient,
      instituteId: "institute-1",
      resolveTutor: async ({ candidate }) => candidate.sessionId === "ended-5"
        ? {
          status: "ambiguous",
          canonicalKey: null,
          displayName: null,
          wiseTeacherUserId: "teacher-1",
        }
        : {
          status: "resolved",
          canonicalKey: "Kevin",
          displayName: "Kevin",
          wiseTeacherUserId: "teacher-1",
        },
    }, { now: new Date("2026-07-24T00:00:00.000Z") });

    expect(result.discoveredCount).toBe(6);
    expect(result.status).toBe("partial");
    expect(result.detailFetchedCount).toBe(6);
    expect(observations).toHaveLength(6);
    expect(observations.every((observation) => observation.session.meetingStatus === "ENDED"))
      .toBe(true);
    expect(observations.every((observation) => observation.assessment?.deductionCandidate === false))
      .toBe(true);
    expect(maxActiveDetails).toBe(4);
    expect(completed).toMatchObject({
      versionInsertedCount: 6,
      assessedCount: 6,
      sessionSavedCount: 6,
      metadata: { globalSourceHealthy: true },
    });
  });

  it("reconciles newly ended rolling sessions when more than 50 unlinked events keep failing", async () => {
    const rollingSessions = Array.from({ length: 15 }, (_, index) => ({
      _id: `rolling-live-${index}`,
      classId: { _id: "rolling-class", name: "Math" },
      userId: "teacher-1",
      scheduledStartTime: `2026-07-20T${String(index).padStart(2, "0")}:00:00.000Z`,
      scheduledEndTime: `2026-07-20T${String(index).padStart(2, "0")}:45:00.000Z`,
      meetingStatus: "ENDED",
    }));
    const detailSessionIds: string[] = [];
    const fakeClient = {
      async get(path: string, params?: Record<string, string>) {
        if (params?.status === "PAST") {
          return { data: { sessions: rollingSessions, page_count: 1 } };
        }
        const sessionId = path.split("/").at(-1) ?? "unknown";
        detailSessionIds.push(sessionId);
        if (sessionId.startsWith("event-failure-")) {
          throw new Error("Wise API 404: session not found");
        }
        const session = rollingSessions.find((row) => row._id === sessionId)!;
        return { data: {
          ...session,
          feedbackForm: { questions: [
            { questionText: "Topics covered" },
            { questionText: "How the student did in class" },
            { questionText: "Need more work on" },
            { questionText: "Homework and due date" },
          ] },
          feedbackSubmissions: [{
            _id: `submission-${sessionId}`,
            profile: "teacher",
            creditsConsumed: 1,
            createdAt: "2026-07-20T12:00:00.000Z",
            answers: [],
          }],
        } };
      },
    } as unknown as WiseClient;
    const observations: PostClassSessionObservation[] = [];
    const repository: PostClassFeedbackRepository = {
      beginSync: async () => "run-event-flood",
      completeSync: async () => undefined,
      failSync: async () => undefined,
      loadPolicyContext: async () => ({
        settingsVersion: 1,
        enforcementMode: "shadow",
        policyEffectiveAt: null,
        policyVersion: 1,
        mappingVersion: 1,
        mappings: [
          { field: "topics", questionText: "Topics covered" },
          { field: "performance", questionText: "How the student did in class" },
          { field: "improvement", questionText: "Need more work on" },
          { field: "homework", questionText: "Homework and due date" },
        ],
      }),
      loadSessionEnforcementContext: async () => ({
        enforcementMode: "shadow",
        policyEffectiveAt: null,
      }),
      listFeedbackEventCandidates: async () => Array.from({ length: 60 }, (_, index) => ({
        sessionId: `event-failure-${index}`,
        classId: "event-class",
        reason: "feedback_event" as const,
      })),
      listIncompleteRecheckCandidates: async () => [],
      listReminderCheckpointPersistedCandidates: async () => [],
      loadFeedbackEvents: async () => [],
      loadHistoricalFeedbackVersions: async () => [],
      loadPreviousComplianceLock: async () => null,
      saveObservation: async (_runId, observation) => {
        observations.push(observation);
        return { versionsInserted: 1, assessmentInserted: true };
      },
      recordSourceIssue: async () => undefined,
      pauseForFormDrift: async () => undefined,
    };

    const result = await syncPostClassFeedback({
      repository,
      client: fakeClient,
      instituteId: "institute-1",
      resolveTutor: async () => ({
        status: "resolved",
        canonicalKey: "teacher",
        displayName: "Teacher",
        wiseTeacherUserId: "teacher-1",
      }),
    }, { now: new Date("2026-07-21T00:00:00.000Z") });

    expect(result).toMatchObject({
      status: "partial",
      candidateCount: 50,
      detailFetchedCount: 10,
      sessionSavedCount: 10,
    });
    expect(detailSessionIds.filter((id) => id.startsWith("event-failure-"))).toHaveLength(40);
    expect(detailSessionIds.filter((id) => id.startsWith("rolling-live-"))).toHaveLength(10);
    expect(observations).toHaveLength(10);
    expect(observations.every((observation) =>
      observation.candidate.reason === "rolling_window")).toBe(true);
  });

  it("pauses the entire parsed batch before saving when any required mapping drifts", async () => {
    const sessions = ["ready", "drift"].map((id) => ({
      _id: id,
      classId: "class-1",
      userId: "teacher-1",
      scheduledStartTime: "2026-07-20T09:00:00.000Z",
      scheduledEndTime: "2026-07-20T10:00:00.000Z",
      meetingStatus: "ENDED",
    }));
    const fakeClient = {
      async get(path: string, params?: Record<string, string>) {
        if (params?.status === "PAST") return { data: { sessions, page_count: 1 } };
        const id = path.split("/").at(-1)!;
        const formQuestions = [
          { questionText: "Topics covered" },
          { questionText: "How the student did in class" },
          ...(id === "drift" ? [] : [{ questionText: "Need more work on" }]),
          { questionText: "Homework and due date" },
        ];
        return {
          data: {
            ...sessions.find((session) => session._id === id),
            feedbackForm: { questions: formQuestions },
            feedbackSubmissions: [{
              _id: `submission-${id}`,
              profile: "teacher",
              creditsConsumed: 1,
              createdAt: "2026-07-23T00:00:00.000Z",
              answers: [],
            }],
          },
        };
      },
    } as unknown as WiseClient;
    let paused = false;
    const observations: PostClassSessionObservation[] = [];
    const repository: PostClassFeedbackRepository = {
      beginSync: async () => "run-drift",
      completeSync: async () => undefined,
      failSync: async () => undefined,
      loadPolicyContext: async () => ({
        settingsVersion: 1,
        enforcementMode: "live",
        policyEffectiveAt: new Date("2026-07-19T00:00:00.000Z"),
        policyVersion: 1,
        mappingVersion: 1,
        mappings: [
          { field: "topics", questionText: "Topics covered" },
          { field: "performance", questionText: "How the student did in class" },
          { field: "improvement", questionText: "Need more work on" },
          { field: "homework", questionText: "Homework and due date" },
        ],
      }),
      loadSessionEnforcementContext: async () => ({
        enforcementMode: "live",
        policyEffectiveAt: new Date("2026-07-19T00:00:00.000Z"),
      }),
      listFeedbackEventCandidates: async () => [],
      listIncompleteRecheckCandidates: async () => [],
      listReminderCheckpointPersistedCandidates: async () => [],
      loadFeedbackEvents: async () => [],
      loadHistoricalFeedbackVersions: async () => [],
      loadPreviousComplianceLock: async () => null,
      saveObservation: async (_runId, observation) => {
        if (!paused) throw new Error("observation saved before form-drift pause");
        observations.push(observation);
        return { versionsInserted: 1, assessmentInserted: true };
      },
      recordSourceIssue: async () => undefined,
      pauseForFormDrift: async () => { paused = true; },
    };

    const result = await syncPostClassFeedback({
      repository,
      client: fakeClient,
      instituteId: "institute-1",
      resolveTutor: async () => ({
        status: "resolved",
        canonicalKey: "Kevin",
        displayName: "Kevin",
        wiseTeacherUserId: "teacher-1",
      }),
    }, { now: new Date("2026-07-24T00:00:00.000Z") });

    expect(result.status).toBe("partial");
    expect(paused).toBe(true);
    expect(observations).toHaveLength(2);
    expect(observations.every((observation) => observation.sourceStatus === "form_drift"))
      .toBe(true);
    expect(observations.every((observation) => observation.assessment?.deductionCandidate === false))
      .toBe(true);
  });

  it("fails closed across the batch for DNS/network and systemic detail-schema failures", async () => {
    const sessions = ["healthy", "network", "schema"].map((id) => ({
      _id: id,
      classId: "class-1",
      userId: "teacher-1",
      scheduledStartTime: "2026-07-20T09:00:00.000Z",
      scheduledEndTime: "2026-07-20T10:00:00.000Z",
      meetingStatus: "ENDED",
    }));
    const fakeClient = {
      async get(path: string, params?: Record<string, string>) {
        if (params?.status === "PAST") return { data: { sessions, page_count: 1 } };
        const id = path.split("/").at(-1)!;
        if (id === "network") {
          throw new TypeError("fetch failed", { cause: { code: "ENOTFOUND" } });
        }
        if (id === "schema") {
          return { data: {
            ...sessions[2],
            feedbackForm: { questions: [] },
            feedbackSubmissions: { unexpected: true },
          } };
        }
        return { data: {
          ...sessions[0],
          feedbackForm: { questions: [
            { questionText: "Topics covered" },
            { questionText: "How the student did in class" },
            { questionText: "Need more work on" },
            { questionText: "Homework and due date" },
          ] },
          feedbackSubmissions: [{
            _id: "submission-healthy",
            profile: "teacher",
            creditsConsumed: 1,
            createdAt: "2026-07-20T12:00:00.000Z",
            answers: [],
          }],
        } };
      },
    } as unknown as WiseClient;
    const observations: PostClassSessionObservation[] = [];
    const issues: Array<{ scope: string; issueType?: string; fingerprint?: string }> = [];
    const repository: PostClassFeedbackRepository = {
      beginSync: async () => "run-outage",
      completeSync: async () => undefined,
      failSync: async () => undefined,
      loadPolicyContext: async () => ({
        settingsVersion: 1,
        enforcementMode: "live",
        policyEffectiveAt: new Date("2026-07-19T00:00:00.000Z"),
        policyVersion: 1,
        mappingVersion: 1,
        mappings: [
          { field: "topics", questionText: "Topics covered" },
          { field: "performance", questionText: "How the student did in class" },
          { field: "improvement", questionText: "Need more work on" },
          { field: "homework", questionText: "Homework and due date" },
        ],
      }),
      loadSessionEnforcementContext: async () => ({
        enforcementMode: "live",
        policyEffectiveAt: new Date("2026-07-19T00:00:00.000Z"),
      }),
      listFeedbackEventCandidates: async () => [],
      listIncompleteRecheckCandidates: async () => [],
      listReminderCheckpointPersistedCandidates: async () => [],
      loadFeedbackEvents: async () => [],
      loadHistoricalFeedbackVersions: async () => [],
      loadPreviousComplianceLock: async () => null,
      saveObservation: async (_runId, observation) => {
        observations.push(observation);
        return { versionsInserted: 1, assessmentInserted: true };
      },
      recordSourceIssue: async (issue) => { issues.push(issue); },
      pauseForFormDrift: async () => undefined,
    };
    const result = await syncPostClassFeedback({
      repository,
      client: fakeClient,
      instituteId: "institute-1",
      resolveTutor: async () => ({
        status: "resolved",
        canonicalKey: "Kevin",
        displayName: "Kevin",
        wiseTeacherUserId: "teacher-1",
      }),
    }, { now: new Date("2026-07-24T00:00:00.000Z") });

    expect(result.status).toBe("partial");
    expect(issues).toContainEqual(expect.objectContaining({
      scope: "global",
      issueType: "wise_transient",
    }));
    expect(issues).toContainEqual(expect.objectContaining({
      scope: "global",
      issueType: "contract_error",
    }));
    expect(issues).toContainEqual(expect.objectContaining({
      scope: "session",
      fingerprint: "detail_retry:network",
    }));
    expect(issues).toContainEqual(expect.objectContaining({
      scope: "session",
      fingerprint: "detail_retry:schema",
    }));
    expect(observations).toHaveLength(1);
    expect(observations[0].sourceStatus).toBe("unavailable");
    expect(observations[0].assessment?.deductionCandidate).toBe(false);
  });

  it("force-refreshes a persisted checkpoint obligation omitted by Wise PAST", async () => {
    let detailCalls = 0;
    let markedUnavailable = false;
    const issues: Array<{ fingerprint: string; sessionId?: string | null }> = [];
    const fakeClient = {
      async get(_path: string, params?: Record<string, string>) {
        if (params?.status === "PAST") return { data: { sessions: [], page_count: 1 } };
        detailCalls += 1;
        throw new Error("Wise API 404: session not found");
      },
    } as unknown as WiseClient;
    const persisted = {
      sessionId: "wise-omitted",
      classId: "class-omitted",
      reason: "rolling_window" as const,
      scheduledStartAt: new Date("2026-07-20T02:00:00.000Z"),
      scheduledEndAt: new Date("2026-07-20T03:00:00.000Z"),
    };
    const repository: PostClassFeedbackRepository = {
      beginSync: async () => "run-omitted",
      completeSync: async () => undefined,
      failSync: async () => undefined,
      loadPolicyContext: async () => ({
        settingsVersion: 1,
        enforcementMode: "live",
        policyEffectiveAt: new Date("2026-07-01T00:00:00.000Z"),
        policyVersion: 1,
        mappingVersion: 1,
        mappings: [],
      }),
      loadSessionEnforcementContext: async () => ({
        enforcementMode: "live",
        policyEffectiveAt: new Date("2026-07-01T00:00:00.000Z"),
      }),
      listFeedbackEventCandidates: async () => [],
      listIncompleteRecheckCandidates: async () => [],
      listReminderCheckpointPersistedCandidates: async () => [persisted],
      filterReminderCheckpointCandidates: async (candidates, freshAfter, checkpointStartedAt) => {
        const planned = planPostClassReminderCheckpointCandidates({
          candidates,
          freshAfter,
          checkpointStartedAt,
          lastObservedBySession: new Map([[
            persisted.sessionId,
            new Date("2026-07-21T01:42:00.000Z"),
          ]]),
        });
        return { candidates: planned, totalPending: planned.length };
      },
      loadFeedbackEvents: async () => [],
      loadHistoricalFeedbackVersions: async () => [],
      loadPreviousComplianceLock: async () => null,
      saveObservation: async () => {
        throw new Error("404 detail must not save an observation");
      },
      recordSourceIssue: async (issue) => {
        issues.push(issue);
        if (issue.sessionId === persisted.sessionId && issue.scope === "session") {
          markedUnavailable = true;
        }
      },
      pauseForFormDrift: async () => undefined,
    };

    const result = await syncPostClassFeedback({
      repository,
      client: fakeClient,
      instituteId: "institute-1",
      resolveTutor: async () => {
        throw new Error("404 detail must not resolve a tutor");
      },
    }, {
      now: new Date("2026-07-21T02:00:00.000Z"),
      reminderCheckpoint: "day_after",
    });

    expect(detailCalls).toBe(1);
    expect(result).toMatchObject({
      status: "partial",
      discoveredCount: 0,
      candidateCount: 1,
      checkpoint: { pendingCount: 1, selectedCount: 1, hasMore: false },
    });
    expect(markedUnavailable).toBe(true);
    expect(issues).toContainEqual(expect.objectContaining({
      fingerprint: "session_not_found:wise-omitted:404",
      sessionId: "wise-omitted",
    }));
  });

  it("fails closed when settings or mapping change between evaluation and persistence", async () => {
    const session = {
      _id: "settings-race",
      classId: "class-1",
      userId: "teacher-1",
      scheduledStartTime: "2026-07-20T09:00:00.000Z",
      scheduledEndTime: "2026-07-20T10:00:00.000Z",
      meetingStatus: "ENDED",
    };
    const fakeClient = {
      async get(_path: string, params?: Record<string, string>) {
        if (params?.status === "PAST") {
          return { data: { sessions: [session], page_count: 1 } };
        }
        return { data: {
          ...session,
          feedbackForm: { questions: [
            { questionText: "Topics covered" },
            { questionText: "How the student did in class" },
            { questionText: "Need more work on" },
            { questionText: "Homework and due date" },
          ] },
          feedbackSubmissions: [{
            _id: "submission-1",
            profile: "teacher",
            creditsConsumed: 1,
            createdAt: "2026-07-20T12:00:00.000Z",
            answers: [],
          }],
        } };
      },
    } as unknown as WiseClient;
    let completed = false;
    let failed = false;
    let persistenceWrites = 0;
    const issues: Array<{ issueType: string; scope: string; details?: Record<string, unknown> }> = [];
    const repository: PostClassFeedbackRepository = {
      beginSync: async () => "run-settings-race",
      completeSync: async () => { completed = true; },
      failSync: async () => { failed = true; },
      loadPolicyContext: async () => ({
        settingsVersion: 4,
        enforcementMode: "shadow",
        policyEffectiveAt: null,
        policyVersion: 2,
        mappingVersion: 7,
        mappings: [
          { field: "topics", questionText: "Topics covered" },
          { field: "performance", questionText: "How the student did in class" },
          { field: "improvement", questionText: "Need more work on" },
          { field: "homework", questionText: "Homework and due date" },
        ],
      }),
      loadSessionEnforcementContext: async () => ({
        enforcementMode: "shadow",
        policyEffectiveAt: new Date("2026-07-19T00:00:00.000Z"),
      }),
      listFeedbackEventCandidates: async () => [],
      listIncompleteRecheckCandidates: async () => [],
      listReminderCheckpointPersistedCandidates: async () => [],
      loadFeedbackEvents: async () => [],
      loadHistoricalFeedbackVersions: async () => [],
      loadPreviousComplianceLock: async () => null,
      saveObservation: async (_runId, observation) => {
        expect(observation).toMatchObject({
          settingsVersion: 4,
          policyVersion: 2,
          mappingVersion: 7,
        });
        assertPostClassObservationSnapshot(observation, {
          settingsVersion: 5,
          policyVersion: 2,
          mappingVersion: 8,
        });
        persistenceWrites += 1;
        return { versionsInserted: 1, assessmentInserted: true };
      },
      recordSourceIssue: async (issue) => { issues.push(issue); },
      pauseForFormDrift: async () => undefined,
    };

    await expect(syncPostClassFeedback({
      repository,
      client: fakeClient,
      instituteId: "institute-1",
      resolveTutor: async () => ({
        status: "resolved",
        canonicalKey: "teacher",
        displayName: "Teacher",
        wiseTeacherUserId: "teacher-1",
      }),
    }, { now: new Date("2026-07-21T00:00:00.000Z") }))
      .rejects.toThrow(/configuration changed during collection/iu);

    expect(persistenceWrites).toBe(0);
    expect(completed).toBe(false);
    expect(failed).toBe(true);
    expect(issues).toContainEqual(expect.objectContaining({
      issueType: "configuration_changed",
      scope: "global",
      details: expect.objectContaining({
        expected: { settingsVersion: 4, policyVersion: 2, mappingVersion: 7 },
        current: { settingsVersion: 5, policyVersion: 2, mappingVersion: 8 },
      }),
    }));
  });
});
