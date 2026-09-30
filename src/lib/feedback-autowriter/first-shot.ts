import { POST_CLASS_FEEDBACK_FIELDS, type FeedbackFieldAnswers } from "@/lib/post-class-feedback/types";
import { buildFeedbackPostBody } from "./session";
import { feedbackBodyHash } from "./submit";

/**
 * Proof of a class's first shot (Phase 1 of the operating loop, pure).
 *
 * The POST claim stored `body_hash = sha256(JSON.stringify({answers: [form order], sessionStatus,
 * creditsConsumed}))` and nothing ever rewrote it (the one-time nickname fix changed `fields` only). So a
 * candidate text is the first shot exactly when the POST body rebuilt from it — in one of the possible form
 * orders, with the stored billing — hashes to `body_hash`. Nothing is accepted on similarity.
 */

type Field = (typeof POST_CLASS_FEEDBACK_FIELDS)[number];

/** Every ordered subset of the four feedback fields (4 + 12 + 24 + 24 = 64 possible form orders). */
export const FORM_FIELD_ORDERS: ReadonlyArray<readonly Field[]> = (() => {
  const orders: Field[][] = [];
  const extend = (prefix: Field[]) => {
    if (prefix.length > 0) orders.push(prefix);
    for (const field of POST_CLASS_FEEDBACK_FIELDS) {
      if (!prefix.includes(field)) extend([...prefix, field]);
    }
  };
  extend([]);
  return orders.toSorted((a, b) => b.length - a.length);
})();

export interface PostedBilling {
  sessionStatus: string;
  creditsConsumed: number;
}

export type FirstShotMethod = "unchanged" | "pc_first_version" | "reverse_rename" | "pc_first_version_reverse_rename";

export interface FirstShotCandidate {
  method: FirstShotMethod;
  fields: FeedbackFieldAnswers;
  /** What produced it, e.g. the feedback version id or the renamed occurrences. */
  source?: Record<string, unknown>;
}

export interface FirstShotProof {
  method: FirstShotMethod;
  fields: FeedbackFieldAnswers;
  fieldOrder: Field[];
  bodyHash: string;
  source: Record<string, unknown>;
}

/** Billing as the POST body carried it, or null when the stored billing is unusable. */
export function postedBilling(billing: unknown): PostedBilling | null {
  const value = billing as { sessionStatus?: unknown; creditsConsumed?: unknown } | null;
  if (!value || typeof value.sessionStatus !== "string" || typeof value.creditsConsumed !== "number") return null;
  return { sessionStatus: value.sessionStatus, creditsConsumed: value.creditsConsumed };
}

/** The first candidate whose rebuilt POST body hashes to `bodyHash`, with the form order that proves it. */
export function proveFirstShot(input: {
  bodyHash: string;
  billing: PostedBilling;
  candidates: readonly FirstShotCandidate[];
}): FirstShotProof | null {
  for (const candidate of input.candidates) {
    for (const order of FORM_FIELD_ORDERS) {
      // A form without a field could not have carried text written for it.
      if (POST_CLASS_FEEDBACK_FIELDS.some((field) => !order.includes(field) && (candidate.fields[field] ?? "").trim() !== "")) continue;
      const body = buildFeedbackPostBody({ fieldOrder: [...order] }, candidate.fields, input.billing);
      if (feedbackBodyHash(body) === input.bodyHash) {
        return {
          method: candidate.method,
          fields: normalizeFields(candidate.fields),
          fieldOrder: [...order],
          bodyHash: input.bodyHash,
          source: candidate.source ?? {},
        };
      }
    }
  }
  return null;
}

/**
 * A re-post made by an owner-approved one-time script, as the script recorded it on the session row after verifying
 * it in Wise: `metadata.nicknameFix` (29 Sep, first name → nickname) or an entry of `metadata.corrections`
 * (`.feedback-autowriter/correct-posts.ts`: `{fields, reason, fromSha256, toSha256, at, by}`). Each is one API save
 * we caused, recorded as a post (origin one-time) so it is never reported as an unmatched API write.
 */
export interface OneTimeCorrection {
  source: "nicknameFix" | "corrections";
  /**
   * The post kind (owner decision D-01, 30 Sep): the nickname fix applied a naming policy that changed after the post
   * — a `policy` re-post, never a fix; an owner-approved correction repaired a wrong post — a `correction`, a fix.
   */
  kind: "policy" | "correction";
  /** The correction post's `dedupe_key`: the same re-post is recorded at most once. */
  dedupeKey: string;
  /** When the script stamped it (after its POST and read-back). */
  at: Date;
  by: string | null;
  reason: string | null;
  /** Field names the correction edited (`corrections` only). */
  fields: string[] | null;
  fromSha256: string | null;
  toSha256: string | null;
  rename: { from: string; to: string } | null;
}

function validInstant(value: unknown): Date | null {
  if (typeof value !== "string") return null;
  const at = new Date(value);
  return Number.isNaN(at.getTime()) ? null : at;
}

/** Every one-time re-post the session row records, oldest first; malformed entries are ignored. */
export function readOneTimeCorrections(wiseSessionId: string, metadata: unknown): OneTimeCorrection[] {
  const record = (typeof metadata === "object" && metadata !== null ? metadata : {}) as { nicknameFix?: unknown; corrections?: unknown };
  const out: OneTimeCorrection[] = [];
  const fix = record.nicknameFix as { from?: unknown; to?: unknown; at?: unknown; by?: unknown } | undefined;
  const fixAt = validInstant(fix?.at);
  if (fix && fixAt && typeof fix.from === "string" && typeof fix.to === "string") {
    out.push({
      source: "nicknameFix", kind: "policy", dedupeKey: `nickname-fix:${wiseSessionId}`, at: fixAt, by: typeof fix.by === "string" ? fix.by : null,
      reason: null, fields: null, fromSha256: null, toSha256: null, rename: { from: fix.from, to: fix.to },
    });
  }
  const corrections = Array.isArray(record.corrections) ? record.corrections : [];
  for (const entry of corrections as Array<{ fields?: unknown; reason?: unknown; fromSha256?: unknown; toSha256?: unknown; at?: unknown; by?: unknown }>) {
    const at = validInstant(entry?.at);
    if (!at || typeof entry.toSha256 !== "string") continue;
    out.push({
      source: "corrections",
      kind: "correction",
      dedupeKey: `correction:${wiseSessionId}:${at.toISOString()}`,
      at,
      by: typeof entry.by === "string" ? entry.by : null,
      reason: typeof entry.reason === "string" ? entry.reason : null,
      fields: Array.isArray(entry.fields) ? entry.fields.filter((field): field is string => typeof field === "string") : null,
      fromSha256: typeof entry.fromSha256 === "string" ? entry.fromSha256 : null,
      toSha256: entry.toSha256,
      rename: null,
    });
  }
  return out.toSorted((a, b) => a.at.getTime() - b.at.getTime());
}

/** A post's settled outcome and what its read-back said (`feedback_autowriter_posts.verification`). */
export interface PostVerificationFacts {
  /** Read-back problem codes (never Wise's response body). */
  problems?: unknown;
  /** After a refused or throttled POST, the auto-submission was still unchanged: nothing landed. */
  stillAutoBlank?: unknown;
}

/**
 * Whether the text of a settled first shot may be in Wise, so the owner must be able to judge it: a verified post,
 * one whose read-back failed (`verify_failed`), one with an unknown outcome, and a refused POST unless the
 * read-back proved the submission unchanged.
 */
export function postMayHaveLanded(outcome: string, verification: PostVerificationFacts | null | undefined): boolean {
  if (outcome === "verified" || outcome === "verify_failed" || outcome === "unknown_outcome") return true;
  return outcome === "rejected" && verification?.stillAutoBlank !== true;
}

/** Read-back problem codes that are billing or status changes (a critical category in the owner's rules). */
const BILLING_PROBLEM = /^(status_|credits_|session_credit)/u;

export function problemCodes(problems: unknown): string[] {
  return Array.isArray(problems) ? problems.filter((problem): problem is string => typeof problem === "string").slice(0, 20) : [];
}

/**
 * The critical category a landed-but-unverified first shot suggests: billing/status drift, or a person's save
 * inside our POST window (we may have replaced their text). Null when the problems say neither.
 */
export function landedProblemCategory(problems: unknown): "billing_status" | "should_not_have_posted" | null {
  const codes = problemCodes(problems);
  if (codes.some((code) => BILLING_PROBLEM.test(code))) return "billing_status";
  if (codes.includes("foreign_submit_event_in_post_window")) return "should_not_have_posted";
  return null;
}

export function normalizeFields(fields: Partial<Record<Field, unknown>>): FeedbackFieldAnswers {
  return Object.fromEntries(POST_CLASS_FEEDBACK_FIELDS.map((field) => {
    const value = fields[field];
    return [field, typeof value === "string" ? value : ""];
  })) as FeedbackFieldAnswers;
}

const escapeRegExp = (value: string) => value.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&");
/** The same whole-word rule the one-time nickname fix used (`.feedback-autowriter/nickname-fix.ts`). */
const wholeWord = (name: string) => new RegExp(`(?<!\\p{L})${escapeRegExp(name)}(?!\\p{L})`, "gu");

/** Above this many occurrences the 2^k variants are not enumerated (none of the renamed posts comes close). */
export const MAX_REVERSE_RENAME_OCCURRENCES = 12;

/**
 * Undo a whole-word rename `from → to`. The rename replaced every `from`; the text may also have held `to`
 * before it (a student already called by their nickname), so every subset of the `to` occurrences is tried
 * (2^k variants, fewest reversals last — all of them first, as the rename's usual case).
 */
export function reverseRenameVariants(fields: FeedbackFieldAnswers, rename: { from: string; to: string }): FeedbackFieldAnswers[] {
  if (!rename.from || !rename.to || rename.from === rename.to) return [];
  const occurrences: Array<{ field: Field; index: number }> = [];
  for (const field of POST_CLASS_FEEDBACK_FIELDS) {
    for (const match of (fields[field] ?? "").matchAll(wholeWord(rename.to))) {
      occurrences.push({ field, index: match.index ?? 0 });
    }
  }
  const k = occurrences.length;
  if (k === 0 || k > MAX_REVERSE_RENAME_OCCURRENCES) return [];
  const variants: FeedbackFieldAnswers[] = [];
  // Masks from all-reversed down to one reversal; mask 0 is the unchanged text (a separate candidate).
  for (let mask = (1 << k) - 1; mask > 0; mask -= 1) {
    const next = { ...fields };
    for (const field of POST_CLASS_FEEDBACK_FIELDS) {
      const chosen = occurrences
        .map((occurrence, position) => ({ ...occurrence, position }))
        .filter((occurrence) => occurrence.field === field && (mask & (1 << occurrence.position)) !== 0)
        .toSorted((a, b) => b.index - a.index);
      let text = fields[field] ?? "";
      for (const occurrence of chosen) {
        text = text.slice(0, occurrence.index) + rename.from + text.slice(occurrence.index + rename.to.length);
      }
      next[field] = text;
    }
    variants.push(next);
  }
  return variants;
}
