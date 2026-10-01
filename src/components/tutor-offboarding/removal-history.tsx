"use client";

import { useCallback, useEffect, useState } from "react";
import { Button } from "@/components/ui/button";
import type { RemovalRunDetail, RemovalRunStatus } from "@/lib/tutor-offboarding/removal-types";
import { Panel, Tag, Upper } from "./atoms";
import { formatDayYear } from "./format";
import { RemovalAccounts } from "./removal-dialog";
import { listRemovalRuns } from "./requests";

const RUN_LABEL: Record<RemovalRunStatus, string> = {
  previewed: "Preview saved", applying: "In progress · check status", applied: "Run finished",
  applied_with_errors: "Some outcomes need attention", expired: "Preview expired",
};

export function RemovalHistory({ onOpen, initialRuns, initialError = null }: {
  onOpen: (id: string) => void; initialRuns?: RemovalRunDetail[]; initialError?: string | null;
}) {
  const [runs, setRuns] = useState<RemovalRunDetail[] | null>(initialRuns ?? null);
  const [error, setError] = useState<string | null>(initialError);
  const [busy, setBusy] = useState(false);
  const refresh = useCallback(async () => {
    setBusy(true);
    try { setRuns(await listRemovalRuns()); setError(null); }
    catch (failure) { setError(failure instanceof Error ? failure.message : "Removal history could not be loaded."); }
    finally { setBusy(false); }
  }, []);
  useEffect(() => { if (initialRuns === undefined) void refresh(); }, [initialRuns, refresh]);
  return (
    <section className="mt-4 space-y-3" aria-label="Removal history">
      <div className="flex items-center justify-between gap-3">
        <h2 className="text-sm font-semibold">Removal history</h2>
        <Button type="button" variant="outline" size="sm" disabled={busy} onClick={() => void refresh()}>{busy ? "Refreshing…" : "Refresh history"}</Button>
      </div>
      {error ? <p role="alert" className="text-sm text-conflict">{error}</p> : null}
      {!runs && !error ? <Panel className="px-4 py-5 text-sm text-muted-foreground">Loading removal history…</Panel> : null}
      {runs?.length === 0 && !error ? <Panel className="px-4 py-5 text-sm text-muted-foreground">No removal runs yet.</Panel> : null}
      {runs?.map((run) => (
        <Panel key={run.id} className="px-4 py-4">
          <div className="flex flex-wrap items-center justify-between gap-3">
            <p className="text-sm font-semibold">{`${run.tutorCount} ${run.tutorCount === 1 ? "tutor" : "tutors"} · ${run.accountCount} Wise ${run.accountCount === 1 ? "account" : "accounts"}`}</p>
            <div className="flex flex-wrap items-center gap-2">
              <Tag>{run.mode === "manual" ? "Manual checklist" : "Live removal"}</Tag>
              <Tag tone={run.status === "applied_with_errors" ? "amber" : "neutral"}>{RUN_LABEL[run.status]}</Tag>
              <Button type="button" size="sm" variant="outline" onClick={() => onOpen(run.id)}>Open run</Button>
            </div>
          </div>
          <p className="mt-2 text-xs text-muted-foreground [overflow-wrap:anywhere]">{`${run.appliedByEmail ?? run.createdByEmail} · ${formatDayYear(run.appliedAt ?? run.createdAt)}`}</p>
          {run.reason ? <p className="mt-2 max-h-28 overflow-y-auto whitespace-pre-wrap text-xs [overflow-wrap:anywhere]" tabIndex={0}>{run.reason}</p> : null}
          <details className="mt-3 rounded-md border">
            <summary className="cursor-pointer px-3 py-2 text-xs font-medium">Account outcomes</summary>
            <div className="border-t p-3"><RemovalAccounts accounts={run.accounts} /></div>
          </details>
        </Panel>
      ))}
      <div className="pt-2"><Upper>Still with us decisions</Upper></div>
    </section>
  );
}
