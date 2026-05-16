import { isBlockingStatus } from "@/lib/normalization/sessions";
import {
  getWiseSessionClassId,
  getWiseSessionClassName,
  getWiseSessionTeacherUserId,
  getWiseUserName,
  type WiseSession,
} from "@/lib/wise/types";
import {
  DEFAULT_CLASSROOM_ROOMS,
  TV_ROOM_WISE_NAME_BY_LEGACY_PLAIN_NAME,
  exactWiseRoomName,
  tvRoomRepairLocation,
  type ClassroomRoomDefinition,
} from "./rooms";

export const WISE_PLAIN_TV_CLEANUP_DISABLED_MESSAGE =
  "Wise plain TV cleanup is disabled. Set ENABLE_WISE_EMERGENCY_REPAIR=true only for an approved incident repair.";

const BANGKOK_FORMATTER = new Intl.DateTimeFormat("en-GB", {
  timeZone: "Asia/Bangkok",
  year: "numeric",
  month: "2-digit",
  day: "2-digit",
  hour: "2-digit",
  minute: "2-digit",
  hour12: false,
});

export type PlainTvCleanupScope = "future";

export type PlainTvCleanupProposalReason =
  | "repair_plain_tv_location"
  | "move_blocker_to_alternate_room";

export interface PlainTvCleanupSession {
  wiseSessionId: string;
  wiseClassId?: string;
  wiseTeacherUserId?: string;
  tutorName: string;
  studentName?: string;
  sessionType?: string;
  status?: string;
  startTime: Date;
  endTime: Date;
  startBangkok: string;
  endBangkok: string;
  location: string;
  studentCount: number | null;
}

export interface PlainTvCleanupPreflightResult {
  conflict: boolean;
  conflictReasons?: string[];
  error?: string;
  response?: unknown;
}

export type PlainTvCleanupPreflight = (
  session: PlainTvCleanupSession,
  toLocation: string,
  skipSessionIds: string[],
) => Promise<PlainTvCleanupPreflightResult>;

export interface PlainTvCleanupProposal {
  wiseSessionId: string;
  wiseClassId: string;
  wiseTeacherUserId?: string;
  tutorName: string;
  studentName?: string;
  startBangkok: string;
  endBangkok: string;
  fromLocation: string;
  toLocation: string;
  reason: PlainTvCleanupProposalReason;
  relatedInvalidSessionId?: string;
  dryRunConflict: boolean;
  dryRunError: string | null;
  dryRunWarning: string | null;
  skipSessionIds: string[];
}

export interface PlainTvCleanupManualRequired {
  wiseSessionId: string;
  wiseClassId?: string;
  tutorName: string;
  studentName?: string;
  startBangkok: string;
  fromLocation: string;
  intendedLocation: string | null;
  reason: string;
}

export interface PlainTvCleanupInvalidSession {
  wiseSessionId: string;
  wiseClassId?: string;
  tutorName: string;
  studentName?: string;
  startBangkok: string;
  wrongLocation: string;
  intendedLocation: string;
  includedInRepairPlan: boolean;
}

export interface PlainTvCleanupPlan {
  generatedAt: string;
  scope: PlainTvCleanupScope;
  fetchedFutureSessionCount: number;
  wiseLocationCount: number;
  exactTvLocationsMissing: string[];
  invalidPlainTvLocationsPresent: string[];
  invalidPlainTvSessions: PlainTvCleanupInvalidSession[];
  proposals: PlainTvCleanupProposal[];
  manualRequired: PlainTvCleanupManualRequired[];
  confirmationToken: string;
  requiredSessionIds: string[];
}

export interface PlainTvCleanupPlanInput {
  wiseSessions: WiseSession[];
  wiseLocations: string[];
  scope?: PlainTvCleanupScope;
  generatedAt?: Date;
  preflight?: PlainTvCleanupPreflight;
}

export interface PlainTvCleanupApplyGuardInput {
  proposals: PlainTvCleanupProposal[];
  confirm?: string;
  sessionIds?: string[];
  env?: NodeJS.ProcessEnv;
}

interface WorkingSession extends PlainTvCleanupSession {
  originalLocation: string;
}

const KNOWN_NON_LOCATION_PREFLIGHT_REASONS = new Set([
  "TEACHER_SESSION",
  "TEACHER_WORKING_HOURS",
]);

function bangkokParts(value: Date): Map<string, string> {
  return new Map(BANGKOK_FORMATTER.formatToParts(value).map((part) => [part.type, part.value]));
}

export function formatBangkokDate(value: Date): string {
  const parts = bangkokParts(value);
  return `${parts.get("year")}-${parts.get("month")}-${parts.get("day")}`;
}

function formatBangkokDateTime(value: Date): string {
  const parts = bangkokParts(value);
  const hour = String(Number(parts.get("hour") ?? "0") % 24).padStart(2, "0");
  return `${parts.get("year")}-${parts.get("month")}-${parts.get("day")} ${hour}:${parts.get("minute")}`;
}

export function isWiseSessionBlockingForPlainTvCleanup(session: WiseSession): boolean {
  if (!isBlockingStatus(session.meetingStatus)) return false;
  const marker = `${session.meetingStatus ?? ""} ${session.title ?? ""}`.toUpperCase();
  return !marker.includes("CANCELLED") && !marker.includes("CANCELED");
}

function isOfflineSession(session: PlainTvCleanupSession): boolean {
  return String(session.sessionType ?? "").toUpperCase() === "OFFLINE";
}

export function normalizeWiseSessionForPlainTvCleanup(session: WiseSession): PlainTvCleanupSession | null {
  const location = session.location?.trim();
  if (!location || !isWiseSessionBlockingForPlainTvCleanup(session)) return null;

  const startTime = new Date(session.scheduledStartTime);
  const endTime = new Date(session.scheduledEndTime);
  if (Number.isNaN(startTime.getTime()) || Number.isNaN(endTime.getTime())) return null;

  return {
    wiseSessionId: session._id,
    wiseClassId: getWiseSessionClassId(session),
    wiseTeacherUserId: getWiseSessionTeacherUserId(session),
    tutorName:
      session.teacherName ??
      getWiseUserName(session.userId) ??
      session.teacherId ??
      getWiseSessionTeacherUserId(session) ??
      "Unknown tutor",
    studentName: getWiseSessionClassName(session),
    sessionType: session.type,
    status: session.meetingStatus,
    startTime,
    endTime,
    startBangkok: formatBangkokDateTime(startTime),
    endBangkok: formatBangkokDateTime(endTime),
    location,
    studentCount: typeof session.studentCount === "number" ? session.studentCount : null,
  };
}

export function intendedPlainTvRepairLocation(location: string | null | undefined): string | null {
  return tvRoomRepairLocation(location);
}

export function assertKnownPlainTvRepairLocation(location: string): string {
  const intended = intendedPlainTvRepairLocation(location);
  if (!intended) {
    throw new Error(`Unknown plain TV room location: ${location}`);
  }
  return intended;
}

function overlaps(left: Pick<PlainTvCleanupSession, "startTime" | "endTime">, right: Pick<PlainTvCleanupSession, "startTime" | "endTime">): boolean {
  return left.startTime < right.endTime && right.startTime < left.endTime;
}

function roomKey(location: string): string {
  return exactWiseRoomName(location).trim().toLowerCase();
}

function physicalRoomKey(location: string): string {
  return exactWiseRoomName(location).replace(/\s+\(TV\)$/i, "").trim().toLowerCase();
}

function roomDefinitionByName(): Map<string, ClassroomRoomDefinition> {
  return new Map(DEFAULT_CLASSROOM_ROOMS.map((room) => [room.name, room]));
}

export function approvedPlainTvCleanupRooms(wiseLocations: Iterable<string>): ClassroomRoomDefinition[] {
  const liveLocations = new Set([...wiseLocations].map((location) => location.trim()));
  const invalidPlainNames = new Set(TV_ROOM_WISE_NAME_BY_LEGACY_PLAIN_NAME.keys());
  return DEFAULT_CLASSROOM_ROOMS
    .filter((room) => room.active && room.category !== "online_only")
    .filter((room) => liveLocations.has(room.name))
    .filter((room) => !invalidPlainNames.has(room.name))
    .sort((left, right) => left.sortOrder - right.sortOrder || left.name.localeCompare(right.name));
}

function roomIsFree(
  roomName: string,
  session: PlainTvCleanupSession,
  sessions: Iterable<WorkingSession>,
  ignoreSessionIds = new Set<string>(),
): boolean {
  const target = physicalRoomKey(roomName);
  for (const candidate of sessions) {
    if (candidate.wiseSessionId === session.wiseSessionId || ignoreSessionIds.has(candidate.wiseSessionId)) continue;
    if (physicalRoomKey(candidate.location) !== target) continue;
    if (overlaps(session, candidate)) return false;
  }
  return true;
}

function sessionRoomRequirement(session: WorkingSession, roomsByName: Map<string, ClassroomRoomDefinition>): {
  capacity: number;
  hasTv: boolean;
} {
  const currentRoom = roomsByName.get(exactWiseRoomName(session.location));
  return {
    capacity: Math.max(session.studentCount ?? 1, currentRoom?.capacity ?? 1),
    hasTv: currentRoom?.hasTv ?? /\(TV\)$/i.test(exactWiseRoomName(session.location)),
  };
}

function candidateAlternateRooms(
  session: WorkingSession,
  sessions: Iterable<WorkingSession>,
  approvedRooms: ClassroomRoomDefinition[],
  roomsByName: Map<string, ClassroomRoomDefinition>,
  blockedRoomName: string,
): ClassroomRoomDefinition[] {
  const requirement = sessionRoomRequirement(session, roomsByName);
  return approvedRooms.filter((room) => (
    physicalRoomKey(room.name) !== physicalRoomKey(blockedRoomName) &&
    room.capacity >= requirement.capacity &&
    (!requirement.hasTv || room.hasTv) &&
    roomIsFree(room.name, session, sessions)
  ));
}

function sortedInvalidSessions(sessions: WorkingSession[]): WorkingSession[] {
  return sessions
    .filter((session) => Boolean(intendedPlainTvRepairLocation(session.location)))
    .sort((left, right) => (
      left.startTime.getTime() - right.startTime.getTime() ||
      left.location.localeCompare(right.location) ||
      left.wiseSessionId.localeCompare(right.wiseSessionId)
    ));
}

function proposalFor(
  session: WorkingSession,
  toLocation: string,
  reason: PlainTvCleanupProposalReason,
  preflight: PlainTvCleanupPreflightResult,
  skipSessionIds: string[],
  relatedInvalidSessionId?: string,
): PlainTvCleanupProposal | null {
  if (!session.wiseClassId) return null;
  return {
    wiseSessionId: session.wiseSessionId,
    wiseClassId: session.wiseClassId,
    wiseTeacherUserId: session.wiseTeacherUserId,
    tutorName: session.tutorName,
    studentName: session.studentName,
    startBangkok: session.startBangkok,
    endBangkok: session.endBangkok,
    fromLocation: session.originalLocation,
    toLocation,
    reason,
    relatedInvalidSessionId,
    dryRunConflict: preflight.conflict,
    dryRunError: preflight.error ?? null,
    dryRunWarning: preflightWarning(preflight),
    skipSessionIds,
  };
}

function preflightWarning(preflight: PlainTvCleanupPreflightResult): string | null {
  if (!isKnownNonLocationPreflightConflict(preflight)) return null;
  return `Wise preflight reported only pre-existing non-location conflict reason(s): ${preflight.conflictReasons?.join(", ")}`;
}

function manualFor(session: WorkingSession, reason: string): PlainTvCleanupManualRequired {
  return {
    wiseSessionId: session.wiseSessionId,
    wiseClassId: session.wiseClassId,
    tutorName: session.tutorName,
    studentName: session.studentName,
    startBangkok: session.startBangkok,
    fromLocation: session.originalLocation,
    intendedLocation: intendedPlainTvRepairLocation(session.originalLocation),
    reason,
  };
}

async function runPreflight(
  preflight: PlainTvCleanupPreflight | undefined,
  session: WorkingSession,
  toLocation: string,
  skipSessionIds: string[],
): Promise<PlainTvCleanupPreflightResult> {
  if (!preflight) return { conflict: false };
  try {
    return await preflight(session, toLocation, skipSessionIds);
  } catch (error) {
    return {
      conflict: false,
      error: error instanceof Error ? error.message : "Wise preflight failed",
    };
  }
}

export function isKnownNonLocationPreflightConflict(preflight: PlainTvCleanupPreflightResult): boolean {
  if (!preflight.conflict || preflight.error) return false;
  const reasons = preflight.conflictReasons ?? [];
  return reasons.length > 0 && reasons.every((reason) => KNOWN_NON_LOCATION_PREFLIGHT_REASONS.has(reason));
}

function preflightAllowsLocationOnlyUpdate(preflight: PlainTvCleanupPreflightResult): boolean {
  return !preflight.error && (!preflight.conflict || isKnownNonLocationPreflightConflict(preflight));
}

export async function buildPlainTvCleanupPlan(input: PlainTvCleanupPlanInput): Promise<PlainTvCleanupPlan> {
  const scope = input.scope ?? "future";
  const generatedAt = input.generatedAt ?? new Date();
  const liveLocations = new Set(input.wiseLocations.map((location) => location.trim()));
  const exactTvLocationsMissing = [...TV_ROOM_WISE_NAME_BY_LEGACY_PLAIN_NAME.values()]
    .filter((location) => !liveLocations.has(location));
  const invalidPlainTvLocationsPresent = [...TV_ROOM_WISE_NAME_BY_LEGACY_PLAIN_NAME.keys()]
    .filter((location) => liveLocations.has(location));
  const approvedRooms = approvedPlainTvCleanupRooms(input.wiseLocations);
  const roomsByName = roomDefinitionByName();
  const normalizedSessions = input.wiseSessions
    .map(normalizeWiseSessionForPlainTvCleanup)
    .filter((session): session is PlainTvCleanupSession => Boolean(session));
  const working = new Map<string, WorkingSession>(
    normalizedSessions.map((session) => [session.wiseSessionId, { ...session, originalLocation: session.location }]),
  );
  const proposals = new Map<string, PlainTvCleanupProposal>();
  const manualRequired: PlainTvCleanupManualRequired[] = [];

  for (const invalidSession of sortedInvalidSessions([...working.values()])) {
    const current = working.get(invalidSession.wiseSessionId);
    if (!current || !intendedPlainTvRepairLocation(current.location)) continue;

    const intendedLocation = intendedPlainTvRepairLocation(current.location);
    if (!intendedLocation) continue;

    if (!current.wiseClassId || !current.wiseSessionId) {
      manualRequired.push(manualFor(current, "Missing Wise class/session id"));
      continue;
    }
    if (!isOfflineSession(current)) {
      manualRequired.push(manualFor(current, "Plain TV cleanup only updates OFFLINE sessions"));
      continue;
    }

    const directPreflight = await runPreflight(input.preflight, current, intendedLocation, [current.wiseSessionId]);
    if (preflightAllowsLocationOnlyUpdate(directPreflight)) {
      const proposal = proposalFor(
        current,
        intendedLocation,
        "repair_plain_tv_location",
        directPreflight,
        [current.wiseSessionId],
      );
      if (!proposal) {
        manualRequired.push(manualFor(current, "Missing Wise class/session id"));
        continue;
      }
      proposals.set(current.wiseSessionId, proposal);
      working.set(current.wiseSessionId, { ...current, location: intendedLocation });
      continue;
    }

    const blockers = [...working.values()]
      .filter((candidate) => (
        candidate.wiseSessionId !== current.wiseSessionId &&
        roomKey(candidate.location) === roomKey(intendedLocation) &&
        overlaps(current, candidate)
      ))
      .sort((left, right) => (
        left.startTime.getTime() - right.startTime.getTime() ||
        left.wiseSessionId.localeCompare(right.wiseSessionId)
      ));

    if (blockers.length === 0) {
      manualRequired.push(manualFor(
        current,
        directPreflight.error ?? "Wise preflight reported a conflict but no exact-room blocker was found",
      ));
      continue;
    }

    const movedBlockerIds: string[] = [];
    let blocked = false;
    for (const blocker of blockers) {
      if (!blocker.wiseClassId) {
        manualRequired.push(manualFor(blocker, `Blocker for ${current.wiseSessionId} is missing Wise class id`));
        blocked = true;
        break;
      }
      if (!isOfflineSession(blocker)) {
        manualRequired.push(manualFor(blocker, `Blocker for ${current.wiseSessionId} is not OFFLINE`));
        blocked = true;
        break;
      }

      const alternateRooms = candidateAlternateRooms(
        blocker,
        working.values(),
        approvedRooms,
        roomsByName,
        intendedLocation,
      );
      if (alternateRooms.length === 0) {
        manualRequired.push(manualFor(blocker, `No approved alternate room is free for blocker of ${current.wiseSessionId}`));
        blocked = true;
        break;
      }

      let alternateRoom: ClassroomRoomDefinition | null = null;
      let blockerPreflight: PlainTvCleanupPreflightResult | null = null;
      const rejectedRooms: string[] = [];
      for (const candidateRoom of alternateRooms) {
        const candidatePreflight = await runPreflight(input.preflight, blocker, candidateRoom.name, [blocker.wiseSessionId]);
        if (preflightAllowsLocationOnlyUpdate(candidatePreflight)) {
          alternateRoom = candidateRoom;
          blockerPreflight = candidatePreflight;
          break;
        }
        rejectedRooms.push(`${candidateRoom.name}: ${candidatePreflight.error ?? "conflict"}`);
      }

      if (!alternateRoom || !blockerPreflight) {
        manualRequired.push(manualFor(
          blocker,
          `Wise preflight rejected ${alternateRooms.length} approved alternate room(s): ${rejectedRooms.join("; ")}`,
        ));
        blocked = true;
        break;
      }

      const blockerProposal = proposalFor(
        blocker,
        alternateRoom.name,
        "move_blocker_to_alternate_room",
        blockerPreflight,
        [blocker.wiseSessionId],
        current.wiseSessionId,
      );
      if (!blockerProposal) {
        manualRequired.push(manualFor(blocker, `Blocker for ${current.wiseSessionId} is missing Wise class/session id`));
        blocked = true;
        break;
      }
      proposals.set(blocker.wiseSessionId, blockerProposal);
      working.set(blocker.wiseSessionId, { ...blocker, location: alternateRoom.name });
      movedBlockerIds.push(blocker.wiseSessionId);
    }

    if (blocked) continue;

    const repairSkipIds = [current.wiseSessionId, ...movedBlockerIds].sort();
    // Wise currently accepts only a single sessionsToSkip object in the live
    // preflight endpoint. Dependent repairs are re-preflighted during apply,
    // after the blocker moves have actually been written.
    const repairPreflight = movedBlockerIds.length > 0
      ? { conflict: false }
      : await runPreflight(input.preflight, current, intendedLocation, repairSkipIds);
    if (!preflightAllowsLocationOnlyUpdate(repairPreflight)) {
      manualRequired.push(manualFor(
        current,
        repairPreflight.error ?? "Wise preflight still reports a conflict after proposed blocker moves",
      ));
      continue;
    }

    const repairProposal = proposalFor(
      current,
      intendedLocation,
      "repair_plain_tv_location",
      repairPreflight,
      repairSkipIds,
    );
    if (!repairProposal) {
      manualRequired.push(manualFor(current, "Missing Wise class/session id"));
      continue;
    }
    proposals.set(current.wiseSessionId, repairProposal);
    working.set(current.wiseSessionId, { ...current, location: intendedLocation });
  }

  const proposalList = [...proposals.values()].sort((left, right) => {
    if (left.reason !== right.reason) {
      return left.reason === "move_blocker_to_alternate_room" ? -1 : 1;
    }
    return left.startBangkok.localeCompare(right.startBangkok) || left.wiseSessionId.localeCompare(right.wiseSessionId);
  });
  const proposalIds = new Set(proposalList.map((proposal) => proposal.wiseSessionId));
  const invalidPlainTvSessions = sortedInvalidSessions([...working.values()].map((session) => ({
    ...session,
    location: session.originalLocation,
  }))).map((session) => ({
    wiseSessionId: session.wiseSessionId,
    wiseClassId: session.wiseClassId,
    tutorName: session.tutorName,
    studentName: session.studentName,
    startBangkok: session.startBangkok,
    wrongLocation: session.originalLocation,
    intendedLocation: intendedPlainTvRepairLocation(session.originalLocation) ?? "",
    includedInRepairPlan: proposalIds.has(session.wiseSessionId),
  }));

  return {
    generatedAt: generatedAt.toISOString(),
    scope,
    fetchedFutureSessionCount: input.wiseSessions.length,
    wiseLocationCount: input.wiseLocations.length,
    exactTvLocationsMissing,
    invalidPlainTvLocationsPresent,
    invalidPlainTvSessions,
    proposals: proposalList,
    manualRequired,
    confirmationToken: `all:${proposalList.length}`,
    requiredSessionIds: proposalList.map((proposal) => proposal.wiseSessionId).sort(),
  };
}

export function assertPlainTvCleanupApplyAllowed(input: PlainTvCleanupApplyGuardInput): void {
  const env = input.env ?? process.env;
  if (env.ENABLE_WISE_EMERGENCY_REPAIR !== "true") {
    throw new Error(WISE_PLAIN_TV_CLEANUP_DISABLED_MESSAGE);
  }
  if (input.proposals.length === 0) {
    throw new Error("Wise plain TV cleanup apply refused: no proposed changes.");
  }
  const expectedConfirm = `all:${input.proposals.length}`;
  if (input.confirm !== expectedConfirm) {
    throw new Error(`Wise plain TV cleanup apply refused: expected --confirm ${expectedConfirm}.`);
  }
  const expectedSessionIds = input.proposals.map((proposal) => proposal.wiseSessionId).sort();
  const actualSessionIds = [...(input.sessionIds ?? [])].sort();
  if (
    expectedSessionIds.length !== actualSessionIds.length ||
    actualSessionIds.some((sessionId, index) => sessionId !== expectedSessionIds[index])
  ) {
    throw new Error(`Wise plain TV cleanup apply refused: expected --session-ids ${expectedSessionIds.join(",")}.`);
  }
  const missingClassId = input.proposals.find((proposal) => !proposal.wiseClassId);
  if (missingClassId) {
    throw new Error(`Wise plain TV cleanup apply refused: session ${missingClassId.wiseSessionId} is missing a Wise class id.`);
  }
}

export function invalidPlainTvSessionCount(wiseSessions: WiseSession[]): number {
  return wiseSessions
    .map(normalizeWiseSessionForPlainTvCleanup)
    .filter((session): session is PlainTvCleanupSession => Boolean(session))
    .filter((session) => Boolean(intendedPlainTvRepairLocation(session.location))).length;
}
