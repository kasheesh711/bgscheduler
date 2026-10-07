import { randomUUID } from "node:crypto";
import path from "node:path";
import type { NightlyCaps } from "./caps";
import { appendJsonl, readJsonl } from "./paths";

/**
 * Reserve-before-spend ledger of the nightly audit (`<state root>/spend.jsonl`, metadata only, kept across nights).
 * Every paid or capped action — a `claude -p` call, an OpenRouter call, a Soniox job, a Wise read, a correction — is
 * reserved here, fsynced to disk, BEFORE it starts, and refused when it would pass a cap; it is settled with its
 * actual cost afterwards. A reservation never settled (the process died) keeps counting at its estimate, so a crash
 * can only make the ledger more cautious.
 */

export const SPEND_KINDS = [
  "opus_audit", "opus_reaudit", "opus_synthesis", "opus_fix", "openrouter", "soniox", "wise_read", "correction",
] as const;
export type SpendKind = (typeof SPEND_KINDS)[number];

const CLAUDE_KINDS = new Set<SpendKind>(["opus_audit", "opus_reaudit", "opus_synthesis", "opus_fix"]);

/**
 * Outcomes that are the key's own failure (the model answered, but not usably) and count toward `failed_twice`.
 * Everything else that is not a success — `infra:*` (CLI error, time-out, budget, usage limit, auth), a stop, or a
 * reservation a crashed process never settled — is not the key's fault: the next run tries it again.
 */
const KEY_FAILURES = new Set(["invalid", "unparseable"]);

const DAY_MS = 24 * 60 * 60 * 1000;

interface ReserveLine {
  type: "reserve";
  id: string;
  night: string;
  kind: SpendKind;
  key: string;
  estimateUsd: number;
  at: string;
}

interface SettleLine {
  type: "settle";
  id: string;
  actualUsd: number | null;
  outcome: string;
  at: string;
}

type LedgerLine = ReserveLine | SettleLine;

export type ReserveResult = { ok: true; id: string } | { ok: false; reason: string };

interface Entry extends ReserveLine {
  settled: SettleLine | null;
}

/**
 * A correction settled as `refused`: the guarded executor stopped before the POST (e.g. `lock:sweep_running` when
 * the autowriter's own sweep held the lock), so Wise was never written. `not_sent` still counts: its lock was
 * claimed and the class's one correction is used up.
 */
function refusedCorrection(entry: Entry): boolean {
  return entry.settled?.outcome === "refused";
}

export class NightlyLedger {
  private readonly entries = new Map<string, Entry>();
  /** Reservations made by this process and not settled yet: in flight, not crashed. */
  private readonly live = new Set<string>();

  /** Breaches already reported to `onBreach` by this process. */
  private readonly reported = new Set<string>();

  private constructor(
    readonly file: string,
    readonly night: string,
    private readonly caps: NightlyCaps,
    private readonly now: () => Date,
    private readonly onBreach: ((breached: string[]) => void) | null,
  ) {}

  /**
   * Opens `<dir>/spend.jsonl` (created on the first reservation). `onBreach` is told, once per cap, when a settled call
   * cost so much more than it reserved that a cap is now passed (the CLI writes the STOP file).
   */
  static open(dir: string, night: string, caps: NightlyCaps, options: { now?: () => Date; onBreach?: (breached: string[]) => void } = {}): NightlyLedger {
    const ledger = new NightlyLedger(path.join(dir, "spend.jsonl"), night, caps, options.now ?? (() => new Date()), options.onBreach ?? null);
    for (const line of readJsonl<LedgerLine>(ledger.file)) ledger.apply(line);
    return ledger;
  }

  private apply(line: LedgerLine): void {
    if (line?.type === "reserve" && typeof line.id === "string" && SPEND_KINDS.includes(line.kind)) {
      this.entries.set(line.id, { ...line, settled: null });
    } else if (line?.type === "settle" && typeof line.id === "string") {
      const entry = this.entries.get(line.id);
      if (entry) entry.settled = line;
    }
  }

  private amount(entry: Entry): number {
    const actual = entry.settled?.actualUsd;
    return typeof actual === "number" && Number.isFinite(actual) ? actual : entry.estimateUsd;
  }

  private select(filter: (entry: Entry) => boolean): Entry[] {
    return [...this.entries.values()].filter(filter);
  }

  private tonight(kind: (entry: Entry) => boolean): Entry[] {
    return this.select((entry) => entry.night === this.night && kind(entry));
  }

  private since(days: number, kind: (entry: Entry) => boolean): Entry[] {
    const from = this.now().getTime() - days * DAY_MS;
    return this.select((entry) => new Date(entry.at).getTime() >= from && kind(entry));
  }

  private sum(entries: readonly Entry[]): number {
    return entries.reduce((total, entry) => total + this.amount(entry), 0);
  }

  /**
   * Tonight's count and spend of one kind (unsettled reservations at their estimate). A correction the executor
   * refused (a guard or the lock said no, nothing was sent to Wise) does not use up a correction.
   */
  used(kind: SpendKind): { count: number; usd: number } {
    const entries = this.tonight((entry) => entry.kind === kind && !(kind === "correction" && refusedCorrection(entry)));
    return { count: entries.length, usd: this.sum(entries) };
  }

  /** Claude (API-equivalent) spend tonight, and over the last 7 days. */
  claudeUsd(): { night: number; week: number; calls: number } {
    const tonight = this.tonight((entry) => CLAUDE_KINDS.has(entry.kind));
    return { night: this.sum(tonight), week: this.sum(this.since(7, (entry) => CLAUDE_KINDS.has(entry.kind))), calls: tonight.length };
  }

  /**
   * Every reservation of a key across nights: how many; how many failed by the key's own fault (an invalid or
   * unparseable answer — what `failed_twice` counts); how many succeeded; and how many ended otherwise (an
   * infrastructure failure, a stop, or a reservation a crashed process never settled).
   */
  attempts(key: string): { total: number; failed: number; succeeded: number; other: number } {
    const entries = this.select((entry) => entry.key === key);
    let failed = 0;
    let succeeded = 0;
    let other = 0;
    for (const entry of entries) {
      if (!entry.settled) {
        if (!this.live.has(entry.id)) other += 1;
      } else if (entry.settled.outcome === "success") {
        succeeded += 1;
      } else if (KEY_FAILURES.has(entry.settled.outcome)) {
        failed += 1;
      } else {
        other += 1;
      }
    }
    return { total: entries.length, failed, succeeded, other };
  }

  /** Corrections reserved in the last `days` days (all nights), less those the executor refused before sending. */
  correctionsSince(days: number): number {
    return this.since(days, (entry) => entry.kind === "correction" && !refusedCorrection(entry)).length;
  }

  /** Why one more reservation of this kind would pass a cap, or null. */
  private refusal(kind: SpendKind, estimateUsd: number): string | null {
    const caps = this.caps;
    if (CLAUDE_KINDS.has(kind)) {
      const perCall: Partial<Record<SpendKind, number>> = {
        opus_audit: caps.perAuditUsd, opus_reaudit: caps.perReauditUsd, opus_synthesis: caps.perSynthesisUsd,
      };
      const limit = perCall[kind];
      if (limit !== undefined && estimateUsd > limit + 1e-9) return `cap:${kind}_per_call`;
      const claude = this.claudeUsd();
      if (claude.calls + 1 > caps.maxOpusCalls) return "cap:opus_calls_night";
      if (claude.night + estimateUsd > caps.maxClaudeUsdNight + 1e-9) return "cap:claude_usd_night";
      if (claude.week + estimateUsd > caps.maxClaudeUsdWeek + 1e-9) return "cap:claude_usd_week";
      return null;
    }
    if (kind === "soniox") {
      return this.used("soniox").usd + estimateUsd > caps.maxSonioxUsdNight + 1e-9 ? "cap:soniox_usd_night" : null;
    }
    if (kind === "openrouter") {
      return this.used("openrouter").usd + estimateUsd > caps.maxOpenRouterUsdNight + 1e-9 ? "cap:openrouter_usd_night" : null;
    }
    if (kind === "wise_read") {
      return this.used("wise_read").count + 1 > caps.maxWiseReads ? "cap:wise_reads_night" : null;
    }
    if (this.used("correction").count + 1 > caps.maxCorrectionsPerNight) return "cap:corrections_night";
    if (this.correctionsSince(7) + 1 > caps.maxCorrectionsPerWeek) return "cap:corrections_week";
    return null;
  }

  /**
   * Reserve before spending: refused when it would pass a cap; otherwise written and fsynced to disk before this
   * returns, so the spend can never happen unrecorded.
   */
  reserve(kind: SpendKind, input: { key: string; estimateUsd: number }): ReserveResult {
    if (!SPEND_KINDS.includes(kind)) return { ok: false, reason: `unknown_kind:${String(kind)}` };
    const estimateUsd = Number.isFinite(input.estimateUsd) && input.estimateUsd >= 0 ? input.estimateUsd : NaN;
    if (Number.isNaN(estimateUsd)) return { ok: false, reason: "invalid_estimate" };
    const refused = this.refusal(kind, estimateUsd);
    if (refused) return { ok: false, reason: refused };
    const line: ReserveLine = {
      type: "reserve", id: randomUUID(), night: this.night, kind, key: input.key, estimateUsd, at: this.now().toISOString(),
    };
    appendJsonl(this.file, line);
    this.apply(line);
    this.live.add(line.id);
    return { ok: true, id: line.id };
  }

  /**
   * Settle a reservation with what it actually cost (null: unknown, kept at its estimate). Returns the caps the
   * actual spend has now passed — a breach the caller answers with the STOP file.
   */
  settle(id: string, input: { actualUsd: number | null; outcome: string }): { breached: string[] } {
    const entry = this.entries.get(id);
    if (!entry) throw new Error(`Unknown reservation ${id}`);
    if (entry.settled) return { breached: [] };
    const actualUsd = typeof input.actualUsd === "number" && Number.isFinite(input.actualUsd) && input.actualUsd >= 0
      ? input.actualUsd : null;
    const line: SettleLine = { type: "settle", id, actualUsd, outcome: input.outcome.slice(0, 80), at: this.now().toISOString() };
    appendJsonl(this.file, line);
    this.apply(line);
    this.live.delete(id);
    const breached = this.breaches();
    const fresh = breached.filter((cap) => !this.reported.has(cap));
    if (fresh.length > 0 && this.onBreach) {
      for (const cap of fresh) this.reported.add(cap);
      this.onBreach(fresh);
    }
    return { breached };
  }

  /** Caps the recorded spend has passed (only possible when a call cost more than it reserved). */
  breaches(): string[] {
    const caps = this.caps;
    const claude = this.claudeUsd();
    const breached: string[] = [];
    if (claude.night > caps.maxClaudeUsdNight + 1e-9) breached.push("claude_usd_night");
    if (claude.week > caps.maxClaudeUsdWeek + 1e-9) breached.push("claude_usd_week");
    if (this.used("soniox").usd > caps.maxSonioxUsdNight + 1e-9) breached.push("soniox_usd_night");
    if (this.used("openrouter").usd > caps.maxOpenRouterUsdNight + 1e-9) breached.push("openrouter_usd_night");
    return breached;
  }

  /** Tonight's totals for the report (metadata only). */
  totals(): Record<SpendKind, { count: number; usd: number }> {
    return Object.fromEntries(SPEND_KINDS.map((kind) => [kind, this.used(kind)])) as Record<SpendKind, { count: number; usd: number }>;
  }
}
