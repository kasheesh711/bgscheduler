import { readFileSync } from "node:fs";
import { beforeAll, afterAll, beforeEach, describe, it, expect, vi } from "vitest";
import { eq, sql } from "drizzle-orm";

vi.mock("server-only", () => ({}));

import type { Database } from "@/lib/db";
import * as schema from "@/lib/db/schema";
import { startTestDb, stopTestDb, truncateAll } from "@/tests/integration/db-helper";
import { feedbackAutoSubmittedFlag, feedbackAutoSubmittedSql, feedbackProofExclusion, staffFeedbackEventSql } from "../feedback-proof";
import { advancePostClassTimingPolicy } from "../settings";
import { reassessPostClassSessions } from "../reassess";
import { createDrizzlePostClassFeedbackRepository } from "../repository";
import { calculateFeedbackDeadline, deriveEventTimingEvidence, evaluateSessionCompliance } from "../policy";

let handle: Awaited<ReturnType<typeof startTestDb>>;
beforeAll(async () => { handle = await startTestDb(); }, 60_000);
afterAll(async () => { if (handle) await stopTestDb(handle); });
beforeEach(async () => {
  await truncateAll(handle.db);
  await handle.db.delete(schema.wiseActivityEvents);
  await handle.db.update(schema.postClassSettings).set({ policyVersion: 1, formMappingVersion: 1 });
});
const appDb = () => handle.db as unknown as Database;

it("uses identical NULL-safe staff classification in SQL and event explanations", async () => {
  const cases = [
    { role: "TEACHER", payload: {} }, { role: " ADMIN ", payload: { session: { autoSubmitted: null } } },
    { role: "STUDENT", payload: {} }, { role: null, payload: {} }, { role: "OWNER", payload: {} },
    { role: "TEACHER", payload: { session: { autoSubmitted: true } } },
    { role: "ADMIN", payload: { autoSubmitted: true } },
    { role: "TEACHER", payload: { session: { autoSubmitted: false }, autoSubmitted: true } },
    { role: "ADMIN", payload: { session: { autoSubmitted: "invalid" }, feedback: { autoSubmitted: true } } },
  ];
  for (const [index, entry] of cases.entries()) {
    await handle.db.insert(schema.wiseActivityEvents).values({
      eventId: String(index), eventName: "SessionFeedbackSubmittedEvent", eventTimestamp: new Date(),
      actorRole: entry.role, payload: entry.payload,
    });
  }
  const rows = await handle.db.select({ id: schema.wiseActivityEvents.eventId,
    qualifies: sql<boolean>`${staffFeedbackEventSql(feedbackAutoSubmittedSql(schema.wiseActivityEvents.payload), schema.wiseActivityEvents.actorRole)}`,
  }).from(schema.wiseActivityEvents);
  for (const row of rows) {
    const entry = cases[Number(row.id)];
    expect(row.qualifies).toBe(feedbackProofExclusion({ actorRole: entry.role,
      autoSubmitted: feedbackAutoSubmittedFlag(entry.payload),
    }) === null);
  }
});

describe("persisted evidence recovery", () => {
  it("advances the policy once, clears contaminated locks, and survives another collector assessment", async () => {
    const end = new Date("2026-09-26T06:00:00Z");
    const deadlineAt = calculateFeedbackDeadline(end);
    const [session] = await handle.db.insert(schema.postClassSessions).values({
      wiseSessionId: "rew-recovery", wiseClassId: "class", scheduledStartAt: new Date("2026-09-26T05:00:00Z"),
      scheduledEndAt: end, deadlineAt, finalStatus: "ENDED", eligible: true,
      sourceStatus: "ready", timingStatus: "on_time", contentStatus: "substantive", enforcementMode: "live",
    }).returning();
    const [version] = await handle.db.insert(schema.postClassFeedbackVersions).values({
      sessionId: session.id, versionKey: "submission:hash", wiseSubmissionId: "submission", contentHash: "hash", profile: "teacher",
      topics: "We studied quadratic factorisation and checked each solution by substituting into the original equation.",
        performance: "The student identified common factors quickly and explained the sign changes with clear reasoning. She corrected one arithmetic mistake independently.",
        improvement: "Next lesson we will practise completing the square, because choosing a suitable method before calculating will improve her confidence and accuracy.", homework: "",
      observedAt: new Date("2026-09-29T19:00:00Z"), sourceCreatedAt: end,
      sourceTimestampTrustworthy: false, sourceTimestampKind: "created",
    }).returning();
    await handle.db.update(schema.postClassSessions).set({ firstOnTimeCompliantVersionId: version.id }).where(eq(schema.postClassSessions.id, session.id));
    await handle.db.insert(schema.postClassAssessments).values({
      sessionId: session.id, feedbackVersionId: version.id, assessmentKey: "old-contaminated",
      policyVersion: 1, mappingVersion: 1, sourceStatus: "ready", contentStatus: "substantive", timingStatus: "on_time", enforcementMode: "live", sourceReady: true, rawOnTime: true,
      details: { scheduledEndAt: end.toISOString(), deadlineAt: deadlineAt.toISOString(), onTimeVersionKey: version.versionKey },
    });
    await handle.db.insert(schema.wiseActivityEvents).values([
      { eventId: "student-before", sessionId: "rew-recovery", eventName: "SessionFeedbackSubmittedEvent", eventTimestamp: new Date("2026-09-26T06:08:16Z"), actorRole: "STUDENT" },
      { eventId: "teacher-after", sessionId: "rew-recovery", eventName: "SessionFeedbackSubmittedEvent", eventTimestamp: new Date("2026-09-29T18:40:13.034Z"), actorRole: "TEACHER" },
    ]);
    const [deduction] = await handle.db.insert(schema.postClassDeductions).values({ sessionId: session.id, status: "approved", amountMinor: 10_000, defaultFinanceMonth: "2026-09-01", decisionByEmail: "reviewer@example.com" }).returning();
    // Enforcement comes from the session's historical activation window.
    await handle.db.update(schema.postClassEnforcementWindows).set({ mode: "live", startsAt: new Date("2026-08-25T17:00:00Z"), policyEffectiveAt: new Date("2026-08-25T17:00:00Z"), actorEmail: "reviewer@example.com" });
    const firstPolicy = await advancePostClassTimingPolicy({ email: "reviewer@example.com" }, 1, appDb());
    expect(firstPolicy.policyVersion).toBe(2);
    expect((await advancePostClassTimingPolicy({ email: "reviewer@example.com" }, 1, appDb())).policyVersion).toBe(2);
    const opts = { db: appDb(), apply: true, financeActions: false, timingStatuses: ["on_time", "late", "not_due", "unknown"] as const,
      wiseSessionIds: ["rew-recovery"], now: new Date("2026-09-30T03:00:00Z") };
    const outcome = await reassessPostClassSessions({ ...opts, timingStatuses: [...opts.timingStatuses] });
    expect(outcome).toMatchObject({ scanned: 1, changed: 1, failed: 0, deductionsWaived: 0 });
    expect(outcome.outcomes[0]).toMatchObject({ to: "late", objectiveViolation: true, onTimeComplianceLocked: false });
    const [corrected] = await handle.db.select().from(schema.postClassSessions).where(eq(schema.postClassSessions.id, session.id));
    expect(corrected).toMatchObject({ policyVersion: 2, timingStatus: "late", firstOnTimeCompliantVersionId: null });
    const repository = createDrizzlePostClassFeedbackRepository(appDb());
    const lock = await repository.loadPreviousComplianceLock("rew-recovery", 2, 1, end);
    const assessment = evaluateSessionCompliance({ sourceStatus: "ready", scheduledEndAt: end, now: opts.now,
      versions: await repository.loadHistoricalFeedbackVersions("rew-recovery"), enforcementMode: "live", policyEffectiveAt: new Date("2026-08-25T17:00:00Z"),
      policyVersion: 2, mappingVersion: 1, previousOnTimeLock: lock,
      eventTiming: deriveEventTimingEvidence({ deadlineAt, events: await repository.loadFeedbackEvents("rew-recovery"), eventCoverageFrom: await repository.loadFeedbackEventCoverageFloor() }),
    });
    expect(assessment).toMatchObject({ timingStatus: "late", onTimeComplianceLocked: false });
    const versions = await repository.loadHistoricalFeedbackVersions("rew-recovery");
    const events = await repository.loadFeedbackEvents("rew-recovery");
    const runId = await repository.beginSync({ triggerType: "manual", actorEmail: "reviewer@example.com", startedAt: opts.now,
      windowStart: "2026-09-26", windowEnd: "2026-09-30", detailCap: 1 });
    await repository.saveObservation(runId, {
      settingsVersion: firstPolicy.version, policyVersion: 2, mappingVersion: 1,
      candidate: { sessionId: "rew-recovery", classId: "class", reason: "feedback_event" },
      session: { sessionId: "rew-recovery", classId: "class", className: "Math", subject: "Math",
        scheduledStartAt: session.scheduledStartAt, scheduledEndAt: end, meetingStatus: "ENDED", classType: "LIVE",
        sessionType: "ONLINE", attendanceStatus: null, submissionSessionStatuses: ["ENDED"], complimentaryOrTrial: false,
        creditsConsumed: 1, participants: [], participantsAuthoritative: false, questions: [],
        mapping: { status: "ready", byField: {}, missingRequiredFields: [], ambiguousFields: [], unmappedQuestionIds: [], reason: null },
        feedbackVersions: versions,
      }, feedbackVersionHistory: versions, tutor: { status: "resolved", canonicalKey: "rew", displayName: "Rew", wiseTeacherUserId: "teacher" },
      eligibility: { status: "eligible", eligible: true, reason: "ended_positive_credits" },
      sourceStatus: "ready", assessment, enforcementMode: "live", events, observedAt: new Date(opts.now.getTime() + 1000),
    });
    expect((await handle.db.select().from(schema.postClassSessions).where(eq(schema.postClassSessions.id, session.id)))[0])
      .toMatchObject({ timingStatus: "late", firstOnTimeCompliantVersionId: null });
    expect((await reassessPostClassSessions({ ...opts, timingStatuses: [...opts.timingStatuses] })).changed).toBe(0);
    expect((await handle.db.select().from(schema.postClassDeductions).where(eq(schema.postClassDeductions.id, deduction.id)))[0])
      .toMatchObject({ status: "approved", amountMinor: 10_000, defaultFinanceMonth: "2026-09-01", decisionByEmail: "reviewer@example.com" });
  });
});

it("migration preserves old rule and mapping timestamps while new inserts use version 2", async () => {
  const client = await handle.pool.connect();
  try {
    await client.query("BEGIN");
    await client.query(`CREATE TEMP TABLE post_class_payout_run_lines (id text, tutor_submitted_at timestamptz, amount_minor integer);
      CREATE TEMP TABLE post_class_payout_tutor_names (id text, updated_at timestamptz);
      INSERT INTO post_class_payout_run_lines VALUES ('old', '2026-09-26T06:08:16Z', -10000);
      INSERT INTO post_class_payout_tutor_names VALUES ('pakgad', '2026-07-30T01:37:55.788Z');`);
    await client.query(readFileSync("drizzle/0099_staff_feedback_timing.sql", "utf8"));
    const old = (await client.query("SELECT * FROM pg_temp.post_class_payout_run_lines")).rows[0];
    expect(old).toMatchObject({ submission_evidence_version: 1, amount_minor: -10000 });
    await client.query("INSERT INTO pg_temp.post_class_payout_run_lines (id) VALUES ('new')");
    expect((await client.query("SELECT submission_evidence_version FROM pg_temp.post_class_payout_run_lines WHERE id='new'")).rows[0].submission_evidence_version).toBe(2);
    const mapping = (await client.query("SELECT * FROM pg_temp.post_class_payout_tutor_names")).rows[0];
    expect(mapping.identity_changed_at).toEqual(mapping.updated_at);
  } finally { await client.query("ROLLBACK"); client.release(); }
});
