"use client";

import { EM_DASH, formatInt } from "@/lib/us-universities/format";

// ----------------------------------------------------------------------------
// Live results count — "N of {total}" with a big tabular-nums figure. The
// count is fail-closed: a null count (or the loading state) renders EM_DASH,
// never 0, so an in-flight or failed fetch can't read as "zero matches".
// ----------------------------------------------------------------------------

export interface CountBannerProps {
  /** Matching-row count; null while unknown (loading/error) → renders EM_DASH. */
  count: number | null;
  /** Total institutions in the active dataset (always known). */
  total: number;
  /** Suppress the count to EM_DASH while a fetch is in flight. */
  loading?: boolean;
}

export function CountBanner({ count, total, loading = false }: CountBannerProps) {
  const display = loading || count == null ? EM_DASH : formatInt(count);
  return (
    <p aria-live="polite" className="flex items-baseline gap-1.5">
      <span className="text-2xl font-semibold tabular-nums text-foreground">{display}</span>
      <span className="text-sm text-muted-foreground">of {formatInt(total)}</span>
    </p>
  );
}
