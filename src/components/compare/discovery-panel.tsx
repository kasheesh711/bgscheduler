"use client";

import { useState, useEffect, useCallback } from "react";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogOverlay,
  DialogPortal,
  DialogClose,
} from "@/components/ui/dialog";
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
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!open) return;
    fetch("/api/filters")
      .then((res) => (res.ok ? res.json() : null))
      .then((data) => { if (data) setFilterOptions(data); })
      .catch((err) => {
        console.error("Failed to load filter options:", err);
      });
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
    setError(null);
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
      } else {
        const errData = await res.json().catch(() => ({}));
        setError(errData.error ?? `Search failed (${res.status})`);
      }
    } catch {
      setError("Search failed. Please try again.");
    } finally {
      setLoading(false);
    }
  }, [existingTutorGroupIds, modeFilter, subjectFilter, filterByTime, dayOfWeek, startTime, endTime]);

  useEffect(() => {
    if (open && existingTutorGroupIds.length > 0) {
      handleSearch();
    }
  }, [open, handleSearch, existingTutorGroupIds.length]);

  const filteredCandidates = response?.candidates.filter((c) =>
    !nameSearch || c.displayName.toLowerCase().includes(nameSearch.toLowerCase()),
  ) ?? [];

  return (
    <Dialog open={open} onOpenChange={(isOpen) => { if (!isOpen) onClose(); }}>
      <DialogPortal>
        <DialogOverlay />
        <DialogContent className="max-w-lg max-h-[80vh] flex flex-col">
          <DialogHeader>
            <DialogTitle>Find Tutors</DialogTitle>
          </DialogHeader>

          <div className="space-y-3 flex-shrink-0">
            <input
              className="w-full rounded-md border border-input bg-background px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-ring/50"
              placeholder="Search by name..."
              value={nameSearch}
              onChange={(e) => setNameSearch(e.target.value)}
            />

            <div className="flex gap-2 flex-wrap">
              <select
                className="rounded-md border border-input bg-background px-2 py-1 text-xs focus:outline-none focus:ring-2 focus:ring-ring/50"
                value={subjectFilter}
                onChange={(e) => setSubjectFilter(e.target.value)}
              >
                <option value="">Subject</option>
                {filterOptions?.subjects.map((s) => (
                  <option key={s} value={s}>{s}</option>
                ))}
              </select>
              <select
                className="rounded-md border border-input bg-background px-2 py-1 text-xs focus:outline-none focus:ring-2 focus:ring-ring/50"
                value={modeFilter}
                onChange={(e) => setModeFilter(e.target.value as "online" | "onsite" | "either")}
              >
                <option value="either">Mode</option>
                <option value="online">Online</option>
                <option value="onsite">Onsite</option>
              </select>
            </div>

            <div className="rounded-md border border-input p-2 space-y-1">
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
                    className="rounded border border-input bg-background px-1 py-0.5"
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
                    className="rounded border border-input bg-background px-1 py-0.5"
                    value={startTime}
                    onChange={(e) => setStartTime(e.target.value)}
                  />
                  <span>–</span>
                  <input
                    type="time"
                    className="rounded border border-input bg-background px-1 py-0.5"
                    value={endTime}
                    onChange={(e) => setEndTime(e.target.value)}
                  />
                </div>
              )}
            </div>

            <Button size="sm" onClick={handleSearch} disabled={loading} className="w-full">
              {loading ? "Searching..." : "Search"}
            </Button>

            {error && (
              <div className="rounded-md bg-destructive/10 p-2 text-xs text-destructive">
                {error}
              </div>
            )}
          </div>

          {response && (
            <div className="text-[10px] text-muted-foreground uppercase tracking-wide mt-2">
              {filteredCandidates.length} tutors
            </div>
          )}

          <div className="flex-1 overflow-y-auto space-y-2 mt-2 min-h-0">
            {filteredCandidates.map((c) => (
              <CandidateCard
                key={c.tutorGroupId}
                candidate={c}
                onAdd={() => onAdd(c.tutorGroupId, c.displayName)}
              />
            ))}
          </div>
        </DialogContent>
      </DialogPortal>
    </Dialog>
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
          <Badge variant="outline" className="text-[10px] text-blocked border-blocked/30">
            Needs review
          </Badge>
        ) : c.conflictCount > 0 ? (
          <Badge variant="outline" className="text-[10px] text-conflict border-conflict/30">
            {c.conflictCount} conflict{c.conflictCount > 1 ? "s" : ""}
          </Badge>
        ) : (
          <Badge variant="outline" className="text-[10px] text-available border-available/30">
            No conflicts
          </Badge>
        )}
      </div>

      {c.freeSlots.length > 0 && (
        <div className="flex gap-1 flex-wrap">
          {c.freeSlots.map((s, i) => (
            <span key={i} className="text-[10px] bg-available/10 text-available px-1.5 py-0.5 rounded">
              {s.start}–{s.end} free
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
