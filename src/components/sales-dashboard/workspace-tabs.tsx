"use client";

import { useCallback, useEffect, useState, type ReactNode } from "react";
import { usePathname, useRouter, useSearchParams } from "next/navigation";
import { Button } from "@/components/ui/button";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { useSalesDimensions } from "@/hooks/use-sales-dimensions";
import type { ExploreSeed, SalesTabProps, SalesWorkspaceTab } from "@/lib/sales-dashboard/types";
import { PackagesTab } from "./tabs/packages-tab";
import { ProgramsTab } from "./tabs/programs-tab";
import { RepsTab } from "./tabs/reps-tab";
import { StudentsTab } from "./tabs/students-tab";

// ----------------------------------------------------------------------------
// Tabbed workspace container. Overview keeps the existing command center
// untouched; the four breakdown tabs are lazy-mounted on first activation and
// kept mounted afterwards. Owns the single useSalesDimensions() instance and
// the ?tab= URL sync.
// ----------------------------------------------------------------------------

const TAB_KEYS: readonly SalesWorkspaceTab[] = ["overview", "reps", "programs", "packages", "students"];

const TAB_LABELS: Record<SalesWorkspaceTab, string> = {
  overview: "Overview",
  reps: "Reps",
  programs: "Programs",
  packages: "Packages",
  students: "Students",
};

const PANELS: Record<Exclude<SalesWorkspaceTab, "overview">, (props: SalesTabProps) => ReactNode> = {
  reps: RepsTab,
  programs: ProgramsTab,
  packages: PackagesTab,
  students: StudentsTab,
};

function asWorkspaceTab(value: string | null): SalesWorkspaceTab {
  return TAB_KEYS.includes(value as SalesWorkspaceTab) ? (value as SalesWorkspaceTab) : "overview";
}

interface WorkspaceTabsProps {
  /** The existing Overview content (setup state + GM command center). */
  overview: ReactNode;
  from: string;
  to: string;
  /** GM cross-link seed from the shell; consumed once on arrival. */
  seed: ExploreSeed | null;
  onSeedConsumed: () => void;
}

export function WorkspaceTabs({ overview, from, to, seed, onSeedConsumed }: WorkspaceTabsProps) {
  const router = useRouter();
  const pathname = usePathname();
  const searchParams = useSearchParams();
  const urlTab = asWorkspaceTab(searchParams.get("tab"));
  const [activeTab, setActiveTab] = useState<SalesWorkspaceTab>(urlTab);
  const [trackedUrlTab, setTrackedUrlTab] = useState<SalesWorkspaceTab>(urlTab);
  const [activated, setActivated] = useState<ReadonlySet<SalesWorkspaceTab>>(() => new Set([urlTab]));
  const [panelSeed, setPanelSeed] = useState<ExploreSeed | null>(null);

  // Follow back/forward navigation: when the URL's ?tab= changes underneath
  // us, adopt it during render (sanctioned derived-state adjustment).
  if (urlTab !== trackedUrlTab) {
    setTrackedUrlTab(urlTab);
    setActiveTab(urlTab);
    setActivated((previous) => {
      if (previous.has(urlTab)) return previous;
      const next = new Set(previous);
      next.add(urlTab);
      return next;
    });
  }

  const panelsTouched = activeTab !== "overview" || [...activated].some((tab) => tab !== "overview");
  const { dimensions, loading, error, invalidate } = useSalesDimensions({ enabled: panelsTouched });

  const selectTab = useCallback((tab: SalesWorkspaceTab) => {
    setActiveTab(tab);
    setActivated((previous) => {
      if (previous.has(tab)) return previous;
      const next = new Set(previous);
      next.add(tab);
      return next;
    });
    const params = new URLSearchParams(searchParams.toString());
    if (tab === "overview") params.delete("tab");
    else params.set("tab", tab);
    const query = params.toString();
    router.replace(query ? `${pathname}?${query}` : pathname, { scroll: false });
  }, [pathname, router, searchParams]);

  // Consume GM cross-link seeds: switch tab, hand the seed to the panel, then
  // notify the shell. Must run as an effect (it updates the parent's state).
  useEffect(() => {
    if (!seed) return;
    // eslint-disable-next-line react-hooks/set-state-in-effect -- one-shot seed handoff from the shell, consumed immediately
    setPanelSeed(seed);
    selectTab(seed.tab);
    onSeedConsumed();
  }, [seed, selectTab, onSeedConsumed]);

  return (
    <Tabs
      value={activeTab}
      onValueChange={(value) => selectTab(asWorkspaceTab(typeof value === "string" ? value : null))}
      className="gap-3"
    >
      <TabsList variant="line" className="border-b pb-1">
        {TAB_KEYS.map((tab) => (
          <TabsTrigger key={tab} value={tab} className="px-2.5">
            {TAB_LABELS[tab]}
          </TabsTrigger>
        ))}
      </TabsList>

      {activeTab !== "overview" && error && !dimensions && !loading ? (
        <div className="flex flex-wrap items-center justify-between gap-3 rounded-md border border-destructive/30 bg-destructive/10 px-3 py-2 text-sm text-destructive">
          <span>Failed to load sales dimensions: {error}</span>
          <Button size="sm" variant="outline" onClick={invalidate}>
            Retry
          </Button>
        </div>
      ) : null}

      <TabsContent value="overview" keepMounted>
        {overview}
      </TabsContent>

      {(Object.keys(PANELS) as Array<keyof typeof PANELS>).map((tab) => {
        const Panel = PANELS[tab];
        return (
          <TabsContent key={tab} value={tab} keepMounted>
            {activated.has(tab) ? (
              <Panel
                dimensions={dimensions}
                loading={loading}
                from={from}
                to={to}
                seed={panelSeed?.tab === tab ? panelSeed : undefined}
                active={activeTab === tab}
              />
            ) : null}
          </TabsContent>
        );
      })}
    </Tabs>
  );
}
