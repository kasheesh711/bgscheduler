"use client";

import { useState } from "react";
import { Button } from "@/components/ui/button";
import {
  RecentSearches,
  saveRecent,
  type RecentSearch,
} from "@/components/search/recent-searches";
import type { SearchMode, RangeSearchResponse } from "@/lib/search/types";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

import type { FilterOptions } from "@/lib/data/filters";
export type { FilterOptions };

export interface SearchContext {
  searchMode: SearchMode;
  dayOfWeek?: number;
  date?: string;
  filters: { subject?: string; curriculum?: string; level?: string };
}

export interface SearchFormProps {
  filterOptions: FilterOptions;
  onSearchResponse: (response: RangeSearchResponse, context: SearchContext) => void;
  onError: (error: string | null) => void;
}

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const DAY_OPTIONS = [
  { value: 0, label: "Sunday" },
  { value: 1, label: "Monday" },
  { value: 2, label: "Tuesday" },
  { value: 3, label: "Wednesday" },
  { value: 4, label: "Thursday" },
  { value: 5, label: "Friday" },
  { value: 6, label: "Saturday" },
];

export const DAY_NAMES = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];

const DURATION_OPTIONS = [
  { value: 60, label: "1 hr" },
  { value: 90, label: "1.5 hr" },
  { value: 120, label: "2 hr" },
];

function generateTimeOptions(): string[] {
  const times: string[] = [];
  for (let h = 0; h < 24; h++) {
    for (let m = 0; m < 60; m += 15) {
      times.push(
        `${String(h).padStart(2, "0")}:${String(m).padStart(2, "0")}`,
      );
    }
  }
  return times;
}

const TIME_OPTIONS = generateTimeOptions();

const selectClass =
  "w-full rounded-md border border-input bg-background px-2 py-1.5 text-sm focus:outline-none focus:ring-2 focus:ring-ring/50";

// ---------------------------------------------------------------------------
// SearchForm component
// ---------------------------------------------------------------------------

export function SearchForm({ filterOptions, onSearchResponse, onError }: SearchFormProps) {
  const [searchMode, setSearchMode] = useState<SearchMode>("recurring");
  const [dayOfWeek, setDayOfWeek] = useState(1);
  const [date, setDate] = useState("");
  const [startTime, setStartTime] = useState("09:00");
  const [endTime, setEndTime] = useState("17:00");
  const [durationMinutes, setDurationMinutes] = useState(60);
  const [modeFilter, setModeFilter] = useState<"online" | "onsite" | "either">("either");
  const [subjectFilter, setSubjectFilter] = useState("");
  const [curriculumFilter, setCurriculumFilter] = useState("");
  const [levelFilter, setLevelFilter] = useState("");
  const [loading, setLoading] = useState(false);

  const isValid =
    searchMode === "recurring" || (searchMode === "one_time" && date !== "");

  const handleSearch = async () => {
    setLoading(true);
    onError(null);

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
      onSearchResponse(data, {
        searchMode,
        dayOfWeek: searchMode === "recurring" ? dayOfWeek : undefined,
        date: searchMode === "one_time" ? date : undefined,
        filters: {
          subject: subjectFilter || undefined,
          curriculum: curriculumFilter || undefined,
          level: levelFilter || undefined,
        },
      });

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
      onError(err instanceof Error ? err.message : "Search failed");
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
    setTimeout(() => {
      document.getElementById("search-btn")?.click();
    }, 0);
  };

  return (
    <>
      <div className="flex items-center justify-between mb-2 flex-shrink-0">
        <h2 className="text-sm font-semibold text-foreground">Search</h2>
        <RecentSearches onSelect={handleSelectRecent} />
      </div>

      {/* Search form */}
      <div className="flex-shrink-0 space-y-2">
        {/* Search mode toggle */}
        <div className="flex gap-1.5">
          <Button
            variant={searchMode === "recurring" ? "default" : "outline"}
            onClick={() => setSearchMode("recurring")}
            size="sm"
            className="text-xs h-7"
          >
            Recurring
          </Button>
          <Button
            variant={searchMode === "one_time" ? "default" : "outline"}
            onClick={() => setSearchMode("one_time")}
            size="sm"
            className="text-xs h-7"
          >
            One-Time
          </Button>
        </div>

        {/* Row 1: Day/Date, From, To */}
        <div className="grid grid-cols-3 gap-2">
          <div>
            <label className="text-[10px] font-medium text-muted-foreground">
              {searchMode === "recurring" ? "Day" : "Date"}
            </label>
            {searchMode === "recurring" ? (
              <select
                className={selectClass}
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
                className={selectClass}
                value={date}
                min={new Date().toISOString().slice(0, 10)}
                onChange={(e) => setDate(e.target.value)}
              />
            )}
          </div>
          <div>
            <label className="text-[10px] font-medium text-muted-foreground">
              From
            </label>
            <select
              className={selectClass}
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
            <label className="text-[10px] font-medium text-muted-foreground">
              To
            </label>
            <select
              className={selectClass}
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
        </div>

        {/* Row 2: Duration, Mode, Search */}
        <div className="grid grid-cols-3 gap-2">
          <div>
            <label className="text-[10px] font-medium text-muted-foreground">
              Duration
            </label>
            <select
              className={selectClass}
              value={durationMinutes}
              onChange={(e) =>
                setDurationMinutes(Number(e.target.value))
              }
            >
              {DURATION_OPTIONS.map((d) => (
                <option key={d.value} value={d.value}>
                  {d.label}
                </option>
              ))}
            </select>
          </div>
          <div>
            <label className="text-[10px] font-medium text-muted-foreground">
              Mode
            </label>
            <select
              className={selectClass}
              value={modeFilter}
              onChange={(e) =>
                setModeFilter(
                  e.target.value as "online" | "onsite" | "either",
                )
              }
            >
              <option value="either">Either</option>
              <option value="online">Online</option>
              <option value="onsite">Onsite</option>
            </select>
          </div>
          <div className="flex items-end">
            <Button
              id="search-btn"
              onClick={handleSearch}
              disabled={loading || !isValid}
              className="w-full h-[34px] text-xs"
              size="sm"
            >
              {loading ? "Searching..." : "Search"}
            </Button>
          </div>
        </div>

        {/* Row 3: Qualification filters */}
        <div className="grid grid-cols-3 gap-2">
          <div>
            <label className="text-[10px] font-medium text-muted-foreground">
              Subject
            </label>
            <select
              className={selectClass}
              value={subjectFilter}
              onChange={(e) => setSubjectFilter(e.target.value)}
            >
              <option value="">Any</option>
              {filterOptions.subjects.map((s) => (
                <option key={s} value={s}>
                  {s}
                </option>
              ))}
            </select>
          </div>
          <div>
            <label className="text-[10px] font-medium text-muted-foreground">
              Curriculum
            </label>
            <select
              className={selectClass}
              value={curriculumFilter}
              onChange={(e) => setCurriculumFilter(e.target.value)}
            >
              <option value="">Any</option>
              {filterOptions.curriculums.map((c) => (
                <option key={c} value={c}>
                  {c}
                </option>
              ))}
            </select>
          </div>
          <div>
            <label className="text-[10px] font-medium text-muted-foreground">
              Level
            </label>
            <select
              className={selectClass}
              value={levelFilter}
              onChange={(e) => setLevelFilter(e.target.value)}
            >
              <option value="">Any</option>
              {filterOptions.levels.map((l) => (
                <option key={l} value={l}>
                  {l}
                </option>
              ))}
            </select>
          </div>
        </div>
      </div>
    </>
  );
}
