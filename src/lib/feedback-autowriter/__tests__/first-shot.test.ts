import { describe, expect, it } from "vitest";
import type { FeedbackFieldAnswers } from "@/lib/post-class-feedback/types";
import ownerVerdictsJson from "../../../../scripts/feedback-autowriter-owner-verdicts.json";
import {
  NICKNAME_FIX_ACTOR,
  NICKNAME_FIX_REASON,
  ONE_TIME_CORRECTION_ACTOR,
  isRecordedDecision,
  parseOwnerVerdicts,
  planOwnerVerdicts,
  planReviewBackfill,
  type BackfillSessionInput,
} from "../backfill";
import {
  FORM_FIELD_ORDERS,
  landedProblemCategory,
  postMayHaveLanded,
  proveFirstShot,
  readOneTimeCorrections,
  reverseRenameVariants,
} from "../first-shot";
import { buildFeedbackPostBody } from "../session";
import type { AutowriterSessionRow } from "../store";
import { feedbackBodyHash, fieldsHash } from "../submit";

const BILLING = { sessionStatus: "COMPLETED", creditsConsumed: 1 };

const ORIGINAL: FeedbackFieldAnswers = {
  topics: "Vocabulary building: synonyms and word classes.",
  performance: "Alexander matched most words quickly; Alexander hesitated on adverbs.",
  improvement: "Alexander should review adverbs of frequency.",
  homework: "",
};

function hashFor(fields: FeedbackFieldAnswers, order = ["performance", "topics", "improvement", "homework"] as const) {
  return feedbackBodyHash(buildFeedbackPostBody({ fieldOrder: [...order] }, fields, BILLING));
}

function renamed(fields: FeedbackFieldAnswers, from: string, to: string): FeedbackFieldAnswers {
  const pattern = new RegExp(`(?<!\\p{L})${from}(?!\\p{L})`, "gu");
  return Object.fromEntries(Object.entries(fields).map(([key, value]) => [key, value.replace(pattern, to)])) as FeedbackFieldAnswers;
}

function row(overrides: Partial<AutowriterSessionRow>): AutowriterSessionRow {
  return {
    id: "00000000-0000-4000-8000-000000000001",
    wiseSessionId: "6a0000000000000000000b01",
    wiseClassId: "690000000000000000000b02",
    wiseTeacherUserId: "695369c028118f629edcb9cb",
    scheduledEndAt: new Date("2026-09-29T12:30:00Z"),
    deadlineAt: new Date("2026-09-30T16:59:59Z"),
    state: "verified",
    evidence: "summary",
    sonioxTranscriptionId: null,
    reason: "verified",
    attempts: 1,
    retryCount: 0,
    nextAttemptAt: null,
    leaseToken: null,
    leaseUntil: null,
    arm: "glm",
    fields: ORIGINAL,
    fieldsSha256: fieldsHash(ORIGINAL),
    billing: { ...BILLING, source: "auto_blank_reuse", expectedConsumedDelta: 0 },
    bodyHash: hashFor(ORIGINAL),
    postStartedAt: new Date("2026-09-29T13:11:25.990Z"),
    verifiedEvent: { at: "2026-09-29T13:11:26.074Z", actorId: "69366668c05630afe5d8a2a4" },
    alertsSent: {},
    lastTrigger: "cron",
    metadata: { pipeline: { promptVersion: 7 }, postedFromCommit: "abc123", expected: { kind: "auto_blank", submissionId: "sub-1" } },
    createdAt: new Date("2026-09-29T12:31:00Z"),
    updatedAt: new Date("2026-09-29T13:25:26Z"),
    ...overrides,
  };
}

describe("first-shot proof", () => {
  it("tries every ordered subset of the four fields as the form order", () => {
    expect(FORM_FIELD_ORDERS).toHaveLength(64);
    expect(FORM_FIELD_ORDERS[0]).toHaveLength(4);
  });

  it("proves the stored text in whatever order the form had", () => {
    const proof = proveFirstShot({ bodyHash: hashFor(ORIGINAL), billing: BILLING, candidates: [{ method: "unchanged", fields: ORIGINAL }] });
    expect(proof).toMatchObject({ method: "unchanged", fieldOrder: ["performance", "topics", "improvement", "homework"] });
  });

  it("accepts nothing that does not hash exactly — not even a whitespace change or other billing", () => {
    const nearly = { ...ORIGINAL, topics: `${ORIGINAL.topics} ` };
    expect(proveFirstShot({ bodyHash: hashFor(ORIGINAL), billing: BILLING, candidates: [{ method: "unchanged", fields: nearly }] })).toBeNull();
    expect(proveFirstShot({
      bodyHash: hashFor(ORIGINAL), billing: { ...BILLING, creditsConsumed: 2 }, candidates: [{ method: "unchanged", fields: ORIGINAL }],
    })).toBeNull();
  });

  it("undoes a nickname rename even when the original already used the nickname somewhere", () => {
    // The first shot already said "Alex" once; the rename then turned every "Alexander" into "Alex".
    const original = { ...ORIGINAL, homework: "Alex: finish worksheet 4." };
    const current = renamed(original, "Alexander", "Alex");
    const variants = reverseRenameVariants(current, { from: "Alexander", to: "Alex" });
    expect(variants).toHaveLength(2 ** 4 - 1);
    // Reversing every "Alex" is wrong here (the homework one was original); the proof finds the right subset.
    const proof = proveFirstShot({
      bodyHash: hashFor(original),
      billing: BILLING,
      candidates: variants.map((fields) => ({ method: "reverse_rename" as const, fields })),
    });
    expect(proof?.fields).toEqual(original);
  });

  it("leaves words that merely contain the nickname alone", () => {
    const variants = reverseRenameVariants({ topics: "Alexis Alex", performance: "", improvement: "", homework: "" }, { from: "Alexander", to: "Alex" });
    expect(variants).toEqual([{ topics: "Alexis Alexander", performance: "", improvement: "", homework: "" }]);
  });
});

describe("planReviewBackfill", () => {
  const fixAt = "2026-09-29T13:25:26.402Z";
  const none: ReadonlySet<string> = new Set();

  it("records the unchanged first shot of a row nobody edited", () => {
    const plan = planReviewBackfill([{ row: row({}), pcFirstVersion: null, hasFirstShot: false, recordedDedupeKeys: none }]);
    expect(plan.firstShots).toHaveLength(1);
    expect(plan.firstShots[0].method).toBe("unchanged");
    expect(plan.firstShots[0].values).toMatchObject({
      kind: "first_shot", provenance: "backfill", outcome: "verified", fieldsSha256: fieldsHash(ORIGINAL),
      pipeline: { promptVersion: 7, postedFromCommit: "abc123" },
    });
    expect(plan.corrections).toEqual([]);
  });

  it("proves a renamed row from Class Feedback's first version, and records the rename as a policy re-post (never a fix)", () => {
    const current = renamed(ORIGINAL, "Alexander", "Alex");
    const plan = planReviewBackfill([{
      row: row({ fields: current, fieldsSha256: fieldsHash(current), metadata: { nicknameFix: { from: "Alexander", to: "Alex", at: fixAt, by: "owner@example.com (one-time fix)" } } }),
      pcFirstVersion: { id: "v1", observedAt: new Date("2026-09-29T13:43:37Z"), fields: ORIGINAL },
      hasFirstShot: false,
      recordedDedupeKeys: none,
    }]);
    expect(plan.firstShots[0]).toMatchObject({ method: "pc_first_version" });
    expect(plan.firstShots[0].values.fields).toEqual(ORIGINAL);
    expect(plan.corrections[0]).toMatchObject({ source: "nicknameFix", kind: "policy", dedupeKey: `nickname-fix:${"6a0000000000000000000b01"}` });
    expect(plan.corrections[0].values).toMatchObject({
      kind: "policy", actorKind: "script", actor: NICKNAME_FIX_ACTOR, reason: NICKNAME_FIX_REASON, provenance: "backfill",
      postFinishedAt: new Date(fixAt), outcome: "verified", fields: current, fieldsSha256: fieldsHash(current), bodyHash: null,
    });
  });

  it("falls back to the reverse rename when Class Feedback only saw the renamed text (a class Class Feedback first read after the rename)", () => {
    const current = renamed(ORIGINAL, "Alexander", "Alex");
    const plan = planReviewBackfill([{
      row: row({ fields: current, metadata: { nicknameFix: { from: "Alexander", to: "Alex", at: fixAt } } }),
      pcFirstVersion: { id: "v2", observedAt: new Date("2026-09-29T13:43:37Z"), fields: current },
      hasFirstShot: false,
      recordedDedupeKeys: none,
    }]);
    expect(plan.firstShots[0].method).toBe("reverse_rename");
    expect(plan.firstShots[0].values.fields).toEqual(ORIGINAL);
  });

  it("reports a row it cannot prove, and never re-plans what is already recorded", () => {
    const plan = planReviewBackfill([
      { row: row({ wiseSessionId: "a".repeat(24), fields: { ...ORIGINAL, topics: "edited by hand" } }), pcFirstVersion: null, hasFirstShot: false, recordedDedupeKeys: none },
      { row: row({ wiseSessionId: "b".repeat(24), metadata: { nicknameFix: { from: "X", to: "Y", at: fixAt } } }), pcFirstVersion: null, hasFirstShot: true, recordedDedupeKeys: new Set([`nickname-fix:${"b".repeat(24)}`]) },
    ]);
    expect(plan.unverified).toEqual([{ wiseSessionId: "a".repeat(24), reason: "no candidate hashes to body_hash", candidates: 1, landedUnverified: false }]);
    expect(plan.alreadyRecorded).toEqual(["b".repeat(24)]);
    expect(plan.corrections).toEqual([]);
  });

  // As `.feedback-autowriter/correct-posts.ts` records an owner-approved correction (synthetic ids and text).
  function correctedInput(overrides: Partial<BackfillSessionInput> = {}): BackfillSessionInput {
    const corrected = { ...ORIGINAL, homework: "", improvement: "Adverbs of frequency." };
    return {
      row: row({
        wiseSessionId: "6a0000000000000000000c01",
        fields: corrected,
        fieldsSha256: fieldsHash(corrected),
        metadata: {
          corrections: [{
            fields: ["improvement"], reason: "synthetic: the summary invented a task", fromSha256: fieldsHash(ORIGINAL),
            toSha256: fieldsHash(corrected), at: "2026-09-29T18:07:12.757Z", by: "owner@example.com (one-time correction, owner-approved)",
          }],
        },
      }),
      pcFirstVersion: { id: "v3", observedAt: new Date("2026-09-29T14:30:00Z"), fields: ORIGINAL },
      hasFirstShot: false,
      recordedDedupeKeys: none,
      ...overrides,
    };
  }

  it("records each metadata.corrections entry as a one-time correction post (a fix), keyed like the nickname fix", () => {
    const plan = planReviewBackfill([correctedInput()]);
    expect(plan.firstShots[0]).toMatchObject({ method: "pc_first_version" });
    expect(plan.firstShots[0].values.fields).toEqual(ORIGINAL);
    expect(plan.corrections).toHaveLength(1);
    expect(plan.corrections[0]).toMatchObject({ source: "corrections", kind: "correction", dedupeKey: "correction:6a0000000000000000000c01:2026-09-29T18:07:12.757Z" });
    expect(plan.corrections[0].values).toMatchObject({
      kind: "correction", actorKind: "script", actor: ONE_TIME_CORRECTION_ACTOR, provenance: "backfill", outcome: "verified",
      postStartedAt: null, postFinishedAt: new Date("2026-09-29T18:07:12.757Z"), bodyHash: null,
      reason: "synthetic: the summary invented a task", dedupeKey: "correction:6a0000000000000000000c01:2026-09-29T18:07:12.757Z",
      verification: { fields: ["improvement"], fromSha256: fieldsHash(ORIGINAL) },
    });
    // The text is the one the correction put in Wise, proven by its hash.
    expect(plan.corrections[0].values.fieldsSha256).toBe(fieldsHash(correctedInput().row.fields as never));
    // Recorded once: a second run with the key recorded plans nothing.
    const again = planReviewBackfill([correctedInput({ hasFirstShot: true, recordedDedupeKeys: new Set([plan.corrections[0].dedupeKey]) })]);
    expect(again.corrections).toEqual([]);
  });

  it("does not record a re-post whose text no stored text proves", () => {
    const input = correctedInput();
    const metadata = input.row.metadata as { corrections: Array<Record<string, unknown>> };
    const plan = planReviewBackfill([{ ...input, row: { ...input.row, metadata: { corrections: [{ ...metadata.corrections[0], toSha256: "f".repeat(64) }] } } }]);
    expect(plan.corrections).toEqual([]);
    expect(plan.unprovenCorrections).toEqual([{
      wiseSessionId: "6a0000000000000000000c01", dedupeKey: "correction:6a0000000000000000000c01:2026-09-29T18:07:12.757Z",
      reason: "no stored text has the re-post's hash",
    }]);
  });

  it("finds a nickname fix's text by the next correction's fromSha256 when both happened", () => {
    const renamedText = renamed(ORIGINAL, "Alexander", "Alex");
    const corrected = { ...renamedText, homework: "" , improvement: "Alex should review adverbs." };
    const plan = planReviewBackfill([{
      row: row({
        wiseSessionId: "6a0000000000000000000d01",
        fields: corrected,
        metadata: {
          nicknameFix: { from: "Alexander", to: "Alex", at: fixAt, by: "owner@example.com (one-time fix)" },
          corrections: [{ fields: ["improvement"], reason: "r", fromSha256: fieldsHash(renamedText), toSha256: fieldsHash(corrected), at: "2026-09-29T18:00:00Z", by: "o" }],
        },
      }),
      pcFirstVersion: { id: "v4", observedAt: new Date("2026-09-29T13:00:00Z"), fields: ORIGINAL },
      pcVersions: [
        { id: "v4", observedAt: new Date("2026-09-29T13:00:00Z"), fields: ORIGINAL },
        { id: "v5", observedAt: new Date("2026-09-29T14:00:00Z"), fields: renamedText },
      ],
      hasFirstShot: false,
      recordedDedupeKeys: none,
    }]);
    expect(plan.corrections.map((entry) => [entry.source, entry.values.kind, entry.values.fieldsSha256])).toEqual([
      ["nicknameFix", "policy", fieldsHash(renamedText)],
      ["corrections", "correction", fieldsHash(corrected)],
    ]);
  });
});

describe("one-time re-posts and landed posts", () => {
  it("reads nickname fixes and corrections from the row, oldest first, ignoring malformed entries", () => {
    const corrections = readOneTimeCorrections("s1", {
      corrections: [
        { fields: ["homework"], toSha256: "b".repeat(64), fromSha256: "a".repeat(64), at: "2026-09-29T18:07:04.491Z", by: "o", reason: "r" },
        { toSha256: "c".repeat(64), at: "not a date" },
        { at: "2026-09-29T18:07:05Z" },
      ],
      nicknameFix: { from: "Alexander", to: "Alex", at: "2026-09-29T13:25:26.402Z", by: "o" },
    });
    expect(corrections.map((entry) => [entry.source, entry.kind, entry.dedupeKey])).toEqual([
      ["nicknameFix", "policy", "nickname-fix:s1"],
      ["corrections", "correction", "correction:s1:2026-09-29T18:07:04.491Z"],
    ]);
    expect(readOneTimeCorrections("s1", null)).toEqual([]);
  });

  it("says which first shots may be in Wise, and which critical category their read-back suggests", () => {
    expect(postMayHaveLanded("verified", {})).toBe(true);
    expect(postMayHaveLanded("verify_failed", {})).toBe(true);
    expect(postMayHaveLanded("unknown_outcome", {})).toBe(true);
    expect(postMayHaveLanded("rejected", { stillAutoBlank: true })).toBe(false);
    expect(postMayHaveLanded("rejected", { stillAutoBlank: false })).toBe(true);
    expect(postMayHaveLanded("not_sent", {})).toBe(false);
    expect(landedProblemCategory(["field_mismatch:topics", "session_credit_entries_2"])).toBe("billing_status");
    expect(landedProblemCategory(["status_CANCELLED"])).toBe("billing_status");
    expect(landedProblemCategory(["foreign_submit_event_in_post_window"])).toBe("should_not_have_posted");
    expect(landedProblemCategory(["field_mismatch:topics"])).toBeNull();
  });
});

describe("owner verdicts given outside the dashboard", () => {
  const file = (overrides: Record<string, unknown> = {}, verdicts?: unknown[]) => ({
    decidedAt: "2026-09-30T09:30:00+07:00",
    reviewer: "owner@example.com (owner interview 2026-09-30)",
    verdicts: verdicts ?? [
      { wiseSessionId: "6a0000000000000000000e01", verdict: "needs_fix", severity: "critical", criticalCategory: "wrong_person", note: "synthetic: another student's work" },
      { wiseSessionId: "6a0000000000000000000e02", verdict: "needs_fix", severity: "factual", criticalCategory: null, note: "synthetic: false homework claim" },
    ],
    ...overrides,
  });

  it("reads the committed decisions of the 30 Sep interview: session ids and the owner's words only", () => {
    const decisions = parseOwnerVerdicts(ownerVerdictsJson);
    expect(decisions.decidedAt.toISOString()).toBe("2026-09-30T02:30:00.000Z");
    expect(decisions.reviewer).toBe("kevhsh7@gmail.com (owner interview 2026-09-30)");
    expect(decisions.verdicts.map((entry) => [entry.wiseSessionId, entry.verdict, entry.severity, entry.criticalCategory])).toEqual([
      ["699477ceb50e50f4cc219904", "needs_fix", "critical", "wrong_person"],
      ["6ab89191c10615490d43a8cf", "needs_fix", "factual", null],
    ]);
    expect(decisions.verdicts.every((entry) => entry.note.endsWith("— owner, 30 Sep interview"))).toBe(true);
  });

  it("refuses a file a dashboard verdict could not be: wrong shape, severity without category, a class decided twice", () => {
    expect(() => parseOwnerVerdicts(file())).not.toThrow();
    expect(() => parseOwnerVerdicts(file({ decidedAt: "30 Sep" }))).toThrow(/invalid/u);
    expect(() => parseOwnerVerdicts(file({ extra: 1 }))).toThrow(/invalid/u);
    expect(() => parseOwnerVerdicts(file({}, [{ wiseSessionId: "../x", verdict: "approve", severity: null, criticalCategory: null, note: "n" }]))).toThrow(/invalid/u);
    expect(() => parseOwnerVerdicts(file({}, [{ wiseSessionId: "6a0000000000000000000e01", verdict: "needs_fix", severity: "critical", criticalCategory: null, note: "n" }])))
      .toThrow(/requires a category/u);
    expect(() => parseOwnerVerdicts(file({}, [{ wiseSessionId: "6a0000000000000000000e01", verdict: "needs_fix", severity: "factual", criticalCategory: null, note: " " }])))
      .toThrow(/invalid/u);
    const twice = { wiseSessionId: "6a0000000000000000000e01", verdict: "approve", severity: null, criticalCategory: null, note: "n" };
    expect(() => parseOwnerVerdicts(file({}, [twice, twice]))).toThrow(/twice/u);
  });

  it("pins each decision to the class's first shot and says what the write will do", () => {
    const decisions = parseOwnerVerdicts(file());
    const [critical, major] = decisions.verdicts;
    const sha = "c".repeat(64);
    const plan = planOwnerVerdicts(decisions, { firstShots: new Map([[critical.wiseSessionId, sha]]) });
    expect(plan.map((entry) => [entry.wiseSessionId, entry.fieldsSha256, entry.status, entry.reviewer])).toEqual([
      [critical.wiseSessionId, sha, "planned", decisions.reviewer],
      [major.wiseSessionId, null, "no_first_shot", decisions.reviewer],
    ]);
    const recorded = { reviewer: decisions.reviewer, verdict: critical.verdict, severity: critical.severity, criticalCategory: critical.criticalCategory, note: critical.note, fieldsSha256: sha };
    expect(planOwnerVerdicts(decisions, { firstShots: new Map([[critical.wiseSessionId, sha]]), currentVerdicts: new Map([[critical.wiseSessionId, recorded]]) })[0].status)
      .toBe("already_recorded");
    // Anyone else's verdict, or this one pinned to another text, is not this decision.
    expect(isRecordedDecision({ ...recorded, reviewer: "owner@example.com" }, critical, decisions.reviewer, sha)).toBe(false);
    expect(isRecordedDecision(recorded, critical, decisions.reviewer, "d".repeat(64))).toBe(false);
    expect(planOwnerVerdicts(decisions, {
      firstShots: new Map([[critical.wiseSessionId, sha]]),
      currentVerdicts: new Map([[critical.wiseSessionId, { ...recorded, reviewer: "owner@example.com", severity: "factual", criticalCategory: null }]]),
    })[0].status).toBe("other_verdict");
  });
});
