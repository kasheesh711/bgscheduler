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
  availability: boolean[]; // parallel to subSlots
}

export interface RangeSearchResponse {
  snapshotMeta: SnapshotMeta;
  subSlots: { start: string; end: string }[];
  grid: RangeGridRow[];
  needsReview: TutorReviewResult[];
  latencyMs: number;
  warnings: string[];
}
