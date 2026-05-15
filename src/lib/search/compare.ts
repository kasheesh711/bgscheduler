import { toZonedTime } from "date-fns-tz";
import type { IndexedSessionBlock, IndexedTutorGroup } from "./index";
import type { CompareTutor, CompareSessionBlock, Conflict, SharedFreeSlot } from "./types";

// "scheduled" covers tenant "SCHEDULED"/"Live" online-session vocabulary (MOD-UAT-01, 2026-04-21).
const ONLINE_SESSION_TYPES = new Set(["online", "virtual", "scheduled"]);
const ONSITE_SESSION_TYPES = new Set(["onsite", "in-person", "offline"]);

export interface DateRange {
  start: Date;
  end: Date;
}

function formatMinute(minute: number): string {
  const h = Math.floor(minute / 60);
  const m = minute % 60;
  return `${String(h).padStart(2, "0")}:${String(m).padStart(2, "0")}`;
}

function formatDate(d: Date): string {
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, "0");
  const day = String(d.getDate()).padStart(2, "0");
  return `${y}-${m}-${day}`;
}

/**
 * Start of today (00:00) in Asia/Bangkok, returned as a Date representing
 * that BKK instant. Used by buildCompareTutor (D-05) to decide whether a
 * calendar date in the requested dateRange is "historical" (→ disable
 * weekday-fallback) or "today-or-future" (→ keep existing fallback).
 *
 * Extracted as a helper so tests can mock `Date.now()` deterministically.
 * Thailand has no DST (stable UTC+7 since 1941) per PITFALLS.md §Assumptions A7.
 */
export function getStartOfTodayBkk(now: Date = new Date()): Date {
  const nowInBkk = toZonedTime(now, "Asia/Bangkok");
  return new Date(nowInBkk.getFullYear(), nowInBkk.getMonth(), nowInBkk.getDate());
}

/**
 * Given a weekday (0=Sunday..6=Saturday) and a dateRange whose `start` is the
 * Monday of the requested week, return the calendar date within the range
 * that corresponds to that weekday, or null if the weekday falls outside the
 * range. Mirrors the client-side `getWeekDate` helper in use-compare.ts:53-59
 * to avoid off-by-one divergence.
 *
 * Weekday→offset mapping (Monday as first day of week in dateRange):
 *   Mon(1) → offset 0, Tue(2) → 1, Wed(3) → 2, Thu(4) → 3, Fri(5) → 4,
 *   Sat(6) → 5, Sun(0) → 6.
 */
export function computeDateForWeekdayInRange(weekday: number, dateRange: DateRange): Date | null {
  const offset = weekday === 0 ? 6 : weekday - 1;
  const date = new Date(
    dateRange.start.getFullYear(),
    dateRange.start.getMonth(),
    dateRange.start.getDate() + offset,
  );
  if (date < dateRange.start || date >= dateRange.end) return null;
  return date;
}

/**
 * Resolved modality for a single session, with confidence grading.
 *
 * Confidence rubric (see `.planning/phases/06-mod-01-reliable-modality-detection/06-CONTEXT.md` D-01..D-08):
 * - `"high"`  — group is single-record (only one modality possible) OR paired group
 *               where `sessionType` agrees with `teacherRecord.isOnlineVariant`.
 * - `"medium"` — reserved for future phases (no emission in MOD-01).
 * - `"low"`  — paired group where `sessionType` is missing (inferred from
 *               `isOnlineVariant` only; data layer keeps the inference, UI renders
 *               this identical to `"unknown"` per D-14).
 *
 * Contradictions (D-07, D-08):
 * - Paired group + `sessionType` disagrees with `teacherRecord.isOnlineVariant`
 *   → `{ modality: "unknown", confidence: "low", contradiction: ... }`.
 * - Single-record group + `sessionType` disagrees with the group's modality
 *   → same treatment (fail-closed wins over pragmatism).
 *
 * The silent single-element `supportedModes` fallback from the pre-MOD-01
 * cascade is intentionally deleted (MOD-02) — fail-closed rule per
 * AGENTS.md:146-149.
 */
export interface SessionModalityResolution {
  modality: CompareSessionBlock["modality"];
  confidence: CompareSessionBlock["modalityConfidence"];
  contradiction?: {
    /** Human-readable description naming both disagreeing signals. */
    message: string;
    /** isOnlineVariant the session's teacherRecord reported (or null if no record). */
    isOnlineVariant: boolean | null;
    /** Normalized sessionType string (lowercase, trimmed). */
    sessionType: string;
  };
}

export function resolveSessionModality(
  group: IndexedTutorGroup,
  session: IndexedTutorGroup["sessionBlocks"][number],
): SessionModalityResolution {
  const teacherRecord = group.wiseRecords.find(
    (record) => record.wiseTeacherId === session.wiseTeacherId,
  );
  const normalizedType = session.sessionType?.trim().toLowerCase();
  const typeSaysOnline = !!normalizedType && ONLINE_SESSION_TYPES.has(normalizedType);
  const typeSaysOnsite = !!normalizedType && ONSITE_SESSION_TYPES.has(normalizedType);
  const hasType = typeSaysOnline || typeSaysOnsite;

  const modes = group.supportedModes;
  const isPaired = modes.includes("online") && modes.includes("onsite");
  const isSingleOnline = modes.length === 1 && modes[0] === "online";
  const isSingleOnsite = modes.length === 1 && modes[0] === "onsite";
  const recordIsOnline = teacherRecord?.isOnline ?? null;

  // 1. Paired groups — require sessionType corroboration for high confidence.
  if (isPaired && teacherRecord) {
    if (hasType) {
      const typeModality: "online" | "onsite" = typeSaysOnline ? "online" : "onsite";
      const recordModality: "online" | "onsite" = recordIsOnline ? "online" : "onsite";
      if (typeModality === recordModality) {
        // Both signals agree → high confidence.
        return { modality: recordModality, confidence: "high" };
      }
      // Contradiction (D-07): unknown + emit conflict_model.
      return {
        modality: "unknown",
        confidence: "low",
        contradiction: {
          message: `Paired group "${group.displayName}" has contradicting modality signals: teacher record isOnlineVariant=${recordIsOnline} but session sessionType="${normalizedType}"`,
          isOnlineVariant: recordIsOnline,
          sessionType: normalizedType ?? "",
        },
      };
    }
    // Paired + sessionType missing → inferred from isOnlineVariant; confidence low (D-04).
    const inferred: "online" | "onsite" = recordIsOnline ? "online" : "onsite";
    return { modality: inferred, confidence: "low" };
  }

  // 2. Single-record groups — contradiction if sessionType disagrees with the group's only mode.
  if (isSingleOnline) {
    if (typeSaysOnsite) {
      return {
        modality: "unknown",
        confidence: "low",
        contradiction: {
          message: `Single-record online group "${group.displayName}" has contradicting sessionType="${normalizedType}"`,
          isOnlineVariant: recordIsOnline,
          sessionType: normalizedType ?? "",
        },
      };
    }
    return { modality: "online", confidence: "high" };
  }
  if (isSingleOnsite) {
    if (typeSaysOnline) {
      return {
        modality: "unknown",
        confidence: "low",
        contradiction: {
          message: `Single-record onsite group "${group.displayName}" has contradicting sessionType="${normalizedType}"`,
          isOnlineVariant: recordIsOnline,
          sessionType: normalizedType ?? "",
        },
      };
    }
    return { modality: "onsite", confidence: "high" };
  }

  // 3. Unresolved group (supportedModes is empty) — fail-closed. No silent single-mode fallback (MOD-02).
  return { modality: "unknown", confidence: "low" };
}

/**
 * Detect a modality contradiction for a single Wise session during sync
 * time, without requiring an IndexedTutorGroup. Mirrors the paired-group
 * and single-record-group contradiction branches of resolveSessionModality.
 * Returns `null` when no contradiction is present.
 *
 * Called from `src/lib/sync/orchestrator.ts` during the per-session iteration
 * so contradictions land in the `data_issues` table as `conflict_model` rows,
 * which flow through to /data-health via the existing counter (extended in
 * Plan 03).
 */
export function detectSessionModalityConflict(input: {
  supportedModality: "online" | "onsite" | "both" | "unresolved";
  isOnlineVariant: boolean;
  sessionType: string | null | undefined;
  groupDisplayName: string;
}): { message: string; sessionType: string; isOnlineVariant: boolean } | null {
  const normalizedType = input.sessionType?.trim().toLowerCase();
  const typeSaysOnline = !!normalizedType && ONLINE_SESSION_TYPES.has(normalizedType);
  const typeSaysOnsite = !!normalizedType && ONSITE_SESSION_TYPES.has(normalizedType);
  if (!typeSaysOnline && !typeSaysOnsite) return null; // no sessionType → nothing to contradict
  const recordModality: "online" | "onsite" = input.isOnlineVariant ? "online" : "onsite";

  if (input.supportedModality === "both") {
    const typeModality = typeSaysOnline ? "online" : "onsite";
    if (typeModality !== recordModality) {
      return {
        message: `Paired group "${input.groupDisplayName}" has contradicting modality signals: teacher record isOnlineVariant=${input.isOnlineVariant} but session sessionType="${normalizedType}"`,
        sessionType: normalizedType ?? "",
        isOnlineVariant: input.isOnlineVariant,
      };
    }
    return null;
  }
  if (input.supportedModality === "online" && typeSaysOnsite) {
    return {
      message: `Single-record online group "${input.groupDisplayName}" has contradicting sessionType="${normalizedType}"`,
      sessionType: normalizedType ?? "",
      isOnlineVariant: input.isOnlineVariant,
    };
  }
  if (input.supportedModality === "onsite" && typeSaysOnline) {
    return {
      message: `Single-record onsite group "${input.groupDisplayName}" has contradicting sessionType="${normalizedType}"`,
      sessionType: normalizedType ?? "",
      isOnlineVariant: input.isOnlineVariant,
    };
  }
  return null;
}

export function buildCompareTutor(
  group: IndexedTutorGroup,
  weekdays?: number[],
  dateRange?: DateRange,
  pastBlocks?: IndexedSessionBlock[],
): CompareTutor {
  const weekdaySet = weekdays ? new Set(weekdays) : null;

  // D-06: Merge past blocks into the filter input BEFORE filtering. Past
  // blocks have already been date-range-filtered by the Plan 03 fetcher; the
  // concat is safe and does not duplicate sessions (past and future are
  // disjoint by definition — future session blocks have startTime >= now,
  // captured past rows have startTime < now at capture time).
  const allBlocks = pastBlocks && pastBlocks.length > 0
    ? [...group.sessionBlocks, ...pastBlocks]
    : group.sessionBlocks;

  const filtered = allBlocks.filter((s) => {
    if (!s.isBlocking) return false;
    if (dateRange) {
      if (s.startTime < dateRange.start || s.startTime >= dateRange.end) return false;
    }
    if (weekdaySet && !weekdaySet.has(s.weekday)) return false;
    return true;
  });

  // D-05 / PAST-04: per-weekday `isHistoricalRange` evaluation. The
  // nearest-future-occurrence fallback runs only for weekdays whose calendar
  // date is today or in the future. Past weekdays render honest empty (D-09)
  // unless we captured real past data in pastBlocks.
  if (dateRange) {
    const startOfTodayBkk = getStartOfTodayBkk();
    const coveredWeekdays = new Set(filtered.map((s) => s.weekday));
    const targetWeekdays = weekdaySet
      ? new Set(weekdaySet)
      : new Set([0, 1, 2, 3, 4, 5, 6]);

    for (const wd of targetWeekdays) {
      if (coveredWeekdays.has(wd)) continue;

      // D-05: calendar date for this weekday within dateRange. If it's before
      // today (BKK), disable the fallback for this weekday only — honest empty.
      const dateForWeekday = computeDateForWeekdayInRange(wd, dateRange);
      if (dateForWeekday && dateForWeekday < startOfTodayBkk) continue;

      // Existing nearest-future-occurrence fallback (unchanged semantics for
      // today + future days — uses `allBlocks` so future blocks are candidates;
      // past blocks cannot satisfy `startTime >= dateRange.end` since they
      // have startTime < now).
      const seenRecurrence = new Set<string>();
      const fallback = allBlocks
        .filter((s) => s.isBlocking && s.weekday === wd && s.startTime >= dateRange.end)
        .sort((a, b) => a.startTime.getTime() - b.startTime.getTime())
        .filter((s) => {
          if (s.recurrenceId) {
            if (seenRecurrence.has(s.recurrenceId)) return false;
            seenRecurrence.add(s.recurrenceId);
          }
          return true;
        });

      if (fallback.length > 0) {
        const firstDate = fallback[0].startTime.toDateString();
        filtered.push(...fallback.filter((s) => s.startTime.toDateString() === firstDate));
      }
    }
  }

  const sessions: CompareSessionBlock[] = filtered.map((s) => {
    const { modality, confidence } = resolveSessionModality(group, s);
    return {
      title: s.title, studentName: s.studentName, subject: s.subject,
      classType: s.classType, sessionType: s.sessionType, recurrenceId: s.recurrenceId, location: s.location,
      modality,
      modalityConfidence: confidence,
      startTime: formatMinute(s.startMinute), endTime: formatMinute(s.endMinute),
      date: dateRange ? formatDate(s.startTime) : undefined,
      weekday: s.weekday, startMinute: s.startMinute, endMinute: s.endMinute,
    };
  });

  const totalMinutes = filtered.reduce((sum, s) => sum + (s.endMinute - s.startMinute), 0);
  const studentNames = new Set(filtered.map((s) => s.studentName).filter(Boolean));

  return {
    tutorGroupId: group.id, tutorCanonicalKey: group.canonicalKey, displayName: group.displayName,
    supportedModes: group.supportedModes, qualifications: group.qualifications,
    sessions,
    availabilityWindows: group.availabilityWindows.map((w) => ({ weekday: w.weekday, startMinute: w.startMinute, endMinute: w.endMinute, modality: w.modality })),
    leaves: group.leaves.map((l) => ({ startTime: l.startTime.toISOString(), endTime: l.endTime.toISOString() })),
    dataIssues: group.dataIssues,
    weeklyHoursBooked: Math.round((totalMinutes / 60) * 100) / 100,
    studentCount: studentNames.size,
  };
}

export function detectConflicts(compareTutors: CompareTutor[]): Conflict[] {
  const conflicts: Conflict[] = [];
  const studentSessions = new Map<string, { tutorIdx: number; session: CompareSessionBlock }[]>();

  for (let i = 0; i < compareTutors.length; i++) {
    for (const session of compareTutors[i].sessions) {
      if (!session.studentName) continue;
      const key = session.studentName.toLowerCase();
      if (!studentSessions.has(key)) studentSessions.set(key, []);
      studentSessions.get(key)!.push({ tutorIdx: i, session });
    }
  }

  const seen = new Set<string>();
  for (const [, entries] of studentSessions) {
    for (let i = 0; i < entries.length; i++) {
      for (let j = i + 1; j < entries.length; j++) {
        const a = entries[i], b = entries[j];
        if (a.tutorIdx === b.tutorIdx) continue;
        if (a.session.weekday !== b.session.weekday) continue;
        if (a.session.startMinute < b.session.endMinute && a.session.endMinute > b.session.startMinute) {
          const dedup = [a.session.studentName, a.session.weekday, Math.min(a.tutorIdx, b.tutorIdx), Math.max(a.tutorIdx, b.tutorIdx)].join("|");
          if (seen.has(dedup)) continue;
          seen.add(dedup);
          conflicts.push({
            studentName: a.session.studentName!,
            dayOfWeek: a.session.weekday,
            startMinute: Math.max(a.session.startMinute, b.session.startMinute),
            endMinute: Math.min(a.session.endMinute, b.session.endMinute),
            tutorA: { tutorGroupId: compareTutors[a.tutorIdx].tutorGroupId, displayName: compareTutors[a.tutorIdx].displayName, sessionTitle: a.session.title ?? `${a.session.subject ?? "Session"} — ${a.session.studentName}` },
            tutorB: { tutorGroupId: compareTutors[b.tutorIdx].tutorGroupId, displayName: compareTutors[b.tutorIdx].displayName, sessionTitle: b.session.title ?? `${b.session.subject ?? "Session"} — ${b.session.studentName}` },
          });
        }
      }
    }
  }
  return conflicts;
}

export function findSharedFreeSlots(
  groups: IndexedTutorGroup[],
  weekdays: number[],
  dateRange?: DateRange,
): SharedFreeSlot[] {
  if (groups.length === 0) return [];
  const results: SharedFreeSlot[] = [];

  for (const weekday of weekdays) {
    const freePerTutor: { start: number; end: number }[][] = [];
    for (const group of groups) {
      const windows = group.availabilityWindows.filter((w) => w.weekday === weekday);
      if (windows.length === 0) { freePerTutor.push([]); continue; }
      const blocks = group.sessionBlocks
        .filter((s) => {
          if (!s.isBlocking || s.weekday !== weekday) return false;
          if (dateRange) {
            if (s.startTime < dateRange.start || s.startTime >= dateRange.end) return false;
          }
          return true;
        })
        .sort((a, b) => a.startMinute - b.startMinute);
      const free: { start: number; end: number }[] = [];
      for (const w of windows) {
        let cursor = w.startMinute;
        for (const b of blocks) {
          if (b.startMinute >= w.endMinute) break;
          if (b.endMinute <= cursor) continue;
          if (b.startMinute > cursor) free.push({ start: cursor, end: Math.min(b.startMinute, w.endMinute) });
          cursor = Math.max(cursor, b.endMinute);
        }
        if (cursor < w.endMinute) free.push({ start: cursor, end: w.endMinute });
      }
      freePerTutor.push(free);
    }

    if (freePerTutor.some((f) => f.length === 0)) continue;
    let intersection = freePerTutor[0];
    for (let i = 1; i < freePerTutor.length; i++) intersection = intersectIntervals(intersection, freePerTutor[i]);
    for (const slot of intersection) {
      if (slot.end - slot.start >= 30) results.push({ dayOfWeek: weekday, startMinute: slot.start, endMinute: slot.end });
    }
  }
  return results;
}

function intersectIntervals(a: { start: number; end: number }[], b: { start: number; end: number }[]): { start: number; end: number }[] {
  const result: { start: number; end: number }[] = [];
  let i = 0, j = 0;
  while (i < a.length && j < b.length) {
    const start = Math.max(a[i].start, b[j].start);
    const end = Math.min(a[i].end, b[j].end);
    if (start < end) result.push({ start, end });
    if (a[i].end < b[j].end) i++; else j++;
  }
  return result;
}
