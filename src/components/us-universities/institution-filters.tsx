"use client";

import { useEffect, useState } from "react";
import { Input } from "@/components/ui/input";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { CONTROL_LABELS } from "@/lib/us-universities/constants";
import type { FilterParams } from "@/lib/us-universities/types";
import type { InstitutionFiltersProps } from "@/components/us-universities/view-types";

// ----------------------------------------------------------------------------
// Institution filter bar — compact controls that drive the browse table's
// FilterParams. Every change is a pure merge (mergeFilter) onto the current
// value, so the parent stays the single source of truth. The text search is
// locally debounced; the rest commit on change.
// ----------------------------------------------------------------------------

/** Sentinel <SelectItem> value standing in for "no filter" (base-ui needs a value). */
export const ALL_OPTION = "__all__";

const SEARCH_DEBOUNCE_MS = 300;

const CONTROL_OPTIONS = Object.entries(CONTROL_LABELS).map(([value, label]) => ({
  value: Number(value),
  label,
}));

/**
 * Pure, testable merge of a partial patch onto the current filter value.
 * Resetting page to 1 is intentionally left to the caller; this only shallow-
 * merges so callers can decide which paging behaviour they want.
 */
export function mergeFilter(value: FilterParams, patch: Partial<FilterParams>): FilterParams {
  return { ...value, ...patch };
}

/** Parse a numeric input string into a number, or undefined when blank/invalid. */
export function parseNumericInput(raw: string): number | undefined {
  const trimmed = raw.trim();
  if (trimmed === "") return undefined;
  const parsed = Number(trimmed);
  return Number.isFinite(parsed) ? parsed : undefined;
}

export function InstitutionFilters({
  states,
  cip2Options,
  value,
  onChange,
}: InstitutionFiltersProps) {
  // Local mirror of the search box so typing stays snappy; commit on debounce.
  const [searchDraft, setSearchDraft] = useState(value.search ?? "");

  // Keep the draft in sync when the parent resets/replaces filters externally.
  useEffect(() => {
    setSearchDraft(value.search ?? "");
  }, [value.search]);

  useEffect(() => {
    const trimmed = searchDraft.trim();
    const next = trimmed === "" ? undefined : trimmed;
    if (next === (value.search ?? undefined)) return;
    const handle = setTimeout(() => {
      onChange(mergeFilter(value, { search: next, page: 1 }));
    }, SEARCH_DEBOUNCE_MS);
    return () => clearTimeout(handle);
    // value/onChange are intentionally read fresh inside the timeout; we only
    // want to (re)debounce when the draft text changes.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [searchDraft]);

  const selectedState = value.states?.[0] ?? ALL_OPTION;
  const selectedControl =
    value.control && value.control.length > 0 ? String(value.control[0]) : ALL_OPTION;
  const selectedCip2 = value.cip2 ?? ALL_OPTION;

  return (
    <div className="flex flex-wrap items-end gap-3 rounded-lg border bg-card p-3">
      <div className="flex min-w-48 flex-1 flex-col gap-1">
        <label htmlFor="inst-search" className="text-xs font-medium text-muted-foreground">
          Search
        </label>
        <Input
          id="inst-search"
          aria-label="Search institutions"
          placeholder="Search by name or city…"
          value={searchDraft}
          onChange={(event) => setSearchDraft(event.target.value)}
        />
      </div>

      <div className="flex min-w-40 flex-col gap-1">
        <label className="text-xs font-medium text-muted-foreground">State</label>
        <Select
          value={selectedState}
          onValueChange={(next) =>
            onChange(
              mergeFilter(value, {
                states: !next || next === ALL_OPTION ? undefined : [next],
                page: 1,
              }),
            )
          }
        >
          <SelectTrigger aria-label="Filter by state" className="w-full bg-background">
            <SelectValue placeholder="All states" />
          </SelectTrigger>
          <SelectContent align="start">
            <SelectItem value={ALL_OPTION}>All states</SelectItem>
            {states.map((facet) => (
              <SelectItem key={facet.state} value={facet.state}>
                {facet.state} ({facet.count})
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
      </div>

      <div className="flex min-w-44 flex-col gap-1">
        <label className="text-xs font-medium text-muted-foreground">Control</label>
        <Select
          value={selectedControl}
          onValueChange={(next) =>
            onChange(
              mergeFilter(value, {
                control:
                  !next || next === ALL_OPTION ? undefined : [Number(next)],
                page: 1,
              }),
            )
          }
        >
          <SelectTrigger aria-label="Filter by control" className="w-full bg-background">
            <SelectValue placeholder="All types" />
          </SelectTrigger>
          <SelectContent align="start">
            <SelectItem value={ALL_OPTION}>All types</SelectItem>
            {CONTROL_OPTIONS.map((option) => (
              <SelectItem key={option.value} value={String(option.value)}>
                {option.label}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
      </div>

      <div className="flex min-w-52 flex-col gap-1">
        <label className="text-xs font-medium text-muted-foreground">Major</label>
        <Select
          value={selectedCip2}
          onValueChange={(next) =>
            onChange(
              mergeFilter(value, {
                cip2: !next || next === ALL_OPTION ? undefined : next,
                page: 1,
              }),
            )
          }
        >
          <SelectTrigger aria-label="Filter by major" className="w-full bg-background">
            <SelectValue placeholder="All majors" />
          </SelectTrigger>
          <SelectContent align="start">
            <SelectItem value={ALL_OPTION}>All majors</SelectItem>
            {cip2Options.map((option) => (
              <SelectItem key={option.cip2} value={option.cip2}>
                {option.label}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
      </div>

      <div className="flex w-28 flex-col gap-1">
        <label htmlFor="inst-max-acceptance" className="text-xs font-medium text-muted-foreground">
          Max accept %
        </label>
        <Input
          id="inst-max-acceptance"
          aria-label="Maximum acceptance rate"
          type="number"
          inputMode="numeric"
          min={0}
          max={100}
          placeholder="100"
          value={value.maxAcceptance ?? ""}
          onChange={(event) =>
            onChange(
              mergeFilter(value, {
                maxAcceptance: parseNumericInput(event.target.value),
                page: 1,
              }),
            )
          }
        />
      </div>

      <div className="flex w-32 flex-col gap-1">
        <label htmlFor="inst-max-net-price" className="text-xs font-medium text-muted-foreground">
          Max net price
        </label>
        <Input
          id="inst-max-net-price"
          aria-label="Maximum net price"
          type="number"
          inputMode="numeric"
          min={0}
          placeholder="Any"
          value={value.maxNetPrice ?? ""}
          onChange={(event) =>
            onChange(
              mergeFilter(value, {
                maxNetPrice: parseNumericInput(event.target.value),
                page: 1,
              }),
            )
          }
        />
      </div>

      <div className="flex w-28 flex-col gap-1">
        <label htmlFor="inst-min-grad-rate" className="text-xs font-medium text-muted-foreground">
          Min grad %
        </label>
        <Input
          id="inst-min-grad-rate"
          aria-label="Minimum graduation rate"
          type="number"
          inputMode="numeric"
          min={0}
          max={100}
          placeholder="0"
          value={value.minGradRate ?? ""}
          onChange={(event) =>
            onChange(
              mergeFilter(value, {
                minGradRate: parseNumericInput(event.target.value),
                page: 1,
              }),
            )
          }
        />
      </div>
    </div>
  );
}
