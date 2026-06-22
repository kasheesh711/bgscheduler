import type {
  ipedsInstitutions,
  ipedsCompletions,
  ipedsImportRuns,
} from "@/lib/db/schema";

// ── Row types (inferred from Drizzle schema) ───────────────────────────

export type IpedsInstitution = typeof ipedsInstitutions.$inferSelect;
export type IpedsInstitutionInsert = typeof ipedsInstitutions.$inferInsert;
export type IpedsCompletion = typeof ipedsCompletions.$inferSelect;
export type IpedsCompletionInsert = typeof ipedsCompletions.$inferInsert;
export type IpedsImportRun = typeof ipedsImportRuns.$inferSelect;

/** Lightweight institution shape returned in list/search/compare payloads (drops `raw`). */
export type IpedsInstitutionSummary = Omit<IpedsInstitution, "raw">;

export interface TopMajor {
  cip2: string;
  label: string;
  count: number;
}

// ── Admissions trends (Milestone 2 — multi-year series) ────────────────

/** One year of an institution's admissions metrics (all nullable, fail-closed). */
export interface AdmissionsTrendPoint {
  dataYear: string;
  acceptanceRate: number | null;
  yieldRate: number | null;
  applicantsTotal: number | null;
  admitsTotal: number | null;
  enrolledTotal: number | null;
  satReadingP25: number | null;
  satReadingP75: number | null;
  satMathP25: number | null;
  satMathP75: number | null;
  actCompositeP25: number | null;
  actCompositeP75: number | null;
}

/** Aggregate acceptance rate across the 4-year set, by year (overview chart). */
export interface AcceptanceTrendPoint {
  dataYear: string;
  avgAcceptance: number | null;
  n: number;
}

export interface InstitutionProfile extends IpedsInstitution {
  completions: IpedsCompletion[];
  topMajors: TopMajor[];
  admissionsTrend: AdmissionsTrendPoint[];
}

export interface CompareInstitution extends IpedsInstitutionSummary {
  topMajor: TopMajor | null;
  admissionsTrend: AdmissionsTrendPoint[];
}

/** Browse-row item: current-year summary + prior-year acceptance for a delta. */
export interface IpedsInstitutionListItem extends IpedsInstitutionSummary {
  acceptancePrevYear: number | null;
}

// ── Filter / list ──────────────────────────────────────────────────────

export interface FilterParams {
  search?: string;
  states?: string[];
  control?: number[];
  minAcceptance?: number;
  maxAcceptance?: number;
  maxNetPrice?: number;
  minGradRate?: number;
  cip2?: string;
  sort?: string;
  dir?: "asc" | "desc";
  page?: number;
  pageSize?: number;
}

export interface InstitutionListResult {
  rows: IpedsInstitutionListItem[];
  total: number;
  page: number;
  pageSize: number;
}

// ── Overview / charts ──────────────────────────────────────────────────

export interface StateFacet {
  state: string;
  count: number;
}

export interface ControlFacet {
  control: number;
  label: string;
  count: number;
}

export interface AcceptanceBucket {
  label: string;
  min: number;
  max: number;
  count: number;
}

export interface ScatterPoint {
  unitId: number;
  name: string;
  /** Total on-campus in-state sticker price (better coverage than net price). */
  cost: number | null;
  gradRate: number | null;
  control: number | null;
}

export interface Cip2Option {
  cip2: string;
  label: string;
}

export interface UsUniversitiesOverview {
  dataYear: string;
  totalInstitutions: number;
  withAcceptanceRate: number;
  avgAcceptanceRate: number | null;
  states: StateFacet[];
  controls: ControlFacet[];
  acceptanceBuckets: AcceptanceBucket[];
  scatter: ScatterPoint[];
  cip2Options: Cip2Option[];
  acceptanceTrend: AcceptanceTrendPoint[];
  lastImportedAt: string | null;
}
