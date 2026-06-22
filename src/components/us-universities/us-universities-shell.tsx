"use client";

import { useCallback, useState } from "react";
import { usePathname, useRouter, useSearchParams } from "next/navigation";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { MAX_COMPARE } from "@/lib/us-universities/constants";
import type { UsUniversitiesOverview } from "@/lib/us-universities/types";
import { OverviewCharts } from "./overview-charts";
import { InstitutionTable } from "./institution-table";
import { ComparePanel } from "./compare-panel";
import { InstitutionProfileDialog } from "./institution-profile";
import { InstitutionSearchCombobox } from "./institution-search-combobox";

type TabKey = "overview" | "browse" | "compare";
const TABS: readonly string[] = ["overview", "browse", "compare"];

function asTab(value: string | null): TabKey {
  return value && TABS.includes(value) ? (value as TabKey) : "overview";
}

function parseIds(value: string | null): number[] {
  return (value ?? "")
    .split(",")
    .map((s) => Number.parseInt(s.trim(), 10))
    .filter((n) => Number.isFinite(n) && n > 0)
    .slice(0, MAX_COMPARE);
}

export function UsUniversitiesShell({ overview }: { overview: UsUniversitiesOverview }) {
  const router = useRouter();
  const pathname = usePathname();
  const searchParams = useSearchParams();

  const [tab, setTab] = useState<TabKey>(asTab(searchParams.get("tab")));
  const [profileUnitId, setProfileUnitId] = useState<number | null>(() => {
    const u = Number.parseInt(searchParams.get("unitId") ?? "", 10);
    return Number.isFinite(u) && u > 0 ? u : null;
  });
  const [compareIds, setCompareIds] = useState<number[]>(() => parseIds(searchParams.get("compare")));

  const syncUrl = useCallback(
    (next: { tab?: TabKey; unitId?: number | null; compare?: number[] }) => {
      const params = new URLSearchParams(searchParams.toString());
      params.set("tab", next.tab ?? tab);
      const unit = next.unitId !== undefined ? next.unitId : profileUnitId;
      if (unit) params.set("unitId", String(unit));
      else params.delete("unitId");
      const compare = next.compare ?? compareIds;
      if (compare.length) params.set("compare", compare.join(","));
      else params.delete("compare");
      router.replace(`${pathname}?${params.toString()}`, { scroll: false });
    },
    [searchParams, tab, profileUnitId, compareIds, pathname, router],
  );

  const changeTab = useCallback(
    (value: string) => {
      const next = asTab(value);
      setTab(next);
      syncUrl({ tab: next });
    },
    [syncUrl],
  );

  const openProfile = useCallback(
    (unitId: number) => {
      setProfileUnitId(unitId);
      syncUrl({ unitId });
    },
    [syncUrl],
  );

  const closeProfile = useCallback(() => {
    setProfileUnitId(null);
    syncUrl({ unitId: null });
  }, [syncUrl]);

  const addCompare = useCallback(
    (unitId: number) => {
      setCompareIds((prev) => {
        if (prev.includes(unitId) || prev.length >= MAX_COMPARE) return prev;
        const next = [...prev, unitId];
        syncUrl({ compare: next });
        return next;
      });
    },
    [syncUrl],
  );

  const removeCompare = useCallback(
    (unitId: number) => {
      setCompareIds((prev) => {
        const next = prev.filter((id) => id !== unitId);
        syncUrl({ compare: next });
        return next;
      });
    },
    [syncUrl],
  );

  const clearCompare = useCallback(() => {
    setCompareIds([]);
    syncUrl({ compare: [] });
  }, [syncUrl]);

  return (
    // Research page: opt out of the app's viewport-locked single-screen layout —
    // the whole page scrolls so all overview charts + the compare SAT chart are
    // reachable (the (app) <main> is overflow-hidden).
    <div className="flex min-h-0 flex-1 flex-col gap-4 overflow-y-auto p-4 md:p-6">
      <header className="flex flex-col gap-3 md:flex-row md:items-center md:justify-between">
        <div>
          <h1 className="text-2xl font-semibold tracking-tight">US Universities</h1>
          <p className="text-sm text-muted-foreground">
            {overview.totalInstitutions.toLocaleString()} four-year universities · IPEDS {overview.dataYear}
          </p>
        </div>
        <div className="w-full md:w-80">
          <InstitutionSearchCombobox
            placeholder="Search universities…"
            onSelect={(unitId) => openProfile(unitId)}
          />
        </div>
      </header>

      <Tabs value={tab} onValueChange={changeTab} className="flex flex-col gap-3">
        <TabsList>
          <TabsTrigger value="overview">Overview</TabsTrigger>
          <TabsTrigger value="browse">Browse</TabsTrigger>
          <TabsTrigger value="compare">
            Compare{compareIds.length ? ` (${compareIds.length})` : ""}
          </TabsTrigger>
        </TabsList>

        {/* keepMounted so browse filters/sort/page (and chart instances) survive
            tab switches — base-ui Tabs.Panel unmounts inactive panels by default. */}
        <TabsContent value="overview" keepMounted>
          <OverviewCharts overview={overview} active={tab === "overview"} onSelect={openProfile} />
        </TabsContent>
        <TabsContent value="browse" keepMounted>
          <InstitutionTable
            overview={overview}
            onSelect={openProfile}
            onAddCompare={addCompare}
            compareIds={compareIds}
          />
        </TabsContent>
        <TabsContent value="compare" keepMounted>
          <ComparePanel
            unitIds={compareIds}
            onRemove={removeCompare}
            onAdd={addCompare}
            onClear={clearCompare}
          />
        </TabsContent>
      </Tabs>

      <InstitutionProfileDialog
        unitId={profileUnitId}
        onClose={closeProfile}
        onAddCompare={addCompare}
      />
    </div>
  );
}
