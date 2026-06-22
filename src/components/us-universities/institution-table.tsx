"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { ArrowDown, ArrowUp, ArrowUpDown, Download } from "lucide-react";
import { Button, buttonVariants } from "@/components/ui/button";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { InstitutionFilters } from "@/components/us-universities/institution-filters";
import {
  CONTROL_LABELS,
  DEFAULT_PAGE_SIZE,
  MAX_COMPARE,
} from "@/lib/us-universities/constants";
import type {
  FilterParams,
  InstitutionListResult,
  IpedsInstitutionListItem,
} from "@/lib/us-universities/types";
import type { InstitutionTableProps } from "@/components/us-universities/view-types";
import { cn } from "@/lib/utils";
import { formatInt, formatPct, formatSatRange } from "@/lib/us-universities/format";

// ----------------------------------------------------------------------------
// Institution browse table — stateful filter bar + server-paginated results.
// Filters drive a debounced /api/us-universities/search fetch (AbortController-
// cancelled on overlap). Sortable headers toggle sort/dir on the whitelisted
// keys, server pagination via Prev/Next, and a CSV export anchor that mirrors
// the current query. Numeric IPEDS metrics are fail-closed: null renders "—".
// ----------------------------------------------------------------------------

/**
 * Year-over-year acceptance change in percentage points. `null` when either
 * bound is missing (fail-closed; never imply a 0 delta). A "down" direction
 * means the institution got MORE selective (lower acceptance %).
 */
export function acceptanceDelta(row: {
  acceptanceRate: number | null;
  acceptancePrevYear: number | null;
}): { points: number; direction: "down" | "up" | "flat" } | null {
  if (row.acceptanceRate == null || row.acceptancePrevYear == null) return null;
  const points = row.acceptanceRate - row.acceptancePrevYear;
  // Derive direction from the displayed (1-dp) value so a ±0.0x change reads as
  // flat rather than a mis-coloured "0pp" up/down arrow.
  const rounded = Math.round(points * 10) / 10;
  if (rounded === 0) return { points: 0, direction: "flat" };
  return { points, direction: rounded < 0 ? "down" : "up" };
}

/** Sort keys the search endpoint accepts (whitelist; others are ignored). */
const SORTABLE_KEYS = [
  "instName",
  "stateAbbr",
  "acceptanceRate",
  "enrollmentTotal",
  "gradRateBach6yr",
  "avgNetPrice",
  "satReadingP75",
  "studentFacultyRatio",
] as const;

type TableSortKey = (typeof SORTABLE_KEYS)[number];

function isSortableKey(key: string): key is TableSortKey {
  return (SORTABLE_KEYS as readonly string[]).includes(key);
}

interface ColumnDef {
  key: string;
  label: string;
  sortKey?: TableSortKey;
  numeric?: boolean;
}

const COLUMNS: ColumnDef[] = [
  { key: "instName", label: "Institution", sortKey: "instName" },
  { key: "stateAbbr", label: "State", sortKey: "stateAbbr" },
  { key: "control", label: "Control" },
  { key: "acceptanceRate", label: "Acceptance %", sortKey: "acceptanceRate", numeric: true },
  { key: "acceptanceTrend", label: "Acceptance trend", numeric: true },
  { key: "sat", label: "SAT (read)", sortKey: "satReadingP75", numeric: true },
  { key: "enrollmentTotal", label: "Enrollment", sortKey: "enrollmentTotal", numeric: true },
  { key: "gradRateBach6yr", label: "Grad 6yr %", sortKey: "gradRateBach6yr", numeric: true },
  { key: "avgNetPrice", label: "Net price", sortKey: "avgNetPrice", numeric: true },
  { key: "compare", label: "" },
];

/**
 * Build the URLSearchParams query string for the search/export endpoints from
 * a FilterParams. Pure + testable: CSV-joins states, omits undefined/blank
 * values, and always emits page/sort/dir so the server gets a stable shape.
 */
export function buildSearchQuery(filters: FilterParams): string {
  const params = new URLSearchParams();
  if (filters.search && filters.search.trim() !== "") {
    params.set("search", filters.search.trim());
  }
  if (filters.states && filters.states.length > 0) {
    params.set("states", filters.states.join(","));
  }
  if (filters.control && filters.control.length > 0) {
    params.set("control", filters.control.join(","));
  }
  if (filters.minAcceptance != null) params.set("minAcceptance", String(filters.minAcceptance));
  if (filters.maxAcceptance != null) params.set("maxAcceptance", String(filters.maxAcceptance));
  if (filters.maxNetPrice != null) params.set("maxNetPrice", String(filters.maxNetPrice));
  if (filters.minGradRate != null) params.set("minGradRate", String(filters.minGradRate));
  if (filters.cip2 && filters.cip2 !== "") params.set("cip2", filters.cip2);

  params.set("sort", filters.sort ?? "instName");
  params.set("dir", filters.dir ?? "asc");
  params.set("page", String(filters.page ?? 1));
  params.set("pageSize", String(filters.pageSize ?? DEFAULT_PAGE_SIZE));

  return params.toString();
}

/**
 * Toggle sort state for a column: clicking the active column flips direction,
 * clicking a new column selects it ascending. Always resets to page 1.
 */
export function toggleSort(filters: FilterParams, key: TableSortKey): FilterParams {
  if (filters.sort === key) {
    return { ...filters, dir: filters.dir === "asc" ? "desc" : "asc", page: 1 };
  }
  return { ...filters, sort: key, dir: "asc", page: 1 };
}

/**
 * Merge a chart-cross-filter patch onto the current filters, always resetting
 * to page 1. Pure + testable: a chart click maps a clicked element to a
 * Partial<FilterParams> patch (see chart-filters.ts) which this applies. The
 * patch's `page`, if any, is overridden — a new filter always starts at page 1.
 */
export function applyChartFilter(
  filters: FilterParams,
  patch: Partial<FilterParams>,
): FilterParams {
  return { ...filters, ...patch, page: 1 };
}

const INITIAL_FILTERS: FilterParams = {
  sort: "instName",
  dir: "asc",
  page: 1,
  pageSize: DEFAULT_PAGE_SIZE,
};

export function InstitutionTable({
  overview,
  onSelect,
  onAddCompare,
  compareIds,
}: InstitutionTableProps) {
  const [filters, setFilters] = useState<FilterParams>(INITIAL_FILTERS);
  const [rows, setRows] = useState<IpedsInstitutionListItem[]>([]);
  const [total, setTotal] = useState(0);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const abortRef = useRef<AbortController | null>(null);
  const query = buildSearchQuery(filters);

  useEffect(() => {
    // Cancel any in-flight request before issuing a new one.
    abortRef.current?.abort();
    const controller = new AbortController();
    abortRef.current = controller;

    // Defer state updates into the timer callback so no setState runs
    // synchronously in the effect body (react-hooks/set-state-in-effect).
    const handle = window.setTimeout(() => {
      setLoading(true);
      setError(null);

      fetch(`/api/us-universities/search?${query}`, { signal: controller.signal })
        .then(async (response) => {
          if (!response.ok) {
            throw new Error(`Search failed (${response.status})`);
          }
          return (await response.json()) as InstitutionListResult;
        })
        .then((result) => {
          if (controller.signal.aborted) return;
          setRows(result.rows ?? []);
          setTotal(result.total ?? 0);
          setLoading(false);
        })
        .catch((err: unknown) => {
          if (controller.signal.aborted || (err instanceof DOMException && err.name === "AbortError")) {
            return;
          }
          setRows([]);
          setTotal(0);
          setError(err instanceof Error ? err.message : "Failed to load institutions");
          setLoading(false);
        });
    }, 0);

    return () => {
      window.clearTimeout(handle);
      controller.abort();
    };
  }, [query]);

  const onSort = useCallback((key: TableSortKey) => {
    setFilters((current) => toggleSort(current, key));
  }, []);

  const page = filters.page ?? 1;
  const pageSize = filters.pageSize ?? DEFAULT_PAGE_SIZE;
  const totalPages = Math.max(1, Math.ceil(total / pageSize));
  const hasPrev = page > 1;
  const hasNext = page < totalPages;
  const rangeStart = total === 0 ? 0 : (page - 1) * pageSize + 1;
  const rangeEnd = Math.min(page * pageSize, total);

  const goToPage = useCallback((next: number) => {
    setFilters((current) => ({ ...current, page: next }));
  }, []);

  return (
    <div className="flex flex-col gap-3">
      <InstitutionFilters
        states={overview.states}
        cip2Options={overview.cip2Options}
        value={filters}
        onChange={setFilters}
      />

      <div className="flex flex-wrap items-center justify-between gap-2">
        <p className="text-sm text-muted-foreground" aria-live="polite">
          {loading
            ? "Loading institutions…"
            : total === 0
              ? "No institutions match these filters."
              : `Showing ${rangeStart.toLocaleString("en-US")}–${rangeEnd.toLocaleString("en-US")} of ${total.toLocaleString("en-US")}`}
        </p>
        <a
          href={`/api/us-universities/export?${query}`}
          download
          aria-label="Download current results as CSV"
          className={buttonVariants({ variant: "outline", size: "sm" })}
        >
          <Download aria-hidden className="size-4" />
          Download CSV
        </a>
      </div>

      {error ? (
        <div className="rounded-lg border border-destructive/40 bg-destructive/5 p-4 text-sm text-destructive">
          {error}
        </div>
      ) : null}

      <div className="rounded-lg border">
        <Table>
          <TableHeader>
            <TableRow>
              {COLUMNS.map((column) => {
                const isActive = column.sortKey != null && filters.sort === column.sortKey;
                const SortIcon = !column.sortKey
                  ? null
                  : !isActive
                    ? ArrowUpDown
                    : filters.dir === "desc"
                      ? ArrowDown
                      : ArrowUp;
                return (
                  <TableHead
                    key={column.key}
                    className={cn(column.numeric && "text-right")}
                    aria-sort={
                      !column.sortKey
                        ? undefined
                        : isActive
                          ? filters.dir === "desc"
                            ? "descending"
                            : "ascending"
                          : "none"
                    }
                  >
                    {column.sortKey && SortIcon ? (
                      <button
                        type="button"
                        onClick={() => column.sortKey && isSortableKey(column.sortKey) && onSort(column.sortKey)}
                        className={cn(
                          "inline-flex items-center gap-1 font-medium hover:text-foreground",
                          column.numeric && "flex-row-reverse",
                          isActive ? "text-foreground" : "text-muted-foreground",
                        )}
                      >
                        {column.label}
                        <SortIcon aria-hidden className="size-3.5" />
                      </button>
                    ) : (
                      column.label
                    )}
                  </TableHead>
                );
              })}
            </TableRow>
          </TableHeader>
          <TableBody>
            {loading ? (
              Array.from({ length: 8 }).map((_, index) => (
                <TableRow key={`skeleton-${index}`}>
                  {COLUMNS.map((column) => (
                    <TableCell key={column.key}>
                      <div className="h-4 w-full animate-pulse rounded bg-muted" />
                    </TableCell>
                  ))}
                </TableRow>
              ))
            ) : rows.length === 0 ? (
              <TableRow>
                <TableCell colSpan={COLUMNS.length} className="py-10 text-center text-muted-foreground">
                  No institutions match these filters.
                </TableCell>
              </TableRow>
            ) : (
              rows.map((row) => {
                const inCompare = compareIds.includes(row.unitId);
                const compareFull = compareIds.length >= MAX_COMPARE;
                return (
                  <TableRow key={row.unitId}>
                    <TableCell className="max-w-72">
                      <button
                        type="button"
                        onClick={() => onSelect(row.unitId)}
                        className="text-left font-medium text-foreground hover:underline"
                      >
                        {row.instName}
                        {row.city ? (
                          <span className="block text-xs font-normal text-muted-foreground">{row.city}</span>
                        ) : null}
                      </button>
                    </TableCell>
                    <TableCell>{row.stateAbbr ?? "—"}</TableCell>
                    <TableCell>
                      {row.control != null ? (CONTROL_LABELS[row.control] ?? "—") : "—"}
                    </TableCell>
                    <TableCell className="text-right tabular-nums">{formatPct(row.acceptanceRate)}</TableCell>
                    <TableCell className="text-right tabular-nums">
                      {(() => {
                        const delta = acceptanceDelta(row);
                        if (delta == null) return "—";
                        if (delta.direction === "flat") {
                          return <span className="text-xs text-muted-foreground">0pp</span>;
                        }
                        const DeltaIcon = delta.direction === "down" ? ArrowDown : ArrowUp;
                        return (
                          <span
                            className={cn(
                              "inline-flex items-center justify-end gap-0.5 text-xs font-medium",
                              delta.direction === "down" ? "text-available" : "text-destructive",
                            )}
                          >
                            <DeltaIcon aria-hidden className="size-3" />
                            {Math.abs(Math.round(delta.points * 10) / 10)}pp
                          </span>
                        );
                      })()}
                    </TableCell>
                    <TableCell className="text-right tabular-nums">
                      {formatSatRange(row.satReadingP25, row.satReadingP75)}
                    </TableCell>
                    <TableCell className="text-right tabular-nums">{formatInt(row.enrollmentTotal)}</TableCell>
                    <TableCell className="text-right tabular-nums">{formatPct(row.gradRateBach6yr)}</TableCell>
                    <TableCell className="text-right tabular-nums">{formatInt(row.avgNetPrice, "$")}</TableCell>
                    <TableCell className="text-right">
                      <Button
                        variant={inCompare ? "secondary" : "outline"}
                        size="sm"
                        disabled={inCompare || compareFull}
                        onClick={() => onAddCompare(row.unitId)}
                        aria-label={
                          inCompare
                            ? `${row.instName} is already in compare`
                            : `Add ${row.instName} to compare`
                        }
                      >
                        {inCompare ? "Added" : "Compare"}
                      </Button>
                    </TableCell>
                  </TableRow>
                );
              })
            )}
          </TableBody>
        </Table>
      </div>

      <div className="flex items-center justify-between gap-2">
        <p className="text-sm text-muted-foreground">
          Page {page.toLocaleString("en-US")} of {totalPages.toLocaleString("en-US")}
        </p>
        <div className="flex items-center gap-2">
          <Button
            variant="outline"
            size="sm"
            disabled={!hasPrev || loading}
            onClick={() => goToPage(page - 1)}
          >
            Prev
          </Button>
          <Button
            variant="outline"
            size="sm"
            disabled={!hasNext || loading}
            onClick={() => goToPage(page + 1)}
          >
            Next
          </Button>
        </div>
      </div>
    </div>
  );
}
