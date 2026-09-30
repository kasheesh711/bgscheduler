import type { Database } from "@/lib/db";
import * as schema from "@/lib/db/schema";
import { withDatabaseTransaction } from "@/lib/db/transaction";
import type { FeedbackFieldAnswers } from "@/lib/post-class-feedback/types";
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

/**
 * Day-one backfill of the review tables (pure planning plus the write; `scripts/feedback-autowriter-backfill-review.ts`
 * loads the rows). Never touches Wise.
 *
 * A first shot is accepted only when its rebuilt POST body hashes to the row's `body_hash`. Candidates: the
 * stored text; for rows a one-time script rewrote, also the earliest teacher version Class Feedback stored and every
 * reverse-rename variant of both. Each one-time re-post the row records (`metadata.nicknameFix`, every entry of
 * `metadata.corrections`) becomes a correction post (origin one-time, actor kind `script`) carrying the text it put in
 * Wise, found by its hash; its `dedupe_key` makes the write idempotent even when two runs overlap.
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
  corrections: Array<{ wiseSessionId: string; dedupeKey: string; source: OneTimeCorrection["source"]; at: Date; values: PostInsert }>;
  /** Re-posts whose text could not be found by its hash: not recorded (their API saves stay unmatched). */
  unprovenCorrections: Array<{ wiseSessionId: string; dedupeKey: string; reason: string }>;
  unverified: Array<{ wiseSessionId: string; reason: string; candidates: number; landedUnverified: boolean }>;
  alreadyRecorded: string[];
}

/** The correction posts row for a one-time re-post, with the text it put in Wise. */
export function oneTimeCorrectionValues(row: AutowriterSessionRow, correction: OneTimeCorrection, fields: FeedbackFieldAnswers): PostInsert {
  const nickname = correction.source === "nicknameFix";
  return {
    wiseSessionId: row.wiseSessionId,
    wiseClassId: row.wiseClassId,
    wiseTeacherUserId: row.wiseTeacherUserId,
    kind: "correction",
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
