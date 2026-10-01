"use client";

import { Button } from "@/components/ui/button";
import type { OffboardingPersonRow } from "@/lib/tutor-offboarding/types";

/** OFF-03/OFF-04/OFF-06/OFF-07: confirmation evidence never changes eligibility. */
export function selectedRemovalRows(rows: OffboardingPersonRow[], keys: ReadonlySet<string>, freshnessOk: boolean): OffboardingPersonRow[] {
  if (!freshnessOk) return [];
  return rows.filter((row) => keys.has(row.signals.canonicalKey) && row.score.removable && !row.score.exclusion);
}

export function SelectionBar({ rows, canRemove, busy, onPreview, onClear }: {
  rows: OffboardingPersonRow[];
  canRemove: boolean;
  busy: boolean;
  onPreview: () => void;
  onClear: () => void;
}) {
  if (rows.length === 0) return null;
  const accounts = rows.reduce((total, row) => total + row.signals.accounts.length, 0);
  return (
    <div className="fixed inset-x-0 bottom-0 z-30 border-t bg-background/95 px-4 py-4 shadow-[0_-4px_16px_rgb(0_0_0/0.06)] backdrop-blur-sm" role="region" aria-label="Selected tutors for removal">
      <div className="mx-auto flex w-full max-w-[1392px] flex-wrap items-center justify-between gap-3">
        <div>
          <p className="text-sm font-semibold">{`${rows.length} ${rows.length === 1 ? "tutor" : "tutors"} (${accounts} Wise ${accounts === 1 ? "account" : "accounts"}) selected`}</p>
          {busy ? <p role="status" className="mt-1 text-xs text-muted-foreground">Checking the current Wise accounts and upcoming classes. This may take a moment.</p> : null}
          <p className="mt-1 text-xs text-muted-foreground">Preview only checks the plan. You confirm the action in the next step.</p>
          {!canRemove ? <p className="mt-1 text-xs text-amber-800 dark:text-amber-200">The owner must allow you to remove tutors.</p> : null}
        </div>
        <div className="flex gap-2">
          <Button type="button" variant="outline" size="sm" disabled={busy} onClick={onClear}>Clear selection</Button>
          <Button type="button" size="sm" disabled={busy || !canRemove} onClick={onPreview}>{busy ? "Checking Wise…" : "Preview removal"}</Button>
        </div>
      </div>
    </div>
  );
}
