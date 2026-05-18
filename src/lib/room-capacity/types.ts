export type RoomCapacitySource = "current" | "projected";

export interface RoomCapacityRoom {
  id?: string;
  name: string;
  capacity: number;
  hasTv: boolean;
  category: "standard" | "overflow_only" | "online_only";
  active: boolean;
  sortOrder: number;
}

export interface RoomCapacitySession {
  id: string;
  groupId: string;
  tutorDisplayName: string;
  wiseTeacherId: string;
  wiseTeacherUserId?: string | null;
  wiseSessionId: string;
  wiseClassId?: string | null;
  startTime: Date;
  endTime: Date;
  date: string;
  weekday: number;
  startMinute: number;
  endMinute: number;
  wiseStatus: string;
  sessionType?: string | null;
  currentWiseLocation?: string | null;
  studentCount?: number | null;
  subject?: string | null;
  classType?: string | null;
  title?: string | null;
  assignedRoom?: string | null;
  status?: "assigned" | "needs_review" | "no_room" | "remote";
  warnings?: string[];
}

export interface RoomCapacityHeatmapCell {
  id: string;
  source: RoomCapacitySource;
  date: string;
  weekday: number;
  roomName: string;
  startMinute: number;
  endMinute: number;
  load: number;
  capacity: number;
  loadRatio: number;
  sessionCount: number;
  status: "empty" | "occupied" | "full" | "over_capacity" | "review";
}

export interface RoomCapacityOvercapInterval {
  id: string;
  source: RoomCapacitySource;
  date: string;
  weekday: number;
  roomName: string;
  startMinute: number;
  endMinute: number;
  load: number;
  capacity: number;
  sessionCount: number;
  tutors: string[];
  classes: string[];
}

export interface RoomCapacityUnmatchedAllocation {
  id: string;
  date: string;
  weekday: number;
  startMinute: number;
  endMinute: number;
  tutorDisplayName: string;
  location: string | null;
  reason: "missing_location" | "unknown_room";
  classLabel: string;
}

export interface RoomCapacityNoRoomRow {
  id: string;
  date: string;
  weekday: number;
  startMinute: number;
  endMinute: number;
  tutorDisplayName: string;
  assignedRoom: string;
  warnings: string[];
  classLabel: string;
  subject: string | null;
  classType: string | null;
}

export interface RoomCapacityDaySummary {
  date: string;
  weekday: number;
  totalSessions: number;
  physicalSessions: number;
  remoteSessions: number;
  overcapIntervals: number;
  projectedNoRoom: number;
  unmatchedAllocations: number;
  peakLoadRatio: number;
  peakLoad: number;
  peakCapacity: number;
}

export interface RoomCapacityMonthResponse {
  range: {
    startDate: string;
    endDate: string;
    generatedAt: string;
  };
  snapshotMeta: {
    snapshotId: string;
    syncedAt: string;
  };
  rooms: RoomCapacityRoom[];
  kpis: {
    currentOvercapIntervals: number;
    impactedRooms: number;
    projectedNoRoomSessions: number;
    unmatchedCurrentAllocations: number;
    peakLoadRatio: number;
  };
  current: {
    overcaps: RoomCapacityOvercapInterval[];
    unmatchedAllocations: RoomCapacityUnmatchedAllocation[];
    heatmapCells: RoomCapacityHeatmapCell[];
    daySummaries: RoomCapacityDaySummary[];
  };
  projected: {
    overcaps: RoomCapacityOvercapInterval[];
    noRoomRows: RoomCapacityNoRoomRow[];
    heatmapCells: RoomCapacityHeatmapCell[];
    daySummaries: RoomCapacityDaySummary[];
  };
}

export interface RoomCapacityForecastDriver {
  scenario: string;
  month: string;
  newPaidStudents: number;
  forecastConsumedHours: number;
  scheduledHours: number;
  capacityUtilizationPct: number;
  capacityExceeded: boolean;
  projectedRevenueThb: number;
}

export interface RoomCapacityPackageMixRow {
  packageHourBucket: string;
  packageHours: number;
  averageRevenueThb: number;
  share: number;
  observedSaleCount: number;
  observedStudentCount: number;
  sourceLabel: string;
}

export interface RoomCapacityDemandMixRow {
  weekday: number;
  startMinute: number;
  durationMinutes: number;
  mode: "online" | "onsite" | "either";
  studentCount: number;
  subject: string | null;
  classType: string | null;
  share: number;
  observedSessions: number;
}

export interface WeekdaySaturationResult {
  weekday: number;
  weekdayName: string;
  roomSlotFullDate: string | null;
  roomTutorFullDate: string | null;
  roomSlotReason: string | null;
  roomTutorReason: string | null;
}

export interface WeekendDemandSlotSummary {
  weekday: number;
  weekdayName: string;
  startMinute: number;
  endMinute: number;
  label: string;
  lostRevenueThb: number;
  lostStudents: number;
  attempts: number;
  remainingOpenCapacityMinutes?: number;
}

export type WeekendDemandBreakpointStatus = "reached" | "reached_extrapolated" | "not_reached";

export interface WeekendDemandBreakpointResult {
  weekday?: number;
  weekdayName?: string;
  breakpointMonth: string | null;
  status: WeekendDemandBreakpointStatus;
  capturedRevenueThb: number;
  lostRevenueThb: number;
  lostRevenuePct: number;
  capturedStudents: number;
  lostStudents: number;
  remainingOpenCapacityMinutes: number;
  topLostPreferredSlots: WeekendDemandSlotSummary[];
  topOpenNonCapturedSlots: WeekendDemandSlotSummary[];
}

export interface WeekendDemandBreakpoint {
  preferenceSource: "current_wise_schedule";
  policy: "preferred_slot_only";
  openHours: { startMinute: number; endMinute: number };
  weekendDemandShare: number;
  combined: WeekendDemandBreakpointResult;
  byDay: WeekendDemandBreakpointResult[];
}

export interface RoomUtilizationMetric {
  occupiedMinutes: number;
  availableMinutes: number;
  utilizationPct: number;
  sessionCount: number;
}

export interface RoomUtilizationDailyRow extends RoomUtilizationMetric {
  date: string;
  weekday: number;
  missingLocationCount: number;
  unknownRoomCount: number;
  excludedStatusCount: number;
  overlapMinutes: number;
}

export interface RoomUtilizationMonthlyRow extends RoomUtilizationMetric {
  month: string;
  startDate: string;
  endDate: string;
  missingLocationCount: number;
  unknownRoomCount: number;
  excludedStatusCount: number;
  overlapMinutes: number;
}

export interface RoomUtilizationRoomRow extends RoomUtilizationMetric {
  roomName: string;
  capacity: number;
  category: "standard" | "overflow_only" | "online_only";
  overlapMinutes: number;
}

export interface RoomUtilizationDataQuality {
  missingLocationCount: number;
  missingLocationMinutes: number;
  unknownRoomCount: number;
  unknownRoomMinutes: number;
  excludedStatusCount: number;
  excludedStatusMinutes: number;
  overlapMinutes: number;
}

export interface RoomUtilizationResponse {
  range: {
    startDate: string;
    endDate: string;
    generatedAt: string;
    openStartMinute: number;
    openEndMinute: number;
    weekdays: number[];
  };
  lastSyncedAt: string | null;
  summary: RoomUtilizationMetric & {
    activeRoomCount: number;
  };
  daily: RoomUtilizationDailyRow[];
  monthly: RoomUtilizationMonthlyRow[];
  rooms: RoomUtilizationRoomRow[];
  dataQuality: RoomUtilizationDataQuality;
}

export type WeekendDemandCaptureReadinessReasonCode =
  | "missing_package_mix"
  | "missing_scenario_drivers"
  | "no_active_physical_rooms"
  | "missing_seed_sessions"
  | "no_weekend_onsite_schedule"
  | "zero_weekend_preference_distribution";

export interface WeekendDemandCaptureReadiness {
  ready: boolean;
  reasonCodes: WeekendDemandCaptureReadinessReasonCode[];
  packageMixRows: number;
  scenarioDriverRows: number;
  activePhysicalRooms: number;
  seedSessionRows: number;
  weekendOnsiteSessionRows: number;
  weekendPreferenceBuckets: number;
  weekendDemandShare: number;
  generatedAt: string;
}

export interface RoomCapacityForecastResponse {
  model: {
    status: "ready" | "missing";
    modelRunId: string | null;
    sourceLabel: string | null;
    forecastStart: string | null;
    forecastEnd: string | null;
    importedAt: string | null;
  };
  scenario: string;
  scenarios: string[];
  generatedAt: string;
  weekdayResults: WeekdaySaturationResult[];
  weekendDemandBreakpoint: WeekendDemandBreakpoint | null;
  weekendDemandCaptureReadiness: WeekendDemandCaptureReadiness | null;
  monthlyDrivers: RoomCapacityForecastDriver[];
}
