// ── Query-param parsing for read routes (search + export) ──────────────

import { z } from "zod";
import type { FilterParams } from "./types";

const csvList = (value: string | null | undefined): string[] | undefined => {
  if (!value) return undefined;
  const parts = value.split(",").map((s) => s.trim()).filter(Boolean);
  return parts.length ? parts : undefined;
};

export const FilterQuerySchema = z.object({
  search: z.string().trim().min(1).optional(),
  states: z.string().optional(),
  control: z.string().optional(),
  minAcceptance: z.coerce.number().optional(),
  maxAcceptance: z.coerce.number().optional(),
  maxNetPrice: z.coerce.number().optional(),
  minGradRate: z.coerce.number().optional(),
  cip2: z.string().trim().min(1).optional(),
  sort: z.string().trim().min(1).optional(),
  dir: z.enum(["asc", "desc"]).optional(),
  page: z.coerce.number().int().positive().optional(),
  pageSize: z.coerce.number().int().positive().optional(),
});

export type FilterQuery = z.infer<typeof FilterQuerySchema>;

/** Convert a validated query object into FilterParams. */
export function toFilterParams(q: FilterQuery): FilterParams {
  return {
    search: q.search,
    states: csvList(q.states),
    control: csvList(q.control)
      ?.map((c) => Number.parseInt(c, 10))
      .filter((n) => Number.isFinite(n)),
    minAcceptance: q.minAcceptance,
    maxAcceptance: q.maxAcceptance,
    maxNetPrice: q.maxNetPrice,
    minGradRate: q.minGradRate,
    cip2: q.cip2,
    sort: q.sort,
    dir: q.dir,
    page: q.page,
    pageSize: q.pageSize,
  };
}

/** Build a plain object from URLSearchParams for Zod parsing. */
export function searchParamsToObject(sp: URLSearchParams): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [k, v] of sp.entries()) out[k] = v;
  return out;
}
