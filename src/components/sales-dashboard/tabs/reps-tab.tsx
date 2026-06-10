"use client";

import type { SalesTabProps } from "@/lib/sales-dashboard/types";

/**
 * Wave-1 stub — the real Reps panel ships in Wave 2 (single-owner file).
 * Receives all data via the locked SalesTabProps contract; fetches rows only
 * via <TransactionsTable>.
 */
export function RepsTab({ dimensions, loading }: SalesTabProps) {
  return (
    <section className="rounded-lg border bg-card p-4 shadow-sm">
      <h2 className="text-sm font-semibold">Reps</h2>
      <p className="mt-1 text-xs text-muted-foreground">
        {loading
          ? "Loading sales dimensions…"
          : dimensions
            ? `${dimensions.repFunnels.length} reps in the live data — panel arrives in Wave 2.`
            : "Per-rep revenue, funnel, and pace breakdowns arrive in Wave 2."}
      </p>
      <div className="mt-4 space-y-2">
        {Array.from({ length: 6 }).map((_, index) => (
          <div key={index} className="h-10 animate-pulse rounded-md bg-muted/50" />
        ))}
      </div>
    </section>
  );
}
