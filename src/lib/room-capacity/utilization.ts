import { and, gte, lte, sql } from "drizzle-orm";
import type { Database } from "@/lib/db";
import * as schema from "@/lib/db/schema";
import { listClassroomRooms, type ClassroomRoom } from "@/lib/classrooms/data";
import { createWiseClient } from "@/lib/wise/client";
import { fetchAllInstituteSessions } from "@/lib/wise/fetchers";
import type { WiseSession } from "@/lib/wise/types";
import { getLocalMinuteOfDay } from "@/lib/normalization/timezone";
import { bangkokDateKey, bangkokWeekday, datesBetweenBangkok, todayBangkok } from "./dates";
import { normalizeRoomLabel } from "./analysis";
import type {
  RoomUtilizationDailyRow,
  RoomUtilizationDataQuality,
  RoomUtilizationMetric,
  RoomUtilizationMonthlyRow,
  RoomUtilizationResponse,
  RoomUtilizationRoomRow,
} from "./types";

export const ROOM_UTILIZATION_HISTORY_START = "2026-03-01";
export const ROOM_UTILIZATION_OPEN_START_MINUTE = 7 * 60;
export const ROOM_UTILIZATION_OPEN_END_MINUTE = 21 * 60;
export const ROOM_UTILIZATION_OPEN_MINUTES =
  ROOM_UTILIZATION_OPEN_END_MINUTE - ROOM_UTILIZATION_OPEN_START_MINUTE;

const ISO_DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
const INSERT_CHUNK_SIZE = 500;
const COUNTED_STATUSES = new Set(["ENDED", "IN_PROGRESS", "UPCOMING"]);
const EXCLUDED_STATUSES = new Set(["CANCELLED", "CANCELED", "MISSED", "NO_SHOW"]);

export type RoomUtilizationSession = typeof schema.roomUtilizationSessions.$inferSelect;

interface RoomLookupEntry {
  name: string;
  capacity: number;
  category: "standard" | "overflow_only" | "online_only";
}

interface OverlapInterval {
  startMinute: number;
  endMinute: number;
  date: string;
  roomName: string;
}

interface SyncRow {
  wiseSessionId: string;
  startTime: Date;
  endTime: Date;
  utilizationDate: string;
  weekday: number;
  startMinute: number;
  endMinute: number;
  wiseStatus: string;
  sessionType: string | null;
  rawLocation: string | null;
  normalizedRoomLabel: string | null;
  studentCount: number | null;
  syncedAt: Date;
  updatedAt: Date;
}

export function assertUtilizationDate(value: string, label = "date"): string {
  if (!ISO_DATE_RE.test(value)) {
    throw new Error(`Invalid ${label}. Expected YYYY-MM-DD.`);
  }
  const parsed = new Date(`${value}T00:00:00+07:00`);
  if (Number.isNaN(parsed.getTime())) {
    throw new Error(`Invalid ${label}. Expected YYYY-MM-DD.`);
  }
  return value;
}

export function defaultRoomUtilizationRange(now = new Date()): { startDate: string; endDate: string } {
  return { startDate: ROOM_UTILIZATION_HISTORY_START, endDate: todayBangkok(now) };
}

export function normalizeUtilizationRoomLabel(value: string | null | undefined): string | null {
  const raw = String(value ?? "").trim();
  if (!raw) return null;
  const normalized = normalizeRoomLabel(raw);
  return normalized || null;
}

export function isCountedUtilizationStatus(value: string | null | undefined): boolean {
  return COUNTED_STATUSES.has(String(value ?? "").toUpperCase());
}

function isExcludedUtilizationStatus(value: string | null | undefined): boolean {
  const status = String(value ?? "").toUpperCase();
  return EXCLUDED_STATUSES.has(status) || !COUNTED_STATUSES.has(status);
}

function percentage(occupiedMinutes: number, availableMinutes: number): number {
  if (availableMinutes <= 0) return 0;
  return Math.round((occupiedMinutes / availableMinutes) * 1000) / 10;
}

function monthKey(date: string): string {
  return date.slice(0, 7);
}

function emptyMetric(availableMinutes = 0): RoomUtilizationMetric {
  return {
    occupiedMinutes: 0,
    availableMinutes,
    utilizationPct: 0,
    sessionCount: 0,
  };
}

function finalizeMetric<T extends RoomUtilizationMetric>(metric: T): T {
  metric.utilizationPct = percentage(metric.occupiedMinutes, metric.availableMinutes);
  return metric;
}

function clippedInterval(row: Pick<RoomUtilizationSession, "startMinute" | "endMinute">): { startMinute: number; endMinute: number; minutes: number } {
  const startMinute = Math.max(ROOM_UTILIZATION_OPEN_START_MINUTE, row.startMinute);
  const endMinute = Math.min(ROOM_UTILIZATION_OPEN_END_MINUTE, row.endMinute);
  return { startMinute, endMinute, minutes: Math.max(0, endMinute - startMinute) };
}

function activeRoomEntries(rooms: Pick<ClassroomRoom, "name" | "capacity" | "category" | "active" | "sortOrder">[]): RoomLookupEntry[] {
  return rooms
    .filter((room) => room.active)
    .sort((left, right) => left.sortOrder - right.sortOrder || left.name.localeCompare(right.name))
    .map((room) => ({
      name: room.name,
      capacity: room.capacity,
      category: room.category,
    }));
}

function roomLookup(rooms: RoomLookupEntry[]): Map<string, RoomLookupEntry> {
  return new Map(
    rooms.map((room) => [
      normalizeUtilizationRoomLabel(room.name)?.toLowerCase() ?? room.name.toLowerCase(),
      room,
    ]),
  );
}

function addQualityCounts(
  target: Pick<RoomUtilizationDataQuality, "missingLocationCount" | "missingLocationMinutes" | "unknownRoomCount" | "unknownRoomMinutes" | "excludedStatusCount" | "excludedStatusMinutes">,
  type: "missing" | "unknown" | "excluded",
  minutes: number,
): void {
  if (type === "missing") {
    target.missingLocationCount += 1;
    target.missingLocationMinutes += minutes;
  } else if (type === "unknown") {
    target.unknownRoomCount += 1;
    target.unknownRoomMinutes += minutes;
  } else {
    target.excludedStatusCount += 1;
    target.excludedStatusMinutes += minutes;
  }
}

function overlapExcessMinutes(intervals: OverlapInterval[]): number {
  const points = [...new Set(intervals.flatMap((row) => [row.startMinute, row.endMinute]))].sort((a, b) => a - b);
  let total = 0;
  for (let index = 0; index < points.length - 1; index += 1) {
    const startMinute = points[index];
    const endMinute = points[index + 1];
    const activeCount = intervals.filter((row) => row.startMinute < endMinute && startMinute < row.endMinute).length;
    if (activeCount > 1) total += (activeCount - 1) * (endMinute - startMinute);
  }
  return total;
}

export function aggregateRoomUtilization(input: {
  rows: RoomUtilizationSession[];
  rooms: Pick<ClassroomRoom, "name" | "capacity" | "category" | "active" | "sortOrder">[];
  startDate: string;
  endDate: string;
  lastSyncedAt?: Date | string | null;
  generatedAt?: Date;
}): RoomUtilizationResponse {
  const startDate = assertUtilizationDate(input.startDate, "startDate");
  const endDate = assertUtilizationDate(input.endDate, "endDate");
  if (startDate > endDate) {
    throw new Error("Invalid date range. startDate must be before or equal to endDate.");
  }

  const dates = datesBetweenBangkok(startDate, endDate);
  const activeRooms = activeRoomEntries(input.rooms);
  const activeRoomCount = activeRooms.length;
  const availablePerDay = activeRoomCount * ROOM_UTILIZATION_OPEN_MINUTES;
  const lookup = roomLookup(activeRooms);

  const daily = new Map<string, RoomUtilizationDailyRow>();
  const monthly = new Map<string, RoomUtilizationMonthlyRow>();
  const roomRows = new Map<string, RoomUtilizationRoomRow>();
  const intervalsByDateRoom = new Map<string, OverlapInterval[]>();
  const dataQuality: RoomUtilizationDataQuality = {
    missingLocationCount: 0,
    missingLocationMinutes: 0,
    unknownRoomCount: 0,
    unknownRoomMinutes: 0,
    excludedStatusCount: 0,
    excludedStatusMinutes: 0,
    overlapMinutes: 0,
  };

  for (const date of dates) {
    daily.set(date, {
      ...emptyMetric(availablePerDay),
      date,
      weekday: bangkokWeekday(date),
      missingLocationCount: 0,
      unknownRoomCount: 0,
      excludedStatusCount: 0,
      overlapMinutes: 0,
    });

    const month = monthKey(date);
    const existingMonth = monthly.get(month);
    if (existingMonth) {
      existingMonth.availableMinutes += availablePerDay;
      existingMonth.endDate = date;
    } else {
      monthly.set(month, {
        ...emptyMetric(availablePerDay),
        month,
        startDate: date,
        endDate: date,
        missingLocationCount: 0,
        unknownRoomCount: 0,
        excludedStatusCount: 0,
        overlapMinutes: 0,
      });
    }
  }

  for (const room of activeRooms) {
    roomRows.set(room.name, {
      ...emptyMetric(dates.length * ROOM_UTILIZATION_OPEN_MINUTES),
      roomName: room.name,
      capacity: room.capacity,
      category: room.category,
      overlapMinutes: 0,
    });
  }

  for (const row of input.rows) {
    const day = daily.get(row.utilizationDate);
    if (!day) continue;
    const month = monthly.get(monthKey(row.utilizationDate));
    if (!month) continue;
    const interval = clippedInterval(row);

    if (isExcludedUtilizationStatus(row.wiseStatus)) {
      addQualityCounts(dataQuality, "excluded", interval.minutes);
      day.excludedStatusCount += 1;
      month.excludedStatusCount += 1;
      continue;
    }

    if (!row.rawLocation?.trim() || !row.normalizedRoomLabel?.trim()) {
      addQualityCounts(dataQuality, "missing", interval.minutes);
      day.missingLocationCount += 1;
      month.missingLocationCount += 1;
      continue;
    }

    const room = lookup.get(row.normalizedRoomLabel.toLowerCase());
    if (!room) {
      addQualityCounts(dataQuality, "unknown", interval.minutes);
      day.unknownRoomCount += 1;
      month.unknownRoomCount += 1;
      continue;
    }

    if (interval.minutes <= 0) continue;

    day.occupiedMinutes += interval.minutes;
    day.sessionCount += 1;
    month.occupiedMinutes += interval.minutes;
    month.sessionCount += 1;
    const roomMetric = roomRows.get(room.name);
    if (roomMetric) {
      roomMetric.occupiedMinutes += interval.minutes;
      roomMetric.sessionCount += 1;
    }

    const overlapInterval = {
      startMinute: interval.startMinute,
      endMinute: interval.endMinute,
      date: row.utilizationDate,
      roomName: room.name,
    };
    const key = `${row.utilizationDate}|${room.name}`;
    intervalsByDateRoom.set(key, [...(intervalsByDateRoom.get(key) ?? []), overlapInterval]);
  }

  for (const [key, intervals] of intervalsByDateRoom) {
    const overlapMinutes = overlapExcessMinutes(intervals);
    if (overlapMinutes <= 0) continue;
    const [date, roomName] = key.split("|");
    dataQuality.overlapMinutes += overlapMinutes;
    const day = daily.get(date);
    if (day) day.overlapMinutes += overlapMinutes;
    const month = monthly.get(monthKey(date));
    if (month) month.overlapMinutes += overlapMinutes;
    const room = roomRows.get(roomName);
    if (room) room.overlapMinutes += overlapMinutes;
  }

  const summary: RoomUtilizationResponse["summary"] = finalizeMetric({
    ...emptyMetric(dates.length * availablePerDay),
    activeRoomCount,
  });

  for (const row of daily.values()) {
    summary.occupiedMinutes += row.occupiedMinutes;
    summary.sessionCount += row.sessionCount;
    finalizeMetric(row);
  }
  finalizeMetric(summary);

  return {
    range: {
      startDate,
      endDate,
      generatedAt: (input.generatedAt ?? new Date()).toISOString(),
      openStartMinute: ROOM_UTILIZATION_OPEN_START_MINUTE,
      openEndMinute: ROOM_UTILIZATION_OPEN_END_MINUTE,
    },
    lastSyncedAt: input.lastSyncedAt ? new Date(input.lastSyncedAt).toISOString() : null,
    summary,
    daily: [...daily.values()],
    monthly: [...monthly.values()].map(finalizeMetric),
    rooms: [...roomRows.values()]
      .map(finalizeMetric)
      .sort((left, right) => right.utilizationPct - left.utilizationPct || left.roomName.localeCompare(right.roomName)),
    dataQuality,
  };
}

export function wiseSessionToUtilizationRow(session: WiseSession, syncedAt = new Date()): SyncRow | null {
  if (!session._id || !session.scheduledStartTime || !session.scheduledEndTime) return null;
  const startTime = new Date(session.scheduledStartTime);
  const endTime = new Date(session.scheduledEndTime);
  if (Number.isNaN(startTime.getTime()) || Number.isNaN(endTime.getTime())) return null;

  const utilizationDate = bangkokDateKey(startTime);
  const endDate = bangkokDateKey(endTime);
  const rawLocation = String(session.location ?? "").trim() || null;
  return {
    wiseSessionId: session._id,
    startTime,
    endTime,
    utilizationDate,
    weekday: bangkokWeekday(utilizationDate),
    startMinute: getLocalMinuteOfDay(startTime),
    endMinute: endDate === utilizationDate ? getLocalMinuteOfDay(endTime) : 24 * 60,
    wiseStatus: session.meetingStatus ?? "UNKNOWN",
    sessionType: session.type ?? null,
    rawLocation,
    normalizedRoomLabel: normalizeUtilizationRoomLabel(rawLocation),
    studentCount: typeof session.studentCount === "number" ? session.studentCount : null,
    syncedAt,
    updatedAt: syncedAt,
  };
}

export async function syncRoomUtilizationSessions(
  db: Database,
  input: { startDate?: string; syncedAt?: Date } = {},
): Promise<{ fetchedCount: number; storedCount: number; startDate: string; syncedAt: string }> {
  const startDate = assertUtilizationDate(input.startDate ?? ROOM_UTILIZATION_HISTORY_START, "startDate");
  const syncedAt = input.syncedAt ?? new Date();
  const instituteId = process.env.WISE_INSTITUTE_ID;
  if (!instituteId) throw new Error("WISE_INSTITUTE_ID is required to sync room utilization");

  const sessions = await fetchAllInstituteSessions(createWiseClient(), instituteId);
  const rows = sessions
    .map((session) => wiseSessionToUtilizationRow(session, syncedAt))
    .filter((row): row is SyncRow => row !== null && row.utilizationDate >= startDate);

  for (let index = 0; index < rows.length; index += INSERT_CHUNK_SIZE) {
    const chunk = rows.slice(index, index + INSERT_CHUNK_SIZE);
    await db
      .insert(schema.roomUtilizationSessions)
      .values(chunk)
      .onConflictDoUpdate({
        target: schema.roomUtilizationSessions.wiseSessionId,
        set: {
          startTime: sql`excluded.start_time`,
          endTime: sql`excluded.end_time`,
          utilizationDate: sql`excluded.utilization_date`,
          weekday: sql`excluded.weekday`,
          startMinute: sql`excluded.start_minute`,
          endMinute: sql`excluded.end_minute`,
          wiseStatus: sql`excluded.wise_status`,
          sessionType: sql`excluded.session_type`,
          rawLocation: sql`excluded.raw_location`,
          normalizedRoomLabel: sql`excluded.normalized_room_label`,
          studentCount: sql`excluded.student_count`,
          syncedAt: sql`excluded.synced_at`,
          updatedAt: syncedAt,
        },
      });
  }

  return {
    fetchedCount: sessions.length,
    storedCount: rows.length,
    startDate,
    syncedAt: syncedAt.toISOString(),
  };
}

export async function getRoomUtilization(
  db: Database,
  input: { startDate?: string | null; endDate?: string | null } = {},
): Promise<RoomUtilizationResponse> {
  const defaults = defaultRoomUtilizationRange();
  const startDate = assertUtilizationDate(input.startDate ?? defaults.startDate, "startDate");
  const endDate = assertUtilizationDate(input.endDate ?? defaults.endDate, "endDate");
  if (startDate > endDate) {
    throw new Error("Invalid date range. startDate must be before or equal to endDate.");
  }

  const [rows, rooms, lastSyncRows] = await Promise.all([
    db
      .select()
      .from(schema.roomUtilizationSessions)
      .where(and(
        gte(schema.roomUtilizationSessions.utilizationDate, startDate),
        lte(schema.roomUtilizationSessions.utilizationDate, endDate),
      )),
    listClassroomRooms(db),
    db
      .select({ lastSyncedAt: sql<Date | null>`max(${schema.roomUtilizationSessions.syncedAt})` })
      .from(schema.roomUtilizationSessions),
  ]);

  return aggregateRoomUtilization({
    rows,
    rooms,
    startDate,
    endDate,
    lastSyncedAt: lastSyncRows[0]?.lastSyncedAt ?? null,
  });
}
