import type { IndexedTutorGroup } from "./index";
import type { CompareTutor, CompareSessionBlock, Conflict, SharedFreeSlot } from "./types";

const ONLINE_SESSION_TYPES = new Set(["online", "virtual"]);
const ONSITE_SESSION_TYPES = new Set(["onsite", "in-person", "offline"]);
const ONLINE_LOCATION_PATTERNS = ["http", "zoom", "google meet", "meet.google", "virtual", "online"];
const ONSITE_LOCATION_PATTERNS = ["onsite", "in person"];

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

function resolveSessionModality(
  group: IndexedTutorGroup,
  session: IndexedTutorGroup["sessionBlocks"][number],
): CompareSessionBlock["modality"] {
  const teacherRecord = group.wiseRecords.find(
    (record) => record.wiseTeacherId === session.wiseTeacherId,
  );

  if (teacherRecord?.isOnline) {
    return "online";
  }

  if (teacherRecord && group.supportedModes.includes("onsite")) {
    return "onsite";
  }

  const normalizedType = session.sessionType?.trim().toLowerCase();
  if (normalizedType && ONLINE_SESSION_TYPES.has(normalizedType)) {
    return "online";
  }
  if (normalizedType && ONSITE_SESSION_TYPES.has(normalizedType)) {
    return "onsite";
  }

  const normalizedLocation = session.location?.trim().toLowerCase();
  if (
    normalizedLocation &&
    ONLINE_LOCATION_PATTERNS.some((pattern) => normalizedLocation.includes(pattern))
  ) {
    return "online";
  }
  if (
    normalizedLocation &&
    ONSITE_LOCATION_PATTERNS.some((pattern) => normalizedLocation.includes(pattern))
  ) {
    return "onsite";
  }

  if (group.supportedModes.length === 1) {
    return group.supportedModes[0] as CompareSessionBlock["modality"];
  }

  return "unknown";
}

export function buildCompareTutor(
  group: IndexedTutorGroup,
  weekdays?: number[],
  dateRange?: DateRange,
): CompareTutor {
  const weekdaySet = weekdays ? new Set(weekdays) : null;

  const filtered = group.sessionBlocks.filter((s) => {
    if (!s.isBlocking) return false;
    if (dateRange) {
      if (s.startTime < dateRange.start || s.startTime >= dateRange.end) return false;
    }
    if (weekdaySet && !weekdaySet.has(s.weekday)) return false;
    return true;
  });

  // Fallback: for weekdays with no sessions in the dateRange (e.g. past days
  // where Wise's "FUTURE" API didn't return data), pull in the nearest future
  // occurrence so the week view still shows a representative schedule.
  if (dateRange) {
    const coveredWeekdays = new Set(filtered.map((s) => s.weekday));
    const targetWeekdays = weekdaySet
      ? new Set(weekdaySet)
      : new Set([0, 1, 2, 3, 4, 5, 6]);

    for (const wd of targetWeekdays) {
      if (coveredWeekdays.has(wd)) continue;

      const seenRecurrence = new Set<string>();
      const fallback = group.sessionBlocks
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

  const sessions: CompareSessionBlock[] = filtered.map((s) => ({
    title: s.title, studentName: s.studentName, subject: s.subject,
    classType: s.classType, sessionType: s.sessionType, recurrenceId: s.recurrenceId, location: s.location,
    modality: resolveSessionModality(group, s),
    startTime: formatMinute(s.startMinute), endTime: formatMinute(s.endMinute),
    date: dateRange ? formatDate(s.startTime) : undefined,
    weekday: s.weekday, startMinute: s.startMinute, endMinute: s.endMinute,
  }));

  const totalMinutes = filtered.reduce((sum, s) => sum + (s.endMinute - s.startMinute), 0);
  const studentNames = new Set(filtered.map((s) => s.studentName).filter(Boolean));

  return {
    tutorGroupId: group.id, displayName: group.displayName,
    supportedModes: group.supportedModes, qualifications: group.qualifications,
    sessions,
    availabilityWindows: group.availabilityWindows.map((w) => ({ weekday: w.weekday, startMinute: w.startMinute, endMinute: w.endMinute, modality: w.modality })),
    leaves: group.leaves.map((l) => ({ startTime: l.startTime.toISOString(), endTime: l.endTime.toISOString() })),
    dataIssues: group.dataIssues,
    weeklyHoursBooked: Math.round((totalMinutes / 60) * 100) / 100,
    studentCount: studentNames.size,
  };
}

export function detectConflicts(compareTutors: CompareTutor[], indexedGroups: IndexedTutorGroup[]): Conflict[] {
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
