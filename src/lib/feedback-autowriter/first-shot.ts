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
