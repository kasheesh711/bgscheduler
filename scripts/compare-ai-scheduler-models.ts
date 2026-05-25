import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { spawn } from "node:child_process";
import path from "node:path";
import { loadEnvConfig } from "@next/env";

interface EvalPayload {
  generatedAt: string;
  model: string;
  reasoningEffort: string;
  snapshotId: string;
  profileVersion: string;
  totalScore: number;
  maxScore: number;
  criticalCount: number;
  latencyMs?: {
    p50: number;
    p95: number;
    max: number;
  };
  results: Array<{
    id: string;
    label: string;
    score: number;
    critical: boolean;
    concerns: string[];
    latencyMs?: number;
  }>;
}

interface ModelCandidate {
  label: string;
  model: string;
  reasoningEffort: "low" | "medium";
}

interface EvalRunResult {
  exitCode: number;
}

function modelCandidates(): ModelCandidate[] {
  return [
    { label: "baseline", model: process.env.OPENAI_SCHEDULER_MODEL?.trim() || "gpt-5.4-mini", reasoningEffort: "low" },
    { label: "gpt-5.5-low", model: "gpt-5.5", reasoningEffort: "low" },
    { label: "gpt-5.5-medium", model: "gpt-5.5", reasoningEffort: "medium" },
  ];
}

function runEval(candidate: ModelCandidate): Promise<EvalRunResult> {
  return new Promise((resolve, reject) => {
    const child = spawn("npx", ["tsx", "scripts/evaluate-ai-scheduler.ts"], {
      cwd: process.cwd(),
      stdio: "inherit",
      env: {
        ...process.env,
        OPENAI_SCHEDULER_MODEL: candidate.model,
        OPENAI_SCHEDULER_REASONING_EFFORT: candidate.reasoningEffort,
      },
    });
    child.on("error", reject);
    child.on("exit", (code) => {
      resolve({ exitCode: code ?? 1 });
    });
  });
}

const latestEvalPath = path.join("/tmp", "bgscheduler", "ai-scheduler-eval-latest.json");

async function readLatestEval(): Promise<EvalPayload> {
  const rawPath = latestEvalPath;
  return JSON.parse(await readFile(rawPath, "utf8")) as EvalPayload;
}

function summarize(payload: EvalPayload, candidate: ModelCandidate) {
  return {
    label: candidate.label,
    model: payload.model,
    reasoningEffort: payload.reasoningEffort,
    totalScore: payload.totalScore,
    maxScore: payload.maxScore,
    scorePct: payload.maxScore > 0 ? payload.totalScore / payload.maxScore : 0,
    criticalCount: payload.criticalCount,
    latencyMs: payload.latencyMs ?? null,
    failedCases: payload.results
      .filter((result) => result.critical || result.score < 8)
      .map((result) => ({
        id: result.id,
        label: result.label,
        score: result.score,
        critical: result.critical,
        concerns: result.concerns,
      })),
    costUsd: null,
    costNote: "The eval runner uses OpenAI store:false but does not receive token pricing metadata from the scheduler abstraction yet.",
  };
}

async function main() {
  loadEnvConfig(process.cwd());
  const rawDir = path.join("/tmp", "bgscheduler");
  await mkdir(rawDir, { recursive: true });

  const comparisons = [];
  const crashes: string[] = [];
  for (const candidate of modelCandidates()) {
    console.log(`\n=== ${candidate.label}: ${candidate.model} / ${candidate.reasoningEffort} ===`);
    const startedAt = Date.now();
    await rm(latestEvalPath, { force: true });
    let runResult: EvalRunResult;
    try {
      runResult = await runEval(candidate);
    } catch (error) {
      crashes.push(`${candidate.label}: ${error instanceof Error ? error.message : String(error)}`);
      continue;
    }

    let payload: EvalPayload;
    try {
      payload = await readLatestEval();
      if (new Date(payload.generatedAt).getTime() < startedAt) {
        throw new Error(`latest eval artifact is stale: ${payload.generatedAt}`);
      }
    } catch (error) {
      crashes.push(`${candidate.label}: eval exited ${runResult.exitCode}, but no JSON artifact was readable (${error instanceof Error ? error.message : String(error)})`);
      continue;
    }
    const copyPath = path.join(rawDir, `ai-scheduler-eval-${candidate.label}.json`);
    await writeFile(copyPath, `${JSON.stringify(payload, null, 2)}\n`);
    comparisons.push({
      ...summarize(payload, candidate),
      exitCode: runResult.exitCode,
      rawJson: copyPath,
    });
  }

  if (crashes.length > 0 || comparisons.length === 0) {
    const detail = crashes.length > 0 ? crashes.join("\n") : "No comparison artifacts were produced.";
    throw new Error(`Model comparison could not complete all candidates.\n${detail}`);
  }

  const output = {
    generatedAt: new Date().toISOString(),
    comparisons,
    promotionGate: {
      required: [
        "Higher academic/tutor-fit score than baseline",
        "Zero parent-ready critical failures",
        "Acceptable p95 latency for the admin workflow",
      ],
      recommendation: "Promote only if gpt-5.5 beats baseline on score without critical failures; otherwise keep it as a hard-turn fallback candidate.",
    },
  };

  const comparisonJson = path.join(rawDir, "ai-scheduler-model-comparison.json");
  await writeFile(comparisonJson, `${JSON.stringify(output, null, 2)}\n`);

  const report = [
    "# AI Scheduler Model Comparison",
    "",
    `Generated: ${output.generatedAt}`,
    "",
    "| Candidate | Model | Reasoning | Exit | Score | Critical | p50 | p95 | Failed cases |",
    "| --- | --- | --- | ---: | ---: | ---: | ---: | ---: | ---: |",
    ...comparisons.map((entry) => `| ${entry.label} | \`${entry.model}\` | \`${entry.reasoningEffort}\` | ${entry.exitCode} | ${entry.totalScore}/${entry.maxScore} | ${entry.criticalCount} | ${entry.latencyMs?.p50 ?? "n/a"} | ${entry.latencyMs?.p95 ?? "n/a"} | ${entry.failedCases.length} |`),
    "",
    "Promotion gate: improve the expanded eval score with zero parent-ready critical failures and acceptable latency.",
    "",
    `Raw JSON: \`${comparisonJson}\``,
    "",
  ].join("\n");
  await writeFile(path.join(process.cwd(), "docs", "ai-scheduler-model-comparison.md"), report);
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
