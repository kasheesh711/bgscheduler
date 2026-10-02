import { and, eq, inArray, sql } from "drizzle-orm";
import type { Database } from "@/lib/db";
import * as schema from "@/lib/db/schema";
import type { PriorFeedbackComparison } from "@/lib/post-class-feedback/similarity";
import type { FeedbackFieldMapping } from "@/lib/post-class-feedback/types";
import {
  correctPostGuarded,
  inCorrectionWindow,
  type CorrectPostInput,
  type CorrectionOutcome,
  type CorrectionPlan,
  type CorrectionStore,
  type CorrectionWiseOps,
} from "../correction";
import { CORRECTION_STALE_AFTER_MS, isCorrectionLockReason, type CorrectionRecovery } from "../correction-store";
import { normalizeFields, postedBilling } from "../first-shot";
import { fieldsHash } from "../submit";
import type { BillingPlan } from "../types";
import { activeWiseCooldown, stopFilePresent, writeStopFile, writeWiseCooldown } from "./caps";
import { EXIT, NightlyStop, type ExitCode } from "./exit";
import { correctionFlagItem, type FlagPlanItem } from "./flags";
import type { NightlyLedger } from "./ledger";
import { appendJsonl, readJsonl } from "./paths";
import { readProposalFiles, verifyProposal, type CorrectionProposal, type HmacKeyResult } from "./proposals";
import { readBundleFile, stopBeforeStep, type BundleFile, type NightContext, type StepResult } from "./steps";
import { correctionTextProblems } from "./text-problems";
import { textProblemContext } from "./verify";

/**
 * `correct` and `recover` (quick 261003-12b): the nightly's only Wise write, through the guarded executor
 * (`correctPostGuarded`), from signed proposals only.
 *
 * - Every proposal's signature is checked before anything else; one that fails refuses the whole run.
 * - The plan is built from the DATABASE: the first-shot posts row (its text, hash, billing and `post_started_at`),
 *   the session row (`metadata.expected.submissionId`, class, teacher) and the field mappings production loads. A
 *   proposal contributes only the corrected text and its stamps — never a Wise id.
 * - A dry run unless `--apply`; `--apply` runs only from a clean checkout of `origin/main`, or with `--supervised` (the
 *   owner-watched first run, recorded as such).
 * - One class at a time: STOP before each class, the executor's own dry run (reads only) first, then — applying —
 *   the next correction window (`inCorrectionWindow`, waited for up to 6 minutes, never past the deadline), the
 *   night (6) and 7-day (15) caps reserved in the ledger, and the one guarded POST.
 * - Verified (or still awaiting its event): an `agent` flag puts the class back in the owner's review list. A safety
 *   outcome stops everything (exit 10, STOP written; the executor leaves the autowriter halted). An event still
 *   missing with the lock kept (`awaiting_event_locked`) stops the night's corrections: `recover` settles it later.
 */

export const CORRECTION_WINDOW_MAX_WAIT_MS = 6 * 60_000;
/** Longest single sleep while waiting for a window (STOP is checked between). */
const WAIT_SLICE_MS = 30_000;
/** Outcomes after which a class is not tried again tonight. */
const FINAL_APPLY_STATUSES = new Set(["verified", "awaiting_event", "awaiting_event_locked", "not_sent", "safety", "error"]);
/** Outcomes whose text is (or may be) in Wise: the owner reviews the class again. */
const LANDED_STATUSES = new Set(["verified", "awaiting_event", "awaiting_event_locked"]);

// ---------------------------------------------------------------------------
// Database reads (SELECT only)
// ---------------------------------------------------------------------------

const S = schema.feedbackAutowriterSessions;
const P = schema.feedbackAutowriterPosts;
const C = schema.feedbackAutowriterControl;

export interface CorrectionRows {
  session: {
    wiseClassId: string | null;
    wiseTeacherUserId: string | null;
    state: string;
    fieldsSha256: string | null;
    metadata: Record<string, unknown>;
  } | null;
  firstShot: {
    wiseClassId: string | null;
    wiseTeacherUserId: string | null;
    fields: unknown;
    fieldsSha256: string;
    billing: unknown;
    postStartedAt: Date | null;
    outcome: string;
    verification: Record<string, unknown>;
  } | null;
}

/** The session row and the autowriter's own first-shot posts row of a class. */
export async function loadCorrectionRows(db: Database, wiseSessionId: string): Promise<CorrectionRows> {
  const [session] = await db.select({
    wiseClassId: S.wiseClassId, wiseTeacherUserId: S.wiseTeacherUserId, state: S.state, fieldsSha256: S.fieldsSha256, metadata: S.metadata,
  }).from(S).where(eq(S.wiseSessionId, wiseSessionId)).limit(1);
  const [firstShot] = await db.select({
    wiseClassId: P.wiseClassId, wiseTeacherUserId: P.wiseTeacherUserId, fields: P.fields, fieldsSha256: P.fieldsSha256, billing: P.billing,
    postStartedAt: P.postStartedAt, outcome: P.outcome, verification: P.verification,
  }).from(P).where(and(eq(P.wiseSessionId, wiseSessionId), eq(P.kind, "first_shot"), eq(P.actorKind, "autowriter"))).limit(1);
  return { session: session ?? null, firstShot: firstShot ?? null };
}

/** The tutors switched off on the control row (a SELECT: never creates the row). */
export async function loadDisabledTutors(db: Database): Promise<string[] | null> {
  const [row] = await db.select({ disabledTutors: C.disabledTutors }).from(C).where(eq(C.id, "default")).limit(1);
  return row ? row.disabledTutors : null;
}

export interface UnsettledCorrections {
  /** Agent corrections still `posting` or `awaiting_event` (`stale`: older than recovery's threshold). */
  rows: Array<{ postId: string; wiseSessionId: string; outcome: string; stale: boolean }>;
  /**
   * The control row halted by a correction lock: `live` (a correction holds it now), `stale` (its run is gone:
   * `recover --apply` lifts it once nothing is unsettled), or `halted_on_top` (an anomaly or a person halted the
   * autowriter on top of the lock: only a person resumes it).
   */
  lock: { state: "live" | "stale" | "halted_on_top"; wiseSessionId: string | null } | null;
  /** Whether `releaseStaleCorrectionLock` would lift the lock now. */
  releasable: boolean;
}

const LOCK_PREFIX = "correction-lock:";

/** What a run left unsettled (reads only): the dry run of `recover`, and the check `preflight` and `correct` make. */
export async function unsettledCorrections(db: Database, opts: { staleAfterMs?: number } = {}): Promise<UnsettledCorrections> {
  const staleAfterMs = opts.staleAfterMs ?? CORRECTION_STALE_AFTER_MS;
  const rows = await db.select({
    postId: P.id,
    wiseSessionId: P.wiseSessionId,
    outcome: P.outcome,
    stale: sql<boolean>`coalesce(${P.postStartedAt}, ${P.recordedAt}) < now() - (${staleAfterMs} * interval '1 millisecond')`,
  }).from(P).where(and(eq(P.kind, "correction"), eq(P.actorKind, "agent"), inArray(P.outcome, ["posting", "awaiting_event"])));
  const [control] = await db.select({
    haltReason: C.haltReason,
    leaseToken: sql<string | null>`${C.leaseToken}::text`,
    leaseLive: sql<boolean>`coalesce(${C.leaseUntil} > now(), false)`,
  }).from(C).where(eq(C.id, "default")).limit(1);
  let lock: UnsettledCorrections["lock"] = null;
  const reason = control?.haltReason ?? null;
  if (reason?.startsWith(LOCK_PREFIX)) {
    const token = /^correction-lock:([0-9a-f-]{36})/u.exec(reason)?.[1] ?? null;
    const live = control?.leaseLive === true && token !== null && control.leaseToken === token;
    lock = {
      state: !isCorrectionLockReason(reason) ? "halted_on_top" : live ? "live" : "stale",
      wiseSessionId: /nightly agent correcting ([0-9a-f]{24})/u.exec(reason)?.[1] ?? null,
    };
  }
  const settledRows = rows.map((row) => ({ ...row, stale: row.stale === true }));
  return { rows: settledRows, lock, releasable: lock?.state === "stale" && settledRows.length === 0 };
}

// ---------------------------------------------------------------------------
// The plan, from the database
// ---------------------------------------------------------------------------

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/**
 * The executor's plan: ids, the base text, its submission, billing and first-shot time from the database rows;
 * from the proposal only the corrected text, its reason, root cause and stamps. Refusal codes otherwise.
 */
export function planFromRows(proposal: CorrectionProposal, rows: CorrectionRows, mappings: readonly FeedbackFieldMapping[]):
  { ok: true; plan: CorrectionPlan } | { ok: false; reason: string } {
  const no = (reason: string) => ({ ok: false as const, reason });
  const { session, firstShot } = rows;
  if (!session) return no("session_missing");
  if (session.state !== "verified") return no(`session_not_verified:${session.state}`);
  if (!firstShot) return no("no_first_shot");
  if (firstShot.outcome !== "verified") return no(`first_shot_not_verified:${firstShot.outcome}`);
  const baseFields = normalizeFields(isRecord(firstShot.fields) ? firstShot.fields : {});
  if (fieldsHash(baseFields) !== firstShot.fieldsSha256) return no("base_hash_mismatch");
  if (session.fieldsSha256 !== firstShot.fieldsSha256) return no("base_not_first_shot");
  // The proposal was verified against exactly this text.
  if (proposal.fieldsSha256 !== firstShot.fieldsSha256) return no("proposal_stale");
  if (fieldsHash(proposal.fields) !== proposal.fieldsHash) return no("candidate_hash_mismatch");
  if (proposal.fieldsHash === firstShot.fieldsSha256) return no("no_change");
  if (!proposal.rootCauseRef?.trim()) return no("root_cause_ref_missing");
  const expected = isRecord(session.metadata.expected) ? session.metadata.expected : null;
  const submissionId = expected?.kind === "auto_blank" && typeof expected.submissionId === "string" && expected.submissionId ? expected.submissionId : null;
  if (!submissionId) return no("submission_unknown");
  const recorded = firstShot.verification.submissionId;
  if (typeof recorded === "string" && recorded !== submissionId) return no("submission_mismatch");
  const billing = postedBilling(firstShot.billing);
  if (!billing) return no("billing_unknown");
  const stored = isRecord(firstShot.billing) ? firstShot.billing : {};
  const plan: BillingPlan = {
    ...billing,
    source: stored.source === "prior_submissions" ? "prior_submissions" : "auto_blank_reuse",
    expectedConsumedDelta: typeof stored.expectedConsumedDelta === "number" ? stored.expectedConsumedDelta : 0,
  };
  const wiseClassId = session.wiseClassId ?? firstShot.wiseClassId;
  if (!wiseClassId) return no("class_unknown");
  if (session.wiseClassId && firstShot.wiseClassId && session.wiseClassId !== firstShot.wiseClassId) return no("class_mismatch");
  const wiseTeacherUserId = session.wiseTeacherUserId;
  if (!wiseTeacherUserId) return no("teacher_unknown");
  if (firstShot.wiseTeacherUserId && firstShot.wiseTeacherUserId !== wiseTeacherUserId) return no("teacher_mismatch");
  if (!firstShot.postStartedAt) return no("first_shot_time_unknown");
  return {
    ok: true,
    plan: {
      wiseSessionId: proposal.wiseSessionId,
      wiseClassId,
      wiseTeacherUserId,
      base: { fields: baseFields, fieldsSha256: firstShot.fieldsSha256, submissionId, billing: plan, firstShotPostedAt: firstShot.postStartedAt },
      fields: normalizeFields(proposal.fields),
      fieldsSha256: proposal.fieldsHash,
      reason: proposal.reason,
      rootCauseRef: proposal.rootCauseRef,
      pipeline: { ...proposal.pipeline, proposalSource: proposal.source, proposalCreatedAt: proposal.createdAt, modes: proposal.modes },
      evidence: proposal.evidence,
      arm: proposal.arm,
      mappings,
    },
  };
}

// ---------------------------------------------------------------------------
// Wise access with the kill switches
// ---------------------------------------------------------------------------

function statusOf(error: unknown): number | null {
  const status = (error as { status?: unknown } | null)?.status;
  return typeof status === "number" ? status : null;
}

/**
 * The Wise ops with both STOP files checked before every read (a read refused by STOP fails like any read), and a
 * note of any 429 seen. The one POST passes through: the executor checks STOP right before it, and a POST refused
 * after the posts row was recorded would only look like an unknown outcome.
 */
export function guardedWiseOps(base: CorrectionWiseOps, stopFiles: readonly string[]): { ops: CorrectionWiseOps; throttled: () => boolean } {
  let throttled = false;
  const read = <T>(fn: () => Promise<T>): Promise<T> => {
    const stop = stopFilePresent(stopFiles);
    if (stop) return Promise.reject(new Error(`Kill switch present: ${stop}`));
    return fn().catch((error: unknown) => {
      if (statusOf(error) === 429) throttled = true;
      throw error;
    });
  };
  return {
    ops: {
      getSessionDetail: (classId, sessionId) => read(() => base.getSessionDetail(classId, sessionId)),
      getSessionCreditEntries: (classId, studentId, sessionId) => read(() => base.getSessionCreditEntries(classId, studentId, sessionId)),
      findFeedbackEvents: (classId, sessionId, since) => read(() => base.findFeedbackEvents(classId, sessionId, since)),
      postFeedback: async (classId, sessionId, body) => {
        const result = await base.postFeedback(classId, sessionId, body);
        if (result.kind === "rate_limited") throttled = true;
        return result;
      },
    },
    throttled: () => throttled,
  };
}

/** Milliseconds until the next correction window opens (0 inside one). */
export function msUntilCorrectionWindow(now: Date): number {
  if (inCorrectionWindow(now)) return 0;
  const intoHour = now.getUTCMinutes() * 60_000 + now.getUTCSeconds() * 1_000 + now.getUTCMilliseconds();
  const next = [10, 40, 70].map((minute) => minute * 60_000).find((start) => start > intoHour)!;
  return next - intoHour;
}

// ---------------------------------------------------------------------------
// correct
// ---------------------------------------------------------------------------

export interface CodeFacts {
  head: string | null;
  branch: string | null;
  originMain: string | null;
  dirty: boolean;
}

export interface CorrectDeps {
  apply: boolean;
  supervised: boolean;
  code: CodeFacts | null;
  hmacKey: HmacKeyResult;
  ledger: Pick<NightlyLedger, "reserve" | "settle" | "used" | "correctionsSince">;
  ops: CorrectionWiseOps;
  /** A Wise 429 was seen (through `guardedWiseOps`). */
  throttled: () => boolean;
  store: CorrectionStore;
  apiActorId: string | null;
  allowlist: ReadonlySet<string>;
  loadRows: (wiseSessionId: string) => Promise<CorrectionRows>;
  loadMappings: () => Promise<FeedbackFieldMapping[]>;
  loadDisabledTutors: () => Promise<string[] | null>;
  unsettled: () => Promise<UnsettledCorrections>;
  /** The tutor's prior feedback and other students' names, for the text checks. */
  textContext: (file: BundleFile) => Promise<{ priorFeedback: PriorFeedbackComparison[]; otherStudentNames: string[] }>;
  /** The `agent` flag after a correction (production: `applyAgentFlags`). */
  raiseFlag: (item: FlagPlanItem) => Promise<{ inserted: number; existing: number }>;
  /** The executor (tests may wrap it). */
  execute?: (input: CorrectPostInput) => Promise<CorrectionOutcome>;
  sleep?: (ms: number) => Promise<void>;
  sessionIds?: readonly string[];
  /** At most this many corrections in this run (applying). */
  max?: number | null;
  maxWindowWaitMs?: number;
}

interface CorrectionLine {
  at: string;
  night: string;
  wiseSessionId: string;
  dryRun: boolean;
  supervised: boolean;
  status: string;
  stage?: string;
  reason?: string;
  postId?: string | null;
  guards?: string[];
  problems?: string[];
  productionStillHalted?: boolean;
  flag?: string;
  source?: string;
  modes?: string[];
  fieldsHash?: string;
}

function lineOf(outcome: CorrectionOutcome): Pick<CorrectionLine, "status" | "stage" | "reason" | "postId" | "guards" | "problems" | "productionStillHalted"> {
  // Typed loosely on purpose: the executor's outcome set grows (e.g. `awaiting_event_locked`) and must still be logged.
  const loose = outcome as unknown as Record<string, unknown>;
  const status = String(loose.status);
  const productionStillHalted = loose.productionStillHalted === true || status === "safety" || status === "awaiting_event_locked";
  return {
    status,
    ...(typeof loose.stage === "string" ? { stage: loose.stage } : {}),
    ...(typeof loose.reason === "string" ? { reason: loose.reason } : {}),
    ...(typeof loose.postId === "string" || loose.postId === null ? { postId: loose.postId as string | null } : {}),
    ...(Array.isArray(loose.guards) ? { guards: loose.guards as string[] } : {}),
    ...(Array.isArray(loose.problems) ? { problems: loose.problems as string[] } : {}),
    productionStillHalted,
  };
}

/** Classes whose correction was attempted for real tonight with a final outcome (never tried again tonight). */
function finishedTonight(ctx: NightContext): Map<string, string> {
  const done = new Map<string, string>();
  for (const line of readJsonl<CorrectionLine>(ctx.paths.correctionsJsonl)) {
    if (line.night === ctx.night && line.dryRun === false && FINAL_APPLY_STATUSES.has(line.status)) done.set(line.wiseSessionId, line.status);
  }
  return done;
}

/** Wait for the next correction window: STOP and the deadline checked between short sleeps. */
async function waitForWindow(ctx: NightContext, deps: CorrectDeps): Promise<NightlyStop | null> {
  const sleep = deps.sleep ?? ((ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms)));
  const maxWait = deps.maxWindowWaitMs ?? CORRECTION_WINDOW_MAX_WAIT_MS;
  const first = msUntilCorrectionWindow(ctx.now());
  if (first > maxWait) return new NightlyStop("outside_window", EXIT.stopped);
  for (;;) {
    const now = ctx.now();
    const wait = msUntilCorrectionWindow(now);
    if (wait === 0) return null;
    if (ctx.deadline && now.getTime() + wait >= ctx.deadline.getTime()) return new NightlyStop("deadline", EXIT.stopped);
    const stop = stopBeforeStep(ctx);
    if (stop) return stop;
    await sleep(Math.min(wait, WAIT_SLICE_MS));
  }
}

function codeRefusal(deps: Pick<CorrectDeps, "apply" | "supervised" | "code">): string | null {
  if (!deps.apply || deps.supervised) return null;
  if (!deps.code?.head || !deps.code.originMain) return "code_unknown";
  if (deps.code.head !== deps.code.originMain) return "not_origin_main";
  if (deps.code.dirty) return "dirty_tree";
  return null;
}

/** `correct`: see the module comment. */
export async function stepCorrect(ctx: NightContext, deps: CorrectDeps): Promise<StepResult> {
  const execute = deps.execute ?? correctPostGuarded;
  const lines: CorrectionLine[] = [];
  const base = {
    step: "correct", night: ctx.night, dryRun: !deps.apply, supervised: deps.supervised,
    code: deps.code ? { head: deps.code.head, branch: deps.code.branch, originMain: deps.code.originMain, dirty: deps.code.dirty } : null,
  };
  const finish = (input: { ok?: boolean; stop?: string | null; exitCode?: ExitCode; next?: string | null; extra?: Record<string, unknown> } = {}): StepResult => {
    const counts: Record<string, number> = {};
    for (const line of lines) counts[line.status] = (counts[line.status] ?? 0) + 1;
    return {
      ok: input.ok ?? true,
      stop: input.stop ?? null,
      next: input.next ?? null,
      exitCode: input.exitCode ?? EXIT.ok,
      summary: {
        ...base,
        outcomes: counts,
        productionStillHalted: lines.some((line) => line.productionStillHalted === true),
        classes: lines.map((line) => ({
          wiseSessionId: line.wiseSessionId, status: line.status, stage: line.stage, reason: line.reason, postId: line.postId, guards: line.guards,
          problems: line.problems, productionStillHalted: line.productionStillHalted, flag: line.flag, source: line.source, modes: line.modes,
        })),
        ...input.extra,
      },
    };
  };
  const refuse = (stop: string, exitCode: ExitCode, extra: Record<string, unknown> = {}) => finish({ ok: false, stop, exitCode, next: "correct", extra });

  const code = codeRefusal(deps);
  if (code) return refuse(code, EXIT.guardRefused);
  const early = stopBeforeStep(ctx);
  if (early) return refuse(early.reason, early.exitCode);
  if (activeWiseCooldown(ctx.now(), ctx.home)) return refuse("wise_cooldown", EXIT.wiseThrottled);
  if (!deps.hmacKey.ok) return refuse(deps.hmacKey.reason, EXIT.guardRefused);
  if (deps.apply && !deps.apiActorId) return refuse("api_actor_missing", EXIT.usage);

  // Every proposal's signature first: one that does not verify refuses the run.
  const wanted = deps.sessionIds && deps.sessionIds.length > 0 ? new Set(deps.sessionIds) : null;
  const files = readProposalFiles(ctx.paths.proposalsDir).filter((entry) => !wanted || wanted.has(entry.wiseSessionId));
  const proposals: CorrectionProposal[] = [];
  const invalid: Array<{ wiseSessionId: string; reason: string }> = [];
  for (const entry of files) {
    const verified = verifyProposal(entry.value, deps.hmacKey.key);
    if (!verified.ok) invalid.push({ wiseSessionId: entry.wiseSessionId, reason: verified.reason });
    else if (verified.proposal.wiseSessionId !== entry.wiseSessionId) invalid.push({ wiseSessionId: entry.wiseSessionId, reason: "file_name_mismatch" });
    else if (verified.proposal.night !== ctx.night) invalid.push({ wiseSessionId: entry.wiseSessionId, reason: "night_mismatch" });
    else proposals.push(verified.proposal);
  }
  if (invalid.length > 0) return refuse("proposal_invalid", EXIT.guardRefused, { invalid });
  if (proposals.length === 0) return finish({ extra: { proposals: 0 } });

  // Anything a run left unsettled is settled by `recover` first.
  const unsettled = await deps.unsettled();
  const unsettledSummary = { rows: unsettled.rows.length, lock: unsettled.lock };
  if (unsettled.rows.length > 0 || unsettled.lock) {
    return refuse("unsettled_correction", EXIT.guardRefused, { unsettled: unsettledSummary, proposals: proposals.length });
  }

  const mappings = await deps.loadMappings();
  const done = finishedTonight(ctx);
  let applied = 0;
  const record = (line: Omit<CorrectionLine, "at" | "night" | "dryRun" | "supervised">): CorrectionLine => {
    const full: CorrectionLine = { at: ctx.now().toISOString(), night: ctx.night, dryRun: !deps.apply, supervised: deps.supervised, ...line };
    appendJsonl(ctx.paths.correctionsJsonl, full);
    lines.push(full);
    ctx.log?.(`correct ${line.wiseSessionId}: ${line.status}${line.stage ? ` (${line.stage}: ${line.reason})` : line.reason ? ` (${line.reason})` : ""}`);
    return full;
  };
  const stopOn = (stop: NightlyStop, next = "correct") =>
    finish({ ok: false, stop: stop.reason, exitCode: stop.exitCode, next, extra: { proposals: proposals.length } });

  for (const proposal of proposals) {
    const sid = proposal.wiseSessionId;
    const about = { wiseSessionId: sid, source: proposal.source, modes: proposal.modes, fieldsHash: proposal.fieldsHash };
    const stop = stopBeforeStep(ctx);
    if (stop) return stopOn(stop);
    if (deps.apply && typeof deps.max === "number" && applied >= deps.max) return finish({ stop: "max_reached", next: "correct", extra: { proposals: proposals.length } });
    if (deps.apply) {
      if (deps.ledger.used("correction").count >= ctx.caps.maxCorrectionsPerNight) return stopOn(new NightlyStop("cap:corrections_night", EXIT.caps));
      if (deps.ledger.correctionsSince(7) >= ctx.caps.maxCorrectionsPerWeek) return stopOn(new NightlyStop("cap:corrections_week", EXIT.caps));
    }
    const finished = done.get(sid);
    if (finished) {
      record({ ...about, status: "skipped", reason: `already_${finished}` });
      continue;
    }

    // The plan, from the database.
    const planned = planFromRows(proposal, await deps.loadRows(sid), mappings);
    if (!planned.ok) {
      record({ ...about, status: "refused", stage: "plan", reason: planned.reason });
      continue;
    }
    const bundle = readBundleFile(ctx.paths, sid);
    if (!bundle) {
      record({ ...about, status: "refused", stage: "plan", reason: "bundle_missing" });
      continue;
    }
    if (bundle.target.fieldsSha256 !== planned.plan.base.fieldsSha256) {
      record({ ...about, status: "refused", stage: "plan", reason: "bundle_stale" });
      continue;
    }
    const context = textProblemContext(bundle, await deps.textContext(bundle));
    if (!context) {
      record({ ...about, status: "refused", stage: "plan", reason: "student_unknown" });
      continue;
    }
    const disabledTutors = await deps.loadDisabledTutors();
    if (!disabledTutors) {
      record({ ...about, status: "refused", stage: "db", reason: "control_row_missing" });
      continue;
    }
    const input: CorrectPostInput = {
      ops: deps.ops,
      store: deps.store,
      plan: planned.plan,
      apiActorId: deps.apiActorId ?? "",
      allowlist: deps.allowlist,
      disabledTutors,
      // Production's validators with this class's own post left out of the copy check, meta words and identity.
      textProblems: (fields) => correctionTextProblems({ ...context, fields: { ...fields } })
        .map((problem) => `${problem.code}${problem.field ? `@${problem.field}` : ""}`),
      now: ctx.now,
      ...(deps.sleep ? { sleep: deps.sleep } : {}),
      stopRequested: () => stopFilePresent(ctx.stopFiles) !== null,
    };

    // Every guard, reads only (also when applying: a refused class never waits for a window or takes the cap).
    const preflight = await execute({ ...input, dryRun: true });
    if (preflight.status !== "preflight_ok" || !deps.apply) {
      record({ ...about, ...lineOf(preflight) });
      if (deps.throttled()) return stopOn(new NightlyStop("wise_429", EXIT.wiseThrottled));
      continue;
    }

    const waited = await waitForWindow(ctx, deps);
    if (waited) return stopOn(waited);
    const beforePost = stopBeforeStep(ctx);
    if (beforePost) return stopOn(beforePost);
    const reserved = deps.ledger.reserve("correction", { key: `correction:${sid}`, estimateUsd: 0 });
    if (!reserved.ok) return stopOn(new NightlyStop(reserved.reason, EXIT.caps));
    applied += 1;
    let outcome: CorrectionOutcome;
    try {
      outcome = await execute({ ...input, dryRun: false });
    } catch (error) {
      // The database failed while the lock was held: the autowriter may be halted. A person must look.
      deps.ledger.settle(reserved.id, { actualUsd: 0, outcome: "error" });
      record({ ...about, status: "error", reason: `executor_threw:${error instanceof Error ? error.name : "Error"}`, productionStillHalted: true });
      writeStopFile(`nightly correction of ${sid} threw while holding the lock: run recover, check the autowriter`, ctx.home, ctx.now());
      return stopOn(new NightlyStop("correction_error", EXIT.safety));
    }
    const line = lineOf(outcome);
    deps.ledger.settle(reserved.id, { actualUsd: 0, outcome: line.status });
    let flag: string | undefined;
    if (LANDED_STATUSES.has(line.status)) {
      try {
        const raised = await deps.raiseFlag(correctionFlagItem({
          wiseSessionId: sid, fieldsSha256: proposal.fieldsHash, modes: proposal.modes, severity: proposal.severity,
          criticalCategory: proposal.criticalCategory,
        }));
        flag = raised.inserted > 0 ? "raised" : "existing";
      } catch (error) {
        flag = `failed:${error instanceof Error ? error.name : "Error"}`;
      }
    }
    record({ ...about, ...line, ...(flag ? { flag } : {}) });

    if (line.status === "safety") {
      writeStopFile(`nightly correction of ${sid} ended in a safety stop: the autowriter is halted; check the class in Wise`, ctx.home, ctx.now());
      return stopOn(new NightlyStop("safety", EXIT.safety));
    }
    // Our event is not in Wise yet and the lock is kept: no other correction tonight; `recover` settles it later.
    if (line.status === "awaiting_event_locked") return stopOn(new NightlyStop("awaiting_event_locked", EXIT.stopped), "recover");
    if (line.status === "not_sent") {
      writeWiseCooldown(ctx.now(), ctx.home);
      return stopOn(new NightlyStop("wise_429", EXIT.wiseThrottled));
    }
    if (flag?.startsWith("failed:")) return stopOn(new NightlyStop("flag_failed", EXIT.error));
    if (line.status === "refused" && /daily_cap/u.test(line.reason ?? "")) return stopOn(new NightlyStop("cap:daily_db", EXIT.caps));
    if (deps.throttled()) return stopOn(new NightlyStop("wise_429", EXIT.wiseThrottled));
  }
  return finish({ extra: { proposals: proposals.length } });
}

// ---------------------------------------------------------------------------
// recover
// ---------------------------------------------------------------------------

export interface RecoverDeps {
  apply: boolean;
  supervised: boolean;
  code: CodeFacts | null;
  unsettled: () => Promise<UnsettledCorrections>;
  /** `recoverStaleCorrections` (Wise reads only, never a POST). */
  recover: () => Promise<CorrectionRecovery[]>;
  /** `releaseStaleCorrectionLock`. */
  release: () => Promise<boolean>;
}

/**
 * `recover`: settle agent corrections a dead run left unsettled from what Wise shows, then lift a correction lock its
 * run left behind. A dry run (reads only, no Wise) unless `--apply`; applying needs the same checkout as `correct`.
 */
export async function stepRecover(ctx: NightContext, deps: RecoverDeps): Promise<StepResult> {
  const before = await deps.unsettled();
  const describe = (state: UnsettledCorrections) => ({
    rows: state.rows.map((row) => ({ postId: row.postId, wiseSessionId: row.wiseSessionId, outcome: row.outcome, stale: row.stale })),
    lock: state.lock,
    releasable: state.releasable,
  });
  const summary: Record<string, unknown> = { step: "recover", night: ctx.night, dryRun: !deps.apply, supervised: deps.supervised, before: describe(before) };
  const nothing = before.rows.length === 0 && before.lock === null;
  if (!deps.apply) {
    return { ok: true, stop: null, next: nothing ? null : "recover --apply", exitCode: EXIT.ok, summary };
  }
  const code = codeRefusal(deps);
  if (code) return { ok: false, stop: code, next: "recover", exitCode: EXIT.guardRefused, summary };
  if (stopFilePresent(ctx.stopFiles)) return { ok: false, stop: "stop_file", next: "recover", exitCode: EXIT.stopped, summary };
  if (nothing) return { ok: true, stop: null, next: null, exitCode: EXIT.ok, summary };
  const results = await deps.recover();
  const released = await deps.release();
  const after = await deps.unsettled();
  summary.results = results.map((item) => ({ postId: item.postId, wiseSessionId: item.wiseSessionId, result: item.result, problems: item.problems }));
  summary.released = released;
  summary.after = describe(after);
  summary.productionStillHalted = after.lock !== null;
  if (results.some((item) => item.result === "safety")) {
    writeStopFile("nightly recover found a correction it could not settle safely: the autowriter is halted", ctx.home, ctx.now());
    return { ok: false, stop: "safety", next: null, exitCode: EXIT.safety, summary };
  }
  if (after.rows.length > 0 || after.lock) {
    const readFailed = results.some((item) => item.result === "read_failed");
    return { ok: false, stop: readFailed ? "read_failed" : "still_unsettled", next: "recover --apply", exitCode: readFailed ? EXIT.error : EXIT.guardRefused, summary };
  }
  return { ok: true, stop: null, next: null, exitCode: EXIT.ok, summary };
}

/** For `preflight`: how many corrections are unsettled and whether a correction lock was left (reads only). */
export function preflightCorrections(state: UnsettledCorrections): { unsettled: number; lock: string | null } {
  return { unsettled: state.rows.length, lock: state.lock ? state.lock.state : null };
}
