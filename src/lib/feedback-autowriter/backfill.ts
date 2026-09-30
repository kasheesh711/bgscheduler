import { and, eq, isNull } from "drizzle-orm";
import { z } from "zod";
import type { Database } from "@/lib/db";
import * as schema from "@/lib/db/schema";
import type { AutowriterCriticalCategory, AutowriterVerdictSeverity } from "@/lib/db/schema";
import { withDatabaseTransaction } from "@/lib/db/transaction";
import type { FeedbackFieldAnswers } from "@/lib/post-class-feedback/types";
import { AutowriterReviewError } from "./api";
import {
  normalizeFields,
  postMayHaveLanded,
  postedBilling,
  proveFirstShot,
  readOneTimeCorrections,
  reverseRenameVariants,
  type FirstShotCandidate,
  type FirstShotMethod,
  type OneTimeCorrection,
} from "./first-shot";
import { recordIncident } from "./incidents";
import { firstShotPostValues } from "./review-job";
import type { AutowriterSessionRow } from "./store";
import { fieldsHash } from "./submit";
import { recordVerdict, verdictShapeProblem } from "./verdicts";

/**
 * Day-one backfill of the review tables (pure planning plus the write; `scripts/feedback-autowriter-backfill-review.ts`
 * loads the rows). Never touches Wise.
 *
 * A first shot is accepted only when its rebuilt POST body hashes to the row's `body_hash`. Candidates: the
 * stored text; for rows a one-time script rewrote, also the earliest teacher version Class Feedback stored and every
 * reverse-rename variant of both. Each one-time re-post the row records becomes a post (origin one-time, actor kind
 * `script`) carrying the text it put in Wise, found by its hash — `metadata.nicknameFix` a `policy` post (a naming rule
 * made after the post, never a fix: owner decision D-01), every entry of `metadata.corrections` a `correction` (a fix);
 * its `dedupe_key` makes the write idempotent even when two runs overlap. Verdicts the owner gave outside the
 * dashboard (`OwnerVerdicts`) are recorded through the dashboard's own path.
 */

export const NICKNAME_FIX_ACTOR = "script:nickname-fix (kevhsh7@gmail.com)";
export const NICKNAME_FIX_REASON = "owner naming policy: nickname";
export const ONE_TIME_CORRECTION_ACTOR = "script:correct-posts (kevhsh7@gmail.com)";
export const ONE_TIME_CORRECTION_REASON = "owner-approved one-time correction";

type PostInsert = typeof schema.feedbackAutowriterPosts.$inferInsert;

export interface NicknameFix {
  from: string;
  to: string;
  at: Date;
  by: string | null;
}

export function readNicknameFix(metadata: unknown): NicknameFix | null {
  const fix = readOneTimeCorrections("", metadata).find((correction) => correction.source === "nicknameFix");
  return fix?.rename ? { ...fix.rename, at: fix.at, by: fix.by } : null;
}

export interface StoredVersion {
  id: string;
  observedAt: Date;
  fields: FeedbackFieldAnswers;
}

export interface BackfillSessionInput {
  row: AutowriterSessionRow;
  /** Earliest substantive teacher version Class Feedback stored for the session. */
  pcFirstVersion: StoredVersion | null;
  /** Every substantive teacher version Class Feedback stored (a text a one-time re-post produced may be among them). */
  pcVersions?: readonly StoredVersion[];
  hasFirstShot: boolean;
  /** `dedupe_key`s of the correction posts already recorded for the session. */
  recordedDedupeKeys: ReadonlySet<string>;
}

export function firstShotCandidates(input: Pick<BackfillSessionInput, "row" | "pcFirstVersion">): FirstShotCandidate[] {
  const current = normalizeFields(input.row.fields ?? {});
  const candidates: FirstShotCandidate[] = [{ method: "unchanged", fields: current }];
  if (input.pcFirstVersion) {
    candidates.push({
      method: "pc_first_version",
      fields: input.pcFirstVersion.fields,
      source: { feedbackVersionId: input.pcFirstVersion.id, observedAt: input.pcFirstVersion.observedAt.toISOString() },
    });
  }
  const fix = readNicknameFix(input.row.metadata);
  if (fix) {
    const rename = (method: FirstShotMethod, fields: FeedbackFieldAnswers, extra: Record<string, unknown>) =>
      reverseRenameVariants(fields, fix).map((variant): FirstShotCandidate => ({ method, fields: variant, source: { ...extra, reversed: "nicknameFix" } }));
    candidates.push(...rename("reverse_rename", current, {}));
    if (input.pcFirstVersion) {
      candidates.push(...rename("pc_first_version_reverse_rename", input.pcFirstVersion.fields, { feedbackVersionId: input.pcFirstVersion.id }));
    }
  }
  return candidates;
}

export interface BackfillPlan {
  firstShots: Array<{ wiseSessionId: string; method: FirstShotMethod; fieldOrder: string[]; values: PostInsert }>;
  corrections: Array<{ wiseSessionId: string; dedupeKey: string; source: OneTimeCorrection["source"]; kind: OneTimeCorrection["kind"]; at: Date; values: PostInsert }>;
  /** Re-posts whose text could not be found by its hash: not recorded (their API saves stay unmatched). */
  unprovenCorrections: Array<{ wiseSessionId: string; dedupeKey: string; reason: string }>;
  unverified: Array<{ wiseSessionId: string; reason: string; candidates: number; landedUnverified: boolean }>;
  alreadyRecorded: string[];
}

/** The posts row for a one-time re-post (`policy` or `correction`), with the text it put in Wise. */
export function oneTimeCorrectionValues(row: AutowriterSessionRow, correction: OneTimeCorrection, fields: FeedbackFieldAnswers): PostInsert {
  const nickname = correction.source === "nicknameFix";
  return {
    wiseSessionId: row.wiseSessionId,
    wiseClassId: row.wiseClassId,
    wiseTeacherUserId: row.wiseTeacherUserId,
    kind: correction.kind,
    fields,
    fieldsSha256: fieldsHash(fields),
    // The script's POST body was not stored; only its text and its read-back are known.
    bodyHash: null,
    billing: row.billing ?? {},
    arm: null,
    evidence: null,
    pipeline: null,
    actorKind: "script",
    actor: nickname ? NICKNAME_FIX_ACTOR : ONE_TIME_CORRECTION_ACTOR,
    reason: nickname ? NICKNAME_FIX_REASON : (correction.reason?.trim().slice(0, 500) || ONE_TIME_CORRECTION_REASON),
    postStartedAt: null,
    postFinishedAt: correction.at,
    outcome: "verified",
    verification: {
      method: "one-time script read-back",
      checks: ["stored text equals the new text", "one teacher submission", "billing unchanged", "credit entries unchanged"],
      stampedBy: correction.by,
      ...(correction.fields ? { fields: correction.fields } : {}),
      ...(correction.fromSha256 ? { fromSha256: correction.fromSha256 } : {}),
      ...(correction.toSha256 ? { toSha256: correction.toSha256 } : {}),
    },
    provenance: "backfill",
    reconstruction: { source: nickname ? "metadata.nicknameFix" : "metadata.corrections", at: correction.at.toISOString() },
    dedupeKey: correction.dedupeKey,
    settledAt: correction.at,
  };
}

/**
 * The text each one-time re-post put in Wise. The last one's is the row's current text (checked against its
 * `toSha256` when recorded); an earlier one's is the stored text whose hash the next re-post names as `fromSha256`
 * (or its own `toSha256`), looked up in the row and Class Feedback's versions. Null when no stored text matches.
 */
function correctionTexts(row: AutowriterSessionRow, corrections: readonly OneTimeCorrection[], versions: readonly StoredVersion[]): Array<FeedbackFieldAnswers | null> {
  const current = normalizeFields(row.fields ?? {});
  const known = [current, ...versions.map((version) => normalizeFields(version.fields))];
  const byHash = (hash: string | null) => hash ? known.find((fields) => fieldsHash(fields) === hash) ?? null : null;
  return corrections.map((correction, index) => {
    const next = corrections[index + 1];
    if (correction.toSha256) return byHash(correction.toSha256);
    if (next) return byHash(next.fromSha256);
    return current;
  });
}

export function planReviewBackfill(inputs: readonly BackfillSessionInput[]): BackfillPlan {
  const plan: BackfillPlan = { firstShots: [], corrections: [], unprovenCorrections: [], unverified: [], alreadyRecorded: [] };
  for (const input of inputs) {
    const { row } = input;
    if (row.state === "verified" && row.fields) {
      const corrections = readOneTimeCorrections(row.wiseSessionId, row.metadata);
      const texts = correctionTexts(row, corrections, input.pcVersions ?? (input.pcFirstVersion ? [input.pcFirstVersion] : []));
      corrections.forEach((correction, index) => {
        if (input.recordedDedupeKeys.has(correction.dedupeKey)) return;
        const fields = texts[index];
        if (!fields) {
          plan.unprovenCorrections.push({ wiseSessionId: row.wiseSessionId, dedupeKey: correction.dedupeKey, reason: "no stored text has the re-post's hash" });
          return;
        }
        plan.corrections.push({
          wiseSessionId: row.wiseSessionId,
          dedupeKey: correction.dedupeKey,
          source: correction.source,
          kind: correction.kind,
          at: correction.at,
          values: oneTimeCorrectionValues(row, correction, fields),
        });
      });
    }
    if (input.hasFirstShot) {
      plan.alreadyRecorded.push(row.wiseSessionId);
      continue;
    }
    const billing = postedBilling(row.billing);
    const candidates = firstShotCandidates(input);
    const post = (row.metadata as { post?: { stillAutoBlank?: unknown } } | null)?.post;
    const landedUnverified = row.state !== "verified" && postMayHaveLanded(row.state, { stillAutoBlank: post?.stillAutoBlank });
    if (!billing || !row.bodyHash) {
      plan.unverified.push({ wiseSessionId: row.wiseSessionId, reason: !row.bodyHash ? "no body_hash" : "billing unreadable", candidates: candidates.length, landedUnverified });
      continue;
    }
    const proof = proveFirstShot({ bodyHash: row.bodyHash, billing, candidates });
    if (!proof) {
      plan.unverified.push({ wiseSessionId: row.wiseSessionId, reason: "no candidate hashes to body_hash", candidates: candidates.length, landedUnverified });
      continue;
    }
    plan.firstShots.push({
      wiseSessionId: row.wiseSessionId,
      method: proof.method,
      fieldOrder: proof.fieldOrder,
      values: firstShotPostValues(row, { ...proof, source: { ...proof.source, candidatesTried: candidates.length } }, "backfill"),
    });
  }
  return plan;
}

/**
 * Write the plan in one transaction. Every insert is idempotent — first shots by the one-per-class index,
 * corrections by their `dedupe_key` — so a re-run, or two runs that overlap, record each post exactly once.
 */
export async function applyReviewBackfillPlan(db: Database, plan: BackfillPlan): Promise<{ firstShots: number; corrections: number; incidents: number }> {
  const P = schema.feedbackAutowriterPosts;
  return withDatabaseTransaction(db, async (tx) => {
    let firstShots = 0;
    let corrections = 0;
    let incidents = 0;
    for (const entry of plan.firstShots) {
      firstShots += (await tx.insert(P).values(entry.values).onConflictDoNothing().returning({ id: P.id })).length;
    }
    for (const entry of plan.corrections) {
      corrections += (await tx.insert(P).values(entry.values).onConflictDoNothing().returning({ id: P.id })).length;
    }
    for (const entry of plan.unverified) {
      if (await recordIncident(tx, {
        dedupeKey: `first_shot_unverified:${entry.wiseSessionId}`,
        kind: "first_shot_unverified",
        severity: entry.landedUnverified ? "critical" : "info",
        wiseSessionId: entry.wiseSessionId,
        summary: "The day-one backfill could not prove this class's first shot against its body_hash: please confirm what was posted.",
        detail: { reason: entry.reason, candidates: entry.candidates },
      })) incidents += 1;
    }
    return { firstShots, corrections, incidents };
  });
}

// ---------------------------------------------------------------------------
// Verdicts the owner gave outside the dashboard (the 30 Sep interview)
// ---------------------------------------------------------------------------

const OwnerVerdictEntry = z.object({
  wiseSessionId: z.string().regex(/^[0-9a-f]{24}$/u),
  verdict: z.enum(["approve", "needs_fix"]),
  severity: z.enum(["cosmetic", "factual", "critical"]).nullable(),
  criticalCategory: z.enum(["wrong_person", "billing_status", "invented_content", "should_not_have_posted"]).nullable(),
  note: z.string().trim().min(1).max(2_000),
}).strict();

const OwnerVerdictsFile = z.object({
  /** When the owner decided: a flag raised after it is news to them, so the verdict is not recorded over it. */
  decidedAt: z.iso.datetime({ offset: true }),
  /** Who recorded it, as the verdict's reviewer, e.g. "kevhsh7@gmail.com (owner interview 2026-09-30)". */
  reviewer: z.string().trim().min(1).max(200),
  verdicts: z.array(OwnerVerdictEntry).min(1).max(50),
}).strict();

export interface OwnerVerdictDecision {
  wiseSessionId: string;
  verdict: "approve" | "needs_fix";
  severity: AutowriterVerdictSeverity | null;
  criticalCategory: AutowriterCriticalCategory | null;
  note: string;
}

export interface OwnerVerdicts {
  decidedAt: Date;
  reviewer: string;
  verdicts: OwnerVerdictDecision[];
}

/**
 * The owner's decisions file (`scripts/feedback-autowriter-owner-verdicts.json`: session ids and the owner's words,
 * never a student's name), checked like a dashboard verdict: severity and category agree, one decision per class.
 */
export function parseOwnerVerdicts(json: unknown): OwnerVerdicts {
  const parsed = OwnerVerdictsFile.safeParse(json);
  if (!parsed.success) throw new Error(`The owner verdicts file is invalid: ${z.prettifyError(parsed.error)}`);
  const seen = new Set<string>();
  for (const entry of parsed.data.verdicts) {
    const problem = verdictShapeProblem(entry);
    if (problem) throw new Error(`Owner verdict for ${entry.wiseSessionId}: ${problem}`);
    if (seen.has(entry.wiseSessionId)) throw new Error(`The owner verdicts file decides ${entry.wiseSessionId} twice.`);
    seen.add(entry.wiseSessionId);
  }
  return { decidedAt: new Date(parsed.data.decidedAt), reviewer: parsed.data.reviewer, verdicts: parsed.data.verdicts };
}

/** A class's current verdict as the plan and the write compare it with a decision. */
export interface CurrentVerdictFacts {
  reviewer: string;
  verdict: "approve" | "needs_fix";
  severity: AutowriterVerdictSeverity | null;
  criticalCategory: AutowriterCriticalCategory | null;
  note: string | null;
  fieldsSha256: string;
}

/** The decision is the class's current verdict already (a re-run, or an overlapping run that got there first). */
export function isRecordedDecision(current: CurrentVerdictFacts | null, decision: OwnerVerdictDecision, reviewer: string, fieldsSha256: string): boolean {
  return current !== null && current.reviewer === reviewer && current.verdict === decision.verdict
    && current.severity === decision.severity && current.criticalCategory === decision.criticalCategory
    && current.note === decision.note && current.fieldsSha256 === fieldsSha256;
}

export interface OwnerVerdictPlanEntry extends OwnerVerdictDecision {
  reviewer: string;
  /** The first shot the verdict is pinned to (recorded, or recorded by this backfill); null when there is none. */
  fieldsSha256: string | null;
  status: "planned" | "already_recorded" | "other_verdict" | "no_first_shot";
}

/** What the write will do with each decision, as far as the dry run can tell (the write re-checks under its lock). */
export function planOwnerVerdicts(decisions: OwnerVerdicts, input: {
  firstShots: ReadonlyMap<string, string>;
  currentVerdicts?: ReadonlyMap<string, CurrentVerdictFacts>;
}): OwnerVerdictPlanEntry[] {
  return decisions.verdicts.map((decision) => {
    const fieldsSha256 = input.firstShots.get(decision.wiseSessionId) ?? null;
    const current = input.currentVerdicts?.get(decision.wiseSessionId) ?? null;
    const status = fieldsSha256 === null ? "no_first_shot"
      : isRecordedDecision(current, decision, decisions.reviewer, fieldsSha256) ? "already_recorded"
        : current ? "other_verdict" : "planned";
    return { ...decision, reviewer: decisions.reviewer, fieldsSha256, status };
  });
}

export interface OwnerVerdictApplyResult {
  recorded: string[];
  alreadyRecorded: string[];
  skipped: Array<{ wiseSessionId: string; reason: string }>;
}

/**
 * Record each decision once, through `recordVerdict` — the dashboard's own path: pinned to the recorded first shot's
 * `fields_sha256`, made current in one transaction, the transcript's triage re-opened for a major or critical verdict,
 * a critical one queued as an incident — as `source: "backfill"` with the file's reviewer. The flags open at the
 * decision are the ones it resolves. Left alone and reported: a class that already has this verdict (a re-run, or an
 * overlapping run that got there first), and — for the owner to answer in the dashboard — one with no review row yet,
 * another current verdict, a flag raised after the decision, or a judgement the decision would downgrade.
 */
export async function applyOwnerVerdicts(db: Database, decisions: OwnerVerdicts): Promise<OwnerVerdictApplyResult> {
  const R = schema.feedbackAutowriterReviews;
  const P = schema.feedbackAutowriterPosts;
  const V = schema.feedbackAutowriterVerdicts;
  const FL = schema.feedbackAutowriterFlags;
  const result: OwnerVerdictApplyResult = { recorded: [], alreadyRecorded: [], skipped: [] };
  const read = async (wiseSessionId: string) => {
    const [review] = await db.select({ currentVerdictId: R.currentVerdictId, fieldsSha256: P.fieldsSha256 }).from(R)
      .innerJoin(P, eq(P.id, R.firstPostId)).where(eq(R.wiseSessionId, wiseSessionId));
    const [current] = review?.currentVerdictId ? await db.select({
      reviewer: V.reviewer, verdict: V.verdict, severity: V.severity, criticalCategory: V.criticalCategory, note: V.note, fieldsSha256: V.fieldsSha256,
    }).from(V).where(eq(V.id, review.currentVerdictId)) : [];
    const open = await db.select({ id: FL.id, createdAt: FL.createdAt }).from(FL)
      .where(and(eq(FL.wiseSessionId, wiseSessionId), isNull(FL.resolvedByVerdictId)));
    return { review: review ?? null, current: current ?? null, open };
  };
  for (const decision of decisions.verdicts) {
    const { wiseSessionId } = decision;
    const facts = await read(wiseSessionId);
    if (!facts.review) {
      result.skipped.push({ wiseSessionId, reason: "no review row: the class's first shot is not recorded" });
      continue;
    }
    if (isRecordedDecision(facts.current, decision, decisions.reviewer, facts.review.fieldsSha256)) {
      result.alreadyRecorded.push(wiseSessionId);
      continue;
    }
    if (facts.current) {
      result.skipped.push({ wiseSessionId, reason: `the class already has a verdict by ${facts.current.reviewer}: record the decision in the dashboard if it still applies` });
      continue;
    }
    if (facts.open.some((flag) => flag.createdAt.getTime() > decisions.decidedAt.getTime())) {
      result.skipped.push({ wiseSessionId, reason: "a flag raised after the decision is open: answer it in the dashboard" });
      continue;
    }
    try {
      await recordVerdict(db, {
        ...decision,
        fieldsSha256: facts.review.fieldsSha256,
        currentVerdictId: null,
        seenFlagIds: facts.open.map((flag) => flag.id),
        reviewer: decisions.reviewer,
        source: "backfill",
      });
      result.recorded.push(wiseSessionId);
    } catch (error) {
      if (!(error instanceof AutowriterReviewError) || error.status !== 409) throw error;
      // Another run recorded it in between (then it is this decision), or a flag or verdict arrived since the read.
      const again = await read(wiseSessionId);
      if (again.review && isRecordedDecision(again.current, decision, decisions.reviewer, again.review.fieldsSha256)) {
        result.alreadyRecorded.push(wiseSessionId);
      } else {
        result.skipped.push({ wiseSessionId, reason: error.message });
      }
    }
  }
  return result;
}
