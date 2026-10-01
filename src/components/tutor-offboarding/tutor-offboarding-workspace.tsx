"use client";

import { useCallback, useState } from "react";
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

const UNAVAILABLE: Record<OffboardingUnavailableReason, string> = {
  not_set_up: "Tutor Offboarding is not set up yet: its database migration has not been applied.",
  no_snapshot: "No Wise snapshot is active yet, so there is nobody to score.",
  load_failed: "The page could not load. Try again in a minute; if it keeps failing, check Data Health.",
};

export function TutorOffboardingWorkspace({ initial }: { initial: OffboardingDashboard }) {
  const [dashboard, setDashboard] = useState(initial);
  const [openKey, setOpenKey] = useState<string | null>(null);
  const [keepKey, setKeepKey] = useState<string | null>(null);

  const reload = useCallback(async () => {
    const response = await fetch("/api/tutor-offboarding", { cache: "no-store" });
    if (response.ok) setDashboard((await response.json()) as OffboardingDashboard);
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
    await fetch(`/api/tutor-offboarding/decisions/${decisionId}`, { method: "DELETE" });
    await reload();
  }

  return (
    <div className="flex min-h-0 flex-1 flex-col overflow-auto">
      <div className="mx-auto w-full max-w-[1440px] pb-10 lg:px-6">
        <header className="border-b pt-1.5 pb-4">
          <h1 className="text-[22px] font-semibold tracking-tight">Tutor Offboarding</h1>
          {/* One string: React SSR separates adjacent text nodes with comments. */}
          <p className="mt-1 text-sm text-muted-foreground">
            {`${topLineSentence(dashboard.summary)} · data ${formatAge(dashboard.snapshotCreatedAt, new Date(dashboard.servedAt))}`}
          </p>
        </header>
        {dashboard.freshness.ok ? null : <FreshnessBanner report={dashboard.freshness} />}
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
