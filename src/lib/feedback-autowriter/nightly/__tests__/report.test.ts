import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import type { AuditResult } from "../audit-schema";
import { appendJsonl } from "../paths";
import {
  auditCounts,
  classReportLine,
  groupByMode,
  judgePassedOf,
  loadWatchdog,
  mergeClassReport,
  modeHistory,
  renderReportMarkdown,
  renderSummaryMarkdown,
  watchdogOutliers,
  type ReportInput,
} from "../report";
import type { BundleFile } from "../steps";
import type { AuditRecord, PrecheckFinding } from "../types";
import { fakeDb } from "./fake-db";
import { PIM_FIELDS, SID, nightlyBundle, nightlyTarget } from "./nightly-fixtures";

const QUOTE = "She hesitated on the second word problem";

function precheck(patch: Partial<PrecheckFinding>): PrecheckFinding {
  return { code: "x", severity: "info", candidate: false, detail: "", mode: null, ...patch };
}

function file(prechecks: PrecheckFinding[] = [], patch: Partial<BundleFile> = {}): BundleFile {
  return {
    target: nightlyTarget({ fieldsSha256: "abcdef0123456789" }),
    bundle: nightlyBundle(),
    prechecks,
    notes: [],
    status: { collectedAt: "", rowMeta: "read", iseb: "not_guided", detail: "fetched", soniox: "fetched", zoom: "none", retranscribe: "not_needed" },
    collectedAt: "",
    ...patch,
  };
}

function audit(patch: Partial<AuditResult> = {}): AuditRecord {
  const result: AuditResult = {
    verdict: "accurate", claims: [], issues: [], omissions: [],
    homework: { feedbackStatesHomework: false, tutorSetHomework: "no", evidence: [] },
    names: { studentCalled: ["Pim"], otherPeopleNamed: [] }, candidateReview: [],
    evidenceQuality: { transcript: "full", speakerLabels: "verified", summaryVsTranscript: "agrees", notes: [] },
    priorIssueReview: null, summaryLine: "fine", ...patch,
  };
  return {
    wiseSessionId: SID, fieldsSha256: "abcdef0123456789", auditVersion: 1, promptVersion: 1, bundleHash: "bundle-hash-0001", grade: "rebuilt",
    result, failure: null, proof: { argv: [], cliVersion: null, models: ["claude-opus-5-5"], opusOutputTokens: 1, inputTokens: 1, outputTokens: 1, costUsd: 0.4, durationMs: 1, effort: "max" },
    at: "2026-10-02T20:00:00.000Z",
  };
}

const issue = (patch: Partial<AuditResult["issues"][number]> = {}): AuditResult["issues"][number] => ({
  id: "i1", claimIds: [], field: "performance", quote: QUOTE, mode: "M06", severity: "major", criticalCategory: null, rootStage: "writer",
  defense: "judge_list", mechanism: "Judgement not in the evidence.", evidence: [{ source: "transcript", locator: "12:30", speaker: "STUDENT", quote: "Twelve.", gloss: null }],
  minimalFix: { action: "delete_span", from: QUOTE, to: null }, confidence: "medium", ...patch,
});

describe("mergeClassReport", () => {
  it("never downgrades a deterministic critical floor, even when the audit says accurate", () => {
    const report = mergeClassReport(file([precheck({ code: "billing_drift", severity: "critical", mode: "M13" })]), audit());
    expect(report).toMatchObject({ severity: "critical", modes: ["M13"], criticalHighConfidence: true, criticalCategory: "billing_status", auditVerdict: "accurate" });
  });

  it("counts a candidate only when the audit confirms it", () => {
    const candidate = precheck({ code: "other_student_named", severity: "critical", mode: "M02", candidate: true, detail: "Nok in performance" });
    const confirmed = mergeClassReport(file([candidate]), audit({ candidateReview: [{ code: "other_student_named", confirmed: true, reason: "a person" }] }));
    expect(confirmed).toMatchObject({ severity: "critical", modes: ["M02"], criticalHighConfidence: false });
    const rejected = mergeClassReport(file([candidate]), audit({ candidateReview: [{ code: "other_student_named", confirmed: false, reason: "a word" }] }));
    expect(rejected.severity).toBeNull();
    expect(rejected.findings[0]).toMatchObject({ severity: "info", confirmed: false });
    const unaudited = mergeClassReport(file([candidate]), null);
    expect(unaudited).toMatchObject({ severity: null, auditFailure: "not_audited" });
    expect(unaudited.findings[0].detail).toMatch(/not confirmed/u);
  });

  it("matches each candidate's review on its unique id; a bare code only when unambiguous", () => {
    const ploy = precheck({ code: "other_person_named", id: "other_person_named#1", severity: "major", mode: "M11", candidate: true, detail: "Ploy" });
    const fern = precheck({ code: "other_person_named", id: "other_person_named#2", severity: "major", mode: "M11", candidate: true, detail: "Fern" });
    const byId = mergeClassReport(file([ploy, fern]), audit({ candidateReview: [
      { code: "other_person_named#1", confirmed: false, reason: "a character in the book" },
      { code: "other_person_named#2", confirmed: true, reason: "another student" },
    ] }));
    expect(byId.findings.map((finding) => [finding.code, finding.severity, finding.confirmed])).toEqual([
      ["other_person_named", "info", false], ["other_person_named", "major", true],
    ]);
    // A bare code shared by two candidates: confirmed → both (a person looks); rejected → neither confirmed.
    const ambiguous = mergeClassReport(file([ploy, fern]), audit({ candidateReview: [{ code: "other_person_named", confirmed: true, reason: "x" }] }));
    expect(ambiguous.findings.map((finding) => finding.severity)).toEqual(["major", "major"]);
    const rejected = mergeClassReport(file([ploy, fern]), audit({ candidateReview: [{ code: "other_person_named", confirmed: false, reason: "x" }] }));
    expect(rejected.findings.map((finding) => finding.confirmed)).toEqual([null, null]);
    // A bundle collected before ids: matched on the code when it is unambiguous.
    const legacy = mergeClassReport(file([{ ...ploy, id: undefined }]), audit({ candidateReview: [{ code: "other_person_named", confirmed: true, reason: "x" }] }));
    expect(legacy.findings[0]).toMatchObject({ severity: "major", confirmed: true });
  });

  it("merges audit issues and omissions; high-confidence criticals mark the class for an incident", () => {
    const report = mergeClassReport(file(), audit({
      verdict: "critical",
      issues: [issue(), issue({ id: "i2", mode: "M01", severity: "critical", criticalCategory: "wrong_person", confidence: "high" })],
      omissions: [{ what: "homework_set_not_reported", detail: "Two pages set for Monday", evidence: [], severity: "major" }],
    }));
    expect(report).toMatchObject({
      severity: "critical", modes: ["M01", "M06", "M09"], criticalHighConfidence: true, criticalCategory: "wrong_person", costUsd: 0.4,
    });
  });

  it("reads the production judges' stored verdict", () => {
    const pass = { faithful: true, unsupported: [], misattributed: [], homeworkNotSet: [] };
    expect(judgePassedOf({ ...pass, levels: { medium: pass, high: pass } })).toBe(true);
    expect(judgePassedOf({ ...pass, faithful: false, unsupported: ["x"], levels: { medium: pass, high: { ...pass, faithful: false, unsupported: ["x"] } } })).toBe(false);
    expect(judgePassedOf(null)).toBeNull();
  });
});

describe("modes, ledger lines and history", () => {
  it("groups by mode with a 14-night history, and writes ledger lines without text or names", () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "nightly-report-"));
    try {
      const ledger = path.join(dir, "ledger.jsonl");
      const report = mergeClassReport(file(), audit({ verdict: "major", issues: [issue()] }));
      appendJsonl(ledger, classReportLine("2026-09-25", { ...report, wiseSessionId: "6a0000000000000000000b01" }, "t", 1));
      appendJsonl(ledger, classReportLine("2026-10-02", report, "t", 1));
      appendJsonl(ledger, classReportLine("2026-10-02", report, "t2", 1)); // a re-run: counted once
      appendJsonl(ledger, classReportLine("2026-09-01", { ...report, wiseSessionId: "6a0000000000000000000b02" }, "t", 1)); // too old
      const history = modeHistory(ledger, "2026-10-02");
      expect(history.get("M06")).toBe(2);
      const groups = groupByMode([report], history);
      expect(groups).toEqual([expect.objectContaining({ mode: "M06", classes: 1, major: 1, count14d: 2, sessions: [SID] })]);
      const line = JSON.stringify(classReportLine("2026-10-02", report, "t", 1));
      expect(line).not.toMatch(/hesitated|Pim|Kevin|Testwong/u);
      expect(JSON.parse(line)).toMatchObject({ type: "class_report", severity: "major", modes: ["M06"], key: `audit:${SID}:abcdef0123456789:a1` });
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe("watchdog", () => {
  it("flags classes over the spend and retry limits", () => {
    expect(watchdogOutliers([
      { wiseSessionId: "a", calls: 3, writerCalls: 1, judgeCalls: 2, transcriberCalls: 1, timeouts: 0, unpriced: 0, costUsd: 0.1 },
      { wiseSessionId: "b", calls: 40, writerCalls: 5, judgeCalls: 13, transcriberCalls: 2, timeouts: 2, unpriced: 3, costUsd: 0.8 },
    ])).toEqual([{
      wiseSessionId: "b", costUsd: 0.8,
      reasons: ["cost_0.80_usd", "writer_runs_5", "judge_calls_13", "soniox_jobs_2", "timeouts_2", "unpriced_calls_3"],
    }]);
  });

  it("reads the day's calls per class and the previous days (SELECT only), and flags a day over 3× the median", async () => {
    const { db, queries } = fakeDb((query) => {
      if (query.sql.includes("group by \"feedback_autowriter_calls\".\"wise_session_id\"")) {
        return [["6a0000000000000000000a01", 10, 2, 4, 1, 0, 0, 2.5]];
      }
      return [["2026-09-28", 0.5], ["2026-09-29", 0.6], ["2026-09-30", 0.7]];
    });
    const result = await loadWatchdog(db, { night: "2026-10-02" });
    expect(queries.every((query) => /^\s*select\b/iu.test(query.sql))).toBe(true);
    expect(queries[0].params).toEqual(expect.arrayContaining(["2026-10-01T17:00:00.000Z", "2026-10-02T17:00:00.000Z"]));
    expect(result).toMatchObject({ dayTotalUsd: 2.5, medianPreviousUsd: 0.6, dayOutlier: true });
    expect(result.outliers[0].reasons).toEqual(["cost_2.50_usd"]);
  });
});

describe("rendering", () => {
  const input = (): ReportInput => {
    const report = mergeClassReport(file(), audit({ verdict: "major", issues: [issue()] }));
    return {
      night: "2026-10-02", generatedAt: "2026-10-02T21:00:00.000Z", code: { head: "abc", branch: "feat" }, cliVersion: "2.1.287",
      reports: [report], modes: groupByMode([report]), watchdog: null,
      costs: { claudeUsd: 0.4, claudeCalls: 1, opusProven: 1, sonioxUsd: 0, openrouterUsd: 0, wiseReads: 1 },
      synthesisLine: null, notes: [],
    };
  };

  it("puts quotes and fixes in report.md (local)", () => {
    const text = renderReportMarkdown(input());
    expect(text).toContain("Proof: Opus5.5 (effort max requested) 1/1");
    expect(text).toContain(`Posted: "${QUOTE}"`);
    expect(text).toContain("Minimal fix: delete_span");
    expect(text).toContain("Evidence (transcript 12:30 STUDENT): \"Twelve.\"");
  });

  it("counts only successful audits as audited, and says why the others were not", () => {
    const audited = mergeClassReport(file(), audit({ verdict: "major", issues: [issue()] }));
    const failed = mergeClassReport(file(), { ...audit(), result: null, failure: "invalid:schema: claims bad" });
    const incomplete = mergeClassReport(file([], { transient: ["wise_detail_failed"] }), null);
    const floorOnly = mergeClassReport(file([precheck({ code: "billing_drift", severity: "critical", mode: "M13" })]), null);
    expect(auditCounts([audited, failed, incomplete, floorOnly])).toEqual({
      posts: 4,
      audited: 1,
      verdicts: { accurate: 0, cosmetic: 0, major: 1, critical: 0, insufficient_evidence: 0 },
      notAudited: { invalid: 1, collection_incomplete: 1, not_audited: 1 },
    });
    const text = renderSummaryMarkdown({ ...input(), reports: [audited, failed, incomplete, floorOnly] });
    expect(text).toContain("- Posts 4; audited 1 (accurate 0, cosmetic 0, major 1, critical 0, insufficient_evidence 0); not audited 3 " +
      "(invalid 1, collection_incomplete 1, not_audited 1)");
  });

  it("keeps summary.md free of names and text", () => {
    const text = renderSummaryMarkdown(input());
    expect(text).toContain("Proof: Opus5.5 (effort max requested) 1/1");
    expect(text).toContain("M06×1");
    for (const forbidden of ["hesitated", "Pim", "Testwong", "Kevin", PIM_FIELDS.topics.slice(0, 30)]) expect(text).not.toContain(forbidden);
  });
});
