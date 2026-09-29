import { describe, expect, it } from "vitest";
import type * as schema from "@/lib/db/schema";
import { buildAutowriterReview, diffWords, type ReviewSourceRows } from "../review-data";
import { fieldsHash } from "../submit";

type PostRow = typeof schema.feedbackAutowriterPosts.$inferSelect;
type ReviewRow = typeof schema.feedbackAutowriterReviews.$inferSelect;
type VerdictRow = typeof schema.feedbackAutowriterVerdicts.$inferSelect;
type MetricRow = typeof schema.feedbackAutowriterDailyMetrics.$inferSelect;

const NOW = new Date("2026-09-30T03:00:00Z");
const FIRST = { topics: "Rotation patterns", performance: "Pasorn spotted symmetry fast.", improvement: "Colour sequences", homework: "" };
const RENAMED = { ...FIRST, performance: "Tann spotted symmetry fast." };

function post(overrides: Partial<PostRow>): PostRow {
  return {
    id: "post-1", wiseSessionId: "s1", wiseClassId: "c1", wiseTeacherUserId: "696e2c4343579bbada2340f8", kind: "first_shot",
    correctionId: null, fields: FIRST, fieldsSha256: fieldsHash(FIRST), bodyHash: "b", billing: {}, arm: "luna", evidence: "summary",
    pipeline: null, actorKind: "autowriter", actor: "system:feedback-autowriter", reason: null,
    postStartedAt: new Date("2026-09-29T08:39:45Z"), postFinishedAt: new Date("2026-09-29T08:39:46Z"), outcome: "verified",
    verification: {}, provenance: "backfill", reconstruction: { method: "pc_first_version" }, recordedAt: new Date("2026-09-30T00:00:00Z"),
    settledAt: new Date("2026-09-29T08:39:46Z"), ...overrides,
  };
}

function review(overrides: Partial<ReviewRow>): ReviewRow {
  return {
    wiseSessionId: "s1", firstPostId: "post-1", tutorKey: "Mimi", wiseTeacherUserId: "696e2c4343579bbada2340f8",
    classEndedAt: new Date("2026-09-29T08:00:00Z"), bangkokDate: "2026-09-29", inclusionReason: "new_tutor",
    inclusionProbability: "1.000", sampleDraw: 0.5, samplingPolicy: "v1", flaggedAt: null, flagSources: [],
    currentVerdictId: null, reviewedAt: null, measuredFixCount: 1, correctionsVerified: 1,
    createdAt: NOW, updatedAt: NOW, ...overrides,
  };
}

function verdict(overrides: Partial<VerdictRow>): VerdictRow {
  return {
    id: "v1", wiseSessionId: "s2", targetKind: "post", postId: "post-2", dryRunId: null, fieldsSha256: "x", verdict: "approve",
    severity: null, criticalCategory: null, note: null, reviewer: "kevhsh7@gmail.com", source: "dashboard", supersedesId: null,
    createdAt: new Date("2026-09-29T15:00:00Z"), ...overrides,
  };
}

function metric(overrides: Partial<MetricRow>): MetricRow {
  return {
    metricDate: "2026-09-29", tutorKey: "*", liveMode: true, posted: 8, required: 8, reviewed: 1, requiredPending: 7, accurate: 1,
    cosmetic: 0, factual: 0, critical: 0, eligible: 9, excludedScope: 0, excludedTutorFirst: 5, excludedAbsent: 0,
    excludedTutorOff: 0, pending: 0, unseen: 0, held: 1, expired: 0, failed: 0, measuredFixClasses: 6, correctionsVerified: 6,
    policyVersion: 1, computedAt: NOW, ...overrides,
  };
}

function source(overrides: Partial<ReviewSourceRows> = {}): ReviewSourceRows {
  return {
    reviews: [
      review({}),
      review({ wiseSessionId: "s2", firstPostId: "post-2", currentVerdictId: "v1", measuredFixCount: 0, correctionsVerified: 0 }),
      // An in-person class never reaches the review surface, even with a stray review row.
      review({ wiseSessionId: "s3", firstPostId: "post-3", measuredFixCount: 0, correctionsVerified: 0 }),
    ],
    posts: [
      post({}),
      post({
        id: "fix-1", kind: "correction", fields: RENAMED, fieldsSha256: fieldsHash(RENAMED), actorKind: "script",
        actor: "script:nickname-fix (kevhsh7@gmail.com)", reason: "owner naming policy: nickname", postStartedAt: null,
        postFinishedAt: new Date("2026-09-29T13:26:11Z"),
      }),
      post({ id: "post-2", wiseSessionId: "s2" }),
      post({ id: "post-3", wiseSessionId: "s3" }),
    ],
    verdicts: [verdict({})],
    flags: [{
      id: "f1", wiseSessionId: "s2", source: "measured_fix", suggestedSeverity: null, suggestedCategory: null, note: "Tutor saved",
      createdBy: "system", idempotencyKey: "k", resolvedByVerdictId: null, createdAt: new Date("2026-09-29T16:00:00Z"),
    }],
    fixEvents: [
      { wiseEventId: "e1", wiseSessionId: "s1", eventAt: new Date("2026-09-29T08:39:45.495Z"), actorKind: "autowriter_first", countsAsFix: false },
      { wiseEventId: "e2", wiseSessionId: "s1", eventAt: new Date("2026-09-29T13:26:07Z"), actorKind: "autowriter_correction", countsAsFix: true },
    ],
    sessions: [
      { wiseSessionId: "s1", wiseClassId: "c1", wiseTeacherUserId: "696e2c4343579bbada2340f8", state: "verified", reason: "verified", className: "Pasorn (Tann.Ch) Class" },
      { wiseSessionId: "s2", wiseClassId: "c2", wiseTeacherUserId: "696e2c4343579bbada2340f8", state: "verified", reason: "verified", className: "Second" },
      { wiseSessionId: "s3", wiseClassId: "c3", wiseTeacherUserId: "696e2c4343579bbada2340f8", state: "skipped_scope", reason: "session_type_OFFLINE", className: "In-person class" },
    ],
    currentVersions: [],
    metrics: [metric({}), metric({ tutorKey: "Mimi", posted: 6, eligible: 6 }), metric({ metricDate: "2026-09-28", liveMode: false, posted: 0, eligible: 3 })],
    lastDailyGate: null,
    incidents: [],
    lastRun: null,
    unresolvedCriticalFlags: 0,
    ...overrides,
  };
}

describe("diffWords", () => {
  it("marks removed and added words and keeps the rest", () => {
    expect(diffWords("Pasorn spotted symmetry fast.", "Tann spotted symmetry fast.")).toEqual([
      { kind: "removed", text: "Pasorn" },
      { kind: "added", text: "Tann" },
      { kind: "same", text: " spotted symmetry fast." },
    ]);
    expect(diffWords("same", "same")).toEqual([{ kind: "same", text: "same" }]);
    expect(diffWords("", "new")).toEqual([{ kind: "added", text: "new" }]);
  });
});

describe("buildAutowriterReview", () => {
  it("shows the immutable first shot against the last verified correction, with the diff and the measured fixes", () => {
    const payload = buildAutowriterReview({ now: NOW, ...source() });
    const item = payload.queue.find((entry) => entry.wiseSessionId === "s1")!;
    expect(item.firstShot).toMatchObject({ fields: FIRST, provenance: "backfill", method: "pc_first_version" });
    expect(item.current).toMatchObject({ source: "correction", fields: RENAMED });
    expect(item.changed).toBe(true);
    expect(item.diff.map((entry) => entry.field)).toEqual(["performance"]);
    expect(item.fixEvents.map((event) => event.actorKind)).toEqual(["autowriter_first", "autowriter_correction"]);
    expect(item.corrections[0]).toMatchObject({ actor: "script:nickname-fix (kevhsh7@gmail.com)", outcome: "verified" });
    expect(item.status).toBe("needs_review");
    expect(item.tutor).toBe("Thanit (Mimi) Montrikittiphant");
  });

  it("prefers the text Class Feedback read from Wise when it is newer than our last post", () => {
    const edited = { ...RENAMED, homework: "Worksheet 3" };
    const payload = buildAutowriterReview({ now: NOW, ...source({
      currentVersions: [{ wiseSessionId: "s1", observedAt: new Date("2026-09-29T14:00:00Z"), fields: edited }],
    }) });
    expect(payload.queue.find((entry) => entry.wiseSessionId === "s1")!.current).toMatchObject({ source: "wise_feedback_version", fields: edited });
  });

  it("keeps in-person classes out of the queue", () => {
    const payload = buildAutowriterReview({ now: NOW, ...source() });
    expect(payload.queue.map((entry) => entry.wiseSessionId)).toEqual(["s1", "s2"].toSorted());
    expect(JSON.stringify(payload)).not.toContain("In-person class");
  });

  it("computes the gate from current verdicts, open flags and live-day coverage", () => {
    const payload = buildAutowriterReview({ now: NOW, ...source() });
    expect(payload.gate).toMatchObject({
      reviewed: 1, accurate: 1, pendingFlaggedReviews: 1, coverageNum: 8, coverageDen: 9, status: "below_head_start",
      currentTutors: 5, nextExpansionSize: 8,
    });
    expect(payload.gate.reasons).toContain("1 flagged post(s) waiting for review");
    expect(payload.queue.find((entry) => entry.wiseSessionId === "s2")).toMatchObject({ status: "flagged", currentVerdict: { verdict: "approve" } });
    expect(payload.coverage).toMatchObject({ posted: 8, miss_held: 1, excluded_tutor_first: 5 });
    expect(payload.daily.map((row) => row.date)).toEqual(["2026-09-29", "2026-09-28"]);
    expect(payload.tutors.find((row) => row.tutorKey === "Mimi")).toMatchObject({ posted: 2, reviewed: 1, coverageNum: 6, coverageDen: 6, phase: "full_review" });
    expect(payload.fixRounds).toMatchObject({ one: 1, zero: 1 });
  });

  it("drops a first_shot_unverified incident once the backfill proved that first shot", () => {
    const incident = {
      id: "i1", dedupeKey: "first_shot_unverified:s1", kind: "first_shot_unverified" as const, severity: "info" as const,
      wiseSessionId: "s1", summary: "…", detail: {}, pushStatus: "not_required" as const, pushAttempts: 0, pushedChannels: [],
      pushedAt: null, lastPushError: null, nextPushAt: null, acknowledgedAt: null, acknowledgedBy: null, createdAt: NOW,
    };
    expect(buildAutowriterReview({ now: NOW, ...source({ incidents: [incident] }) }).incidents).toEqual([]);
  });
});
