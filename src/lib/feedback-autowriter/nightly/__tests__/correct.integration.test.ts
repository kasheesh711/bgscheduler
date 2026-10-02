import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { eq, sql } from "drizzle-orm";
import type { Database } from "@/lib/db";
import * as schema from "@/lib/db/schema";
import { calculateFeedbackDeadline } from "@/lib/post-class-feedback/policy";
import { DEFAULT_FEEDBACK_FIELD_MAPPINGS } from "@/lib/post-class-feedback/wise";
import { startTestDb, stopTestDb } from "@/tests/integration/db-helper";
import { API_ACTOR, BASE, CORRECTED, STANDARD_ORDER } from "../../__tests__/correction-fixtures";
import { CLASS_ID, SESSION_ID, SUBMISSION_ID } from "../../__tests__/fixtures";
import { AGENT_CORRECTION_ACTOR, agentCorrectionDedupeKey, type CorrectionPlan } from "../../correction";
import { pgCorrectionStore, releaseStaleCorrectionLock } from "../../correction-store";
import { snapshotFirstShots } from "../../review-job";
import { KEVIN_ONLINE_WISE_USER_ID } from "../../roster";
import { buildFeedbackPostBody } from "../../session";
import { haltAutowriter } from "../../store";
import { feedbackBodyHash, fieldsHash } from "../../submit";
import type { BillingPlan } from "../../types";
import { loadCorrectionRows, loadDisabledTutors, planFromRows, preflightCorrections, unsettledCorrections } from "../correct-step";
import { applyAgentFlags, correctionFlagItem } from "../flags";
import { correctionProposal } from "./nightly-fixtures";

/**
 * The nightly correction's own SQL against a real Postgres (all migrations applied): the plan's rows, the switches,
 * what a run left unsettled (the dry run of `recover`), and the agent flag after a correction. Synthetic ids and
 * invented lesson text only.
 */

let handle: Awaited<ReturnType<typeof startTestDb>>;
let db: Database;

const S = schema.feedbackAutowriterSessions;
const P = schema.feedbackAutowriterPosts;
const FL = schema.feedbackAutowriterFlags;
const C = schema.feedbackAutowriterControl;

const TEACHER = KEVIN_ONLINE_WISE_USER_ID;
const BILLING: BillingPlan = { sessionStatus: "COMPLETED", creditsConsumed: 1, source: "auto_blank_reuse", expectedConsumedDelta: 0 };
const id24 = (n: number) => `6a${String(n).padStart(22, "0")}`;
const noSleep = async () => {};

/** A class the autowriter posted and verified (its body_hash pins `BASE`), with its first shot snapshotted. */
async function posted(): Promise<{ postStartedAt: Date }> {
  const endAt = new Date(Date.now() - 2 * 60 * 60 * 1000);
  const postStartedAt = new Date(endAt.getTime() + 40 * 60 * 1000);
  await db.insert(S).values({
    wiseSessionId: SESSION_ID, wiseClassId: CLASS_ID, wiseTeacherUserId: TEACHER, scheduledEndAt: endAt,
    deadlineAt: calculateFeedbackDeadline(endAt), state: "verified", reason: "verified", arm: "sol", fields: BASE,
    fieldsSha256: fieldsHash(BASE), billing: BILLING as unknown as Record<string, unknown>,
    bodyHash: feedbackBodyHash(buildFeedbackPostBody({ fieldOrder: STANDARD_ORDER }, BASE, BILLING)), postStartedAt,
    verifiedEvent: { at: new Date(postStartedAt.getTime() + 90).toISOString(), actorId: API_ACTOR, actorRole: "OWNER", autoSubmitted: false },
    metadata: { expected: { kind: "auto_blank", submissionId: SUBMISSION_ID } },
  });
  expect((await snapshotFirstShots(db)).unverified).toEqual([]);
  return { postStartedAt };
}

function plan(postStartedAt: Date): CorrectionPlan {
  return {
    wiseSessionId: SESSION_ID, wiseClassId: CLASS_ID, wiseTeacherUserId: TEACHER,
    base: { fields: BASE, fieldsSha256: fieldsHash(BASE), submissionId: SUBMISSION_ID, billing: BILLING, firstShotPostedAt: postStartedAt },
    fields: CORRECTED, fieldsSha256: fieldsHash(CORRECTED), reason: "M06 overstated_judgement (major): synthetic", rootCauseRef: "fix/synthetic",
    pipeline: {}, evidence: "transcript", arm: "sol", mappings: DEFAULT_FEEDBACK_FIELD_MAPPINGS,
  };
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
    feedback_autowriter_control_history RESTART IDENTITY CASCADE`);
  await db.execute(sql`UPDATE feedback_autowriter_control SET mode = 'live', halted_at = NULL, halt_reason = NULL,
    disabled_tutors = '[]'::jsonb, lease_token = NULL, lease_until = NULL`);
});

describe("the plan's rows (Postgres, SELECT only)", () => {
  it("builds the executor's plan from the session row and the review job's first-shot row", async () => {
    const { postStartedAt } = await posted();
    const rows = await loadCorrectionRows(db, SESSION_ID);
    const proposal = correctionProposal({ wiseSessionId: SESSION_ID, fieldsSha256: fieldsHash(BASE), fields: CORRECTED, fieldsHash: fieldsHash(CORRECTED) });
    const planned = planFromRows(proposal, rows, DEFAULT_FEEDBACK_FIELD_MAPPINGS);
    expect(planned.ok).toBe(true);
    if (!planned.ok) return;
    expect(planned.plan).toMatchObject({
      wiseClassId: CLASS_ID, wiseTeacherUserId: TEACHER,
      base: { fields: BASE, fieldsSha256: fieldsHash(BASE), submissionId: SUBMISSION_ID, billing: BILLING, firstShotPostedAt: postStartedAt },
    });
    // The store's own preconditions accept the plan as built (reads only).
    expect(await pgCorrectionStore(db, { actor: AGENT_CORRECTION_ACTOR }).preconditions(planned.plan, new Date())).toEqual([]);
    expect(await loadCorrectionRows(db, id24(77))).toEqual({ session: null, firstShot: null });
  });

  it("reads the tutors switched off without writing the control row", async () => {
    await db.update(C).set({ disabledTutors: [id24(5)] }).where(eq(C.id, "default"));
    expect(await loadDisabledTutors(db)).toEqual([id24(5)]);
  });
});

describe("unsettledCorrections (the dry run of recover)", () => {
  it("is empty when nothing was left", async () => {
    expect(await unsettledCorrections(db)).toEqual({ rows: [], lock: null, releasable: false });
  });

  it("lists agent corrections still posting or awaiting their event, stale after the recovery threshold", async () => {
    for (const [n, outcome, ageMs] of [[1, "posting", 0], [2, "awaiting_event", 30 * 60_000], [3, "verified", 30 * 60_000]] as const) {
      await db.insert(P).values({
        wiseSessionId: id24(n), kind: "correction", fields: BASE, fieldsSha256: fieldsHash(BASE), billing: BILLING as unknown as Record<string, unknown>,
        actorKind: "agent", actor: AGENT_CORRECTION_ACTOR, reason: "synthetic", outcome, provenance: "live",
        postStartedAt: new Date(Date.now() - ageMs), dedupeKey: agentCorrectionDedupeKey(id24(n)),
      });
    }
    const state = await unsettledCorrections(db);
    expect(state.rows.map((row) => `${row.wiseSessionId}:${row.outcome}:${row.stale}`).toSorted()).toEqual([
      `${id24(1)}:posting:false`, `${id24(2)}:awaiting_event:true`,
    ]);
    expect(preflightCorrections(state)).toEqual({ unsettled: 2, lock: null });
  });

  it("tells a live lock from a stale one and from a halt added on top, as releaseStaleCorrectionLock does", async () => {
    const { postStartedAt } = await posted();
    const locked = await pgCorrectionStore(db, { actor: AGENT_CORRECTION_ACTOR, sleep: noSleep }).lock(plan(postStartedAt));
    expect(locked.ok).toBe(true);
    expect(await unsettledCorrections(db)).toMatchObject({ lock: { state: "live", wiseSessionId: SESSION_ID }, releasable: false });

    // The run died: its lease ran out with the lock still on the control row.
    await db.update(C).set({ leaseUntil: sql`now() - interval '1 minute'` }).where(eq(C.id, "default"));
    const stale = await unsettledCorrections(db);
    expect(stale).toMatchObject({ lock: { state: "stale", wiseSessionId: SESSION_ID }, releasable: true });
    expect(preflightCorrections(stale)).toEqual({ unsettled: 0, lock: "stale" });

    // A person (or an anomaly) halted on top: only a person resumes it.
    await haltAutowriter(db, "owner pause for review", "owner@example.com");
    expect(await unsettledCorrections(db)).toMatchObject({ lock: { state: "halted_on_top" }, releasable: false });
    expect(await releaseStaleCorrectionLock(db)).toBe(false);

    // Back to the stale lock alone: the dry run and the real release agree.
    const [{ reason }] = await db.select({ reason: C.haltReason }).from(C).where(eq(C.id, "default"));
    await db.update(C).set({ haltReason: reason!.split(" | then: ")[0] }).where(eq(C.id, "default"));
    expect((await unsettledCorrections(db)).releasable).toBe(true);
    expect(await releaseStaleCorrectionLock(db)).toBe(true);
    expect(await unsettledCorrections(db)).toEqual({ rows: [], lock: null, releasable: false });
  });
});

describe("the agent flag after a correction", () => {
  it("is raised once per class, with mode codes only, and puts the class back in the review list", async () => {
    await posted();
    const item = correctionFlagItem({ wiseSessionId: SESSION_ID, fieldsSha256: fieldsHash(CORRECTED), modes: ["M06"], severity: "major", criticalCategory: null });
    expect(await applyAgentFlags(db, [item])).toEqual({ inserted: 1, existing: 0, incidents: 0 });
    expect(await applyAgentFlags(db, [item])).toEqual({ inserted: 0, existing: 1, incidents: 0 });
    const flags = await db.select().from(FL).where(eq(FL.wiseSessionId, SESSION_ID));
    expect(flags).toHaveLength(1);
    expect(flags[0]).toMatchObject({
      source: "agent", idempotencyKey: `agent-correction:${SESSION_ID}`, note: "corrected by the nightly agent: M06",
      suggestedSeverity: "factual", createdBy: "agent:nightly-audit", resolvedByVerdictId: null,
    });
  });
});
