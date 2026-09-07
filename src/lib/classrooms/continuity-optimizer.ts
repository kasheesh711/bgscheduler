import type { AssignmentResultRow, ExternalRoomBlock } from "./assignment-engine";
import type { ClassroomRoomDefinition } from "./rooms";
import { assignmentTutorKey, CONTINUITY_GAP_MINUTES, physicalRoom, policyForTutor, roomQualityMetrics, type TutorRoomPolicies } from "./room-policy";
import { isOnsiteSessionType } from "./session-mode";

export const CONTINUITY_MAX_NODES = 10_000;
export const CONTINUITY_MAX_DEPTH = 4;

interface Input {
  rows: AssignmentResultRow[];
  rooms: ClassroomRoomDefinition[];
  externalBlocks: ExternalRoomBlock[];
  compatible: (row: AssignmentResultRow, room: ClassroomRoomDefinition) => boolean;
  locked: (row: AssignmentResultRow) => boolean;
  preferenceCost: (row: AssignmentResultRow, room: ClassroomRoomDefinition) => number;
  policies?: TutorRoomPolicies;
  savedRooms?: ReadonlyMap<string, string>;
  frozenSessionIds?: ReadonlySet<string>;
  maxNodes?: number;
}

const overlaps = (a: { startMinute: number; endMinute: number }, b: { startMinute: number; endMinute: number }) => a.startMinute < b.endMinute && b.startMinute < a.endMinute;
const better = (a: number[], b: number[]) => {
  for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) return a[i] < b[i];
  return false;
};

/** Whole-chain lookahead followed by bounded, atomic displacement/swap candidates. */
export function optimizeClassroomContinuity(input: Input) {
  const { rows, rooms } = input;
  const byId = new Map(rows.map(row => [row.wiseSessionId, row]));
  const roomByName = new Map(rooms.map(room => [physicalRoom(room.name), room]));
  const placed = rows.filter(row => ["assigned", "needs_review"].includes(row.status) && roomByName.has(physicalRoom(row.assignedRoom)));
  const retained = (row: AssignmentResultRow) => isOnsiteSessionType(row.sessionType) ? row.currentWiseLocation : null;
  const locked = (row: AssignmentResultRow) => input.locked(row) || input.frozenSessionIds?.has(row.wiseSessionId)
    || row.status !== "assigned" || Boolean(retained(row) && !row.wiseClassId);
  const candidates = new Map(placed.map(row => [row.wiseSessionId, rooms.filter(room =>
    input.compatible(row, room) && (!locked(row) || physicalRoom(room.name) === physicalRoom(row.assignedRoom))
    && !input.externalBlocks.some(block => block.wiseSessionId !== row.wiseSessionId && physicalRoom(block.location) === physicalRoom(room.name) && overlaps(row, block)),
  ).sort((a, b) => input.preferenceCost(row, a) - input.preferenceCost(row, b) || a.sortOrder - b.sortOrder || a.name.localeCompare(b.name))]));
  let positions = new Map(placed.map(row => [row.wiseSessionId, row.assignedRoom]));
  const peers = new Map(placed.map(row => [row.wiseSessionId, rows.filter(other => other.wiseSessionId !== row.wiseSessionId && overlaps(row, other))]));
  const conflicts = (row: AssignmentResultRow, room: string, plan: Map<string, string>) => (peers.get(row.wiseSessionId) ?? []).filter(other =>
    physicalRoom(plan.get(other.wiseSessionId) ?? retained(other) ?? "") === physicalRoom(room));
  const scoredRows = (plan: Map<string, string>) => rows.map(row => ({ ...row, assignedRoom: plan.get(row.wiseSessionId) ?? row.assignedRoom }));
  const score = (plan: Map<string, string>) => {
    const metrics = roomQualityMetrics(scoredRows(plan), input.policies);
    let changed = 0, preference = 0;
    for (const [id, room] of plan) {
      if (input.savedRooms?.has(id) && physicalRoom(input.savedRooms.get(id)!) !== physicalRoom(room)) changed++;
      preference += input.preferenceCost(byId.get(id)!, roomByName.get(physicalRoom(room))!);
    }
    return [rows.filter(row => row.status === "no_room").length, metrics.roomChanges, metrics.outsideUsualRooms, changed, metrics.distinctTeacherRooms, preference];
  };
  const groups = new Map<string, AssignmentResultRow[]>();
  for (const row of rows) {
    const key = assignmentTutorKey(row);
    groups.set(key, [...(groups.get(key) ?? []), row]);
  }
  const chains: AssignmentResultRow[][] = [];
  for (const group of [...groups.values()].sort((a, b) => assignmentTutorKey(a[0]).localeCompare(assignmentTutorKey(b[0])))) {
    group.sort((a, b) => a.startMinute - b.startMinute || a.endMinute - b.endMinute || a.wiseSessionId.localeCompare(b.wiseSessionId));
    let chain: AssignmentResultRow[] = [];
    for (const row of group) {
      const prior = chain.at(-1);
      if (!positions.has(row.wiseSessionId) || (prior && (row.startMinute < prior.endMinute || row.startMinute - prior.endMinute > CONTINUITY_GAP_MINUTES))) {
        if (chain.length) chains.push(chain);
        chain = [];
      }
      if (positions.has(row.wiseSessionId)) chain.push(row);
    }
    if (chain.length) chains.push(chain);
  }
  // First try the entire chain; pairs allow partial improvements when a long chain cannot fit.
  const roots = [...chains.filter(chain => chain.length > 1).sort((a, b) => b.length - a.length || a[0].startMinute - b[0].startMinute),
    ...chains.flatMap(chain => chain.slice(1).map((row, i) => [chain[i], row])), ...placed.map(row => [row])];
  let nodes = 0, depthLimited = false, budgetLimited = false;
  const maxNodes = Math.max(0, Math.min(CONTINUITY_MAX_NODES, input.maxNodes ?? CONTINUITY_MAX_NODES));
  const valid = (plan: Map<string, string>) => placed.every(row => {
    const target = plan.get(row.wiseSessionId);
    return target && (candidates.get(row.wiseSessionId) ?? []).some(room => room.name === target) && conflicts(row, target, plan).length === 0;
  });
  let bestScore = score(positions);
  let improved = true;
  while (improved && nodes < maxNodes) {
    improved = false;
    for (let rootIndex = 0; rootIndex < roots.length && nodes < maxNodes; rootIndex++) {
      const root = roots[rootIndex];
      const ids = new Set(root.map(row => row.wiseSessionId));
      const common = (candidates.get(root[0].wiseSessionId) ?? []).filter(room => root.every(row =>
        (candidates.get(row.wiseSessionId) ?? []).some(candidate => candidate.name === room.name)));
      let allowance = Math.max(1, Math.floor((maxNodes - nodes) / (roots.length - rootIndex)));
      function* place(row: AssignmentResultRow, plan: Map<string, string>, ancestors: Set<string>, depth: number): Generator<Map<string, string>> {
        if (depth > CONTINUITY_MAX_DEPTH) { depthLimited = true; return; }
        if (locked(row)) return;
        const options = (candidates.get(row.wiseSessionId) ?? []).map(room => ({ room, blockers: conflicts(row, room.name, plan) }))
          .sort((a, b) => a.blockers.length - b.blockers.length || input.preferenceCost(row, a.room) - input.preferenceCost(row, b.room));
        for (const { room, blockers } of options) {
          if (nodes >= maxNodes || allowance-- <= 0) { budgetLimited = true; return; }
          nodes++;
          if (blockers.some(other => locked(other) || ancestors.has(other.wiseSessionId))) continue;
          const next = new Map(plan);
          next.set(row.wiseSessionId, room.name);
          yield* relocate(blockers, 0, next, new Set([...ancestors, row.wiseSessionId]), depth);
        }
      }
      function* relocate(blockers: AssignmentResultRow[], index: number, plan: Map<string, string>, ancestors: Set<string>, depth: number): Generator<Map<string, string>> {
        if (index === blockers.length) { yield plan; return; }
        for (const next of place(blockers[index], plan, ancestors, depth + 1)) yield* relocate(blockers, index + 1, next, ancestors, depth);
      }
      // Cheap moves get first consideration; displacement consumes the remaining allowance.
      const options = common.map(room => ({ room, blockers: [...new Map(root.flatMap(row => conflicts(row, room.name, positions)).filter(row => !ids.has(row.wiseSessionId)).map(row => [row.wiseSessionId, row])).values()] }))
        .sort((a, b) => a.blockers.length - b.blockers.length || root.reduce((sum, row) => sum + input.preferenceCost(row, a.room) - input.preferenceCost(row, b.room), 0));
      for (const { room, blockers } of options) {
        if (nodes >= maxNodes || allowance-- <= 0) { budgetLimited = true; break; }
        nodes++;
        if (root.every(row => positions.get(row.wiseSessionId) === room.name) || blockers.some(locked)) continue;
        const next = new Map(positions);
        for (const row of root) next.set(row.wiseSessionId, room.name);
        for (const candidate of relocate(blockers, 0, next, ids, 0)) {
          const candidateScore = score(candidate);
          if (better(candidateScore, bestScore) && valid(candidate)) {
            positions = candidate; bestScore = candidateScore; improved = true;
          }
        }
      }
    }
  }
  const result = rows.map(row => {
    const target = positions.get(row.wiseSessionId);
    if (!target || target === row.assignedRoom) return row;
    return { ...row, assignedRoom: target, ruleTrace: [...row.ruleTrace, `continuity optimization: ${row.assignedRoom} → ${target}`] };
  });
  return { rows: result, metrics: { ...roomQualityMetrics(result, input.policies), continuityNodes: nodes,
    continuitySearchExhausted: nodes >= maxNodes || depthLimited || budgetLimited } };
}

export function usualRoomPreferenceCost(row: AssignmentResultRow, room: ClassroomRoomDefinition, policies?: TutorRoomPolicies): number {
  const policy = policyForTutor(row, policies);
  const rank = policy?.rooms.findIndex(name => physicalRoom(name) === physicalRoom(room.name)) ?? -1;
  return rank >= 0 ? rank * 100 : policy?.rooms.length ? 1_000 : 0;
}
