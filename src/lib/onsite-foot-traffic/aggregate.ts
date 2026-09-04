import { weekdayName } from "@/lib/room-capacity/dates";

import {
  addBangkokDays,
  bangkokTimeLabel,
  bangkokWeekday,
  endOfBangkokMonth,
  formatFootTrafficDate,
  mondayWeekStart,
  monthLabel,
  monthStart,
  weekEnd,
} from "./dates";
import type {
  FootTrafficBreakdownRow,
  FootTrafficDashboardResult,
  FootTrafficDataQuality,
  FootTrafficFilters,
  FootTrafficPeriodRow,
  FootTrafficSessionRecord,
  FootTrafficSummary,
  FootTrafficVisitDetail,
  FootTrafficVisitRecord,
} from "./types";

interface AggregateInput {
  sessions: FootTrafficSessionRecord[];
  visits: FootTrafficVisitRecord[];
  filters: FootTrafficFilters;
  latestCompletedDate: string;
  coverageStartDate: string | null;
  coverageEndDate: string | null;
  dataAsOf: string | null;
  lastSuccessfulSyncAt: string | null;
  sourceSyncRunId: string | null;
  availableRooms: string[];
}

const EMPTY_SUMMARY: FootTrafficSummary = {
  studentVisits: 0,
  uniqueStudents: 0,
  onsiteClasses: 0,
  averageVisitsPerClass: 0,
  unidentifiedVisits: 0,
};

function roundAverage(visits: number, classes: number): number {
  return classes > 0 ? Math.round((visits / classes) * 100) / 100 : 0;
}

function summarize(
  sessions: readonly FootTrafficSessionRecord[],
  visits: readonly FootTrafficVisitRecord[],
): FootTrafficSummary {
  const onsiteClasses = sessions.filter((session) => session.isCountedOnsite).length;
  const uniqueStudents = new Set(
    visits.map((visit) => visit.studentFingerprint).filter((value): value is string => Boolean(value)),
  ).size;
  const unidentifiedVisits = visits.filter((visit) => !visit.studentFingerprint).length;
  return {
    studentVisits: visits.length,
    uniqueStudents,
    onsiteClasses,
    averageVisitsPerClass: roundAverage(visits.length, onsiteClasses),
    unidentifiedVisits,
  };
}

function overlap(startA: string, endA: string, startB: string, endB: string): boolean {
  return startA <= endB && startB <= endA;
}

function groupPeriod(
  sessions: readonly FootTrafficSessionRecord[],
  visits: readonly FootTrafficVisitRecord[],
  start: string,
  end: string,
): FootTrafficSummary {
  return summarize(
    sessions.filter((row) => row.attendanceDate >= start && row.attendanceDate <= end),
    visits.filter((row) => row.attendanceDate >= start && row.attendanceDate <= end),
  );
}

function buildWeekly(
  sessions: readonly FootTrafficSessionRecord[],
  visits: readonly FootTrafficVisitRecord[],
  effectiveStart: string,
  effectiveEnd: string,
): FootTrafficPeriodRow[] {
  if (effectiveStart > effectiveEnd) return [];
  const rows: FootTrafficPeriodRow[] = [];
  for (let start = mondayWeekStart(effectiveStart); start <= effectiveEnd; start = addBangkokDays(start, 7)) {
    const end = weekEnd(start);
    if (!overlap(start, end, effectiveStart, effectiveEnd)) continue;
    rows.push({
      key: start,
      label: `Week of ${formatFootTrafficDate(start, { day: "numeric", month: "short" })}`,
      periodStart: start,
      periodEnd: end,
      isPartial: start < effectiveStart || end > effectiveEnd,
      ...groupPeriod(sessions, visits, start, end),
    });
  }
  return rows;
}

function nextMonth(date: string): string {
  const [year, month] = date.split("-").map(Number);
  return `${month === 12 ? year + 1 : year}-${String(month === 12 ? 1 : month + 1).padStart(2, "0")}-01`;
}

function buildMonthly(
  sessions: readonly FootTrafficSessionRecord[],
  visits: readonly FootTrafficVisitRecord[],
  effectiveStart: string,
  effectiveEnd: string,
): FootTrafficPeriodRow[] {
  if (effectiveStart > effectiveEnd) return [];
  const rows: FootTrafficPeriodRow[] = [];
  for (let start = monthStart(effectiveStart); start <= effectiveEnd; start = nextMonth(start)) {
    const end = endOfBangkokMonth(start);
    rows.push({
      key: start.slice(0, 7),
      label: monthLabel(start),
      periodStart: start,
      periodEnd: end,
      isPartial: start < effectiveStart || end > effectiveEnd,
      ...groupPeriod(sessions, visits, start, end),
    });
  }
  return rows;
}

function breakdown(
  sessions: readonly FootTrafficSessionRecord[],
  visits: readonly FootTrafficVisitRecord[],
  definitions: Array<{ key: string; label: string; matchesSession: (row: FootTrafficSessionRecord) => boolean }>,
): FootTrafficBreakdownRow[] {
  return definitions.map((definition) => {
    const groupSessions = sessions.filter(definition.matchesSession);
    const sessionIds = new Set(groupSessions.map((row) => row.wiseSessionId));
    const groupVisits = visits.filter((row) => sessionIds.has(row.wiseSessionId));
    return { key: definition.key, label: definition.label, ...summarize(groupSessions, groupVisits) };
  });
}

function qualityFor(sessions: readonly FootTrafficSessionRecord[], visits: readonly FootTrafficVisitRecord[]): FootTrafficDataQuality {
  const reasonCount = (reason: FootTrafficSessionRecord["exclusionReason"]) =>
    sessions.filter((session) => session.exclusionReason === reason).length;
  return {
    totalPastSessions: sessions.length,
    countedOnsiteSessions: sessions.filter((session) => session.isCountedOnsite).length,
    excludedSessions: sessions.filter((session) => !session.isCountedOnsite).length,
    cancelledSessions: reasonCount("cancelled"),
    missedSessions: reasonCount("missed"),
    notEndedSessions: reasonCount("not_ended"),
    nonOnsiteSessions: reasonCount("not_onsite"),
    missingLocationSessions: reasonCount("missing_location"),
    unknownRoomSessions: reasonCount("unknown_room"),
    onlineOnlyRoomSessions: reasonCount("online_only_room"),
    sessionsWithoutAttendanceEvidence: reasonCount("no_attendance_evidence"),
    participantsWithoutAttendanceEvidence: sessions.reduce(
      (sum, session) => sum + session.missingAttendanceEvidenceCount,
      0,
    ),
    unidentifiedVisits: visits.filter((visit) => !visit.studentFingerprint).length,
  };
}

export function aggregateFootTraffic(input: AggregateInput): FootTrafficDashboardResult {
  const selectedRooms = new Set(input.filters.rooms ?? []);
  const selectedWeekdays = new Set(input.filters.weekdays ?? []);
  const coverageEnd = input.coverageEndDate ?? input.filters.endDate;
  const effectiveEnd = [input.filters.endDate, input.latestCompletedDate, coverageEnd].sort()[0];
  const coverageStart = input.coverageStartDate ?? input.filters.startDate;
  const effectiveStart = input.filters.startDate < coverageStart ? coverageStart : input.filters.startDate;
  const hasCoverage = Boolean(input.coverageStartDate && input.coverageEndDate && effectiveStart <= effectiveEnd);

  const filteredSessions = hasCoverage
    ? input.sessions.filter((session) => {
      if (session.attendanceDate < effectiveStart || session.attendanceDate > effectiveEnd) return false;
      if (selectedRooms.size > 0 && (!session.roomName || !selectedRooms.has(session.roomName))) return false;
      if (selectedWeekdays.size > 0 && !selectedWeekdays.has(bangkokWeekday(session.attendanceDate))) return false;
      return true;
    })
    : [];
  const sessionIds = new Set(filteredSessions.map((session) => session.wiseSessionId));
  const filteredVisits = input.visits.filter((visit) => sessionIds.has(visit.wiseSessionId));
  const sessionsById = new Map(filteredSessions.map((session) => [session.wiseSessionId, session]));
  const detail: FootTrafficVisitDetail[] = filteredVisits.map((visit) => {
    const session = sessionsById.get(visit.wiseSessionId)!;
    return {
      attendanceDate: visit.attendanceDate,
      startTime: bangkokTimeLabel(session.scheduledStartAt),
      weekStart: mondayWeekStart(visit.attendanceDate),
      month: visit.attendanceDate.slice(0, 7),
      studentFingerprint: visit.studentFingerprint,
      wiseSessionId: visit.wiseSessionId,
      room: session.roomName ?? "Unknown",
      subject: session.subject,
      tutor: session.tutorName,
      consumedCredits: visit.consumedCredits,
    };
  }).sort((left, right) =>
    left.attendanceDate.localeCompare(right.attendanceDate) ||
    left.startTime.localeCompare(right.startTime) ||
    left.wiseSessionId.localeCompare(right.wiseSessionId));

  const roomNames = [...new Set(
    selectedRooms.size > 0 ? [...selectedRooms] : input.availableRooms,
  )].sort((left, right) => left.localeCompare(right));
  const weekdays = [1, 2, 3, 4, 5, 6, 0];
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
    summary: hasCoverage ? summarize(filteredSessions, filteredVisits) : { ...EMPTY_SUMMARY },
    weekly: hasCoverage ? buildWeekly(filteredSessions, filteredVisits, effectiveStart, effectiveEnd) : [],
    monthly: hasCoverage ? buildMonthly(filteredSessions, filteredVisits, effectiveStart, effectiveEnd) : [],
    byWeekday: breakdown(
      filteredSessions,
      filteredVisits,
      weekdays.map((weekday) => ({
        key: String(weekday),
        label: weekdayName(weekday),
        matchesSession: (row) => bangkokWeekday(row.attendanceDate) === weekday,
      })),
    ),
    byRoom: breakdown(
      filteredSessions,
      filteredVisits,
      roomNames.map((roomName) => ({
        key: roomName,
        label: roomName,
        matchesSession: (row) => row.roomName === roomName,
      })),
    ).sort((left, right) => right.studentVisits - left.studentVisits || left.label.localeCompare(right.label)),
    dataQuality: qualityFor(filteredSessions, filteredVisits),
    visits: detail,
  };
}
