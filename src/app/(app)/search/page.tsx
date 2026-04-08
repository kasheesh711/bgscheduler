"use client";

import { Suspense, useState, useEffect, useCallback, useRef } from "react";
import { useSearchParams } from "next/navigation";
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
import { TutorSelector, TUTOR_COLORS } from "@/components/compare/tutor-selector";
import type { TutorChip } from "@/components/compare/tutor-selector";
import { TutorCombobox } from "@/components/compare/tutor-combobox";
import { CalendarGrid } from "@/components/compare/calendar-grid";
import { WeekOverview } from "@/components/compare/week-overview";
import { DiscoveryPanel } from "@/components/compare/discovery-panel";
import type {
  SearchMode,
  RangeSearchResponse,
  CompareResponse,
  CompareTutor,
  Conflict,
} from "@/lib/search/types";

export default function SearchPage() {
  return (
    <Suspense
      fallback={
        <div className="py-8 text-center text-muted-foreground">Loading...</div>
      }
    >
      <SearchPageInner />
    </Suspense>
  );
}

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

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

const DAY_NAMES = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];

function getCurrentMonday(): string {
  const now = new Date();
  // Use Asia/Bangkok local date
  const bkk = new Date(now.toLocaleString("en-US", { timeZone: "Asia/Bangkok" }));
  const day = bkk.getDay(); // 0=Sun
  const diff = day === 0 ? -6 : 1 - day;
  const monday = new Date(bkk.getFullYear(), bkk.getMonth(), bkk.getDate() + diff);
  return formatIsoDate(monday);
}

function shiftWeek(current: string, delta: number): string {
  const [y, m, d] = current.split("-").map(Number);
  const date = new Date(y, m - 1, d + delta * 7);
  return formatIsoDate(date);
}

function formatIsoDate(d: Date): string {
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, "0");
  const day = String(d.getDate()).padStart(2, "0");
  return `${y}-${m}-${day}`;
}

function formatWeekLabel(weekStart: string): string {
  const [y, m, d] = weekStart.split("-").map(Number);
  const start = new Date(y, m - 1, d);
  const end = new Date(y, m - 1, d + 6);
  const months = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
  const s = `${start.getDate()} ${months[start.getMonth()]}`;
  const e = `${end.getDate()} ${months[end.getMonth()]}, ${end.getFullYear()}`;
  return `${s} – ${e}`;
}

function getWeekDate(weekStart: string, dayOfWeek: number): string {
  const [y, m, d] = weekStart.split("-").map(Number);
  // weekStart is Monday (day 1). Offset: Mon=0, Tue=1, ..., Sat=5, Sun=6
  const offset = dayOfWeek === 0 ? 6 : dayOfWeek - 1;
  const date = new Date(y, m - 1, d + offset);
  return `${date.getDate()}/${date.getMonth() + 1}`;
}

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
// Main component
// ---------------------------------------------------------------------------

function SearchPageInner() {
  const searchParams = useSearchParams();

  // --- Search state ---
  const [searchMode, setSearchMode] = useState<SearchMode>("recurring");
  const [dayOfWeek, setDayOfWeek] = useState(1);
  const [date, setDate] = useState("");
  const [startTime, setStartTime] = useState("09:00");
  const [endTime, setEndTime] = useState("17:00");
  const [durationMinutes, setDurationMinutes] = useState(60);
  const [modeFilter, setModeFilter] = useState<"online" | "onsite" | "either">(
    "either",
  );
  const [subjectFilter, setSubjectFilter] = useState("");
  const [curriculumFilter, setCurriculumFilter] = useState("");
  const [levelFilter, setLevelFilter] = useState("");
  const [filterOptions, setFilterOptions] = useState<FilterOptions | null>(
    null,
  );
  const [response, setResponse] = useState<RangeSearchResponse | null>(null);
  const [selectedIds, setSelectedIds] = useState<Set<string>>(new Set());
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // --- Compare state ---
  const [compareTutors, setCompareTutors] = useState<TutorChip[]>([]);
  const [compareResponse, setCompareResponse] =
    useState<CompareResponse | null>(null);
  const [compareLoading, setCompareLoading] = useState(false);
  const [compareError, setCompareError] = useState<string | null>(null);
  const [activeDay, setActiveDay] = useState<number | null>(null);
  const [discoveryOpen, setDiscoveryOpen] = useState(false);
  const [prefillConflict, setPrefillConflict] = useState<Conflict | null>(null);
  const [weekStart, setWeekStart] = useState<string>(getCurrentMonday);

  // Client-side cache: avoids refetching tutor schedules already loaded for the same week
  const tutorCache = useRef(new Map<string, CompareTutor>());
  const lastSnapshotId = useRef<string | null>(null);
  const abortRef = useRef<AbortController | null>(null);

  // --- Init ---
  useEffect(() => {
    fetch("/api/filters")
      .then((res) => (res.ok ? res.json() : null))
      .then((data) => {
        if (data) setFilterOptions(data);
      })
      .catch(() => {});
  }, []);

  // Handle ?tutors= deep link
  useEffect(() => {
    const tutorIds =
      searchParams.get("tutors")?.split(",").filter(Boolean) ?? [];
    if (tutorIds.length > 0) {
      fetchCompare(tutorIds, weekStart);
    }
  }, []); // eslint-disable-line react-hooks/exhaustive-deps

  // --- Search handlers ---
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
    setTimeout(() => {
      document.getElementById("search-btn")?.click();
    }, 0);
  };

  const handleToggleSelect = (id: string) => {
    setSelectedIds((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  };

  // --- Compare handlers ---
  const fetchCompare = useCallback(async (
    ids: string[],
    week: string,
    opts?: { fetchOnly?: string[] },
  ) => {
    if (ids.length === 0) {
      setCompareResponse(null);
      return;
    }

    // Abort any in-flight request
    abortRef.current?.abort();
    const controller = new AbortController();
    abortRef.current = controller;

    setCompareLoading(true);
    setCompareError(null);
    try {
      const res = await fetch("/api/compare", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          tutorGroupIds: ids,
          mode: "recurring",
          weekStart: week,
          fetchOnly: opts?.fetchOnly,
        }),
        signal: controller.signal,
      });
      if (!res.ok) {
        const data = await res.json().catch(() => ({}));
        throw new Error(data.error ?? `Compare failed (${res.status})`);
      }
      const data: CompareResponse = await res.json();

      // If server snapshot changed, our cache is stale — refetch everything
      if (lastSnapshotId.current && lastSnapshotId.current !== data.snapshotMeta.snapshotId) {
        tutorCache.current.clear();
        // Recursive full refetch (no fetchOnly)
        setCompareLoading(false);
        return fetchCompare(ids, week);
      }
      lastSnapshotId.current = data.snapshotMeta.snapshotId;

      // Merge returned tutors into cache
      for (const t of data.tutors) {
        tutorCache.current.set(`${t.tutorGroupId}:${week}`, t);
      }

      // Build full tutor list from cache
      const mergedTutors = ids
        .map((id) => tutorCache.current.get(`${id}:${week}`))
        .filter((t): t is CompareTutor => t !== undefined);

      setCompareResponse({
        ...data,
        tutors: mergedTutors,
      });
      setCompareTutors(
        mergedTutors.map((t, i) => ({
          tutorGroupId: t.tutorGroupId,
          displayName: t.displayName,
          color: TUTOR_COLORS[i % TUTOR_COLORS.length],
        })),
      );
    } catch (err) {
      if (err instanceof DOMException && err.name === "AbortError") return;
      setCompareError(err instanceof Error ? err.message : "Compare failed");
    } finally {
      setCompareLoading(false);
    }
  }, []);

  const handleCompareSelected = () => {
    const ids = [...selectedIds];
    tutorCache.current.clear();
    fetchCompare(ids, weekStart);
  };

  const handleRemoveTutor = (id: string) => {
    const remaining = compareTutors.filter((t) => t.tutorGroupId !== id);
    setCompareTutors(remaining);
    tutorCache.current.delete(`${id}:${weekStart}`);
    if (remaining.length === 0) {
      setCompareResponse(null);
      return;
    }
    // Fetch zero tutors — only recompute conflicts/free-slots on server
    fetchCompare(remaining.map((t) => t.tutorGroupId), weekStart, { fetchOnly: [] });
  };

  const handleAddTutor = (id: string, name: string) => {
    if (compareTutors.length >= 3) return;
    const updated = [
      ...compareTutors,
      {
        tutorGroupId: id,
        displayName: name,
        color: TUTOR_COLORS[compareTutors.length],
      },
    ];
    setCompareTutors(updated);
    setDiscoveryOpen(false);
    // Only fetch the newly added tutor
    fetchCompare(updated.map((t) => t.tutorGroupId), weekStart, { fetchOnly: [id] });
  };

  const handleWeekChange = (newWeek: string) => {
    setWeekStart(newWeek);
    tutorCache.current.clear();
    if (compareTutors.length > 0) {
      fetchCompare(compareTutors.map((t) => t.tutorGroupId), newWeek);
    }
  };

  const isValid =
    searchMode === "recurring" || (searchMode === "one_time" && date !== "");

  // ---------------------------------------------------------------------------
  // Render — side-by-side layout
  // ---------------------------------------------------------------------------

  return (
    <div className="flex-1 flex gap-3 overflow-hidden min-h-0">
      {/* ================================================================= */}
      {/* LEFT PANEL — Search                                                */}
      {/* ================================================================= */}
      <div className="w-1/2 flex flex-col overflow-hidden min-w-0 border-r border-border/50 pr-3">
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
                {filterOptions?.subjects.map((s) => (
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
                {filterOptions?.curriculums.map((c) => (
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
                {filterOptions?.levels.map((l) => (
                  <option key={l} value={l}>
                    {l}
                  </option>
                ))}
              </select>
            </div>
          </div>
        </div>

        {error && (
          <div className="rounded-md bg-destructive/10 p-2 text-xs text-destructive mt-2 flex-shrink-0">
            {error}
          </div>
        )}

        {/* Results */}
        {response && (
          <div className="flex-1 overflow-y-auto mt-2 min-h-0">
            <div className="flex items-center justify-between mb-1 sticky top-0 bg-background z-10 pb-1">
              <div className="flex items-center gap-2 text-[10px] text-muted-foreground">
                <span>
                  {response.snapshotMeta.snapshotId.slice(0, 8)}
                </span>
                <span>·</span>
                <span>{response.latencyMs}ms</span>
                {response.snapshotMeta.stale && (
                  <Badge variant="destructive" className="text-[10px]">
                    Stale
                  </Badge>
                )}
              </div>
              <div className="flex items-center gap-2">
                <CopyButton
                  grid={response.grid}
                  subSlots={response.subSlots}
                  selectedIds={selectedIds}
                  dayOfWeek={
                    searchMode === "recurring" ? dayOfWeek : undefined
                  }
                  date={searchMode === "one_time" ? date : undefined}
                  filters={{
                    subject: subjectFilter || undefined,
                    curriculum: curriculumFilter || undefined,
                    level: levelFilter || undefined,
                  }}
                />
                {selectedIds.size >= 2 && selectedIds.size <= 3 && (
                  <Button
                    variant="outline"
                    size="sm"
                    className="text-xs h-7"
                    onClick={handleCompareSelected}
                  >
                    Compare ({selectedIds.size})
                  </Button>
                )}
              </div>
            </div>
            {response.warnings.length > 0 && (
              <div className="space-y-1 mb-2">
                {response.warnings.map((w, i) => (
                  <div
                    key={i}
                    className="rounded-md bg-accent/60 p-1.5 text-[10px] text-accent-foreground"
                  >
                    {w}
                  </div>
                ))}
              </div>
            )}
            <AvailabilityGrid
              subSlots={response.subSlots}
              grid={response.grid}
              needsReview={response.needsReview}
              selectedIds={selectedIds}
              onToggleSelect={handleToggleSelect}
            />
          </div>
        )}

        {!response && !loading && (
          <div className="flex-1 flex items-center justify-center text-sm text-muted-foreground">
            Search for available tutors
          </div>
        )}
      </div>

      {/* ================================================================= */}
      {/* RIGHT PANEL — Compare                                              */}
      {/* ================================================================= */}
      <div className="w-1/2 flex flex-col overflow-hidden min-w-0 pl-1">
        {/* Tutor selector */}
        <div className="flex items-center gap-2 flex-wrap mb-2 flex-shrink-0">
          {compareTutors.map((t) => (
            <div
              key={t.tutorGroupId}
              className="flex items-center gap-1.5 rounded-md border px-2 py-1 text-xs"
              style={{ borderColor: t.color }}
            >
              <div className="h-2 w-2 rounded-full" style={{ background: t.color }} />
              <span className="font-medium">{t.displayName}</span>
              <button
                onClick={() => handleRemoveTutor(t.tutorGroupId)}
                className="text-muted-foreground hover:text-foreground text-[10px] ml-0.5"
              >
                x
              </button>
            </div>
          ))}
          {compareTutors.length < 3 && (
            <TutorCombobox
              existingTutorGroupIds={compareTutors.map((t) => t.tutorGroupId)}
              onAdd={handleAddTutor}
            />
          )}
          <button
            onClick={() => setDiscoveryOpen(true)}
            className="text-[10px] text-muted-foreground hover:text-foreground"
          >
            Advanced search
          </button>
          <span className="text-[10px] text-muted-foreground ml-auto">
            {compareTutors.length}/3
          </span>
        </div>

        {compareError && (
          <div className="rounded-md bg-destructive/10 p-2 text-xs text-destructive mb-2 flex-shrink-0">
            {compareError}
          </div>
        )}

        {compareLoading && (
          <div className="flex-1 flex items-center justify-center text-sm text-muted-foreground">
            Loading schedules...
          </div>
        )}

        {compareResponse && !compareLoading && (
          <>
            {/* Week picker + snapshot meta */}
            <div className="flex items-center gap-2 mb-1 flex-shrink-0">
              <div className="flex items-center gap-1">
                <button
                  onClick={() => handleWeekChange(shiftWeek(weekStart, -1))}
                  className="px-1.5 py-0.5 text-xs rounded hover:bg-muted transition-colors text-muted-foreground hover:text-foreground"
                >
                  &lt;
                </button>
                <span className="text-xs font-medium min-w-[140px] text-center">
                  {formatWeekLabel(weekStart)}
                </span>
                <button
                  onClick={() => handleWeekChange(shiftWeek(weekStart, 1))}
                  className="px-1.5 py-0.5 text-xs rounded hover:bg-muted transition-colors text-muted-foreground hover:text-foreground"
                >
                  &gt;
                </button>
                {weekStart !== getCurrentMonday() && (
                  <button
                    onClick={() => handleWeekChange(getCurrentMonday())}
                    className="px-1.5 py-0.5 text-[10px] rounded border border-border hover:bg-muted transition-colors text-muted-foreground hover:text-foreground ml-1"
                  >
                    Today
                  </button>
                )}
              </div>
              <div className="flex items-center gap-2 text-[10px] text-muted-foreground ml-auto">
                <span>{compareResponse.snapshotMeta.snapshotId.slice(0, 8)}</span>
                <span>·</span>
                <span>{compareResponse.latencyMs}ms</span>
                {compareResponse.snapshotMeta.stale && (
                  <Badge variant="destructive" className="text-[10px]">Stale</Badge>
                )}
              </div>
            </div>

            {/* Day tabs */}
            <div className="flex border-b border-border flex-shrink-0">
              <button
                className={`px-3 py-1.5 text-xs font-medium transition-colors relative ${
                  activeDay === null
                    ? "text-primary"
                    : "text-muted-foreground hover:text-foreground"
                }`}
                onClick={() => setActiveDay(null)}
              >
                Week
                {activeDay === null && (
                  <span className="absolute bottom-0 left-0 right-0 h-0.5 bg-primary rounded-full" />
                )}
              </button>
              {[1, 2, 3, 4, 5, 6, 0].map((day) => (
                <button
                  key={day}
                  className={`px-3 py-1.5 text-xs font-medium transition-colors relative ${
                    activeDay === day
                      ? "text-primary"
                      : "text-muted-foreground hover:text-foreground"
                  }`}
                  onClick={() => setActiveDay(day)}
                >
                  {DAY_NAMES[day]} {getWeekDate(weekStart, day)}
                  {activeDay === day && (
                    <span className="absolute bottom-0 left-0 right-0 h-0.5 bg-primary rounded-full" />
                  )}
                </button>
              ))}
            </div>

            {/* Calendar view */}
            <div className={`flex-1 min-h-0 mt-1 ${activeDay !== null ? "overflow-y-auto" : ""}`}>
              {activeDay !== null ? (
                <CalendarGrid
                  tutors={compareResponse.tutors}
                  tutorChips={compareTutors}
                  conflicts={compareResponse.conflicts}
                  sharedFreeSlots={compareResponse.sharedFreeSlots}
                  dayOfWeek={activeDay}
                  onFindAlternatives={(conflict) => {
                    setPrefillConflict(conflict);
                    setDiscoveryOpen(true);
                  }}
                />
              ) : (
                <WeekOverview
                  tutors={compareResponse.tutors}
                  tutorChips={compareTutors}
                  conflicts={compareResponse.conflicts}
                  sharedFreeSlots={compareResponse.sharedFreeSlots}
                  onDayClick={(day) => setActiveDay(day)}
                />
              )}
            </div>

            {/* Conflicts summary */}
            {compareResponse.conflicts.length > 0 && (
              <div className="rounded-md border border-conflict/30 bg-conflict/10 p-2 text-xs mt-2 flex-shrink-0">
                <span className="font-semibold text-conflict">
                  {compareResponse.conflicts.length} conflict{compareResponse.conflicts.length > 1 ? "s" : ""}
                </span>
                <ul className="mt-0.5 space-y-0.5 text-conflict/80 text-[10px]">
                  {compareResponse.conflicts.slice(0, 5).map((c, i) => (
                    <li key={i}>
                      {c.studentName} — {DAY_NAMES[c.dayOfWeek]}{" "}
                      {formatMinute(c.startMinute)}–{formatMinute(c.endMinute)} —{" "}
                      {c.tutorA.displayName} vs {c.tutorB.displayName}
                    </li>
                  ))}
                  {compareResponse.conflicts.length > 5 && (
                    <li>+{compareResponse.conflicts.length - 5} more</li>
                  )}
                </ul>
              </div>
            )}
          </>
        )}

        {compareTutors.length === 0 && !compareLoading && (
          <div className="flex-1 flex flex-col items-center justify-center text-muted-foreground">
            <p className="text-sm font-medium">Compare tutors</p>
            <p className="text-xs mt-1">
              Use the dropdown above or select 2-3 tutors from search results.
            </p>
          </div>
        )}

        <DiscoveryPanel
          open={discoveryOpen}
          onClose={() => {
            setDiscoveryOpen(false);
            setPrefillConflict(null);
          }}
          existingTutorGroupIds={compareTutors.map((t) => t.tutorGroupId)}
          onAdd={handleAddTutor}
          prefillConflict={prefillConflict}
        />
      </div>
    </div>
  );
}

function formatMinute(minute: number): string {
  const h = Math.floor(minute / 60);
  const m = minute % 60;
  const suffix = h >= 12 ? "pm" : "am";
  const h12 = h === 0 ? 12 : h > 12 ? h - 12 : h;
  return m === 0
    ? `${h12}${suffix}`
    : `${h12}:${String(m).padStart(2, "0")}${suffix}`;
}
