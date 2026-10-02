import type { Database } from "@/lib/db";
import type { AutowriterCriticalCategory } from "@/lib/db/schema";
import { withDatabaseTransaction } from "@/lib/db/transaction";
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

/** Write the planned flags (and incidents), each in one transaction. Re-running inserts nothing new. */
export async function applyAgentFlags(db: Database, items: readonly FlagPlanItem[]): Promise<{
  inserted: number;
  existing: number;
  incidents: number;
}> {
  let inserted = 0;
  let existing = 0;
  let incidents = 0;
  for (const item of items) {
    const done = await withDatabaseTransaction(db, async (tx) => {
      const flagged = await insertFlag(tx, {
        wiseSessionId: item.wiseSessionId,
        source: "agent",
        idempotencyKey: item.idempotencyKey,
        note: item.note,
        suggestedSeverity: item.suggestedSeverity,
        suggestedCategory: item.suggestedCategory,
        createdBy: AGENT_FLAG_ACTOR,
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
  return { inserted, existing, incidents };
}
