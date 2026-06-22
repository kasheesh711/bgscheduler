"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { Search } from "lucide-react";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import {
  Command,
  CommandEmpty,
  CommandGroup,
  CommandInput,
  CommandItem,
  CommandList,
} from "@/components/ui/command";
import { cn } from "@/lib/utils";
import type { IpedsInstitutionSummary } from "@/lib/us-universities/types";
import type { InstitutionSearchComboboxProps } from "./view-types";

// -----------------------------------------------------------------------------
// Async institution combobox. Typing fans out a debounced, abortable request to
// the read-only search API (server-side filtering), so cmdk's built-in client
// filter is disabled — every fetched row is shown verbatim. Selecting a row
// calls onSelect(unitId, name) and closes the popover.
// -----------------------------------------------------------------------------

const SUGGEST_LIMIT = 10;
const DEBOUNCE_MS = 220;

/**
 * Build the query string for the suggestion fetch. Trims the term, caps the
 * page size, and URL-encodes the search so callers (and tests) get a stable,
 * injection-safe path. Returns the path relative to the API root.
 */
export function buildSuggestQuery(q: string): string {
  const params = new URLSearchParams();
  params.set("search", q.trim());
  params.set("pageSize", String(SUGGEST_LIMIT));
  return `/api/us-universities/search?${params.toString()}`;
}

export function InstitutionSearchCombobox({
  placeholder = "Search institutions…",
  onSelect,
}: InstitutionSearchComboboxProps) {
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState("");
  const [rows, setRows] = useState<IpedsInstitutionSummary[]>([]);
  const [loading, setLoading] = useState(false);
  const abortRef = useRef<AbortController | null>(null);

  useEffect(() => {
    const term = query.trim();
    abortRef.current?.abort();
    // All state updates happen inside the timer callback (not synchronously in
    // the effect body) so the fetch effect stays a clean external subscription.
    const handle = window.setTimeout(
      () => {
        if (term.length === 0) {
          setRows([]);
          setLoading(false);
          return;
        }
        setLoading(true);
        const controller = new AbortController();
        abortRef.current = controller;

        fetch(buildSuggestQuery(term), { signal: controller.signal })
          .then((res) => (res.ok ? res.json() : Promise.reject(new Error(String(res.status)))))
          .then((data: { rows?: IpedsInstitutionSummary[] }) => {
            setRows(Array.isArray(data.rows) ? data.rows : []);
            setLoading(false);
          })
          .catch((err: unknown) => {
            if (err instanceof DOMException && err.name === "AbortError") return;
            console.error("Institution suggest failed", err);
            setRows([]);
            setLoading(false);
          });
      },
      term.length === 0 ? 0 : DEBOUNCE_MS,
    );

    return () => window.clearTimeout(handle);
  }, [query]);

  useEffect(() => () => abortRef.current?.abort(), []);

  const handleSelect = useCallback(
    (row: IpedsInstitutionSummary) => {
      onSelect(row.unitId, row.instName);
      setOpen(false);
      setQuery("");
      setRows([]);
    },
    [onSelect],
  );

  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger
        render={(props) => (
          <button
            {...props}
            type="button"
            className={cn(
              "flex h-8 w-full items-center gap-2 rounded-lg border border-border bg-background px-2.5 text-left text-sm",
              "hover:bg-muted hover:text-foreground aria-expanded:bg-muted",
            )}
          >
            <Search className="h-3.5 w-3.5 shrink-0 text-muted-foreground" aria-hidden="true" />
            <span className="truncate text-muted-foreground">{placeholder}</span>
          </button>
        )}
      />
      <PopoverContent className="w-[var(--reference-width)] min-w-72 p-0" align="start">
        <Command shouldFilter={false}>
          <CommandInput
            value={query}
            onValueChange={setQuery}
            placeholder={placeholder}
            aria-label="Search institutions"
          />
          <CommandList>
            {loading ? (
              <div className="py-6 text-center text-sm text-muted-foreground">Searching…</div>
            ) : query.trim().length === 0 ? (
              <div className="py-6 text-center text-sm text-muted-foreground">
                Type to search institutions
              </div>
            ) : (
              <>
                <CommandEmpty>No institutions found.</CommandEmpty>
                <CommandGroup>
                  {rows.map((row) => (
                    <CommandItem
                      key={row.unitId}
                      value={String(row.unitId)}
                      onSelect={() => handleSelect(row)}
                    >
                      <span className="truncate font-medium">{row.instName}</span>
                      {row.stateAbbr ? (
                        <span className="ml-auto shrink-0 text-xs text-muted-foreground">
                          {row.stateAbbr}
                        </span>
                      ) : null}
                    </CommandItem>
                  ))}
                </CommandGroup>
              </>
            )}
          </CommandList>
        </Command>
      </PopoverContent>
    </Popover>
  );
}
