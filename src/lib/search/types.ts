// ── Search request/response types ────────────────────────────────────

export type SearchMode = "recurring" | "one_time";

export interface SearchSlot {
  id: string;
  dayOfWeek?: number; // 0=Sunday..6=Saturday (for recurring)
  date?: string; // ISO date (for one_time)
  start: string; // "HH:mm"
  end: string; // "HH:mm"
  mode: "online" | "onsite" | "either";
}

export interface SearchFilters {
  subject?: string;
  curriculum?: string;
  level?: string;
}

export interface SearchRequest {
  searchMode: SearchMode;
  slots: SearchSlot[];
  filters?: SearchFilters;
  rawInput?: string;
}

export interface SnapshotMeta {
  snapshotId: string;
  syncedAt: string;
  stale: boolean;
}

export interface TutorResult {
  tutorGroupId: string;
  displayName: string;
  supportedModes: string[];
  qualifications: { subject: string; curriculum: string; level: string; examPrep?: string }[];
  underlyingWiseRecords: { wiseTeacherId: string; wiseDisplayName: string; isOnline: boolean }[];
}

export interface TutorReviewResult extends TutorResult {
  reasons: string[];
}

export interface SlotResult {
  slotId: string;
  available: TutorResult[];
  needsReview: TutorReviewResult[];
}

export interface SearchResponse {
  snapshotMeta: SnapshotMeta;
  normalizedSlots: SearchSlot[];
  perSlotResults: SlotResult[];
  intersection: TutorResult[];
  latencyMs: number;
  warnings: string[];
}

// ── Blocking session info ───────────────────────────────────────────

export interface BlockingSessionInfo {
  title?: string;
  studentName?: string;
  subject?: string;
  classType?: string;
  recurrenceId?: string;
  location?: string;
  startTime: string; // "HH:mm"
  endTime: string;   // "HH:mm"
}

// ── Range search types ──────────────────────────────────────────────

export interface RangeSearchRequest {
  searchMode: SearchMode;
  dayOfWeek?: number;
  date?: string;
  startTime: string; // "HH:mm"
  endTime: string;   // "HH:mm"
  durationMinutes: number; // 60, 90, or 120
  mode: "online" | "onsite" | "either";
  filters?: SearchFilters;
}

export interface RangeGridRow {
  tutorGroupId: string;
  displayName: string;
  supportedModes: string[];
  qualifications: { subject: string; curriculum: string; level: string; examPrep?: string }[];
  availability: (true | BlockingSessionInfo[])[]; // true = available, BlockingSessionInfo[] = blocking sessions
}

export interface RangeSearchResponse {
  snapshotMeta: SnapshotMeta;
  subSlots: { start: string; end: string }[];
  grid: RangeGridRow[];
  needsReview: TutorReviewResult[];
  latencyMs: number;
  warnings: string[];
}

// ── Compare types ──────────────────────────────────────────────────

export interface CompareRequest {
  tutorGroupIds: string[];          // 1-3 tutor group IDs
  mode: "recurring" | "one_time";
  dayOfWeek?: number;               // for recurring (0-6)
  date?: string;                    // ISO date for one_time
}

export interface CompareSessionBlock {
  title?: string;
  studentName?: string;
  subject?: string;
  classType?: string;
  sessionType?: string;
  recurrenceId?: string;
  location?: string;
  modality: "online" | "onsite" | "unknown";
  startTime: string;    // "HH:mm"
  endTime: string;      // "HH:mm"
  weekday: number;
  startMinute: number;
  endMinute: number;
}

export interface CompareTutor {
  tutorGroupId: string;
  displayName: string;
  supportedModes: string[];
  qualifications: { subject: string; curriculum: string; level: string; examPrep?: string }[];
  sessions: CompareSessionBlock[];
  availabilityWindows: { weekday: number; startMinute: number; endMinute: number; modality: string }[];
  leaves: { startTime: string; endTime: string }[];
  dataIssues: { type: string; message: string }[];
  weeklyHoursBooked: number;
  studentCount: number;
}

export interface Conflict {
  studentName: string;
  dayOfWeek: number;
  startMinute: number;
  endMinute: number;
  tutorA: { tutorGroupId: string; displayName: string; sessionTitle: string };
  tutorB: { tutorGroupId: string; displayName: string; sessionTitle: string };
}

export interface SharedFreeSlot {
  dayOfWeek: number;
  startMinute: number;
  endMinute: number;
}

export interface CompareResponse {
  snapshotMeta: SnapshotMeta;
  tutors: CompareTutor[];
  conflicts: Conflict[];
  sharedFreeSlots: SharedFreeSlot[];
  latencyMs: number;
  warnings: string[];
}

export interface DiscoverRequest {
  existingTutorGroupIds: string[];
  mode: "recurring" | "one_time";
  dayOfWeek?: number;
  date?: string;
  startTime?: string;    // "HH:mm"
  endTime?: string;      // "HH:mm"
  modeFilter?: "online" | "onsite" | "either";
  filters?: SearchFilters;
}

export interface DiscoverCandidate {
  tutorGroupId: string;
  displayName: string;
  supportedModes: string[];
  qualifications: { subject: string; curriculum: string; level: string; examPrep?: string }[];
  conflictCount: number;
  conflicts: Conflict[];
  freeSlots: { start: string; end: string }[];
  hasDataIssues: boolean;
  dataIssueReasons: string[];
}

export interface DiscoverResponse {
  snapshotMeta: SnapshotMeta;
  candidates: DiscoverCandidate[];
  latencyMs: number;
}
