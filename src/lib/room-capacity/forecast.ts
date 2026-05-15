import type { SearchIndex, IndexedTutorGroup } from "@/lib/search";
import {
  addBangkokDays,
  bangkokDateKey,
  bangkokDateStartUtc,
  bangkokWeekday,
  datesBetweenBangkok,
  monthStart,
  nextMonthStart,
  weekdayName,
} from "./dates";
import { classifySessionMode, normalizeRoomLabel, sessionLoad } from "./analysis";
import type {
  RoomCapacityDemandMixRow,
  RoomCapacityForecastDriver,
  RoomCapacityRoom,
  RoomCapacitySession,
  WeekdaySaturationResult,
} from "./types";

interface OccupancyInterval {
  date: string;
  roomName: string;
  startMinute: number;
  endMinute: number;
}

interface TutorInterval {
  date: string;
  startMinute: number;
  endMinute: number;
}

export interface SimulationDemand {
  date: string;
  weekday: number;
  startMinute: number;
  endMinute: number;
  mode: "online" | "onsite" | "either";
  studentCount: number;
  subject: string | null;
  classType: string | null;
}

export interface SaturationSimulationInput {
  rooms: RoomCapacityRoom[];
  seedSessions: RoomCapacitySession[];
  demandMix: RoomCapacityDemandMixRow[];
  drivers: RoomCapacityForecastDriver[];
  searchIndex?: SearchIndex | null;
}

function overlaps(aStart: number, aEnd: number, bStart: number, bEnd: number): boolean {
  return aStart < bEnd && bStart < aEnd;
}

function roomCanHost(room: RoomCapacityRoom, demand: Pick<SimulationDemand, "studentCount" | "mode">): boolean {
  if (!room.active) return false;
  if (room.capacity < demand.studentCount) return false;
  if (room.category === "online_only" && demand.mode === "onsite") return false;
  return true;
}

function buildSeedOccupancy(rows: RoomCapacitySession[], rooms: RoomCapacityRoom[]): Map<string, OccupancyInterval[]> {
  const roomByName = new Map(rooms.map((room) => [normalizeRoomLabel(room.name).toLowerCase(), room]));
  const occupancy = new Map<string, OccupancyInterval[]>();

  for (const row of rows) {
    const roomName = normalizeRoomLabel(row.currentWiseLocation).toLowerCase();
    const room = roomByName.get(roomName);
    if (!room) continue;
    const key = `${row.date}|${room.name}`;
    occupancy.set(key, [
      ...(occupancy.get(key) ?? []),
      {
        date: row.date,
        roomName: room.name,
        startMinute: row.startMinute,
        endMinute: row.endMinute,
      },
    ]);
  }

  return occupancy;
}

function placeRoom(
  demand: SimulationDemand,
  rooms: RoomCapacityRoom[],
  occupancy: Map<string, OccupancyInterval[]>,
): string | null {
  const candidates = rooms
    .filter((room) => roomCanHost(room, demand))
    .sort((left, right) => left.capacity - right.capacity || left.sortOrder - right.sortOrder);

  for (const room of candidates) {
    const key = `${demand.date}|${room.name}`;
    const existing = occupancy.get(key) ?? [];
    if (existing.some((interval) => overlaps(demand.startMinute, demand.endMinute, interval.startMinute, interval.endMinute))) {
      continue;
    }
    occupancy.set(key, [...existing, { date: demand.date, roomName: room.name, startMinute: demand.startMinute, endMinute: demand.endMinute }]);
    return room.name;
  }

  return null;
}

function dateRangeForMonth(month: string): string[] {
  const start = monthStart(month);
  const next = nextMonthStart(month);
  const end = addBangkokDays(next, -1);
  return datesBetweenBangkok(start, end);
}

export function expandDemandForMonth(
  driver: RoomCapacityForecastDriver,
  demandMix: RoomCapacityDemandMixRow[],
): SimulationDemand[] {
  const incrementalHours = Math.max(0, driver.forecastConsumedHours - driver.scheduledHours);
  if (incrementalHours <= 0 || demandMix.length === 0) return [];

  const monthDates = dateRangeForMonth(driver.month);
  const demands: SimulationDemand[] = [];

  for (const mix of demandMix) {
    const targetMinutes = incrementalHours * 60 * mix.share;
    const targetCount = Math.floor(targetMinutes / Math.max(1, mix.durationMinutes));
    if (targetCount <= 0) continue;

    const candidateDates = monthDates.filter((date) => bangkokWeekday(date) === mix.weekday);
    if (candidateDates.length === 0) continue;

    for (let index = 0; index < targetCount; index += 1) {
      const date = candidateDates[index % candidateDates.length];
      demands.push({
        date,
        weekday: mix.weekday,
        startMinute: mix.startMinute,
        endMinute: mix.startMinute + mix.durationMinutes,
        mode: mix.mode,
        studentCount: Math.max(1, mix.studentCount),
        subject: mix.subject,
        classType: mix.classType,
      });
    }
  }

  return demands.sort((left, right) =>
    left.date.localeCompare(right.date) ||
    left.startMinute - right.startMinute ||
    right.studentCount - left.studentCount,
  );
}

function hasWindow(group: IndexedTutorGroup, demand: SimulationDemand): boolean {
  return group.availabilityWindows.some((window) => {
    if (window.weekday !== demand.weekday) return false;
    if (window.startMinute > demand.startMinute || window.endMinute < demand.endMinute) return false;
    if (demand.mode !== "either" && window.modality !== "both" && window.modality !== demand.mode) return false;
    return true;
  });
}

function matchesSubject(group: IndexedTutorGroup, subject: string | null): boolean {
  if (!subject) return group.qualifications.length > 0;
  return group.qualifications.some((qualification) => qualification.subject.toLowerCase() === subject.toLowerCase());
}

function isTutorBlocked(group: IndexedTutorGroup, demand: SimulationDemand, added: TutorInterval[]): boolean {
  if (added.some((interval) => interval.date === demand.date && overlaps(demand.startMinute, demand.endMinute, interval.startMinute, interval.endMinute))) {
    return true;
  }
  if (group.sessionBlocks.some((block) => {
    const blockDate = bangkokDateKey(block.startTime);
    return block.isBlocking && blockDate === demand.date && overlaps(demand.startMinute, demand.endMinute, block.startMinute, block.endMinute);
  })) {
    return true;
  }

  const demandStart = new Date(bangkokDateStartUtc(demand.date).getTime() + demand.startMinute * 60_000);
  const demandEnd = new Date(bangkokDateStartUtc(demand.date).getTime() + demand.endMinute * 60_000);
  return group.leaves.some((leave) => leave.startTime < demandEnd && leave.endTime > demandStart);
}

function placeTutor(
  demand: SimulationDemand,
  searchIndex: SearchIndex | null | undefined,
  addedByTutor: Map<string, TutorInterval[]>,
): string | null {
  if (!searchIndex) return null;

  const candidates = searchIndex.tutorGroups
    .filter((group) => group.dataIssues.length === 0)
    .filter((group) => group.supportedModes.length > 0)
    .filter((group) => demand.mode === "either" || group.supportedModes.includes(demand.mode))
    .filter((group) => hasWindow(group, demand))
    .filter((group) => matchesSubject(group, demand.subject))
    .sort((left, right) => left.displayName.localeCompare(right.displayName));

  for (const group of candidates) {
    const added = addedByTutor.get(group.id) ?? [];
    if (isTutorBlocked(group, demand, added)) continue;
    addedByTutor.set(group.id, [...added, { date: demand.date, startMinute: demand.startMinute, endMinute: demand.endMinute }]);
    return group.id;
  }

  return null;
}

export function simulateSaturation(input: SaturationSimulationInput): WeekdaySaturationResult[] {
  const roomOnlyOccupancy = buildSeedOccupancy(input.seedSessions, input.rooms);
  const roomTutorOccupancy = buildSeedOccupancy(input.seedSessions, input.rooms);
  const addedByTutor = new Map<string, TutorInterval[]>();
  const results = new Map<number, WeekdaySaturationResult>();
  for (let weekday = 0; weekday < 7; weekday += 1) {
    results.set(weekday, {
      weekday,
      weekdayName: weekdayName(weekday),
      roomSlotFullDate: null,
      roomTutorFullDate: null,
      roomSlotReason: null,
      roomTutorReason: null,
    });
  }

  const drivers = [...input.drivers].sort((left, right) => left.month.localeCompare(right.month));
  for (const driver of drivers) {
    for (const demand of expandDemandForMonth(driver, input.demandMix)) {
      const result = results.get(demand.weekday)!;

      if (!result.roomSlotFullDate) {
        const placedRoom = placeRoom(demand, input.rooms, roomOnlyOccupancy);
        if (!placedRoom) {
          result.roomSlotFullDate = demand.date;
          result.roomSlotReason = `${demand.studentCount}-student ${demand.mode} class at ${demand.startMinute}`;
        }
      }

      if (!result.roomTutorFullDate) {
        const placedRoom = placeRoom(demand, input.rooms, roomTutorOccupancy);
        const placedTutor = placedRoom ? placeTutor(demand, input.searchIndex, addedByTutor) : null;
        if (!placedRoom || !placedTutor) {
          result.roomTutorFullDate = demand.date;
          result.roomTutorReason = !placedRoom ? "No room slot" : "No qualified available tutor";
        }
      }
    }
  }

  return [...results.values()];
}

export function driversForScenario(
  drivers: RoomCapacityForecastDriver[],
  scenario: string,
): RoomCapacityForecastDriver[] {
  return drivers.filter((driver) => driver.scenario.toLowerCase() === scenario.toLowerCase());
}

export function seededDemandMixFromSchedule(rows: RoomCapacitySession[]): RoomCapacityDemandMixRow[] {
  const onsiteRows = rows.filter((row) => {
    const mode = classifySessionMode(row.sessionType, row.currentWiseLocation);
    return mode === "onsite" || normalizeRoomLabel(row.currentWiseLocation).length > 0;
  });
  const totalMinutes = onsiteRows.reduce((sum, row) => sum + Math.max(0, row.endMinute - row.startMinute), 0);
  if (totalMinutes <= 0) return [];

  const grouped = new Map<string, RoomCapacityDemandMixRow & { minutes: number }>();
  for (const row of onsiteRows) {
    const durationMinutes = Math.max(30, row.endMinute - row.startMinute);
    const mode = "onsite" as const;
    const studentCount = sessionLoad(row);
    const key = [row.weekday, row.startMinute, durationMinutes, mode, studentCount, row.subject ?? "", row.classType ?? ""].join("|");
    const existing = grouped.get(key) ?? {
      weekday: row.weekday,
      startMinute: row.startMinute,
      durationMinutes,
      mode,
      studentCount,
      subject: row.subject ?? null,
      classType: row.classType ?? null,
      share: 0,
      observedSessions: 0,
      minutes: 0,
    };
    existing.observedSessions += 1;
    existing.minutes += durationMinutes;
    grouped.set(key, existing);
  }

  return [...grouped.values()]
    .map(({ minutes, ...row }) => ({ ...row, share: minutes / totalMinutes }))
    .sort((left, right) => right.share - left.share);
}
