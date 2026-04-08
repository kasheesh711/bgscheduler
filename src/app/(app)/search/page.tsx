"use client";

import { Suspense, useState, useEffect, useCallback } from "react";
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
import { CalendarGrid } from "@/components/compare/calendar-grid";
import { WeekOverview } from "@/components/compare/week-overview";
import { DiscoveryPanel } from "@/components/compare/discovery-panel";
import type {
  SearchMode,
  RangeSearchResponse,
  CompareResponse,
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

const DURATION_OPTIONS = [
  { value: 60, label: "1 hour" },
  { value: 90, label: "1.5 hours" },
  { value: 120, label: "2 hours" },
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

// ---------------------------------------------------------------------------
// Main component
// ---------------------------------------------------------------------------

type WorkspaceTab = "search" | "compare";

function SearchPageInner() {
  const searchParams = useSearchParams();

  // --- Workspace tab ---
  const [activeTab, setActiveTab] = useState<WorkspaceTab>("search");

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
      setActiveTab("compare");
      fetchCompare(tutorIds);
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
  const fetchCompare = useCallback(async (ids: string[]) => {
    if (ids.length === 0) {
      setCompareResponse(null);
      return;
    }
    setCompareLoading(true);
    setCompareError(null);
    try {
      const res = await fetch("/api/compare", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ tutorGroupIds: ids, mode: "recurring" }),
      });
      if (!res.ok) {
        const data = await res.json().catch(() => ({}));
        throw new Error(data.error ?? `Compare failed (${res.status})`);
      }
      const data: CompareResponse = await res.json();
      setCompareResponse(data);
      setCompareTutors(
        data.tutors.map((t, i) => ({
          tutorGroupId: t.tutorGroupId,
          displayName: t.displayName,
          color: TUTOR_COLORS[i % TUTOR_COLORS.length],
        })),
      );
    } catch (err) {
      setCompareError(err instanceof Error ? err.message : "Compare failed");
    } finally {
      setCompareLoading(false);
    }
  }, []);

  const handleCompareSelected = () => {
    const ids = [...selectedIds];
    setActiveTab("compare");
    fetchCompare(ids);
  };

  const handleRemoveTutor = (id: string) => {
    const remaining = compareTutors.filter((t) => t.tutorGroupId !== id);
    setCompareTutors(remaining);
    fetchCompare(remaining.map((t) => t.tutorGroupId));
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
    fetchCompare(updated.map((t) => t.tutorGroupId));
  };

  const isValid =
    searchMode === "recurring" || (searchMode === "one_time" && date !== "");

  // ---------------------------------------------------------------------------
  // Render
  // ---------------------------------------------------------------------------

  return (
    <div className="space-y-6">
      {/* Workspace tabs */}
      <div className="flex items-center gap-1 border-b border-border">
        <button
          className={`px-4 py-2.5 text-sm font-medium transition-colors relative ${
            activeTab === "search"
              ? "text-primary"
              : "text-muted-foreground hover:text-foreground"
          }`}
          onClick={() => setActiveTab("search")}
        >
          Search
          {activeTab === "search" && (
            <span className="absolute bottom-0 left-0 right-0 h-0.5 bg-primary rounded-full" />
          )}
        </button>
        <button
          className={`px-4 py-2.5 text-sm font-medium transition-colors relative flex items-center gap-2 ${
            activeTab === "compare"
              ? "text-primary"
              : "text-muted-foreground hover:text-foreground"
          }`}
          onClick={() => setActiveTab("compare")}
        >
          Compare
          {compareTutors.length > 0 && (
            <span className="inline-flex items-center justify-center h-5 min-w-5 px-1.5 rounded-full bg-primary/15 text-primary text-xs font-medium">
              {compareTutors.length}
            </span>
          )}
          {activeTab === "compare" && (
            <span className="absolute bottom-0 left-0 right-0 h-0.5 bg-primary rounded-full" />
          )}
        </button>
      </div>

      {/* ================================================================= */}
      {/* SEARCH TAB                                                         */}
      {/* ================================================================= */}
      {activeTab === "search" && (
        <>
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
              <div className="grid grid-cols-5 gap-3 max-w-5xl">
                <div>
                  <label className="text-xs font-medium text-muted-foreground">
                    {searchMode === "recurring" ? "Day" : "Date"}
                  </label>
                  {searchMode === "recurring" ? (
                    <select
                      className="w-full rounded-md border border-input bg-background px-2.5 py-1.5 text-sm focus:outline-none focus:ring-2 focus:ring-ring/50"
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
                      className="w-full rounded-md border border-input bg-background px-2.5 py-1.5 text-sm focus:outline-none focus:ring-2 focus:ring-ring/50"
                      value={date}
                      min={new Date().toISOString().slice(0, 10)}
                      onChange={(e) => setDate(e.target.value)}
                    />
                  )}
                </div>
                <div>
                  <label className="text-xs font-medium text-muted-foreground">
                    From
                  </label>
                  <select
                    className="w-full rounded-md border border-input bg-background px-2.5 py-1.5 text-sm focus:outline-none focus:ring-2 focus:ring-ring/50"
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
                  <label className="text-xs font-medium text-muted-foreground">
                    To
                  </label>
                  <select
                    className="w-full rounded-md border border-input bg-background px-2.5 py-1.5 text-sm focus:outline-none focus:ring-2 focus:ring-ring/50"
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
                  <label className="text-xs font-medium text-muted-foreground">
                    Class Duration
                  </label>
                  <select
                    className="w-full rounded-md border border-input bg-background px-2.5 py-1.5 text-sm focus:outline-none focus:ring-2 focus:ring-ring/50"
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
                  <label className="text-xs font-medium text-muted-foreground">
                    Mode
                  </label>
                  <select
                    className="w-full rounded-md border border-input bg-background px-2.5 py-1.5 text-sm focus:outline-none focus:ring-2 focus:ring-ring/50"
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
              </div>

              {/* Qualification filters */}
              <div className="grid grid-cols-3 gap-3 max-w-5xl">
                <div>
                  <label className="text-xs font-medium text-muted-foreground">
                    Subject
                  </label>
                  <select
                    className="w-full rounded-md border border-input bg-background px-2.5 py-1.5 text-sm focus:outline-none focus:ring-2 focus:ring-ring/50"
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
                  <label className="text-xs font-medium text-muted-foreground">
                    Curriculum
                  </label>
                  <select
                    className="w-full rounded-md border border-input bg-background px-2.5 py-1.5 text-sm focus:outline-none focus:ring-2 focus:ring-ring/50"
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
                  <label className="text-xs font-medium text-muted-foreground">
                    Level
                  </label>
                  <select
                    className="w-full rounded-md border border-input bg-background px-2.5 py-1.5 text-sm focus:outline-none focus:ring-2 focus:ring-ring/50"
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

              <div className="max-w-5xl">
                <Button
                  id="search-btn"
                  onClick={handleSearch}
                  disabled={loading || !isValid}
                  className="w-full"
                >
                  {loading ? "Searching..." : "Search"}
                </Button>
              </div>

              {error && (
                <div className="rounded-md bg-destructive/10 p-3 text-sm text-destructive">
                  {error}
                </div>
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
                        onClick={handleCompareSelected}
                      >
                        Compare selected ({selectedIds.size})
                      </Button>
                    )}
                  </div>
                </div>
                <div className="flex items-center gap-2 text-xs text-muted-foreground">
                  <span>
                    Snapshot:{" "}
                    {response.snapshotMeta.snapshotId.slice(0, 8)}
                  </span>
                  <span>|</span>
                  <span>
                    Synced:{" "}
                    {new Date(
                      response.snapshotMeta.syncedAt,
                    ).toLocaleString()}
                  </span>
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
                        className="rounded-md bg-accent/60 p-2 text-xs text-accent-foreground"
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
        </>
      )}

      {/* ================================================================= */}
      {/* COMPARE TAB                                                        */}
      {/* ================================================================= */}
      {activeTab === "compare" && (
        <>
          <Card>
            <CardContent className="pt-6">
              <TutorSelector
                tutors={compareTutors}
                onRemove={handleRemoveTutor}
                onOpenDiscovery={() => setDiscoveryOpen(true)}
              />
            </CardContent>
          </Card>

          {compareError && (
            <div className="rounded-md bg-destructive/10 p-3 text-sm text-destructive">
              {compareError}
            </div>
          )}

          {compareLoading && (
            <div className="text-center text-sm text-muted-foreground py-8">
              Loading schedules...
            </div>
          )}

          {compareResponse && !compareLoading && (
            <>
              <div className="flex items-center gap-2 text-xs text-muted-foreground">
                <span>
                  Snapshot:{" "}
                  {compareResponse.snapshotMeta.snapshotId.slice(0, 8)}
                </span>
                <span>|</span>
                <span>
                  Synced:{" "}
                  {new Date(
                    compareResponse.snapshotMeta.syncedAt,
                  ).toLocaleString()}
                </span>
                <span>|</span>
                <span>{compareResponse.latencyMs}ms</span>
                {compareResponse.snapshotMeta.stale && (
                  <Badge variant="destructive" className="text-xs">
                    Stale Data
                  </Badge>
                )}
              </div>

              {/* Day tabs */}
              <div className="flex border-b border-border">
                <button
                  className={`px-4 py-2 text-sm font-medium transition-colors relative ${
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
                    className={`px-4 py-2 text-sm font-medium transition-colors relative ${
                      activeDay === day
                        ? "text-primary"
                        : "text-muted-foreground hover:text-foreground"
                    }`}
                    onClick={() => setActiveDay(day)}
                  >
                    {DAY_NAMES[day]}
                    {activeDay === day && (
                      <span className="absolute bottom-0 left-0 right-0 h-0.5 bg-primary rounded-full" />
                    )}
                  </button>
                ))}
              </div>

              <Card>
                <CardContent className="pt-6">
                  {activeDay !== null && compareResponse ? (
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
                  ) : compareResponse ? (
                    <WeekOverview
                      tutors={compareResponse.tutors}
                      tutorChips={compareTutors}
                      conflicts={compareResponse.conflicts}
                      onDayClick={(day) => setActiveDay(day)}
                    />
                  ) : null}
                </CardContent>
              </Card>

              {compareResponse.conflicts.length > 0 && (
                <div className="rounded-md border border-conflict/30 bg-conflict/10 p-3 text-sm">
                  <span className="font-semibold text-conflict">
                    {compareResponse.conflicts.length} conflict
                    {compareResponse.conflicts.length > 1 ? "s" : ""} detected
                  </span>
                  <ul className="mt-1 space-y-1 text-conflict/80 text-xs">
                    {compareResponse.conflicts.map((c, i) => (
                      <li key={i}>
                        {c.studentName} — {DAY_NAMES[c.dayOfWeek]}{" "}
                        {formatMinute(c.startMinute)}–
                        {formatMinute(c.endMinute)} —{" "}
                        {c.tutorA.displayName} vs {c.tutorB.displayName}
                      </li>
                    ))}
                  </ul>
                </div>
              )}
            </>
          )}

          {compareTutors.length === 0 && !compareLoading && (
            <div className="text-center py-16 text-muted-foreground">
              <p className="text-lg font-medium">No tutors selected</p>
              <p className="text-sm mt-1">
                Select 2-3 tutors from the Search tab, or use the{" "}
                <button
                  className="text-primary hover:underline"
                  onClick={() => setDiscoveryOpen(true)}
                >
                  discovery panel
                </button>{" "}
                to find tutors.
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
        </>
      )}
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
