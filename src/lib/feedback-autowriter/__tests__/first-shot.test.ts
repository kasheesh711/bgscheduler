import { describe, expect, it } from "vitest";
import type { FeedbackFieldAnswers } from "@/lib/post-class-feedback/types";
import { NICKNAME_FIX_ACTOR, NICKNAME_FIX_REASON, planReviewBackfill } from "../backfill";
import { FORM_FIELD_ORDERS, proveFirstShot, reverseRenameVariants } from "../first-shot";
import { buildFeedbackPostBody } from "../session";
import type { AutowriterSessionRow } from "../store";
import { feedbackBodyHash, fieldsHash } from "../submit";

const BILLING = { sessionStatus: "COMPLETED", creditsConsumed: 1 };

const ORIGINAL: FeedbackFieldAnswers = {
  topics: "Vocabulary building: synonyms and word classes.",
  performance: "Worawut matched most words quickly; Worawut hesitated on adverbs.",
  improvement: "Worawut should review adverbs of frequency.",
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
    wiseSessionId: "6aba30a97d4c21cce9b574d1",
    wiseClassId: "698ec3c7444ac4ea909bbb02",
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
    // The first shot already said "Bas" once; the rename then turned every "Worawut" into "Bas".
    const original = { ...ORIGINAL, homework: "Bas: finish worksheet 4." };
    const current = renamed(original, "Worawut", "Bas");
    const variants = reverseRenameVariants(current, { from: "Worawut", to: "Bas" });
    expect(variants).toHaveLength(2 ** 4 - 1);
    // Reversing every "Bas" is wrong here (the homework one was original); the proof finds the right subset.
    const proof = proveFirstShot({
      bodyHash: hashFor(original),
      billing: BILLING,
      candidates: variants.map((fields) => ({ method: "reverse_rename" as const, fields })),
    });
    expect(proof?.fields).toEqual(original);
  });

  it("leaves words that merely contain the nickname alone", () => {
    const variants = reverseRenameVariants({ topics: "Basic Bas", performance: "", improvement: "", homework: "" }, { from: "Worawut", to: "Bas" });
    expect(variants).toEqual([{ topics: "Basic Worawut", performance: "", improvement: "", homework: "" }]);
  });
});

describe("planReviewBackfill", () => {
  const fixAt = "2026-09-29T13:25:26.402Z";

  it("records the unchanged first shot of a row nobody edited", () => {
    const plan = planReviewBackfill([{ row: row({}), pcFirstVersion: null, hasFirstShot: false, hasNicknameCorrection: false }]);
    expect(plan.firstShots).toHaveLength(1);
    expect(plan.firstShots[0].method).toBe("unchanged");
    expect(plan.firstShots[0].values).toMatchObject({
      kind: "first_shot", provenance: "backfill", outcome: "verified", fieldsSha256: fieldsHash(ORIGINAL),
      pipeline: { promptVersion: 7, postedFromCommit: "abc123" },
    });
    expect(plan.corrections).toEqual([]);
  });

  it("proves a renamed row from Class Feedback's first version, and records the rename as a correction", () => {
    const current = renamed(ORIGINAL, "Worawut", "Bas");
    const plan = planReviewBackfill([{
      row: row({ fields: current, fieldsSha256: fieldsHash(current), metadata: { nicknameFix: { from: "Worawut", to: "Bas", at: fixAt, by: "kevhsh7@gmail.com (one-time fix)" } } }),
      pcFirstVersion: { id: "v1", observedAt: new Date("2026-09-29T13:43:37Z"), fields: ORIGINAL },
      hasFirstShot: false,
      hasNicknameCorrection: false,
    }]);
    expect(plan.firstShots[0]).toMatchObject({ method: "pc_first_version" });
    expect(plan.firstShots[0].values.fields).toEqual(ORIGINAL);
    expect(plan.corrections[0].values).toMatchObject({
      kind: "correction", actorKind: "script", actor: NICKNAME_FIX_ACTOR, reason: NICKNAME_FIX_REASON,
      postFinishedAt: new Date(fixAt), outcome: "verified", fields: current, fieldsSha256: fieldsHash(current), bodyHash: null,
    });
  });

  it("falls back to the reverse rename when Class Feedback only saw the renamed text (Gift's class)", () => {
    const current = renamed(ORIGINAL, "Worawut", "Bas");
    const plan = planReviewBackfill([{
      row: row({ fields: current, metadata: { nicknameFix: { from: "Worawut", to: "Bas", at: fixAt } } }),
      pcFirstVersion: { id: "v2", observedAt: new Date("2026-09-29T13:43:37Z"), fields: current },
      hasFirstShot: false,
      hasNicknameCorrection: false,
    }]);
    expect(plan.firstShots[0].method).toBe("reverse_rename");
    expect(plan.firstShots[0].values.fields).toEqual(ORIGINAL);
  });

  it("reports a row it cannot prove, and never re-plans what is already recorded", () => {
    const plan = planReviewBackfill([
      { row: row({ wiseSessionId: "a".repeat(24), fields: { ...ORIGINAL, topics: "edited by hand" } }), pcFirstVersion: null, hasFirstShot: false, hasNicknameCorrection: false },
      { row: row({ wiseSessionId: "b".repeat(24), metadata: { nicknameFix: { from: "X", to: "Y", at: fixAt } } }), pcFirstVersion: null, hasFirstShot: true, hasNicknameCorrection: true },
    ]);
    expect(plan.unverified).toEqual([{ wiseSessionId: "a".repeat(24), reason: "no candidate hashes to body_hash", candidates: 1 }]);
    expect(plan.alreadyRecorded).toEqual(["b".repeat(24)]);
    expect(plan.corrections).toEqual([]);
  });
});
