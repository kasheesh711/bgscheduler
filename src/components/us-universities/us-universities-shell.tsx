"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { usePathname, useRouter, useSearchParams } from "next/navigation";
import { Separator } from "@/components/ui/separator";
import { DEFAULT_PAGE_SIZE, MAX_COMPARE } from "@/lib/us-universities/constants";
import type {
  FilterParams,
  InstitutionListResult,
  IpedsInstitutionListItem,
  UsUniversitiesOverview,
} from "@/lib/us-universities/types";
import { dossierHref } from "@/lib/us-universities/nav";
import { OverviewCharts } from "./overview-charts";
import {
  InstitutionTable,
  applyChartFilter,
  buildSearchQuery,
  isSortableKey,
  toggleSort,
} from "./institution-table";
import { CountBanner } from "@/components/us-universities/count-banner";
import { FilterChipTray } from "@/components/us-universities/filter-chip-tray";
import { CardTableToggle, type ResultsView } from "@/components/us-universities/card-table-toggle";
import { InstitutionCard } from "@/components/us-universities/institution-card";
import { Download } from "lucide-react";
import { buttonVariants } from "@/components/ui/button";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
// eslint-disable-next-line @typescript-eslint/no-unused-vars
import { ComparePanel } from "./compare-panel";
// eslint-disable-next-line @typescript-eslint/no-unused-vars
import { InstitutionProfileDialog } from "./institution-profile";
import { InstitutionSearchCombobox } from "./institution-search-combobox";
import { ShortlistBar, resolveShortlistEntries } from "./shortlist-bar";
import { CompareSheet } from "./compare-sheet";
import { KpiHero } from "./kpi-hero";
import { ConsoleSupplyMap } from "./console-supply-map";

const SORT_OPTIONS: { value: string; label: string }[] = [
  { value: "instName", label: "Name (A–Z)" },
  { value: "acceptanceRate", label: "Acceptance %" },
  { value: "satReadingP75", label: "SAT (read)" },
  { value: "enrollmentTotal", label: "Enrollment" },
  { value: "gradRateBach6yr", label: "Grad 6yr %" },
  { value: "avgNetPrice", label: "Net price" },
];

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

/**
 * Legacy deep-link bridge: a stale `?unitId=N` Console URL (from the old modal
 * era) is rewritten to the dossier route, carrying any `?compare=` shortlist
 * and dropping the obsolete tab/unitId params. Returns null when there is no
 * valid legacy unitId. Pure + exported for tests.
 */
export function legacyUnitIdRedirect(searchParams: URLSearchParams): string | null {
  const raw = searchParams.get("unitId");
  if (!raw) return null;
  const unitId = Number.parseInt(raw, 10);
  if (!Number.isFinite(unitId) || unitId <= 0) return null;
  const compareIds = parseIds(searchParams.get("compare"));
  // Filters are not modelled in the legacy URL beyond compare; pass empty.
  return dossierHref(unitId, {} as FilterParams, compareIds);
}

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

  const [compareIds, setCompareIds] = useState<number[]>(() => parseIds(getParam("compare")));
  const [compareOpen, setCompareOpen] = useState(false);

  // Lifted browse-search state (was inside InstitutionTable).
  // Initialize from URL params so a hard refresh or consoleHref round-trip
  // restores the active sort/filter/page state (D-04: URL is the source of truth).
  const [filters, setFilters] = useState<FilterParams>(() => {
    const sp = searchParams;
    if (!sp) return INITIAL_FILTERS;
    const p = (k: string) => sp.get(k);
    const coerceInt = (v: string | null) => {
      const n = Number.parseInt(v ?? "", 10);
      return Number.isFinite(n) && n > 0 ? n : undefined;
    };
    const coerceFloat = (v: string | null) => {
      const n = Number.parseFloat(v ?? "");
      return Number.isFinite(n) ? n : undefined;
    };
    const states = p("states") ? p("states")!.split(",").filter(Boolean) : undefined;
    const control = p("control")
      ? p("control")!.split(",").map(Number).filter((n) => Number.isFinite(n) && n > 0)
      : undefined;
    return {
      search: p("search") ?? undefined,
      states: states && states.length > 0 ? states : undefined,
      control: control && control.length > 0 ? control : undefined,
      minAcceptance: coerceFloat(p("minAcceptance")),
      maxAcceptance: coerceFloat(p("maxAcceptance")),
      maxNetPrice: coerceFloat(p("maxNetPrice")),
      minGradRate: coerceFloat(p("minGradRate")),
      cip2: p("cip2") ?? undefined,
      sort: p("sort") ?? INITIAL_FILTERS.sort,
      dir: (p("dir") === "desc" ? "desc" : "asc") as "asc" | "desc",
      page: coerceInt(p("page")) ?? 1,
      pageSize: coerceInt(p("pageSize")) ?? DEFAULT_PAGE_SIZE,
    };
  });
  const [rows, setRows] = useState<IpedsInstitutionListItem[]>([]);
  const [total, setTotal] = useState(0);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [resultsView, setResultsView] = useState<ResultsView>("cards");
  const [supplyMapOpen, setSupplyMapOpen] = useState(false);

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
      compare?: number[];
      filters?: FilterParams;
    }) => {
      const params = new URLSearchParams(searchParams?.toString() ?? "");
      // unitId belongs on the dossier route; never carry it in the Console URL.
      params.delete("unitId");
      // Drop the legacy ?tab= param — the Console has no tabs.
      params.delete("tab");
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
    [searchParams, compareIds, filters, pathname, router],
  );

  const openDossier = useCallback(
    (unitId: number) => {
      router.push(dossierHref(unitId, filters, compareIds));
    },
    [router, filters, compareIds],
  );

  const resultsRef = useRef<HTMLDivElement | null>(null);

  const handleChartFilter = useCallback(
    (patch: Partial<FilterParams>) => {
      const next = applyChartFilter(filters, patch);
      setFilters(next);
      syncUrl({ filters: next });
      resultsRef.current?.scrollIntoView({ behavior: "smooth", block: "start" });
    },
    [filters, syncUrl],
  );

  const handleClearChip = useCallback(
    (patch: Partial<FilterParams>) => {
      const next = { ...applyChartFilter(filters, patch), page: 1 };
      setFilters(next);
      syncUrl({ filters: next });
    },
    [filters, syncUrl],
  );

  const handleClearAll = useCallback(() => {
    const next: FilterParams = {
      sort: filters.sort,
      dir: filters.dir,
      pageSize: filters.pageSize,
      page: 1,
    };
    setFilters(next);
    syncUrl({ filters: next });
  }, [filters, syncUrl]);

  const handleSortChange = useCallback(
    (next: string | null) => {
      if (!next) return;
      const updated = { ...filters, sort: next, page: 1 };
      setFilters(updated);
      syncUrl({ filters: updated });
    },
    [filters, syncUrl],
  );

  // Redirect legacy ?unitId= deep links to the dossier route on first render.
  useEffect(() => {
    const href = legacyUnitIdRedirect(new URLSearchParams(searchParams?.toString() ?? ""));
    if (href) router.replace(href, { scroll: false });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

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
            onSelect={(unitId) => openDossier(unitId)}
          />
        </div>
      </header>

      <KpiHero overview={overview} />

      <OverviewCharts
        overview={overview}
        active
        onSelect={openDossier}
        onFilter={handleChartFilter}
      />

      <Separator />

      <div id="us-universities-results" ref={resultsRef} className="min-h-0 flex-1 scroll-mt-4">
        <div className="flex flex-col gap-3">
          <div className="sticky top-0 z-10 flex flex-wrap items-center justify-between gap-3 border-b bg-background/95 py-2 backdrop-blur supports-[backdrop-filter]:bg-background/80">
            <CountBanner count={loading ? null : total} total={overview.totalInstitutions} loading={loading} />
            <div className="flex flex-wrap items-center gap-2">
              <CardTableToggle view={resultsView} onChange={setResultsView} />
              <Select value={filters.sort ?? "instName"} onValueChange={handleSortChange}>
                <SelectTrigger aria-label="Sort results" className="h-8 w-44 bg-background">
                  <SelectValue placeholder="Sort by" />
                </SelectTrigger>
                <SelectContent align="end">
                  {SORT_OPTIONS.map((option) => (
                    <SelectItem key={option.value} value={option.value}>
                      {option.label}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
              <a
                href={`/api/us-universities/export?${buildSearchQuery(filters)}`}
                download
                aria-label="Download current results as CSV"
                className={buttonVariants({ variant: "outline", size: "sm" })}
              >
                <Download aria-hidden className="size-4" />
                Download CSV
              </a>
            </div>
          </div>

          <FilterChipTray
            filters={filters}
            overview={overview}
            onClear={handleClearChip}
            onClearAll={handleClearAll}
          />

          <ConsoleSupplyMap
            rows={rows}
            open={supplyMapOpen}
            onToggle={setSupplyMapOpen}
          />

          {error ? (
            <div className="rounded-lg border border-destructive/40 bg-destructive/5 p-4 text-sm text-destructive">
              {error}
            </div>
          ) : !loading && rows.length === 0 ? (
            <div className="rounded-lg border bg-card p-10 text-center text-sm text-muted-foreground">
              No universities match — remove a chip to widen.
            </div>
          ) : resultsView === "cards" ? (
            <div className="grid gap-3 [grid-template-columns:repeat(auto-fill,minmax(190px,1fr))]">
              {loading
                ? Array.from({ length: 8 }).map((_, index) => (
                    <div
                      key={`card-skeleton-${index}`}
                      className="h-56 animate-pulse rounded-lg border bg-muted"
                    />
                  ))
                : rows.map((row) => (
                    <InstitutionCard
                      key={row.unitId}
                      row={row}
                      inCompare={compareIds.includes(row.unitId)}
                      compareFull={compareIds.length >= MAX_COMPARE}
                      onSelect={openDossier}
                      onAddCompare={addCompare}
                    />
                  ))}
            </div>
          ) : (
            <InstitutionTable
              rows={rows}
              total={total}
              loading={loading}
              error={error}
              filters={filters}
              states={overview.states}
              cip2Options={overview.cip2Options}
              onSort={onSort}
              onSelect={openDossier}
              onAddCompare={addCompare}
              onFilterChange={onFilterChange}
              onPage={onPage}
              compareIds={compareIds}
            />
          )}
        </div>
      </div>

      <ShortlistBar
        entries={resolveShortlistEntries(compareIds, rows)}
        onRemove={removeCompare}
        onClear={clearCompare}
        onOpenCompare={() => setCompareOpen(true)}
      />
      <CompareSheet
        open={compareOpen}
        onOpenChange={setCompareOpen}
        unitIds={compareIds}
        onRemove={removeCompare}
        onAdd={addCompare}
        onClear={clearCompare}
      />
    </div>
  );
}
