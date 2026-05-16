import fs from "node:fs";
import path from "node:path";
import { WiseClient } from "@/lib/wise/client";
import {
  checkTeacherAvailabilityForSessions,
  fetchAllFutureSessions,
  fetchInstituteLocations,
  updateSessionLocation,
  type WiseSessionAvailabilityInput,
} from "@/lib/wise/fetchers";
import {
  assertPlainTvCleanupApplyAllowed,
  buildPlainTvCleanupPlan,
  formatBangkokDate,
  invalidPlainTvSessionCount,
  isKnownNonLocationPreflightConflict,
  normalizeWiseSessionForPlainTvCleanup,
  type PlainTvCleanupPlan,
  type PlainTvCleanupPreflight,
  type PlainTvCleanupProposal,
  type PlainTvCleanupSession,
} from "@/lib/classrooms/plain-tv-cleanup";
import {
  LEGACY_PLAIN_TV_ROOM_NAMES,
  WISE_TV_ROOM_NAMES,
} from "@/lib/classrooms/rooms";
import type { WiseSession } from "@/lib/wise/types";

type Action = "dry-run" | "apply-sessions" | "verify" | "probe-location-delete";

interface CliOptions {
  action: Action | null;
  scope: "future";
  confirm?: string;
  sessionIds: string[];
  json: boolean;
  help: boolean;
}

interface ProbeResult {
  method: "HEAD" | "OPTIONS";
  path: string;
  status: number | "network-error";
  allow: string | null;
  hasDeleteSignal: boolean;
  error?: string;
}

const APPLY_BATCH_SIZE = 10;

function loadEnvFile(filePath: string): void {
  if (!fs.existsSync(filePath)) return;
  for (const line of fs.readFileSync(filePath, "utf8").split(/\r?\n/)) {
    const match = line.match(/^\s*([A-Za-z_][A-Za-z0-9_]*)=(.*)\s*$/);
    if (!match || process.env[match[1]]) continue;
    process.env[match[1]] = match[2].replace(/^['"]|['"]$/g, "");
  }
}

function loadLocalEnv(): void {
  const cwd = process.cwd();
  loadEnvFile(path.join(cwd, ".env.local"));
  loadEnvFile(path.join(cwd, ".env"));
}

function usage(): string {
  return [
    "Wise plain TV-room cleanup",
    "",
    "Dry run:",
    "  npm run wise:plain-tv-cleanup -- --dry-run --scope future",
    "",
    "Apply approved session moves:",
    "  ENABLE_WISE_EMERGENCY_REPAIR=true npm run wise:plain-tv-cleanup -- --apply-sessions --confirm all:<change-count> --session-ids id1,id2",
    "",
    "Verify:",
    "  npm run wise:plain-tv-cleanup -- --verify",
    "",
    "Probe catalog delete/deactivate support:",
    "  npm run wise:plain-tv-cleanup -- --probe-location-delete",
    "",
    "Options:",
    "  --scope future           Inspect FUTURE Wise sessions only",
    "  --confirm TOKEN          Required in apply mode; token is all:<change-count>",
    "  --session-ids IDS        Required in apply mode; comma-separated exact proposed session IDs",
    "  --json                   Print machine-readable output",
    "  --help                   Show this help",
  ].join("\n");
}

function parseArgs(argv: string[]): CliOptions {
  const options: CliOptions = {
    action: null,
    scope: "future",
    sessionIds: [],
    json: false,
    help: false,
  };

  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === "--dry-run") {
      options.action = setAction(options.action, "dry-run");
    } else if (arg === "--apply-sessions") {
      options.action = setAction(options.action, "apply-sessions");
    } else if (arg === "--verify") {
      options.action = setAction(options.action, "verify");
    } else if (arg === "--probe-location-delete") {
      options.action = setAction(options.action, "probe-location-delete");
    } else if (arg === "--scope") {
      const scope = argv[++i];
      if (scope !== "future") throw new Error(`Invalid --scope "${scope}". Only "future" is supported.`);
      options.scope = scope;
    } else if (arg === "--confirm") {
      options.confirm = argv[++i];
    } else if (arg === "--session-ids") {
      options.sessionIds = (argv[++i] ?? "")
        .split(",")
        .map((value) => value.trim())
        .filter(Boolean);
    } else if (arg === "--json") {
      options.json = true;
    } else if (arg === "--help" || arg === "-h") {
      options.help = true;
    } else {
      throw new Error(`Unknown argument: ${arg}\n\n${usage()}`);
    }
  }

  return options;
}

function setAction(existing: Action | null, next: Action): Action {
  if (existing && existing !== next) {
    throw new Error(`Choose exactly one action. Got both --${existing} and --${next}.`);
  }
  return next;
}

function requireEnv(name: string): string {
  const value = process.env[name]?.trim();
  if (!value) throw new Error(`${name} is required.`);
  return value;
}

function createWiseClientFromEnv(): WiseClient {
  return new WiseClient({
    userId: requireEnv("WISE_USER_ID"),
    apiKey: requireEnv("WISE_API_KEY"),
    namespace: process.env.WISE_NAMESPACE ?? "begifted-education",
  });
}

function wiseHeaders(): Record<string, string> {
  const userId = requireEnv("WISE_USER_ID");
  const apiKey = requireEnv("WISE_API_KEY");
  const namespace = process.env.WISE_NAMESPACE ?? "begifted-education";
  const credentials = Buffer.from(`${userId}:${apiKey}`).toString("base64");
  return {
    "Content-Type": "application/json",
    Authorization: `Basic ${credentials}`,
    "x-api-key": apiKey,
    "x-wise-namespace": namespace,
    "user-agent": `VendorIntegrations/${namespace}`,
  };
}

function csvValue(value: unknown): string {
  const text = String(value ?? "");
  if (!/[",\r\n]/.test(text)) return text;
  return `"${text.replace(/"/g, '""')}"`;
}

function writeCsv(filePath: string, rows: Array<Record<string, unknown>>): void {
  const headers = Object.keys(rows[0] ?? {
    session_id: "",
    class_id: "",
    student: "",
    tutor: "",
    bangkok_start: "",
    bangkok_end: "",
    wrong_location: "",
    intended_location: "",
    included_in_repair_plan: "",
  });
  const lines = [
    headers.join(","),
    ...rows.map((row) => headers.map((header) => csvValue(row[header])).join(",")),
  ];
  fs.writeFileSync(filePath, `${lines.join("\n")}\n`);
}

function writeJson(filePath: string, value: unknown): void {
  fs.writeFileSync(filePath, `${JSON.stringify(value, null, 2)}\n`);
}

function locationSummary(plan: PlainTvCleanupPlan): string {
  return [
    `${plan.invalidPlainTvSessions.length} invalid future blocking session occurrence(s)`,
    `${new Set(plan.invalidPlainTvSessions.map((session) => session.wiseClassId).filter(Boolean)).size} distinct Wise class(es)`,
    `${plan.proposals.length} proposed session update(s)`,
    `${plan.manualRequired.length} manual-required item(s)`,
  ].join("; ");
}

function invalidSessionRows(plan: PlainTvCleanupPlan): Array<Record<string, unknown>> {
  return plan.invalidPlainTvSessions.map((session) => ({
    session_id: session.wiseSessionId,
    class_id: session.wiseClassId ?? "",
    student: session.studentName ?? "",
    tutor: session.tutorName,
    bangkok_start: session.startBangkok,
    wrong_location: session.wrongLocation,
    intended_location: session.intendedLocation,
    included_in_repair_plan: session.includedInRepairPlan ? "yes" : "no",
  }));
}

function checklistMarkdown(plan: PlainTvCleanupPlan, probeResults: ProbeResult[] = []): string {
  const today = formatBangkokDate(new Date());
  const invalidLocationLines = LEGACY_PLAIN_TV_ROOM_NAMES
    .map((name) => `- [ ] Remove or deactivate invalid plain Wise location: \`${name}\``)
    .join("\n");
  const probeLines = probeResults.length === 0
    ? "- Probe not run in this command."
    : probeResults.map((result) => (
      `- ${result.method} ${result.path}: ${result.status}${result.allow ? `, Allow=${result.allow}` : ""}`
    )).join("\n");

  return [
    `# Wise Location Catalog Cleanup Checklist - ${today}`,
    "",
    "Generated after the guarded plain TV-room cleanup dry-run/probe.",
    "",
    "## Preconditions",
    "- [ ] `npm run wise:plain-tv-cleanup -- --verify` reports 0 future blocking sessions in invalid plain TV rooms.",
    "- [ ] Exact Wise `(TV)` locations still exist.",
    "- [ ] No class/session deletion is being attempted.",
    "",
    "## Invalid Plain TV Locations",
    invalidLocationLines,
    "",
    "## Non-mutating API Probe",
    probeLines,
    "",
    "## Manual Admin Steps",
    "1. Open the Wise location/admin catalog.",
    "2. Remove or deactivate only the 11 invalid plain TV names listed above.",
    "3. Keep the exact `(TV)` locations unchanged.",
    "4. Re-run `npm run wise:plain-tv-cleanup -- --verify` and confirm the session count is still 0.",
    "",
    "## Current Session Cleanup Summary",
    `- ${locationSummary(plan)}`,
    `- Confirmation token for current session repair plan: \`${plan.confirmationToken}\``,
  ].join("\n");
}

function responseHasConflict(value: unknown): boolean {
  if (!value || typeof value !== "object") return false;
  if (Array.isArray(value)) return value.some(responseHasConflict);
  const record = value as Record<string, unknown>;
  if (record.conflict === true || record.hasConflict === true) return true;
  if (record.isConflict === true || record.isConflicting === true) return true;
  return Object.values(record).some(responseHasConflict);
}

function collectConflictReasons(value: unknown, reasons = new Set<string>()): string[] {
  if (!value || typeof value !== "object") return [...reasons];
  if (Array.isArray(value)) {
    for (const item of value) collectConflictReasons(item, reasons);
    return [...reasons];
  }
  const record = value as Record<string, unknown>;
  if (record.conflict === true && typeof record.reason === "string") {
    reasons.add(record.reason);
  }
  for (const item of Object.values(record)) collectConflictReasons(item, reasons);
  return [...reasons].sort();
}

function makePreflight(
  client: WiseClient,
  instituteId: string,
  sessions: WiseSession[],
): PlainTvCleanupPreflight {
  const normalizedById = new Map<string, PlainTvCleanupSession>();
  for (const session of sessions) {
    const normalized = normalizeWiseSessionForPlainTvCleanup(session);
    if (normalized) normalizedById.set(normalized.wiseSessionId, normalized);
  }

  return async (session, toLocation, skipSessionIds) => {
    if (!session.wiseTeacherUserId) {
      return { conflict: false, error: "Missing Wise teacher user id for preflight" };
    }

    const body: WiseSessionAvailabilityInput = {
      teacherId: session.wiseTeacherUserId,
      sessions: [{
        teacherId: session.wiseTeacherUserId,
        classId: session.wiseClassId,
        sessionId: session.wiseSessionId,
        scheduledStartTime: session.startTime.toISOString(),
        scheduledEndTime: session.endTime.toISOString(),
        type: session.sessionType,
      }],
      locationToCheck: toLocation,
    };
    const skipSessionId = skipSessionIds[0] ?? session.wiseSessionId;
    const skipped = normalizedById.get(skipSessionId);
    body.sessionsToSkip = {
      sessionId: skipSessionId,
      skipUpcoming: false,
      classId: skipped?.wiseClassId,
      startTime: skipped?.startTime.toISOString(),
    };

    const response = await checkTeacherAvailabilityForSessions(client, instituteId, body);
    return {
      conflict: responseHasConflict(response),
      conflictReasons: collectConflictReasons(response),
      response,
    };
  };
}

async function buildLivePlan(client: WiseClient, instituteId: string): Promise<{
  locations: string[];
  sessions: WiseSession[];
  plan: PlainTvCleanupPlan;
}> {
  const [locations, sessions] = await Promise.all([
    fetchInstituteLocations(client, instituteId),
    fetchAllFutureSessions(client, instituteId),
  ]);
  const plan = await buildPlainTvCleanupPlan({
    wiseLocations: locations,
    wiseSessions: sessions,
    preflight: makePreflight(client, instituteId, sessions),
  });
  return { locations, sessions, plan };
}

function ensureCatalog(plan: PlainTvCleanupPlan): void {
  if (plan.exactTvLocationsMissing.length > 0) {
    throw new Error(`Wise exact TV locations are missing: ${plan.exactTvLocationsMissing.join(", ")}`);
  }
}

function writeArtifacts(plan: PlainTvCleanupPlan, probeResults: ProbeResult[] = []): {
  csvPath: string;
  jsonPath: string;
  checklistPath: string;
} {
  const today = formatBangkokDate(new Date());
  const csvPath = path.resolve(`wise-live-invalid-tv-room-classes-${today}.csv`);
  const jsonPath = path.resolve(`wise-plain-tv-repair-plan-${today}.json`);
  const checklistPath = path.resolve(`wise-location-catalog-cleanup-checklist-${today}.md`);

  writeCsv(csvPath, invalidSessionRows(plan));
  writeJson(jsonPath, plan);
  fs.writeFileSync(checklistPath, `${checklistMarkdown(plan, probeResults)}\n`);

  return { csvPath, jsonPath, checklistPath };
}

function printPlan(plan: PlainTvCleanupPlan, artifactPaths?: ReturnType<typeof writeArtifacts>): void {
  console.log("Wise plain TV-room cleanup dry run");
  console.log(locationSummary(plan));
  console.log(`Fetched FUTURE sessions: ${plan.fetchedFutureSessionCount}`);
  console.log(`Wise locations: ${plan.wiseLocationCount}`);
  console.log(`Exact TV locations missing: ${plan.exactTvLocationsMissing.length ? plan.exactTvLocationsMissing.join(", ") : "none"}`);
  console.log(`Invalid plain TV locations present: ${plan.invalidPlainTvLocationsPresent.length ? plan.invalidPlainTvLocationsPresent.join(", ") : "none"}`);

  if (plan.manualRequired.length > 0) {
    console.log("");
    console.log(`Manual required: ${plan.manualRequired.length}`);
    for (const item of plan.manualRequired.slice(0, 20)) {
      console.log(`- ${item.startBangkok} | ${item.fromLocation} -> ${item.intendedLocation ?? "unknown"} | ${item.reason} | session ${item.wiseSessionId}`);
    }
    if (plan.manualRequired.length > 20) {
      console.log(`- ... ${plan.manualRequired.length - 20} more in JSON report`);
    }
  }

  if (plan.proposals.length > 0) {
    console.log("");
    console.log(`Apply confirmation token: ${plan.confirmationToken}`);
    console.log(`Required session IDs: ${plan.requiredSessionIds.join(",")}`);
    console.log("Apply command:");
    console.log(`  ENABLE_WISE_EMERGENCY_REPAIR=true npm run wise:plain-tv-cleanup -- --apply-sessions --confirm ${plan.confirmationToken} --session-ids ${plan.requiredSessionIds.join(",")}`);
  }

  if (artifactPaths) {
    console.log("");
    console.log("Wrote:");
    console.log(`- ${artifactPaths.csvPath}`);
    console.log(`- ${artifactPaths.jsonPath}`);
    console.log(`- ${artifactPaths.checklistPath}`);
  }
}

function proposalBySessionId(plan: PlainTvCleanupPlan): Map<string, PlainTvCleanupProposal> {
  return new Map(plan.proposals.map((proposal) => [proposal.wiseSessionId, proposal]));
}

function sessionAtLocation(sessions: WiseSession[], proposal: PlainTvCleanupProposal): boolean {
  const session = sessions.find((candidate) => candidate._id === proposal.wiseSessionId);
  return session?.location?.trim() === proposal.toLocation;
}

async function refetchAndValidateBatch(
  client: WiseClient,
  instituteId: string,
  appliedBatch: PlainTvCleanupProposal[],
  maxInvalidCount: number,
): Promise<WiseSession[]> {
  const sessions = await fetchAllFutureSessions(client, instituteId);
  for (const proposal of appliedBatch) {
    if (!sessionAtLocation(sessions, proposal)) {
      throw new Error(`Post-batch validation failed: session ${proposal.wiseSessionId} is not at ${proposal.toLocation}.`);
    }
  }
  const invalidCount = invalidPlainTvSessionCount(sessions);
  if (invalidCount > maxInvalidCount) {
    throw new Error(`Post-batch validation failed: invalid plain TV session count increased to ${invalidCount}.`);
  }
  return sessions;
}

async function applySessions(client: WiseClient, instituteId: string, options: CliOptions): Promise<void> {
  const live = await buildLivePlan(client, instituteId);
  let sessions = live.sessions;
  const plan = live.plan;
  ensureCatalog(plan);
  if (plan.manualRequired.length > 0) {
    throw new Error("Wise plain TV cleanup apply refused: manual-required conflicts are present in the dry-run plan.");
  }

  assertPlainTvCleanupApplyAllowed({
    proposals: plan.proposals,
    confirm: options.confirm,
    sessionIds: options.sessionIds,
  });

  const approvedProposals = plan.proposals;
  const expectedProposalIds = proposalBySessionId(plan);
  let maxInvalidCount = invalidPlainTvSessionCount(sessions);
  for (let index = 0; index < approvedProposals.length; index += APPLY_BATCH_SIZE) {
    const batch = approvedProposals.slice(index, index + APPLY_BATCH_SIZE);
    const currentPreflight = makePreflight(client, instituteId, sessions);

    for (const proposal of batch) {
      const originalSession = sessions.find((session) => session._id === proposal.wiseSessionId);
      const currentSession = originalSession ? normalizeWiseSessionForPlainTvCleanup(originalSession) : null;
      if (!currentSession) {
        throw new Error(`Apply refused: session ${proposal.wiseSessionId} was not found in current live FUTURE sessions.`);
      }
      const preflight = await currentPreflight(currentSession, proposal.toLocation, [proposal.wiseSessionId]);
      if (preflight.error || (preflight.conflict && !isKnownNonLocationPreflightConflict(preflight))) {
        throw new Error(`Apply refused: live preflight failed for ${proposal.wiseSessionId}: ${preflight.error ?? "conflict"}`);
      }
      if (isKnownNonLocationPreflightConflict(preflight)) {
        console.warn(`Continuing ${proposal.wiseSessionId}: Wise preflight reported only non-location reason(s) ${preflight.conflictReasons?.join(", ")}.`);
      }
      if (!expectedProposalIds.has(proposal.wiseSessionId)) {
        throw new Error(`Apply refused: session ${proposal.wiseSessionId} is not in the approved proposal set.`);
      }

      console.log(`Applying ${proposal.wiseSessionId}: ${proposal.fromLocation} -> ${proposal.toLocation}`);
      await updateSessionLocation(client, proposal.wiseClassId, proposal.wiseSessionId, proposal.toLocation);
    }

    sessions = await refetchAndValidateBatch(client, instituteId, batch, maxInvalidCount);
    maxInvalidCount = invalidPlainTvSessionCount(sessions);
  }

  const finalSessions = await fetchAllFutureSessions(client, instituteId);
  const finalCount = invalidPlainTvSessionCount(finalSessions);
  if (finalCount !== 0) {
    throw new Error(`Final verification failed: ${finalCount} future blocking session(s) still occupy invalid plain TV rooms.`);
  }
  console.log("Final verification passed: 0 future blocking sessions occupy invalid plain TV rooms.");
}

async function verify(client: WiseClient, instituteId: string): Promise<void> {
  const sessions = await fetchAllFutureSessions(client, instituteId);
  const count = invalidPlainTvSessionCount(sessions);
  if (count !== 0) {
    throw new Error(`Verification failed: ${count} future blocking session(s) still occupy invalid plain TV rooms.`);
  }
  console.log("Verification passed: 0 future blocking sessions occupy invalid plain TV rooms.");
}

async function probe(client: WiseClient, instituteId: string): Promise<{
  plan: PlainTvCleanupPlan;
  probeResults: ProbeResult[];
  artifactPaths: ReturnType<typeof writeArtifacts>;
}> {
  const { plan } = await buildLivePlan(client, instituteId);
  const baseUrl = process.env.WISE_BASE_URL ?? "https://api.wiseapp.live";
  const encodedNames = LEGACY_PLAIN_TV_ROOM_NAMES.map((name) => encodeURIComponent(name));
  const candidatePaths = [
    `/institutes/${instituteId}/locations`,
    ...encodedNames.flatMap((name) => [
      `/institutes/${instituteId}/locations/${name}`,
      `/institutes/${instituteId}/location/${name}`,
      `/institutes/${instituteId}/rooms/${name}`,
    ]),
  ];
  const headers = wiseHeaders();
  const probeResults: ProbeResult[] = [];

  for (const candidatePath of candidatePaths) {
    for (const method of ["OPTIONS", "HEAD"] as const) {
      try {
        const response = await fetch(`${baseUrl}${candidatePath}`, { method, headers });
        const allow = response.headers.get("allow");
        probeResults.push({
          method,
          path: candidatePath,
          status: response.status,
          allow,
          hasDeleteSignal: /\b(DELETE|PATCH|PUT)\b/i.test(allow ?? ""),
        });
      } catch (error) {
        probeResults.push({
          method,
          path: candidatePath,
          status: "network-error",
          allow: null,
          hasDeleteSignal: false,
          error: error instanceof Error ? error.message : String(error),
        });
      }
    }
  }

  const artifactPaths = writeArtifacts(plan, probeResults);
  return { plan, probeResults, artifactPaths };
}

async function main(): Promise<void> {
  loadLocalEnv();
  const options = parseArgs(process.argv.slice(2));
  if (options.help) {
    console.log(usage());
    return;
  }
  if (!options.action) {
    throw new Error(`Choose one action.\n\n${usage()}`);
  }

  const instituteId = process.env.WISE_INSTITUTE_ID ?? "696e1f4d90102225641cc413";
  const client = createWiseClientFromEnv();

  if (options.action === "dry-run") {
    const { plan } = await buildLivePlan(client, instituteId);
    ensureCatalog(plan);
    const artifactPaths = writeArtifacts(plan);
    if (options.json) {
      console.log(JSON.stringify({ plan, artifactPaths }, null, 2));
    } else {
      printPlan(plan, artifactPaths);
    }
    return;
  }

  if (options.action === "apply-sessions") {
    await applySessions(client, instituteId, options);
    return;
  }

  if (options.action === "verify") {
    await verify(client, instituteId);
    return;
  }

  if (options.action === "probe-location-delete") {
    const result = await probe(client, instituteId);
    if (options.json) {
      console.log(JSON.stringify(result, null, 2));
    } else {
      const deleteSignals = result.probeResults.filter((item) => item.hasDeleteSignal);
      console.log("Wise location delete/deactivate probe complete.");
      console.log(`Exact TV locations expected: ${WISE_TV_ROOM_NAMES.join(", ")}`);
      console.log(`Invalid plain TV locations checked: ${LEGACY_PLAIN_TV_ROOM_NAMES.join(", ")}`);
      console.log(`DELETE/PATCH/PUT signal in Allow headers: ${deleteSignals.length ? "yes" : "no"}`);
      console.log(`Wrote checklist: ${result.artifactPaths.checklistPath}`);
    }
  }
}

main().catch((error: unknown) => {
  const message = error instanceof Error ? error.message : String(error);
  console.error(message);
  process.exitCode = 1;
});
