import { join } from "node:path";
import loadHighs, { type Highs, type Model } from "highs";
import { isOnlineSession, isOfflineSession, REMOTE_NO_ROOM_NEEDED, roomPassesConstraints,
  type AssignmentResultRow, type ExternalRoomBlock } from "./assignment-engine";
import { getPriorityPreferredRoom, isGiftTutor, NO_ROOM_AVAILABLE, ROOM_JOY, type ClassroomRoomDefinition } from "./rooms";
import { physicalRoom } from "./room-policy";
import { compareStudentEvidence, unknownStudentEvidence } from "./mode-history";
import type { OverflowAction, OverflowPlacement, OverflowPlan, StudentModeEvidence } from "./overflow-types";
import { overflowLessonKey } from "./overflow-release";
import { classroomTimestampToWiseIso } from "./timestamps";
export { overflowLessonKey } from "./overflow-release";

export const OVERFLOW_BUDGET_MS = 30_000;
let runtime: Promise<Highs> | undefined;
export function loadOverflowSolver(): Promise<Highs> {
  // Explicit resolution + Next output tracing keeps WASM available in deployed Node functions.
  // Turbopack rewrites require.resolve() to numeric module IDs. Use the traced
  // deployment-root asset instead; Node functions execute from the app root.
  return runtime ??= loadHighs({ locateFile: () => join(process.cwd(), "node_modules/highs/build/highs.wasm") })
    .catch(error => { runtime = undefined; throw error; });
}

/** Read-only deployment diagnostic: exercise the deployed WASM and integer constraints. */
export async function checkOverflowSolver() {
  const started = performance.now(), highs = await loadOverflowSolver();
  const model = highs.createModel({ numCols: 1, numRows: 1, colCost: [1], colLower: [0], colUpper: [2],
    integrality: [highs.constants.variableType.integer], rowLower: [0.5], rowUpper: [2],
    matrix: { format: "csr", numRows: 1, numCols: 1, starts: [0, 1], indices: [0], values: [1] } });
  try {
    model.options.set({ output_flag: false, time_limit: 2 });
    const solved = model.run();
    if (solved.modelStatus !== 7 || model.getObjectiveValue() !== 1) throw new Error("Integer optimizer self-check failed");
    return { ok: true, package: "highs@1.15.3", integerOptimum: 1, wasmLoaded: true, elapsedMs: Math.round(performance.now() - started) };
  } finally { model.dispose(); }
}

interface PlannerInput<T extends AssignmentResultRow> {
  rows: T[];
  rooms: ClassroomRoomDefinition[];
  assignmentDate: string;
  now?: Date;
  frozenSessionIds?: ReadonlySet<string>;
  externalRoomBlocks?: ExternalRoomBlock[];
  evidence?: ReadonlyMap<string, StudentModeEvidence>;
  sourceSnapshotId?: string | null;
  sourceCheckedAt?: string | null;
  snapshotFinishedAt?: string | null;
  historyCheckedAt?: string | null;
  unverifiedReasons?: string[];
  budgetMs?: number;
}

interface Choice {
  row: number;
  room: string;
  occupies: string | null;
  converted: boolean;
  released: boolean;
  missing: number;
  rank: number;
  moved: number;
  elsewhere: number;
  order: number;
}
interface Solution {
  choices: Choice[];
  missing: number;
  switches: number;
  missingProven: boolean;
  switchesProven: boolean;
  lowerBound: number | null;
  rankingComplete: boolean;
}
const overlaps = (a: { startMinute: number; endMinute: number }, b: { startMinute: number; endMinute: number }) => a.startMinute < b.endMinute && b.startMinute < a.endMinute;
const holdsRoom = (room: string) => room !== NO_ROOM_AVAILABLE && room !== REMOTE_NO_ROOM_NEEDED;

export function eligibleOnlineSwitch(row: AssignmentResultRow, frozen: ReadonlySet<string>): boolean {
  return isOfflineSession(row.sessionType) && !row.overrideRoom && !frozen.has(row.wiseSessionId)
    && row.status !== "needs_review" && !row.warnings.includes("needs_review_missing_capacity")
    && Boolean(row.wiseClassId) && row.studentCount === 1 && row.studentIds?.length === 1
    && /ONE_TO_ONE|ONE.TO.ONE|1:1|PERSONAL|INDIVIDUAL/i.test(row.classType ?? "") && !/GROUP/i.test(row.classType ?? "");
}

function candidateRanks<T extends AssignmentResultRow>(input: PlannerInput<T>): Map<string, number> {
  const frozen = input.frozenSessionIds ?? new Set<string>();
  const candidates = input.rows.filter(row => eligibleOnlineSwitch(row, frozen)).sort((a, b) =>
    compareStudentEvidence(input.evidence?.get(a.studentIds![0]) ?? unknownStudentEvidence(a.studentIds![0]),
      input.evidence?.get(b.studentIds![0]) ?? unknownStudentEvidence(b.studentIds![0]))
    || a.wiseSessionId.localeCompare(b.wiseSessionId));
  return new Map(candidates.map((row, index) => [row.wiseSessionId, index + 1]));
}

function choicesFor<T extends AssignmentResultRow>(input: PlannerInput<T>, allowConversions: boolean): Choice[] {
  const frozen = input.frozenSessionIds ?? new Set<string>(), ranks = candidateRanks(input);
  // Aliases share occupancy, but retain their own capacity/equipment policy.
  const rooms = input.rooms.filter(room => room.active).sort((a, b) => a.sortOrder - b.sortOrder || a.name.localeCompare(b.name));
  const choices: Choice[] = [];
  input.rows.forEach((row, index) => {
    const locked = Boolean(row.overrideRoom) || frozen.has(row.wiseSessionId) || row.status === "needs_review"
      || (!isOfflineSession(row.sessionType) && !isOnlineSession(row.sessionType))
      || (isOfflineSession(row.sessionType) && !row.wiseClassId);
    const add = (room: string, released = false, converted = false) => {
      const occupies = holdsRoom(room) ? physicalRoom(room) : room === NO_ROOM_AVAILABLE && isOfflineSession(row.sessionType)
        && row.currentWiseLocation ? physicalRoom(row.currentWiseLocation) : null;
      if (occupies && (input.externalRoomBlocks ?? []).some(block => block.wiseSessionId !== row.wiseSessionId
        && physicalRoom(block.location) === occupies && overlaps(block, row))) return;
      choices.push({ row: index, room, occupies, released, converted,
        missing: Number(room === NO_ROOM_AVAILABLE), rank: converted ? ranks.get(row.wiseSessionId)! : 0,
        moved: Number(holdsRoom(row.assignedRoom) && physicalRoom(row.assignedRoom) !== physicalRoom(room)),
        elsewhere: Number(released && room === REMOTE_NO_ROOM_NEEDED),
        order: rooms.findIndex(candidate => candidate.name === room) + 1 });
    };
    // A fixed override fixes the requested room, not an earlier allocator failure.
    // Other lessons may move so an unallocated override can finally be satisfied.
    if (row.overrideRoom && row.status === "no_room" && !frozen.has(row.wiseSessionId)) {
      const target = rooms.find(room => room.name === row.overrideRoom);
      if (target && roomPassesConstraints(target, row, row.minCapacity, row.needsTv)) add(target.name);
      add(NO_ROOM_AVAILABLE);
      return;
    }
    if (locked) { add(row.assignedRoom); return; }
    if (row.status === "remote" && !row.overflowReleaseRoom) { add(REMOTE_NO_ROOM_NEEDED); return; }
    const online = isOnlineSession(row.sessionType);
    const pin = getPriorityPreferredRoom(row.tutorDisplayName) ?? (isGiftTutor(row.tutorDisplayName) ? ROOM_JOY : null);
    if (!row.overflowReleaseRoom) {
      for (const room of rooms) {
        if (pin && physicalRoom(room.name) !== physicalRoom(pin)) continue;
        if (roomPassesConstraints(room, row, row.minCapacity, row.needsTv)) add(room.name,
          online && room.category === "online_only" && physicalRoom(row.assignedRoom) !== physicalRoom(room.name));
      }
    }
    if (online || (allowConversions && ranks.has(row.wiseSessionId))) {
      for (const room of rooms.filter(room => room.category === "online_only" && room.capacity >= 1)) {
        if (!choices.some(choice => choice.row === index && choice.room === room.name)) add(room.name, true, !online);
      }
      add(REMOTE_NO_ROOM_NEEDED, true, !online);
    }
    if (row.status === "no_room") add(NO_ROOM_AVAILABLE);
  });
  return choices;
}

function buildModel(highs: Highs, rows: AssignmentResultRow[], choices: Choice[]): Model {
  const constraints: Array<{ indices: number[]; lower: number; upper: number }> = rows.map((_, index) => ({
    indices: choices.flatMap((choice, col) => choice.row === index ? [col] : []), lower: 1, upper: 1,
  }));
  // Half-open event intervals: a room vacated at 12:00 is available for a 12:00 start.
  for (const room of [...new Set(choices.map(choice => choice.occupies).filter((value): value is string => Boolean(value)))]) {
    const columns = choices.flatMap((choice, col) => choice.occupies === room ? [col] : []);
    const times = [...new Set(columns.flatMap(col => [rows[choices[col].row].startMinute, rows[choices[col].row].endMinute]))].sort((a, b) => a - b);
    const seen = new Set<string>();
    for (const time of times.slice(0, -1)) {
      const indices = columns.filter(col => rows[choices[col].row].startMinute <= time && rows[choices[col].row].endMinute > time);
      const key = indices.join(",");
      if (new Set(indices.map(col => choices[col].row)).size < 2 || seen.has(key)) continue;
      seen.add(key); constraints.push({ indices, lower: 0, upper: 1 });
    }
  }
  const starts = [0], indices: number[] = [], values: number[] = [];
  for (const constraint of constraints) { indices.push(...constraint.indices); values.push(...constraint.indices.map(() => 1)); starts.push(indices.length); }
  return highs.createModel({ numCols: choices.length, numRows: constraints.length,
    colCost: choices.map(choice => choice.missing), colLower: choices.map(() => 0), colUpper: choices.map(() => 1),
    integrality: choices.map(() => highs.constants.variableType.integer),
    rowLower: constraints.map(row => row.lower), rowUpper: constraints.map(row => row.upper),
    matrix: { format: "csr", numRows: constraints.length, numCols: choices.length, starts, indices, values } });
}

function solve<T extends AssignmentResultRow>(highs: Highs, input: PlannerInput<T>, allowConversions: boolean, deadline: number): Solution | null {
  if (performance.now() >= deadline) return null;
  const choices = choicesFor(input, allowConversions);
  if (performance.now() >= deadline || !choices.length || input.rows.some((_, index) => !choices.some(choice => choice.row === index))) return null;
  const model = buildModel(highs, input.rows, choices);
  let best: Solution | null = null;
  const phases: Array<(choice: Choice) => number> = [choice => choice.missing, choice => Number(choice.converted),
    choice => choice.rank, choice => choice.elsewhere, choice => choice.moved, choice => choice.order];
  try {
    model.options.set({ output_flag: false, random_seed: 0, mip_rel_gap: 0, mip_abs_gap: 0 });
    for (let phase = 0; phase < phases.length; phase++) {
      if (performance.now() >= deadline) return best;
      const cost = choices.map(phases[phase]);
      if (!cost.some(Boolean) && best) {
        if (phase === 1) { best.switchesProven = best.missingProven; best.lowerBound = 0; }
        if (phase === phases.length - 1) best.rankingComplete = true;
        continue;
      }
      cost.forEach((value, index) => model.changeColCost(index, value));
      model.zeroAllClocks();
      model.options.set("time_limit", Math.max(0.001, (deadline - performance.now()) / 1000));
      const outcome = model.run();
      const optimal = outcome.modelStatus === 7;
      const feasible = Number(model.info.get("primal_solution_status")) === 2;
      if (!feasible) return best;
      const primal = model.getSolution().colValue;
      if (primal.some(value => !Number.isFinite(value) || Math.abs(value - Math.round(value)) > 1e-5)) return best;
      const selected = choices.filter((_, index) => primal[index] > 0.5);
      // Do not trust a fractional, incomplete, or overlapping incumbent on a limited solve.
      if (selected.length !== input.rows.length || new Set(selected.map(choice => choice.row)).size !== input.rows.length
        || selected.some((choice, index) => choice.occupies && selected.slice(index + 1).some(other => other.occupies === choice.occupies
          && overlaps(input.rows[choice.row], input.rows[other.row])))) return best;
      const missing = selected.reduce((sum, choice) => sum + choice.missing, 0);
      const switches = selected.filter(choice => choice.converted).length;
      const previous: Solution | null = best as Solution | null;
      const bound: number | null = phase === 1 ? Number(model.info.get("mip_dual_bound")) : previous?.lowerBound ?? null;
      best = { choices: selected, missing, switches, missingProven: phase === 0 ? optimal : previous?.missingProven ?? false,
        switchesProven: phase === 1 ? optimal : previous?.switchesProven ?? false,
        lowerBound: bound !== null && Number.isFinite(bound) ? Math.max(0, Math.ceil(bound - 1e-6)) : null,
        rankingComplete: phase === phases.length - 1 && optimal };
      if (!optimal) return best;
      const optimum = Math.round(model.getObjectiveValue());
      const nonzero = cost.flatMap((value, index) => value ? [index] : []);
      if (nonzero.length) model.addRow(optimum, optimum, { indices: nonzero, values: nonzero.map(index => cost[index]) });
    }
    return best;
  } finally { model.dispose(); }
}

function placement(row: AssignmentResultRow, choice: Choice): OverflowPlacement {
  return { wiseSessionId: row.wiseSessionId, tutor: row.tutorDisplayName, student: row.studentName ?? null,
    startMinute: row.startMinute, endMinute: row.endMinute, originalRoom: row.assignedRoom, room: choice.room,
    status: choice.missing ? "no_room" : choice.room === REMOTE_NO_ROOM_NEEDED ? "remote" : row.status === "needs_review" ? "needs_review" : "assigned",
    converted: choice.converted, released: choice.released, lessonKey: overflowLessonKey(row) };
}

function actions<T extends AssignmentResultRow>(input: PlannerInput<T>, solution: Solution): OverflowAction[] {
  return solution.choices.flatMap(choice => {
    const row = input.rows[choice.row], moved = physicalRoom(row.assignedRoom) !== physicalRoom(choice.room);
    if ((!moved && !choice.converted) || choice.missing) return [];
    return [{ ...placement(row, choice), kind: choice.converted ? "switch_to_online" as const
      : choice.released ? "relocate_online" as const : row.status === "no_room" ? "accommodate" as const : "move_room" as const,
      teachingLocation: choice.room === REMOTE_NO_ROOM_NEEDED ? "elsewhere" as const
        : input.rooms.find(room => room.name === choice.room)?.category === "online_only" ? "dedicated_online_room" as const : "classroom" as const,
      evidence: choice.converted ? input.evidence?.get(row.studentIds![0]) ?? unknownStudentEvidence(row.studentIds![0]) : null }];
  });
}

/** Pure planning plus a local WASM solve: never writes allocations, Wise, or notifications. */
export async function planClassroomOverflow<T extends AssignmentResultRow>(input: PlannerInput<T>): Promise<{ actualRows: T[]; plan: OverflowPlan | null }> {
  const overflow = input.rows.filter(row => row.status === "no_room").length;
  if (!overflow) return { actualRows: input.rows, plan: null };
  const start = performance.now(), now = input.now ?? new Date();
  input = { ...input, frozenSessionIds: new Set([...(input.frozenSessionIds ?? []), ...input.rows
    .filter(row => Date.parse(classroomTimestampToWiseIso(row.startTime)) <= now.getTime()).map(row => row.wiseSessionId)]) };
  const plan: OverflowPlan = { version: 1, algorithmVersion: "overflow-v1", assignmentDate: input.assignmentDate,
    generatedAt: now.toISOString(), sourceSnapshotId: input.sourceSnapshotId ?? null, sourceCheckedAt: input.sourceCheckedAt ?? null,
    snapshotFinishedAt: input.snapshotFinishedAt ?? null,
    historyCheckedAt: input.historyCheckedAt ?? null, status: "unverified", minimumSwitches: null, switchLowerBound: null,
    proposedSwitches: 0, rankingComplete: false, baselineOverflow: overflow, actualRemainingOverflow: overflow,
    predictedRemainingOverflow: overflow, actualActions: [], proposedActions: [], predictedAssignments: [], accommodatedSessionIds: [],
    warnings: [...(input.unverifiedReasons ?? [])], elapsedMs: 0 };
  if (input.rows.some(row => row.status === "needs_review" || row.warnings.includes("needs_review_missing_capacity"))) {
    plan.warnings.push("Resolve class size or source review issues before relying on an overflow plan.");
  }
  if (input.rows.some(row => !Number.isFinite(row.startMinute) || !Number.isFinite(row.endMinute)
    || row.startMinute < 0 || row.endMinute > 1440 || row.endMinute <= row.startMinute)) {
    plan.warnings.push("A lesson interval is incomplete or crosses the day boundary; resolve its source times before planning.");
  }
  if (plan.warnings.length) return { actualRows: input.rows, plan };
  let actualRows = input.rows;
  try {
    const deadline = start + Math.max(0, Math.min(OVERFLOW_BUDGET_MS, input.budgetMs ?? OVERFLOW_BUDGET_MS));
    const highs = await loadOverflowSolver();
    let actual = solve(highs, input, false, Math.min(deadline, start + 10_000));
    const predicted = actual?.missing === 0 ? actual : solve(highs, input, true, deadline);
    // A later incumbent can also improve the actual-mode plan with zero conversions.
    if (predicted && !predicted.switches && (!actual || predicted.missing < actual.missing)) actual = predicted;
    if (actual && actual.missing <= overflow) {
      plan.actualActions = actions(input, actual);
      plan.actualRemainingOverflow = actual.missing;
      actualRows = input.rows.map((row, index) => {
        const choice = actual.choices.find(candidate => candidate.row === index)!;
        if (choice.room === row.assignedRoom && !choice.released) return row;
        return { ...row, assignedRoom: choice.room, status: placement(row, choice).status,
          overflowReleaseRoom: choice.released ? choice.room : row.overflowReleaseRoom ?? null,
          minCapacity: choice.released ? 1 : row.minCapacity, needsTv: choice.released ? false : row.needsTv,
          warnings: choice.missing ? row.warnings : row.warnings.filter(value => !["no_room_available", "room_repair_search_exhausted", "no_compatible_room"].includes(value)),
          ruleTrace: [...row.ruleTrace, choice.released ? "overflow relief: onsite classroom released for the whole lesson" : "overflow optimizer: coordinated room rearrangement"] };
      });
    }
    if (predicted) {
      plan.predictedAssignments = predicted.choices.map(choice => placement(input.rows[choice.row], choice));
      plan.predictedRemainingOverflow = predicted.missing;
      plan.proposedSwitches = predicted.switches;
      plan.proposedActions = predicted.switches ? actions(input, predicted) : [];
      plan.switchLowerBound = actual?.missing === 0 ? 0 : predicted.missing === 0 ? predicted.lowerBound : null;
      const countProven = actual?.missing === 0 || predicted.switchesProven;
      plan.minimumSwitches = predicted.missing === 0 && countProven ? predicted.switches : null;
      plan.status = predicted.missing === 0 ? countProven ? "minimum_proven" : "best_found"
        : predicted.missingProven ? "no_complete_solution" : "best_found";
      plan.rankingComplete = predicted.rankingComplete;
      plan.accommodatedSessionIds = plan.predictedAssignments.filter(row => row.originalRoom === NO_ROOM_AVAILABLE && row.status !== "no_room").map(row => row.wiseSessionId);
    } else plan.warnings.push("The search did not return a verified solution within its budget; no impossibility or minimum is established.");
  } catch (error) {
    // A solver failure cannot interrupt the existing allocator or make unresolved classes disappear.
    plan.status = "unverified";
    plan.warnings.push(`Overflow optimizer unavailable: ${error instanceof Error ? error.message : "unknown error"}`);
  }
  plan.elapsedMs = Math.round(performance.now() - start);
  return { actualRows, plan };
}
