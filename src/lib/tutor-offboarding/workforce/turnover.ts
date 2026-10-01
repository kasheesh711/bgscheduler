import { isCancelledSession, recordedTeachingMinutes } from "./credits";
import { bangkokDayStart, bangkokMonthBounds, subtractIntervals, type Interval } from "./intervals";
import type { WorkforceEvidence, WorkforceMetric, WorkforceMonth, WorkforcePerson, WorkforceQuery, WorkforceRole } from "./types";

const DAY = 86_400_000;
const MAX_SOURCE_AGE = 90 * 60_000;
const dateValue = (value: string | null | undefined): number | null => {
  const parsed = value ? Date.parse(value) : NaN;
  return Number.isFinite(parsed) ? parsed : null;
};
const distinct = (values: string[]) => [...new Set(values)];
function metric(value: number | null, reasons: string[] = [], incomplete = false): WorkforceMetric {
  return { value, completeness: value === null ? "unknown" : incomplete ? "partial" : "complete", reasonCodes: distinct(reasons) };
}

export interface WorkforcePersonState extends WorkforcePerson {
  departedAt: string | null;
  pendingDeparture: boolean;
  markedForDeparture: boolean;
}
export type WorkforceTurnoverMonth = Pick<WorkforceMonth,
  "month" | "partialMonth" | "openingRosterCount" | "closingRosterCount" | "joinsCount" |
  "departuresCount" | "pendingCount" | "turnoverPercent" | "joinedPersonKeys" |
  "departedPersonKeys" | "pendingPersonKeys">;

function completeHistoryIntervals(evidence: WorkforceEvidence): Interval[] {
  return evidence.sourceCoverage.filter(c => c.source === "wise_history" && c.completeness === "complete" && !c.truncated)
    .flatMap(c => {
      try { return [{ start: bangkokDayStart(c.requestedFrom), end: bangkokDayStart(c.requestedTo) + DAY }]; }
      catch { return []; }
    });
}

/** Uses all retained history and the current future snapshot, not the selected chart period. */
export function buildWorkforcePersonStates(evidence: WorkforceEvidence, now: Date): WorkforcePersonState[] {
  const people = new Map<string, WorkforcePerson>();
  for (const input of evidence.people) {
    const previous = people.get(input.canonicalKey);
    const accounts = [...new Map([...(previous?.accounts ?? []), ...input.accounts].map(a => [a.wiseTeacherId, a])).values()];
    const joins = [previous?.joinedAt, input.joinedAt, ...accounts.map(a => a.joinedAt)].map(dateValue).filter((v): v is number => v !== null);
    people.set(input.canonicalKey, { ...input, accounts, joinedAt: joins.length ? new Date(Math.min(...joins)).toISOString() : null });
  }
  const sessionsByPerson = new Map<string, typeof evidence.sessions>();
  for (const session of evidence.sessions) for (const key of distinct(session.canonicalTutorKeys)) {
    const rows = sessionsByPerson.get(key) ?? [];
    rows.push(session);
    sessionsByPerson.set(key, rows);
  }
  const creditsBySession = Map.groupBy(evidence.studentCredits, c => c.wiseSessionId);
  const observationsByPerson = Map.groupBy(evidence.observations, o => o.canonicalKey);
  const marks = new Map<string, WorkforceEvidence["terminationMarks"][number]>();
  for (const mark of evidence.terminationMarks) {
    const previous = marks.get(mark.canonicalKey);
    if (!previous || mark.markedAt >= previous.markedAt) marks.set(mark.canonicalKey, mark);
  }
  const history = completeHistoryIntervals(evidence);
  const freshFuture = evidence.sourceCoverage.some(c => c.source === "wise_future_snapshot" &&
    c.completeness === "complete" && !c.truncated && dateValue(c.observedAt) !== null &&
    dateValue(c.observedAt)! <= now.getTime() && now.getTime() - dateValue(c.observedAt)! <= MAX_SOURCE_AGE);

  return [...people.values()].map(person => {
    const sessions = [...new Map((sessionsByPerson.get(person.canonicalKey) ?? []).map(s => [s.wiseSessionId, s])).values()]
      .filter(s => !s.reasonCodes.includes("absent_from_current_future_snapshot"));
    const observations = observationsByPerson.get(person.canonicalKey) ?? [];
    const teachingEvidence = observations.some(o => o.qualifications.length > 0 || o.offeredWindows.some(w => w.endMinute > w.startMinute)) ||
      sessions.some(s => (recordedTeachingMinutes(s, creditsBySession.get(s.wiseSessionId) ?? []).value ?? 0) > 0);
    const isAdmin = person.accounts.some(a => a.relation?.trim().toUpperCase() === "ADMIN");
    const isTeacher = person.accounts.some(a => a.relation?.trim().toUpperCase() === "TEACHER");
    const role: WorkforceRole | null = person.role ?? (isAdmin && teachingEvidence ? "teaching_admin" : isTeacher ? "tutor" : null);
    const reasonCodes = [...person.reasonCodes, "WISE_ROSTER_RECONSTRUCTED", "ROLE_HISTORY_RECONSTRUCTED"];
    if (!role) reasonCodes.push("ROLE_UNCONFIRMED");
    if (!person.joinedAt) reasonCodes.push("JOIN_DATE_UNKNOWN");
    const mark = marks.get(person.canonicalKey);
    const markedForDeparture = Boolean(mark && mark.status !== "cancelled");
    const pendingDeparture = markedForDeparture && sessions.some(s => {
      const end = dateValue(s.endAt) ?? dateValue(s.startAt);
      return end !== null && end > now.getTime() && !isCancelledSession(s);
    });
    let departedAt: string | null = null;
    if (markedForDeparture && !pendingDeparture) {
      let lastTaught: number | null = null;
      let lastUnknown: number | null = null;
      for (const session of sessions) {
        const end = dateValue(session.endAt) ?? dateValue(session.startAt);
        if (end === null || end > now.getTime()) continue;
        const taught = recordedTeachingMinutes(session, creditsBySession.get(session.wiseSessionId) ?? []);
        if (taught.value !== null && taught.value > 0) lastTaught = Math.max(lastTaught ?? -Infinity, end);
        else if (taught.value === null) lastUnknown = Math.max(lastUnknown ?? -Infinity, end);
      }
      const historyComplete = lastTaught !== null && subtractIntervals([{ start: lastTaught, end: now.getTime() }], history).length === 0;
      if (!freshFuture) reasonCodes.push("FUTURE_SNAPSHOT_UNCONFIRMED");
      if (!historyComplete) reasonCodes.push("DEPARTURE_HISTORY_INCOMPLETE");
      if (lastTaught !== null && (lastUnknown === null || lastUnknown <= lastTaught) && historyComplete && freshFuture) {
        departedAt = new Date(lastTaught).toISOString();
      } else reasonCodes.push("DEPARTURE_DATE_UNCONFIRMED");
    }
    return { ...person, role, departedAt, pendingDeparture, markedForDeparture, reasonCodes: distinct(reasonCodes) };
  });
}

/** Roster fields only; the report builder joins demand and capacity for each month. */
export function buildTurnoverMonths(evidence: WorkforceEvidence, query: WorkforceQuery, now: Date): WorkforceTurnoverMonth[] {
  const states = buildWorkforcePersonStates(evidence, now);
  const candidates = states.filter(p => p.role !== null && (query.role === "all" || p.role === query.role));
  const people = query.modality === "all" ? candidates : candidates.filter(p => p.accounts.some(a => a.modality === query.modality));
  const unresolvedRoles = query.role === "all" && states.some(p => p.role === null);
  const unresolvedModality = query.modality !== "all" && candidates.some(p => p.accounts.some(a => a.modality === null) || p.accounts.length === 0);
  const missingJoins = people.some(p => p.joinedAt === null);
  const uncertainDepartures = people.some(p => p.markedForDeparture && !p.pendingDeparture && p.departedAt === null);
  const unknownRemovalDates = people.some(p => p.rosterState === "off_roster" && !p.departedAt);
  const terminationSourceIncomplete = !evidence.sourceCoverage.some(c => c.source === "termination_sheet" &&
    c.completeness === "complete" && !c.truncated && !c.issueCodes.includes("unmatched_termination_identity"));
  const reasons = ["WISE_ROSTER_RECONSTRUCTED", "ROLE_HISTORY_RECONSTRUCTED",
    ...(missingJoins ? ["JOIN_DATE_UNKNOWN"] : []), ...(uncertainDepartures ? ["DEPARTURE_DATE_UNCONFIRMED"] : []),
    ...(unresolvedRoles ? ["ROLE_UNCONFIRMED"] : []), ...(unresolvedModality ? ["MODALITY_HISTORY_UNCONFIRMED"] : []),
    ...(unknownRemovalDates ? ["REMOVAL_DATE_UNKNOWN"] : []), ...(terminationSourceIncomplete ? ["TERMINATION_SOURCE_INCOMPLETE"] : [])];
  const incomplete = missingJoins || uncertainDepartures || unresolvedRoles || unresolvedModality || unknownRemovalDates || terminationSourceIncomplete;
  const selectedStart = bangkokDayStart(query.from), selectedEnd = bangkokDayStart(query.to) + DAY;
  const rows: WorkforceTurnoverMonth[] = [];
  for (let month = query.from.slice(0, 7); month <= query.to.slice(0, 7);) {
    const bounds = bangkokMonthBounds(month);
    const start = Math.max(bounds.start, selectedStart), end = Math.min(bounds.end, selectedEnd, now.getTime());
    const hasSubjectFilter = Boolean(query.subject || query.curriculum || query.level);
    // A current skill list cannot reconstruct membership at historical month boundaries.
    const unsupported = hasSubjectFilter || bounds.start >= now.getTime();
    const rowReasons = [...reasons, ...(hasSubjectFilter ? ["HISTORICAL_QUALIFICATIONS_UNAVAILABLE"] : []), ...(bounds.start >= now.getTime() ? ["FUTURE_ROSTER_UNAVAILABLE"] : [])];
    const opening = people.filter(p => dateValue(p.joinedAt) !== null && dateValue(p.joinedAt)! < bounds.start && (dateValue(p.departedAt) === null || dateValue(p.departedAt)! >= bounds.start));
    const closing = people.filter(p => dateValue(p.joinedAt) !== null && dateValue(p.joinedAt)! < end && (dateValue(p.departedAt) === null || dateValue(p.departedAt)! >= end));
    const joined = people.filter(p => dateValue(p.joinedAt) !== null && dateValue(p.joinedAt)! >= start && dateValue(p.joinedAt)! < end);
    const departed = people.filter(p => dateValue(p.departedAt) !== null && dateValue(p.departedAt)! >= start && dateValue(p.departedAt)! < end);
    const pending = people.filter(p => p.pendingDeparture && (dateValue(p.joinedAt) === null || dateValue(p.joinedAt)! < end));
    rows.push({ month, partialMonth: start > bounds.start || end < bounds.end,
      openingRosterCount: metric(unsupported ? null : opening.length, rowReasons, incomplete),
      closingRosterCount: metric(unsupported ? null : closing.length, rowReasons, incomplete),
      joinsCount: metric(unsupported ? null : joined.length, rowReasons, missingJoins || unresolvedRoles || unresolvedModality),
      departuresCount: metric(unsupported ? null : departed.length, rowReasons, uncertainDepartures || unresolvedRoles || unresolvedModality || terminationSourceIncomplete),
      pendingCount: metric(unsupported ? null : pending.length, rowReasons, unresolvedRoles || unresolvedModality || terminationSourceIncomplete),
      turnoverPercent: metric(unsupported || incomplete || opening.length === 0 ? null : departed.length / opening.length * 100,
        [...rowReasons, ...(opening.length === 0 ? ["NO_OPENING_ROSTER"] : [])]),
      joinedPersonKeys: unsupported ? [] : joined.map(p => p.canonicalKey),
      departedPersonKeys: unsupported ? [] : departed.map(p => p.canonicalKey),
      pendingPersonKeys: unsupported ? [] : pending.map(p => p.canonicalKey) });
    month = new Date(bounds.end + 7 * 3_600_000).toISOString().slice(0, 7);
  }
  return rows;
}
