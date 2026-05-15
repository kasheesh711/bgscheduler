import { REMOTE_NO_ROOM_NEEDED } from "@/lib/classrooms/assignment-engine";
import { NO_ROOM_AVAILABLE } from "@/lib/classrooms/rooms";
import { bangkokWeekday, datesBetweenBangkok } from "./dates";
import type {
  RoomCapacityDaySummary,
  RoomCapacityDemandMixRow,
  RoomCapacityHeatmapCell,
  RoomCapacityNoRoomRow,
  RoomCapacityOvercapInterval,
  RoomCapacityRoom,
  RoomCapacitySession,
  RoomCapacitySource,
  RoomCapacityUnmatchedAllocation,
} from "./types";

export const ROOM_CAPACITY_BIN_MINUTES = 30;

export function normalizeRoomLabel(value: string | null | undefined): string {
  return String(value ?? "")
    .replace("📺", "")
    .replace(":television:", "")
    .replace(/\(Lab\)/gi, "")
    .replace(/\s+\(TV\)\s*$/i, "")
    .replace(/\s+/g, " ")
    .trim();
}

export function classLabel(row: Pick<RoomCapacitySession, "subject" | "classType" | "title">): string {
  return row.subject || row.classType || row.title || "Untitled class";
}

export function sessionLoad(row: Pick<RoomCapacitySession, "studentCount">): number {
  const count = Number(row.studentCount);
  return Number.isFinite(count) && count > 0 ? count : 1;
}

function activeRooms(rooms: RoomCapacityRoom[]): RoomCapacityRoom[] {
  return rooms
    .filter((room) => room.active)
    .sort((left, right) => left.sortOrder - right.sortOrder || left.name.localeCompare(right.name));
}

function roomLookup(rooms: RoomCapacityRoom[]): Map<string, RoomCapacityRoom> {
  return new Map(activeRooms(rooms).map((room) => [normalizeRoomLabel(room.name).toLowerCase(), room]));
}

function isRemoteRoom(row: RoomCapacitySession): boolean {
  return row.status === "remote" || row.assignedRoom === REMOTE_NO_ROOM_NEEDED;
}

function resolvedRoomForSession(
  row: RoomCapacitySession,
  roomsByName: Map<string, RoomCapacityRoom>,
  source: RoomCapacitySource,
): RoomCapacityRoom | null {
  if (source === "projected") {
    if (isRemoteRoom(row)) return null;
    if (!row.assignedRoom || row.assignedRoom === NO_ROOM_AVAILABLE) return null;
    return roomsByName.get(normalizeRoomLabel(row.assignedRoom).toLowerCase()) ?? null;
  }

  if (!row.currentWiseLocation) return null;
  return roomsByName.get(normalizeRoomLabel(row.currentWiseLocation).toLowerCase()) ?? null;
}

export function findUnmatchedCurrentAllocations(
  rows: RoomCapacitySession[],
  rooms: RoomCapacityRoom[],
): RoomCapacityUnmatchedAllocation[] {
  const roomsByName = roomLookup(rooms);
  return rows
    .filter((row) => !row.currentWiseLocation || !roomsByName.has(normalizeRoomLabel(row.currentWiseLocation).toLowerCase()))
    .map((row) => ({
      id: row.id,
      date: row.date,
      weekday: row.weekday,
      startMinute: row.startMinute,
      endMinute: row.endMinute,
      tutorDisplayName: row.tutorDisplayName,
      location: row.currentWiseLocation ?? null,
      reason: row.currentWiseLocation ? "unknown_room" : "missing_location",
      classLabel: classLabel(row),
    }));
}

export function findProjectedNoRoomRows(rows: RoomCapacitySession[]): RoomCapacityNoRoomRow[] {
  return rows
    .filter((row) => row.status === "no_room" || row.assignedRoom === NO_ROOM_AVAILABLE)
    .map((row) => ({
      id: row.id,
      date: row.date,
      weekday: row.weekday,
      startMinute: row.startMinute,
      endMinute: row.endMinute,
      tutorDisplayName: row.tutorDisplayName,
      assignedRoom: row.assignedRoom ?? NO_ROOM_AVAILABLE,
      warnings: row.warnings ?? [],
      classLabel: classLabel(row),
      subject: row.subject ?? null,
      classType: row.classType ?? null,
    }));
}

function rowsByDateRoom(
  rows: RoomCapacitySession[],
  rooms: RoomCapacityRoom[],
  source: RoomCapacitySource,
): Map<string, { date: string; weekday: number; room: RoomCapacityRoom; rows: RoomCapacitySession[] }> {
  const roomsByName = roomLookup(rooms);
  const grouped = new Map<string, { date: string; weekday: number; room: RoomCapacityRoom; rows: RoomCapacitySession[] }>();

  for (const row of rows) {
    const room = resolvedRoomForSession(row, roomsByName, source);
    if (!room) continue;
    const key = `${row.date}|${room.name}`;
    const group = grouped.get(key) ?? { date: row.date, weekday: row.weekday, room, rows: [] };
    group.rows.push(row);
    grouped.set(key, group);
  }

  return grouped;
}

export function buildOvercapIntervals(
  rows: RoomCapacitySession[],
  rooms: RoomCapacityRoom[],
  source: RoomCapacitySource,
): RoomCapacityOvercapInterval[] {
  const intervals: RoomCapacityOvercapInterval[] = [];
  for (const group of rowsByDateRoom(rows, rooms, source).values()) {
    const points = [...new Set(group.rows.flatMap((row) => [row.startMinute, row.endMinute]))].sort((a, b) => a - b);
    for (let index = 0; index < points.length - 1; index += 1) {
      const startMinute = points[index];
      const endMinute = points[index + 1];
      if (startMinute === endMinute) continue;
      const activeRows = group.rows.filter((row) => row.startMinute < endMinute && startMinute < row.endMinute);
      const load = activeRows.reduce((sum, row) => sum + sessionLoad(row), 0);
      if (load <= group.room.capacity) continue;

      intervals.push({
        id: `${source}-${group.date}-${group.room.name}-${startMinute}-${endMinute}`,
        source,
        date: group.date,
        weekday: group.weekday,
        roomName: group.room.name,
        startMinute,
        endMinute,
        load,
        capacity: group.room.capacity,
        sessionCount: activeRows.length,
        tutors: [...new Set(activeRows.map((row) => row.tutorDisplayName))],
        classes: [...new Set(activeRows.map(classLabel))],
      });
    }
  }

  return intervals.sort((left, right) =>
    left.date.localeCompare(right.date) ||
    left.startMinute - right.startMinute ||
    left.roomName.localeCompare(right.roomName),
  );
}

export function buildHeatmapCells(
  rows: RoomCapacitySession[],
  rooms: RoomCapacityRoom[],
  source: RoomCapacitySource,
  startDate: string,
  endDate: string,
  binMinutes = ROOM_CAPACITY_BIN_MINUTES,
): RoomCapacityHeatmapCell[] {
  const cells: RoomCapacityHeatmapCell[] = [];
  const active = activeRooms(rooms);
  const roomsByName = roomLookup(rooms);
  const dates = datesBetweenBangkok(startDate, endDate);

  for (const date of dates) {
    const weekday = bangkokWeekday(date);
    const dayRows = rows.filter((row) => row.date === date);
    for (const room of active) {
      for (let startMinute = 7 * 60; startMinute < 21 * 60; startMinute += binMinutes) {
        const endMinute = Math.min(startMinute + binMinutes, 21 * 60);
        const activeRows = dayRows.filter((row) => {
          const resolvedRoom = resolvedRoomForSession(row, roomsByName, source);
          return resolvedRoom?.name === room.name && row.startMinute < endMinute && startMinute < row.endMinute;
        });
        const load = activeRows.reduce((sum, row) => sum + sessionLoad(row), 0);
        const loadRatio = room.capacity > 0 ? load / room.capacity : 0;
        cells.push({
          id: `${source}-${date}-${room.name}-${startMinute}`,
          source,
          date,
          weekday,
          roomName: room.name,
          startMinute,
          endMinute,
          load,
          capacity: room.capacity,
          loadRatio,
          sessionCount: activeRows.length,
          status:
            load === 0
              ? "empty"
              : load > room.capacity
                ? "over_capacity"
                : load === room.capacity
                  ? "full"
                  : "occupied",
        });
      }
    }
  }

  return cells;
}

export function buildDaySummaries(
  rows: RoomCapacitySession[],
  heatmapCells: RoomCapacityHeatmapCell[],
  overcaps: RoomCapacityOvercapInterval[],
  unmatched: RoomCapacityUnmatchedAllocation[],
  noRoomRows: RoomCapacityNoRoomRow[],
  startDate: string,
  endDate: string,
): RoomCapacityDaySummary[] {
  return datesBetweenBangkok(startDate, endDate).map((date) => {
    const dayRows = rows.filter((row) => row.date === date);
    const dayCells = heatmapCells.filter((cell) => cell.date === date);
    const peak = dayCells.reduce<RoomCapacityHeatmapCell | null>(
      (best, cell) => (!best || cell.loadRatio > best.loadRatio ? cell : best),
      null,
    );
    return {
      date,
      weekday: bangkokWeekday(date),
      totalSessions: dayRows.length,
      physicalSessions: dayRows.filter((row) => row.status !== "remote").length,
      remoteSessions: dayRows.filter((row) => row.status === "remote").length,
      overcapIntervals: overcaps.filter((row) => row.date === date).length,
      projectedNoRoom: noRoomRows.filter((row) => row.date === date).length,
      unmatchedAllocations: unmatched.filter((row) => row.date === date).length,
      peakLoadRatio: peak?.loadRatio ?? 0,
      peakLoad: peak?.load ?? 0,
      peakCapacity: peak?.capacity ?? 0,
    };
  });
}

export function buildDemandMixFromSessions(rows: RoomCapacitySession[]): RoomCapacityDemandMixRow[] {
  const eligible = rows.filter((row) => {
    const mode = classifySessionMode(row.sessionType, row.currentWiseLocation ?? row.assignedRoom);
    return (mode === "onsite" || normalizeRoomLabel(row.currentWiseLocation ?? row.assignedRoom).length > 0) && row.endMinute > row.startMinute;
  });
  if (eligible.length === 0) return [];

  const grouped = new Map<string, RoomCapacityDemandMixRow>();
  for (const row of eligible) {
    const durationMinutes = row.endMinute - row.startMinute;
    const studentCount = Math.max(1, sessionLoad(row));
    const subject = row.subject ?? null;
    const classType = row.classType ?? null;
    const key = [
      row.weekday,
      row.startMinute,
      durationMinutes,
      "onsite",
      studentCount,
      subject ?? "",
      classType ?? "",
    ].join("|");
    const existing = grouped.get(key) ?? {
      weekday: row.weekday,
      startMinute: row.startMinute,
      durationMinutes,
      mode: "onsite",
      studentCount,
      subject,
      classType,
      share: 0,
      observedSessions: 0,
    };
    existing.observedSessions += 1;
    grouped.set(key, existing);
  }

  const total = [...grouped.values()].reduce((sum, row) => sum + row.observedSessions, 0);
  return [...grouped.values()]
    .map((row) => ({ ...row, share: total > 0 ? row.observedSessions / total : 0 }))
    .sort((left, right) => right.share - left.share || left.weekday - right.weekday || left.startMinute - right.startMinute);
}

export function classifySessionMode(
  sessionType: string | null | undefined,
  location?: string | null,
): "online" | "onsite" | "either" {
  const evidence = `${sessionType ?? ""} ${location ?? ""}`.toLowerCase();
  if (evidence.includes("offline") || evidence.includes("on-site") || evidence.includes("onsite")) return "onsite";
  if (evidence.includes("online") || evidence.includes("live session")) return "online";
  return "either";
}
