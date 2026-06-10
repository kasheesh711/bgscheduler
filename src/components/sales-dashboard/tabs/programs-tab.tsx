"use client";

import type { SalesTabProps } from "@/lib/sales-dashboard/types";

/**
 * Wave-1 stub — the real Programs panel ships in Wave 2 (single-owner file).
 * Receives all data via the locked SalesTabProps contract; fetches rows only
 * via <TransactionsTable>.
 */
export function ProgramsTab({ dimensions, loading }: SalesTabProps) {
  return (
    <section className="rounded-lg border bg-card p-4 shadow-sm">
      <h2 className="text-sm font-semibold">Programs</h2>
      <p className="mt-1 text-xs text-muted-foreground">
        {loading
          ? "Loading sales dimensions…"
          : dimensions
            ? `${new Set(dimensions.programs.map((row) => row.program)).size} programs in the live data — panel arrives in Wave 2.`
            : "Program revenue, mix, and momentum breakdowns arrive in Wave 2."}
      </p>
      <div className="mt-4 space-y-2">
        {Array.from({ length: 6 }).map((_, index) => (
          <div key={index} className="h-10 animate-pulse rounded-md bg-muted/50" />
        ))}
      </div>
    </section>
  );
}
