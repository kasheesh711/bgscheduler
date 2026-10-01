import { chmodSync, writeFileSync } from "node:fs";
import path from "node:path";
import { loadEnvConfig } from "@next/env";
import { probeWorkforceSources } from "@/lib/tutor-offboarding/workforce/wise-source";
import type { ProbeOptions } from "@/lib/tutor-offboarding/workforce/types";

loadEnvConfig(process.cwd());

function arg(name: string): string | undefined {
  const inline = process.argv.find((item) => item.startsWith(`--${name}=`));
  if (inline) return inline.slice(name.length + 3);
  const index = process.argv.indexOf(`--${name}`);
  const next = index >= 0 ? process.argv[index + 1] : undefined;
  return next && !next.startsWith("--") ? next : undefined;
}
function repeated(name: string): string[] {
  const values: string[] = [];
  for (let index = 0; index < process.argv.length; index += 1) {
    if (process.argv[index] === `--${name}` && process.argv[index + 1] && !process.argv[index + 1].startsWith("--")) values.push(process.argv[index + 1]);
    else if (process.argv[index].startsWith(`--${name}=`)) values.push(process.argv[index].slice(name.length + 3));
  }
  return values;
}
function required(name: string): string {
  const value = arg(name);
  if (!value) throw new Error(`--${name} is required`);
  return value;
}
function positiveInt(name: string): number {
  const value = Number(required(name));
  if (!Number.isInteger(value) || value < 1) throw new Error(`--${name} must be a positive integer`);
  return value;
}
function creditExample(value: string): ProbeOptions["creditExamples"][number] {
  const [label, classId, studentId, sessionId] = value.split(":");
  if (!label || !classId || !studentId) throw new Error("--credit-example format is label:classId:studentId[:sessionId]");
  return { label, classId, studentId, ...(sessionId ? { sessionId } : {}) };
}

async function main(): Promise<void> {
  const options: ProbeOptions = {
    from: required("from"), to: required("to"),
    maxRequests: positiveInt("max-requests"), maxPages: positiveInt("max-pages"),
    maxDates: positiveInt("max-dates"), maxCreditExamples: positiveInt("max-credit-examples"),
    creditExamples: repeated("credit-example").map(creditExample),
    availabilityTeacherUserIds: repeated("availability-teacher"),
    ...(arg("out") ? { outputPath: path.resolve(arg("out")!) } : {}),
  };
  if (options.creditExamples.length > options.maxCreditExamples) throw new Error("credit-example count exceeds --max-credit-examples");
  const report = await probeWorkforceSources(options);
  const detailed = report as typeof report & {
    availabilityDiagnostics?: unknown;
    sampleLabels?: Array<{ classId: string | null; title: string | null; sessionId: string }>;
    creditExamples?: unknown;
  };
  const privateDiagnostics = {
    ...report,
    availabilityDiagnostics: detailed.availabilityDiagnostics ?? [],
    classLabels: detailed.sampleLabels ?? [],
    creditExamples: detailed.creditExamples ?? [],
  };
  if (options.outputPath) {
    writeFileSync(options.outputPath, JSON.stringify(privateDiagnostics, null, 2), { encoding: "utf8", mode: 0o600 });
    chmodSync(options.outputPath, 0o600);
  }
  const summary = {
    requestedWindow: report.requestedWindow,
    requests: report.requests,
    pages: report.pages,
    sessions: report.evidence.sessions.length,
    creditExamples: report.evidence.studentCredits.length,
    completeSessionDates: report.evidence.sourceCoverage.map((coverage) => coverage.completeness),
    contractIssues: report.contractIssues,
    conclusions: report.conclusions,
    privateOutputWritten: Boolean(options.outputPath),
  };
  process.stdout.write(`${JSON.stringify(summary, null, 2)}\n`);
}

main().catch((error: unknown) => {
  const name = error instanceof Error ? error.name : "Error";
  const message = error instanceof Error ? error.message.split("(")[0].trim() : "Probe failed";
  process.stderr.write(`${name}: ${message}\n`);
  process.exitCode = 1;
});
