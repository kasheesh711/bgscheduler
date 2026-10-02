import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { answers, autoBlankSubmission, sessionDetail } from "../../__tests__/fixtures";
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
  stepCollect,
  stepPreflight,
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
    expect(readTargets(ctx.paths)).toMatchObject({ night: "2026-10-02", chosen: [], auditVersion: 1 });
    const again = await stepSelect(ctx, { db, ledger });
    expect(again.summary).toMatchObject({ cached: true });
    expect(queries).toHaveLength(1);
    await stepSelect(ctx, { db, ledger, force: true });
    expect(queries).toHaveLength(2);
  });
});

describe("stepCollect", () => {
  function writeTargets(ctx: NightContext, targets = [nightlyTarget()]) {
    const file: TargetsFile = { night: ctx.night, auditVersion: 1, selectedAt: "", chosen: targets, skipped: [] };
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
