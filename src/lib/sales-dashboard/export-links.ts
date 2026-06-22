import type { SlimTransactionFilters } from "./dimensions";

export function buildTransactionsExportHref(filters: SlimTransactionFilters = {}): string {
  const params = new URLSearchParams();
  if (filters.rep) params.set("rep", filters.rep);
  if (filters.program) params.set("program", filters.program);
  if (filters.band) params.set("band", filters.band);
  if (filters.student) params.set("student", filters.student);
  if (filters.from) params.set("from", filters.from);
  if (filters.to) params.set("to", filters.to);
  const query = params.toString();
  return `/api/sales-dashboard/transactions/export${query ? `?${query}` : ""}`;
}
