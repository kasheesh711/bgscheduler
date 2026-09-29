import type * as schema from "@/lib/db/schema";
import type { FeedbackFieldAnswers } from "@/lib/post-class-feedback/types";
import {
  normalizeFields,
  postedBilling,
  proveFirstShot,
  reverseRenameVariants,
  type FirstShotCandidate,
  type FirstShotMethod,
} from "./first-shot";
import { firstShotPostValues } from "./review-job";
import type { AutowriterSessionRow } from "./store";
import { fieldsHash } from "./submit";

/**
 * Day-one backfill of the review tables (pure planning; `scripts/feedback-autowriter-backfill-review.ts` loads
 * the rows and writes the plan). Never touches Wise.
 *
 * A first shot is accepted only when its rebuilt POST body hashes to the row's `body_hash`. Candidates: the
 * stored text; for rows the one-time nickname fix rewrote (`metadata.nicknameFix`), also the earliest teacher
 * version Class Feedback stored and every reverse-rename variant of both. The nickname re-posts themselves are
 * recorded as correction posts by the script's actor.
 */

export const NICKNAME_FIX_ACTOR = "script:nickname-fix (kevhsh7@gmail.com)";
export const NICKNAME_FIX_REASON = "owner naming policy: nickname";

type PostInsert = typeof schema.feedbackAutowriterPosts.$inferInsert;

export interface NicknameFix {
  from: string;
  to: string;
  at: Date;
  by: string | null;
}

export function readNicknameFix(metadata: unknown): NicknameFix | null {
  const fix = (metadata as { nicknameFix?: { from?: unknown; to?: unknown; at?: unknown; by?: unknown } } | null)?.nicknameFix;
  if (!fix || typeof fix.from !== "string" || typeof fix.to !== "string" || typeof fix.at !== "string") return null;
  const at = new Date(fix.at);
  if (Number.isNaN(at.getTime())) return null;
  return { from: fix.from, to: fix.to, at, by: typeof fix.by === "string" ? fix.by : null };
}

export interface BackfillSessionInput {
  row: AutowriterSessionRow;
  /** Earliest substantive teacher version Class Feedback stored for the session. */
  pcFirstVersion: { id: string; observedAt: Date; fields: FeedbackFieldAnswers } | null;
  hasFirstShot: boolean;
  hasNicknameCorrection: boolean;
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
  corrections: Array<{ wiseSessionId: string; values: PostInsert }>;
  unverified: Array<{ wiseSessionId: string; reason: string; candidates: number }>;
  alreadyRecorded: string[];
}

/** The correction posts row for a one-time nickname re-post (its text is the row's current, verified text). */
export function nicknameCorrectionValues(row: AutowriterSessionRow, fix: NicknameFix): PostInsert {
  return {
    wiseSessionId: row.wiseSessionId,
    wiseClassId: row.wiseClassId,
    wiseTeacherUserId: row.wiseTeacherUserId,
    kind: "correction",
    fields: normalizeFields(row.fields ?? {}),
    fieldsSha256: fieldsHash(normalizeFields(row.fields ?? {})),
    // The script's POST body was not stored; only its text and its read-back are known.
    bodyHash: null,
    billing: row.billing ?? {},
    arm: null,
    evidence: null,
    pipeline: null,
    actorKind: "script",
    actor: NICKNAME_FIX_ACTOR,
    reason: NICKNAME_FIX_REASON,
    postStartedAt: null,
    postFinishedAt: fix.at,
    outcome: "verified",
    verification: {
      method: "one-time script read-back",
      checks: ["stored text equals the new text", "one teacher submission", "billing unchanged", "credit entries unchanged"],
      stampedBy: fix.by,
    },
    provenance: "backfill",
    reconstruction: { source: "metadata.nicknameFix", at: fix.at.toISOString() },
    settledAt: fix.at,
  };
}

export function planReviewBackfill(inputs: readonly BackfillSessionInput[]): BackfillPlan {
  const plan: BackfillPlan = { firstShots: [], corrections: [], unverified: [], alreadyRecorded: [] };
  for (const input of inputs) {
    const { row } = input;
    const fix = readNicknameFix(row.metadata);
    if (fix && !input.hasNicknameCorrection && row.fields && row.state === "verified") {
      plan.corrections.push({ wiseSessionId: row.wiseSessionId, values: nicknameCorrectionValues(row, fix) });
    }
    if (input.hasFirstShot) {
      plan.alreadyRecorded.push(row.wiseSessionId);
      continue;
    }
    const billing = postedBilling(row.billing);
    const candidates = firstShotCandidates(input);
    if (!billing || !row.bodyHash) {
      plan.unverified.push({ wiseSessionId: row.wiseSessionId, reason: !row.bodyHash ? "no body_hash" : "billing unreadable", candidates: candidates.length });
      continue;
    }
    const proof = proveFirstShot({ bodyHash: row.bodyHash, billing, candidates });
    if (!proof) {
      plan.unverified.push({ wiseSessionId: row.wiseSessionId, reason: "no candidate hashes to body_hash", candidates: candidates.length });
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
