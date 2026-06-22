"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { usePathname, useRouter, useSearchParams } from "next/navigation";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { DEFAULT_PAGE_SIZE, MAX_COMPARE } from "@/lib/us-universities/constants";
import type {
  FilterParams,
  InstitutionListResult,
  IpedsInstitutionListItem,
  UsUniversitiesOverview,
} from "@/lib/us-universities/types";
import { OverviewCharts } from "./overview-charts";
import {
  InstitutionTable,
  applyChartFilter,
  buildSearchQuery,
  isSortableKey,
  toggleSort,
} from "./institution-table";
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

const INITIAL_FILTERS: FilterParams = {
  sort: "instName",
  dir: "asc",
  page: 1,
  pageSize: DEFAULT_PAGE_SIZE,
};

export function UsUniversitiesShell({ overview }: { overview: UsUniversitiesOverview }) {
  const router = useRouter();
  const pathname = usePathname();
  // SSR-safe reads: under renderToStaticMarkup there is no router provider so
  // useSearchParams() returns null. Optional-chain all access to avoid throws.
  const searchParams = useSearchParams();
  const getParam = useCallback(
    (key: string): string | null => searchParams?.get(key) ?? null,
    [searchParams],
  );

  const [tab, setTab] = useState<TabKey>(asTab(getParam("tab")));
  const [profileUnitId, setProfileUnitId] = useState<number | null>(() => {
    const u = Number.parseInt(getParam("unitId") ?? "", 10);
    return Number.isFinite(u) && u > 0 ? u : null;
  });
  const [compareIds, setCompareIds] = useState<number[]>(() => parseIds(getParam("compare")));

  // Lifted browse-search state (was inside InstitutionTable).
  const [filters, setFilters] = useState<FilterParams>(INITIAL_FILTERS);
  const [rows, setRows] = useState<IpedsInstitutionListItem[]>([]);
  const [total, setTotal] = useState(0);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const abortRef = useRef<AbortController | null>(null);
  const query = buildSearchQuery(filters);

  // Fetch effect: cancel in-flight on re-run, defer setState via window.setTimeout
  // to avoid setState-in-render warnings (mirrors original table pattern, commit dcc281a).
  useEffect(() => {
    abortRef.current?.abort();
    const controller = new AbortController();
    abortRef.current = controller;

    const handle = window.setTimeout(() => {
      setLoading(true);
      setError(null);

      fetch(`/api/us-universities/search?${query}`, { signal: controller.signal })
        .then(async (response) => {
          if (!response.ok) {
            throw new Error(`Search failed (${response.status})`);
          }
          return (await response.json()) as InstitutionListResult;
        })
        .then((result) => {
          if (controller.signal.aborted) return;
          setRows(result.rows ?? []);
          setTotal(result.total ?? 0);
          setLoading(false);
        })
        .catch((err: unknown) => {
          if (controller.signal.aborted || (err instanceof DOMException && err.name === "AbortError")) {
            return;
          }
          setRows([]);
          setTotal(0);
          setError(err instanceof Error ? err.message : "Failed to load institutions");
          setLoading(false);
        });
    }, 0);

    return () => {
      window.clearTimeout(handle);
      controller.abort();
    };
  }, [query]);

  const syncUrl = useCallback(
    (next: {
      tab?: TabKey;
      unitId?: number | null;
      compare?: number[];
      filters?: FilterParams;
    }) => {
      const params = new URLSearchParams(searchParams?.toString() ?? "");
      params.set("tab", next.tab ?? tab);
      const unit = next.unitId !== undefined ? next.unitId : profileUnitId;
      if (unit) params.set("unitId", String(unit));
      else params.delete("unitId");
      const compare = next.compare ?? compareIds;
      if (compare.length) params.set("compare", compare.join(","));
      else params.delete("compare");
      // Thread the active search filters into the URL via the shared builder so
      // a refresh restores the browse state. buildSearchQuery omits blanks and
      // always emits sort/dir/page/pageSize.
      const fq = new URLSearchParams(buildSearchQuery(next.filters ?? filters));
      for (const [k, v] of fq.entries()) params.set(k, v);
      router.replace(`${pathname}?${params.toString()}`, { scroll: false });
    },
    [searchParams, tab, profileUnitId, compareIds, filters, pathname, router],
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

  const onFilterChange = useCallback(
    (next: FilterParams) => {
      setFilters(next);
      syncUrl({ filters: next });
    },
    [syncUrl],
  );

  const onSort = useCallback(
    (key: string) => {
      setFilters((current) => {
        const next = isSortableKey(key) ? toggleSort(current, key) : current;
        syncUrl({ filters: next });
        return next;
      });
    },
    [syncUrl],
  );

  const onPage = useCallback(
    (nextPage: number) => {
      setFilters((current) => {
        const next = { ...current, page: nextPage };
        syncUrl({ filters: next });
        return next;
      });
    },
    [syncUrl],
  );

  // applyChartFilter is wired by Phase 2 (chart onFilter); kept imported for the
  // cross-filter path. Reference here to document intent without dead-code lint.
  void applyChartFilter;

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
            rows={rows}
            total={total}
            loading={loading}
            error={error}
            filters={filters}
            states={overview.states}
            cip2Options={overview.cip2Options}
            onSort={onSort}
            onSelect={openProfile}
            onAddCompare={addCompare}
            onFilterChange={onFilterChange}
            onPage={onPage}
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
