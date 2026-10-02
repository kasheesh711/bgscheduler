import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { eq, sql } from "drizzle-orm";
import type { Database } from "@/lib/db";
import * as schema from "@/lib/db/schema";
import { startTestDb, stopTestDb } from "@/tests/integration/db-helper";
import { KEVIN_ONLINE_WISE_USER_ID } from "../../roster";
import { fieldsHash } from "../../submit";
import { dbEvidenceSources } from "../evidence";
import { AGENT_FLAG_ACTOR, applyAgentFlags, planAgentFlags } from "../flags";
import { loadOtherStudentNames } from "../prechecks";
import { loadWatchdog, type ClassReport } from "../report";
import { loadNightlyTargets } from "../select";
import { PIM_FIELDS } from "./nightly-fixtures";

/**
 * The nightly audit's SQL against a real Postgres (all migrations applied): its reads select exactly the night's
 * verified autowriter posts, and its one write — agent flags and incidents — is idempotent.
 */

let handle: Awaited<ReturnType<typeof startTestDb>>;
let db: Database;

const S = schema.feedbackAutowriterSessions;
const P = schema.feedbackAutowriterPosts;
const R = schema.feedbackAutowriterReviews;
const V = schema.feedbackAutowriterVerdicts;
const FL = schema.feedbackAutowriterFlags;
const FX = schema.feedbackAutowriterFixEvents;
const I = schema.feedbackAutowriterIncidents;
const C = schema.feedbackAutowriterCalls;
const E = schema.feedbackIsebEvidence;

const id = (n: number) => `6a0000000000000000000${String(n).padStart(3, "0")}`;
const classId = (n: number) => `6a00000000000000000c0${String(n).padStart(2, "0")}`;
const SHA = fieldsHash(PIM_FIELDS);
const BILLING = { sessionStatus: "COMPLETED", creditsConsumed: 1 };

async function session(n: number, patch: Partial<typeof S.$inferInsert> = {}) {
  await db.insert(S).values({
    wiseSessionId: id(n), wiseClassId: classId(n), wiseTeacherUserId: KEVIN_ONLINE_WISE_USER_ID,
    scheduledEndAt: new Date("2026-10-02T09:00:00Z"), deadlineAt: new Date("2026-10-04T16:59:00Z"), state: "verified",
    evidence: "transcript", arm: "sol", fields: PIM_FIELDS, fieldsSha256: SHA, billing: BILLING, ...patch,
  });
}

async function firstShot(n: number, patch: Partial<typeof P.$inferInsert> = {}): Promise<string> {
  const [row] = await db.insert(P).values({
    wiseSessionId: id(n), wiseClassId: classId(n), wiseTeacherUserId: KEVIN_ONLINE_WISE_USER_ID, kind: "first_shot", fields: PIM_FIELDS,
    fieldsSha256: SHA, billing: BILLING, actorKind: "autowriter", actor: "system:feedback-autowriter", outcome: "verified",
    provenance: "snapshot", pipeline: { evidence: "transcript", promptVersion: 5 }, postStartedAt: new Date("2026-10-02T09:40:00Z"), ...patch,
  }).returning({ id: P.id });
  return row.id;
}

beforeAll(async () => {
  handle = await startTestDb();
  db = handle.db as unknown as Database;
}, 120_000);

afterAll(async () => {
  if (handle) await stopTestDb(handle);
});

beforeEach(async () => {
  await db.execute(sql`TRUNCATE TABLE feedback_autowriter_incidents, feedback_autowriter_fix_events, feedback_autowriter_flags,
    feedback_autowriter_reviews, feedback_autowriter_verdicts, feedback_autowriter_posts, feedback_autowriter_sessions,
    feedback_autowriter_calls, feedback_iseb_evidence, post_class_sessions CASCADE`);
});

describe("loadNightlyTargets (Postgres, SELECT only)", () => {
  it("selects the night's verified autowriter posts with their verdict, owner flags and person saves", async () => {
    // A: in the night, reviewed (approved), an open owner flag, a tutor saved after our post.
    await session(1, { metadata: { className: "Somsri (Pim.Ta) Testwong", transcript: { speakerMethod: "zoom_alignment" } }, sonioxTranscriptionId: "job-a" });
    const postA = await firstShot(1);
    const [verdict] = await db.insert(V).values({
      wiseSessionId: id(1), postId: postA, fieldsSha256: SHA, verdict: "approve", reviewer: "owner@example.invalid", source: "dashboard",
    }).returning({ id: V.id });
    await db.insert(R).values({
      wiseSessionId: id(1), firstPostId: postA, tutorKey: "Kevin", bangkokDate: "2026-10-02", inclusionReason: "random_sample",
      inclusionProbability: "0.500", sampleDraw: 0.2, samplingPolicy: "test", currentVerdictId: verdict.id,
    });
    await db.insert(FL).values({ wiseSessionId: id(1), source: "owner", createdBy: "owner@example.invalid", idempotencyKey: "owner:1" });
    await db.insert(FX).values({
      wiseEventId: "event-1", wiseSessionId: id(1), eventAt: new Date("2026-10-02T11:00:00Z"), actorKind: "tutor", countsAsFix: true, classifierVersion: 1,
    });
    // B: in the night (early), summary-route; a measured-fix flag is not the owner's; our own save is not a person's.
    await session(2, { scheduledEndAt: new Date("2026-10-01T20:00:00Z"), evidence: "summary", metadata: { className: "Noknoi (Nok.Ka) Samplename" } });
    await firstShot(2, { pipeline: { evidence: "summary", formatGuide: { id: "iseb", version: 1 } } });
    await db.insert(FL).values({ wiseSessionId: id(2), source: "measured_fix", createdBy: "system", idempotencyKey: "fix:2" });
    await db.insert(FX).values({
      wiseEventId: "event-2", wiseSessionId: id(2), eventAt: new Date("2026-10-02T11:00:00Z"), actorKind: "autowriter_first", countsAsFix: false, classifierVersion: 1,
    });
    // Outside the night (23:30 Bangkok on the 1st, 00:30 on the 3rd), not verified, or no text: never.
    await session(3, { scheduledEndAt: new Date("2026-10-01T16:30:00Z") });
    await firstShot(3);
    await session(4, { scheduledEndAt: new Date("2026-10-02T17:30:00Z") });
    await firstShot(4);
    await session(5, { state: "held", metadata: { className: "Tawanchai Example" } });
    await session(8, { fields: null, fieldsSha256: null });
    // Verified, but no autowriter first-shot row yet (not snapshotted, or only another actor's): audited all the same.
    await session(6, { scheduledEndAt: new Date("2026-10-02T08:00:00Z"), postStartedAt: new Date("2026-10-02T08:30:00Z") });
    await firstShot(6, { actorKind: "script", actor: "script:test" });
    await session(7, { scheduledEndAt: new Date("2026-10-02T07:00:00Z") });

    const targets = await loadNightlyTargets(db, { night: "2026-10-02" });
    expect(targets.map((target) => target.wiseSessionId)).toEqual([id(1), id(6), id(7), id(2)]);
    expect(targets.filter((target) => target.firstShotPostId === null).map((target) => target.wiseSessionId)).toEqual([id(6), id(7)]);
    expect(targets[0]).toMatchObject({
      wiseClassId: classId(1), tutorKey: "Kevin", evidence: "transcript", fieldsSha256: SHA, sonioxTranscriptionId: "job-a",
      firstShotPostId: postA, currentVerdictId: verdict.id, verdict: "approve", ownerFlagOpen: true, humanSavedSincePost: true,
      guided: false, studentDisplayName: "Pim", scheduledEndAt: "2026-10-02T09:00:00.000Z",
    });
    expect(targets[3]).toMatchObject({ evidence: "summary", verdict: null, ownerFlagOpen: false, humanSavedSincePost: false, guided: true, studentDisplayName: "Nok" });
    expect((await loadNightlyTargets(db, { night: "2026-10-02", sessionIds: [id(2)] })).map((target) => target.wiseSessionId)).toEqual([id(2)]);
    expect(await loadNightlyTargets(db, { night: "2026-09-20" })).toEqual([]);
  });
});

describe("other reads (Postgres, SELECT only)", () => {
  it("names the tutor's other students, without the class itself", async () => {
    await session(1, { metadata: { className: "Somsri (Pim.Ta) Testwong" } });
    await session(2, { metadata: { className: "Noknoi (Nok.Ka) Samplename" } });
    await session(5, { state: "held", metadata: { className: "Tawanchai Example" } });
    await session(8, { metadata: { className: "Maths Y5 group" } });
    await session(9, { wiseTeacherUserId: "6a00000000000000000000ff", metadata: { className: "Other (Fern.Ta) Tutorstudent" } });
    expect(await loadOtherStudentNames(db, { tutorKey: "Kevin", excludeClassId: classId(1), now: new Date("2026-10-03T00:00:00Z") }))
      .toEqual(["Nok", "Tawanchai"]);
  });

  it("reads the row's transcript facts and the retained ISEB record", async () => {
    await session(1, { metadata: { transcript: { speakerMethod: "talk_share" }, judge: { faithful: true }, studentJoinedAsGuest: "Pim iPad" } });
    await db.insert(E).values({ wiseSessionId: id(1), evidenceHash: "hash-1", lessonRecord: "[00:00] TUTOR: Fractions.", evidenceKind: "transcript" });
    const sources = dbEvidenceSources(db);
    expect(await sources.rowMeta(id(1))).toEqual({ speakerMethod: "talk_share", judge: { faithful: true }, joinedAsGuest: "Pim iPad" });
    expect(await sources.isebRecord(id(1), "hash-1")).toEqual({ evidenceHash: "hash-1", lessonRecord: "[00:00] TUTOR: Fractions.", evidenceKind: "transcript" });
    expect(await sources.isebRecord(id(1), "other")).toBeNull();
    expect(await sources.rowMeta(id(99))).toEqual({ speakerMethod: null, judge: null, joinedAsGuest: null });
  });

  it("totals the day's production calls per class and against the previous days", async () => {
    const call = (n: number, role: "writer" | "judge" | "transcriber", at: string, costUsd: string | null, error: string | null = null) => ({
      wiseSessionId: id(n), role, arm: role === "transcriber" ? "soniox" as const : "sol" as const, requestedModel: "m", ok: error === null,
      error, costUsd, promptVersion: 5, createdAt: new Date(at),
    });
    await db.insert(C).values([
      ...Array.from({ length: 5 }, () => call(1, "writer", "2026-10-02T03:00:00Z", "0.30000000")),
      call(2, "writer", "2026-10-02T04:00:00Z", "0.01000000"),
      call(2, "judge", "2026-10-02T04:01:00Z", null, "timeout after 240000 ms"),
      call(2, "judge", "2026-10-02T04:02:00Z", null, "The operation timed out"),
      call(2, "transcriber", "2026-10-02T04:03:00Z", "0.10000000"),
      // Previous days (Bangkok dates 28, 29, 30 Sep) and another night.
      call(3, "writer", "2026-09-28T03:00:00Z", "0.30000000"),
      call(3, "writer", "2026-09-29T03:00:00Z", "0.40000000"),
      call(3, "writer", "2026-09-30T03:00:00Z", "0.50000000"),
      call(3, "writer", "2026-10-02T18:00:00Z", "9.00000000"),
    ]);
    const watchdog = await loadWatchdog(db, { night: "2026-10-02" });
    expect(watchdog.rows.find((row) => row.wiseSessionId === id(1))).toMatchObject({ calls: 5, writerCalls: 5, costUsd: 1.5 });
    expect(watchdog.rows.find((row) => row.wiseSessionId === id(2))).toMatchObject({ judgeCalls: 2, transcriberCalls: 1, timeouts: 2, unpriced: 2 });
    expect(watchdog.previousDays).toEqual([{ day: "2026-09-28", usd: 0.3 }, { day: "2026-09-29", usd: 0.4 }, { day: "2026-09-30", usd: 0.5 }]);
    expect(watchdog).toMatchObject({ medianPreviousUsd: 0.4, dayOutlier: true });
    expect(watchdog.dayTotalUsd).toBeCloseTo(1.61);
    expect(watchdog.outliers.map((outlier) => [outlier.wiseSessionId, outlier.reasons])).toEqual([
      [id(1), ["cost_1.50_usd", "writer_runs_5"]],
      [id(2), ["timeouts_2"]],
    ]);
  });
});

describe("applyAgentFlags (the one write)", () => {
  it("flags each class once, puts it back in the review list, and raises one incident for a high-confidence critical", async () => {
    await session(1);
    const postA = await firstShot(1);
    await db.insert(R).values({
      wiseSessionId: id(1), firstPostId: postA, tutorKey: "Kevin", bangkokDate: "2026-10-02", inclusionReason: "not_sampled",
      inclusionProbability: "0.000", sampleDraw: 0.9, samplingPolicy: "test",
    });
    const report = (n: number, patch: Partial<ClassReport>): ClassReport => ({
      wiseSessionId: id(n), fieldsSha256: SHA, tutorKey: "Kevin", className: null, postedEvidenceKind: "transcript", grade: "rebuilt", lateFrom: null,
      auditVerdict: "major", auditFailure: null, auditSummaryLine: null, severity: "major", modes: ["M06"], findings: [], ownerVerdict: null,
      judgePassed: true, wiseTextEdited: false, costUsd: 0.4, criticalHighConfidence: false, criticalCategory: null, ...patch,
    });
    const plan = planAgentFlags([
      report(1, { severity: "critical", modes: ["M01"], criticalHighConfidence: true, criticalCategory: "wrong_person" }),
      report(2, {}),
    ], { auditVersion: 1, maxFlags: 10 });
    expect(await applyAgentFlags(db, plan.items)).toEqual({ inserted: 2, existing: 0, incidents: 1 });
    expect(await applyAgentFlags(db, plan.items)).toEqual({ inserted: 0, existing: 2, incidents: 0 });
    const flags = await db.select().from(FL).orderBy(FL.wiseSessionId);
    expect(flags.map((flag) => [flag.wiseSessionId, flag.source, flag.createdBy, flag.suggestedSeverity, flag.suggestedCategory, flag.idempotencyKey])).toEqual([
      [id(1), "agent", AGENT_FLAG_ACTOR, "critical", "wrong_person", `agent-audit:${id(1)}:${SHA}:1`],
      [id(2), "agent", AGENT_FLAG_ACTOR, "factual", null, `agent-audit:${id(2)}:${SHA}:1`],
    ]);
    const [review] = await db.select().from(R).where(eq(R.wiseSessionId, id(1)));
    expect(review.flaggedAt).not.toBeNull();
    expect(review.flagSources).toEqual(["agent"]);
    const incidents = await db.select().from(I);
    expect(incidents).toHaveLength(1);
    expect(incidents[0]).toMatchObject({
      kind: "critical_flag", severity: "critical", wiseSessionId: id(1), pushStatus: "pending", dedupeKey: `agent-audit:${id(1)}:${SHA}:1`,
    });
    expect(incidents[0].summary).not.toMatch(/Pim|fraction/iu);
  });
});
