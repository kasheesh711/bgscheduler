import { buildSynthesisPrompt, evidenceTextOf } from "./audit-prompt";
import { SYNTHESIS_JSON_SCHEMA, parseSynthesisResult, type SynthesisResult } from "./audit-schema";
import { ledgerOutcome, type ClaudeCall, type ClaudeOutcome } from "./claude-runner";
import { EXIT, NightlyStop } from "./exit";
import type { NightlyLedger } from "./ledger";
import type { ClassReport, ModeGroup } from "./report";
import type { BundleFile } from "./steps";
import type { AuditRecord, ClaudeProof } from "./types";

/**
 * One Opus 5.5 max call per night (`perSynthesisUsd`) that reads the night's audits and the 14-night mode history
 * and writes the improvement plan (`plan.md`, local) and a sanitised fix brief (`fix-brief.json`): a mode id, the
 * mechanism in general words and a fully invented fixture — `parseSynthesisResult` refuses a brief with any real name
 * or an 8-word run copied from the evidence or the posts.
 */

export const SYNTHESIS_TIMEOUT_MS = 20 * 60 * 1000;

/** Every name the night's bundles carry (students, their name parts and guest names, tutors), for the brief check. */
export function realNamesOf(files: readonly BundleFile[]): string[] {
  const names = new Set<string>();
  const add = (value: string | null | undefined) => {
    const trimmed = value?.trim();
    if (!trimmed) return;
    names.add(trimmed);
    for (const part of trimmed.replace(/[()]/gu, " ").split(/[\s.,;/|_-]+/u)) if ([...part].length >= 3) names.add(part);
  };
  for (const file of files) {
    add(file.bundle.studentFullName);
    add(file.bundle.studentDisplayName);
    add(file.target.className);
    for (const alias of file.bundle.studentAliases) add(alias);
    for (const tutor of file.bundle.tutorNames) add(tutor);
  }
  // Words that are part of names but are not names ("Online" in a Wise display name).
  for (const word of ["Online", "Onsite", "Session", "Live"]) names.delete(word);
  return [...names];
}

export type SynthesisOutcome =
  | { ok: true; result: SynthesisResult; proof: ClaudeProof; costUsd: number | null }
  | { ok: false; reason: string; proof: ClaudeProof | null; costUsd: number | null; stop: NightlyStop | null };

export async function synthesizeNight(deps: {
  ledger: Pick<NightlyLedger, "reserve" | "settle">;
  run: (call: ClaudeCall) => Promise<ClaudeOutcome>;
  perSynthesisUsd: number;
  timeoutMs?: number;
}, input: {
  night: string;
  records: AuditRecord[];
  files: readonly BundleFile[];
  reports: readonly ClassReport[];
  modes: readonly ModeGroup[];
}): Promise<SynthesisOutcome> {
  const key = `synthesis:${input.night}`;
  const prompt = buildSynthesisPrompt({
    night: input.night,
    records: input.records,
    ledgerModes: input.modes.map((group) => ({ mode: group.mode, count14d: group.count14d, status: "open" })),
    classes: Object.fromEntries(input.reports.map((report) => [report.wiseSessionId, {
      tutorKey: report.tutorKey, postedEvidenceKind: report.postedEvidenceKind, judgePassed: report.judgePassed,
    }])),
  });
  const reserved = deps.ledger.reserve("opus_synthesis", { key, estimateUsd: deps.perSynthesisUsd });
  if (!reserved.ok) return { ok: false, reason: reserved.reason, proof: null, costUsd: null, stop: new NightlyStop(reserved.reason, EXIT.caps) };
  const outcome = await deps.run({
    purpose: "synthesis", key, system: prompt.system, user: prompt.user, schema: SYNTHESIS_JSON_SCHEMA,
    budgetUsd: deps.perSynthesisUsd, timeoutMs: deps.timeoutMs ?? SYNTHESIS_TIMEOUT_MS,
  });
  const costUsd = outcome.proof?.costUsd ?? null;
  if (outcome.kind !== "success") {
    deps.ledger.settle(reserved.id, { actualUsd: costUsd, outcome: ledgerOutcome(outcome.kind, false) });
    const stop = outcome.kind === "usage_limited" || outcome.kind === "auth" ? new NightlyStop(outcome.kind, EXIT.model) : null;
    return { ok: false, reason: `${outcome.kind}:${outcome.reason}`, proof: outcome.proof, costUsd, stop };
  }
  const parsed = parseSynthesisResult(outcome.value, {
    sessionIds: new Set(input.files.map((file) => file.target.wiseSessionId)),
    realNames: realNamesOf(input.files),
    evidenceTexts: input.files.flatMap((file) => [evidenceTextOf(file.bundle), Object.values(file.bundle.postedFields).join("\n")]),
  });
  deps.ledger.settle(reserved.id, { actualUsd: costUsd, outcome: ledgerOutcome("success", parsed.ok) });
  if (!parsed.ok) return { ok: false, reason: `invalid:${parsed.reason}`, proof: outcome.proof, costUsd, stop: null };
  return { ok: true, result: parsed.result, proof: outcome.proof, costUsd };
}

/** `plan.md` (local): the night's modes with mechanisms and fixes, tonight's pick, the long-term plan. */
export function renderPlanMarkdown(night: string, result: SynthesisResult): string {
  const lines = [
    `# Improvement plan — ${night}`,
    "",
    result.summaryLine,
    "",
    `Production judges passed ${result.judgeMisses.count} post(s) with a major or critical issue (${result.judgeMisses.modes.join(", ") || "—"}).`,
    "",
    "## Failure modes tonight",
    "",
  ];
  for (const mode of result.failureModes) {
    lines.push(
      `### ${mode.mode} — ${mode.title} (${mode.severity}, ${mode.sessions.length} class(es), confidence ${mode.confidence})`,
      "",
      `- Stage: ${mode.rootStage}; fixability: ${mode.fixability}`,
      `- Mechanism: ${mode.mechanism}`,
      `- Proposed change: ${mode.proposedChange}`,
      `- Files: ${mode.proposedFiles.join(", ") || "—"}`,
      `- Sessions: ${mode.sessions.join(", ")}`,
      "",
    );
  }
  lines.push("## Tonight's fix", "", result.fixPick ? `${result.fixPick.mode}: ${result.fixPick.reason}` : "None picked.", "");
  if (result.fixBrief) {
    lines.push(
      "Sanitised brief: see fix-brief.json.",
      "",
      ...result.fixBrief.acceptance.map((check) => `- Acceptance: ${check}`),
      "",
    );
  }
  lines.push("## Long-term improvement plan", "");
  for (const item of result.longTermPlan) {
    lines.push(`### ${item.title}`, "", item.why, "", ...item.steps.map((step, index) => `${index + 1}. ${step}`), "", `Cost impact: ${item.costImpact}`, "");
  }
  return lines.join("\n");
}

/** `fix-brief.json`: the sanitised hand-over (already checked for real names and copied runs), or null. */
export function fixBriefFile(night: string, result: SynthesisResult): Record<string, unknown> | null {
  if (!result.fixBrief) return null;
  return {
    night,
    mode: result.fixBrief.mode,
    mechanism: result.fixBrief.mechanism,
    targetFiles: result.fixBrief.targetFiles,
    syntheticFixture: result.fixBrief.syntheticFixture,
    acceptance: result.fixBrief.acceptance,
    pickReason: result.fixPick?.reason ?? null,
  };
}
