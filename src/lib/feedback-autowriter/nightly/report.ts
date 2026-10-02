import { and, gte, lt, sql } from "drizzle-orm";
import type { Database } from "@/lib/db";
import * as schema from "@/lib/db/schema";
import { passingStoredVerdict } from "../judge";
import { addDays, bangkokDayBounds } from "../quality";
import type { AuditResult } from "./audit-schema";
import { failureMode, severityRank, type FailureSeverity } from "./modes";
import { readJsonl } from "./paths";
import { auditKey } from "./select";
import type { BundleFile } from "./steps";
import type { AuditRecord, PrecheckFinding } from "./types";

/**
 * The night's findings: deterministic prechecks merged with the Opus audit (a critical or major precheck is never
 * downgraded; a candidate counts only when the audit confirms it), grouped by failure mode, plus the production spend
 * and retry watchdog (`M16 cost_runaway`) over `feedback_autowriter_calls`. `report.md` (local) carries the quotes;
 * `summary.md` and the ledger lines carry no names and no lesson or feedback text.
 */

export type ReportSeverity = FailureSeverity | "info";

export interface ReportFinding {
  source: "precheck" | "audit" | "omission";
  /** A precheck code, an audit issue id or an omission kind — never a name or a quote. */
  code: string;
  mode: string | null;
  severity: ReportSeverity;
  confidence: "high" | "medium" | "low" | null;
  criticalCategory: string | null;
  field: string | null;
  /** Local report only. */
  quote: string | null;
  /** Local report only. */
  detail: string | null;
  /** Local report only. */
  minimalFix: AuditResult["issues"][number]["minimalFix"] | null;
  /** Local report only. */
  evidence: AuditResult["issues"][number]["evidence"];
  /** A candidate precheck: whether the audit confirmed it (null: no audit to confirm it). */
  confirmed: boolean | null;
}

export interface ClassReport {
  wiseSessionId: string;
  fieldsSha256: string;
  /** Local report only. */
  tutorKey: string | null;
  /** Local report only. */
  className: string | null;
  postedEvidenceKind: "summary" | "transcript";
  grade: string;
  /** A post of an earlier night picked up late: that night. */
  lateFrom: string | null;
  /** Whether better evidence may still come for this class. */
  improvable: boolean;
  auditVerdict: AuditResult["verdict"] | null;
  auditFailure: string | null;
  auditSummaryLine: string | null;
  /** Worst severity of the merged findings (null: nothing wrong found). */
  severity: FailureSeverity | null;
  modes: string[];
  findings: ReportFinding[];
  ownerVerdict: "approve" | "needs_fix" | null;
  /** Whether the production judges passed the post (null: no stored verdict). */
  judgePassed: boolean | null;
  wiseTextEdited: boolean;
  costUsd: number | null;
  /** A deterministic critical floor, or a critical audit issue with high confidence. */
  criticalHighConfidence: boolean;
  /** The critical category to suggest on a flag. */
  criticalCategory: string | null;
}

function precheckFinding(precheck: PrecheckFinding, confirmed: boolean | null): ReportFinding {
  const counts = !precheck.candidate || confirmed === true;
  return {
    source: "precheck",
    code: precheck.code,
    mode: precheck.mode,
    severity: counts ? precheck.severity : "info",
    confidence: precheck.candidate ? null : precheck.severity === "info" ? null : "high",
    criticalCategory: counts && precheck.severity === "critical" && precheck.mode ? failureMode(precheck.mode)?.criticalCategory ?? null : null,
    field: null,
    quote: null,
    detail: precheck.candidate && !counts ? `${precheck.detail} — ${confirmed === false ? "rejected by the audit" : "not confirmed (no audit)"}` : precheck.detail,
    minimalFix: null,
    evidence: [],
    confirmed: precheck.candidate ? confirmed : null,
  };
}

/** Whether the production judges passed the stored draft: true, false, or null when there is no stored verdict. */
export function judgePassedOf(storedJudge: unknown): boolean | null {
  if (!storedJudge || typeof storedJudge !== "object" || !("faithful" in storedJudge)) return null;
  return passingStoredVerdict(storedJudge) !== null;
}

/**
 * The audit's review of one candidate: matched on its unique id (`code#n`). A review under the bare code counts only
 * when that code is unambiguous (one candidate has it — also how bundles collected before ids are matched); a bare
 * code shared by several candidates confirms them all when any such review confirms (fail closed: a person looks),
 * and otherwise leaves them unconfirmed.
 */
export function candidateVerdict(
  precheck: PrecheckFinding,
  prechecks: readonly PrecheckFinding[],
  reviews: AuditResult["candidateReview"],
): boolean | null {
  const id = precheck.id ?? precheck.code;
  const exact = reviews.filter((review) => review.code.trim() === id);
  if (exact.length > 0) return exact.at(-1)!.confirmed;
  const bare = reviews.filter((review) => review.code.trim() === precheck.code);
  if (bare.length === 0) return null;
  const sharing = prechecks.filter((item) => item.candidate && item.code === precheck.code).length;
  if (sharing <= 1) return bare.at(-1)!.confirmed;
  return bare.some((review) => review.confirmed) ? true : null;
}

/** One class's findings: prechecks floors, confirmed candidates, the audit's issues and omissions. */
export function mergeClassReport(file: BundleFile, record: AuditRecord | null): ClassReport {
  const result = record?.result ?? null;
  const reviews = result?.candidateReview ?? [];
  const findings: ReportFinding[] = file.prechecks.map((precheck) =>
    precheckFinding(precheck, precheck.candidate ? candidateVerdict(precheck, file.prechecks, reviews) : null));
  for (const issue of result?.issues ?? []) {
    findings.push({
      source: "audit", code: issue.id, mode: issue.mode, severity: issue.severity, confidence: issue.confidence,
      criticalCategory: issue.criticalCategory, field: issue.field, quote: issue.quote, detail: issue.mechanism,
      minimalFix: issue.minimalFix, evidence: issue.evidence, confirmed: null,
    });
  }
  for (const omission of result?.omissions ?? []) {
    findings.push({
      source: "omission", code: omission.what, mode: "M09", severity: omission.severity, confidence: null, criticalCategory: null,
      field: null, quote: null, detail: omission.detail, minimalFix: null, evidence: omission.evidence, confirmed: null,
    });
  }
  const counted = findings.filter((finding) => finding.severity !== "info");
  let severity: FailureSeverity | null = null;
  for (const finding of counted) {
    const value = finding.severity as FailureSeverity;
    if (!severity || severityRank(value) > severityRank(severity)) severity = value;
  }
  const criticals = counted.filter((finding) => finding.severity === "critical");
  return {
    wiseSessionId: file.target.wiseSessionId,
    fieldsSha256: file.target.fieldsSha256,
    tutorKey: file.target.tutorKey,
    className: file.target.className,
    postedEvidenceKind: file.bundle.postedEvidenceKind,
    grade: file.bundle.grade,
    lateFrom: file.target.lateFrom ?? null,
    improvable: file.improvable ?? false,
    auditVerdict: result?.verdict ?? null,
    auditFailure: record?.failure ?? (record ? null
      : file.transient && file.transient.length > 0 ? `collection_incomplete:${file.transient.join(",")}`
        : file.bundle.grade === "none" ? "no_evidence" : "not_audited"),
    auditSummaryLine: result?.summaryLine ?? null,
    severity,
    modes: [...new Set(counted.flatMap((finding) => (finding.mode ? [finding.mode] : [])))].sort(),
    findings,
    ownerVerdict: file.target.verdict,
    judgePassed: judgePassedOf(file.bundle.storedJudge),
    wiseTextEdited: file.bundle.wiseTextMatchesPost === false,
    costUsd: record?.proof?.costUsd ?? null,
    criticalHighConfidence: criticals.some((finding) => finding.confidence === "high"),
    criticalCategory: criticals.find((finding) => finding.criticalCategory)?.criticalCategory ?? null,
  };
}

export interface ModeGroup {
  mode: string;
  title: string;
  classes: number;
  critical: number;
  major: number;
  cosmetic: number;
  sessions: string[];
  /** Classes with this mode over the last 14 nights (this night included). */
  count14d: number;
}

/** The night's failure modes, worst and most frequent first. */
export function groupByMode(reports: readonly ClassReport[], history: ReadonlyMap<string, number> = new Map()): ModeGroup[] {
  const groups = new Map<string, ModeGroup>();
  for (const report of reports) {
    for (const finding of report.findings) {
      if (!finding.mode || finding.severity === "info") continue;
      const group = groups.get(finding.mode) ?? {
        mode: finding.mode, title: failureMode(finding.mode)?.title ?? finding.mode, classes: 0, critical: 0, major: 0, cosmetic: 0,
        sessions: [], count14d: history.get(finding.mode) ?? 0,
      };
      if (!group.sessions.includes(report.wiseSessionId)) {
        group.sessions.push(report.wiseSessionId);
        group.classes += 1;
      }
      group[finding.severity as FailureSeverity] += 1;
      groups.set(finding.mode, group);
    }
  }
  return [...groups.values()].sort((a, b) => b.critical - a.critical || b.major - a.major || b.classes - a.classes || a.mode.localeCompare(b.mode));
}

/** One `class_report` line of the metadata ledger: ids, hashes, modes, severities, verdicts, cost — no text, no names. */
export function classReportLine(night: string, report: ClassReport, at: string, auditVersion: number): Record<string, unknown> {
  return {
    type: "class_report",
    night,
    at,
    key: auditKey({ wiseSessionId: report.wiseSessionId, fieldsSha256: report.fieldsSha256, auditVersion }),
    wiseSessionId: report.wiseSessionId,
    fieldsSha256: report.fieldsSha256,
    auditVersion,
    grade: report.grade,
    postedEvidenceKind: report.postedEvidenceKind,
    lateFrom: report.lateFrom,
    auditVerdict: report.auditVerdict,
    auditFailure: report.auditFailure,
    severity: report.severity,
    modes: report.modes,
    findings: report.findings.filter((finding) => finding.severity !== "info").map((finding) => ({
      source: finding.source, code: finding.code, mode: finding.mode, severity: finding.severity, confidence: finding.confidence,
    })),
    ownerVerdict: report.ownerVerdict,
    judgePassed: report.judgePassed,
    wiseTextEdited: report.wiseTextEdited,
    costUsd: report.costUsd,
  };
}

/** Classes per failure mode over the 14 nights ending `night`, from the latest class_report line of each class. */
export function modeHistory(ledgerJsonl: string, night: string): Map<string, number> {
  const from = addDays(night, -13);
  const latest = new Map<string, { night: string; modes: string[] }>();
  for (const line of readJsonl<{ type?: string; night?: string; wiseSessionId?: string; modes?: string[] }>(ledgerJsonl)) {
    if (line.type !== "class_report" || !line.night || !line.wiseSessionId || line.night < from || line.night > night) continue;
    latest.set(`${line.night}|${line.wiseSessionId}`, { night: line.night, modes: Array.isArray(line.modes) ? line.modes : [] });
  }
  const counts = new Map<string, number>();
  for (const { modes } of latest.values()) for (const mode of new Set(modes)) counts.set(mode, (counts.get(mode) ?? 0) + 1);
  return counts;
}

// ---------------------------------------------------------------------------
// Production spend and retry watchdog (M16)
// ---------------------------------------------------------------------------

export const WATCHDOG_LIMITS = {
  costUsd: 0.75,
  writerCalls: 4,
  judgeCalls: 12,
  transcriberCalls: 1,
  timeouts: 2,
  unpriced: 3,
  dayVsMedian: 3,
} as const;

export interface WatchdogRow {
  wiseSessionId: string;
  calls: number;
  writerCalls: number;
  judgeCalls: number;
  transcriberCalls: number;
  timeouts: number;
  unpriced: number;
  costUsd: number;
}

export interface WatchdogResult {
  rows: WatchdogRow[];
  outliers: Array<{ wiseSessionId: string; reasons: string[]; costUsd: number }>;
  dayTotalUsd: number;
  previousDays: Array<{ day: string; usd: number }>;
  medianPreviousUsd: number | null;
  dayOutlier: boolean;
}

/** Classes with abnormal spend or retries (any class, held ones included). */
export function watchdogOutliers(rows: readonly WatchdogRow[]): WatchdogResult["outliers"] {
  const out: WatchdogResult["outliers"] = [];
  for (const row of rows) {
    const reasons: string[] = [];
    if (row.costUsd > WATCHDOG_LIMITS.costUsd) reasons.push(`cost_${row.costUsd.toFixed(2)}_usd`);
    if (row.writerCalls > WATCHDOG_LIMITS.writerCalls) reasons.push(`writer_runs_${row.writerCalls}`);
    if (row.judgeCalls > WATCHDOG_LIMITS.judgeCalls) reasons.push(`judge_calls_${row.judgeCalls}`);
    if (row.transcriberCalls > WATCHDOG_LIMITS.transcriberCalls) reasons.push(`soniox_jobs_${row.transcriberCalls}`);
    if (row.timeouts >= WATCHDOG_LIMITS.timeouts) reasons.push(`timeouts_${row.timeouts}`);
    if (row.unpriced >= WATCHDOG_LIMITS.unpriced) reasons.push(`unpriced_calls_${row.unpriced}`);
    if (reasons.length > 0) out.push({ wiseSessionId: row.wiseSessionId, reasons, costUsd: row.costUsd });
  }
  return out.sort((a, b) => b.costUsd - a.costUsd);
}

function median(values: readonly number[]): number | null {
  if (values.length === 0) return null;
  const sorted = [...values].sort((a, b) => a - b);
  const middle = Math.floor(sorted.length / 2);
  return sorted.length % 2 ? sorted[middle] : (sorted[middle - 1] + sorted[middle]) / 2;
}

/** The day's production model and transcription calls per class (SELECT only), and the day against its last 7. */
export async function loadWatchdog(db: Database, input: { night: string }): Promise<WatchdogResult> {
  const C = schema.feedbackAutowriterCalls;
  const { start, end } = bangkokDayBounds(input.night);
  const count = (condition: ReturnType<typeof sql>) => sql<number>`count(*) filter (where ${condition})`.mapWith(Number);
  const rows = await db.select({
    wiseSessionId: C.wiseSessionId,
    calls: sql<number>`count(*)`.mapWith(Number),
    writerCalls: count(sql`${C.role} = 'writer'`),
    judgeCalls: count(sql`${C.role} = 'judge'`),
    transcriberCalls: count(sql`${C.role} = 'transcriber'`),
    timeouts: count(sql`${C.error} ilike '%timeout%' or ${C.error} ilike '%timed out%' or ${C.error} ilike '%aborterror%'`),
    unpriced: count(sql`${C.costUsd} is null`),
    costUsd: sql<number>`coalesce(sum(${C.costUsd}), 0)`.mapWith(Number),
  }).from(C)
    .where(and(gte(C.createdAt, start), lt(C.createdAt, end)))
    .groupBy(C.wiseSessionId);
  const weekStart = bangkokDayBounds(addDays(input.night, -7)).start;
  const days = await db.select({
    day: sql<string>`to_char(${C.createdAt} at time zone 'Asia/Bangkok', 'YYYY-MM-DD')`,
    usd: sql<number>`coalesce(sum(${C.costUsd}), 0)`.mapWith(Number),
  }).from(C)
    .where(and(gte(C.createdAt, weekStart), lt(C.createdAt, start)))
    .groupBy(sql`1`)
    .orderBy(sql`1`);
  const dayTotalUsd = rows.reduce((sum, row) => sum + row.costUsd, 0);
  const medianPreviousUsd = days.length >= 3 ? median(days.map((day) => day.usd)) : null;
  return {
    rows,
    outliers: watchdogOutliers(rows),
    dayTotalUsd,
    previousDays: days,
    medianPreviousUsd,
    dayOutlier: medianPreviousUsd !== null && medianPreviousUsd > 0 && dayTotalUsd > WATCHDOG_LIMITS.dayVsMedian * medianPreviousUsd,
  };
}

// ---------------------------------------------------------------------------
// Rendering
// ---------------------------------------------------------------------------

export interface NightCosts {
  claudeUsd: number;
  claudeCalls: number;
  opusProven: number;
  sonioxUsd: number;
  openrouterUsd: number;
  wiseReads: number;
}

export interface ReportInput {
  night: string;
  generatedAt: string;
  code: { head: string | null; branch: string | null } | null;
  cliVersion: string | null;
  reports: readonly ClassReport[];
  modes: readonly ModeGroup[];
  watchdog: WatchdogResult | null;
  costs: NightCosts;
  synthesisLine: string | null;
  notes: readonly string[];
}

function cell(value: unknown): string {
  return String(value ?? "—").replace(/\|/gu, "/").replace(/\n/gu, " ");
}

/**
 * The night's posts: how many were audited successfully, their verdicts (deterministic floors merged in), and why the
 * others were not (collection incomplete, no evidence, a failed or refused audit — by category, never counted as audited).
 */
export function auditCounts(reports: readonly ClassReport[]): {
  posts: number;
  audited: number;
  verdicts: Record<string, number>;
  notAudited: Record<string, number>;
} {
  const verdicts: Record<string, number> = { accurate: 0, cosmetic: 0, major: 0, critical: 0, insufficient_evidence: 0 };
  const notAudited: Record<string, number> = {};
  let audited = 0;
  for (const report of reports) {
    if (report.auditVerdict === null) {
      const reason = (report.auditFailure ?? "not_audited").split(":")[0];
      notAudited[reason] = (notAudited[reason] ?? 0) + 1;
      continue;
    }
    audited += 1;
    const key = report.severity ?? (report.auditVerdict === "insufficient_evidence" ? "insufficient_evidence" : "accurate");
    verdicts[key] = (verdicts[key] ?? 0) + 1;
  }
  return { posts: reports.length, audited, verdicts, notAudited };
}

/** "Posts 14; audited 12 (accurate 9, …); not audited 2 (collection_incomplete 1, invalid 1)". */
function auditCountsLine(reports: readonly ClassReport[]): string {
  const counts = auditCounts(reports);
  const list = (record: Record<string, number>) => Object.entries(record).map(([key, value]) => `${key} ${value}`).join(", ");
  const notAudited = counts.posts - counts.audited;
  return `Posts ${counts.posts}; audited ${counts.audited} (${list(counts.verdicts)})` +
    (notAudited > 0 ? `; not audited ${notAudited} (${list(counts.notAudited)})` : "");
}

const SEVERITY_ORDER: Record<string, number> = { critical: 0, major: 1, cosmetic: 2 };

/**
 * The proof line: calls whose usage shows claude-opus-5-5, out of all calls. `modelUsage` proves the model, not the
 * effort: max effort was requested on every call (`--effort max`), which is all the CLI can attest.
 */
export function proofLine(counts: { opusProven: number; claudeCalls: number }): string {
  return `Opus5.5 (effort max requested) ${counts.opusProven}/${counts.claudeCalls}`;
}

/** `report.md`: everything, quotes included (local, 0600, deleted after 7 days). */
export function renderReportMarkdown(input: ReportInput): string {
  const sorted = [...input.reports].sort((a, b) =>
    (SEVERITY_ORDER[a.severity ?? ""] ?? 3) - (SEVERITY_ORDER[b.severity ?? ""] ?? 3) || a.wiseSessionId.localeCompare(b.wiseSessionId));
  const lines = [
    `# Nightly audit — ${input.night}`,
    "",
    `Generated ${input.generatedAt}; code \`${input.code?.head?.slice(0, 12) ?? "unknown"}\` (${input.code?.branch ?? "?"}); ${input.cliVersion ?? "claude CLI ?"}.`,
    `Proof: ${proofLine(input.costs)} calls. Spend: Claude $${input.costs.claudeUsd.toFixed(2)} (API-equivalent, subscription), ` +
      `Soniox $${input.costs.sonioxUsd.toFixed(2)}, Wise reads ${input.costs.wiseReads}.`,
    "",
    "## Posts",
    "",
    `${auditCountsLine(input.reports)}.`,
    ...(input.synthesisLine ? ["", `Synthesis: ${input.synthesisLine} (see plan.md)`] : []),
    ...input.notes.map((note) => `- ${note}`),
    "",
    "## Failure modes",
    "",
    "| Mode | Title | Classes | Critical | Major | Cosmetic | 14 nights |",
    "|---|---|---:|---:|---:|---:|---:|",
    ...input.modes.map((group) => `| ${group.mode} | ${cell(group.title)} | ${group.classes} | ${group.critical} | ${group.major} | ${group.cosmetic} | ${group.count14d} |`),
    "",
    "## Classes",
    "",
  ];
  for (const report of sorted) {
    lines.push(
      `### ${report.wiseSessionId} — ${report.severity ?? (report.auditVerdict ?? "not audited")}`,
      "",
      `${report.lateFrom ? `Late pickup from ${report.lateFrom} (verified after that night's selection). ` : ""}` +
        `Tutor ${report.tutorKey ?? "?"}; class ${report.className ?? "?"}; posted from ${report.postedEvidenceKind}; evidence ${report.grade}; ` +
        `owner verdict ${report.ownerVerdict ?? "none"}; production judges passed ${report.judgePassed ?? "?"}` +
        `${report.wiseTextEdited ? "; TEXT EDITED IN WISE SINCE OUR POST (never corrected over)" : ""}.`,
      ...(report.auditFailure ? [`Not audited: ${report.auditFailure}`] : []),
      ...(report.auditVerdict === "insufficient_evidence" && report.improvable
        ? ["Evidence may still improve (collect again, with --retranscribe while Wise lists the recording)."] : []),
      ...(report.auditSummaryLine ? [`Audit: ${report.auditSummaryLine}`] : []),
      "",
    );
    for (const finding of report.findings.filter((item) => item.severity !== "info")) {
      lines.push(`- **${finding.severity}** ${finding.mode ?? ""} ${finding.source}:${finding.code}${finding.confidence ? ` (${finding.confidence})` : ""}` +
        `${finding.field ? ` in ${finding.field}` : ""}: ${finding.detail ?? ""}`);
      if (finding.quote) lines.push(`  - Posted: "${finding.quote}"`);
      for (const quote of finding.evidence) lines.push(`  - Evidence (${quote.source}${quote.locator ? ` ${quote.locator}` : ""}${quote.speaker ? ` ${quote.speaker}` : ""}): "${quote.quote}"${quote.gloss ? ` — ${quote.gloss}` : ""}`);
      if (finding.minimalFix) lines.push(`  - Minimal fix: ${finding.minimalFix.action} "${finding.minimalFix.from}"${finding.minimalFix.to !== null ? ` → "${finding.minimalFix.to}"` : ""}`);
    }
    const info = report.findings.filter((item) => item.severity === "info").map((item) => item.code);
    if (info.length > 0) lines.push(`- info: ${info.join(", ")}`);
    lines.push("");
  }
  lines.push("## Production spend and retries (M16 watchdog)", "");
  if (!input.watchdog) {
    lines.push("Not run.");
  } else {
    lines.push(
      `Day total $${input.watchdog.dayTotalUsd.toFixed(2)}; median of the previous days ${input.watchdog.medianPreviousUsd === null ? "n/a" : `$${input.watchdog.medianPreviousUsd.toFixed(2)}`}` +
        `${input.watchdog.dayOutlier ? " — ABOVE 3× THE MEDIAN" : ""}.`,
      "",
      ...(input.watchdog.outliers.length === 0 ? ["No class over the limits."] : [
        "| Session | Cost | Reasons |",
        "|---|---:|---|",
        ...input.watchdog.outliers.map((outlier) => `| ${outlier.wiseSessionId} | $${outlier.costUsd.toFixed(3)} | ${outlier.reasons.join(", ")} |`),
      ]),
    );
  }
  lines.push("");
  return lines.join("\n");
}

/** `summary.md`: counts, modes, costs and proof only — no names, no quotes, no lesson or feedback text. */
export function renderSummaryMarkdown(input: ReportInput): string {
  const flagged = input.reports.filter((report) => report.severity === "critical" || report.severity === "major");
  return [
    `# Nightly audit summary — ${input.night}`,
    "",
    `- ${auditCountsLine(input.reports)}`,
    `- Major or critical: ${flagged.length}; already approved by the owner: ${flagged.filter((report) => report.ownerVerdict === "approve").length}; ` +
      `passed by the production judges: ${flagged.filter((report) => report.judgePassed === true).length}`,
    `- Modes: ${input.modes.map((group) => `${group.mode}×${group.classes}`).join(", ") || "none"}`,
    `- Proof: ${proofLine(input.costs)}`,
    `- Spend: Claude $${input.costs.claudeUsd.toFixed(2)} API-eq, Soniox $${input.costs.sonioxUsd.toFixed(2)}, OpenRouter $${input.costs.openrouterUsd.toFixed(2)}, Wise reads ${input.costs.wiseReads}`,
    `- Watchdog (M16): ${input.watchdog ? `${input.watchdog.outliers.length} class(es) over the limits${input.watchdog.dayOutlier ? "; day above 3× median" : ""}` : "not run"}`,
    "",
    "| Session | Severity | Modes | Evidence |",
    "|---|---|---|---|",
    ...[...input.reports].sort((a, b) => (SEVERITY_ORDER[a.severity ?? ""] ?? 3) - (SEVERITY_ORDER[b.severity ?? ""] ?? 3))
      .map((report) => `| ${report.wiseSessionId} | ${report.severity ?? (report.auditVerdict ?? "not audited")} | ${report.modes.join(", ") || "—"} | ${report.grade} |`),
    "",
  ].join("\n");
}
