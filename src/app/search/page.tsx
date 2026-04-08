"use client";

import { useState, useEffect } from "react";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { AvailabilityGrid } from "@/components/search/availability-grid";
import { CopyButton } from "@/components/search/copy-button";
import {
  RecentSearches,
  saveRecent,
  type RecentSearch,
} from "@/components/search/recent-searches";
import type { SearchMode, RangeSearchResponse } from "@/lib/search/types";

interface FilterOptions {
  subjects: string[];
  curriculums: string[];
  levels: string[];
}

const DAY_OPTIONS = [
  { value: 0, label: "Sunday" },
  { value: 1, label: "Monday" },
  { value: 2, label: "Tuesday" },
  { value: 3, label: "Wednesday" },
  { value: 4, label: "Thursday" },
  { value: 5, label: "Friday" },
  { value: 6, label: "Saturday" },
];

const DURATION_OPTIONS = [
  { value: 60, label: "1 hour" },
  { value: 90, label: "1.5 hours" },
  { value: 120, label: "2 hours" },
];

function generateTimeOptions(): string[] {
  const times: string[] = [];
  for (let h = 0; h < 24; h++) {
    for (let m = 0; m < 60; m += 15) {
      times.push(`${String(h).padStart(2, "0")}:${String(m).padStart(2, "0")}`);
    }
  }
  return times;
}

const TIME_OPTIONS = generateTimeOptions();

export default function SearchPage() {
  const [searchMode, setSearchMode] = useState<SearchMode>("recurring");
  const [dayOfWeek, setDayOfWeek] = useState(1); // Monday
  const [date, setDate] = useState("");
  const [startTime, setStartTime] = useState("09:00");
  const [endTime, setEndTime] = useState("17:00");
  const [durationMinutes, setDurationMinutes] = useState(60);
  const [modeFilter, setModeFilter] = useState<"online" | "onsite" | "either">("either");
  const [subjectFilter, setSubjectFilter] = useState("");
  const [curriculumFilter, setCurriculumFilter] = useState("");
  const [levelFilter, setLevelFilter] = useState("");
  const [filterOptions, setFilterOptions] = useState<FilterOptions | null>(null);

  const [response, setResponse] = useState<RangeSearchResponse | null>(null);
  const [selectedIds, setSelectedIds] = useState<Set<string>>(new Set());
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    fetch("/api/filters")
      .then((res) => (res.ok ? res.json() : null))
      .then((data) => {
        if (data) setFilterOptions(data);
      })
      .catch(() => {});
  }, []);

  const handleSearch = async () => {
    setLoading(true);
    setError(null);
    setSelectedIds(new Set());

    const params = {
      searchMode,
      dayOfWeek: searchMode === "recurring" ? dayOfWeek : undefined,
      date: searchMode === "one_time" ? date : undefined,
      startTime,
      endTime,
      durationMinutes,
      mode: modeFilter,
      filters: {
        subject: subjectFilter || undefined,
        curriculum: curriculumFilter || undefined,
        level: levelFilter || undefined,
      },
    };

    try {
      const res = await fetch("/api/search/range", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(params),
      });

      if (!res.ok) {
        const data = await res.json().catch(() => ({}));
        throw new Error(data.error ?? `Search failed (${res.status})`);
      }

      const data: RangeSearchResponse = await res.json();
      setResponse(data);

      // Save to recents
      saveRecent({
        searchMode,
        dayOfWeek: searchMode === "recurring" ? dayOfWeek : undefined,
        date: searchMode === "one_time" ? date : undefined,
        startTime,
        endTime,
        durationMinutes,
        mode: modeFilter,
        filters: {
          subject: subjectFilter || undefined,
          curriculum: curriculumFilter || undefined,
          level: levelFilter || undefined,
        },
      });
    } catch (err) {
      setError(err instanceof Error ? err.message : "Search failed");
    } finally {
      setLoading(false);
    }
  };

  const handleSelectRecent = (search: RecentSearch) => {
    setSearchMode(search.searchMode);
    if (search.dayOfWeek !== undefined) setDayOfWeek(search.dayOfWeek);
    if (search.date) setDate(search.date);
    setStartTime(search.startTime);
    setEndTime(search.endTime);
    setDurationMinutes(search.durationMinutes);
    setModeFilter(search.mode);
    setSubjectFilter(search.filters?.subject ?? "");
    setCurriculumFilter(search.filters?.curriculum ?? "");
    setLevelFilter(search.filters?.level ?? "");

    // Auto-submit after populating
    setTimeout(() => {
      document.getElementById("search-btn")?.click();
    }, 0);
  };

  const handleToggleSelect = (id: string) => {
    setSelectedIds((prev) => {
      const next = new Set(prev);
      if (next.has(id)) {
        next.delete(id);
      } else {
        next.add(id);
      }
      return next;
    });
  };

  const isValid =
    searchMode === "recurring" || (searchMode === "one_time" && date !== "");

  return (
    <div className="mx-auto max-w-6xl p-6 space-y-6">
      <div className="flex items-center justify-between">
        <h1 className="text-2xl font-bold">Tutor Availability Search</h1>
        <div className="flex items-center gap-4">
          <a href="/compare" className="text-sm text-blue-600 hover:underline">
            Compare
          </a>
          <a href="/data-health" className="text-sm text-blue-600 hover:underline">
            Data Health
          </a>
        </div>
      </div>

      {/* Recent searches */}
      <RecentSearches onSelect={handleSelectRecent} />

      <Card>
        <CardHeader>
          <CardTitle>Search Criteria</CardTitle>
        </CardHeader>
        <CardContent className="space-y-4">
          {/* Search mode toggle */}
          <div className="flex gap-2">
            <Button
              variant={searchMode === "recurring" ? "default" : "outline"}
              onClick={() => setSearchMode("recurring")}
              size="sm"
            >
              Recurring Weekly
            </Button>
            <Button
              variant={searchMode === "one_time" ? "default" : "outline"}
              onClick={() => setSearchMode("one_time")}
              size="sm"
            >
              One-Time
            </Button>
          </div>

          {/* Range input row */}
          <div className="grid grid-cols-5 gap-2">
            <div>
              <label className="text-xs font-medium text-muted-foreground">
                {searchMode === "recurring" ? "Day" : "Date"}
              </label>
              {searchMode === "recurring" ? (
                <select
                  className="w-full rounded-md border px-2 py-1.5 text-sm"
                  value={dayOfWeek}
                  onChange={(e) => setDayOfWeek(Number(e.target.value))}
                >
                  {DAY_OPTIONS.map((d) => (
                    <option key={d.value} value={d.value}>
                      {d.label}
                    </option>
                  ))}
                </select>
              ) : (
                <input
                  type="date"
                  className="w-full rounded-md border px-2 py-1.5 text-sm"
                  value={date}
                  min={new Date().toISOString().slice(0, 10)}
                  onChange={(e) => setDate(e.target.value)}
                />
              )}
            </div>
            <div>
              <label className="text-xs font-medium text-muted-foreground">From</label>
              <select
                className="w-full rounded-md border px-2 py-1.5 text-sm"
                value={startTime}
                onChange={(e) => setStartTime(e.target.value)}
              >
                {TIME_OPTIONS.map((t) => (
                  <option key={t} value={t}>
                    {t}
                  </option>
                ))}
              </select>
            </div>
            <div>
              <label className="text-xs font-medium text-muted-foreground">To</label>
              <select
                className="w-full rounded-md border px-2 py-1.5 text-sm"
                value={endTime}
                onChange={(e) => setEndTime(e.target.value)}
              >
                {TIME_OPTIONS.map((t) => (
                  <option key={t} value={t}>
                    {t}
                  </option>
                ))}
              </select>
            </div>
            <div>
              <label className="text-xs font-medium text-muted-foreground">Class Duration</label>
              <select
                className="w-full rounded-md border px-2 py-1.5 text-sm"
                value={durationMinutes}
                onChange={(e) => setDurationMinutes(Number(e.target.value))}
              >
                {DURATION_OPTIONS.map((d) => (
                  <option key={d.value} value={d.value}>
                    {d.label}
                  </option>
                ))}
              </select>
            </div>
            <div>
              <label className="text-xs font-medium text-muted-foreground">Mode</label>
              <select
                className="w-full rounded-md border px-2 py-1.5 text-sm"
                value={modeFilter}
                onChange={(e) =>
                  setModeFilter(e.target.value as "online" | "onsite" | "either")
                }
              >
                <option value="either">Either</option>
                <option value="online">Online</option>
                <option value="onsite">Onsite</option>
              </select>
            </div>
          </div>

          {/* Qualification filters */}
          <div className="grid grid-cols-3 gap-2">
            <div>
              <label className="text-xs font-medium text-muted-foreground">Subject</label>
              <select
                className="w-full rounded-md border px-2 py-1.5 text-sm"
                value={subjectFilter}
                onChange={(e) => setSubjectFilter(e.target.value)}
              >
                <option value="">Any</option>
                {filterOptions?.subjects.map((s) => (
                  <option key={s} value={s}>
                    {s}
                  </option>
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
                  <option key={c} value={c}>
                    {c}
                  </option>
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
                  <option key={l} value={l}>
                    {l}
                  </option>
                ))}
              </select>
            </div>
          </div>

          {/* Search button */}
          <Button
            id="search-btn"
            onClick={handleSearch}
            disabled={loading || !isValid}
            className="w-full"
          >
            {loading ? "Searching..." : "Search"}
          </Button>

          {error && (
            <div className="rounded-md bg-red-50 p-3 text-sm text-red-700">{error}</div>
          )}
        </CardContent>
      </Card>

      {/* Results */}
      {response && (
        <Card>
          <CardHeader>
            <div className="flex items-center justify-between">
              <CardTitle>Results</CardTitle>
              <div className="flex items-center gap-3">
                <CopyButton
                  grid={response.grid}
                  subSlots={response.subSlots}
                  selectedIds={selectedIds}
                  dayOfWeek={searchMode === "recurring" ? dayOfWeek : undefined}
                  date={searchMode === "one_time" ? date : undefined}
                  filters={{
                    subject: subjectFilter || undefined,
                    curriculum: curriculumFilter || undefined,
                    level: levelFilter || undefined,
                  }}
                />
                {selectedIds.size >= 2 && selectedIds.size <= 3 && (
                  <a
                    href={`/compare?tutors=${[...selectedIds].join(",")}`}
                    className="inline-flex items-center rounded-md border px-3 py-1.5 text-sm font-medium hover:bg-muted transition-colors"
                  >
                    Compare schedules ({selectedIds.size})
                  </a>
                )}
              </div>
            </div>
            <div className="flex items-center gap-2 text-xs text-muted-foreground">
              <span>Snapshot: {response.snapshotMeta.snapshotId.slice(0, 8)}</span>
              <span>|</span>
              <span>Synced: {new Date(response.snapshotMeta.syncedAt).toLocaleString()}</span>
              <span>|</span>
              <span>{response.latencyMs}ms</span>
              {response.snapshotMeta.stale && (
                <Badge variant="destructive" className="text-xs">
                  Stale Data
                </Badge>
              )}
            </div>
            {response.warnings.length > 0 && (
              <div className="space-y-1 mt-2">
                {response.warnings.map((w, i) => (
                  <div
                    key={i}
                    className="rounded-md bg-yellow-50 p-2 text-xs text-yellow-800"
                  >
                    {w}
                  </div>
                ))}
              </div>
            )}
          </CardHeader>
          <CardContent>
            <AvailabilityGrid
              subSlots={response.subSlots}
              grid={response.grid}
              needsReview={response.needsReview}
              selectedIds={selectedIds}
              onToggleSelect={handleToggleSelect}
            />
          </CardContent>
        </Card>
      )}
    </div>
  );
}
