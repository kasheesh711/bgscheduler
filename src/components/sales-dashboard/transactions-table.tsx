"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { Loader2 } from "lucide-react";
import { Button } from "@/components/ui/button";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
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
}

const LOAD_ALL_PAGE_SIZE = 1000;
const SKELETON_ROWS = 6;

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

export function TransactionsTable({ filter, from, to, pageSize = 200, className }: TransactionsTableProps) {
  const [page, setPage] = useState<TransactionsPage | null>(null);
  const [loading, setLoading] = useState(true);
  const [loadingAll, setLoadingAll] = useState(false);
  const [error, setError] = useState("");
  const cacheRef = useRef(new Map<string, TransactionsPage>());
  const abortRef = useRef<AbortController | null>(null);

  const key = cacheKey(filter, from, to);

  useEffect(() => {
    const cached = cacheRef.current.get(key);
    if (cached) {
      setPage(cached);
      setLoading(false);
      setError("");
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
      })
      .catch((fetchError: unknown) => {
        if (controller.signal.aborted) return;
        setError(fetchError instanceof Error ? fetchError.message : "Failed to load transactions");
        setLoading(false);
      });

    return () => controller.abort();
    // eslint-disable-next-line react-hooks/exhaustive-deps -- key encodes filter/from/to; pageSize is fixed per mount
  }, [key]);

  const loadAll = useCallback(async () => {
    if (!page || loadingAll) return;
    abortRef.current?.abort();
    const controller = new AbortController();
    abortRef.current = controller;
    setLoadingAll(true);
    setError("");
    try {
      let rows = page.rows;
      let total = page.total;
      while (rows.length < total) {
        const next = await fetchTransactionsPage(
          buildQuery(filter, from, to, LOAD_ALL_PAGE_SIZE, rows.length),
          controller.signal,
        );
        total = next.total;
        if (next.rows.length === 0) break;
        rows = [...rows, ...next.rows];
      }
      const result = { rows, total };
      cacheRef.current.set(key, result);
      setPage(result);
    } catch (fetchError) {
      if (!controller.signal.aborted) {
        setError(fetchError instanceof Error ? fetchError.message : "Failed to load transactions");
      }
    } finally {
      setLoadingAll(false);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps -- key encodes filter/from/to
  }, [page, loadingAll, key]);

  const remaining = page ? page.total - page.rows.length : 0;

  return (
    <div className={cn("rounded-lg border bg-card", className)}>
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
