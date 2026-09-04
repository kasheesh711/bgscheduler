import { weekdayName } from "@/lib/room-capacity/dates";

import {
  addBangkokDays,
  bangkokWeekday,
  endOfBangkokMonth,
  formatFootTrafficDate,
  mondayWeekStart,
  monthLabel,
  monthStart,
} from "./dates";
import type {
  FootTrafficBreakdownRow,
  FootTrafficDashboardPayload,
  FootTrafficDataQuality,
  FootTrafficFilters,
  FootTrafficPeriodRow,
  FootTrafficSessionRecord,
  FootTrafficSummary,
  FootTrafficVisitRecord,
} from "./types";

type AggregateSessionRecord = Pick<
  FootTrafficSessionRecord,
  | "wiseSessionId"
  | "attendanceDate"
  | "roomName"
  | "missingAttendanceEvidenceCount"
  | "isCountedOnsite"
  | "exclusionReason"
>;

type AggregateVisitRecord = Pick<
  FootTrafficVisitRecord,
  "wiseSessionId" | "studentFingerprint" | "attendanceDate"
>;

interface AggregateInput {
  sessions: AggregateSessionRecord[];
  visits: AggregateVisitRecord[];
  filters: FootTrafficFilters;
  latestCompletedDate: string;
  coverageStartDate: string | null;
  coverageEndDate: string | null;
  dataAsOf: string | null;
  lastSuccessfulSyncAt: string | null;
  sourceSyncRunId: string | null;
  availableRooms: string[];
}

interface DateDimensions {
  weekday: number;
  weekStart: string;
  month: string;
}

interface SessionDimensions extends DateDimensions {
  roomName: string | null;
}

interface MutableSummary {
  studentVisits: number;
  onsiteClasses: number;
  unidentifiedVisits: number;
  studentFingerprints: Set<string>;
}

function createSummary(): MutableSummary {
  return {
    studentVisits: 0,
    onsiteClasses: 0,
    unidentifiedVisits: 0,
    studentFingerprints: new Set<string>(),
  };
}

function roundAverage(visits: number, classes: number): number {
  return classes > 0 ? Math.round((visits / classes) * 100) / 100 : 0;
}

function materializeSummary(summary?: MutableSummary): FootTrafficSummary {
  if (!summary) {
    return {
      studentVisits: 0,
      uniqueStudents: 0,
      onsiteClasses: 0,
      averageVisitsPerClass: 0,
      unidentifiedVisits: 0,
    };
  }
  return {
    studentVisits: summary.studentVisits,
    uniqueStudents: summary.studentFingerprints.size,
    onsiteClasses: summary.onsiteClasses,
    averageVisitsPerClass: roundAverage(summary.studentVisits, summary.onsiteClasses),
    unidentifiedVisits: summary.unidentifiedVisits,
  };
}

function accumulatorFor(map: Map<string, MutableSummary>, key: string): MutableSummary {
  const existing = map.get(key);
  if (existing) return existing;
  const created = createSummary();
  map.set(key, created);
  return created;
}

function addSession(summary: MutableSummary, isCountedOnsite: boolean): void {
  if (isCountedOnsite) summary.onsiteClasses += 1;
}

function addVisit(summary: MutableSummary, studentFingerprint: string | null): void {
  summary.studentVisits += 1;
  if (studentFingerprint) {
    summary.studentFingerprints.add(studentFingerprint);
  } else {
    summary.unidentifiedVisits += 1;
  }
}

function createDataQuality(): FootTrafficDataQuality {
  return {
    totalPastSessions: 0,
    countedOnsiteSessions: 0,
    excludedSessions: 0,
    cancelledSessions: 0,
    missedSessions: 0,
    notEndedSessions: 0,
    nonOnsiteSessions: 0,
    missingLocationSessions: 0,
    unknownRoomSessions: 0,
    onlineOnlyRoomSessions: 0,
    sessionsWithoutAttendanceEvidence: 0,
    participantsWithoutAttendanceEvidence: 0,
    unidentifiedVisits: 0,
  };
}

function addSessionQuality(
  quality: FootTrafficDataQuality,
  session: AggregateSessionRecord,
): void {
  quality.totalPastSessions += 1;
  quality.participantsWithoutAttendanceEvidence += session.missingAttendanceEvidenceCount;
  if (session.isCountedOnsite) {
    quality.countedOnsiteSessions += 1;
  } else {
    quality.excludedSessions += 1;
  }

  switch (session.exclusionReason) {
    case "cancelled":
      quality.cancelledSessions += 1;
      break;
    case "missed":
      quality.missedSessions += 1;
      break;
    case "not_ended":
      quality.notEndedSessions += 1;
      break;
    case "not_onsite":
      quality.nonOnsiteSessions += 1;
      break;
    case "missing_location":
      quality.missingLocationSessions += 1;
      break;
    case "unknown_room":
      quality.unknownRoomSessions += 1;
      break;
    case "online_only_room":
      quality.onlineOnlyRoomSessions += 1;
      break;
    case "no_attendance_evidence":
      quality.sessionsWithoutAttendanceEvidence += 1;
      break;
    default:
      break;
  }
}

function dimensionsFor(
  date: string,
  cache: Map<string, DateDimensions>,
): DateDimensions {
  const existing = cache.get(date);
  if (existing) return existing;
  const weekday = bangkokWeekday(date);
  const dimensions = {
    weekday,
    weekStart: addBangkokDays(date, weekday === 0 ? -6 : 1 - weekday),
    month: date.slice(0, 7),
  };
  cache.set(date, dimensions);
  return dimensions;
}

function overlap(startA: string, endA: string, startB: string, endB: string): boolean {
  return startA <= endB && startB <= endA;
}

function buildWeekly(
  summaries: ReadonlyMap<string, MutableSummary>,
  effectiveStart: string,
  effectiveEnd: string,
): FootTrafficPeriodRow[] {
  if (effectiveStart > effectiveEnd) return [];
  const rows: FootTrafficPeriodRow[] = [];
  for (let start = mondayWeekStart(effectiveStart); start <= effectiveEnd; start = addBangkokDays(start, 7)) {
    const end = addBangkokDays(start, 6);
    if (!overlap(start, end, effectiveStart, effectiveEnd)) continue;
    rows.push({
      key: start,
      label: `Week of ${formatFootTrafficDate(start, { day: "numeric", month: "short" })}`,
      periodStart: start,
      periodEnd: end,
      isPartial: start < effectiveStart || end > effectiveEnd,
      ...materializeSummary(summaries.get(start)),
    });
  }
  return rows;
}

function nextMonth(date: string): string {
  const [year, month] = date.split("-").map(Number);
  return `${month === 12 ? year + 1 : year}-${String(month === 12 ? 1 : month + 1).padStart(2, "0")}-01`;
}

function buildMonthly(
  summaries: ReadonlyMap<string, MutableSummary>,
  effectiveStart: string,
  effectiveEnd: string,
): FootTrafficPeriodRow[] {
  if (effectiveStart > effectiveEnd) return [];
  const rows: FootTrafficPeriodRow[] = [];
  for (let start = monthStart(effectiveStart); start <= effectiveEnd; start = nextMonth(start)) {
    const end = endOfBangkokMonth(start);
    const key = start.slice(0, 7);
    rows.push({
      key,
      label: monthLabel(start),
      periodStart: start,
      periodEnd: end,
      isPartial: start < effectiveStart || end > effectiveEnd,
      ...materializeSummary(summaries.get(key)),
    });
  }
  return rows;
}

export function aggregateFootTraffic(input: AggregateInput): FootTrafficDashboardPayload {
  const selectedRooms = new Set(input.filters.rooms ?? []);
  const selectedWeekdays = new Set(input.filters.weekdays ?? []);
  const coverageEnd = input.coverageEndDate ?? input.filters.endDate;
  const effectiveEnd = [input.filters.endDate, input.latestCompletedDate, coverageEnd].sort()[0];
  const coverageStart = input.coverageStartDate ?? input.filters.startDate;
  const effectiveStart = input.filters.startDate < coverageStart ? coverageStart : input.filters.startDate;
  const hasCoverage = Boolean(input.coverageStartDate && input.coverageEndDate && effectiveStart <= effectiveEnd);
  const roomNames = [...new Set(
    selectedRooms.size > 0 ? [...selectedRooms] : input.availableRooms,
  )].sort((left, right) => left.localeCompare(right));
  const includedRooms = new Set(roomNames);
  const weekdays = [1, 2, 3, 4, 5, 6, 0];

  const overall = createSummary();
  const weekly = new Map<string, MutableSummary>();
  const monthly = new Map<string, MutableSummary>();
  const byWeekday = new Map<string, MutableSummary>();
  const byRoom = new Map<string, MutableSummary>();
  const dataQuality = createDataQuality();
  const dateDimensions = new Map<string, DateDimensions>();
  const sessionsById = new Map<string, SessionDimensions>();

  if (hasCoverage) {
    for (const session of input.sessions) {
      if (session.attendanceDate < effectiveStart || session.attendanceDate > effectiveEnd) continue;
      if (selectedRooms.size > 0 && (!session.roomName || !selectedRooms.has(session.roomName))) continue;
      const dimensions = dimensionsFor(session.attendanceDate, dateDimensions);
      if (selectedWeekdays.size > 0 && !selectedWeekdays.has(dimensions.weekday)) continue;

      const sessionDimensions = { ...dimensions, roomName: session.roomName };
      sessionsById.set(session.wiseSessionId, sessionDimensions);
      addSessionQuality(dataQuality, session);
      addSession(overall, session.isCountedOnsite);
      addSession(accumulatorFor(weekly, dimensions.weekStart), session.isCountedOnsite);
      addSession(accumulatorFor(monthly, dimensions.month), session.isCountedOnsite);
      addSession(accumulatorFor(byWeekday, String(dimensions.weekday)), session.isCountedOnsite);
      if (session.roomName && includedRooms.has(session.roomName)) {
        addSession(accumulatorFor(byRoom, session.roomName), session.isCountedOnsite);
      }
    }

    for (const visit of input.visits) {
      const session = sessionsById.get(visit.wiseSessionId);
      if (!session) continue;
      const visitDimensions = dimensionsFor(visit.attendanceDate, dateDimensions);
      addVisit(overall, visit.studentFingerprint);
      addVisit(accumulatorFor(weekly, visitDimensions.weekStart), visit.studentFingerprint);
      addVisit(accumulatorFor(monthly, visitDimensions.month), visit.studentFingerprint);
      addVisit(accumulatorFor(byWeekday, String(session.weekday)), visit.studentFingerprint);
      if (session.roomName && includedRooms.has(session.roomName)) {
        addVisit(accumulatorFor(byRoom, session.roomName), visit.studentFingerprint);
      }
      if (!visit.studentFingerprint) dataQuality.unidentifiedVisits += 1;
    }
  }

  const emptyEffectiveStart = hasCoverage ? effectiveStart : input.filters.startDate;
  const emptyEffectiveEnd = hasCoverage ? effectiveEnd : input.filters.endDate;

  return {
    meta: {
      requestedStartDate: input.filters.startDate,
      requestedEndDate: input.filters.endDate,
      effectiveStartDate: emptyEffectiveStart,
      effectiveEndDate: emptyEffectiveEnd,
      coverageStartDate: input.coverageStartDate,
      coverageEndDate: input.coverageEndDate,
      latestCompletedDate: input.latestCompletedDate,
      dataAsOf: input.dataAsOf,
      lastSuccessfulSyncAt: input.lastSuccessfulSyncAt,
      sourceSyncRunId: input.sourceSyncRunId,
      timeZone: "Asia/Bangkok",
      source: "Wise PAST sessions",
      isEndDateCapped: hasCoverage && effectiveEnd < input.filters.endDate,
      isSeptemberMonthToDate:
        input.filters.startDate <= "2026-09-30" && input.filters.endDate >= "2026-09-01" && effectiveEnd < "2026-09-30",
      rooms: [...selectedRooms],
      weekdays: [...selectedWeekdays],
      availableRooms: [...input.availableRooms].sort((left, right) => left.localeCompare(right)),
    },
    summary: materializeSummary(overall),
    weekly: hasCoverage ? buildWeekly(weekly, effectiveStart, effectiveEnd) : [],
    monthly: hasCoverage ? buildMonthly(monthly, effectiveStart, effectiveEnd) : [],
    byWeekday: weekdays.map((weekday): FootTrafficBreakdownRow => ({
      key: String(weekday),
      label: weekdayName(weekday),
      ...materializeSummary(byWeekday.get(String(weekday))),
    })),
    byRoom: roomNames.map((roomName): FootTrafficBreakdownRow => ({
      key: roomName,
      label: roomName,
      ...materializeSummary(byRoom.get(roomName)),
    })).sort((left, right) => right.studentVisits - left.studentVisits || left.label.localeCompare(right.label)),
    dataQuality,
  };
}
