"use client";

import { useState, useCallback, useRef } from "react";
import { flushSync } from "react-dom";
import { toZonedTime } from "date-fns-tz";
import { TUTOR_COLORS } from "@/components/compare/session-colors";
import type { TutorChip } from "@/components/compare/tutor-selector";
import { CACHE_VERSION } from "@/lib/search/cache-version";
import { TIMEZONE } from "@/lib/normalization/timezone";
import type { CompareResponse, CompareTutor, Conflict } from "@/lib/search/types";
import {
  type CalendarViewTransitionKind,
  runCalendarViewTransition,
} from "@/lib/ui/view-transitions";

interface PreparedCompareState {
  response: CompareResponse;
  tutorChips: TutorChip[];
}

interface WeekChangeOptions {
  kind?: CalendarViewTransitionKind | null;
  skipTransition?: boolean;
  capturedScrollTop?: number;
  restoreScrollTop?: (scrollTop: number) => void;
}

interface ReplaceCompareOptions {
  activeDay?: number | null;
}

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
  // REL-08: canonical "now in Bangkok" via date-fns-tz toZonedTime.
  const bkk = toZonedTime(new Date(), TIMEZONE);
  const day = bkk.getDay(); // 0=Sun
  const diff = day === 0 ? -6 : 1 - day;
  const monday = new Date(bkk.getFullYear(), bkk.getMonth(), bkk.getDate() + diff);
  return formatIsoDate(monday);
}

export function getMondayForDate(date: Date): string {
  const day = date.getDay(); // 0=Sun
  const diff = day === 0 ? -6 : 1 - day;
  const monday = new Date(date.getFullYear(), date.getMonth(), date.getDate() + diff);
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

  const commitPreparedCompare = useCallback((prepared: PreparedCompareState) => {
    setCompareResponse(prepared.response);
    setCompareTutors(prepared.tutorChips);
  }, []);

  const fetchCompareData = useCallback(async (
    ids: string[],
    week: string,
    opts?: { fetchOnly?: string[]; _retried?: boolean; keepCurrentVisible?: boolean },
  ): Promise<PreparedCompareState | null> => {
    if (ids.length === 0) {
      return null;
    }

    // Abort any in-flight request
    abortRef.current?.abort();
    const controller = new AbortController();
    abortRef.current = controller;

    if (!opts?.keepCurrentVisible) {
      setCompareLoading(true);
    }
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
        if (opts?._retried) {
          // Already retried once; surface the error rather than recurse again.
          setCompareError("Snapshot changed during fetch. Please retry.");
          return null;
        }
        // Recursive full refetch (no fetchOnly).
        return await fetchCompareData(ids, week, {
          _retried: true,
          keepCurrentVisible: opts?.keepCurrentVisible,
        });
      }
      lastSnapshotId.current = data.snapshotMeta.snapshotId;

      // Merge returned tutors into cache
      for (const t of data.tutors) {
        tutorCache.current.set(`${t.tutorGroupId}:${week}:${CACHE_VERSION}`, t);
      }

      // Build full tutor list from cache
      let mergedTutors = ids
        .map((id) => tutorCache.current.get(`${id}:${week}:${CACHE_VERSION}`))
        .filter((t): t is CompareTutor => t !== undefined);

      // Tutor group UUIDs are snapshot-scoped. After a Wise sync, the server may
      // resolve stale URL/cache IDs to the active snapshot and return tutors
      // under new IDs. Treat those returned IDs as authoritative so old
      // /search?tutors=... links recover instead of keeping an empty cache.
      if (mergedTutors.length < data.tutors.length) {
        mergedTutors = data.tutors;
      }

      return {
        response: {
          ...data,
          tutors: mergedTutors,
        },
        tutorChips: mergedTutors.map((t, i) => ({
          tutorGroupId: t.tutorGroupId,
          displayName: t.displayName,
          color: TUTOR_COLORS[i % TUTOR_COLORS.length],
        })),
      };
    } catch (err) {
      if (err instanceof DOMException && err.name === "AbortError") return null;
      setCompareError(err instanceof Error ? err.message : "Compare failed");
      return null;
    } finally {
      if (!opts?.keepCurrentVisible) {
        setCompareLoading(false);
      }
    }
  }, []);

  const fetchCompare = useCallback(async (
    ids: string[],
    week: string,
    opts?: { fetchOnly?: string[]; _retried?: boolean },
  ) => {
    if (ids.length === 0) {
      setCompareResponse(null);
      return;
    }

    const prepared = await fetchCompareData(ids, week, opts);
    if (prepared) {
      commitPreparedCompare(prepared);
    }
  }, [commitPreparedCompare, fetchCompareData]);

  const cancelCompareFetch = useCallback(() => {
    abortRef.current?.abort();
    abortRef.current = null;
  }, []);

  const pruneCacheToWeek = useCallback((committedWeek: string) => {
    const targetSuffix = `:${committedWeek}:${CACHE_VERSION}`;
    for (const key of Array.from(tutorCache.current.keys())) {
      if (!key.endsWith(targetSuffix)) {
        tutorCache.current.delete(key);
      }
    }
  }, []);

  const replaceCompare = useCallback(async (
    ids: string[],
    week: string,
    options: ReplaceCompareOptions = {},
  ) => {
    cancelCompareFetch();
    tutorCache.current.clear();
    setActiveDay(options.activeDay ?? null);

    if (ids.length === 0) {
      setWeekStart(week);
      setCompareResponse(null);
      setCompareTutors([]);
      return;
    }

    const prepared = await fetchCompareData(ids, week);
    if (!prepared) return;

    setWeekStart(week);
    commitPreparedCompare(prepared);
    pruneCacheToWeek(week);
  }, [
    cancelCompareFetch,
    commitPreparedCompare,
    fetchCompareData,
    pruneCacheToWeek,
  ]);

  const removeTutor = (id: string) => {
    const remaining = compareTutors.filter((t) => t.tutorGroupId !== id);
    setCompareTutors(remaining);
    tutorCache.current.delete(`${id}:${weekStart}:${CACHE_VERSION}`);
    if (remaining.length === 0) {
      cancelCompareFetch();
      tutorCache.current.clear();
      setCompareResponse(null);
      return;
    }
    // Fetch zero tutors -- only recompute conflicts/free-slots on server
    fetchCompare(remaining.map((t) => t.tutorGroupId), weekStart, { fetchOnly: [] });
  };

  const addTutor = useCallback(
    (id: string, name: string) => {
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
    },
    [compareTutors, weekStart, fetchCompare],
  );

  const changeWeek = useCallback(async (newWeek: string, options: WeekChangeOptions = {}) => {
    if (newWeek === weekStart) {
      cancelCompareFetch();
      return;
    }

    if (compareTutors.length === 0) {
      setWeekStart(newWeek);
      return;
    }

    const prepared = await fetchCompareData(
      compareTutors.map((t) => t.tutorGroupId),
      newWeek,
      { keepCurrentVisible: true },
    );

    if (prepared === null) {
      return;
    }

    const commitLoadedWeek = () => {
      flushSync(() => {
        setWeekStart(newWeek);
        commitPreparedCompare(prepared);
      });
      pruneCacheToWeek(newWeek);
      if (
        typeof options.restoreScrollTop === "function" &&
        typeof options.capturedScrollTop === "number"
      ) {
        options.restoreScrollTop(options.capturedScrollTop);
      }
    };

    if (options.kind) {
      await runCalendarViewTransition(commitLoadedWeek, {
        kind: options.kind,
        skip: options.skipTransition,
      });
      return;
    }

    commitLoadedWeek();
  }, [
    cancelCompareFetch,
    commitPreparedCompare,
    compareTutors,
    fetchCompareData,
    pruneCacheToWeek,
    weekStart,
  ]);

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
    replaceCompare,
    addTutor,
    removeTutor,
    changeWeek,
    cancelCompareFetch,
    setActiveDay,
    setDiscoveryOpen,
    setPrefillConflict,
    getCurrentMonday,
  };
}

export type UseCompareReturn = ReturnType<typeof useCompare>;
