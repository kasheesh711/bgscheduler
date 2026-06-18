"use client";

import { useCallback, useEffect, useRef, useState, useSyncExternalStore } from "react";
import { Download, Loader2 } from "lucide-react";
import { Button, buttonVariants } from "@/components/ui/button";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import {
  getSalesDimensionsVersion,
  subscribeSalesDimensionsVersion,
} from "@/hooks/use-sales-dimensions";
import { buildTransactionsExportHref } from "@/lib/sales-dashboard/export-links";
import { formatCurrency } from "@/lib/sales-dashboard/format";
import type { SlimTransaction } from "@/lib/sales-dashboard/types";
import { cn } from "@/lib/utils";

// ----------------------------------------------------------------------------
// Shared paged transactions table over /api/sales-dashboard/transactions.
// Owns its fetch (AbortController + per-key cache); shows skeleton rows while
// loading and an explicit "+N more / load all" footer — never silently
// truncates.
// ----------------------------------------------------------------------------

export interface TransactionsFilter {
  rep?: string;
  program?: string;
  band?: string;
  student?: string;
}

interface TransactionsPage {
  rows: SlimTransaction[];
  total: number;
}

interface TransactionsTableProps {
  filter: TransactionsFilter;
  from?: string;
  to?: string;
  /** First-page size; defaults to the endpoint default of 200. */
  pageSize?: number;
  className?: string;
  /**
   * Notified whenever rows settle (cache hit, fetch success, or load-all), so
   * embedding panels can derive views from the same fetch instead of issuing
   * a duplicate request.
   */
  onLoaded?: (rows: SlimTransaction[], total: number) => void;
  /** Notified when the fetch fails (the table also renders the error inline). */
  onError?: (message: string) => void;
}

const LOAD_ALL_PAGE_SIZE = 1000;
const SKELETON_ROWS = 6;
/** Bounded restarts when the server list shifts mid load-all (see loadAll). */
const MAX_LOAD_ALL_RESTARTS = 3;

function buildQuery(filter: TransactionsFilter, from: string | undefined, to: string | undefined, limit: number, offset: number): string {
  const params = new URLSearchParams();
  if (filter.rep) params.set("rep", filter.rep);
  if (filter.program) params.set("program", filter.program);
  if (filter.band) params.set("band", filter.band);
  if (filter.student) params.set("student", filter.student);
  if (from) params.set("from", from);
  if (to) params.set("to", to);
  params.set("limit", String(limit));
  params.set("offset", String(offset));
  return params.toString();
}

function cacheKey(filter: TransactionsFilter, from: string | undefined, to: string | undefined): string {
  return [filter.rep ?? "", filter.program ?? "", filter.band ?? "", filter.student ?? "", from ?? "", to ?? ""].join("|");
}

async function fetchTransactionsPage(query: string, signal: AbortSignal): Promise<TransactionsPage> {
  const response = await fetch(`/api/sales-dashboard/transactions?${query}`, { signal, cache: "no-store" });
  const body = await response.json().catch(() => ({}));
  if (!response.ok) {
    throw new Error((body as { error?: string }).error || `Transactions request failed (${response.status})`);
  }
  return body as TransactionsPage;
}

function kindLabel(row: SlimTransaction): string {
  if (row.kind === "additional") return row.salesType || "Additional";
  return row.enrollmentType || "—";
}

export function TransactionsTable({ filter, from, to, pageSize = 200, className, onLoaded, onError }: TransactionsTableProps) {
  const [page, setPage] = useState<TransactionsPage | null>(null);
  const [loading, setLoading] = useState(true);
  const [loadingAll, setLoadingAll] = useState(false);
  const [error, setError] = useState("");
  const cacheRef = useRef(new Map<string, TransactionsPage>());
  const abortRef = useRef<AbortController | null>(null);

  // Latest-callback refs so changing parent closures never re-trigger fetches.
  const onLoadedRef = useRef(onLoaded);
  const onErrorRef = useRef(onError);
  useEffect(() => {
    onLoadedRef.current = onLoaded;
    onErrorRef.current = onError;
  });

  const key = cacheKey(filter, from, to);
  const exportHref = buildTransactionsExportHref({
    ...filter,
    from,
    to,
  });

  // Imports/source edits bump the shared sales-data version; drop the
  // per-mount page cache so this table can't disagree with the refreshed
  // aggregates (the current key would otherwise keep serving pre-import rows).
  const dataVersion = useSyncExternalStore(
    subscribeSalesDimensionsVersion,
    getSalesDimensionsVersion,
    getSalesDimensionsVersion,
  );
  const dataVersionRef = useRef(dataVersion);

  useEffect(() => {
    if (dataVersionRef.current !== dataVersion) {
      dataVersionRef.current = dataVersion;
      cacheRef.current.clear();
    }
    const cached = cacheRef.current.get(key);
    if (cached) {
      setPage(cached);
      setLoading(false);
      setError("");
      onLoadedRef.current?.(cached.rows, cached.total);
      return;
    }

    abortRef.current?.abort();
    const controller = new AbortController();
    abortRef.current = controller;
    setLoading(true);
    setError("");

    fetchTransactionsPage(buildQuery(filter, from, to, pageSize, 0), controller.signal)
      .then((result) => {
        cacheRef.current.set(key, result);
        setPage(result);
        setLoading(false);
        onLoadedRef.current?.(result.rows, result.total);
      })
      .catch((fetchError: unknown) => {
        if (controller.signal.aborted) return;
        const message = fetchError instanceof Error ? fetchError.message : "Failed to load transactions";
        setError(message);
        setLoading(false);
        onErrorRef.current?.(message);
      });

    return () => controller.abort();
    // eslint-disable-next-line react-hooks/exhaustive-deps -- key encodes filter/from/to; pageSize is fixed per mount
  }, [key, dataVersion]);

  const loadAll = useCallback(async () => {
    if (!page || loadingAll) return;
    abortRef.current?.abort();
    const controller = new AbortController();
    abortRef.current = controller;
    setLoadingAll(true);
    setError("");
    try {
      // The list is newest-first behind a short-lived server cache, and rows
      // carry no stable id to dedup on. If an import lands mid-loop the
      // offsets shift, so when `total` moves between pages we restart the
      // accumulation from offset 0 (bounded) instead of stitching pages from
      // two different snapshots.
      let rows = page.rows;
      let total = page.total;
      let restarts = 0;
      while (rows.length < total) {
        const next = await fetchTransactionsPage(
          buildQuery(filter, from, to, LOAD_ALL_PAGE_SIZE, rows.length),
          controller.signal,
        );
        if (next.total !== total && restarts < MAX_LOAD_ALL_RESTARTS) {
          restarts += 1;
          rows = [];
          total = next.total;
          continue;
        }
        total = next.total;
        if (next.rows.length === 0) break;
        rows = [...rows, ...next.rows];
      }
      const result = { rows, total };
      cacheRef.current.set(key, result);
      setPage(result);
      onLoadedRef.current?.(result.rows, result.total);
    } catch (fetchError) {
      if (!controller.signal.aborted) {
        const message = fetchError instanceof Error ? fetchError.message : "Failed to load transactions";
        setError(message);
        onErrorRef.current?.(message);
      }
    } finally {
      setLoadingAll(false);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps -- key encodes filter/from/to
  }, [page, loadingAll, key]);

  const remaining = page ? page.total - page.rows.length : 0;

  return (
    <div className={cn("rounded-lg border bg-card", className)}>
      <div className="flex items-center justify-end border-b px-3 py-2">
        <a
          href={exportHref}
          className={buttonVariants({ variant: "outline", size: "sm" })}
          aria-label="Export transactions CSV"
        >
          <Download className="size-3.5" />
          Transactions CSV
        </a>
      </div>
      <Table className="text-sm">
        <TableHeader>
          <TableRow className="text-[11px] uppercase tracking-wide text-muted-foreground">
            <TableHead className="pl-4">Date</TableHead>
            <TableHead>Student</TableHead>
            <TableHead>Rep</TableHead>
            <TableHead>Program</TableHead>
            <TableHead>Package</TableHead>
            <TableHead>Type</TableHead>
            <TableHead className="text-right">Amount</TableHead>
            <TableHead className="pr-4">Valid until</TableHead>
          </TableRow>
        </TableHeader>
        <TableBody>
          {loading ? (
            Array.from({ length: SKELETON_ROWS }).map((_, index) => (
              <TableRow key={`skeleton-${index}`}>
                <TableCell colSpan={8} className="px-4 py-2">
                  <div className="h-6 animate-pulse rounded bg-muted/50" />
                </TableCell>
              </TableRow>
            ))
          ) : error ? (
            <TableRow>
              <TableCell colSpan={8} className="px-4 py-6 text-center text-sm text-destructive">{error}</TableCell>
            </TableRow>
          ) : !page || page.rows.length === 0 ? (
            <TableRow>
              <TableCell colSpan={8} className="px-4 py-6 text-center text-sm text-muted-foreground">
                No transactions match this filter.
              </TableCell>
            </TableRow>
          ) : (
            page.rows.map((row, index) => (
              <TableRow key={`${row.date}-${row.studentKey}-${index}`}>
                <TableCell className="pl-4 whitespace-nowrap">{row.date}</TableCell>
                <TableCell className="max-w-[160px] truncate font-medium">{row.student}</TableCell>
                <TableCell className="max-w-[140px] truncate">{row.rep || "—"}</TableCell>
                <TableCell className="max-w-[160px] truncate">{row.program || "—"}</TableCell>
                <TableCell className="max-w-[140px] truncate">{row.packageLabel || "—"}</TableCell>
                <TableCell className="whitespace-nowrap text-muted-foreground">{kindLabel(row)}</TableCell>
                <TableCell className="text-right font-medium">{formatCurrency(row.amount)}</TableCell>
                <TableCell className="pr-4 whitespace-nowrap text-muted-foreground">{row.validUntil ?? "—"}</TableCell>
              </TableRow>
            ))
          )}
        </TableBody>
      </Table>
      {!loading && !error && page && remaining > 0 ? (
        <div className="flex items-center justify-between gap-3 border-t px-4 py-2 text-xs text-muted-foreground">
          <span>+{remaining.toLocaleString("en-US")} more transaction{remaining === 1 ? "" : "s"}</span>
          <Button size="sm" variant="outline" disabled={loadingAll} onClick={() => void loadAll()}>
            {loadingAll ? <Loader2 className="size-3.5 animate-spin" /> : null}
            Load all
          </Button>
        </div>
      ) : null}
      {!loading && !error && page && page.rows.length > 0 && remaining === 0 ? (
        <div className="border-t px-4 py-2 text-xs text-muted-foreground">
          {page.total.toLocaleString("en-US")} transaction{page.total === 1 ? "" : "s"}
        </div>
      ) : null}
    </div>
  );
}
