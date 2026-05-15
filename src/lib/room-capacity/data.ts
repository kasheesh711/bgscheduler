import { and, desc, eq, gte, inArray, lte, lt } from "drizzle-orm";
import type { Database } from "@/lib/db";
import * as schema from "@/lib/db/schema";
import { assignClassrooms, type AssignmentSession } from "@/lib/classrooms/assignment-engine";
import { listClassroomRooms } from "@/lib/classrooms/data";
import { ensureIndex } from "@/lib/search/index";
import {
  buildDaySummaries,
  buildHeatmapCells,
  buildOvercapIntervals,
  findProjectedNoRoomRows,
  findUnmatchedCurrentAllocations,
} from "./analysis";
import { addBangkokDays, bangkokDateKey, bangkokDateStartUtc, defaultRoomCapacityRange, endOfBangkokMonth } from "./dates";
import {
  buildWeekendDemandCaptureReadiness,
  driversForScenario,
  seededDemandMixFromSchedule,
  simulateSaturation,
  simulateWeekendDemandBreakpoint,
} from "./forecast";
import type {
  RoomCapacityDemandMixRow,
  RoomCapacityForecastDriver,
  RoomCapacityForecastResponse,
  RoomCapacityMonthResponse,
  RoomCapacityPackageMixRow,
  RoomCapacityRoom,
  RoomCapacitySession,
} from "./types";

interface ActiveSnapshot {
  id: string;
  createdAt: Date;
}

async function getActiveSnapshot(db: Database): Promise<ActiveSnapshot> {
  const [activeSnapshot] = await db
    .select({ id: schema.snapshots.id, createdAt: schema.snapshots.createdAt })
    .from(schema.snapshots)
    .where(eq(schema.snapshots.active, true))
    .limit(1);
  if (!activeSnapshot) throw new Error("No active Wise snapshot found");
  return activeSnapshot;
}

function toRoomCapacityRoom(room: Awaited<ReturnType<typeof listClassroomRooms>>[number]): RoomCapacityRoom {
  return {
    id: room.id,
    name: room.name,
    capacity: room.capacity,
    hasTv: room.hasTv,
    category: room.category,
    active: room.active,
    sortOrder: room.sortOrder,
  };
}

function toEngineRoom(room: RoomCapacityRoom) {
  return {
    name: room.name,
    capacity: room.capacity,
    hasTv: room.hasTv,
    category: room.category,
    active: room.active,
    sortOrder: room.sortOrder,
  };
}

async function loadSessionsForRange(
  db: Database,
  snapshotId: string,
  startDate: string,
  endDate: string,
): Promise<RoomCapacitySession[]> {
  const start = bangkokDateStartUtc(startDate);
  const end = bangkokDateStartUtc(addBangkokDays(endDate, 1));
  const rows = await db
    .select({
      id: schema.futureSessionBlocks.id,
      groupId: schema.futureSessionBlocks.groupId,
      tutorDisplayName: schema.tutorIdentityGroups.displayName,
      wiseTeacherId: schema.futureSessionBlocks.wiseTeacherId,
      wiseTeacherUserId: schema.futureSessionBlocks.wiseTeacherUserId,
      wiseSessionId: schema.futureSessionBlocks.wiseSessionId,
      wiseClassId: schema.futureSessionBlocks.wiseClassId,
      startTime: schema.futureSessionBlocks.startTime,
      endTime: schema.futureSessionBlocks.endTime,
      weekday: schema.futureSessionBlocks.weekday,
      startMinute: schema.futureSessionBlocks.startMinute,
      endMinute: schema.futureSessionBlocks.endMinute,
      wiseStatus: schema.futureSessionBlocks.wiseStatus,
      sessionType: schema.futureSessionBlocks.sessionType,
      currentWiseLocation: schema.futureSessionBlocks.location,
      studentCount: schema.futureSessionBlocks.studentCount,
      subject: schema.futureSessionBlocks.subject,
      classType: schema.futureSessionBlocks.classType,
      title: schema.futureSessionBlocks.title,
    })
    .from(schema.futureSessionBlocks)
    .innerJoin(schema.tutorIdentityGroups, eq(schema.futureSessionBlocks.groupId, schema.tutorIdentityGroups.id))
    .where(
      and(
        eq(schema.futureSessionBlocks.snapshotId, snapshotId),
        eq(schema.futureSessionBlocks.isBlocking, true),
        gte(schema.futureSessionBlocks.startTime, start),
        lt(schema.futureSessionBlocks.startTime, end),
      ),
    );

  return rows.map((row) => ({
    ...row,
    startTime: new Date(row.startTime),
    endTime: new Date(row.endTime),
    date: bangkokDateKey(new Date(row.startTime)),
    wiseTeacherUserId: row.wiseTeacherUserId ?? null,
    wiseClassId: row.wiseClassId ?? null,
    sessionType: row.sessionType ?? null,
    currentWiseLocation: row.currentWiseLocation ?? null,
    studentCount: row.studentCount ?? null,
    subject: row.subject ?? null,
    classType: row.classType ?? null,
    title: row.title ?? null,
  }));
}

async function loadLatestOverridesByDate(
  db: Database,
  startDate: string,
  endDate: string,
): Promise<Map<string, Map<string, string>>> {
  const runs = await db
    .select()
    .from(schema.classroomAssignmentRuns)
    .where(and(gte(schema.classroomAssignmentRuns.assignmentDate, startDate), lte(schema.classroomAssignmentRuns.assignmentDate, endDate)))
    .orderBy(desc(schema.classroomAssignmentRuns.createdAt));

  const latestByDate = new Map<string, (typeof runs)[number]>();
  for (const run of runs) {
    if (!latestByDate.has(run.assignmentDate)) latestByDate.set(run.assignmentDate, run);
  }

  const runIds = [...latestByDate.values()].map((run) => run.id);
  if (runIds.length === 0) return new Map();

  const rows = await db
    .select({
      runId: schema.classroomAssignmentRows.runId,
      wiseSessionId: schema.classroomAssignmentRows.wiseSessionId,
      overrideRoom: schema.classroomAssignmentRows.overrideRoom,
    })
    .from(schema.classroomAssignmentRows)
    .where(inArray(schema.classroomAssignmentRows.runId, runIds));

  const dateByRunId = new Map([...latestByDate.values()].map((run) => [run.id, run.assignmentDate]));
  const byDate = new Map<string, Map<string, string>>();
  for (const row of rows) {
    if (!row.overrideRoom) continue;
    const date = dateByRunId.get(row.runId);
    if (!date) continue;
    const overrides = byDate.get(date) ?? new Map<string, string>();
    overrides.set(row.wiseSessionId, row.overrideRoom);
    byDate.set(date, overrides);
  }

  return byDate;
}

function toAssignmentSession(row: RoomCapacitySession): AssignmentSession {
  return {
    groupId: row.groupId,
    tutorDisplayName: row.tutorDisplayName,
    wiseTeacherId: row.wiseTeacherId,
    wiseTeacherUserId: row.wiseTeacherUserId,
    wiseSessionId: row.wiseSessionId,
    wiseClassId: row.wiseClassId,
    startTime: row.startTime,
    endTime: row.endTime,
    weekday: row.weekday,
    startMinute: row.startMinute,
    endMinute: row.endMinute,
    wiseStatus: row.wiseStatus,
    sessionType: row.sessionType,
    currentWiseLocation: row.currentWiseLocation,
    studentName: null,
    studentCount: row.studentCount,
    subject: row.subject,
    classType: row.classType,
    title: row.title,
  };
}

function buildProjectedSessions(
  rows: RoomCapacitySession[],
  rooms: RoomCapacityRoom[],
  overridesByDate: Map<string, Map<string, string>>,
): RoomCapacitySession[] {
  const rowsByDate = new Map<string, RoomCapacitySession[]>();
  for (const row of rows) rowsByDate.set(row.date, [...(rowsByDate.get(row.date) ?? []), row]);

  const projected: RoomCapacitySession[] = [];
  for (const [date, dayRows] of rowsByDate) {
    const result = assignClassrooms(
      dayRows.map(toAssignmentSession),
      rooms.map(toEngineRoom),
      overridesByDate.get(date) ?? new Map(),
    );
    for (const row of result.rows) {
      projected.push({
        ...row,
        id: row.wiseSessionId,
        date,
        startTime: row.startTime,
        endTime: row.endTime,
        currentWiseLocation: row.currentWiseLocation ?? null,
        assignedRoom: row.assignedRoom,
        status: row.status,
        warnings: row.warnings,
        studentCount: row.studentCount ?? null,
        subject: row.subject ?? null,
        classType: row.classType ?? null,
        title: row.title ?? null,
      });
    }
  }
  return projected;
}

export async function getRoomCapacityMonth(
  db: Database,
  input: { startDate?: string | null; endDate?: string | null } = {},
): Promise<RoomCapacityMonthResponse> {
  const defaultRange = defaultRoomCapacityRange();
  const startDate = input.startDate ?? defaultRange.startDate;
  const endDate = input.endDate ?? defaultRange.endDate;
  const activeSnapshot = await getActiveSnapshot(db);
  const rooms = (await listClassroomRooms(db)).map(toRoomCapacityRoom);
  const currentRows = await loadSessionsForRange(db, activeSnapshot.id, startDate, endDate);
  const overridesByDate = await loadLatestOverridesByDate(db, startDate, endDate);
  const projectedRows = buildProjectedSessions(currentRows, rooms, overridesByDate);

  const currentOvercaps = buildOvercapIntervals(currentRows, rooms, "current");
  const projectedOvercaps = buildOvercapIntervals(projectedRows, rooms, "projected");
  const unmatchedAllocations = findUnmatchedCurrentAllocations(currentRows, rooms);
  const noRoomRows = findProjectedNoRoomRows(projectedRows);
  const currentHeatmapCells = buildHeatmapCells(currentRows, rooms, "current", startDate, endDate);
  const projectedHeatmapCells = buildHeatmapCells(projectedRows, rooms, "projected", startDate, endDate);
  const currentDaySummaries = buildDaySummaries(
    currentRows,
    currentHeatmapCells,
    currentOvercaps,
    unmatchedAllocations,
    [],
    startDate,
    endDate,
  );
  const projectedDaySummaries = buildDaySummaries(
    projectedRows,
    projectedHeatmapCells,
    projectedOvercaps,
    [],
    noRoomRows,
    startDate,
    endDate,
  );

  return {
    range: { startDate, endDate, generatedAt: new Date().toISOString() },
    snapshotMeta: { snapshotId: activeSnapshot.id, syncedAt: activeSnapshot.createdAt.toISOString() },
    rooms,
    kpis: {
      currentOvercapIntervals: currentOvercaps.length,
      impactedRooms: new Set(currentOvercaps.map((overcap) => overcap.roomName)).size,
      projectedNoRoomSessions: noRoomRows.length,
      unmatchedCurrentAllocations: unmatchedAllocations.length,
      peakLoadRatio: Math.max(0, ...currentHeatmapCells.map((cell) => cell.loadRatio)),
    },
    current: {
      overcaps: currentOvercaps,
      unmatchedAllocations,
      heatmapCells: currentHeatmapCells,
      daySummaries: currentDaySummaries,
    },
    projected: {
      overcaps: projectedOvercaps,
      noRoomRows,
      heatmapCells: projectedHeatmapCells,
      daySummaries: projectedDaySummaries,
    },
  };
}

async function loadLatestModelRun(db: Database) {
  const [run] = await db
    .select()
    .from(schema.roomCapacityModelRuns)
    .orderBy(desc(schema.roomCapacityModelRuns.createdAt))
    .limit(1);
  return run ?? null;
}

async function loadForecastDrivers(db: Database, modelRunId: string): Promise<RoomCapacityForecastDriver[]> {
  const rows = await db
    .select()
    .from(schema.roomCapacityForecastDrivers)
    .where(eq(schema.roomCapacityForecastDrivers.modelRunId, modelRunId))
    .orderBy(schema.roomCapacityForecastDrivers.scenario, schema.roomCapacityForecastDrivers.month);
  return rows.map((row) => ({
    scenario: row.scenario,
    month: row.month,
    newPaidStudents: row.newPaidStudents,
    forecastConsumedHours: row.forecastConsumedHours,
    scheduledHours: row.scheduledHours,
    capacityUtilizationPct: row.capacityUtilizationPct,
    capacityExceeded: row.capacityExceeded,
    projectedRevenueThb: row.projectedRevenueThb,
  }));
}

async function loadDemandMix(db: Database, modelRunId: string): Promise<RoomCapacityDemandMixRow[]> {
  const rows = await db
    .select()
    .from(schema.roomCapacityDemandMix)
    .where(eq(schema.roomCapacityDemandMix.modelRunId, modelRunId))
    .orderBy(schema.roomCapacityDemandMix.weekday, schema.roomCapacityDemandMix.startMinute);
  return rows.map((row) => ({
    weekday: row.weekday,
    startMinute: row.startMinute,
    durationMinutes: row.durationMinutes,
    mode: row.mode === "online" || row.mode === "either" ? row.mode : "onsite",
    studentCount: row.studentCount,
    subject: row.subject,
    classType: row.classType,
    share: row.share,
    observedSessions: row.observedSessions,
  }));
}

async function loadPackageMix(db: Database, modelRunId: string): Promise<RoomCapacityPackageMixRow[]> {
  const rows = await db
    .select()
    .from(schema.roomCapacityPackageMix)
    .where(eq(schema.roomCapacityPackageMix.modelRunId, modelRunId))
    .orderBy(schema.roomCapacityPackageMix.share);
  return rows
    .map((row) => ({
      packageHourBucket: row.packageHourBucket,
      packageHours: row.packageHours,
      averageRevenueThb: row.averageRevenueThb,
      share: row.share,
      observedSaleCount: row.observedSaleCount,
      observedStudentCount: row.observedStudentCount,
      sourceLabel: row.sourceLabel,
    }))
    .sort((left, right) => right.share - left.share || left.packageHours - right.packageHours);
}

function missingForecastResponse(scenario: string): RoomCapacityForecastResponse {
  return {
    model: {
      status: "missing",
      modelRunId: null,
      sourceLabel: null,
      forecastStart: null,
      forecastEnd: null,
      importedAt: null,
    },
    scenario,
    scenarios: [],
    generatedAt: new Date().toISOString(),
    weekdayResults: Array.from({ length: 7 }, (_, weekday) => ({
      weekday,
      weekdayName: ["Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"][weekday],
      roomSlotFullDate: null,
      roomTutorFullDate: null,
      roomSlotReason: null,
      roomTutorReason: null,
    })),
    weekendDemandBreakpoint: null,
    weekendDemandCaptureReadiness: null,
    monthlyDrivers: [],
  };
}

export async function getRoomCapacityForecast(
  db: Database,
  input: { scenario?: string | null } = {},
): Promise<RoomCapacityForecastResponse> {
  const scenario = input.scenario || "Base";
  const modelRun = await loadLatestModelRun(db);
  if (!modelRun) return missingForecastResponse(scenario);

  const drivers = await loadForecastDrivers(db, modelRun.id);
  const scenarios = [...new Set(drivers.map((driver) => driver.scenario))].sort();
  const selectedDrivers = driversForScenario(drivers, scenario);
  const fallbackScenario = selectedDrivers.length > 0 ? scenario : (scenarios[0] ?? "Base");
  const scenarioDrivers = selectedDrivers.length > 0 ? selectedDrivers : driversForScenario(drivers, fallbackScenario);
  const lastDriverMonth = scenarioDrivers.at(-1)?.month ?? modelRun.forecastEnd;
  const seedEndDate = endOfBangkokMonth(lastDriverMonth);

  const activeSnapshot = await getActiveSnapshot(db);
  const rooms = (await listClassroomRooms(db)).map(toRoomCapacityRoom);
  const seedSessions = await loadSessionsForRange(db, activeSnapshot.id, modelRun.forecastStart, seedEndDate);
  const overridesByDate = await loadLatestOverridesByDate(db, modelRun.forecastStart, seedEndDate);
  const projectedSeedSessions = buildProjectedSessions(seedSessions, rooms, overridesByDate);
  const importedDemandMix = await loadDemandMix(db, modelRun.id);
  const packageMix = await loadPackageMix(db, modelRun.id);
  const demandMix = importedDemandMix.length > 0 ? importedDemandMix : seededDemandMixFromSchedule(seedSessions);
  const searchIndex = await ensureIndex(db);

  const weekdayResults = simulateSaturation({
    rooms,
    seedSessions,
    demandMix,
    drivers: scenarioDrivers,
    searchIndex,
  });
  const weekendDemandInput = {
    rooms,
    seedSessions: projectedSeedSessions,
    packageMix,
    drivers: scenarioDrivers,
  };
  const weekendDemandCaptureReadiness = buildWeekendDemandCaptureReadiness(weekendDemandInput);
  const weekendDemandBreakpoint = simulateWeekendDemandBreakpoint(weekendDemandInput);

  return {
    model: {
      status: "ready",
      modelRunId: modelRun.id,
      sourceLabel: modelRun.sourceLabel,
      forecastStart: modelRun.forecastStart,
      forecastEnd: modelRun.forecastEnd,
      importedAt: modelRun.createdAt.toISOString(),
    },
    scenario: fallbackScenario,
    scenarios,
    generatedAt: new Date().toISOString(),
    weekdayResults,
    weekendDemandBreakpoint,
    weekendDemandCaptureReadiness,
    monthlyDrivers: scenarioDrivers,
  };
}
