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
  RoomCapacityPackageMixRow,
  RoomCapacityRoom,
  RoomCapacitySession,
  WeekendDemandBreakpoint,
  WeekendDemandBreakpointResult,
  WeekendDemandSlotSummary,
  WeekdaySaturationResult,
} from "./types";

interface OccupancyInterval {
  date: string;
  roomName: string;
  startMinute: number;
  endMinute: number;
}

interface ReservedInterval extends OccupancyInterval {
  capacity: number;
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

export interface WeekendDemandBreakpointInput {
  rooms: RoomCapacityRoom[];
  seedSessions: RoomCapacitySession[];
  packageMix: RoomCapacityPackageMixRow[];
  drivers: RoomCapacityForecastDriver[];
  maxExtrapolatedMonths?: number;
}

interface WeekendDemandRecord {
  month: string;
  weekday: number;
  startMinute: number;
  durationMinutes: number;
  studentCount: number;
  packageHours: number;
  revenueThb: number;
  packageHourBucket: string;
  sequence: number;
}

interface MutableMonthStats {
  month: string;
  capturedRevenueThb: number;
  lostRevenueThb: number;
  capturedStudents: number;
  lostStudents: number;
  lostSlots: Map<string, WeekendDemandSlotSummary>;
}

const OPEN_START_MINUTE = 7 * 60;
const OPEN_END_MINUTE = 21 * 60;
const WEEKEND_WEEKDAYS = [6, 0];

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
    const roomName = normalizeRoomLabel(row.currentWiseLocation ?? row.assignedRoom).toLowerCase();
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

function activePhysicalRooms(rooms: RoomCapacityRoom[]): RoomCapacityRoom[] {
  return rooms
    .filter((room) => room.active && room.category !== "online_only")
    .sort((left, right) => left.capacity - right.capacity || left.sortOrder - right.sortOrder || left.name.localeCompare(right.name));
}

function roomByNormalizedName(rooms: RoomCapacityRoom[]): Map<string, RoomCapacityRoom> {
  return new Map(rooms.map((room) => [normalizeRoomLabel(room.name).toLowerCase(), room]));
}

function resolvedPhysicalRoom(
  row: RoomCapacitySession,
  roomsByName: Map<string, RoomCapacityRoom>,
): RoomCapacityRoom | null {
  for (const label of [row.currentWiseLocation, row.assignedRoom]) {
    const normalized = normalizeRoomLabel(label).toLowerCase();
    if (!normalized) continue;
    const room = roomsByName.get(normalized);
    if (room?.active && room.category !== "online_only") return room;
  }
  return null;
}

function onsiteStudentMinutes(row: RoomCapacitySession, roomsByName: Map<string, RoomCapacityRoom>): number {
  if (row.endMinute <= row.startMinute) return 0;
  const mode = classifySessionMode(row.sessionType, row.currentWiseLocation ?? row.assignedRoom);
  if (mode === "online") return 0;
  if (!resolvedPhysicalRoom(row, roomsByName)) return 0;
  return (row.endMinute - row.startMinute) * sessionLoad(row);
}

function buildWeekendSeedOccupancy(rows: RoomCapacitySession[], rooms: RoomCapacityRoom[]): Map<string, ReservedInterval[]> {
  const roomsByName = roomByNormalizedName(rooms);
  const occupancy = new Map<string, ReservedInterval[]>();

  for (const row of rows) {
    const room = resolvedPhysicalRoom(row, roomsByName);
    if (!room || row.endMinute <= row.startMinute) continue;
    const key = `${row.date}|${room.name}`;
    occupancy.set(key, [
      ...(occupancy.get(key) ?? []),
      {
        date: row.date,
        roomName: room.name,
        startMinute: row.startMinute,
        endMinute: row.endMinute,
        capacity: room.capacity,
      },
    ]);
  }

  return occupancy;
}

function dateRangeForMonth(month: string): string[] {
  const start = monthStart(month);
  const next = nextMonthStart(month);
  const end = addBangkokDays(next, -1);
  return datesBetweenBangkok(start, end);
}

function roundMoney(value: number): number {
  return Math.round(value);
}

function roundPct(value: number): number {
  return Math.round(value * 1000) / 1000;
}

export function largestRemainderCounts(totalCount: number, shares: number[]): number[] {
  const count = Math.max(0, Math.round(totalCount));
  if (count === 0 || shares.length === 0) return shares.map(() => 0);
  const totalShare = shares.reduce((sum, share) => sum + Math.max(0, share), 0);
  if (totalShare <= 0) return shares.map(() => 0);

  const targets = shares.map((share, index) => {
    const raw = count * (Math.max(0, share) / totalShare);
    return { index, floor: Math.floor(raw), remainder: raw - Math.floor(raw) };
  });
  let assigned = targets.reduce((sum, target) => sum + target.floor, 0);
  const counts = targets.map((target) => target.floor);

  for (const target of [...targets].sort((left, right) => right.remainder - left.remainder || left.index - right.index)) {
    if (assigned >= count) break;
    counts[target.index] += 1;
    assigned += 1;
  }

  return counts;
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

export function weekendPreferenceDistributionFromSchedule(
  rows: RoomCapacitySession[],
  rooms: RoomCapacityRoom[],
): { preferenceMix: RoomCapacityDemandMixRow[]; weekendDemandShare: number } {
  const roomsByName = roomByNormalizedName(rooms);
  const onsiteTotalMinutes = rows.reduce((sum, row) => sum + onsiteStudentMinutes(row, roomsByName), 0);
  const grouped = new Map<string, RoomCapacityDemandMixRow & { weightedMinutes: number }>();

  for (const row of rows) {
    if (!WEEKEND_WEEKDAYS.includes(row.weekday)) continue;
    const weightedMinutes = onsiteStudentMinutes(row, roomsByName);
    if (weightedMinutes <= 0) continue;
    const durationMinutes = row.endMinute - row.startMinute;
    const key = [
      row.weekday,
      row.startMinute,
      durationMinutes,
      "onsite",
      row.subject ?? "",
      row.classType ?? "",
    ].join("|");
    const existing = grouped.get(key) ?? {
      weekday: row.weekday,
      startMinute: row.startMinute,
      durationMinutes,
      mode: "onsite",
      studentCount: 1,
      subject: row.subject ?? null,
      classType: row.classType ?? null,
      share: 0,
      observedSessions: 0,
      weightedMinutes: 0,
    };
    existing.observedSessions += 1;
    existing.weightedMinutes += weightedMinutes;
    grouped.set(key, existing);
  }

  const weekendMinutes = [...grouped.values()].reduce((sum, row) => sum + row.weightedMinutes, 0);
  const preferenceMix = [...grouped.values()]
    .map(({ weightedMinutes, ...row }) => ({
      ...row,
      share: weekendMinutes > 0 ? weightedMinutes / weekendMinutes : 0,
    }))
    .sort((left, right) =>
      right.share - left.share ||
      left.weekday - right.weekday ||
      left.startMinute - right.startMinute ||
      left.durationMinutes - right.durationMinutes,
    );

  return {
    preferenceMix,
    weekendDemandShare: onsiteTotalMinutes > 0 ? weekendMinutes / onsiteTotalMinutes : 0,
  };
}

function repeatedByCounts<T>(rows: T[], counts: number[]): T[] {
  return rows.flatMap((row, index) => Array.from({ length: counts[index] ?? 0 }, () => row));
}

export function expandWeekendDemandForMonth(
  driver: RoomCapacityForecastDriver,
  packageMix: RoomCapacityPackageMixRow[],
  preferenceMix: RoomCapacityDemandMixRow[],
  weekendDemandShare: number,
): WeekendDemandRecord[] {
  const studentCount = Math.max(0, Math.round(driver.newPaidStudents * weekendDemandShare));
  if (studentCount === 0 || packageMix.length === 0 || preferenceMix.length === 0) return [];

  const sortedPackages = [...packageMix].sort((left, right) => right.share - left.share || left.packageHours - right.packageHours);
  const sortedPreferences = [...preferenceMix].sort((left, right) => right.share - left.share || left.weekday - right.weekday || left.startMinute - right.startMinute);
  const packageRecords = repeatedByCounts(sortedPackages, largestRemainderCounts(studentCount, sortedPackages.map((row) => row.share)));
  const preferenceRecords = repeatedByCounts(sortedPreferences, largestRemainderCounts(studentCount, sortedPreferences.map((row) => row.share)));
  const count = Math.min(packageRecords.length, preferenceRecords.length);

  return Array.from({ length: count }, (_, index) => {
    const packageRow = packageRecords[index];
    const preference = preferenceRecords[index];
    return {
      month: driver.month,
      weekday: preference.weekday,
      startMinute: preference.startMinute,
      durationMinutes: preference.durationMinutes,
      studentCount: 1,
      packageHours: packageRow.packageHours,
      revenueThb: packageRow.averageRevenueThb,
      packageHourBucket: packageRow.packageHourBucket,
      sequence: index,
    };
  }).sort((left, right) =>
    left.weekday - right.weekday ||
    left.startMinute - right.startMinute ||
    right.packageHours - left.packageHours ||
    left.sequence - right.sequence,
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

function firstDateForWeekday(month: string, weekday: number, sequence: number): string | null {
  const dates = dateRangeForMonth(month).filter((date) => bangkokWeekday(date) === weekday);
  return dates.length > 0 ? dates[sequence % dates.length] : null;
}

function demandOccurrences(record: WeekendDemandRecord): SimulationDemand[] {
  const startDate = firstDateForWeekday(record.month, record.weekday, record.sequence);
  if (!startDate) return [];
  const sessionsNeeded = Math.max(1, Math.ceil((record.packageHours * 60) / Math.max(1, record.durationMinutes)));
  return Array.from({ length: sessionsNeeded }, (_, index) => ({
    date: addBangkokDays(startDate, index * 7),
    weekday: record.weekday,
    startMinute: record.startMinute,
    endMinute: record.startMinute + record.durationMinutes,
    mode: "onsite" as const,
    studentCount: record.studentCount,
    subject: null,
    classType: record.packageHourBucket,
  }));
}

function findAvailablePhysicalRoom(
  demand: SimulationDemand,
  rooms: RoomCapacityRoom[],
  occupancy: Map<string, ReservedInterval[]>,
  pending: ReservedInterval[],
): RoomCapacityRoom | null {
  if (demand.startMinute < OPEN_START_MINUTE || demand.endMinute > OPEN_END_MINUTE) return null;
  const candidates = rooms.filter((room) => roomCanHost(room, demand));
  for (const room of candidates) {
    const key = `${demand.date}|${room.name}`;
    const existing = occupancy.get(key) ?? [];
    const blocked = [...existing, ...pending.filter((interval) => interval.date === demand.date && interval.roomName === room.name)];
    if (blocked.some((interval) => overlaps(demand.startMinute, demand.endMinute, interval.startMinute, interval.endMinute))) continue;
    return room;
  }
  return null;
}

function reserveExactPreferredPackage(
  record: WeekendDemandRecord,
  rooms: RoomCapacityRoom[],
  occupancy: Map<string, ReservedInterval[]>,
): boolean {
  const pending: ReservedInterval[] = [];
  for (const occurrence of demandOccurrences(record)) {
    const room = findAvailablePhysicalRoom(occurrence, rooms, occupancy, pending);
    if (!room) return false;
    pending.push({
      date: occurrence.date,
      roomName: room.name,
      startMinute: occurrence.startMinute,
      endMinute: occurrence.endMinute,
      capacity: room.capacity,
    });
  }

  for (const interval of pending) {
    const key = `${interval.date}|${interval.roomName}`;
    occupancy.set(key, [...(occupancy.get(key) ?? []), interval]);
  }
  return true;
}

function newMonthStats(month: string): MutableMonthStats {
  return {
    month,
    capturedRevenueThb: 0,
    lostRevenueThb: 0,
    capturedStudents: 0,
    lostStudents: 0,
    lostSlots: new Map(),
  };
}

function addLostSlot(stats: MutableMonthStats, record: WeekendDemandRecord): void {
  const key = `${record.weekday}|${record.startMinute}|${record.startMinute + record.durationMinutes}`;
  const existing = stats.lostSlots.get(key) ?? {
    weekday: record.weekday,
    weekdayName: weekdayName(record.weekday),
    startMinute: record.startMinute,
    endMinute: record.startMinute + record.durationMinutes,
    label: `${weekdayName(record.weekday)} ${minuteLabel(record.startMinute)}-${minuteLabel(record.startMinute + record.durationMinutes)}`,
    lostRevenueThb: 0,
    lostStudents: 0,
    attempts: 0,
  };
  existing.lostRevenueThb += record.revenueThb;
  existing.lostStudents += 1;
  existing.attempts += 1;
  stats.lostSlots.set(key, existing);
}

function addDemandOutcome(stats: MutableMonthStats, record: WeekendDemandRecord, placed: boolean): void {
  if (placed) {
    stats.capturedRevenueThb += record.revenueThb;
    stats.capturedStudents += 1;
    return;
  }
  stats.lostRevenueThb += record.revenueThb;
  stats.lostStudents += 1;
  addLostSlot(stats, record);
}

function minuteLabel(minute: number): string {
  const hour = Math.floor(minute / 60);
  const mins = minute % 60;
  return `${String(hour).padStart(2, "0")}:${String(mins).padStart(2, "0")}`;
}

function remainingOpenCapacityMinutes(
  month: string,
  weekdays: number[],
  rooms: RoomCapacityRoom[],
  occupancy: Map<string, ReservedInterval[]>,
): number {
  let total = 0;
  const weekdaySet = new Set(weekdays);
  for (const date of dateRangeForMonth(month)) {
    if (!weekdaySet.has(bangkokWeekday(date))) continue;
    for (const room of rooms) {
      const intervals = occupancy.get(`${date}|${room.name}`) ?? [];
      for (let startMinute = OPEN_START_MINUTE; startMinute < OPEN_END_MINUTE; startMinute += 30) {
        const endMinute = startMinute + 30;
        if (intervals.some((interval) => overlaps(startMinute, endMinute, interval.startMinute, interval.endMinute))) continue;
        total += room.capacity * 30;
      }
    }
  }
  return total;
}

function openSlotSummaries(
  month: string,
  weekdays: number[],
  rooms: RoomCapacityRoom[],
  occupancy: Map<string, ReservedInterval[]>,
): WeekendDemandSlotSummary[] {
  const grouped = new Map<string, WeekendDemandSlotSummary>();
  const weekdaySet = new Set(weekdays);

  for (const date of dateRangeForMonth(month)) {
    const weekday = bangkokWeekday(date);
    if (!weekdaySet.has(weekday)) continue;
    for (const room of rooms) {
      const intervals = occupancy.get(`${date}|${room.name}`) ?? [];
      for (let startMinute = OPEN_START_MINUTE; startMinute < OPEN_END_MINUTE; startMinute += 30) {
        const endMinute = startMinute + 30;
        if (intervals.some((interval) => overlaps(startMinute, endMinute, interval.startMinute, interval.endMinute))) continue;
        const key = `${weekday}|${startMinute}|${endMinute}`;
        const existing = grouped.get(key) ?? {
          weekday,
          weekdayName: weekdayName(weekday),
          startMinute,
          endMinute,
          label: `${weekdayName(weekday)} ${minuteLabel(startMinute)}-${minuteLabel(endMinute)}`,
          lostRevenueThb: 0,
          lostStudents: 0,
          attempts: 0,
          remainingOpenCapacityMinutes: 0,
        };
        existing.remainingOpenCapacityMinutes = (existing.remainingOpenCapacityMinutes ?? 0) + room.capacity * 30;
        grouped.set(key, existing);
      }
    }
  }

  return [...grouped.values()]
    .sort((left, right) =>
      (right.remainingOpenCapacityMinutes ?? 0) - (left.remainingOpenCapacityMinutes ?? 0) ||
      left.weekday - right.weekday ||
      left.startMinute - right.startMinute,
    )
    .slice(0, 8);
}

function resultFromStats(
  stats: MutableMonthStats | null,
  status: WeekendDemandBreakpointResult["status"],
  month: string | null,
  weekdays: number[],
  rooms: RoomCapacityRoom[],
  occupancy: Map<string, ReservedInterval[]>,
): WeekendDemandBreakpointResult {
  const totalRevenue = (stats?.capturedRevenueThb ?? 0) + (stats?.lostRevenueThb ?? 0);
  const resultMonth = month ?? stats?.month ?? null;
  return {
    ...(weekdays.length === 1 ? { weekday: weekdays[0], weekdayName: weekdayName(weekdays[0]) } : {}),
    breakpointMonth: status === "not_reached" ? null : resultMonth,
    status,
    capturedRevenueThb: roundMoney(stats?.capturedRevenueThb ?? 0),
    lostRevenueThb: roundMoney(stats?.lostRevenueThb ?? 0),
    lostRevenuePct: totalRevenue > 0 ? roundPct((stats?.lostRevenueThb ?? 0) / totalRevenue) : 0,
    capturedStudents: stats?.capturedStudents ?? 0,
    lostStudents: stats?.lostStudents ?? 0,
    remainingOpenCapacityMinutes: resultMonth ? remainingOpenCapacityMinutes(resultMonth, weekdays, rooms, occupancy) : 0,
    topLostPreferredSlots: [...(stats?.lostSlots.values() ?? [])]
      .map((slot) => ({ ...slot, lostRevenueThb: roundMoney(slot.lostRevenueThb) }))
      .sort((left, right) => right.lostRevenueThb - left.lostRevenueThb || right.lostStudents - left.lostStudents)
      .slice(0, 8),
    topOpenNonCapturedSlots: resultMonth ? openSlotSummaries(resultMonth, weekdays, rooms, occupancy) : [],
  };
}

function reachedBreakpoint(stats: MutableMonthStats): boolean {
  return stats.lostRevenueThb > stats.capturedRevenueThb && stats.lostRevenueThb > 0;
}

function averageTrailingGrowth(drivers: RoomCapacityForecastDriver[]): number {
  const ordered = drivers.filter((driver) => driver.newPaidStudents > 0).sort((left, right) => left.month.localeCompare(right.month));
  const trailing = ordered.slice(-3);
  if (trailing.length < 2) return 0;
  const growthRates: number[] = [];
  for (let index = 1; index < trailing.length; index += 1) {
    const prior = trailing[index - 1].newPaidStudents;
    const current = trailing[index].newPaidStudents;
    if (prior > 0) growthRates.push(current / prior - 1);
  }
  if (growthRates.length === 0) return 0;
  const average = growthRates.reduce((sum, rate) => sum + rate, 0) / growthRates.length;
  return Math.max(-0.2, Math.min(0.5, average));
}

function extrapolatedDriver(
  prior: RoomCapacityForecastDriver,
  growthRate: number,
): RoomCapacityForecastDriver {
  const newPaidStudents = Math.max(0, prior.newPaidStudents * (1 + growthRate));
  return {
    ...prior,
    month: nextMonthStart(prior.month),
    newPaidStudents,
    forecastConsumedHours: prior.forecastConsumedHours * (1 + growthRate),
    projectedRevenueThb: prior.projectedRevenueThb * (1 + growthRate),
  };
}

export function simulateWeekendDemandBreakpoint(input: WeekendDemandBreakpointInput): WeekendDemandBreakpoint | null {
  const rooms = activePhysicalRooms(input.rooms);
  const drivers = [...input.drivers].sort((left, right) => left.month.localeCompare(right.month));
  if (rooms.length === 0 || drivers.length === 0 || input.packageMix.length === 0) return null;

  const { preferenceMix, weekendDemandShare } = weekendPreferenceDistributionFromSchedule(input.seedSessions, input.rooms);
  if (preferenceMix.length === 0 || weekendDemandShare <= 0) return null;

  const occupancy = buildWeekendSeedOccupancy(input.seedSessions, input.rooms);
  const growthRate = averageTrailingGrowth(drivers);
  const maxExtrapolatedMonths = input.maxExtrapolatedMonths ?? 36;
  const breakpoints = new Map<string, WeekendDemandBreakpointResult>();
  const lastStats = new Map<string, MutableMonthStats>();
  const scopes = [
    { key: "combined", weekdays: WEEKEND_WEEKDAYS },
    { key: "6", weekdays: [6] },
    { key: "0", weekdays: [0] },
  ];

  let driver: RoomCapacityForecastDriver | null = null;
  let extrapolatedCount = 0;
  const totalIterations = drivers.length + maxExtrapolatedMonths;

  for (let index = 0; index < totalIterations; index += 1) {
    const isExtrapolated = index >= drivers.length;
    if (!isExtrapolated) {
      driver = drivers[index];
    } else if (driver && [...breakpoints.keys()].length < scopes.length) {
      driver = extrapolatedDriver(driver, growthRate);
      extrapolatedCount += 1;
    } else {
      break;
    }
    if (!driver) break;

    const monthStats = new Map<string, MutableMonthStats>();
    for (const scope of scopes) monthStats.set(scope.key, newMonthStats(driver.month));

    for (const record of expandWeekendDemandForMonth(driver, input.packageMix, preferenceMix, weekendDemandShare)) {
      const placed = reserveExactPreferredPackage(record, rooms, occupancy);
      addDemandOutcome(monthStats.get("combined")!, record, placed);
      addDemandOutcome(monthStats.get(String(record.weekday))!, record, placed);
    }

    for (const scope of scopes) {
      const stats = monthStats.get(scope.key)!;
      lastStats.set(scope.key, stats);
      if (!breakpoints.has(scope.key) && reachedBreakpoint(stats)) {
        breakpoints.set(
          scope.key,
          resultFromStats(stats, isExtrapolated ? "reached_extrapolated" : "reached", driver.month, scope.weekdays, rooms, occupancy),
        );
      }
    }

    if (breakpoints.size === scopes.length) break;
  }

  const resultForScope = (scope: { key: string; weekdays: number[] }) =>
    breakpoints.get(scope.key) ??
    resultFromStats(lastStats.get(scope.key) ?? null, extrapolatedCount > 0 ? "not_reached" : "not_reached", null, scope.weekdays, rooms, occupancy);

  return {
    preferenceSource: "current_wise_schedule",
    policy: "preferred_slot_only",
    openHours: { startMinute: OPEN_START_MINUTE, endMinute: OPEN_END_MINUTE },
    weekendDemandShare: roundPct(weekendDemandShare),
    combined: resultForScope(scopes[0]),
    byDay: [resultForScope(scopes[1]), resultForScope(scopes[2])],
  };
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
