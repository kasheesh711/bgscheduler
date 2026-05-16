import fs from "node:fs";
import path from "node:path";
import { WiseClient } from "@/lib/wise/client";
import {
  fetchAllFutureSessions,
  fetchInstituteLocations,
  updateSessionLocation,
} from "@/lib/wise/fetchers";
import {
  assertEmergencyRepairApplyAllowed,
  availableRoomsForSession,
  buildEmergencyRepairPlan,
  formatBangkokDate,
  sessionsForBangkokDate,
  type EmergencyRepairPlan,
  type EmergencyRepairProposal,
  type EmergencyRepairSession,
  type RoomConflict,
} from "@/lib/classrooms/wise-room-conflict-repair";

interface CliOptions {
  date: string;
  apply: boolean;
  confirm?: string;
  sessionIds: string[];
  json: boolean;
  help: boolean;
}

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
    "Wise room conflict emergency repair",
    "",
    "Dry run:",
    "  npm run wise:room-conflict-repair -- --date 2026-05-16",
    "",
    "Apply:",
    "  ENABLE_WISE_EMERGENCY_REPAIR=true npm run wise:room-conflict-repair -- --date 2026-05-16 --apply --confirm 2026-05-16:2 --session-ids id1,id2",
    "",
    "Options:",
    "  --date YYYY-MM-DD       Bangkok date to inspect; defaults to today in Asia/Bangkok",
    "  --apply                 Apply the proposed Wise single-session location repairs",
    "  --confirm TOKEN         Required in apply mode; token is YYYY-MM-DD:<change-count>",
    "  --session-ids IDS       Required in apply mode; comma-separated exact proposed session IDs",
    "  --json                  Print the machine-readable plan",
    "  --help                  Show this help",
  ].join("\n");
}

function parseArgs(argv: string[]): CliOptions {
  const options: CliOptions = {
    date: formatBangkokDate(new Date()),
    apply: false,
    sessionIds: [],
    json: false,
    help: false,
  };

  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === "--date") {
      options.date = argv[++i] ?? "";
    } else if (arg === "--apply") {
      options.apply = true;
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

  if (!/^\d{4}-\d{2}-\d{2}$/.test(options.date)) {
    throw new Error(`Invalid --date "${options.date}". Expected YYYY-MM-DD.`);
  }

  return options;
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

function sessionName(session: EmergencyRepairSession): string {
  return [
    session.tutorName,
    session.studentName ? `/ ${session.studentName}` : null,
  ].filter(Boolean).join(" ");
}

function sessionLine(session: EmergencyRepairSession): string {
  return `${sessionName(session)} | ${session.startTimeBangkok}-${session.endTimeBangkok.slice(11)} | ${session.location} | class ${session.wiseClassId ?? "missing"} | session ${session.wiseSessionId}`;
}

function printConflict(
  conflict: RoomConflict,
  sessions: EmergencyRepairSession[],
  approvedRooms: string[],
): void {
  console.log(`- ${conflict.physicalRoom}, ${conflict.overlapStartBangkok}-${conflict.overlapEndBangkok.slice(11)}`);
  for (const session of conflict.sessions) {
    const availableRooms = availableRoomsForSession(session, sessions, approvedRooms);
    console.log(`  - ${sessionLine(session)}`);
    console.log(`    available exact Wise rooms: ${availableRooms.length > 0 ? availableRooms.join(", ") : "none"}`);
  }
}

function printProposal(index: number, proposal: EmergencyRepairProposal): void {
  console.log(`${index}. ${proposal.reason}: ${proposal.tutorName}${proposal.studentName ? ` / ${proposal.studentName}` : ""}`);
  console.log(`   ${proposal.startTimeBangkok}-${proposal.endTimeBangkok.slice(11)}`);
  console.log(`   ${proposal.fromLocation} -> ${proposal.toLocation}`);
  console.log(`   class ${proposal.wiseClassId ?? "missing"} | session ${proposal.wiseSessionId}`);
}

function printPlan(plan: EmergencyRepairPlan, sessions: EmergencyRepairSession[], fetchedCount: number): void {
  console.log(`Wise room conflict repair dry run for ${plan.date}`);
  console.log(`Fetched ${fetchedCount} live FUTURE Wise sessions; ${sessions.length} blocking located sessions on this Bangkok date.`);
  console.log(`Approved exact Wise repair rooms: ${plan.approvedRooms.join(", ") || "none"}`);
  console.log("");

  if (plan.conflicts.length === 0) {
    console.log("Physical room conflicts: none");
  } else {
    console.log(`Physical room conflicts: ${plan.conflicts.length}`);
    for (const conflict of plan.conflicts) {
      printConflict(conflict, sessions, plan.approvedRooms);
    }
  }

  console.log("");
  if (plan.invalidPlainTvLocations.length === 0) {
    console.log("Invalid plain TV-room locations: none");
  } else {
    console.log(`Invalid plain TV-room locations: ${plan.invalidPlainTvLocations.length}`);
    for (const invalid of plan.invalidPlainTvLocations) {
      console.log(`- ${invalid.tutorName}${invalid.studentName ? ` / ${invalid.studentName}` : ""} | ${invalid.startTimeBangkok} | ${invalid.wrongLocation} -> ${invalid.intendedLocation} | session ${invalid.wiseSessionId}${invalid.includedInRepairPlan ? " | proposed" : ""}`);
    }
  }

  console.log("");
  if (plan.manualRequired.length > 0) {
    console.log(`manual_required: ${plan.manualRequired.length}`);
    for (const item of plan.manualRequired) {
      console.log(`- ${item.reason}: ${item.conflict.physicalRoom} ${item.conflict.overlapStartBangkok}-${item.conflict.overlapEndBangkok.slice(11)}`);
    }
  }

  if (plan.proposals.length === 0) {
    console.log("Proposed Wise repair plan: no changes");
  } else {
    console.log(`Proposed Wise repair plan: ${plan.proposals.length} change(s)`);
    plan.proposals.forEach((proposal, index) => printProposal(index + 1, proposal));
    console.log("");
    console.log(`Apply confirmation token: ${plan.confirmationToken}`);
    console.log(`Required session IDs: ${plan.requiredSessionIds.join(",")}`);
    console.log("Apply command:");
    console.log(`  ENABLE_WISE_EMERGENCY_REPAIR=true npm run wise:room-conflict-repair -- --date ${plan.date} --apply --confirm ${plan.confirmationToken} --session-ids ${plan.requiredSessionIds.join(",")}`);
  }

  if (plan.remainingConflictsAfterPlan.length > 0) {
    console.log("");
    console.log(`Remaining conflicts after proposed plan: ${plan.remainingConflictsAfterPlan.length}`);
  }
}

async function applyPlan(
  client: WiseClient,
  instituteId: string,
  plan: EmergencyRepairPlan,
  options: CliOptions,
  wiseLocations: string[],
): Promise<void> {
  if (plan.manualRequired.length > 0) {
    throw new Error("Emergency repair apply refused: at least one conflict requires manual repair.");
  }
  if (plan.remainingConflictsAfterPlan.length > 0) {
    throw new Error("Emergency repair apply refused: proposed plan does not clear all physical room conflicts.");
  }

  assertEmergencyRepairApplyAllowed({
    date: options.date,
    proposals: plan.proposals,
    confirm: options.confirm,
    sessionIds: options.sessionIds,
  });

  for (const proposal of plan.proposals) {
    if (!proposal.wiseClassId) {
      throw new Error(`Emergency repair apply refused: session ${proposal.wiseSessionId} is missing a Wise class id.`);
    }
    console.log(`Applying ${proposal.wiseSessionId}: ${proposal.fromLocation} -> ${proposal.toLocation}`);
    await updateSessionLocation(client, proposal.wiseClassId, proposal.wiseSessionId, proposal.toLocation);
  }

  const refetched = await fetchAllFutureSessions(client, instituteId);
  const repairedSessions = sessionsForBangkokDate(refetched, options.date);
  const postPlan = buildEmergencyRepairPlan(options.date, repairedSessions, wiseLocations);
  if (postPlan.conflicts.length > 0) {
    throw new Error(`Post-repair validation failed: ${postPlan.conflicts.length} physical room conflict(s) remain.`);
  }

  console.log(`Post-repair validation passed for ${options.date}: no physical room conflicts remain.`);
}

async function main(): Promise<void> {
  loadLocalEnv();
  const options = parseArgs(process.argv.slice(2));
  if (options.help) {
    console.log(usage());
    return;
  }

  const instituteId = process.env.WISE_INSTITUTE_ID ?? "696e1f4d90102225641cc413";
  const client = createWiseClientFromEnv();
  const [wiseLocations, wiseSessions] = await Promise.all([
    fetchInstituteLocations(client, instituteId),
    fetchAllFutureSessions(client, instituteId),
  ]);
  const sessions = sessionsForBangkokDate(wiseSessions, options.date);
  const plan = buildEmergencyRepairPlan(options.date, sessions, wiseLocations);

  if (options.json) {
    console.log(JSON.stringify({
      fetchedWiseFutureSessionCount: wiseSessions.length,
      inspectedSessionCount: sessions.length,
      plan,
    }, null, 2));
  } else {
    printPlan(plan, sessions, wiseSessions.length);
  }

  if (options.apply) {
    await applyPlan(client, instituteId, plan, options, wiseLocations);
  }
}

main().catch((error: unknown) => {
  const message = error instanceof Error ? error.message : String(error);
  console.error(message);
  process.exitCode = 1;
});
