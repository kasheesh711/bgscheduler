import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { answers, autoBlankSubmission, sessionDetail } from "../../__tests__/fixtures";
import { auditCacheFile } from "../audit";
import { AUDIT_VERSION } from "../audit-schema";
import { NIGHTLY_CAPS } from "../caps";
import { createWiseReadGate, readOnlySoniox, type RowMeta } from "../evidence";
import { NightlyLedger } from "../ledger";
import { nightlyPaths, readJsonFile } from "../paths";
import {
  nextStep,
  readBundleFile,
  readRunState,
  readTargets,
  recordStep,
  runNight,
  stepCollect,
  stepCosts,
  stepFlag,
  stepPreflight,
  stepReport,
  stepSelect,
  type NightContext,
  type PreflightFacts,
  type RunState,
  type TargetsFile,
} from "../steps";
import { fakeDb } from "./fake-db";
import { CID, PIM_FIELDS, SID, STUDENT, nightlyTarget } from "./nightly-fixtures";

let dir: string;
let clock: number;

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), "nightly-steps-"));
  clock = new Date("2026-10-02T19:15:00Z").getTime();
});

afterEach(() => {
  fs.rmSync(dir, { recursive: true, force: true });
});

function context(patch: Partial<NightContext> = {}): NightContext {
  return {
    night: "2026-10-02",
    paths: nightlyPaths(path.join(dir, "state"), "2026-10-02"),
    caps: { ...NIGHTLY_CAPS },
    now: () => new Date(clock),
    deadline: new Date("2026-10-02T23:50:00Z"),
    stopFiles: [path.join(dir, "STOP")],
    home: dir,
    ...patch,
  };
}

const goodFacts: PreflightFacts = {
  nodeVersion: "v22.22.2",
  missingEnv: [],
  optionalEnvMissing: [],
  code: { head: "abc123", branch: "feat/autowriter-nightly-audit", dirty: false },
  claudeCliVersion: "2.1.287 (Claude Code)",
  lock: { ok: true },
  corrections: { unsettled: 0, lock: null },
};

describe("run state", () => {
  it("checkpoints steps and resumes at the first unfinished one", () => {
    const ctx = context();
    expect(nextStep(readRunState(ctx))).toBe("preflight");
    recordStep(ctx, "preflight", { status: "done", stop: null, summary: {} });
    recordStep(ctx, "select", { status: "done", stop: null, summary: {} });
    recordStep(ctx, "collect", { status: "stopped", stop: "wise_429", summary: {} });
    const state = readJsonFile<RunState>(ctx.paths.runJson)!;
    expect(nextStep(state)).toBe("collect");
    expect(state.steps.collect).toMatchObject({ status: "stopped", stop: "wise_429", pid: process.pid });
    expect(fs.statSync(ctx.paths.runJson).mode & 0o777).toBe(0o600);
  });
});

describe("stepPreflight", () => {
  it("passes a clean setup and records the code and CLI version", () => {
    const ctx = context();
    const result = stepPreflight(ctx, goodFacts);
    expect(result).toMatchObject({ ok: true, stop: null, next: "select", exitCode: 0 });
    expect(readRunState(ctx)).toMatchObject({ code: goodFacts.code, claudeCliVersion: "2.1.287 (Claude Code)", steps: { preflight: { status: "done" } } });
  });

  it("refuses a dirty tree, missing environment or an old node (6), a held lock or STOP (7)", () => {
    expect(stepPreflight(context(), { ...goodFacts, code: { ...goodFacts.code!, dirty: true } })).toMatchObject({ ok: false, stop: "dirty_tree", exitCode: 6 });
    expect(stepPreflight(context(), { ...goodFacts, missingEnv: ["DATABASE_URL"] })).toMatchObject({ stop: "env_missing:DATABASE_URL", exitCode: 6 });
    expect(stepPreflight(context(), { ...goodFacts, nodeVersion: "v20.20.2" })).toMatchObject({ stop: "node_v20.20.2_below_22", exitCode: 6 });
    expect(stepPreflight(context(), { ...goodFacts, lock: { ok: false, reason: "held", holder: { pid: 1 } } })).toMatchObject({ stop: "locked", exitCode: 7 });
    // A correction a run left unsettled (or its lock) stops the night until `recover` has settled it.
    expect(stepPreflight(context(), { ...goodFacts, corrections: { unsettled: 1, lock: null } })).toMatchObject({ ok: false, stop: "unsettled_correction", exitCode: 6 });
    expect(stepPreflight(context(), { ...goodFacts, corrections: { unsettled: 0, lock: "stale" } })).toMatchObject({ ok: false, stop: "unsettled_correction", exitCode: 6 });
    expect(stepPreflight(context(), { ...goodFacts, corrections: { error: "NeonDbError" } })).toMatchObject({ ok: false, stop: "corrections_unreadable:NeonDbError", exitCode: 6 });
    fs.writeFileSync(path.join(dir, "STOP"), "");
    expect(stepPreflight(context(), goodFacts)).toMatchObject({ stop: "stop_file", exitCode: 7 });
    fs.rmSync(path.join(dir, "STOP"));
    clock = new Date("2026-10-02T23:51:00Z").getTime();
    expect(stepPreflight(context(), goodFacts)).toMatchObject({ stop: "deadline", exitCode: 7 });
    expect(stepPreflight(context({ deadline: null }), goodFacts)).toMatchObject({ ok: true });
  });
});

describe("stepSelect", () => {
  it("writes the night's targets and does not select again once done", async () => {
    const ctx = context();
    const { db, queries } = fakeDb(() => []);
    const ledger = NightlyLedger.open(ctx.paths.root, ctx.night, ctx.caps);
    const first = await stepSelect(ctx, { db, ledger });
    expect(first).toMatchObject({ ok: true, summary: { posts: 0, chosen: 0 } });
    expect(readTargets(ctx.paths)).toMatchObject({ night: "2026-10-02", chosen: [], auditVersion: AUDIT_VERSION });
    const again = await stepSelect(ctx, { db, ledger });
    expect(again.summary).toMatchObject({ cached: true });
    expect(queries).toHaveLength(1);
    await stepSelect(ctx, { db, ledger, force: true });
    expect(queries).toHaveLength(2);
  });
});

describe("stepCollect", () => {
  function writeTargets(ctx: NightContext, targets = [nightlyTarget()]) {
    const file: TargetsFile = { night: ctx.night, auditVersion: AUDIT_VERSION, selectedAt: "", chosen: targets, skipped: [] };
    fs.mkdirSync(path.dirname(ctx.paths.targetsJson), { recursive: true });
    fs.writeFileSync(ctx.paths.targetsJson, JSON.stringify(file));
  }

  function deps(ctx: NightContext, wiseImpl?: () => Promise<unknown>) {
    const ledger = NightlyLedger.open(ctx.paths.root, ctx.night, ctx.caps, { now: ctx.now });
    const wise = {
      getSessionDetail: vi.fn(wiseImpl ?? (async () => ({
        data: sessionDetail({
          _id: SID, classId: CID, className: STUDENT, title: "Live Session - Maths",
          participants: [{ wiseUserId: "6a0000000000000000000003", name: STUDENT, isTeacher: false, inMeetingDuration: 3600, absolutePercentAttendance: 99 }],
          feedbackSubmissions: [autoBlankSubmission({ answers: answers([PIM_FIELDS.topics, PIM_FIELDS.performance, PIM_FIELDS.improvement, ""]), metadata: {} })],
        }),
      }))),
      getSessionDetailById: vi.fn(),
    };
    const production = {
      get: vi.fn(async () => ({ status: "completed" as const, audioDurationMs: 3_600_000, errorMessage: null })),
      transcript: vi.fn(async () => ({ text: "hello", tokens: [{ text: "Hello there, today we add fractions.", start_ms: 0, end_ms: 5_000, speaker: "1" }] })),
    };
    return {
      wise,
      production,
      deps: {
        collect: {
          sources: {
            rowMeta: async (): Promise<RowMeta> => ({ speakerMethod: "talk_share", judge: null, joinedAsGuest: null }),
            isebRecord: async () => null,
          },
          wise,
          gate: createWiseReadGate({ ledger, pacingMs: 5_000, deadline: ctx.deadline, now: ctx.now, sleep: async (ms) => { clock += ms; }, stopFiles: ctx.stopFiles, home: dir }),
          soniox: readOnlySoniox(production),
          fetchText: async () => "WEBVTT\n",
          now: ctx.now,
        },
        priorFeedback: async () => [],
        otherStudentNames: async () => ["Nok"],
      },
    };
  }

  it("needs select first", async () => {
    const ctx = context();
    expect(await stepCollect(ctx, deps(ctx).deps)).toMatchObject({ ok: false, stop: "no_targets", next: "select", exitCode: 2 });
  });

  it("writes one bundle with prechecks per class and records the step", async () => {
    const ctx = context();
    writeTargets(ctx);
    const { deps: collectDeps, wise } = deps(ctx);
    const result = await stepCollect(ctx, collectDeps);
    expect(result).toMatchObject({ ok: true, next: "audit", summary: { collected: 1, grades: { rebuilt: 1 }, wiseReads: 1 } });
    const file = readBundleFile(ctx.paths, SID);
    expect(file?.bundle).toMatchObject({ wiseSessionId: SID, grade: "rebuilt", studentDisplayName: "Pim" });
    expect(file?.prechecks.map((finding) => finding.code)).toContain("evidence_grade_rebuilt");
    expect(fs.statSync(path.join(ctx.paths.bundlesDir, `${SID}.json`)).mode & 0o777).toBe(0o600);
    expect(readRunState(ctx).steps.collect?.status).toBe("done");
    // Re-running reads the cache: no second Wise read.
    await stepCollect(ctx, collectDeps);
    expect(wise.getSessionDetail).toHaveBeenCalledTimes(1);
  });

  it("stops the stage on a Wise 429 and keeps what it collected", async () => {
    const ctx = context();
    writeTargets(ctx, [nightlyTarget(), nightlyTarget({ wiseSessionId: "6a0000000000000000000a02", scheduledEndAt: "2026-10-02T08:00:00.000Z" })]);
    let calls = 0;
    const { deps: collectDeps } = deps(ctx, async () => {
      calls += 1;
      if (calls === 2) throw Object.assign(new Error("429"), { status: 429 });
      return { data: sessionDetail({ _id: SID, classId: CID }) };
    });
    const result = await stepCollect(ctx, collectDeps);
    expect(result).toMatchObject({ ok: false, stop: "wise_429", next: "collect", exitCode: 5, summary: { collected: 1 } });
    expect(readRunState(ctx).steps.collect).toMatchObject({ status: "stopped", stop: "wise_429" });
  });

  it("stops before a class when a STOP file appears", async () => {
    const ctx = context();
    writeTargets(ctx);
    fs.writeFileSync(path.join(dir, "STOP"), "");
    expect(await stepCollect(ctx, deps(ctx).deps)).toMatchObject({ ok: false, stop: "stop_file", exitCode: 7 });
  });
});

describe("stepReport, stepFlag, stepCosts and runNight", () => {
  function collectedNight(ctx: NightContext) {
    const target = nightlyTarget({ fieldsSha256: "abcdef0123456789" });
    const file = { night: ctx.night, auditVersion: AUDIT_VERSION, selectedAt: "", chosen: [target], skipped: [] };
    fs.mkdirSync(ctx.paths.bundlesDir, { recursive: true });
    fs.writeFileSync(ctx.paths.targetsJson, JSON.stringify(file));
    fs.writeFileSync(path.join(ctx.paths.bundlesDir, `${SID}.json`), JSON.stringify({
      target,
      bundle: { wiseSessionId: SID, night: ctx.night, grade: "rebuilt", hash: "bundle-hash-0001", classDetails: [], tutorNames: [], studentFullName: STUDENT,
        studentDisplayName: "Pim", studentAliases: [], postedFields: PIM_FIELDS, wiseCurrentFields: PIM_FIELDS, wiseTextMatchesPost: true, transcript: null,
        wiseSummary: "Overview: fractions.", zoomCaptions: null, postedEvidenceKind: "transcript", scheduledMinutes: 60, storedJudge: null, pipeline: null },
      prechecks: [{ code: "billing_drift", severity: "critical", candidate: false, detail: "Wise shows 2 credits", mode: "M13" }],
      notes: [], status: {}, collectedAt: "",
    }));
  }

  it("writes the partial report without an audit, never with names in the summary", async () => {
    const ctx = context({ deadline: null });
    collectedNight(ctx);
    const ledger = NightlyLedger.open(ctx.paths.root, ctx.night, ctx.caps);
    const run = vi.fn();
    const result = await stepReport(ctx, { db: null, ledger, run, cliVersion: "2.1.287" });
    expect(result).toMatchObject({ ok: true, summary: { classes: 1, severities: { critical: 1 }, synthesis: { ran: false } } });
    // No audit with a result: no synthesis call.
    expect(run).not.toHaveBeenCalled();
    expect(fs.readFileSync(ctx.paths.reportMd, "utf8")).toContain("billing_drift");
    const summary = fs.readFileSync(ctx.paths.summaryMd, "utf8");
    expect(summary).toContain("M13×1");
    expect(summary).not.toMatch(/Pim|Testwong|fractions/u);
    expect(readRunState(ctx).steps.report?.status).toBe("done");
  });

  it("pays for the synthesis once per set of audits: a report re-run reuses it", async () => {
    const ctx = context({ deadline: null });
    collectedNight(ctx);
    const target = nightlyTarget({ fieldsSha256: "abcdef0123456789" });
    const auditFile = auditCacheFile(ctx.paths.auditsDir, { wiseSessionId: SID, fieldsSha256: target.fieldsSha256, bundleHash: "bundle-hash-0001" });
    fs.mkdirSync(path.dirname(auditFile), { recursive: true });
    fs.writeFileSync(auditFile, JSON.stringify({
      wiseSessionId: SID, fieldsSha256: target.fieldsSha256, auditVersion: AUDIT_VERSION, promptVersion: 1, bundleHash: "bundle-hash-0001", grade: "rebuilt",
      failure: null, proof: null, at: "",
      result: {
        verdict: "accurate", claims: [], issues: [], omissions: [], homework: { feedbackStatesHomework: false, tutorSetHomework: "no", evidence: [] },
        names: { studentCalled: ["Pim"], otherPeopleNamed: [] }, candidateReview: [],
        evidenceQuality: { transcript: "full", speakerLabels: "verified", summaryVsTranscript: "agrees", notes: [] }, priorIssueReview: null, summaryLine: "ok",
      },
    }));
    const ledger = NightlyLedger.open(ctx.paths.root, ctx.night, ctx.caps);
    const synthesis = {
      failureModes: [], fixPick: null, fixBrief: null, longTermPlan: [], judgeMisses: { count: 0, modes: [] }, summaryLine: "Nothing to fix tonight.",
    };
    const run = vi.fn(async () => ({
      kind: "success" as const, value: synthesis,
      proof: { argv: [], cliVersion: null, models: ["claude-opus-5-5"], opusOutputTokens: 1, inputTokens: 1, outputTokens: 1, costUsd: 0.5, durationMs: 1, effort: "max" as const },
    }));
    const first = await stepReport(ctx, { db: null, ledger, run, cliVersion: null });
    expect(first.summary).toMatchObject({ synthesis: { ran: true, ok: true } });
    const again = await stepReport(ctx, { db: null, ledger, run, cliVersion: null });
    expect(again.summary).toMatchObject({ synthesis: { ran: false, reused: true } });
    expect(run).toHaveBeenCalledTimes(1);
    expect(fs.readFileSync(ctx.paths.planMd, "utf8")).toContain("Nothing to fix tonight.");
  });

  it("plans flags as a dry run unless applied", async () => {
    const ctx = context();
    collectedNight(ctx);
    const result = await stepFlag(ctx, { db: null, apply: false });
    expect(result.summary).toMatchObject({ dryRun: true, planned: [{ wiseSessionId: SID, severity: "critical", modes: ["M13"], incident: true }] });
    expect(readRunState(ctx).steps.flag).toBeUndefined();
    const { db, queries } = fakeDb(() => []);
    await expect(stepFlag(ctx, { db, apply: false })).resolves.toMatchObject({ summary: { dryRun: true } });
    expect(queries).toHaveLength(0);
  });

  it("sums the last nights' costs from the latest line per night", () => {
    const ctx = context();
    fs.mkdirSync(ctx.paths.root, { recursive: true });
    fs.writeFileSync(ctx.paths.costsJsonl, [
      JSON.stringify({ night: "2026-10-01", claudeUsd: 5, claudeCalls: 10, opusProven: 10, sonioxUsd: 1, openrouterUsd: 0, wiseReads: 20 }),
      JSON.stringify({ night: "2026-10-02", claudeUsd: 3, claudeCalls: 6, opusProven: 6, sonioxUsd: 0, openrouterUsd: 0, wiseReads: 10 }),
      JSON.stringify({ night: "2026-10-02", claudeUsd: 4, claudeCalls: 8, opusProven: 8, sonioxUsd: 0.5, openrouterUsd: 0, wiseReads: 12 }),
      JSON.stringify({ night: "2026-09-01", claudeUsd: 99, claudeCalls: 1, opusProven: 1, sonioxUsd: 0, openrouterUsd: 0, wiseReads: 0 }),
    ].join("\n"));
    expect(stepCosts(ctx, 7).summary).toMatchObject({ totals: { claudeUsd: 9, claudeCalls: 18, sonioxUsd: 1.5, wiseReads: 32 } });
  });

  it("runs the night from the first unfinished step and ends a stopped step with a partial report", async () => {
    const ctx = context();
    recordStep(ctx, "preflight", { status: "done", stop: null, summary: {} });
    const ok = (step: string) => async () => ({ ok: true, stop: null, next: null, summary: { step }, exitCode: 0 as const });
    const calls: string[] = [];
    const partialReport = vi.fn(async () => ({ ok: true, stop: null, next: null, summary: { step: "report" }, exitCode: 0 as const }));
    const result = await runNight(ctx, {
      order: ["preflight", "select", "collect", "audit", "report"],
      steps: {
        preflight: () => { calls.push("preflight"); return ok("preflight")(); },
        select: () => { calls.push("select"); return ok("select")(); },
        collect: async () => { calls.push("collect"); return { ok: false, stop: "wise_429", next: "collect", summary: {}, exitCode: 5 as const }; },
        audit: () => { calls.push("audit"); return ok("audit")(); },
      },
      partialReport,
    });
    expect(calls).toEqual(["select", "collect"]);
    expect(partialReport).toHaveBeenCalledTimes(1);
    expect(result).toMatchObject({ ok: false, stop: "wise_429", exitCode: 5, summary: { steps: { preflight: "done earlier" } } });

    const stopped = await runNight(ctx, {
      order: ["select"],
      steps: { select: async () => ({ ok: false, stop: "stop_file", next: "select", summary: {}, exitCode: 7 as const }) },
      partialReport,
    });
    expect(stopped.stop).toBe("stop_file");
    expect(partialReport).toHaveBeenCalledTimes(1);
  });
});
