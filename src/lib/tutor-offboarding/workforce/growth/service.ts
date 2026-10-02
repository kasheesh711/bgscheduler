import type { Database } from "@/lib/db";
import { TutorOffboardingError } from "../../errors";
import { workforceContentHash } from "../observations";
import { cachedWorkforceRead, invalidateWorkforceReadCache, workforceReadKey, workforceReportDeadline, WORKFORCE_READ_CACHE_MS } from "../read-cache";
import type { WorkforceQuality } from "../types";
import { buildAllGrowthFlows } from "./flows";
import { buildGrowthForecast, selectGrowthFlows } from "./forecast";
import { monthOf } from "./calendar";
import { loadGrowthEvidence } from "./store";
import type { GrowthDetailQuery, GrowthDrilldown, GrowthEvidence, GrowthQuery, GrowthReport } from "./types";

const ALGORITHM_VERSION = "course-growth-v1";
const unique = (values: string[]) => [...new Set(values)].sort();
function calculationTime(revision: string | undefined, now: Date): Date {
  if (!revision) return now;
  const match = /^g1:(\d{13}):[a-f0-9]{64}$/.exec(revision);
  const instant = match ? Number(match[1]) : NaN;
  if (!Number.isFinite(instant) || instant > now.getTime()) throw new TutorOffboardingError('Refresh the growth report before opening details or exporting.', 409);
  return new Date(instant);
}

function qualityOf(...values: WorkforceQuality[]): WorkforceQuality {
  const completeness = values.some(value => value.completeness === "unknown") ? "unknown"
    : values.some(value => value.completeness === "partial") ? "partial" : "complete";
  return { completeness, issueCodes: unique(values.flatMap(value => value.issueCodes)),
    sourceCoverage: [...new Map(values.flatMap(value => value.sourceCoverage).map(row => [JSON.stringify(row), row])).values()],
    exceptions: [...new Map(values.flatMap(value => value.exceptions).map(row => [JSON.stringify(row), row])).values()] };
}

export function buildGrowthReport(evidence: GrowthEvidence, query: GrowthQuery, now: Date): GrowthReport {
  const fullFlows = buildAllGrowthFlows(evidence, now);
  const flows = selectGrowthFlows(fullFlows, query);
  const forecast = buildGrowthForecast(evidence, flows, query, now, fullFlows);
  const quality = qualityOf(flows.quality, forecast.quality);
  // Hash calculated state as well as evidence: crossing a maturity boundary must invalidate details.
  const digest = workforceContentHash({ algorithm: ALGORITHM_VERSION, evidence: evidence.revision, query, flows, forecast, quality });
  const reportRevision = `g1:${now.getTime()}:${digest}`;
  return { schemaVersion: 1, reportRevision, generatedAt: now.toISOString(), query, flows, forecast, quality };
}

/** Database reads and pure calculations only. Ingestion owns lifecycle persistence. */
export async function getGrowthReport(db: Database, query: GrowthQuery, now = new Date(), revision?: string, refresh = false): Promise<GrowthReport> {
  const asOf = calculationTime(revision, now);
  if (revision) return buildGrowthReport(await loadGrowthEvidence(db, now), query, asOf);
  if (refresh) invalidateWorkforceReadCache();
  return cachedWorkforceRead(db, 'growth-report', workforceReadKey(query), async () => {
    const loaded = await cachedWorkforceRead(db, 'growth-evidence', 'all', async () => ({ evidence: await loadGrowthEvidence(db, now), asOf }), refresh, value => value.asOf.getTime() + WORKFORCE_READ_CACHE_MS);
    return buildGrowthReport(loaded.evidence, query, loaded.asOf);
  }, refresh, workforceReportDeadline);
}

function readOffset(query: GrowthDetailQuery): number {
  if (!query.cursor) return 0;
  try {
    const cursor = JSON.parse(Buffer.from(query.cursor, "base64url").toString("utf8"));
    if (cursor.revision !== query.reportRevision || cursor.kind !== query.kind || cursor.key !== query.key
      || !Number.isSafeInteger(cursor.offset) || cursor.offset < 0) throw new Error("cursor mismatch");
    return cursor.offset;
  } catch { throw new TutorOffboardingError("The detail cursor is invalid. Reopen the chart detail.", 400); }
}

export async function getGrowthDrilldown(db: Database, query: GrowthDetailQuery, now = new Date()): Promise<GrowthDrilldown> {
  const asOf = calculationTime(query.reportRevision, now);
  const evidence = await loadGrowthEvidence(db, now);
  const report = buildGrowthReport(evidence, { filters: query.filters, assumptions: query.assumptions }, asOf);
  if (report.reportRevision !== query.reportRevision) throw new TutorOffboardingError("The report changed. Refresh before opening details.", 409);
  const offset = readOffset(query), pageSize = query.pageSize ?? 100;
  const row = report.flows.months.find(value => value.key === query.key);
  const event = query.kind === "churn" ? report.flows.lifecycleEvents.find(value => value.eventKey === query.key) : undefined;
  const capacity = query.kind === "capacity" ? report.forecast.months.find(value => value.key === query.key)
    ?? report.forecast.allocations.flatMap(value => value.cells).find(value => value.key === query.key) : undefined;
  if (query.kind === "capacity" ? !capacity : !row && !event) throw new TutorOffboardingError("This chart detail no longer exists in the selected report.", 404);

  const contributors = row?.contributors ?? { studentIds: event ? [event.studentId] : [], sessionIds: event?.sourceSessionIds ?? [], eventKeys: event ? [event.eventKey] : [] };
  const ids = new Set(contributors.sessionIds), eventKeys = new Set(contributors.eventKeys);
  const sessions = evidence.workforce.sessions.filter(session => capacity ? monthOf(session.startAt) === capacity.month : ids.has(session.wiseSessionId));
  const events = report.flows.lifecycleEvents.filter(value => eventKeys.has(value.eventKey));
  const personKeys = new Set(sessions.flatMap(session => session.canonicalTutorKeys));
  if (capacity) for (const benchmark of report.forecast.hiring.filter(value => value.courseKey === capacity.courseKey && value.month === capacity.month)) {
    for (const key of benchmark.benchmarkPersonKeys) personKeys.add(key);
  }
  const observations = capacity ? evidence.workforce.observations.filter(value => personKeys.has(value.canonicalKey)) : [];
  const records = [
    ...sessions.map(value => ({ sortKey: `session:${value.wiseSessionId}`, kind: "session" as const, value })),
    ...events.map(value => ({ sortKey: `event:${value.eventKey}:${value.revision}`, kind: "event" as const, value })),
    ...observations.map(value => ({ sortKey: `observation:${value.id}`, kind: "observation" as const, value })),
  ].sort((a, b) => a.sortKey.localeCompare(b.sortKey));
  if (offset > records.length) throw new TutorOffboardingError("The detail cursor is outside this report.", 400);
  const page = records.slice(offset, offset + pageSize), nextOffset = offset + page.length;
  return { reportRevision: report.reportRevision, kind: query.kind, key: query.key,
    contributors: capacity ? { studentIds: unique(sessions.flatMap(value => value.historicalBookedStudentIds ?? [])), sessionIds: sessions.map(value => value.wiseSessionId).sort(), eventKeys: [] } : contributors,
    sessions: page.filter(value => value.kind === "session").map(value => value.value),
    events: page.filter(value => value.kind === "event").map(value => value.value),
    observations: page.filter(value => value.kind === "observation").map(value => value.value),
    // Unmapped bookings can affect certainty without belonging to a course's
    // contributors. Keep report-wide uncertainty visible on every detail page.
    exceptions: report.quality.exceptions,
    nextCursor: nextOffset < records.length ? Buffer.from(JSON.stringify({ revision: report.reportRevision, kind: query.kind, key: query.key, offset: nextOffset })).toString("base64url") : null,
  };
}
