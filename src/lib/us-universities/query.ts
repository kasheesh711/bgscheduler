// ── Browse-table query building (pure) ─────────────────────────────────
// Translates FilterParams into Drizzle conditions / ordering / pagination.
// The cip2 (major) filter needs a subquery and is composed in data.ts.

import { and, asc, desc, eq, gte, lte, inArray, ilike, type SQL } from "drizzle-orm";
import { ipedsInstitutions } from "@/lib/db/schema";
import {
  DEFAULT_SORT,
  DEFAULT_PAGE_SIZE,
  MAX_PAGE_SIZE,
  SORTABLE_COLUMN_KEYS,
  type SortableColumnKey,
} from "./constants";
import type { FilterParams } from "./types";

const SORT_COLUMNS = {
  instName: ipedsInstitutions.instName,
  stateAbbr: ipedsInstitutions.stateAbbr,
  acceptanceRate: ipedsInstitutions.acceptanceRate,
  enrollmentTotal: ipedsInstitutions.enrollmentTotal,
  gradRateBach6yr: ipedsInstitutions.gradRateBach6yr,
  avgNetPrice: ipedsInstitutions.avgNetPrice,
  totalPriceInState: ipedsInstitutions.totalPriceInState,
  satReadingP75: ipedsInstitutions.satReadingP75,
  studentFacultyRatio: ipedsInstitutions.studentFacultyRatio,
} satisfies Record<SortableColumnKey, unknown>;

/** Resolve a user-supplied sort to a whitelisted column key (never raw input). */
export function resolveSortKey(sort?: string): SortableColumnKey {
  return (SORTABLE_COLUMN_KEYS as readonly string[]).includes(sort ?? "")
    ? (sort as SortableColumnKey)
    : DEFAULT_SORT;
}

export function buildInstitutionOrderBy(params: FilterParams): SQL {
  const column = SORT_COLUMNS[resolveSortKey(params.sort)];
  return params.dir === "desc" ? desc(column) : asc(column);
}

export function clampPagination(params: FilterParams): {
  limit: number;
  offset: number;
  page: number;
  pageSize: number;
} {
  const pageSize = Math.min(
    Math.max(1, Math.floor(params.pageSize ?? DEFAULT_PAGE_SIZE)),
    MAX_PAGE_SIZE,
  );
  const page = Math.max(1, Math.floor(params.page ?? 1));
  return { limit: pageSize, offset: (page - 1) * pageSize, page, pageSize };
}

/** Build all conditions except cip2 (which requires a completions subquery). */
export function buildInstitutionConditions(params: FilterParams, dataYear: string): SQL[] {
  const conditions: SQL[] = [eq(ipedsInstitutions.dataYear, dataYear)];
  const search = params.search?.trim();
  if (search) conditions.push(ilike(ipedsInstitutions.instName, `%${search}%`));
  if (params.states?.length) conditions.push(inArray(ipedsInstitutions.stateAbbr, params.states));
  if (params.control?.length) conditions.push(inArray(ipedsInstitutions.control, params.control));
  if (params.minAcceptance != null) conditions.push(gte(ipedsInstitutions.acceptanceRate, params.minAcceptance));
  if (params.maxAcceptance != null) conditions.push(lte(ipedsInstitutions.acceptanceRate, params.maxAcceptance));
  if (params.maxNetPrice != null) conditions.push(lte(ipedsInstitutions.avgNetPrice, params.maxNetPrice));
  if (params.minGradRate != null) conditions.push(gte(ipedsInstitutions.gradRateBach6yr, params.minGradRate));
  return conditions;
}

export function combineConditions(conditions: SQL[]): SQL | undefined {
  return conditions.length ? and(...conditions) : undefined;
}
