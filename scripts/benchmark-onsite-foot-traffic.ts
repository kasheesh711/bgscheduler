import { performance } from "node:perf_hooks";

import { aggregateFootTraffic } from "../src/lib/onsite-foot-traffic/aggregate";
import type {
  FootTrafficSessionRecord,
  FootTrafficVisitRecord,
} from "../src/lib/onsite-foot-traffic/types";

const SESSION_COUNT = 17_500;
const COUNTED_SESSION_COUNT = 7_600;
const VISIT_COUNT = 8_000;
const DISTINCT_STUDENTS = 481;
const DATE_COUNT = 187;
const MAX_AGGREGATION_MS = 100;

type BenchmarkSession = Pick<
  FootTrafficSessionRecord,
  | "wiseSessionId"
  | "attendanceDate"
  | "roomName"
  | "missingAttendanceEvidenceCount"
  | "isCountedOnsite"
  | "exclusionReason"
>;
type BenchmarkVisit = Pick<
  FootTrafficVisitRecord,
  "wiseSessionId" | "studentFingerprint" | "attendanceDate"
>;

function dateAt(index: number): string {
  const date = new Date(Date.UTC(2026, 2, 1 + index));
  return date.toISOString().slice(0, 10);
}

const dates = Array.from({ length: DATE_COUNT }, (_, index) => dateAt(index));
const rooms = Array.from({ length: 35 }, (_, index) => `Room ${String(index + 1).padStart(2, "0")}`);
const sessions: BenchmarkSession[] = Array.from({ length: SESSION_COUNT }, (_, index) => ({
  wiseSessionId: `session-${index}`,
  attendanceDate: dates[index % dates.length],
  roomName: rooms[index % rooms.length],
  missingAttendanceEvidenceCount: index % 211 === 0 ? 1 : 0,
  isCountedOnsite: index < COUNTED_SESSION_COUNT,
  exclusionReason: index < COUNTED_SESSION_COUNT ? null : "not_onsite",
}));
const visits: BenchmarkVisit[] = Array.from({ length: VISIT_COUNT }, (_, index) => {
  const session = sessions[index % COUNTED_SESSION_COUNT];
  return {
    wiseSessionId: session.wiseSessionId,
    attendanceDate: session.attendanceDate,
    studentFingerprint: index % 101 === 0 ? null : `student-${index % DISTINCT_STUDENTS}`,
  };
});

const startedAt = performance.now();
const result = aggregateFootTraffic({
  sessions,
  visits,
  filters: { startDate: "2026-03-01", endDate: "2026-09-30" },
  latestCompletedDate: "2026-09-03",
  coverageStartDate: "2026-03-01",
  coverageEndDate: "2026-09-03",
  dataAsOf: "2026-09-03",
  lastSuccessfulSyncAt: "2026-09-04T01:18:00.000Z",
  sourceSyncRunId: "benchmark-run",
  availableRooms: rooms,
});
const aggregationMs = Math.round((performance.now() - startedAt) * 10) / 10;

console.log(JSON.stringify({
  event: "onsite_foot_traffic_benchmark",
  aggregationMs,
  thresholdMs: MAX_AGGREGATION_MS,
  sessionRows: sessions.length,
  visitRows: visits.length,
  summary: result.summary,
}));

if (aggregationMs > MAX_AGGREGATION_MS) {
  console.error(`Foot-traffic aggregation exceeded ${MAX_AGGREGATION_MS}ms.`);
  process.exitCode = 1;
}
