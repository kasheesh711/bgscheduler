import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { SynthesisResult } from "../audit-schema";
import { NIGHTLY_CAPS } from "../caps";
import type { ClaudeCall, ClaudeOutcome } from "../claude-runner";
import { NightlyLedger } from "../ledger";
import type { ClassReport } from "../report";
import type { BundleFile } from "../steps";
import { fixBriefFile, realNamesOf, renderPlanMarkdown, synthesizeNight } from "../synthesis";
import type { AuditRecord, ClaudeProof } from "../types";
import { SID, nightlyBundle, nightlyTarget } from "./nightly-fixtures";

let dir: string;

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), "nightly-synthesis-"));
});

afterEach(() => {
  fs.rmSync(dir, { recursive: true, force: true });
});

const PROOF: ClaudeProof = {
  argv: [], cliVersion: null, models: ["claude-opus-5-5"], opusOutputTokens: 4000, inputTokens: 20_000, outputTokens: 4000, costUsd: 0.9,
  durationMs: 1, effort: "max",
};

const FILE: BundleFile = {
  target: nightlyTarget(), bundle: nightlyBundle(), prechecks: [], notes: [], collectedAt: "",
  status: { collectedAt: "", rowMeta: "read", iseb: "not_guided", detail: "fetched", soniox: "fetched", zoom: "none", retranscribe: "not_needed" },
};

const RECORD: AuditRecord = {
  wiseSessionId: SID, fieldsSha256: "sha-1", auditVersion: 1, promptVersion: 1, bundleHash: "h", grade: "rebuilt", failure: null, proof: PROOF,
  at: "", result: {
    verdict: "major", claims: [], issues: [], omissions: [],
    homework: { feedbackStatesHomework: true, tutorSetHomework: "no", evidence: [] },
    names: { studentCalled: ["Pim"], otherPeopleNamed: [] }, candidateReview: [],
    evidenceQuality: { transcript: "full", speakerLabels: "verified", summaryVsTranscript: "agrees", notes: [] },
    priorIssueReview: null, summaryLine: "1 issue",
  },
};

const REPORT = { wiseSessionId: SID, tutorKey: "Kevin", postedEvidenceKind: "transcript", judgePassed: true } as unknown as ClassReport;

function synthesis(patch: Partial<SynthesisResult> = {}): SynthesisResult {
  return {
    failureModes: [{
      mode: "M03", title: "Homework the tutor did not set", severity: "major", sessions: [SID],
      mechanism: "Remaining work described in the lesson is written as set homework.", rootStage: "writer",
      proposedChange: "Add a deterministic check for homework without a setting phrase.", proposedFiles: ["src/lib/feedback-autowriter/validate.ts"],
      fixability: "auto_allowed", confidence: "medium",
    }],
    fixPick: { mode: "M03", reason: "Most frequent major mode." },
    fixBrief: {
      mode: "M03",
      mechanism: "The writer treats unfinished work as homework.",
      targetFiles: ["src/lib/feedback-autowriter/prompt.ts"],
      syntheticFixture: {
        evidenceKind: "transcript",
        evidence: "[00:10] TUTOR: We can finish the last two questions next time, Tawan.",
        badFeedback: { topics: "Fractions", performance: "Tawan worked well.", improvement: "Practise.", homework: "Finish the last two questions by Friday." },
        expectedBehaviour: "Homework stays empty.",
      },
      acceptance: ["Homework empty on the fixture"],
    },
    longTermPlan: [{ title: "Homework check", why: "Recurring", steps: ["Add the check"], costImpact: "None" }],
    judgeMisses: { count: 1, modes: ["M03"] },
    summaryLine: "One major homework issue.",
    ...patch,
  };
}

describe("synthesizeNight", () => {
  it("makes one reserved Opus call and returns a validated plan and sanitised brief", async () => {
    const ledger = NightlyLedger.open(dir, "2026-10-02", { ...NIGHTLY_CAPS });
    const run = vi.fn(async (call: ClaudeCall): Promise<ClaudeOutcome> => {
      expect(call).toMatchObject({ purpose: "synthesis", key: "synthesis:2026-10-02", budgetUsd: 2 });
      expect(call.user).toContain(SID);
      return { kind: "success", value: synthesis(), proof: PROOF };
    });
    const outcome = await synthesizeNight({ ledger, run, perSynthesisUsd: 2 }, {
      night: "2026-10-02", records: [RECORD], files: [FILE], reports: [REPORT], modes: [],
    });
    expect(outcome.ok).toBe(true);
    expect(ledger.used("opus_synthesis")).toEqual({ count: 1, usd: 0.9 });
    if (!outcome.ok) throw new Error("unreachable");
    expect(renderPlanMarkdown("2026-10-02", outcome.result)).toContain("### M03 — Homework the tutor did not set");
    expect(fixBriefFile("2026-10-02", outcome.result)).toMatchObject({ mode: "M03", syntheticFixture: { evidenceKind: "transcript" } });
  });

  it("refuses a brief that carries a real name from the night's bundles", async () => {
    const ledger = NightlyLedger.open(dir, "2026-10-02", { ...NIGHTLY_CAPS });
    const leaky = synthesis();
    leaky.fixBrief!.mechanism = "Pim's unfinished work was written as homework.";
    const outcome = await synthesizeNight({ ledger, run: async () => ({ kind: "success", value: leaky, proof: PROOF }), perSynthesisUsd: 2 }, {
      night: "2026-10-02", records: [RECORD], files: [FILE], reports: [REPORT], modes: [],
    });
    expect(outcome).toMatchObject({ ok: false, reason: "invalid:fix brief contains a real name" });
  });

  it("stops on a usage limit and respects the synthesis cap", async () => {
    const ledger = NightlyLedger.open(dir, "2026-10-02", { ...NIGHTLY_CAPS });
    const limited = await synthesizeNight({ ledger, run: async () => ({ kind: "usage_limited", reason: "x", proof: null }), perSynthesisUsd: 2 }, {
      night: "2026-10-02", records: [RECORD], files: [FILE], reports: [REPORT], modes: [],
    });
    expect(limited).toMatchObject({ ok: false, stop: { reason: "usage_limited" } });
    const over = await synthesizeNight({ ledger, run: vi.fn(), perSynthesisUsd: 4.5 }, {
      night: "2026-10-02", records: [RECORD], files: [FILE], reports: [REPORT], modes: [],
    });
    expect(over).toMatchObject({ ok: false, reason: "cap:opus_synthesis_per_call" });
  });

  it("collects the night's real names for the brief check", () => {
    expect(realNamesOf([FILE])).toEqual(expect.arrayContaining(["Pimchanok (Pim.Ta) Testwong", "Pimchanok", "Testwong", "Pim", "Arthit Teacherson", "Art"]));
  });
});
