import { and, desc, eq, gte, inArray, isNotNull, isNull, lt } from "drizzle-orm";
import type { Database } from "@/lib/db";
import * as schema from "@/lib/db/schema";
import { POST_CLASS_FEEDBACK_FIELDS, type FeedbackFieldAnswers } from "@/lib/post-class-feedback/types";
import { chooseStudentDisplayName } from "../prompt";
import { bangkokDayBounds } from "../quality";
import { tutorKeyFor } from "../review-job";
import { fieldsHash } from "../submit";
import { readJsonl } from "./paths";
import type { NightlyTarget } from "./types";

/**
 * Which posted classes a night audits (SELECT only): the autowriter's own verified posts of classes that ended on the
 * Bangkok date `night`, each with its first-shot post row — never tutor-written feedback. A class is audited once per
 * posted text and audit version (`auditKey`); a key that failed twice is not tried again until the version changes.
 */

const S = schema.feedbackAutowriterSessions;
const P = schema.feedbackAutowriterPosts;
const R = schema.feedbackAutowriterReviews;
const V = schema.feedbackAutowriterVerdicts;
const FL = schema.feedbackAutowriterFlags;
const FX = schema.feedbackAutowriterFixEvents;
const PC = schema.postClassSessions;

/** Saves by a person, or by our API user outside any post we recorded: the text in Wise may not be ours any more. */
export const HUMAN_SAVE_KINDS = ["owner_web", "tutor", "other_staff", "api_actor_unmatched"] as const;

/** The audit's idempotency key: one audit per class, posted text and audit version. */
export function auditKey(input: { wiseSessionId: string; fieldsSha256: string; auditVersion: number }): string {
  return `audit:${input.wiseSessionId}:${input.fieldsSha256}:a${input.auditVersion}`;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** Whether a draft was written with a style or format guide, or Atom/ISEB evidence (its exact input was retained). */
export function guidedStamp(pipeline: Record<string, unknown> | null): boolean {
  if (!pipeline) return false;
  return ["styleGuide", "formatGuide", "atomEvidenceHash", "lessonEvidenceHash"].some((key) => pipeline[key] !== null && pipeline[key] !== undefined);
}

function fieldsRecord(value: unknown): Record<string, string> | null {
  if (!isRecord(value)) return null;
  const out: Record<string, string> = {};
  for (const field of POST_CLASS_FEEDBACK_FIELDS) {
    const text = value[field];
    if (typeof text !== "string") return null;
    out[field] = text;
  }
  return out;
}

function iso(value: Date | string | null | undefined): string | null {
  if (value === null || value === undefined) return null;
  const date = value instanceof Date ? value : new Date(value);
  return Number.isNaN(date.getTime()) ? null : date.toISOString();
}

/** One joined row of the target query (also built by tests). */
export interface TargetRow {
  wiseSessionId: string;
  wiseClassId: string | null;
  postWiseClassId: string | null;
  wiseTeacherUserId: string | null;
  scheduledEndAt: Date | null;
  deadlineAt: Date | null;
  evidence: "summary" | "transcript";
  arm: string | null;
  fields: unknown;
  fieldsSha256: string | null;
  billing: Record<string, unknown> | null;
  sonioxTranscriptionId: string | null;
  metadata: Record<string, unknown>;
  firstShotPostId: string;
  firstShotPipeline: Record<string, unknown> | null;
  firstShotStartedAt: Date | null;
  firstShotRecordedAt: Date;
  reviewTutorKey: string | null;
  currentVerdictId: string | null;
  mirrorClassName: string | null;
}

export interface TargetFacts {
  /** Verdicts on the class, newest first. */
  verdicts: ReadonlyArray<{ id: string; verdict: "approve" | "needs_fix" }>;
  ownerFlagOpen: boolean;
  /** When a person (or an unmatched API save) saved the class's feedback. */
  humanSaves: readonly Date[];
}

/**
 * A target from its row and facts, or null when the row cannot be audited as posted (no readable four-field text).
 * The student's name is the class name until the collect step reads Wise's participant list.
 */
export function targetFromRow(row: TargetRow, facts: TargetFacts): NightlyTarget | null {
  const fields = fieldsRecord(row.fields);
  const scheduledEndAt = iso(row.scheduledEndAt);
  if (!fields || !scheduledEndAt) return null;
  const pipeline = row.firstShotPipeline ?? (isRecord(row.metadata.pipeline) ? row.metadata.pipeline : null);
  const stampEvidence = pipeline?.evidence;
  const current = row.currentVerdictId ? facts.verdicts.find((verdict) => verdict.id === row.currentVerdictId) ?? null : null;
  const verdict = current ?? facts.verdicts[0] ?? null;
  const postedAt = (row.firstShotStartedAt ?? row.firstShotRecordedAt).getTime();
  const className = row.mirrorClassName?.trim() || (typeof row.metadata.className === "string" ? row.metadata.className.trim() : "") || null;
  return {
    wiseSessionId: row.wiseSessionId,
    wiseClassId: row.wiseClassId ?? row.postWiseClassId ?? "",
    wiseTeacherUserId: row.wiseTeacherUserId,
    tutorKey: row.reviewTutorKey ?? (row.wiseTeacherUserId ? tutorKeyFor(row.wiseTeacherUserId) : null),
    scheduledEndAt,
    deadlineAt: iso(row.deadlineAt),
    evidence: stampEvidence === "transcript" || stampEvidence === "summary" ? stampEvidence : row.evidence,
    arm: row.arm,
    fields,
    fieldsSha256: row.fieldsSha256 ?? fieldsHash(fields as unknown as FeedbackFieldAnswers),
    billing: row.billing,
    sonioxTranscriptionId: row.sonioxTranscriptionId,
    firstShotPostId: row.firstShotPostId,
    currentVerdictId: row.currentVerdictId,
    verdict: verdict?.verdict ?? null,
    ownerFlagOpen: facts.ownerFlagOpen,
    humanSavedSincePost: facts.humanSaves.some((at) => at.getTime() >= postedAt - 5_000),
    guided: guidedStamp(pipeline),
    pipeline,
    studentFullName: className,
    studentDisplayName: className ? chooseStudentDisplayName(className) : null,
    className,
  };
}

/**
 * The night's verified autowriter posts (SELECT only), newest first: `scheduled_end_at` within the Bangkok date
 * `night` (00:00–24:00 Asia/Bangkok), text present, and a first-shot post by the autowriter itself. `sessionIds`
 * narrows the night to those classes.
 */
export async function loadNightlyTargets(db: Database, input: { night: string; sessionIds?: readonly string[] }): Promise<NightlyTarget[]> {
  const { start, end } = bangkokDayBounds(input.night);
  const conditions = [
    eq(S.state, "verified"),
    isNotNull(S.fields),
    gte(S.scheduledEndAt, start),
    lt(S.scheduledEndAt, end),
    ...(input.sessionIds && input.sessionIds.length > 0 ? [inArray(S.wiseSessionId, [...input.sessionIds])] : []),
  ];
  const rows: TargetRow[] = await db.select({
    wiseSessionId: S.wiseSessionId,
    wiseClassId: S.wiseClassId,
    postWiseClassId: P.wiseClassId,
    wiseTeacherUserId: S.wiseTeacherUserId,
    scheduledEndAt: S.scheduledEndAt,
    deadlineAt: S.deadlineAt,
    evidence: S.evidence,
    arm: S.arm,
    fields: S.fields,
    fieldsSha256: S.fieldsSha256,
    billing: S.billing,
    sonioxTranscriptionId: S.sonioxTranscriptionId,
    metadata: S.metadata,
    firstShotPostId: P.id,
    firstShotPipeline: P.pipeline,
    firstShotStartedAt: P.postStartedAt,
    firstShotRecordedAt: P.recordedAt,
    reviewTutorKey: R.tutorKey,
    currentVerdictId: R.currentVerdictId,
    mirrorClassName: PC.className,
  }).from(S)
    .innerJoin(P, and(eq(P.wiseSessionId, S.wiseSessionId), eq(P.kind, "first_shot"), eq(P.actorKind, "autowriter")))
    .leftJoin(R, eq(R.wiseSessionId, S.wiseSessionId))
    .leftJoin(PC, eq(PC.wiseSessionId, S.wiseSessionId))
    .where(and(...conditions))
    .orderBy(desc(S.scheduledEndAt));
  if (rows.length === 0) return [];
  const ids = rows.map((row) => row.wiseSessionId);
  const verdicts = await db.select({ id: V.id, wiseSessionId: V.wiseSessionId, verdict: V.verdict })
    .from(V).where(inArray(V.wiseSessionId, ids)).orderBy(desc(V.createdAt));
  const ownerFlags = await db.select({ wiseSessionId: FL.wiseSessionId }).from(FL)
    .where(and(inArray(FL.wiseSessionId, ids), eq(FL.source, "owner"), isNull(FL.resolvedByVerdictId)));
  const saves = await db.select({ wiseSessionId: FX.wiseSessionId, eventAt: FX.eventAt }).from(FX)
    .where(and(inArray(FX.wiseSessionId, ids), inArray(FX.actorKind, [...HUMAN_SAVE_KINDS])));
  const flagged = new Set(ownerFlags.map((flag) => flag.wiseSessionId));
  const targets: NightlyTarget[] = [];
  for (const row of rows) {
    const target = targetFromRow(row, {
      verdicts: verdicts.filter((verdict) => verdict.wiseSessionId === row.wiseSessionId),
      ownerFlagOpen: flagged.has(row.wiseSessionId),
      humanSaves: saves.filter((save) => save.wiseSessionId === row.wiseSessionId).map((save) => save.eventAt),
    });
    if (target) targets.push(target);
  }
  return targets;
}

/** One line of the metadata-only audit ledger (`ledger.jsonl`) as far as selection reads it. */
interface AuditLedgerLine {
  type?: string;
  key?: string;
  verdict?: string | null;
}

/** Keys with a finished audit (any verdict, insufficient evidence included) in the audit ledger. */
export function auditedKeys(ledgerJsonl: string): Set<string> {
  const keys = new Set<string>();
  for (const line of readJsonl<AuditLedgerLine>(ledgerJsonl)) {
    if (line.type === "audit" && typeof line.key === "string" && typeof line.verdict === "string") keys.add(line.key);
  }
  return keys;
}

export interface TargetChoice {
  chosen: NightlyTarget[];
  skipped: Array<{ wiseSessionId: string; reason: "already_audited" | "failed_twice" | "over_cap" }>;
}

/**
 * The night's audit list: newest first, without texts already audited at this version or keys that failed twice,
 * capped at `maxTargets`.
 */
export function chooseTargets(input: {
  targets: readonly NightlyTarget[];
  audited: ReadonlySet<string>;
  failures: (key: string) => number;
  auditVersion: number;
  maxTargets: number;
}): TargetChoice {
  const choice: TargetChoice = { chosen: [], skipped: [] };
  const ordered = [...input.targets].sort((a, b) => b.scheduledEndAt.localeCompare(a.scheduledEndAt) || a.wiseSessionId.localeCompare(b.wiseSessionId));
  for (const target of ordered) {
    const key = auditKey({ wiseSessionId: target.wiseSessionId, fieldsSha256: target.fieldsSha256, auditVersion: input.auditVersion });
    if (input.audited.has(key)) choice.skipped.push({ wiseSessionId: target.wiseSessionId, reason: "already_audited" });
    else if (input.failures(key) >= 2) choice.skipped.push({ wiseSessionId: target.wiseSessionId, reason: "failed_twice" });
    else if (choice.chosen.length >= input.maxTargets) choice.skipped.push({ wiseSessionId: target.wiseSessionId, reason: "over_cap" });
    else choice.chosen.push(target);
  }
  return choice;
}
