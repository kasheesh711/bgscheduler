"use client";

import { useState, useCallback, useRef } from "react";
import { TUTOR_COLORS } from "@/components/compare/tutor-selector";
import type { TutorChip } from "@/components/compare/tutor-selector";
import type { CompareResponse, CompareTutor, Conflict } from "@/lib/search/types";

// ---------------------------------------------------------------------------
// Helper functions
// ---------------------------------------------------------------------------

function formatIsoDate(d: Date): string {
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, "0");
  const day = String(d.getDate()).padStart(2, "0");
  return `${y}-${m}-${day}`;
}

export function getCurrentMonday(): string {
  const now = new Date();
  // Use Asia/Bangkok local date
  const bkk = new Date(now.toLocaleString("en-US", { timeZone: "Asia/Bangkok" }));
  const day = bkk.getDay(); // 0=Sun
  const diff = day === 0 ? -6 : 1 - day;
  const monday = new Date(bkk.getFullYear(), bkk.getMonth(), bkk.getDate() + diff);
  return formatIsoDate(monday);
}

export function shiftWeek(current: string, delta: number): string {
  const [y, m, d] = current.split("-").map(Number);
  const date = new Date(y, m - 1, d + delta * 7);
  return formatIsoDate(date);
}

export function formatWeekLabel(weekStart: string): string {
  const [y, m, d] = weekStart.split("-").map(Number);
  const start = new Date(y, m - 1, d);
  const end = new Date(y, m - 1, d + 6);
  const months = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
  const s = `${start.getDate()} ${months[start.getMonth()]}`;
  const e = `${end.getDate()} ${months[end.getMonth()]}, ${end.getFullYear()}`;
  return `${s} \u2013 ${e}`;
}

export function getWeekDate(weekStart: string, dayOfWeek: number): string {
  const [y, m, d] = weekStart.split("-").map(Number);
  // weekStart is Monday (day 1). Offset: Mon=0, Tue=1, ..., Sat=5, Sun=6
  const offset = dayOfWeek === 0 ? 6 : dayOfWeek - 1;
  const date = new Date(y, m - 1, d + offset);
  return `${date.getDate()}/${date.getMonth() + 1}`;
}

export function formatMinute(minute: number): string {
  const h = Math.floor(minute / 60);
  const m = minute % 60;
  const suffix = h >= 12 ? "pm" : "am";
  const h12 = h === 0 ? 12 : h > 12 ? h - 12 : h;
  return m === 0
    ? `${h12}${suffix}`
    : `${h12}:${String(m).padStart(2, "0")}${suffix}`;
}

// ---------------------------------------------------------------------------
// useCompare hook
// ---------------------------------------------------------------------------

export function useCompare() {
  const [compareTutors, setCompareTutors] = useState<TutorChip[]>([]);
  const [compareResponse, setCompareResponse] = useState<CompareResponse | null>(null);
  const [compareLoading, setCompareLoading] = useState(false);
  const [compareError, setCompareError] = useState<string | null>(null);
  const [activeDay, setActiveDay] = useState<number | null>(null);
  const [discoveryOpen, setDiscoveryOpen] = useState(false);
  const [prefillConflict, setPrefillConflict] = useState<Conflict | null>(null);
  const [weekStart, setWeekStart] = useState<string>(getCurrentMonday);

  const tutorCache = useRef(new Map<string, CompareTutor>());
  const lastSnapshotId = useRef<string | null>(null);
  const abortRef = useRef<AbortController | null>(null);

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

      // If server snapshot changed, our cache is stale -- refetch everything
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

  const removeTutor = (id: string) => {
    const remaining = compareTutors.filter((t) => t.tutorGroupId !== id);
    setCompareTutors(remaining);
    tutorCache.current.delete(`${id}:${weekStart}`);
    if (remaining.length === 0) {
      setCompareResponse(null);
      return;
    }
    // Fetch zero tutors -- only recompute conflicts/free-slots on server
    fetchCompare(remaining.map((t) => t.tutorGroupId), weekStart, { fetchOnly: [] });
  };

  const addTutor = (id: string, name: string) => {
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

  const changeWeek = (newWeek: string) => {
    setWeekStart(newWeek);
    tutorCache.current.clear();
    if (compareTutors.length > 0) {
      fetchCompare(compareTutors.map((t) => t.tutorGroupId), newWeek);
    }
  };

  return {
    // State
    compareTutors,
    compareResponse,
    compareLoading,
    compareError,
    activeDay,
    discoveryOpen,
    prefillConflict,
    weekStart,
    tutorCache,
    // Actions
    fetchCompare,
    addTutor,
    removeTutor,
    changeWeek,
    setActiveDay,
    setDiscoveryOpen,
    setPrefillConflict,
    getCurrentMonday,
  };
}

export type UseCompareReturn = ReturnType<typeof useCompare>;
