// ── US Universities (IPEDS) server data layer ──────────────────────────
// Cached read helpers for the admin tab. All reads hit Postgres only; the
// source .accdb/CSV are never touched at runtime. Cache invalidates on the
// "us-universities" tag (swept by a future re-import flow if added).

import { and, asc, desc, eq, inArray, sql } from "drizzle-orm";
import { cacheLife, cacheTag } from "next/cache";
import { getDb } from "@/lib/db";
import { ipedsInstitutions, ipedsCompletions, ipedsImportRuns } from "@/lib/db/schema";
import { CONTROL_LABELS, CURRENT_DATA_YEAR, cip2Label } from "./constants";
import {
  buildInstitutionConditions,
  buildInstitutionOrderBy,
  clampPagination,
  combineConditions,
} from "./query";
import { shapeAdmissionsTrend, priorDataYearOf } from "./trend";
import type {
  AcceptanceBucket,
  AcceptanceTrendPoint,
  AdmissionsTrendPoint,
  CompareInstitution,
  ControlFacet,
  FilterParams,
  InstitutionListResult,
  InstitutionProfile,
  IpedsInstitution,
  IpedsInstitutionSummary,
  ScatterPoint,
  StateFacet,
  TopMajor,
  UsUniversitiesOverview,
} from "./types";

export const US_UNIVERSITIES_CACHE_TAG = "us-universities";

const ACCEPTANCE_BUCKETS: Array<{ label: string; min: number; max: number }> = [
  { label: "Under 10%", min: 0, max: 10 },
  { label: "10–25%", min: 10, max: 25 },
  { label: "25–50%", min: 25, max: 50 },
  { label: "50–75%", min: 50, max: 75 },
  { label: "75–100%", min: 75, max: 100.01 },
];

function stripRaw(row: IpedsInstitution): IpedsInstitutionSummary {
  const { raw: _raw, ...rest } = row;
  return rest;
}

/** Compute each institution's single top major (by CIP2) from completion rows. */
function topMajorByUnit(
  completions: Array<{ unitId: number; cip2: string; count: number }>,
): Map<number, TopMajor> {
  const byUnit = new Map<number, Map<string, number>>();
  for (const c of completions) {
    let fam = byUnit.get(c.unitId);
    if (!fam) byUnit.set(c.unitId, (fam = new Map()));
    fam.set(c.cip2, (fam.get(c.cip2) ?? 0) + c.count);
  }
  const out = new Map<number, TopMajor>();
  for (const [unitId, fam] of byUnit) {
    let best: TopMajor | null = null;
    for (const [cip2, count] of fam) {
      if (!best || count > best.count) best = { cip2, label: cip2Label(cip2), count };
    }
    if (best) out.set(unitId, best);
  }
  return out;
}

// ── Admissions trends (multi-year) ─────────────────────────────────────

const TREND_COLUMNS = {
  unitId: ipedsInstitutions.unitId,
  dataYear: ipedsInstitutions.dataYear,
  acceptanceRate: ipedsInstitutions.acceptanceRate,
  yieldRate: ipedsInstitutions.yieldRate,
  applicantsTotal: ipedsInstitutions.applicantsTotal,
  admitsTotal: ipedsInstitutions.admitsTotal,
  enrolledTotal: ipedsInstitutions.enrolledTotal,
  satReadingP25: ipedsInstitutions.satReadingP25,
  satReadingP75: ipedsInstitutions.satReadingP75,
  satMathP25: ipedsInstitutions.satMathP25,
  satMathP75: ipedsInstitutions.satMathP75,
  actCompositeP25: ipedsInstitutions.actCompositeP25,
  actCompositeP75: ipedsInstitutions.actCompositeP75,
};

async function fetchAdmissionsTrend(unitIds: number[]): Promise<Map<number, AdmissionsTrendPoint[]>> {
  if (unitIds.length === 0) return new Map();
  const db = getDb();
  const rows = await db
    .select(TREND_COLUMNS)
    .from(ipedsInstitutions)
    .where(inArray(ipedsInstitutions.unitId, unitIds))
    .orderBy(asc(ipedsInstitutions.unitId), asc(ipedsInstitutions.dataYear));
  return shapeAdmissionsTrend(rows);
}

// ── Uncached implementations ───────────────────────────────────────────

async function searchInstitutionsUncached(
  params: FilterParams,
  dataYear: string,
): Promise<InstitutionListResult> {
  const db = getDb();
  const conditions = buildInstitutionConditions(params, dataYear);
  if (params.cip2) {
    const sub = db
      .select({ unitId: ipedsCompletions.unitId })
      .from(ipedsCompletions)
      .where(and(eq(ipedsCompletions.dataYear, dataYear), eq(ipedsCompletions.cip2, params.cip2)));
    conditions.push(inArray(ipedsInstitutions.unitId, sub));
  }
  const where = combineConditions(conditions);
  const { limit, offset, page, pageSize } = clampPagination(params);

  const [{ value: total }] = await db
    .select({ value: sql<number>`count(*)::int` })
    .from(ipedsInstitutions)
    .where(where);

  const rows = await db
    .select()
    .from(ipedsInstitutions)
    .where(where)
    .orderBy(buildInstitutionOrderBy(params))
    .limit(limit)
    .offset(offset);

  // Prior-year acceptance for the page's institutions → browse "trend" delta.
  const prior = priorDataYearOf(dataYear);
  const prevById = new Map<number, number | null>();
  if (prior && rows.length > 0) {
    const prevRows = await db
      .select({ unitId: ipedsInstitutions.unitId, acc: ipedsInstitutions.acceptanceRate })
      .from(ipedsInstitutions)
      .where(
        and(
          eq(ipedsInstitutions.dataYear, prior),
          inArray(ipedsInstitutions.unitId, rows.map((r) => r.unitId)),
        ),
      );
    for (const r of prevRows) prevById.set(r.unitId, r.acc);
  }

  return {
    rows: rows.map((r) => ({ ...stripRaw(r), acceptancePrevYear: prevById.get(r.unitId) ?? null })),
    total,
    page,
    pageSize,
  };
}

const EXPORT_ROW_CAP = 5000;

async function exportInstitutionsUncached(
  params: FilterParams,
  dataYear: string,
): Promise<IpedsInstitutionSummary[]> {
  const db = getDb();
  const conditions = buildInstitutionConditions(params, dataYear);
  if (params.cip2) {
    const sub = db
      .select({ unitId: ipedsCompletions.unitId })
      .from(ipedsCompletions)
      .where(and(eq(ipedsCompletions.dataYear, dataYear), eq(ipedsCompletions.cip2, params.cip2)));
    conditions.push(inArray(ipedsInstitutions.unitId, sub));
  }
  const rows = await db
    .select()
    .from(ipedsInstitutions)
    .where(combineConditions(conditions))
    .orderBy(buildInstitutionOrderBy(params))
    .limit(EXPORT_ROW_CAP);
  return rows.map(stripRaw);
}

async function getUsUniversitiesOverviewUncached(dataYear: string): Promise<UsUniversitiesOverview> {
  const db = getDb();
  const yearEq = eq(ipedsInstitutions.dataYear, dataYear);

  const [totals] = await db
    .select({
      total: sql<number>`count(*)::int`,
      withAcceptance: sql<number>`count(${ipedsInstitutions.acceptanceRate})::int`,
      avgAcceptance: sql<number | null>`avg(${ipedsInstitutions.acceptanceRate})`,
    })
    .from(ipedsInstitutions)
    .where(yearEq);

  const stateRows = await db
    .select({ state: ipedsInstitutions.stateAbbr, n: sql<number>`count(*)::int` })
    .from(ipedsInstitutions)
    .where(yearEq)
    .groupBy(ipedsInstitutions.stateAbbr)
    .orderBy(desc(sql`count(*)`));
  const states: StateFacet[] = stateRows
    .filter((r) => r.state)
    .map((r) => ({ state: r.state as string, count: r.n }));

  const controlRows = await db
    .select({ control: ipedsInstitutions.control, n: sql<number>`count(*)::int` })
    .from(ipedsInstitutions)
    .where(yearEq)
    .groupBy(ipedsInstitutions.control)
    .orderBy(desc(sql`count(*)`));
  const controls: ControlFacet[] = controlRows
    .filter((r) => r.control != null)
    .map((r) => ({
      control: r.control as number,
      label: CONTROL_LABELS[r.control as number] ?? `Control ${r.control}`,
      count: r.n,
    }));

  const acceptanceRows = await db
    .select({ acceptanceRate: ipedsInstitutions.acceptanceRate })
    .from(ipedsInstitutions)
    .where(and(yearEq, sql`${ipedsInstitutions.acceptanceRate} is not null`));
  const acceptanceBuckets: AcceptanceBucket[] = ACCEPTANCE_BUCKETS.map((b) => ({
    ...b,
    count: acceptanceRows.filter(
      (r) => r.acceptanceRate != null && r.acceptanceRate >= b.min && r.acceptanceRate < b.max,
    ).length,
  }));

  const scatterRows = await db
    .select({
      unitId: ipedsInstitutions.unitId,
      name: ipedsInstitutions.instName,
      cost: ipedsInstitutions.totalPriceInState,
      netPrice: ipedsInstitutions.avgNetPrice,
      gradRate: ipedsInstitutions.gradRateBach6yr,
      control: ipedsInstitutions.control,
    })
    .from(ipedsInstitutions)
    .where(and(yearEq, sql`${ipedsInstitutions.gradRateBach6yr} is not null`));
  const scatter: ScatterPoint[] = scatterRows.map((r) => ({
    unitId: r.unitId,
    name: r.name,
    cost: r.cost ?? r.netPrice ?? null,
    gradRate: r.gradRate,
    control: r.control,
  }));

  const cip2Rows = await db
    .selectDistinct({ cip2: ipedsCompletions.cip2 })
    .from(ipedsCompletions)
    .where(eq(ipedsCompletions.dataYear, dataYear));
  const cip2Options = cip2Rows
    .map((r) => ({ cip2: r.cip2, label: cip2Label(r.cip2) }))
    .sort((a, b) => a.label.localeCompare(b.label));

  // Aggregate acceptance rate by year for the admissions-trend chart. Restrict
  // to the canonical-year institution cohort so each year averages the SAME set
  // of schools (cross-year comparability; independent of how historical rows
  // were imported). Self-scoped via a subquery rather than the optional import flag.
  const cohortSub = db
    .select({ unitId: ipedsInstitutions.unitId })
    .from(ipedsInstitutions)
    .where(eq(ipedsInstitutions.dataYear, dataYear));
  const trendRows = await db
    .select({
      dataYear: ipedsInstitutions.dataYear,
      avg: sql<number | null>`avg(${ipedsInstitutions.acceptanceRate})`,
      n: sql<number>`count(${ipedsInstitutions.acceptanceRate})::int`,
    })
    .from(ipedsInstitutions)
    .where(inArray(ipedsInstitutions.unitId, cohortSub))
    .groupBy(ipedsInstitutions.dataYear)
    .orderBy(asc(ipedsInstitutions.dataYear));
  const acceptanceTrend: AcceptanceTrendPoint[] = trendRows.map((r) => ({
    dataYear: r.dataYear,
    avgAcceptance: r.avg != null ? Math.round(Number(r.avg) * 10) / 10 : null,
    n: r.n,
  }));

  const [lastRun] = await db
    .select({ finishedAt: ipedsImportRuns.finishedAt })
    .from(ipedsImportRuns)
    .where(and(eq(ipedsImportRuns.dataYear, dataYear), eq(ipedsImportRuns.status, "success")))
    .orderBy(desc(ipedsImportRuns.finishedAt))
    .limit(1);

  return {
    dataYear,
    totalInstitutions: totals?.total ?? 0,
    withAcceptanceRate: totals?.withAcceptance ?? 0,
    avgAcceptanceRate: totals?.avgAcceptance != null ? Number(totals.avgAcceptance) : null,
    states,
    controls,
    acceptanceBuckets,
    scatter,
    cip2Options,
    acceptanceTrend,
    lastImportedAt: lastRun?.finishedAt ? lastRun.finishedAt.toISOString() : null,
  };
}

async function getInstitutionProfileUncached(
  unitId: number,
  dataYear: string,
): Promise<InstitutionProfile | null> {
  const db = getDb();
  const [institution] = await db
    .select()
    .from(ipedsInstitutions)
    .where(and(eq(ipedsInstitutions.dataYear, dataYear), eq(ipedsInstitutions.unitId, unitId)))
    .limit(1);
  if (!institution) return null;

  const completions = await db
    .select()
    .from(ipedsCompletions)
    .where(and(eq(ipedsCompletions.dataYear, dataYear), eq(ipedsCompletions.unitId, unitId)))
    .orderBy(desc(ipedsCompletions.count));

  const famTotals = new Map<string, number>();
  for (const c of completions) famTotals.set(c.cip2, (famTotals.get(c.cip2) ?? 0) + c.count);
  const topMajors: TopMajor[] = [...famTotals.entries()]
    .map(([cip2, count]) => ({ cip2, label: cip2Label(cip2), count }))
    .sort((a, b) => b.count - a.count)
    .slice(0, 8);

  const admissionsTrend = (await fetchAdmissionsTrend([unitId])).get(unitId) ?? [];

  return { ...institution, completions, topMajors, admissionsTrend };
}

async function getCompareInstitutionsUncached(
  unitIds: number[],
  dataYear: string,
): Promise<CompareInstitution[]> {
  if (unitIds.length === 0) return [];
  const db = getDb();
  const rows = await db
    .select()
    .from(ipedsInstitutions)
    .where(and(eq(ipedsInstitutions.dataYear, dataYear), inArray(ipedsInstitutions.unitId, unitIds)));

  const completions = await db
    .select({
      unitId: ipedsCompletions.unitId,
      cip2: ipedsCompletions.cip2,
      count: ipedsCompletions.count,
    })
    .from(ipedsCompletions)
    .where(and(eq(ipedsCompletions.dataYear, dataYear), inArray(ipedsCompletions.unitId, unitIds)));
  const topMajor = topMajorByUnit(completions);
  const trendByUnit = await fetchAdmissionsTrend(unitIds);

  // Preserve caller order.
  const byId = new Map(rows.map((r) => [r.unitId, r]));
  return unitIds
    .map((id) => byId.get(id))
    .filter((r): r is IpedsInstitution => Boolean(r))
    .map((r) => ({
      ...stripRaw(r),
      topMajor: topMajor.get(r.unitId) ?? null,
      admissionsTrend: trendByUnit.get(r.unitId) ?? [],
    }));
}

// ── Cached public API ──────────────────────────────────────────────────

export async function getUsUniversitiesOverview(
  dataYear: string = CURRENT_DATA_YEAR,
): Promise<UsUniversitiesOverview> {
  "use cache";
  cacheTag(US_UNIVERSITIES_CACHE_TAG);
  cacheLife({ stale: 300, revalidate: 600, expire: 3600 });
  return getUsUniversitiesOverviewUncached(dataYear);
}

export async function searchInstitutions(
  params: FilterParams,
  dataYear: string = CURRENT_DATA_YEAR,
): Promise<InstitutionListResult> {
  "use cache";
  cacheTag(US_UNIVERSITIES_CACHE_TAG);
  cacheLife({ stale: 300, revalidate: 600, expire: 3600 });
  return searchInstitutionsUncached(params, dataYear);
}

export async function getInstitutionProfile(
  unitId: number,
  dataYear: string = CURRENT_DATA_YEAR,
): Promise<InstitutionProfile | null> {
  "use cache";
  cacheTag(US_UNIVERSITIES_CACHE_TAG);
  cacheLife({ stale: 300, revalidate: 600, expire: 3600 });
  return getInstitutionProfileUncached(unitId, dataYear);
}

export async function getCompareInstitutions(
  unitIds: number[],
  dataYear: string = CURRENT_DATA_YEAR,
): Promise<CompareInstitution[]> {
  "use cache";
  cacheTag(US_UNIVERSITIES_CACHE_TAG);
  cacheLife({ stale: 300, revalidate: 600, expire: 3600 });
  return getCompareInstitutionsUncached(unitIds, dataYear);
}

export async function getInstitutionsForExport(
  params: FilterParams,
  dataYear: string = CURRENT_DATA_YEAR,
): Promise<IpedsInstitutionSummary[]> {
  "use cache";
  cacheTag(US_UNIVERSITIES_CACHE_TAG);
  cacheLife({ stale: 300, revalidate: 600, expire: 3600 });
  return exportInstitutionsUncached(params, dataYear);
}
