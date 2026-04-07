"use client";

import { useState, useEffect } from "react";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { SlotBuilder } from "@/components/search/slot-builder";
import { SlotChips } from "@/components/search/slot-chips";
import { ResultsView } from "@/components/search/results-view";
import type { SearchSlot, SearchResponse, SearchMode } from "@/lib/search/types";

interface FilterOptions {
  subjects: string[];
  curriculums: string[];
  levels: string[];
}

export default function SearchPage() {
  const [slots, setSlots] = useState<SearchSlot[]>([]);
  const [searchMode, setSearchMode] = useState<SearchMode>("recurring");
  const [modeFilter, setModeFilter] = useState<"online" | "onsite" | "either">("either");
  const [subjectFilter, setSubjectFilter] = useState("");
  const [curriculumFilter, setCurriculumFilter] = useState("");
  const [levelFilter, setLevelFilter] = useState("");
  const [filterOptions, setFilterOptions] = useState<FilterOptions | null>(null);

  useEffect(() => {
    fetch("/api/filters")
      .then((res) => (res.ok ? res.json() : null))
      .then((data) => { if (data) setFilterOptions(data); })
      .catch(() => {});
  }, []);
  const [response, setResponse] = useState<SearchResponse | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const handleAddSlot = (slot: SearchSlot) => {
    setSlots((prev) => [...prev, slot]);
  };

  const handleRemoveSlot = (id: string) => {
    setSlots((prev) => prev.filter((s) => s.id !== id));
  };

  const handleSearch = async () => {
    if (slots.length === 0) return;

    setLoading(true);
    setError(null);

    try {
      const res = await fetch("/api/search", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          searchMode,
          slots: slots.map((s) => ({ ...s, mode: modeFilter })),
          filters: {
            subject: subjectFilter || undefined,
            curriculum: curriculumFilter || undefined,
            level: levelFilter || undefined,
          },
        }),
      });

      if (!res.ok) {
        const data = await res.json().catch(() => ({}));
        throw new Error(data.error ?? `Search failed (${res.status})`);
      }

      const data: SearchResponse = await res.json();
      setResponse(data);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Search failed");
    } finally {
      setLoading(false);
    }
  };

  return (
    <div className="mx-auto max-w-6xl p-6 space-y-6">
      <div className="flex items-center justify-between">
        <h1 className="text-2xl font-bold">Tutor Availability Search</h1>
        <a href="/data-health" className="text-sm text-blue-600 hover:underline">
          Data Health
        </a>
      </div>

      <Card>
        <CardHeader>
          <CardTitle>Search Criteria</CardTitle>
        </CardHeader>
        <CardContent className="space-y-4">
          {/* Search mode toggle */}
          <div className="flex gap-2">
            <Button
              variant={searchMode === "recurring" ? "default" : "outline"}
              onClick={() => {
                setSearchMode("recurring");
                setSlots([]);
              }}
              size="sm"
            >
              Recurring Weekly
            </Button>
            <Button
              variant={searchMode === "one_time" ? "default" : "outline"}
              onClick={() => {
                setSearchMode("one_time");
                setSlots([]);
              }}
              size="sm"
            >
              One-Time
            </Button>
          </div>

          {/* Structured slot builder */}
          <SlotBuilder searchMode={searchMode} onAdd={handleAddSlot} />

          {/* Slot chips */}
          <SlotChips slots={slots} onRemove={handleRemoveSlot} />

          {/* Filters */}
          <div className="grid grid-cols-4 gap-2">
            <div>
              <label className="text-xs font-medium text-muted-foreground">Mode</label>
              <select
                className="w-full rounded-md border px-2 py-1.5 text-sm"
                value={modeFilter}
                onChange={(e) => setModeFilter(e.target.value as "online" | "onsite" | "either")}
              >
                <option value="either">Either</option>
                <option value="online">Online</option>
                <option value="onsite">Onsite</option>
              </select>
            </div>
            <div>
              <label className="text-xs font-medium text-muted-foreground">Subject</label>
              <select
                className="w-full rounded-md border px-2 py-1.5 text-sm"
                value={subjectFilter}
                onChange={(e) => setSubjectFilter(e.target.value)}
              >
                <option value="">Any</option>
                {filterOptions?.subjects.map((s) => (
                  <option key={s} value={s}>{s}</option>
                ))}
              </select>
            </div>
            <div>
              <label className="text-xs font-medium text-muted-foreground">Curriculum</label>
              <select
                className="w-full rounded-md border px-2 py-1.5 text-sm"
                value={curriculumFilter}
                onChange={(e) => setCurriculumFilter(e.target.value)}
              >
                <option value="">Any</option>
                {filterOptions?.curriculums.map((c) => (
                  <option key={c} value={c}>{c}</option>
                ))}
              </select>
            </div>
            <div>
              <label className="text-xs font-medium text-muted-foreground">Level</label>
              <select
                className="w-full rounded-md border px-2 py-1.5 text-sm"
                value={levelFilter}
                onChange={(e) => setLevelFilter(e.target.value)}
              >
                <option value="">Any</option>
                {filterOptions?.levels.map((l) => (
                  <option key={l} value={l}>{l}</option>
                ))}
              </select>
            </div>
          </div>

          {/* Search button */}
          <Button onClick={handleSearch} disabled={loading || slots.length === 0} className="w-full">
            {loading ? "Searching..." : "Search"}
          </Button>

          {error && (
            <div className="rounded-md bg-red-50 p-3 text-sm text-red-700">{error}</div>
          )}
        </CardContent>
      </Card>

      {/* Results */}
      {response && <ResultsView response={response} />}
    </div>
  );
}
