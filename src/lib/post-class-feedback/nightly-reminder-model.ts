import { addBangkokDays, bangkokDateStartUtc, todayBangkok } from "@/lib/room-capacity/dates";
import { POST_CLASS_MIN_COMBINED_CHARACTERS } from "./policy";

export type NightlyMode = "off" | "shadow" | "live";
export const NIGHTLY_FRESHNESS_MS = 20 * 60_000;
export const NIGHTLY_RETRY_MINUTES = [30, 90, 180] as const;
export const NIGHTLY_TERMINAL = ["sent", "excluded", "expired", "superseded"] as const;

export function nightlyCheckpoint(date: string): Date {
  return new Date(bangkokDateStartUtc(date).getTime() + 22 * 60 * 60_000);
}

/** The clock, never the spreadsheet timezone, determines the eligible night. */
export function latestNightlyDate(now: Date, activatedAt: Date | null): string | null {
  if (!activatedAt) return null;
  const today = todayBangkok(now);
  const date = now >= nightlyCheckpoint(today) ? today : addBangkokDays(today, -1);
  return nightlyCheckpoint(date) >= activatedAt ? date : null;
}

export function nightlyWindow(date: string) {
  return {
    startDate: addBangkokDays(date, -2),
    endDate: addBangkokDays(date, 1), // Wise's exclusive bound
    start: bangkokDateStartUtc(addBangkokDays(date, -2)),
    cutoff: nightlyCheckpoint(date),
  };
}

export interface NightlySessionState {
  eligible: boolean;
  enforcementMode: string;
  sourceStatus: string;
  canonicalTutorKey: string | null;
  lastObservedAt: Date | null;
  scheduledEndAt: Date;
  deadlineAt: Date;
  deleted?: boolean;
  policyCurrent?: boolean;
  assessment: {
    sourceStatus: string;
    adjustedCompliant: boolean;
    combinedRawCharCount: number;
    fieldFailures: string[];
    details: Record<string, unknown>;
  } | null;
}

export function nightlyDisposition(state: NightlySessionState | null, now: Date, cutoff: Date): {
  status: "ready" | "excluded" | "expired" | "blocked_source";
  reason: string | null;
} {
  if (!state) return { status: "blocked_source", reason: "Session has not been imported from Wise." };
  if (state.deleted) return { status: "excluded", reason: "Wise deletion was verified." };
  if (!state.lastObservedAt || state.lastObservedAt.getTime() < now.getTime() - NIGHTLY_FRESHNESS_MS) {
    return { status: "blocked_source", reason: "Fresh Wise feedback is required." };
  }
  if (state.sourceStatus !== "ready" || state.policyCurrent === false) {
    return { status: "blocked_source", reason: "Current Wise evidence and policy versions are required." };
  }
  if (state.scheduledEndAt > cutoff) return { status: "excluded", reason: "Class ended after the nightly cutoff." };
  if (!state.eligible || state.enforcementMode !== "live") {
    return { status: "excluded", reason: "Current feedback policy does not apply to this class." };
  }
  if (state.sourceStatus !== "ready" || !state.canonicalTutorKey || !state.assessment || state.assessment.sourceStatus !== "ready") {
    return { status: "blocked_source", reason: "Wise feedback or tutor identity is unresolved." };
  }
  if (state.assessment.details.policyApplies !== true) {
    return { status: "excluded", reason: "Current feedback policy does not apply to this class." };
  }
  if (state.assessment.adjustedCompliant || (state.assessment.combinedRawCharCount >= POST_CLASS_MIN_COMBINED_CHARACTERS &&
      !state.assessment.fieldFailures.includes("all_fields_placeholder"))) {
    return { status: "excluded", reason: "Feedback is complete." };
  }
  if (state.deadlineAt <= now) return { status: "expired", reason: "Feedback deadline passed before reminder acceptance." };
  return { status: "ready", reason: null };
}

export function nightlyCounts(rows: readonly { status: string }[]) {
  const count = (status: string) => rows.filter((row) => row.status === status).length;
  return {
    considered: rows.length,
    sent: count("sent"),
    excluded: count("excluded"),
    expired: count("expired"),
    superseded: count("superseded"),
    ready: count("ready"),
    blockedSource: count("blocked_source"),
    blockedRecipient: count("blocked_recipient"),
    unknown: count("unknown"),
    failed: count("failed"),
    pending: count("pending") + count("queued"),
  };
}
