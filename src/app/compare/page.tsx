"use client";

import { useState, useEffect, useCallback } from "react";
import { useSearchParams } from "next/navigation";
import { Card, CardContent } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { TutorSelector, TUTOR_COLORS } from "@/components/compare/tutor-selector";
import type { TutorChip } from "@/components/compare/tutor-selector";
import { CalendarGrid } from "@/components/compare/calendar-grid";
import type { CompareResponse } from "@/lib/search/types";

const DAY_NAMES = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];

export default function ComparePage() {
  const searchParams = useSearchParams();
  const [tutors, setTutors] = useState<TutorChip[]>([]);
  const [activeDay, setActiveDay] = useState<number | null>(null);
  const [response, setResponse] = useState<CompareResponse | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [discoveryOpen, setDiscoveryOpen] = useState(false);

  useEffect(() => {
    const tutorIds = searchParams.get("tutors")?.split(",").filter(Boolean) ?? [];
    if (tutorIds.length > 0) {
      fetchCompare(tutorIds);
    }
  }, []); // eslint-disable-line react-hooks/exhaustive-deps

  const fetchCompare = useCallback(async (ids: string[]) => {
    if (ids.length === 0) {
      setResponse(null);
      return;
    }
    setLoading(true);
    setError(null);
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
      setResponse(data);
      setTutors(
        data.tutors.map((t, i) => ({
          tutorGroupId: t.tutorGroupId,
          displayName: t.displayName,
          color: TUTOR_COLORS[i % TUTOR_COLORS.length],
        })),
      );
    } catch (err) {
      setError(err instanceof Error ? err.message : "Compare failed");
    } finally {
      setLoading(false);
    }
  }, []);

  const handleRemoveTutor = (id: string) => {
    const remaining = tutors.filter((t) => t.tutorGroupId !== id);
    setTutors(remaining);
    fetchCompare(remaining.map((t) => t.tutorGroupId));
  };

  const handleAddTutor = (id: string, name: string) => {
    if (tutors.length >= 3) return;
    const updated = [
      ...tutors,
      { tutorGroupId: id, displayName: name, color: TUTOR_COLORS[tutors.length] },
    ];
    setTutors(updated);
    setDiscoveryOpen(false);
    fetchCompare(updated.map((t) => t.tutorGroupId));
  };

  return (
    <div className="mx-auto max-w-6xl p-6 space-y-6">
      <div className="flex items-center justify-between">
        <h1 className="text-2xl font-bold">Compare Tutors</h1>
        <a href="/search" className="text-sm text-blue-600 hover:underline">
          ← Back to Search
        </a>
      </div>

      <Card>
        <CardContent className="pt-6">
          <TutorSelector
            tutors={tutors}
            onRemove={handleRemoveTutor}
            onOpenDiscovery={() => setDiscoveryOpen(true)}
          />
        </CardContent>
      </Card>

      {error && (
        <div className="rounded-md bg-red-50 p-3 text-sm text-red-700">{error}</div>
      )}

      {loading && (
        <div className="text-center text-sm text-muted-foreground py-8">Loading schedules...</div>
      )}

      {response && !loading && (
        <>
          <div className="flex items-center gap-2 text-xs text-muted-foreground">
            <span>Snapshot: {response.snapshotMeta.snapshotId.slice(0, 8)}</span>
            <span>|</span>
            <span>Synced: {new Date(response.snapshotMeta.syncedAt).toLocaleString()}</span>
            <span>|</span>
            <span>{response.latencyMs}ms</span>
            {response.snapshotMeta.stale && (
              <Badge variant="destructive" className="text-xs">Stale Data</Badge>
            )}
          </div>

          <div className="flex border-b">
            <button
              className={`px-4 py-2 text-sm font-medium ${activeDay === null ? "border-b-2 border-blue-500 text-foreground" : "text-muted-foreground hover:text-foreground"}`}
              onClick={() => setActiveDay(null)}
            >
              Week
            </button>
            {[1, 2, 3, 4, 5, 6, 0].map((day) => (
              <button
                key={day}
                className={`px-4 py-2 text-sm font-medium ${activeDay === day ? "border-b-2 border-blue-500 text-foreground" : "text-muted-foreground hover:text-foreground"}`}
                onClick={() => setActiveDay(day)}
              >
                {DAY_NAMES[day]}
              </button>
            ))}
          </div>

          <Card>
            <CardContent className="pt-6">
              {activeDay !== null && response ? (
                <CalendarGrid
                  tutors={response.tutors}
                  tutorChips={tutors}
                  conflicts={response.conflicts}
                  sharedFreeSlots={response.sharedFreeSlots}
                  dayOfWeek={activeDay}
                  onFindAlternatives={(conflict) => {
                    setDiscoveryOpen(true);
                  }}
                  onTutorNameClick={(id) => {
                    // Will wire to profile popover in Task 9
                  }}
                />
              ) : response ? (
                <div className="text-center text-sm text-muted-foreground py-12">
                  Week overview — click a day tab to see detailed schedules
                </div>
              ) : null}
            </CardContent>
          </Card>

          {response.conflicts.length > 0 && (
            <div className="rounded-md border border-red-500/30 bg-red-950/10 p-3 text-sm">
              <span className="font-semibold text-red-400">
                {response.conflicts.length} conflict{response.conflicts.length > 1 ? "s" : ""} detected
              </span>
              <ul className="mt-1 space-y-1 text-red-300/80 text-xs">
                {response.conflicts.map((c, i) => (
                  <li key={i}>
                    ⚠ {c.studentName} — {DAY_NAMES[c.dayOfWeek]}{" "}
                    {formatMinute(c.startMinute)}–{formatMinute(c.endMinute)} —{" "}
                    {c.tutorA.displayName} vs {c.tutorB.displayName}
                  </li>
                ))}
              </ul>
            </div>
          )}
        </>
      )}

      {/* Discovery panel placeholder — replaced in Task 8 */}
      {discoveryOpen && (
        <div className="rounded-md border p-4 text-sm text-muted-foreground">
          Discovery panel — coming in Task 8.{" "}
          <button
            className="underline"
            onClick={() => handleAddTutor("placeholder-id", "Placeholder")}
          >
            (stub)
          </button>
        </div>
      )}
    </div>
  );
}

function formatMinute(minute: number): string {
  const h = Math.floor(minute / 60);
  const m = minute % 60;
  const suffix = h >= 12 ? "pm" : "am";
  const h12 = h === 0 ? 12 : h > 12 ? h - 12 : h;
  return m === 0 ? `${h12}${suffix}` : `${h12}:${String(m).padStart(2, "0")}${suffix}`;
}
