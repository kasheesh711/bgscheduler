import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { DEFAULT_FEEDBACK_FIELD_MAPPINGS } from "@/lib/post-class-feedback/wise";
import { API_ACTOR, BASE, CORRECTED, clock as executorClock, fakeWise } from "../../__tests__/correction-fixtures";
import { CLASS_ID, SESSION_ID, STUDENT_NAME, SUBMISSION_ID } from "../../__tests__/fixtures";
import type { CorrectPostInput, CorrectionOutcome, CorrectionStore } from "../../correction";
import { AUTOWRITER_TEACHER_ALLOWLIST, KEVIN_ONLINE_WISE_USER_ID } from "../../roster";
import { fieldsHash } from "../../submit";
import { AUDIT_VERSION } from "../audit-schema";
import { NIGHTLY_CAPS, activeWiseCooldown, type NightlyCaps } from "../caps";
import {
  guardedWiseOps,
  msUntilCorrectionWindow,
  planFromRows,
  runStopForRefusal,
  stepCorrect,
  stepRecover,
  type CorrectDeps,
  type CorrectionRows,
  type RecoverDeps,
  type UnsettledCorrections,
} from "../correct-step";
import { NightlyLedger } from "../ledger";
import { nightlyPaths, readJsonl, writeJsonAtomic } from "../paths";
import { signProposal, writeProposal, type CorrectionProposal } from "../proposals";
import type { BundleFile, NightContext } from "../steps";
import { CID, PIM_CORRECTED, PIM_FIELDS, SID, correctionProposal, nightlyBundle, nightlyTarget } from "./nightly-fixtures";

/** Synthetic people, lessons and ids only (the repository is public). */
const SID_B = "6a0000000000000000000a02";
const NIGHT = "2026-10-02";
const KEY = Buffer.alloc(32, 5);
const SUBMISSION = "6a00000000000000000000d1";
const FIRST_SHOT_AT = new Date("2026-10-02T09:40:00.000Z");
const BILLING = { sessionStatus: "COMPLETED", creditsConsumed: 1, source: "auto_blank_reuse", expectedConsumedDelta: 0 };
/** 06:11 Bangkok on the morning after the night: UTC minute 11, inside a correction window. */
const IN_WINDOW = new Date("2026-10-02T23:11:00.000Z");

let dir: string;
let clock: number;

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), "nightly-correct-"));
  clock = IN_WINDOW.getTime();
});

afterEach(() => {
  fs.rmSync(dir, { recursive: true, force: true });
});

function context(caps: Partial<NightlyCaps> = {}, patch: Partial<NightContext> = {}): NightContext {
  return {
    night: NIGHT,
    paths: nightlyPaths(path.join(dir, "state"), NIGHT),
    caps: { ...NIGHTLY_CAPS, ...caps },
    now: () => new Date(clock),
    deadline: new Date("2026-10-02T23:50:00.000Z"),
    stopFiles: [path.join(dir, "STOP")],
    home: dir,
    ...patch,
  };
}

function rows(patch: { session?: Partial<NonNullable<CorrectionRows["session"]>> | null; firstShot?: Partial<NonNullable<CorrectionRows["firstShot"]>> | null } = {}): CorrectionRows {
  return {
    session: patch.session === null ? null : {
      wiseClassId: CID, wiseTeacherUserId: KEVIN_ONLINE_WISE_USER_ID, state: "verified", fieldsSha256: fieldsHash(PIM_FIELDS),
      metadata: { expected: { kind: "auto_blank", submissionId: SUBMISSION, sessionStatus: "COMPLETED", creditsConsumed: 1 } },
      ...patch.session,
    },
    firstShot: patch.firstShot === null ? null : {
      wiseClassId: CID, wiseTeacherUserId: KEVIN_ONLINE_WISE_USER_ID, fields: PIM_FIELDS, fieldsSha256: fieldsHash(PIM_FIELDS), billing: BILLING,
      postStartedAt: FIRST_SHOT_AT, outcome: "verified", verification: { submissionId: SUBMISSION }, ...patch.firstShot,
    },
  };
}

/** A signed proposal and the class's bundle, as `verify` and `collect` left them. */
function seed(ctx: NightContext, proposal: CorrectionProposal = correctionProposal(), key = KEY): void {
  writeProposal(ctx.paths.proposalsDir, proposal, key);
  const file: BundleFile = {
    target: nightlyTarget({ wiseSessionId: proposal.wiseSessionId, fieldsSha256: fieldsHash(PIM_FIELDS) }),
    bundle: nightlyBundle({ wiseSessionId: proposal.wiseSessionId }),
    prechecks: [], notes: [],
    status: { collectedAt: "", rowMeta: "read", iseb: "not_guided", detail: "fetched", soniox: "fetched", zoom: "none", retranscribe: "not_needed" },
    collectedAt: "",
  };
  writeJsonAtomic(path.join(ctx.paths.bundlesDir, `${proposal.wiseSessionId}.json`), file);
}

const NOTHING_UNSETTLED: UnsettledCorrections = { rows: [], lock: null, releasable: false };

/** A store the step itself must never touch (only the executor uses it). */
function untouchableStore(): CorrectionStore {
  const fail = async (): Promise<never> => {
    throw new Error("the step must not use the store itself");
  };
  return { preconditions: fail, lock: fail, databaseNow: fail, recordPostStart: fail, settle: fail, halt: fail, incident: fail };
}

function harness(ctx: NightContext, patch: Partial<CorrectDeps> & { outcome?: (input: CorrectPostInput) => CorrectionOutcome } = {}) {
  const log: string[] = [];
  const ledger = NightlyLedger.open(ctx.paths.root, NIGHT, ctx.caps, { now: () => new Date(clock) });
  const execute = vi.fn(async (input: CorrectPostInput): Promise<CorrectionOutcome> => {
    log.push(`${input.dryRun ? "dry" : "apply"}:${input.plan.wiseSessionId}@${new Date(clock).toISOString().slice(11, 19)}`);
    if (input.dryRun) return { status: "preflight_ok", bodyHash: "body", guards: ["plan", "window (not enforced: dry run outside the window)", "db_preconditions"] };
    return patch.outcome?.(input) ?? { status: "verified", postId: `post-${input.plan.wiseSessionId}`, bodyHash: "body" };
  });
  const raiseFlag = vi.fn<CorrectDeps["raiseFlag"]>(async () => ({ inserted: 1, existing: 0 }));
  const sleep = vi.fn(async (ms: number) => {
    clock += ms;
  });
  const deps: CorrectDeps = {
    apply: false,
    supervised: false,
    code: { head: "c0ffee", branch: "main", originMain: "c0ffee", dirty: false },
    hmacKey: { ok: true, key: KEY, created: false },
    ledger,
    ops: { getSessionDetail: vi.fn(), getSessionCreditEntries: vi.fn(), findFeedbackEvents: vi.fn(), postFeedback: vi.fn() },
    throttled: () => false,
    store: untouchableStore(),
    apiActorId: "69366668c05630afe5d8a2a4",
    allowlist: AUTOWRITER_TEACHER_ALLOWLIST,
    loadRows: vi.fn(async () => rows()),
    loadMappings: async () => [...DEFAULT_FEEDBACK_FIELD_MAPPINGS],
    loadDisabledTutors: async () => [],
    unsettled: async () => NOTHING_UNSETTLED,
    textContext: async () => ({ priorFeedback: [], otherStudentNames: [] }),
    raiseFlag,
    execute,
    sleep,
    ...patch,
  };
  return { deps, execute, raiseFlag, sleep, log, ledger };
}

describe("planFromRows: the plan comes from the database", () => {
  it("takes ids, the base text, submission, billing and first-shot time from the rows, and only the text and stamps from the proposal", () => {
    const proposal = correctionProposal({ pipeline: { auditVersion: AUDIT_VERSION, wiseClassId: "6a00000000000000000000ee", submissionId: "6a00000000000000000000ef" } });
    const planned = planFromRows(proposal, rows(), DEFAULT_FEEDBACK_FIELD_MAPPINGS);
    expect(planned.ok).toBe(true);
    if (!planned.ok) return;
    expect(planned.plan).toMatchObject({
      wiseSessionId: SID, wiseClassId: CID, wiseTeacherUserId: KEVIN_ONLINE_WISE_USER_ID,
      base: { fields: PIM_FIELDS, fieldsSha256: fieldsHash(PIM_FIELDS), submissionId: SUBMISSION, billing: BILLING, firstShotPostedAt: FIRST_SHOT_AT },
      fields: PIM_CORRECTED, fieldsSha256: fieldsHash(PIM_CORRECTED), reason: proposal.reason, rootCauseRef: "fix/autowriter-audit-m06",
      evidence: "transcript", arm: "sol",
    });
  });

  it("refuses when the rows and the proposal do not line up", () => {
    const cases: Array<[CorrectionRows, CorrectionProposal, string]> = [
      [rows({ session: null }), correctionProposal(), "session_missing"],
      [rows({ session: { state: "held" } }), correctionProposal(), "session_not_verified:held"],
      [rows({ firstShot: null }), correctionProposal(), "no_first_shot"],
      [rows({ firstShot: { outcome: "verify_failed" } }), correctionProposal(), "first_shot_not_verified:verify_failed"],
      [rows({ firstShot: { fields: PIM_CORRECTED } }), correctionProposal(), "base_hash_mismatch"],
      [rows({ session: { fieldsSha256: "moved" } }), correctionProposal(), "base_not_first_shot"],
      [rows(), correctionProposal({ fieldsSha256: "another-text" }), "proposal_stale"],
      [rows(), correctionProposal({ fieldsHash: "deadbeef" }), "candidate_hash_mismatch"],
      [rows(), correctionProposal({ fields: PIM_FIELDS, fieldsHash: fieldsHash(PIM_FIELDS) }), "no_change"],
      [rows(), correctionProposal({ rootCauseRef: "" }), "root_cause_ref_missing"],
      [rows({ session: { metadata: {} } }), correctionProposal(), "submission_unknown"],
      [rows({ firstShot: { verification: { submissionId: "6a00000000000000000000d9" } } }), correctionProposal(), "submission_mismatch"],
      [rows({ firstShot: { billing: {} } }), correctionProposal(), "billing_unknown"],
      [rows({ session: { wiseClassId: null }, firstShot: { wiseClassId: null } }), correctionProposal(), "class_unknown"],
      [rows({ firstShot: { wiseClassId: "6a00000000000000000000c9" } }), correctionProposal(), "class_mismatch"],
      [rows({ session: { wiseTeacherUserId: null } }), correctionProposal(), "teacher_unknown"],
      [rows({ firstShot: { wiseTeacherUserId: "6a00000000000000000000aa" } }), correctionProposal(), "teacher_mismatch"],
      [rows({ firstShot: { postStartedAt: null } }), correctionProposal(), "first_shot_time_unknown"],
      [rows(), correctionProposal({ checks: correctionProposal().checks.filter((item) => item.name !== "judge") }), "checks_incomplete:judge"],
      [rows(), correctionProposal({ checks: correctionProposal().checks.map((item) => (item.name === "reaudit_names" ? { ...item, pass: false } : item)) }), "checks_incomplete:reaudit_names"],
      [rows(), correctionProposal({ severity: "critical" }), "checks_incomplete:critical_confirmation"],
    ];
    for (const [given, proposal, reason] of cases) expect(planFromRows(proposal, given, DEFAULT_FEEDBACK_FIELD_MAPPINGS), reason).toEqual({ ok: false, reason });
  });
});

describe("stepCorrect: what it refuses outright", () => {
  it("refuses unsigned, tampered or foreign-signed proposals before anything else", async () => {
    for (const [name, write] of [
      ["unsigned", (ctx: NightContext) => writeJsonAtomic(path.join(ctx.paths.proposalsDir, `${SID}.json`), { proposal: correctionProposal() })],
      ["tampered", (ctx: NightContext) => {
        const signed = signProposal(correctionProposal(), KEY);
        signed.proposal.fields = { ...signed.proposal.fields, homework: "Finish the whole mock paper by Monday." };
        writeJsonAtomic(path.join(ctx.paths.proposalsDir, `${SID}.json`), signed);
      }],
      ["foreign", (ctx: NightContext) => writeProposal(ctx.paths.proposalsDir, correctionProposal(), Buffer.alloc(32, 8))],
      ["renamed", (ctx: NightContext) => writeJsonAtomic(path.join(ctx.paths.proposalsDir, `${SID_B}.json`), signProposal(correctionProposal(), KEY))],
      ["other night", (ctx: NightContext) => writeProposal(ctx.paths.proposalsDir, correctionProposal({ night: "2026-10-01" }), KEY)],
    ] as const) {
      const ctx = context({}, { paths: nightlyPaths(path.join(dir, name), NIGHT) });
      seed(ctx);
      write(ctx);
      const h = harness(ctx, { apply: true });
      const result = await stepCorrect(ctx, h.deps);
      expect(result, name).toMatchObject({ ok: false, stop: "proposal_invalid", exitCode: 6 });
      expect(h.execute, name).not.toHaveBeenCalled();
      expect(h.deps.loadRows, name).not.toHaveBeenCalled();
    }
  });

  it("refuses --apply off a clean origin/main checkout unless supervised, and records a supervised run", async () => {
    for (const [code, stop] of [
      [{ head: "c0ffee", branch: "feat/x", originMain: "beef01", dirty: false }, "not_origin_main"],
      [{ head: "c0ffee", branch: "main", originMain: "c0ffee", dirty: true }, "dirty_tree"],
      [{ head: "c0ffee", branch: "main", originMain: null, dirty: false }, "code_unknown"],
    ] as const) {
      const ctx = context({}, { paths: nightlyPaths(path.join(dir, stop), NIGHT) });
      seed(ctx);
      const h = harness(ctx, { apply: true, code });
      expect(await stepCorrect(ctx, h.deps), stop).toMatchObject({ ok: false, stop, exitCode: 6 });
      expect(h.execute).not.toHaveBeenCalled();
      // A dry run is never refused for the checkout.
      expect((await stepCorrect(ctx, harness(ctx, { apply: false, code }).deps)).ok, stop).toBe(true);
    }
    const ctx = context();
    seed(ctx);
    const h = harness(ctx, { apply: true, supervised: true, code: { head: "c0ffee", branch: "feat/autowriter-nightly-correct", originMain: "beef01", dirty: false } });
    const result = await stepCorrect(ctx, h.deps);
    expect(result).toMatchObject({ ok: true, summary: { supervised: true, dryRun: false, outcomes: { verified: 1 } } });
    expect(readJsonl<{ supervised: boolean; status: string }>(ctx.paths.correctionsJsonl).at(-1)).toMatchObject({ supervised: true, status: "verified" });
  });

  it("refuses while a correction is unsettled or its lock is left, a running Wise cooldown, and a missing key", async () => {
    const ctx = context();
    seed(ctx);
    const unsettled = harness(ctx, { apply: true, unsettled: async () => ({ rows: [{ postId: "p1", wiseSessionId: SID, outcome: "posting", stale: true }], lock: null, releasable: false }) });
    expect(await stepCorrect(ctx, unsettled.deps)).toMatchObject({ ok: false, stop: "unsettled_correction", exitCode: 6 });
    const locked = harness(ctx, { unsettled: async () => ({ rows: [], lock: { state: "stale", wiseSessionId: SID }, releasable: true }) });
    expect(await stepCorrect(ctx, locked.deps)).toMatchObject({ ok: false, stop: "unsettled_correction", exitCode: 6 });
    expect(await stepCorrect(ctx, harness(ctx, { hmacKey: { ok: false, reason: "hmac_key_missing" } }).deps)).toMatchObject({ stop: "hmac_key_missing", exitCode: 6 });
    fs.mkdirSync(path.join(dir, ".bgscheduler-nightly"), { recursive: true });
    fs.writeFileSync(path.join(dir, ".bgscheduler-nightly", "wise-cooldown-until"), new Date(clock + 60_000).toISOString());
    expect(await stepCorrect(ctx, harness(ctx).deps)).toMatchObject({ ok: false, stop: "wise_cooldown", exitCode: 5 });
    expect(unsettled.execute).not.toHaveBeenCalled();
  });
});

describe("stepCorrect: a dry run", () => {
  it("prints every guard per class and never waits, reserves or posts", async () => {
    clock = new Date("2026-10-02T22:20:00.000Z").getTime(); // outside a window
    const ctx = context();
    seed(ctx);
    seed(ctx, correctionProposal({ wiseSessionId: SID_B }));
    const h = harness(ctx);
    const result = await stepCorrect(ctx, h.deps);
    expect(result).toMatchObject({ ok: true, exitCode: 0, summary: { dryRun: true, outcomes: { preflight_ok: 2 } } });
    expect((result.summary.classes as Array<{ guards: string[] }>)[0].guards).toContain("db_preconditions");
    expect(h.execute.mock.calls.map(([input]) => input.dryRun)).toEqual([true, true]);
    expect(h.sleep).not.toHaveBeenCalled();
    expect(h.ledger.used("correction").count).toBe(0);
    expect(h.raiseFlag).not.toHaveBeenCalled();
    expect(readJsonl<{ dryRun: boolean }>(ctx.paths.correctionsJsonl).map((line) => line.dryRun)).toEqual([true, true]);
  });

  it("hands the executor the database plan, production's text checks and the switches", async () => {
    const ctx = context();
    seed(ctx);
    const h = harness(ctx, { loadDisabledTutors: async () => ["6a00000000000000000000ab"] });
    await stepCorrect(ctx, h.deps);
    const [input] = h.execute.mock.calls[0];
    expect(input).toMatchObject({ dryRun: true, apiActorId: "69366668c05630afe5d8a2a4", disabledTutors: ["6a00000000000000000000ab"], plan: { wiseClassId: CID, base: { submissionId: SUBMISSION } } });
    // The executor's required AI-suspect context: every name of the student, the tutor's names, the prior feedback.
    expect(input.aiSuspect).toEqual({
      studentNames: ["Pimchanok (Pim.Ta) Testwong", "Pim"], tutorNames: ["Arthit Teacherson", "Art"], priorFeedback: [], styleGuided: false,
    });
    // The executor and the store read one clock (the store checks it against the database's).
    expect(input.now).toBe(ctx.now);
    expect(input.allowlist).toBe(AUTOWRITER_TEACHER_ALLOWLIST);
    expect(input.textProblems(PIM_CORRECTED)).toEqual([]);
    expect(input.textProblems({ ...PIM_CORRECTED, topics: `${PIM_CORRECTED.topics} We used the Zoom recording.` })).toEqual(expect.arrayContaining(["meta_word:zoom@topics", "meta_word:recording@topics"]));
  });

  it("refuses a class whose plan or bundle cannot be built, and goes on to the next", async () => {
    const ctx = context();
    seed(ctx);
    seed(ctx, correctionProposal({ wiseSessionId: SID_B }));
    fs.rmSync(path.join(ctx.paths.bundlesDir, `${SID_B}.json`));
    const h = harness(ctx, { loadRows: vi.fn(async (sid: string) => (sid === SID ? rows({ firstShot: null }) : rows())) });
    const result = await stepCorrect(ctx, h.deps);
    expect(result.summary.classes).toEqual([
      expect.objectContaining({ wiseSessionId: SID, status: "refused", stage: "plan", reason: "no_first_shot" }),
      expect.objectContaining({ wiseSessionId: SID_B, status: "refused", stage: "plan", reason: "bundle_missing" }),
    ]);
    expect(h.execute).not.toHaveBeenCalled();
  });
});

describe("stepCorrect: applying", () => {
  it("corrects one class at a time — every guard read first, then the POST — and raises an agent flag after each", async () => {
    const ctx = context();
    seed(ctx);
    seed(ctx, correctionProposal({ wiseSessionId: SID_B, modes: ["M03", "M06"] }));
    const h = harness(ctx, { apply: true });
    const result = await stepCorrect(ctx, h.deps);
    expect(result).toMatchObject({ ok: true, exitCode: 0, summary: { outcomes: { verified: 2 }, productionStillHalted: false } });
    expect(h.log.map((line) => line.split("@")[0])).toEqual([`dry:${SID}`, `apply:${SID}`, `dry:${SID_B}`, `apply:${SID_B}`]);
    expect(h.raiseFlag.mock.calls.map(([item]) => [item.idempotencyKey, item.note, item.incident])).toEqual([
      [`agent-correction:${SID}`, "corrected by the nightly agent: M06", false],
      [`agent-correction:${SID_B}`, "corrected by the nightly agent: M03, M06", false],
    ]);
    expect(h.ledger.used("correction").count).toBe(2);
    const lines = readJsonl<{ status: string; flag: string; dryRun: boolean }>(ctx.paths.correctionsJsonl);
    expect(lines.map((line) => `${line.status}:${line.flag}`)).toEqual(["verified:raised", "verified:raised"]);
    expect(JSON.stringify(lines)).not.toMatch(/Pim|fraction/u);

    // A class corrected tonight is never tried again tonight.
    const again = harness(ctx, { apply: true });
    expect((await stepCorrect(ctx, again.deps)).summary.outcomes).toEqual({ skipped: 2 });
    expect(again.execute).not.toHaveBeenCalled();
  });

  it("waits for the next correction window with the clock it is given, but never more than 6 minutes or past the deadline", async () => {
    clock = new Date("2026-10-02T23:06:30.000Z").getTime(); // 3.5 minutes before :10
    const ctx = context();
    seed(ctx);
    const h = harness(ctx, { apply: true });
    expect(await stepCorrect(ctx, h.deps)).toMatchObject({ ok: true, summary: { outcomes: { verified: 1 } } });
    expect(h.log).toEqual([`dry:${SID}@23:06:30`, `apply:${SID}@23:10:00`]);
    expect(h.sleep.mock.calls.every(([ms]) => ms <= 30_000)).toBe(true);

    clock = new Date("2026-10-02T23:20:00.000Z").getTime(); // the next window is 20 minutes away
    const far = context({}, { paths: nightlyPaths(path.join(dir, "far"), NIGHT) });
    seed(far);
    const tooFar = harness(far, { apply: true });
    expect(await stepCorrect(far, tooFar.deps)).toMatchObject({ ok: false, stop: "outside_window", exitCode: 7, next: "correct" });
    expect(tooFar.execute.mock.calls.map(([input]) => input.dryRun)).toEqual([true]);
    expect(tooFar.ledger.used("correction").count).toBe(0);

    clock = new Date("2026-10-02T23:36:00.000Z").getTime(); // window at :40, deadline at :38
    const late = context({}, { paths: nightlyPaths(path.join(dir, "late"), NIGHT), deadline: new Date("2026-10-02T23:38:00.000Z") });
    seed(late);
    expect(await stepCorrect(late, harness(late, { apply: true }).deps)).toMatchObject({ ok: false, stop: "deadline", exitCode: 7 });
  });

  it("stops before the next class once a STOP file appears", async () => {
    const ctx = context();
    seed(ctx);
    seed(ctx, correctionProposal({ wiseSessionId: SID_B }));
    const h = harness(ctx, {
      apply: true,
      outcome: (input) => {
        fs.writeFileSync(path.join(dir, "STOP"), "owner stop");
        return { status: "verified", postId: `post-${input.plan.wiseSessionId}`, bodyHash: "body" };
      },
    });
    const result = await stepCorrect(ctx, h.deps);
    expect(result).toMatchObject({ ok: false, stop: "stop_file", exitCode: 7 });
    expect(h.log.map((line) => line.split("@")[0])).toEqual([`dry:${SID}`, `apply:${SID}`]);
  });

  it("ends everything on a safety outcome: exit 10, STOP written, the autowriter left halted, nothing released", async () => {
    const ctx = context();
    seed(ctx);
    seed(ctx, correctionProposal({ wiseSessionId: SID_B }));
    const h = harness(ctx, { apply: true, outcome: () => ({ status: "safety", postId: "post-1", problems: ["credit_entries_changed:[1]->[1,1]"] }) });
    const result = await stepCorrect(ctx, h.deps);
    expect(result).toMatchObject({ ok: false, stop: "safety", exitCode: 10, summary: { productionStillHalted: true } });
    expect(fs.existsSync(path.join(dir, ".bgscheduler-nightly", "STOP"))).toBe(true);
    expect(h.log.map((line) => line.split("@")[0])).toEqual([`dry:${SID}`, `apply:${SID}`]);
    // Only the executor touches the store (it keeps the lock on a safety outcome); no flag for a text that did not verify.
    expect(h.raiseFlag).not.toHaveBeenCalled();
    expect(readJsonl<{ status: string; problems: string[] }>(ctx.paths.correctionsJsonl)[0]).toMatchObject({ status: "safety", problems: ["credit_entries_changed:[1]->[1,1]"] });
  });

  it("stops the night's corrections when the event is still missing under the lock, and hands over to recover", async () => {
    const ctx = context();
    seed(ctx);
    seed(ctx, correctionProposal({ wiseSessionId: SID_B }));
    const h = harness(ctx, {
      apply: true,
      outcome: () => ({ status: "awaiting_event_locked", postId: "post-1", bodyHash: "body" }),
    });
    const result = await stepCorrect(ctx, h.deps);
    expect(result).toMatchObject({
      ok: false, stop: "awaiting_event_locked", exitCode: 7, next: "recover --apply",
      // recover acts once the row is older than the lock's lease (plus margin): 25 minutes from now at the latest.
      summary: { productionStillHalted: true, recoverNotBefore: new Date(clock + 25 * 60_000).toISOString() },
    });
    expect(h.raiseFlag).toHaveBeenCalledTimes(1);
    expect(h.log.map((line) => line.split("@")[0])).toEqual([`dry:${SID}`, `apply:${SID}`]);
  });

  it("parks Wise for 30 minutes after a 429 that sent nothing, and stops", async () => {
    const ctx = context();
    seed(ctx);
    const h = harness(ctx, { apply: true, outcome: () => ({ status: "not_sent", postId: "post-1", reason: "wise_rate_limited" }) });
    expect(await stepCorrect(ctx, h.deps)).toMatchObject({ ok: false, stop: "wise_429", exitCode: 5 });
    expect(activeWiseCooldown(new Date(clock), dir)).not.toBeNull();
    expect(h.raiseFlag).not.toHaveBeenCalled();
  });

  it("stops without parking Wise when the lock was lost or its budget spent before the POST", async () => {
    for (const reason of ["lock_lost", "lock_budget", "lock_check_failed:NeonDbError,settle_failed:23505"]) {
      const ctx = context({}, { paths: nightlyPaths(path.join(dir, reason.slice(0, 12)), NIGHT), home: path.join(dir, reason.slice(0, 12)) });
      seed(ctx);
      seed(ctx, correctionProposal({ wiseSessionId: SID_B }));
      const h = harness(ctx, { apply: true, outcome: () => ({ status: "not_sent", postId: "post-1", reason }) });
      expect(await stepCorrect(ctx, h.deps), reason).toMatchObject({ ok: false, stop: `not_sent:${reason.split(/[,:]/u)[0]}`, exitCode: 7 });
      expect(activeWiseCooldown(new Date(clock), ctx.home), reason).toBeNull();
      expect(h.log.map((line) => line.split("@")[0]), reason).toEqual([`dry:${SID}`, `apply:${SID}`]);
    }
  });

  it("stops when a released correction leaves the autowriter halted by someone else, after flagging it", async () => {
    const ctx = context();
    seed(ctx);
    seed(ctx, correctionProposal({ wiseSessionId: SID_B }));
    const h = harness(ctx, { apply: true, outcome: () => ({ status: "verified", postId: "post-1", bodyHash: "body", productionStillHalted: true }) });
    expect(await stepCorrect(ctx, h.deps)).toMatchObject({ ok: false, stop: "production_halted", exitCode: 7, next: null, summary: { productionStillHalted: true } });
    expect(h.raiseFlag).toHaveBeenCalledTimes(1);
    expect(h.log.map((line) => line.split("@")[0])).toEqual([`dry:${SID}`, `apply:${SID}`]);
  });

  it("keeps to the night (6) and week (15) caps, the database's daily cap and --max", async () => {
    const ctx = context({ maxCorrectionsPerNight: 1 });
    seed(ctx);
    seed(ctx, correctionProposal({ wiseSessionId: SID_B }));
    const capped = harness(ctx, { apply: true });
    expect(await stepCorrect(ctx, capped.deps)).toMatchObject({ ok: false, stop: "cap:corrections_night", exitCode: 3, summary: { outcomes: { verified: 1 } } });

    const week = context({ maxCorrectionsPerWeek: 0 }, { paths: nightlyPaths(path.join(dir, "week"), NIGHT) });
    seed(week);
    const weekCapped = harness(week, { apply: true });
    expect(await stepCorrect(week, weekCapped.deps)).toMatchObject({ ok: false, stop: "cap:corrections_week", exitCode: 3 });
    expect(weekCapped.execute).not.toHaveBeenCalled();

    const daily = context({}, { paths: nightlyPaths(path.join(dir, "daily"), NIGHT) });
    seed(daily);
    seed(daily, correctionProposal({ wiseSessionId: SID_B }));
    const dbCapped = harness(daily, { apply: true, outcome: () => ({ status: "refused", stage: "db", reason: "daily_cap" }) });
    expect(await stepCorrect(daily, dbCapped.deps)).toMatchObject({ ok: false, stop: "cap:daily_db", exitCode: 3 });

    const limited = context({}, { paths: nightlyPaths(path.join(dir, "max"), NIGHT) });
    seed(limited);
    seed(limited, correctionProposal({ wiseSessionId: SID_B }));
    const one = harness(limited, { apply: true, max: 1 });
    expect(await stepCorrect(limited, one.deps)).toMatchObject({ ok: true, stop: "max_reached", summary: { outcomes: { verified: 1 } } });
  });

  it("ends the run on a refusal every later class would meet too: the database's daily cap, a skewed clock", async () => {
    for (const [reason, stop, exitCode] of [["daily_cap", "cap:daily_db", 3], ["clock_skew:3400ms", "clock_skew", 6]] as const) {
      const ctx = context({}, { paths: nightlyPaths(path.join(dir, stop), NIGHT) });
      seed(ctx);
      seed(ctx, correctionProposal({ wiseSessionId: SID_B }));
      const h = harness(ctx);
      h.execute.mockImplementation(async () => ({ status: "refused", stage: "db", reason }));
      expect(await stepCorrect(ctx, h.deps), reason).toMatchObject({ ok: false, stop, exitCode });
      expect(h.execute, reason).toHaveBeenCalledTimes(1);
    }
    expect(runStopForRefusal("db:owner_flag_open")).toBeNull();
  });

  it("does not wait, reserve or post for a class its own read-only guards refuse", async () => {
    clock = new Date("2026-10-02T23:06:00.000Z").getTime();
    const ctx = context();
    seed(ctx);
    const h = harness(ctx, { apply: true });
    h.execute.mockImplementation(async (input: CorrectPostInput) => {
      h.log.push(`${input.dryRun ? "dry" : "apply"}:${input.plan.wiseSessionId}`);
      return { status: "refused", stage: "wise", reason: "wise_text_differs_from_last_post" };
    });
    expect(await stepCorrect(ctx, h.deps)).toMatchObject({ ok: true, summary: { outcomes: { refused: 1 } } });
    expect(h.log).toEqual([`dry:${SID}`]);
    expect(h.sleep).not.toHaveBeenCalled();
    expect(h.ledger.used("correction").count).toBe(0);
  });

  it("stops cleanly on a database read failure before any Wise access", async () => {
    const ctx = context();
    seed(ctx);
    const h = harness(ctx, { apply: true, loadRows: vi.fn(async () => {
      throw Object.assign(new Error("connection refused"), { name: "NeonDbError" });
    }) });
    expect(await stepCorrect(ctx, h.deps)).toMatchObject({
      ok: false, stop: "db_error", exitCode: 1, summary: { classes: [expect.objectContaining({ status: "refused", reason: "read_failed:NeonDbError" })] },
    });
    expect(h.execute).not.toHaveBeenCalled();
  });

  it("treats an executor that throws while holding the lock as a safety stop", async () => {
    const ctx = context();
    seed(ctx);
    const h = harness(ctx, { apply: true });
    h.execute.mockImplementation(async (input: CorrectPostInput) => {
      if (input.dryRun) return { status: "preflight_ok", bodyHash: "b", guards: [] };
      throw new Error("connection reset");
    });
    expect(await stepCorrect(ctx, h.deps)).toMatchObject({ ok: false, stop: "correction_error", exitCode: 10, summary: { productionStillHalted: true } });
    expect(fs.existsSync(path.join(dir, ".bgscheduler-nightly", "STOP"))).toBe(true);
  });
});

describe("guardedWiseOps and the window", () => {
  it("refuses every read under STOP, notes a 429, and lets the one POST through", async () => {
    const stopFile = path.join(dir, "STOP");
    const base = {
      getSessionDetail: vi.fn(async () => ({ data: {} })),
      getSessionCreditEntries: vi.fn(async () => {
        throw Object.assign(new Error("HTTP 429"), { status: 429 });
      }),
      findFeedbackEvents: vi.fn(async () => []),
      postFeedback: vi.fn(async () => ({ kind: "sent" as const, status: 200 })),
    };
    const guarded = guardedWiseOps(base, [stopFile]);
    await expect(guarded.ops.getSessionCreditEntries(CID, "s", SID)).rejects.toThrow("HTTP 429");
    expect(guarded.throttled()).toBe(true);
    fs.writeFileSync(stopFile, "x");
    await expect(guarded.ops.getSessionDetail(CID, SID)).rejects.toThrow(/Kill switch/u);
    await expect(guarded.ops.findFeedbackEvents(CID, SID, new Date())).rejects.toThrow(/Kill switch/u);
    expect(base.getSessionDetail).not.toHaveBeenCalled();
    await expect(guarded.ops.postFeedback(CID, SID, { answers: [], sessionStatus: "COMPLETED", creditsConsumed: 1 })).resolves.toEqual({ kind: "sent", status: 200 });
  });

  it("measures the wait to the next window (UTC :10–:15 and :40–:45)", () => {
    expect(msUntilCorrectionWindow(new Date("2026-10-02T23:12:00Z"))).toBe(0);
    expect(msUntilCorrectionWindow(new Date("2026-10-02T23:07:30Z"))).toBe(150_000);
    expect(msUntilCorrectionWindow(new Date("2026-10-02T23:16:00Z"))).toBe(24 * 60_000);
    expect(msUntilCorrectionWindow(new Date("2026-10-02T23:46:00Z"))).toBe(24 * 60_000);
    expect(msUntilCorrectionWindow(new Date("2026-10-02T23:39:59Z"))).toBe(1_000);
  });
});

describe("stepRecover", () => {
  function recoverDeps(patch: Partial<RecoverDeps> = {}) {
    const deps = {
      apply: false, supervised: false, code: { head: "c0ffee", branch: "main", originMain: "c0ffee", dirty: false },
      unsettled: vi.fn<RecoverDeps["unsettled"]>(async () => ({ rows: [{ postId: "p1", wiseSessionId: SID, outcome: "posting", stale: true }], lock: { state: "stale", wiseSessionId: SID }, releasable: false })),
      recover: vi.fn<RecoverDeps["recover"]>(async () => [{ postId: "p1", wiseSessionId: SID, result: "not_sent", problems: [] }]),
      release: vi.fn<RecoverDeps["release"]>(async () => true),
    };
    return { ...deps, ...patch } as typeof deps;
  }

  it("is a dry run of database reads unless --apply", async () => {
    const ctx = context();
    const deps = recoverDeps();
    const result = await stepRecover(ctx, deps);
    expect(result).toMatchObject({ ok: true, next: "recover --apply", summary: { dryRun: true, before: { rows: [{ postId: "p1" }], lock: { state: "stale" } } } });
    expect(deps.recover).not.toHaveBeenCalled();
    expect(deps.release).not.toHaveBeenCalled();
  });

  it("settles, then releases the lock, applying from origin/main (or supervised), never under STOP", async () => {
    const ctx = context();
    const settled = recoverDeps({ apply: true });
    settled.unsettled.mockResolvedValueOnce({ rows: [{ postId: "p1", wiseSessionId: SID, outcome: "posting", stale: true }], lock: { state: "stale", wiseSessionId: SID }, releasable: false })
      .mockResolvedValueOnce({ rows: [], lock: null, releasable: false });
    expect(await stepRecover(ctx, settled)).toMatchObject({ ok: true, exitCode: 0, summary: { released: true, results: [{ result: "not_sent" }] } });
    expect(settled.recover.mock.invocationCallOrder[0]).toBeLessThan(settled.release.mock.invocationCallOrder[0]);

    const offMain = recoverDeps({ apply: true, code: { head: "c0ffee", branch: "x", originMain: "beef", dirty: false } });
    expect(await stepRecover(ctx, offMain)).toMatchObject({ ok: false, stop: "not_origin_main", exitCode: 6 });
    expect(offMain.recover).not.toHaveBeenCalled();
    fs.writeFileSync(path.join(dir, "STOP"), "x");
    const stopped = recoverDeps({ apply: true });
    expect(await stepRecover(ctx, stopped)).toMatchObject({ ok: false, stop: "stop_file", exitCode: 7 });
    expect(stopped.recover).not.toHaveBeenCalled();
  });

  it("waits while a correction lock's lease is live: nothing is released, try again later", async () => {
    const ctx = context();
    const deps = recoverDeps({ apply: true, recover: vi.fn<RecoverDeps["recover"]>(async () => [{ postId: "p1", wiseSessionId: SID, result: "lease_live", problems: [] }]) });
    expect(await stepRecover(ctx, deps)).toMatchObject({ ok: false, stop: "lease_live", exitCode: 7, next: "recover --apply", summary: { released: false } });
    expect(deps.release).not.toHaveBeenCalled();
    // A live lock with nothing old enough to recover yet: the same.
    const live = recoverDeps({
      apply: true,
      unsettled: vi.fn<RecoverDeps["unsettled"]>(async () => ({ rows: [], lock: { state: "live", wiseSessionId: SID }, releasable: false })),
      recover: vi.fn<RecoverDeps["recover"]>(async () => []),
    });
    expect(await stepRecover(ctx, live)).toMatchObject({ ok: false, stop: "lease_live", exitCode: 7 });
    expect(live.release).not.toHaveBeenCalled();
  });

  it("exits 10 and writes STOP when a correction could not be settled safely", async () => {
    const ctx = context();
    const deps = recoverDeps({ apply: true, recover: vi.fn<RecoverDeps["recover"]>(async () => [{ postId: "p1", wiseSessionId: SID, result: "safety", problems: ["api_save_but_text_not_landed"] }]) });
    expect(await stepRecover(ctx, deps)).toMatchObject({ ok: false, stop: "safety", exitCode: 10 });
    expect(fs.existsSync(path.join(dir, ".bgscheduler-nightly", "STOP"))).toBe(true);
  });
});

describe("stepCorrect with the real executor (dry run)", () => {
  it("builds a plan the guarded executor accepts: every guard passes on reads alone", async () => {
    const ctx = context();
    const proposal = correctionProposal({
      wiseSessionId: SESSION_ID, fieldsSha256: fieldsHash(BASE), fields: CORRECTED, fieldsHash: fieldsHash(CORRECTED),
    });
    writeProposal(ctx.paths.proposalsDir, proposal, KEY);
    const file: BundleFile = {
      target: nightlyTarget({ wiseSessionId: SESSION_ID, wiseClassId: CLASS_ID, fieldsSha256: fieldsHash(BASE), fields: { ...BASE } }),
      bundle: nightlyBundle({ wiseSessionId: SESSION_ID, studentFullName: STUDENT_NAME, studentDisplayName: "Somchai", tutorNames: ["Kevin"], postedFields: { ...BASE } }),
      prechecks: [], notes: [],
      status: { collectedAt: "", rowMeta: "read", iseb: "not_guided", detail: "fetched", soniox: "fetched", zoom: "none", retranscribe: "not_needed" },
      collectedAt: "",
    };
    writeJsonAtomic(path.join(ctx.paths.bundlesDir, `${SESSION_ID}.json`), file);
    const time = executorClock(IN_WINDOW);
    const wise = fakeWise(time, []);
    const preconditions = vi.fn(async () => ({ problems: [] as string[], firstShotPostedAt: new Date("2026-10-02T09:40:00.000Z") }));
    const databaseNow = vi.fn(async () => time.now());
    const store: CorrectionStore = { ...untouchableStore(), preconditions, databaseNow };
    const h = harness(ctx, {
      execute: undefined,
      ops: wise,
      store,
      apiActorId: API_ACTOR,
      loadRows: vi.fn(async () => ({
        session: {
          wiseClassId: CLASS_ID, wiseTeacherUserId: KEVIN_ONLINE_WISE_USER_ID, state: "verified", fieldsSha256: fieldsHash(BASE),
          metadata: { expected: { kind: "auto_blank", submissionId: SUBMISSION_ID, sessionStatus: "COMPLETED", creditsConsumed: 1 } },
        },
        firstShot: {
          wiseClassId: CLASS_ID, wiseTeacherUserId: KEVIN_ONLINE_WISE_USER_ID, fields: BASE, fieldsSha256: fieldsHash(BASE), billing: BILLING,
          postStartedAt: new Date("2026-10-02T09:40:00.000Z"), outcome: "verified", verification: { submissionId: SUBMISSION_ID },
        },
      })),
    });
    const result = await stepCorrect(ctx, h.deps);
    expect(result.summary.classes).toEqual([expect.objectContaining({ wiseSessionId: SESSION_ID, status: "preflight_ok" })]);
    const [line] = result.summary.classes as Array<{ guards: string[] }>;
    expect(line.guards).toEqual(expect.arrayContaining(["plan", "db_preconditions", "wise_state_before_lock", "credit_baseline", "lock (not taken: dry run)"]));
    expect(preconditions).toHaveBeenCalledTimes(1);
    expect(wise.postFeedback).not.toHaveBeenCalled();
  });
});
