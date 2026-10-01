"use client";

import { useCallback, useState } from "react";
import { Button } from "@/components/ui/button";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import type { OffboardingDashboard, OffboardingUnavailableReason } from "@/lib/tutor-offboarding/types";
import { Panel } from "./atoms";
import { formatAge, topLineSentence } from "./format";
import { GrantsPanel } from "./grants-panel";
import { HistoryTable } from "./history-table";
import { Inbox } from "./inbox";
import { PersonDrawer } from "./person-detail";
import { ExcludedList, FreshnessBanner, HowScoreWorks, StaffAccounts } from "./rail";
import { StillWithUsDialog } from "./still-with-us-dialog";
import { TerminationSourcePanel } from "./termination-evidence";
import { refreshDashboard, revokeDecision } from "./requests";

const UNAVAILABLE: Record<OffboardingUnavailableReason, string> = {
  not_set_up: "Tutor Offboarding is not set up yet: its database migration has not been applied.",
  no_snapshot: "No Wise snapshot is active yet, so there is nobody to score.",
  load_failed: "The page could not load. Try again in a minute; if it keeps failing, check Data Health.",
};

export function TutorOffboardingWorkspace({ initial }: { initial: OffboardingDashboard }) {
  const [dashboard, setDashboard] = useState(initial);
  const [openKey, setOpenKey] = useState<string | null>(null);
  const [keepKey, setKeepKey] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [refreshing, setRefreshing] = useState(false);

  const reload = useCallback(async () => {
    setRefreshing(true);
    try {
      const next = await refreshDashboard();
      if (!next.available) throw new Error(UNAVAILABLE[next.reason]);
      setDashboard(next);
      setError(null);
    } catch (failure) {
      setError(failure instanceof Error ? failure.message : "The review list could not refresh.");
      throw failure;
    } finally {
      setRefreshing(false);
    }
  }, []);

  if (!dashboard.available) {
    return (
      <div className="mx-auto w-full max-w-[1440px] pb-10 lg:px-6">
        <h1 className="border-b pt-1.5 pb-4 text-[22px] font-semibold tracking-tight">Tutor Offboarding</h1>
        <Panel className="mt-5 px-5 py-6 text-sm">{UNAVAILABLE[dashboard.reason]}</Panel>
      </div>
    );
  }

  const everyone = [...dashboard.inbox, ...dashboard.excluded, ...dashboard.staff];
  const openRow = everyone.find((row) => row.signals.canonicalKey === openKey) ?? null;
  const keepRow = dashboard.inbox.find((row) => row.signals.canonicalKey === keepKey) ?? null;

  async function undo(decisionId: string) {
    setError(null);
    try {
      await revokeDecision(decisionId);
      try { await reload(); } catch { setError("The decision was undone, but the review list could not refresh. Refresh the list."); }
    } catch (failure) {
      setError(failure instanceof Error ? failure.message : "The decision could not be undone.");
    }
  }

  return (
    <div className="flex min-h-0 flex-1 flex-col overflow-auto">
      <div className="mx-auto w-full max-w-[1440px] pb-10 lg:px-6">
        <header className="border-b pt-1.5 pb-4">
          <h1 className="text-[22px] font-semibold tracking-tight">Tutor Offboarding</h1>
          {/* One string: React SSR separates adjacent text nodes with comments. */}
          <p className="mt-1 text-sm text-muted-foreground">
            {`${topLineSentence(dashboard.summary, dashboard.inbox.filter((row) => row.termination).length, everyone.filter((row) => row.termination).length)} · data ${formatAge(dashboard.snapshotCreatedAt, new Date(dashboard.servedAt))}`}
          </p>
        </header>
        {error ? (
          <Panel className="mt-4 flex flex-wrap items-center justify-between gap-3 px-4 py-3">
            <p role="alert" className="text-sm text-conflict">{error}</p>
            <Button type="button" size="sm" variant="outline" disabled={refreshing} onClick={() => void reload().catch(() => undefined)}>{refreshing ? "Refreshing…" : "Refresh list"}</Button>
          </Panel>
        ) : null}
        {dashboard.freshness.ok ? null : <FreshnessBanner report={dashboard.freshness} />}
        {dashboard.terminationSource ? <TerminationSourcePanel source={dashboard.terminationSource} /> : null}
        <Tabs defaultValue="review" className="mt-5">
          <TabsList>
            <TabsTrigger value="review">To review</TabsTrigger>
            <TabsTrigger value="history">History</TabsTrigger>
          </TabsList>
          <TabsContent value="review">
            <div className="mt-4 grid gap-5 lg:grid-cols-3">
              <div className="lg:col-span-2">
                <Inbox rows={dashboard.inbox} onOpen={setOpenKey} onKeep={setKeepKey} />
              </div>
              <aside className="space-y-4">
                <HowScoreWorks curve={dashboard.curve} />
                <StaffAccounts rows={dashboard.staff} onOpen={setOpenKey} />
                <ExcludedList rows={dashboard.excluded} onOpen={setOpenKey} onUndo={(id) => void undo(id)} />
                {dashboard.viewer.isOwner && dashboard.grants ? (
                  <GrantsPanel grants={dashboard.grants} onChanged={(grants) => setDashboard({ ...dashboard, grants })} />
                ) : null}
              </aside>
            </div>
          </TabsContent>
          <TabsContent value="history">
            <HistoryTable decisions={dashboard.decisions} />
          </TabsContent>
        </Tabs>
      </div>
      <PersonDrawer row={openRow} onClose={() => setOpenKey(null)} />
      <StillWithUsDialog row={keepRow} onClose={() => setKeepKey(null)} onSaved={reload} />
    </div>
  );
}
