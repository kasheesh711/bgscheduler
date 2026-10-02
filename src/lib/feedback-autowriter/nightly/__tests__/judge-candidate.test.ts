import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { AUTOWRITER_JUDGE_TIMEOUT_MS, AUTOWRITER_MODELS } from "../../config";
import type { OpenRouterCallResult } from "../../openrouter";
import { NIGHTLY_CAPS, type NightlyCaps } from "../caps";
import { JUDGE_CALL_ESTIMATE_USD, judgeCandidate, judgeEvidenceOf } from "../judge-candidate";
import { NightlyLedger } from "../ledger";
import { readJsonl } from "../paths";
import { PIM_FIELDS, nightlyBundle } from "./nightly-fixtures";

/** Synthetic people and lesson only. */
type Request = Parameters<typeof import("../../openrouter").callOpenRouter>[0];

const PASSING = JSON.stringify({ faithful: true, unsupported: [], misattributed: [], homeworkNotSet: [] });

function reply(content: string, costUsd: number | null = 0.002, patch: Partial<Extract<OpenRouterCallResult, { ok: true }>> = {}): OpenRouterCallResult {
  return {
    ok: true, content, model: AUTOWRITER_MODELS.judge.expectModel, provider: AUTOWRITER_MODELS.judge.expectProvider, generationId: "g",
    finishReason: "stop", usage: { promptTokens: 800, completionTokens: 200, reasoningTokens: 100, cachedTokens: 0, costUsd }, latencyMs: 4, ...patch,
  };
}

let dir: string;
beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), "nightly-judge-"));
});
afterEach(() => {
  fs.rmSync(dir, { recursive: true, force: true });
});

function ledger(caps: Partial<NightlyCaps> = {}) {
  return NightlyLedger.open(dir, "2026-10-02", { ...NIGHTLY_CAPS, ...caps }, { now: () => new Date("2026-10-02T23:00:00Z") });
}

describe("judgeEvidenceOf", () => {
  it("prefers the transcript, falls back to the summary, and has nothing without either", () => {
    expect(judgeEvidenceOf(nightlyBundle())).toMatchObject({ evidence: "transcript", speakerLabels: "verified" });
    expect(judgeEvidenceOf(nightlyBundle({ transcript: null }))).toMatchObject({ evidence: "summary", record: "Overview: The class added fractions." });
    expect(judgeEvidenceOf(nightlyBundle({ transcript: null, wiseSummary: "  " }))).toBeNull();
  });
});

describe("judgeCandidate", () => {
  it("reserves every call before it is sent and passes only when both levels pass", async () => {
    const book = ledger();
    const sent: string[] = [];
    const callModel = vi.fn(async (request: Request) => {
      // The reservation is on disk before the request leaves.
      const reserved = readJsonl<{ type: string; key: string }>(path.join(dir, "spend.jsonl")).filter((line) => line.type === "reserve");
      sent.push(`${request.effort}:${reserved.some((line) => line.key === `judge:k:${request.effort}`)}`);
      return reply(PASSING);
    });
    const result = await judgeCandidate({ apiKey: "k", ledger: book, key: "judge:k", callModel }, { fields: PIM_FIELDS, bundle: nightlyBundle() });
    expect(result).toMatchObject({ faithful: true, error: null, evidence: "transcript", calls: 2, costUsd: 0.004, capStop: null, breached: [] });
    expect(sent.toSorted()).toEqual(["high:true", "medium:true"]);
    expect(book.totals().openrouter).toEqual({ count: 2, usd: 0.004 });
    expect(callModel.mock.calls[0][0]).toMatchObject({ model: AUTOWRITER_MODELS.judge.model, timeoutMs: AUTOWRITER_JUDGE_TIMEOUT_MS.transcript });
    // The student's name stays out of the judge's messages.
    expect(JSON.stringify(callModel.mock.calls[0][0].messages)).not.toContain("Pim");
  });

  it("fails when either level finds a problem", async () => {
    const callModel = vi.fn(async (request: Request) => reply(request.effort === "medium"
      ? JSON.stringify({ faithful: false, unsupported: ["a test score"], misattributed: [], homeworkNotSet: [] })
      : PASSING));
    const result = await judgeCandidate({ apiKey: "k", ledger: ledger(), key: "judge:k", callModel }, { fields: PIM_FIELDS, bundle: nightlyBundle() });
    expect(result).toMatchObject({ faithful: false, error: null, problems: ["a test score"] });
  });

  it("never sends a call the ledger refuses, and says which cap stopped it", async () => {
    const callModel = vi.fn(async () => reply(PASSING));
    const result = await judgeCandidate(
      { apiKey: "k", ledger: ledger({ maxOpenRouterUsdNight: 0.06 }), key: "judge:k", callModel },
      { fields: PIM_FIELDS, bundle: nightlyBundle() },
    );
    // One call fits under $0.06 at its $0.05 estimate; the second is refused.
    expect(callModel).toHaveBeenCalledTimes(1);
    expect(result).toMatchObject({ faithful: false, capStop: "cap:openrouter_usd_night", calls: 1 });
    expect(result.error).toMatch(/^judge:(medium|high):cap:openrouter_usd_night$/u);
  });

  it("reports a cap the billed cost passed after the fact", async () => {
    const callModel = vi.fn(async () => reply(PASSING, 1.6));
    const result = await judgeCandidate({ apiKey: "k", ledger: ledger(), key: "judge:k", callModel }, { fields: PIM_FIELDS, bundle: nightlyBundle() });
    expect(result.breached).toEqual(["openrouter_usd_night"]);
    expect(result.faithful).toBe(true);
  });

  it("refuses a verdict from another host than the pinned one", async () => {
    const callModel = vi.fn(async () => reply(PASSING, 0.002, { provider: "ElsewhereAI" }));
    const result = await judgeCandidate({ apiKey: "k", ledger: ledger(), key: "judge:k", callModel }, { fields: PIM_FIELDS, bundle: nightlyBundle() });
    expect(result).toMatchObject({ faithful: false, error: "judge:medium:provider_mismatch:ElsewhereAI" });
  });

  it("makes no call without evidence or without the student's name", async () => {
    const callModel = vi.fn(async () => reply(PASSING));
    const deps = { apiKey: "k", ledger: ledger(), key: "judge:k", callModel };
    expect(await judgeCandidate(deps, { fields: PIM_FIELDS, bundle: nightlyBundle({ transcript: null, wiseSummary: null }) }))
      .toMatchObject({ faithful: false, error: "no_evidence", calls: 0 });
    expect(await judgeCandidate(deps, { fields: PIM_FIELDS, bundle: nightlyBundle({ studentFullName: null }) }))
      .toMatchObject({ faithful: false, error: "student_unknown", calls: 0 });
    expect(callModel).not.toHaveBeenCalled();
  });

  it("gives the judges an ISEB post's Atom evidence, redacted, as production does", async () => {
    const callModel = vi.fn<(request: Request) => Promise<OpenRouterCallResult>>(async () => reply(PASSING));
    const atom = "Matched activity: Fractions drill 3 — Pimchanok answered 18 of 20 correctly (90%).";
    await judgeCandidate({ apiKey: "k", ledger: ledger(), key: "judge:k", callModel }, {
      fields: PIM_FIELDS, bundle: nightlyBundle({ atomEvidence: atom }),
    });
    const user = callModel.mock.calls[0][0].messages[1].content;
    expect(user).toContain("Frozen Atom lesson evidence:");
    expect(user).toContain("answered 18 of 20 correctly (90%)");
    expect(user).not.toContain("Pimchanok");
    expect(callModel.mock.calls[0][0].messages[0].content).toContain("SOURCE_CONTRADICTION");
  });

  it("judges a summary-only bundle in summary mode at the summary time-out", async () => {
    const callModel = vi.fn<(request: Request) => Promise<OpenRouterCallResult>>(async () => reply(PASSING, null));
    const result = await judgeCandidate({ apiKey: "k", ledger: ledger(), key: "judge:k", callModel }, {
      fields: PIM_FIELDS, bundle: nightlyBundle({ transcript: null }),
    });
    expect(result).toMatchObject({ faithful: true, evidence: "summary", costUsd: 2 * JUDGE_CALL_ESTIMATE_USD });
    expect(callModel.mock.calls[0][0]).toMatchObject({ timeoutMs: AUTOWRITER_JUDGE_TIMEOUT_MS.summary });
  });
});
