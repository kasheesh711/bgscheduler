import { createHmac, randomBytes, timingSafeEqual } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { POST_CLASS_FEEDBACK_FIELDS, type FeedbackFieldAnswers } from "@/lib/post-class-feedback/types";
import { fieldsHash } from "../submit";
import { NIGHTLY_FILE_MODE, ensureDir, nightlyHome, readJsonFile, writeJsonAtomic } from "./paths";

/**
 * Correction proposals (quick 261003-12b): what `verify` found good enough to post, and the only input `correct`
 * accepts. Each is signed with HMAC-SHA256 over its canonical JSON (keys sorted at every level) with a local key,
 * `~/.bgscheduler-nightly/hmac.key` (32 random bytes, 0600, created by `verify` when missing), so a proposal edited or
 * written by anything but `verify` is refused. The proposal carries the candidate text and its checks; it never
 * carries a Wise class, teacher or submission id — `correct` reads those from the database.
 */

export const PROPOSAL_VERSION = 1;
export const PROPOSAL_ALG = "HMAC-SHA256";
const HMAC_KEY_BYTES = 32;
const SESSION_ID = /^[0-9a-f]{24}$/iu;

export interface ProposalCheck {
  name: string;
  pass: boolean;
  /** Codes and numbers only (no lesson text). */
  detail: string;
}

export interface CorrectionProposal {
  version: typeof PROPOSAL_VERSION;
  night: string;
  wiseSessionId: string;
  /** The posted text it corrects (the first shot's `fields_sha256`). */
  fieldsSha256: string;
  /** The corrected text and its `fieldsHash`. */
  fields: FeedbackFieldAnswers;
  fieldsHash: string;
  source: "replay" | "minimal_fix";
  /** What the corrected text was written from (stored on the posts row). */
  evidence: "summary" | "transcript";
  arm: string | null;
  /** The audit issues it corrects (ids, modes and severities only). */
  issues: Array<{ id: string; mode: string; severity: "critical" | "major" }>;
  modes: string[];
  severity: "critical" | "major";
  criticalCategory: string | null;
  checks: ProposalCheck[];
  /** Mode codes and one line, no lesson text, at most 500 characters (the posts row's reason). */
  reason: string;
  /** The fix branch or PR behind the correction. */
  rootCauseRef: string;
  /** Versions and commit that produced the text and its checks (the posts row's pipeline). */
  pipeline: Record<string, unknown>;
  createdAt: string;
}

export interface SignedProposal {
  proposal: CorrectionProposal;
  alg: typeof PROPOSAL_ALG;
  signature: string;
}

/** JSON with every object's keys sorted (arrays keep their order): the bytes a signature covers. */
export function canonicalJson(value: unknown): string {
  return JSON.stringify(sortKeys(value));
}

function sortKeys(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(sortKeys);
  if (value && typeof value === "object") {
    return Object.fromEntries(Object.keys(value as Record<string, unknown>).sort()
      .filter((key) => (value as Record<string, unknown>)[key] !== undefined)
      .map((key) => [key, sortKeys((value as Record<string, unknown>)[key])]));
  }
  return value;
}

export function hmacKeyFile(home?: string): string {
  return path.join(nightlyHome(home), "hmac.key");
}

export type HmacKeyResult = { ok: true; key: Buffer; created: boolean } | { ok: false; reason: string };

/** The signing key; refused when it is not 32 bytes or another user could read it. */
export function loadHmacKey(home?: string): HmacKeyResult {
  const file = hmacKeyFile(home);
  let stat: fs.Stats;
  try {
    stat = fs.statSync(file);
  } catch (error) {
    return { ok: false, reason: (error as NodeJS.ErrnoException).code === "ENOENT" ? "hmac_key_missing" : "hmac_key_unreadable" };
  }
  if (!stat.isFile()) return { ok: false, reason: "hmac_key_not_a_file" };
  if ((stat.mode & 0o077) !== 0) return { ok: false, reason: "hmac_key_permissions" };
  const key = fs.readFileSync(file);
  if (key.length !== HMAC_KEY_BYTES) return { ok: false, reason: "hmac_key_length" };
  return { ok: true, key, created: false };
}

/** The signing key, created (32 random bytes, 0600, never overwritten) when there is none yet. */
export function loadOrCreateHmacKey(home?: string): HmacKeyResult {
  const file = hmacKeyFile(home);
  if (!fs.existsSync(file)) {
    ensureDir(path.dirname(file));
    let descriptor: number | null = null;
    try {
      descriptor = fs.openSync(file, "wx", NIGHTLY_FILE_MODE);
      fs.writeSync(descriptor, randomBytes(HMAC_KEY_BYTES));
      fs.fsyncSync(descriptor);
    } catch (error) {
      // Another process created it first: use theirs.
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
    } finally {
      if (descriptor !== null) fs.closeSync(descriptor);
    }
    const loaded = loadHmacKey(home);
    return loaded.ok ? { ...loaded, created: descriptor !== null } : loaded;
  }
  return loadHmacKey(home);
}

function signatureOf(proposal: CorrectionProposal, key: Buffer): string {
  return createHmac("sha256", key).update(canonicalJson(proposal)).digest("hex");
}

export function signProposal(proposal: CorrectionProposal, key: Buffer): SignedProposal {
  return { proposal, alg: PROPOSAL_ALG, signature: signatureOf(proposal, key) };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function wellFormedFields(value: unknown): value is FeedbackFieldAnswers {
  return isRecord(value) && POST_CLASS_FEEDBACK_FIELDS.every((field) => typeof value[field] === "string");
}

/**
 * A proposal as read from disk, or why it is refused: not signed, signed with another key, edited after signing, or
 * not a well-formed proposal (its text must hash to its `fieldsHash`; the reason and root-cause reference must be set).
 */
export function verifyProposal(value: unknown, key: Buffer): { ok: true; proposal: CorrectionProposal } | { ok: false; reason: string } {
  if (!isRecord(value) || !isRecord(value.proposal)) return { ok: false, reason: "not_a_proposal" };
  if (value.alg !== PROPOSAL_ALG || typeof value.signature !== "string" || !/^[0-9a-f]{64}$/u.test(value.signature)) {
    return { ok: false, reason: "unsigned" };
  }
  const expected = Buffer.from(signatureOf(value.proposal as unknown as CorrectionProposal, key), "hex");
  const given = Buffer.from(value.signature, "hex");
  if (given.length !== expected.length || !timingSafeEqual(given, expected)) return { ok: false, reason: "signature_mismatch" };
  const proposal = value.proposal as unknown as CorrectionProposal;
  if (proposal.version !== PROPOSAL_VERSION) return { ok: false, reason: "version" };
  if (typeof proposal.wiseSessionId !== "string" || !SESSION_ID.test(proposal.wiseSessionId)) return { ok: false, reason: "session_id" };
  if (!wellFormedFields(proposal.fields) || fieldsHash(proposal.fields) !== proposal.fieldsHash) return { ok: false, reason: "fields_hash" };
  if (typeof proposal.fieldsSha256 !== "string" || !proposal.fieldsSha256) return { ok: false, reason: "base_hash_missing" };
  if (typeof proposal.reason !== "string" || !proposal.reason.trim() || [...proposal.reason].length > 500) return { ok: false, reason: "reason" };
  if (typeof proposal.rootCauseRef !== "string" || !proposal.rootCauseRef.trim()) return { ok: false, reason: "root_cause_ref_missing" };
  if (proposal.source !== "replay" && proposal.source !== "minimal_fix") return { ok: false, reason: "source" };
  if (proposal.evidence !== "summary" && proposal.evidence !== "transcript") return { ok: false, reason: "evidence" };
  return { ok: true, proposal };
}

export function proposalFile(proposalsDir: string, wiseSessionId: string): string {
  if (!SESSION_ID.test(wiseSessionId)) throw new Error("Not a Wise session id");
  return path.join(proposalsDir, `${wiseSessionId}.json`);
}

/** Sign and write `proposals/<sid>.json` (0600). */
export function writeProposal(proposalsDir: string, proposal: CorrectionProposal, key: Buffer): string {
  const file = proposalFile(proposalsDir, proposal.wiseSessionId);
  writeJsonAtomic(file, signProposal(proposal, key));
  return file;
}

/** Every `<sid>.json` in the proposals folder, unparsed (a file that does not parse comes back as null). */
export function readProposalFiles(proposalsDir: string): Array<{ wiseSessionId: string; file: string; value: unknown }> {
  let names: string[];
  try {
    names = fs.readdirSync(proposalsDir);
  } catch {
    return [];
  }
  return names.filter((name) => /^[0-9a-f]{24}\.json$/iu.test(name)).sort().map((name) => {
    const file = path.join(proposalsDir, name);
    return { wiseSessionId: name.slice(0, 24), file, value: readJsonFile<unknown>(file) };
  });
}
