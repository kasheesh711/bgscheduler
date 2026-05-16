"use client";

import { useEffect, useState } from "react";
import { Button } from "@/components/ui/button";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import { Command, CommandEmpty, CommandGroup, CommandInput, CommandItem, CommandList } from "@/components/ui/command";
import { Badge } from "@/components/ui/badge";
import { X, Search, Check, Sparkles, AlertCircle } from "lucide-react";
import {
  RecentSearches,
  saveRecent,
  type RecentSearch,
} from "@/components/search/recent-searches";
import type { SearchMode, RangeSearchResponse } from "@/lib/search/types";
import type { TutorListItem } from "@/lib/data/tutors";
import type { NaturalLanguageSearchResponse } from "@/lib/search/natural-language";

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
  tutorList: TutorListItem[];
  naturalLanguageEnabled: boolean;
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

function summarizeNaturalLanguageResult(data: Extract<NaturalLanguageSearchResponse, { status: "parsed" }>): string {
  const parsed = data.parsed;
  const dayLabel = parsed.searchMode === "recurring"
    ? parsed.dayOfWeek !== undefined
      ? DAY_NAMES[parsed.dayOfWeek]
      : "Recurring"
    : parsed.date ?? "One-time";
  const filters = [parsed.filters.subject, parsed.filters.curriculum, parsed.filters.level]
    .filter(Boolean)
    .join(" / ");
  const tutors = data.parsed.matchedTutors.map((tutor) => tutor.displayName).join(", ");
  return [
    `${dayLabel} ${parsed.startTime}-${parsed.endTime}`,
    `${parsed.durationMinutes} min`,
    parsed.mode,
    filters || "Any qualification",
    tutors ? `Tutors: ${tutors}` : null,
  ].filter(Boolean).join(" · ");
}

// ---------------------------------------------------------------------------
// SearchForm component
// ---------------------------------------------------------------------------

export function SearchForm({
  filterOptions,
  tutorList,
  naturalLanguageEnabled,
  onSearchResponse,
  onError,
}: SearchFormProps) {
  const [searchMode, setSearchMode] = useState<SearchMode>("recurring");
  const [dayOfWeek, setDayOfWeek] = useState(1);
  const [date, setDate] = useState("");
  // Defaults reflect the tutor working window (3–8pm) so staff don't have to
  // know it — they hit Search and get sensible results immediately.
  const [startTime, setStartTime] = useState("15:00");
  const [endTime, setEndTime] = useState("20:00");
  const [durationMinutes, setDurationMinutes] = useState(90);
  const [modeFilter, setModeFilter] = useState<"online" | "onsite" | "either">("either");
  const [subjectFilter, setSubjectFilter] = useState("");
  const [curriculumFilter, setCurriculumFilter] = useState("");
  const [levelFilter, setLevelFilter] = useState("");
  const [loading, setLoading] = useState(false);
  const [selectedTutorIds, setSelectedTutorIds] = useState<string[]>([]);
  const [tutorPopoverOpen, setTutorPopoverOpen] = useState(false);
  const [pendingSearch, setPendingSearch] = useState(false);
  const [naturalInput, setNaturalInput] = useState("");
  const [naturalLoading, setNaturalLoading] = useState(false);
  const [naturalError, setNaturalError] = useState<string | null>(null);
  const [naturalParsedSummary, setNaturalParsedSummary] = useState<string | null>(null);
  const [naturalWarnings, setNaturalWarnings] = useState<string[]>([]);
  const [naturalClarifications, setNaturalClarifications] = useState<string[]>([]);

  const handleAddTutor = (id: string) => {
    setSelectedTutorIds((prev) => prev.includes(id) ? prev : [...prev, id]);
  };

  const handleRemoveTutor = (id: string) => {
    setSelectedTutorIds((prev) => prev.filter((x) => x !== id));
  };

  const isValid =
    searchMode === "recurring" || (searchMode === "one_time" && date !== "");

  const activeFilterCount =
    (subjectFilter ? 1 : 0) +
    (curriculumFilter ? 1 : 0) +
    (levelFilter ? 1 : 0) +
    (modeFilter !== "either" ? 1 : 0) +
    selectedTutorIds.length;

  const handleNaturalLanguageParse = async () => {
    const input = naturalInput.trim();
    if (!naturalLanguageEnabled || !input || naturalLoading) return;

    setNaturalLoading(true);
    setNaturalError(null);
    setNaturalParsedSummary(null);
    setNaturalWarnings([]);
    setNaturalClarifications([]);

    try {
      const res = await fetch("/api/search/natural-language", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ input }),
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) {
        throw new Error(data.error ?? `Natural language parse failed (${res.status})`);
      }

      const parsed = data as NaturalLanguageSearchResponse;
      setNaturalWarnings(parsed.warnings ?? []);

      if (parsed.status === "needs_clarification") {
        setNaturalClarifications(parsed.clarifyingQuestions);
        return;
      }

      setSearchMode(parsed.parsed.searchMode);
      if (parsed.parsed.dayOfWeek !== undefined) setDayOfWeek(parsed.parsed.dayOfWeek);
      setDate(parsed.parsed.date ?? "");
      setStartTime(parsed.parsed.startTime);
      setEndTime(parsed.parsed.endTime);
      setDurationMinutes(parsed.parsed.durationMinutes);
      setModeFilter(parsed.parsed.mode);
      setSubjectFilter(parsed.parsed.filters.subject ?? "");
      setCurriculumFilter(parsed.parsed.filters.curriculum ?? "");
      setLevelFilter(parsed.parsed.filters.level ?? "");
      setSelectedTutorIds(parsed.parsed.tutorGroupIds);
      setNaturalParsedSummary(summarizeNaturalLanguageResult(parsed));
    } catch (err) {
      setNaturalError(err instanceof Error ? err.message : "Natural language parse failed");
    } finally {
      setNaturalLoading(false);
    }
  };

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
      tutorGroupIds: selectedTutorIds.length > 0 ? selectedTutorIds : undefined,
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
    // Defer the search until after React commits the state updates above.
    setPendingSearch(true);
  };

  // Trigger a search once state from a recent-search restore has been applied.
  useEffect(() => {
    if (!pendingSearch) return;
    setPendingSearch(false);
    handleSearch();
    // We intentionally only run when pendingSearch flips true; handleSearch
    // reads the latest state via closure on each render.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [pendingSearch]);

  return (
    <>
      <div className="flex items-center justify-between mb-2 flex-shrink-0">
        <h2 className="text-sm font-semibold text-foreground">Search</h2>
        <RecentSearches onSelect={handleSelectRecent} />
      </div>

      {/* Search form */}
      <div className="flex-shrink-0 space-y-2">
        {/* Natural language intake */}
        <div className="rounded-md border border-border bg-card/80 p-2.5">
          <div className="mb-1.5 flex items-center gap-1.5 text-[10px] font-semibold uppercase tracking-wider text-muted-foreground">
            <Sparkles className="h-3 w-3 text-primary" aria-hidden />
            Natural language intake
          </div>
          <div className="flex gap-2">
            <textarea
              value={naturalInput}
              onChange={(e) => setNaturalInput(e.target.value)}
              rows={2}
              maxLength={1000}
              placeholder="e.g. Parent wants Year 5 English online next Tuesday after 5pm for 90 minutes with Kevin"
              disabled={!naturalLanguageEnabled}
              className="min-h-[54px] flex-1 resize-none rounded-md border border-input bg-background px-2 py-1.5 text-xs leading-relaxed outline-none focus:ring-2 focus:ring-ring/50 disabled:cursor-not-allowed disabled:opacity-60"
              aria-label="Natural language search request"
            />
            <Button
              type="button"
              size="sm"
              variant="outline"
              onClick={handleNaturalLanguageParse}
              disabled={!naturalLanguageEnabled || naturalLoading || naturalInput.trim().length === 0}
              className="h-[54px] w-[88px] shrink-0 gap-1 text-xs"
            >
              {naturalLoading ? "Parsing..." : "Parse"}
            </Button>
          </div>

          {!naturalLanguageEnabled && (
            <div className="mt-2 rounded-md border border-border bg-muted/40 px-2 py-1.5 text-[11px] text-muted-foreground">
              AI intake is not configured. Manual search still works.
            </div>
          )}

          {naturalParsedSummary && (
            <div className="mt-2 rounded-md border border-primary/25 bg-primary/5 px-2 py-1.5 text-[11px] text-foreground">
              <span className="font-medium">Filled form:</span> {naturalParsedSummary}. Review below, then click Search.
            </div>
          )}

          {naturalClarifications.length > 0 && (
            <div className="mt-2 rounded-md border border-amber-300/40 bg-amber-50 px-2 py-1.5 text-[11px] text-amber-900 dark:bg-amber-950/20 dark:text-amber-200">
              <div className="mb-1 flex items-center gap-1 font-medium">
                <AlertCircle className="h-3 w-3" aria-hidden />
                Needs clarification
              </div>
              <ul className="space-y-0.5">
                {naturalClarifications.map((question, index) => (
                  <li key={index}>{question}</li>
                ))}
              </ul>
            </div>
          )}

          {naturalWarnings.length > 0 && (
            <div className="mt-1.5 space-y-0.5 text-[10.5px] text-muted-foreground">
              {naturalWarnings.map((warning, index) => (
                <div key={index}>{warning}</div>
              ))}
            </div>
          )}

          {naturalError && (
            <div className="mt-2 rounded-md bg-destructive/10 px-2 py-1.5 text-[11px] text-destructive">
              {naturalError}. Manual search still works.
            </div>
          )}
        </div>

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

        {/* Tutor name filter */}
        <div>
          <div className="flex items-center justify-between">
            <label className="text-xs font-medium text-muted-foreground">
              Tutor (optional)
            </label>
            {selectedTutorIds.length > 0 && (
              <button
                type="button"
                onClick={() => setSelectedTutorIds([])}
                className="text-xs text-muted-foreground hover:text-destructive"
              >
                Clear all
              </button>
            )}
          </div>
          {selectedTutorIds.length > 0 && (
            <div className="flex flex-wrap items-center gap-1 mt-0.5 mb-1">
              {selectedTutorIds.map((id) => {
                const tutor = tutorList.find((t) => t.tutorGroupId === id);
                return tutor ? (
                  <Badge key={id} variant="secondary" className="text-xs px-1.5 py-0 gap-0.5">
                    {tutor.displayName}
                    <button
                      type="button"
                      onClick={() => handleRemoveTutor(id)}
                      className="ml-0.5 hover:text-destructive"
                    >
                      <X className="h-3 w-3" />
                    </button>
                  </Badge>
                ) : null;
              })}
            </div>
          )}
          <Popover open={tutorPopoverOpen} onOpenChange={setTutorPopoverOpen}>
            <PopoverTrigger
              render={(props) => (
                <button
                  {...props}
                  type="button"
                  className={`${selectClass} flex items-center gap-2 text-left`}
                >
                  <Search className="h-3.5 w-3.5 text-muted-foreground flex-shrink-0" />
                  <span className="text-muted-foreground">
                    {selectedTutorIds.length === 0
                      ? "Search by tutor name..."
                      : `${selectedTutorIds.length} tutor${selectedTutorIds.length > 1 ? "s" : ""} selected`}
                  </span>
                </button>
              )}
            />
            <PopoverContent className="w-[var(--reference-width)] p-0" align="start">
              <Command>
                <CommandInput placeholder="Type a name..." />
                <CommandList>
                  <CommandEmpty>No tutors found.</CommandEmpty>
                  <CommandGroup>
                    {tutorList.map((t) => {
                      const isSelected = selectedTutorIds.includes(t.tutorGroupId);
                      return (
                        <CommandItem
                          key={t.tutorGroupId}
                          value={t.displayName}
                          onSelect={() => {
                            if (isSelected) {
                              handleRemoveTutor(t.tutorGroupId);
                            } else {
                              handleAddTutor(t.tutorGroupId);
                            }
                          }}
                        >
                          <div className="flex items-start gap-2 w-full">
                            <div className={`flex h-4 w-4 items-center justify-center rounded border mt-0.5 flex-shrink-0 ${isSelected ? "bg-primary border-primary text-primary-foreground" : "border-input"}`}>
                              {isSelected && <Check className="h-3 w-3" />}
                            </div>
                            <div className="flex flex-col gap-0.5 min-w-0">
                              <span className="text-sm font-medium">{t.displayName}</span>
                              <div className="flex gap-1 flex-wrap">
                                {t.supportedModes.map((m) => (
                                  <Badge key={m} variant="secondary" className="text-[10px] px-1 py-0">
                                    {m}
                                  </Badge>
                                ))}
                                {t.subjects.slice(0, 3).map((s) => (
                                  <Badge key={s} variant="outline" className="text-[10px] px-1 py-0">
                                    {s}
                                  </Badge>
                                ))}
                                {t.subjects.length > 3 && (
                                  <span className="text-[10px] text-muted-foreground">
                                    +{t.subjects.length - 3}
                                  </span>
                                )}
                              </div>
                            </div>
                          </div>
                        </CommandItem>
                      );
                    })}
                  </CommandGroup>
                </CommandList>
              </Command>
            </PopoverContent>
          </Popover>
        </div>

        {/* Row 1: Day/Date, From, To */}
        <div className="grid grid-cols-3 gap-2">
          <div>
            <label className="text-xs font-medium text-muted-foreground">
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
            <label className="text-xs font-medium text-muted-foreground">
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
            <label className="text-xs font-medium text-muted-foreground">
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
            <label className="text-xs font-medium text-muted-foreground">
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
            <label className="text-xs font-medium text-muted-foreground">
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
              className="w-full h-8 text-xs"
              size="sm"
            >
              {loading ? "Searching..." : "Search"}
            </Button>
          </div>
        </div>

        {/* Row 3: Qualification filters */}
        <div className="grid grid-cols-3 gap-2">
          <div>
            <label className="text-xs font-medium text-muted-foreground">
              Subject
            </label>
            <select
              className={selectClass}
              value={subjectFilter}
              onChange={(e) => setSubjectFilter(e.target.value)}
            >
              <option value="">Any subject</option>
              {filterOptions.subjects.map((s) => (
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
              className={selectClass}
              value={curriculumFilter}
              onChange={(e) => setCurriculumFilter(e.target.value)}
            >
              <option value="">Any curriculum</option>
              {filterOptions.curriculums.map((c) => (
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
              className={selectClass}
              value={levelFilter}
              onChange={(e) => setLevelFilter(e.target.value)}
            >
              <option value="">Any level</option>
              {filterOptions.levels.map((l) => (
                <option key={l} value={l}>
                  {l}
                </option>
              ))}
            </select>
          </div>
        </div>

        {/* Active filter summary + reset */}
        {activeFilterCount > 0 && (
          <div className="flex items-center justify-between px-0.5 text-[10.5px] text-muted-foreground">
            <span>
              <span className="font-semibold text-foreground">{activeFilterCount}</span>{" "}
              filter{activeFilterCount !== 1 ? "s" : ""} active
            </span>
            <button
              type="button"
              onClick={() => {
                setSubjectFilter("");
                setCurriculumFilter("");
                setLevelFilter("");
                setModeFilter("either");
                setSelectedTutorIds([]);
              }}
              className="underline underline-offset-2 hover:text-foreground"
            >
              Clear all
            </button>
          </div>
        )}
      </div>
    </>
  );
}
