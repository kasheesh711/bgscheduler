import { and, count, eq, inArray } from "drizzle-orm";
import type { Database } from "@/lib/db";
import * as schema from "@/lib/db/schema";
import type { AutowriterCriticalCategory } from "@/lib/db/schema";
import { withDatabaseTransaction } from "@/lib/db/transaction";
import { AGENT_CORRECTION_ACTOR } from "../correction";
import { recordIncident } from "../incidents";
import { insertFlag } from "../review-job";
import type { ClassReport } from "./report";

/**
 * The nightly audit's only database write: one `agent` flag per class with a major or critical finding — an open flag
 * puts the class back in the owner's review list — and a `critical_flag` incident (pushed by the app's hourly review
 * job) for a critical finding with high confidence. Dry run unless `--apply`. Idempotent per class, text and audit
 * version (`agent-audit:<sid>:<fieldsSha256>:<auditVersion>`); at most `maxFlags` a night, criticals first. The note
 * carries mode codes and severities only — never lesson or feedback text.
 */

export const AGENT_FLAG_ACTOR = "agent:nightly-audit";

const FL = schema.feedbackAutowriterFlags;

const CRITICAL_CATEGORIES = new Set<AutowriterCriticalCategory>(["wrong_person", "billing_status", "invented_content", "should_not_have_posted"]);

export interface FlagPlanItem {
  wiseSessionId: string;
  fieldsSha256: string;
  idempotencyKey: string;
  severity: "critical" | "major";
  suggestedSeverity: "critical" | "factual";
  suggestedCategory: AutowriterCriticalCategory | null;
  note: string;
  /** A critical finding with high confidence: also an incident the review job pushes to the owner. */
  incident: boolean;
  modes: string[];
  /** Who raised it (default `AGENT_FLAG_ACTOR`, the audit): a correction's flag says so (`AGENT_CORRECTION_FLAG_ACTOR`). */
  createdBy?: string;
}

export function agentFlagKey(input: { wiseSessionId: string; fieldsSha256: string; auditVersion: number }): string {
  return `agent-audit:${input.wiseSessionId}:${input.fieldsSha256}:${input.auditVersion}`;
}

/** The night's flags: critical classes first, then major, capped. */
export function planAgentFlags(reports: readonly ClassReport[], input: { auditVersion: number; maxFlags: number }): {
  items: FlagPlanItem[];
  overCap: string[];
} {
  const flaggable = reports
    .filter((report) => report.severity === "critical" || report.severity === "major")
    .sort((a, b) => (a.severity === b.severity ? a.wiseSessionId.localeCompare(b.wiseSessionId) : a.severity === "critical" ? -1 : 1));
  const items: FlagPlanItem[] = [];
  const overCap: string[] = [];
  for (const report of flaggable) {
    if (items.length >= input.maxFlags) {
      overCap.push(report.wiseSessionId);
      continue;
    }
    const severity = report.severity as "critical" | "major";
    const counted = report.findings.filter((finding) => finding.severity === "critical" || finding.severity === "major");
    const codes = [...new Set(counted.map((finding) => `${finding.severity} ${finding.mode ?? finding.code}`))].sort();
    const category = report.criticalCategory && CRITICAL_CATEGORIES.has(report.criticalCategory as AutowriterCriticalCategory)
      ? report.criticalCategory as AutowriterCriticalCategory : null;
    items.push({
      wiseSessionId: report.wiseSessionId,
      fieldsSha256: report.fieldsSha256,
      idempotencyKey: agentFlagKey({ wiseSessionId: report.wiseSessionId, fieldsSha256: report.fieldsSha256, auditVersion: input.auditVersion }),
      severity,
      suggestedSeverity: severity === "critical" ? "critical" : "factual",
      suggestedCategory: severity === "critical" ? category : null,
      note: `Nightly Opus audit (v${input.auditVersion}): ${codes.join("; ")}. Details in the local nightly report.`.slice(0, 500),
      incident: severity === "critical" && report.criticalHighConfidence,
      modes: report.modes,
    });
  }
  return { items, overCap };
}

/** Who raises the flag after a correction: the correction's own actor, so the audit's nightly flag cap never counts it. */
export const AGENT_CORRECTION_FLAG_ACTOR = AGENT_CORRECTION_ACTOR;

/** The idempotency key of the flag a correction raises: one per class, as there is one agent correction per class. */
export function agentCorrectionFlagKey(wiseSessionId: string): string {
  return `agent-correction:${wiseSessionId}`;
}

/**
 * The flag raised after the nightly agent corrected a post in Wise, so the owner reviews the class again: the original
 * finding's severity and category (the verdict still judges the first shot), mode codes in the note, never text.
 */
export function correctionFlagItem(input: {
  wiseSessionId: string;
  /** The corrected text's hash. */
  fieldsSha256: string;
  modes: readonly string[];
  severity: "critical" | "major";
  criticalCategory: string | null;
}): FlagPlanItem {
  const category = input.criticalCategory && CRITICAL_CATEGORIES.has(input.criticalCategory as AutowriterCriticalCategory)
    ? input.criticalCategory as AutowriterCriticalCategory : null;
  return {
    wiseSessionId: input.wiseSessionId,
    fieldsSha256: input.fieldsSha256,
    idempotencyKey: agentCorrectionFlagKey(input.wiseSessionId),
    severity: input.severity,
    suggestedSeverity: input.severity === "critical" ? "critical" : "factual",
    suggestedCategory: input.severity === "critical" ? category : null,
    note: `corrected by the nightly agent: ${[...new Set(input.modes)].join(", ")}`.slice(0, 500),
    incident: false,
    modes: [...input.modes],
    createdBy: AGENT_CORRECTION_FLAG_ACTOR,
  };
}

/** Agent flags the nightly has already raised on these classes (SELECT): what the night's flag cap counts. */
export async function countAgentFlags(db: Database, wiseSessionIds: readonly string[]): Promise<number> {
  if (wiseSessionIds.length === 0) return 0;
  const [row] = await db.select({ total: count() }).from(FL)
    .where(and(eq(FL.source, "agent"), eq(FL.createdBy, AGENT_FLAG_ACTOR), inArray(FL.wiseSessionId, [...wiseSessionIds])));
  return Number(row?.total ?? 0);
}

/**
 * Write the planned flags (and incidents), each in one transaction, in plan order (criticals first). A flag that
 * already exists is counted, not written again; at most `maxNew` new ones are written — the night's cap counted in
 * the database (`countAgentFlags`), so re-runs cannot go past it — and the rest are reported over the cap.
 */
export async function applyAgentFlags(db: Database, items: readonly FlagPlanItem[], options: { maxNew?: number } = {}): Promise<{
  inserted: number;
  existing: number;
  incidents: number;
  overCap: string[];
}> {
  let inserted = 0;
  let existing = 0;
  let incidents = 0;
  const overCap: string[] = [];
  const keys = items.map((item) => item.idempotencyKey);
  const present = new Set(keys.length === 0 ? [] : (await db.select({ key: FL.idempotencyKey }).from(FL)
    .where(inArray(FL.idempotencyKey, keys))).map((row) => row.key));
  for (const item of items) {
    if (present.has(item.idempotencyKey)) {
      existing += 1;
      continue;
    }
    if (options.maxNew !== undefined && inserted >= options.maxNew) {
      overCap.push(item.wiseSessionId);
      continue;
    }
    const done = await withDatabaseTransaction(db, async (tx) => {
      const flagged = await insertFlag(tx, {
        wiseSessionId: item.wiseSessionId,
        source: "agent",
        idempotencyKey: item.idempotencyKey,
        note: item.note,
        suggestedSeverity: item.suggestedSeverity,
        suggestedCategory: item.suggestedCategory,
        createdBy: item.createdBy ?? AGENT_FLAG_ACTOR,
      });
      const pushed = item.incident ? await recordIncident(tx, {
        dedupeKey: item.idempotencyKey,
        kind: "critical_flag",
        severity: "critical",
        wiseSessionId: item.wiseSessionId,
        summary: `Nightly audit: a critical ${item.suggestedCategory ?? "content"} problem (${item.modes.join(", ")}) in a posted feedback — review the class`,
        detail: { source: "nightly_audit", modes: item.modes, fieldsSha256: item.fieldsSha256 },
      }) : false;
      return { flagged, pushed };
    });
    if (done.flagged) inserted += 1;
    else existing += 1;
    if (done.pushed) incidents += 1;
  }
  return { inserted, existing, incidents, overCap };
}
