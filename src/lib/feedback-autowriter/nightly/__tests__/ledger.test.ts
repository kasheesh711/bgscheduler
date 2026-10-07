import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { NIGHTLY_CAPS, type NightlyCaps } from "../caps";
import { NightlyLedger } from "../ledger";
import { readJsonl } from "../paths";

let dir: string;
let clock: Date;
const now = () => clock;
const caps = (patch: Partial<NightlyCaps> = {}): NightlyCaps => ({ ...NIGHTLY_CAPS, ...patch });

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), "nightly-ledger-"));
  clock = new Date("2026-10-02T19:00:00Z");
});

afterEach(() => {
  fs.rmSync(dir, { recursive: true, force: true });
});

describe("NightlyLedger", () => {
  it("writes the reservation to disk before returning, then settles it", () => {
    const ledger = NightlyLedger.open(dir, "2026-10-02", caps(), { now });
    const reserved = ledger.reserve("opus_audit", { key: "k1", estimateUsd: 1.5 });
    expect(reserved.ok).toBe(true);
    const lines = readJsonl<Record<string, unknown>>(path.join(dir, "spend.jsonl"));
    expect(lines).toEqual([expect.objectContaining({ type: "reserve", kind: "opus_audit", key: "k1", estimateUsd: 1.5, night: "2026-10-02" })]);
    expect(ledger.used("opus_audit")).toEqual({ count: 1, usd: 1.5 });
    if (!reserved.ok) throw new Error("unreachable");
    expect(ledger.settle(reserved.id, { actualUsd: 0.42, outcome: "success" })).toEqual({ breached: [] });
    expect(ledger.used("opus_audit")).toEqual({ count: 1, usd: 0.42 });
    // Reopened from disk: the same totals.
    expect(NightlyLedger.open(dir, "2026-10-02", caps(), { now }).used("opus_audit")).toEqual({ count: 1, usd: 0.42 });
  });

  it("refuses a reservation that would pass a cap, and counts an unsettled one at its estimate", () => {
    const ledger = NightlyLedger.open(dir, "2026-10-02", caps({ maxClaudeUsdNight: 6 }), { now });
    expect(ledger.reserve("opus_audit", { key: "a", estimateUsd: 3 }).ok).toBe(true);
    expect(ledger.reserve("opus_audit", { key: "b", estimateUsd: 3 }).ok).toBe(true);
    expect(ledger.reserve("opus_audit", { key: "c", estimateUsd: 3 })).toEqual({ ok: false, reason: "cap:claude_usd_night" });
    expect(ledger.reserve("opus_audit", { key: "d", estimateUsd: 3.5 })).toEqual({ ok: false, reason: "cap:opus_audit_per_call" });
    expect(ledger.reserve("opus_synthesis", { key: "s", estimateUsd: 4.5 })).toEqual({ ok: false, reason: "cap:opus_synthesis_per_call" });
  });

  it("caps Opus calls, the Claude week, Soniox, OpenRouter, Wise reads and corrections", () => {
    const ledger = NightlyLedger.open(dir, "2026-10-02", caps({
      maxOpusCalls: 2, maxSonioxUsdNight: 0.2, maxOpenRouterUsdNight: 0.1, maxWiseReads: 2, maxCorrectionsPerNight: 1,
    }), { now });
    expect(ledger.reserve("opus_audit", { key: "a", estimateUsd: 0.1 }).ok).toBe(true);
    expect(ledger.reserve("opus_reaudit", { key: "b", estimateUsd: 0.1 }).ok).toBe(true);
    expect(ledger.reserve("opus_audit", { key: "c", estimateUsd: 0.1 })).toEqual({ ok: false, reason: "cap:opus_calls_night" });
    expect(ledger.reserve("soniox", { key: "s1", estimateUsd: 0.15 }).ok).toBe(true);
    expect(ledger.reserve("soniox", { key: "s2", estimateUsd: 0.1 })).toEqual({ ok: false, reason: "cap:soniox_usd_night" });
    expect(ledger.reserve("openrouter", { key: "o", estimateUsd: 0.2 })).toEqual({ ok: false, reason: "cap:openrouter_usd_night" });
    expect(ledger.reserve("wise_read", { key: "w1", estimateUsd: 0 }).ok).toBe(true);
    expect(ledger.reserve("wise_read", { key: "w2", estimateUsd: 0 }).ok).toBe(true);
    expect(ledger.reserve("wise_read", { key: "w3", estimateUsd: 0 })).toEqual({ ok: false, reason: "cap:wise_reads_night" });
    expect(ledger.reserve("correction", { key: "x1", estimateUsd: 0 }).ok).toBe(true);
    expect(ledger.reserve("correction", { key: "x2", estimateUsd: 0 })).toEqual({ ok: false, reason: "cap:corrections_night" });
    expect(ledger.reserve("opus_audit", { key: "neg", estimateUsd: -1 })).toEqual({ ok: false, reason: "invalid_estimate" });
  });

  it("does not count a correction the executor refused before sending (e.g. the sweep held the lock)", () => {
    const ledger = NightlyLedger.open(dir, "2026-10-05", caps({ maxCorrectionsPerNight: 1, maxCorrectionsPerWeek: 1 }), { now });
    for (let attempt = 0; attempt < 3; attempt += 1) {
      const reserved = ledger.reserve("correction", { key: "correction:s1", estimateUsd: 0 });
      if (!reserved.ok) throw new Error(`refused reservation ${attempt} blocked the next: ${reserved.reason}`);
      ledger.settle(reserved.id, { actualUsd: 0, outcome: "refused" });
    }
    expect(ledger.correctionsTonight()).toBe(0);
    expect(ledger.used("correction").count).toBe(3); // the report still sees every attempt
    expect(ledger.refusedTonight("correction:s1")).toBe(3);
    expect(ledger.correctionsSince(7)).toBe(0);
    const real = ledger.reserve("correction", { key: "correction:s1", estimateUsd: 0 });
    if (!real.ok) throw new Error("unreachable");
    ledger.settle(real.id, { actualUsd: 0, outcome: "verified" });
    expect(ledger.correctionsTonight()).toBe(1);
    expect(ledger.reserve("correction", { key: "correction:s2", estimateUsd: 0 })).toEqual({ ok: false, reason: "cap:corrections_night" });
    // An unsettled reservation (in flight or crashed), not_sent, error and refused_after_claim still count.
    const reopened = NightlyLedger.open(dir, "2026-10-05", caps({ maxCorrectionsPerNight: 5, maxCorrectionsPerWeek: 5 }), { now });
    const notSent = reopened.reserve("correction", { key: "correction:s3", estimateUsd: 0 });
    if (!notSent.ok) throw new Error("unreachable");
    reopened.settle(notSent.id, { actualUsd: 0, outcome: "not_sent" });
    for (const outcome of ["error", "refused_after_claim"]) {
      const settled = reopened.reserve("correction", { key: `correction:${outcome}`, estimateUsd: 0 });
      if (!settled.ok) throw new Error("unreachable");
      reopened.settle(settled.id, { actualUsd: 0, outcome });
    }
    expect(reopened.reserve("correction", { key: "correction:s4", estimateUsd: 0 }).ok).toBe(true);
    expect(reopened.correctionsTonight()).toBe(5);
  });

  it("keeps the Claude week and the correction week across nights", () => {
    clock = new Date("2026-09-30T19:00:00Z");
    const first = NightlyLedger.open(dir, "2026-09-30", caps({ maxClaudeUsdWeek: 4, maxCorrectionsPerWeek: 2 }), { now });
    const a = first.reserve("opus_audit", { key: "a", estimateUsd: 1.5 });
    if (!a.ok) throw new Error("unreachable");
    first.settle(a.id, { actualUsd: 3, outcome: "success" });
    expect(first.reserve("correction", { key: "c1", estimateUsd: 0 }).ok).toBe(true);
    expect(first.reserve("correction", { key: "c2", estimateUsd: 0 }).ok).toBe(true);
    clock = new Date("2026-10-02T19:00:00Z");
    const second = NightlyLedger.open(dir, "2026-10-02", caps({ maxClaudeUsdWeek: 4, maxCorrectionsPerWeek: 2 }), { now });
    expect(second.claudeUsd()).toEqual({ night: 0, week: 3, calls: 0 });
    expect(second.reserve("opus_audit", { key: "b", estimateUsd: 1.5 })).toEqual({ ok: false, reason: "cap:claude_usd_week" });
    expect(second.correctionsSince(7)).toBe(2);
    expect(second.reserve("correction", { key: "c3", estimateUsd: 0 })).toEqual({ ok: false, reason: "cap:corrections_week" });
    // A week later the old spend has rolled off.
    clock = new Date("2026-10-08T19:00:00Z");
    const later = NightlyLedger.open(dir, "2026-10-08", caps({ maxClaudeUsdWeek: 4, maxCorrectionsPerWeek: 2 }), { now });
    expect(later.claudeUsd().week).toBe(0);
    expect(later.correctionsSince(7)).toBe(0);
  });

  it("counts only invalid or unparseable answers as a key's failures, across nights; infrastructure failures and crashes do not", () => {
    const first = NightlyLedger.open(dir, "2026-10-01", caps(), { now });
    const settle = (outcome: string) => {
      const reserved = first.reserve("opus_audit", { key: "k", estimateUsd: 1.5 });
      if (!reserved.ok) throw new Error("unreachable");
      first.settle(reserved.id, { actualUsd: 0.1, outcome });
    };
    settle("invalid");
    for (const outcome of ["infra:cli_error", "infra:timeout", "infra:usage_limited", "infra:auth", "infra:budget_exceeded"]) settle(outcome);
    // A reservation this process still holds is in flight …
    const inFlight = first.reserve("opus_audit", { key: "k", estimateUsd: 1.5 });
    expect(inFlight.ok).toBe(true);
    expect(first.attempts("k")).toEqual({ total: 7, failed: 1, succeeded: 0, other: 5 });
    // … and seen from a later run it never settled (the process died): not the key's fault either.
    const second = NightlyLedger.open(dir, "2026-10-02", caps(), { now });
    expect(second.attempts("k")).toEqual({ total: 7, failed: 1, succeeded: 0, other: 6 });
    const reserved = second.reserve("opus_audit", { key: "k", estimateUsd: 1.5 });
    if (!reserved.ok) throw new Error("unreachable");
    second.settle(reserved.id, { actualUsd: 0.1, outcome: "unparseable" });
    expect(second.attempts("k")).toMatchObject({ failed: 2 });
    expect(second.attempts("other")).toEqual({ total: 0, failed: 0, succeeded: 0, other: 0 });
  });

  it("reports a breach when a call cost more than it reserved", () => {
    const ledger = NightlyLedger.open(dir, "2026-10-02", caps({ maxClaudeUsdNight: 2 }), { now });
    const first = ledger.reserve("opus_audit", { key: "a", estimateUsd: 1.5 });
    if (!first.ok) throw new Error("unreachable");
    expect(ledger.settle(first.id, { actualUsd: 2.4, outcome: "success" })).toEqual({ breached: ["claude_usd_night"] });
    expect(() => ledger.settle("nope", { actualUsd: 0, outcome: "success" })).toThrow(/Unknown reservation/u);
    // Settling twice changes nothing.
    expect(ledger.settle(first.id, { actualUsd: 0, outcome: "success" })).toEqual({ breached: [] });
    expect(ledger.used("opus_audit").usd).toBe(2.4);
  });

  it("tells onBreach once per cap when a settled call passed it (the CLI writes STOP)", () => {
    const onBreach = vi.fn();
    const ledger = NightlyLedger.open(dir, "2026-10-02", caps({ maxClaudeUsdNight: 6 }), { now, onBreach });
    const first = ledger.reserve("opus_audit", { key: "a", estimateUsd: 3 });
    if (!first.ok) throw new Error("unreachable");
    ledger.settle(first.id, { actualUsd: 2.9, outcome: "success" });
    expect(onBreach).not.toHaveBeenCalled();
    const second = ledger.reserve("opus_audit", { key: "b", estimateUsd: 3 });
    if (!second.ok) throw new Error("unreachable");
    expect(ledger.settle(second.id, { actualUsd: 3.4, outcome: "success" })).toEqual({ breached: ["claude_usd_night"] });
    expect(onBreach).toHaveBeenCalledTimes(1);
    expect(onBreach).toHaveBeenCalledWith(["claude_usd_night"]);
  });

  it("keeps the estimate when the actual cost is unknown", () => {
    const ledger = NightlyLedger.open(dir, "2026-10-02", caps(), { now });
    const reserved = ledger.reserve("soniox", { key: "s", estimateUsd: 0.12 });
    if (!reserved.ok) throw new Error("unreachable");
    ledger.settle(reserved.id, { actualUsd: null, outcome: "error" });
    expect(ledger.used("soniox")).toEqual({ count: 1, usd: 0.12 });
    expect(ledger.totals().soniox).toEqual({ count: 1, usd: 0.12 });
  });
});
