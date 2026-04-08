"use client";

import { useState, useEffect, useCallback } from "react";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import type { DiscoverResponse, DiscoverCandidate, Conflict } from "@/lib/search/types";

const DAY_NAMES = ["Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"];

interface FilterOptions {
  subjects: string[];
  curriculums: string[];
  levels: string[];
}

interface DiscoveryPanelProps {
  open: boolean;
  onClose: () => void;
  existingTutorGroupIds: string[];
  onAdd: (id: string, name: string) => void;
  prefillConflict?: Conflict | null;
}

export function DiscoveryPanel({
  open,
  onClose,
  existingTutorGroupIds,
  onAdd,
  prefillConflict,
}: DiscoveryPanelProps) {
  const [nameSearch, setNameSearch] = useState("");
  const [dayOfWeek, setDayOfWeek] = useState<number | undefined>(prefillConflict?.dayOfWeek);
  const [startTime, setStartTime] = useState(prefillConflict ? minuteToHHMM(prefillConflict.startMinute) : "");
  const [endTime, setEndTime] = useState(prefillConflict ? minuteToHHMM(prefillConflict.endMinute) : "");
  const [modeFilter, setModeFilter] = useState<"online" | "onsite" | "either">("either");
  const [subjectFilter, setSubjectFilter] = useState(prefillConflict?.tutorB.sessionTitle.split(" — ")[0] ?? "");
  const [filterByTime, setFilterByTime] = useState(!!prefillConflict);
  const [filterOptions, setFilterOptions] = useState<FilterOptions | null>(null);

  const [response, setResponse] = useState<DiscoverResponse | null>(null);
  const [loading, setLoading] = useState(false);

  useEffect(() => {
    if (!open) return;
    fetch("/api/filters")
      .then((res) => (res.ok ? res.json() : null))
      .then((data) => { if (data) setFilterOptions(data); })
      .catch(() => {});
  }, [open]);

  useEffect(() => {
    if (prefillConflict) {
      setDayOfWeek(prefillConflict.dayOfWeek);
      setStartTime(minuteToHHMM(prefillConflict.startMinute));
      setEndTime(minuteToHHMM(prefillConflict.endMinute));
      setFilterByTime(true);
    }
  }, [prefillConflict]);

  const handleSearch = useCallback(async () => {
    setLoading(true);
    try {
      const body: Record<string, unknown> = {
        existingTutorGroupIds,
        mode: "recurring",
        modeFilter: modeFilter !== "either" ? modeFilter : undefined,
        filters: {
          subject: subjectFilter || undefined,
        },
      };

      if (filterByTime && dayOfWeek !== undefined && startTime && endTime) {
        body.dayOfWeek = dayOfWeek;
        body.startTime = startTime;
        body.endTime = endTime;
      }

      const res = await fetch("/api/compare/discover", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
      });

      if (res.ok) {
        const data: DiscoverResponse = await res.json();
        setResponse(data);
      }
    } catch {
      // Silently fail — user can retry
    } finally {
      setLoading(false);
    }
  }, [existingTutorGroupIds, modeFilter, subjectFilter, filterByTime, dayOfWeek, startTime, endTime]);

  useEffect(() => {
    if (open && existingTutorGroupIds.length > 0) {
      handleSearch();
    }
  }, [open, handleSearch, existingTutorGroupIds.length]);

  if (!open) return null;

  const filteredCandidates = response?.candidates.filter((c) =>
    !nameSearch || c.displayName.toLowerCase().includes(nameSearch.toLowerCase()),
  ) ?? [];

  return (
    <div className="fixed inset-0 z-50 flex">
      <div className="flex-1 bg-black/30" onClick={onClose} />

      <div className="w-[360px] bg-background border-l flex flex-col h-full">
        <div className="flex items-center justify-between px-4 py-3 border-b">
          <span className="font-semibold">Add Tutor</span>
          <button onClick={onClose} className="text-muted-foreground hover:text-foreground text-sm">
            ✕ Close
          </button>
        </div>

        <div className="px-4 py-3 space-y-3">
          <input
            className="w-full rounded-md border px-3 py-2 text-sm"
            placeholder="Search by name..."
            value={nameSearch}
            onChange={(e) => setNameSearch(e.target.value)}
          />

          <div className="flex gap-2 flex-wrap">
            <select
              className="rounded-md border px-2 py-1 text-xs"
              value={subjectFilter}
              onChange={(e) => setSubjectFilter(e.target.value)}
            >
              <option value="">Subject</option>
              {filterOptions?.subjects.map((s) => (
                <option key={s} value={s}>{s}</option>
              ))}
            </select>
            <select
              className="rounded-md border px-2 py-1 text-xs"
              value={modeFilter}
              onChange={(e) => setModeFilter(e.target.value as "online" | "onsite" | "either")}
            >
              <option value="either">Mode</option>
              <option value="online">Online</option>
              <option value="onsite">Onsite</option>
            </select>
          </div>

          <div className="rounded-md border p-2 space-y-1">
            <label className="flex items-center gap-2 text-xs">
              <input
                type="checkbox"
                checked={filterByTime}
                onChange={(e) => setFilterByTime(e.target.checked)}
              />
              Only show tutors free at:
            </label>
            {filterByTime && (
              <div className="flex gap-2 items-center pl-5 text-xs">
                <select
                  className="rounded border px-1 py-0.5"
                  value={dayOfWeek ?? ""}
                  onChange={(e) => setDayOfWeek(e.target.value ? Number(e.target.value) : undefined)}
                >
                  <option value="">Day</option>
                  {DAY_NAMES.map((d, i) => (
                    <option key={i} value={i}>{d.slice(0, 3)}</option>
                  ))}
                </select>
                <input
                  type="time"
                  className="rounded border px-1 py-0.5"
                  value={startTime}
                  onChange={(e) => setStartTime(e.target.value)}
                />
                <span>–</span>
                <input
                  type="time"
                  className="rounded border px-1 py-0.5"
                  value={endTime}
                  onChange={(e) => setEndTime(e.target.value)}
                />
              </div>
            )}
          </div>

          <Button size="sm" onClick={handleSearch} disabled={loading} className="w-full">
            {loading ? "Searching..." : "Search"}
          </Button>
        </div>

        {response && (
          <div className="px-4 pb-2 text-[10px] text-muted-foreground uppercase tracking-wide">
            {filteredCandidates.length} tutors
          </div>
        )}

        <div className="flex-1 overflow-y-auto px-4 pb-4 space-y-2">
          {filteredCandidates.map((c) => (
            <CandidateCard
              key={c.tutorGroupId}
              candidate={c}
              onAdd={() => onAdd(c.tutorGroupId, c.displayName)}
            />
          ))}
        </div>
      </div>
    </div>
  );
}

function CandidateCard({ candidate, onAdd }: { candidate: DiscoverCandidate; onAdd: () => void }) {
  const c = candidate;

  return (
    <div className={`rounded-lg border p-3 space-y-2 ${c.hasDataIssues ? "opacity-50" : ""}`}>
      <div className="flex justify-between items-start">
        <div>
          <div className="font-semibold text-sm">{c.displayName}</div>
          <div className="text-xs text-muted-foreground">
            {c.qualifications.map((q) => q.subject).filter((v, i, a) => a.indexOf(v) === i).join(", ")}
            {" · "}
            {c.supportedModes.join("/")}
          </div>
        </div>
        {c.hasDataIssues ? (
          <Badge variant="outline" className="text-[10px] text-yellow-500 border-yellow-500/30">
            Needs review
          </Badge>
        ) : c.conflictCount > 0 ? (
          <Badge variant="outline" className="text-[10px] text-red-400 border-red-400/30">
            {c.conflictCount} conflict{c.conflictCount > 1 ? "s" : ""}
          </Badge>
        ) : (
          <Badge variant="outline" className="text-[10px] text-green-400 border-green-400/30">
            No conflicts
          </Badge>
        )}
      </div>

      {c.freeSlots.length > 0 && (
        <div className="flex gap-1 flex-wrap">
          {c.freeSlots.map((s, i) => (
            <span key={i} className="text-[10px] bg-green-500/10 text-green-400 px-1.5 py-0.5 rounded">
              {s.start}–{s.end} free ✓
            </span>
          ))}
        </div>
      )}

      <div className="text-right">
        <Button
          size="sm"
          variant={c.conflictCount > 0 || c.hasDataIssues ? "outline" : "default"}
          className="text-xs h-7"
          onClick={onAdd}
        >
          {c.conflictCount > 0 ? "Add anyway" : c.hasDataIssues ? "Add anyway" : "Add to compare"}
        </Button>
      </div>
    </div>
  );
}

function minuteToHHMM(minute: number): string {
  const h = Math.floor(minute / 60);
  const m = minute % 60;
  return `${String(h).padStart(2, "0")}:${String(m).padStart(2, "0")}`;
}
