"use client";

import { useState, useEffect, useCallback } from "react";
import { useSearchParams } from "next/navigation";
import { SearchForm } from "@/components/search/search-form";
import type { SearchContext } from "@/components/search/search-form";
import type { FilterOptions } from "@/lib/data/filters";
import type { TutorListItem } from "@/lib/data/tutors";
import { SearchResults } from "@/components/search/search-results";
import { ComparePanel } from "@/components/compare/compare-panel";
import { useCompare } from "@/hooks/use-compare";
import type { RangeSearchResponse } from "@/lib/search/types";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

interface SearchWorkspaceProps {
  filterOptions: FilterOptions;
  tutorList: TutorListItem[];
}

// ---------------------------------------------------------------------------
// SearchWorkspace component
// ---------------------------------------------------------------------------

export function SearchWorkspace({ filterOptions, tutorList }: SearchWorkspaceProps) {
  const searchParams = useSearchParams();
  const compare = useCompare();

  const [response, setResponse] = useState<RangeSearchResponse | null>(null);
  const [searchContext, setSearchContext] = useState<SearchContext | null>(null);
  const [error, setError] = useState<string | null>(null);

  // Handle ?tutors= deep link
  useEffect(() => {
    const tutorIds =
      searchParams.get("tutors")?.split(",").filter(Boolean) ?? [];
    if (tutorIds.length > 0) {
      compare.fetchCompare(tutorIds, compare.weekStart);
    }
  }, []); // eslint-disable-line react-hooks/exhaustive-deps

  // --- Communication wiring ---
  const handleSearchResponse = useCallback((data: RangeSearchResponse, context: SearchContext) => {
    setResponse(data);
    setSearchContext(context);
    setError(null);
  }, []);

  const handleCompareSelected = useCallback((ids: string[]) => {
    compare.tutorCache.current.clear();
    compare.fetchCompare(ids, compare.weekStart);
  }, [compare]);

  return (
    <div className="flex-1 flex gap-3 overflow-hidden min-h-0">
      <div className="w-1/2 flex flex-col overflow-hidden min-w-0 border-r border-border/50 pr-3">
        <SearchForm
          filterOptions={filterOptions}
          onSearchResponse={handleSearchResponse}
          onError={setError}
        />
        {error && (
          <div className="rounded-md bg-destructive/10 p-2 text-xs text-destructive mt-2 flex-shrink-0">
            {error}
          </div>
        )}
        <SearchResults
          response={response}
          loading={false}
          searchContext={searchContext}
          onCompareSelected={handleCompareSelected}
        />
      </div>
      <div className="w-1/2 flex flex-col overflow-hidden min-w-0 pl-1">
        <ComparePanel compare={compare} tutorList={tutorList} />
      </div>
    </div>
  );
}
