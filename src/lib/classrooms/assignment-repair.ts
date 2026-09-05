import type { AssignmentResultRow, ExternalRoomBlock } from "./assignment-engine";
import { isOnsiteSessionType } from "./session-mode";
import { NO_ROOM_AVAILABLE, type ClassroomRoomDefinition } from "./rooms";

export const ROOM_REPAIR_MAX_NODES = 20_000;
export const ROOM_REPAIR_MAX_DEPTH = 4;

/** Shared by both passes of incremental reconciliation; the cap is per date, not per call. */
export interface RoomRepairBudget { remaining: number }

const physical = (name: string) => name.trim().toLowerCase().replace(/\s+\(tv\)$/, "");
const overlaps = (a: { startMinute: number; endMinute: number }, b: { startMinute: number; endMinute: number }) =>
  a.startMinute < b.endMinute && b.startMinute < a.endMinute;

interface RepairInput {
  rows: AssignmentResultRow[];
  rooms: ClassroomRoomDefinition[];
  externalBlocks: ExternalRoomBlock[];
  budget: RoomRepairBudget;
  compatible: (row: AssignmentResultRow, room: ClassroomRoomDefinition) => boolean;
  locked: (row: AssignmentResultRow) => boolean;
  preferenceCost: (row: AssignmentResultRow, room: ClassroomRoomDefinition) => number;
}

/** Bounded displacement search. Every branch is a separate map; failed branches change nothing. */
export function repairClassroomAssignments(input: RepairInput): AssignmentResultRow[] {
  const { rows, rooms, budget } = input;
  budget.remaining = Math.max(0, Math.min(ROOM_REPAIR_MAX_NODES, budget.remaining));
  const roomByName = new Map(rooms.map(room => [physical(room.name), room]));
  const baseline = new Map(rows.filter(row => roomByName.has(physical(row.assignedRoom)))
    .map(row => [row.wiseSessionId, row.assignedRoom]));
  const active = rows.filter(row => row.status !== "remote");
  const peers = new Map(active.map(row => [row.wiseSessionId,
    active.filter(other => other.wiseSessionId !== row.wiseSessionId && overlaps(row, other))]));
  const canPublish = (row: AssignmentResultRow) => isOnsiteSessionType(row.sessionType)
    && Boolean(row.wiseClassId) && !row.warnings.includes("needs_review_missing_capacity");
  const retainedLocation = (row: AssignmentResultRow) => isOnsiteSessionType(row.sessionType)
    ? row.currentWiseLocation?.trim() || null : null;
  const immovable = (row: AssignmentResultRow) => input.locked(row)
    || (Boolean(retainedLocation(row)) && !canPublish(row));
  const candidates = new Map(active.map(row => [row.wiseSessionId, rooms.filter(room =>
    input.compatible(row, room) && !input.externalBlocks.some(block =>
      block.wiseSessionId !== row.wiseSessionId && physical(block.location) === physical(room.name) && overlaps(row, block)),
  )]));

  let positions = new Map(baseline);
  for (const row of active) {
    const target = positions.get(row.wiseSessionId);
    if (target && canPublish(row) && !(candidates.get(row.wiseSessionId) ?? []).some(room => physical(room.name) === physical(target))) {
      positions.delete(row.wiseSessionId);
    }
  }
  // A row which cannot be published continues to occupy its actual Wise location, even if the
  // greedy plan proposed a different room. Unknown catalog locations still block by physical name.
  for (const row of active) {
    if (!canPublish(row) && retainedLocation(row)) {
      const actual = retainedLocation(row);
      if (actual) positions.set(row.wiseSessionId, roomByName.get(physical(actual))?.name ?? actual);
      else positions.delete(row.wiseSessionId);
    }
  }
  const effectiveRoom = (row: AssignmentResultRow, plan: Map<string, string>) =>
    plan.get(row.wiseSessionId) ?? retainedLocation(row);
  const conflicts = (row: AssignmentResultRow, room: string, plan: Map<string, string>) => (peers.get(row.wiseSessionId) ?? []).filter(other =>
    physical(effectiveRoom(other, plan) ?? "") === physical(room),
  );

  // Never return a proposal occupying the retained Wise location of an unresolved session. Removal
  // can expose another retained location, so close this set before searching and after each repair.
  const protectRetainedLocations = (plan: Map<string, string>) => {
    if (!active.some(row => retainedLocation(row) && (!plan.has(row.wiseSessionId) || !canPublish(row)))) return plan;
    let changed = true;
    while (changed) {
      changed = false;
      for (const row of active) {
        const target = plan.get(row.wiseSessionId);
        if (!target || !canPublish(row)) continue;
        if ((peers.get(row.wiseSessionId) ?? []).some(other => (!plan.has(other.wiseSessionId) || !canPublish(other))
          && physical(retainedLocation(other) ?? "") === physical(target))) {
          plan.delete(row.wiseSessionId);
          changed = true;
        }
      }
    }
    return plan;
  };
  positions = protectRetainedLocations(positions);

  const score = (plan: Map<string, string>): number[] => {
    let missing = 0, moved = 0, preference = 0;
    for (const row of active) {
      const target = plan.get(row.wiseSessionId);
      if (!target) { missing++; continue; }
      if (baseline.has(row.wiseSessionId) && baseline.get(row.wiseSessionId) !== target) moved++;
      const room = roomByName.get(physical(target));
      if (room) preference += input.preferenceCost(row, room);
    }
    return [missing, moved, preference];
  };
  const better = (a: number[], b: number[]) => {
    for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) return a[i] < b[i];
    return false;
  };
  const unresolved = active.filter(row => !positions.has(row.wiseSessionId) && !(retainedLocation(row) && !canPublish(row)))
    .sort((a, b) => a.startMinute - b.startMinute || a.wiseSessionId.localeCompare(b.wiseSessionId));
  const limited = new Set<string>();
  for (let index = 0; index < unresolved.length; index++) {
    const root = unresolved[index];
    if (positions.has(root.wiseSessionId)) continue;
    // Reserve work for subsequent unresolved rows rather than spending the whole date on one.
    let allowance = Math.floor(budget.remaining / (unresolved.length - index));
    let hitDepth = false;
    function* place(row: AssignmentResultRow, plan: Map<string, string>, ancestors: Set<string>, depth: number): Generator<Map<string, string>> {
      if (depth > ROOM_REPAIR_MAX_DEPTH) { hitDepth = true; return; }
      if (allowance <= 0 || budget.remaining <= 0) return;
      allowance--; budget.remaining--;
      const visited = new Set([...ancestors, row.wiseSessionId]);
      const options = (candidates.get(row.wiseSessionId) ?? []).map(room => ({
        room, blockers: conflicts(row, room.name, plan),
      })).sort((a, b) => a.blockers.length - b.blockers.length
        || Number(b.room.name === baseline.get(row.wiseSessionId)) - Number(a.room.name === baseline.get(row.wiseSessionId))
        || input.preferenceCost(row, a.room) - input.preferenceCost(row, b.room)
        || a.room.sortOrder - b.room.sortOrder || a.room.name.localeCompare(b.room.name));
      for (const { room, blockers } of options) {
        if (allowance <= 0 || budget.remaining <= 0) return;
        if (blockers.some(other => immovable(other) || visited.has(other.wiseSessionId))) continue;
        const next = new Map(plan);
        next.set(row.wiseSessionId, room.name);
        // Keep each displaced row's old position until it is placed: siblings cannot steal a
        // room from an unprocessed blocker, and ancestor checks reject cycles.
        function* relocate(i: number, partial: Map<string, string>): Generator<Map<string, string>> {
          if (i === blockers.length) { yield partial; return; }
          for (const moved of place(blockers[i], partial, visited, depth + 1)) yield* relocate(i + 1, moved);
        }
        yield* relocate(0, next);
      }
    }
    let best = positions;
    let bestScore = score(best);
    for (const candidate of place(root, positions, new Set(), 0)) {
      const protectedPlan = protectRetainedLocations(new Map(candidate));
      // A complete candidate must preserve every previously placed class.
      if ([...positions.keys()].some(id => !protectedPlan.has(id))) continue;
      const nextScore = score(protectedPlan);
      if (better(nextScore, bestScore)) { best = protectedPlan; bestScore = nextScore; }
    }
    positions = best;
    if (allowance <= 0 || budget.remaining <= 0 || hitDepth) limited.add(root.wiseSessionId);
  }

  return rows.map(row => {
    if (row.status === "remote") return row;
    const target = positions.get(row.wiseSessionId);
    if (target === row.assignedRoom && row.status !== "no_room") return row;
    if (!target) {
      const reason = !(candidates.get(row.wiseSessionId)?.length) ? "no_compatible_room"
        : limited.has(row.wiseSessionId) || budget.remaining <= 0 ? "room_repair_search_exhausted" : "room_repair_unresolved";
      return { ...row, assignedRoom: NO_ROOM_AVAILABLE, status: "no_room" as const,
        warnings: [...new Set([...row.warnings.filter(w => w !== "no_compatible_room" && !w.startsWith("room_repair_")), "no_room_available", reason])],
        ruleTrace: [...row.ruleTrace, `room repair: ${reason}; retained Wise occupancy protected`] };
    }
    const retainedReview = Boolean(retainedLocation(row)) && !canPublish(row);
    return { ...row, assignedRoom: target,
      status: row.warnings.includes("needs_review_missing_capacity") || retainedReview ? "needs_review" as const : "assigned" as const,
      warnings: [...row.warnings.filter(w => w !== "no_room_available" && w !== "no_compatible_room" && !w.startsWith("room_repair_")),
        ...(retainedReview ? ["retained_wise_location_needs_review"] : [])],
      ruleTrace: [...row.ruleTrace, `room repair: ${row.assignedRoom} → ${target}`] };
  });
}
