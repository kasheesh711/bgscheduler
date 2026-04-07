"use client";

import { Badge } from "@/components/ui/badge";

const STORAGE_KEY = "bgscheduler-recent-searches";
const MAX_RECENTS = 10;

const DAY_ABBREVS = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];

export interface RecentSearch {
  searchMode: "recurring" | "one_time";
  dayOfWeek?: number;
  date?: string;
  startTime: string;
  endTime: string;
  durationMinutes: number;
  mode: "online" | "onsite" | "either";
  filters?: {
    subject?: string;
    curriculum?: string;
    level?: string;
  };
  timestamp: number;
}

function getLabel(search: RecentSearch): string {
  const day =
    search.searchMode === "recurring" && search.dayOfWeek !== undefined
      ? DAY_ABBREVS[search.dayOfWeek]
      : search.date ?? "";

  const fmt = (t: string) => {
    const [h] = t.split(":").map(Number);
    const suffix = h >= 12 ? "pm" : "am";
    const h12 = h === 0 ? 12 : h > 12 ? h - 12 : h;
    return `${h12}${suffix}`;
  };

  const time = `${fmt(search.startTime)}-${fmt(search.endTime)}`;
  const parts = [day, time];

  if (search.filters?.subject) parts.push(search.filters.subject);
  if (search.filters?.curriculum) parts.push(search.filters.curriculum);
  if (search.filters?.level) parts.push(search.filters.level);

  return parts.join(" ");
}

export function loadRecents(): RecentSearch[] {
  if (typeof window === "undefined") return [];
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    return raw ? JSON.parse(raw) : [];
  } catch {
    return [];
  }
}

export function saveRecent(search: Omit<RecentSearch, "timestamp">): void {
  const recents = loadRecents();

  // Deduplicate by matching params (ignore timestamp)
  const key = JSON.stringify({ ...search, timestamp: undefined });
  const filtered = recents.filter(
    (r) => JSON.stringify({ ...r, timestamp: undefined }) !== key
  );

  filtered.unshift({ ...search, timestamp: Date.now() });

  // Keep only most recent
  const trimmed = filtered.slice(0, MAX_RECENTS);
  localStorage.setItem(STORAGE_KEY, JSON.stringify(trimmed));
}

interface RecentSearchesProps {
  onSelect: (search: RecentSearch) => void;
}

export function RecentSearches({ onSelect }: RecentSearchesProps) {
  const recents = loadRecents();

  if (recents.length === 0) return null;

  return (
    <div className="flex flex-wrap gap-1.5">
      <span className="text-xs text-muted-foreground self-center mr-1">Recent:</span>
      {recents.map((search, i) => (
        <Badge
          key={i}
          variant="outline"
          className="cursor-pointer hover:bg-muted transition-colors text-xs"
          onClick={() => onSelect(search)}
        >
          {getLabel(search)}
        </Badge>
      ))}
    </div>
  );
}
