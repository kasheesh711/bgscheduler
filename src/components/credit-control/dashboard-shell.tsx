"use client";

import { CircleHelp, LogOut, RefreshCw, Search, X } from "lucide-react";
import { startTransition, useCallback, useDeferredValue, useEffect, useMemo, useRef, useState } from "react";

import { formatShortTimestamp } from "@/lib/credit-control/helpers";
import type {
  AppSessionUser,
  DashboardPayload,
  StudentActionStatus,
  StudentRecord,
} from "@/types/credit-control";
import type { CalendarView, LinePreview, RiskFilter, SortField, SortState, Toast } from "@/lib/credit-control/ui-helpers";
import {
  actionStatusLabel,
  buildAdminScopedSummary,
  buildFilteredCalendarDayMap,
  buildParentMessage,
  buildActionToastMessage,
  compareNullableDates,
  findNextCalendarDate,
  formatDateKey,
  getAdjacentActionableDate,
  getCalendarCursorForView,
  getDefaultCalendarDate,
  getDefaultDateForCurrentPeriod,
  getSelectedCalendarDay,
  getVisibleCalendarDates,
  isQueueRowVisibleForCurrentAdmin,
  isStudentVisibleForCurrentAdmin,
  parseDateKey,
  startOfMonth,
  addDays,
} from "@/lib/credit-control/ui-helpers";

import { BulkActionBar } from "./bulk-action-bar";
import { CalendarPanel } from "./calendar-panel";
import { LinePreviewDrawer } from "./line-preview-modal";
import { QueuePanel, type QueuePanelHandle } from "./queue-panel";
import { StudentDetail, type ActionHistoryEntry } from "./student-detail";
import { SummaryBar } from "./summary-bar";
import { ToastNotification } from "./toast-notification";
import { useKeyboardShortcuts, SHORTCUT_LIST } from "@/hooks/use-keyboard-shortcuts";
import { useResizableSplit } from "@/hooks/use-resizable-split";

export function DashboardShell({ sessionUser }: { sessionUser: AppSessionUser }) {
  // ---------------------------------------------------------------------------
  // State
  // ---------------------------------------------------------------------------
  const [data, setData] = useState<DashboardPayload | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const [adminView, setAdminViewRaw] = useState(() => {
    if (typeof window === "undefined") return "all";
    return localStorage.getItem("begifted-admin-view") ?? "all";
  });
  const setAdminView = useCallback((key: string) => {
    setAdminViewRaw(key);
    try { localStorage.setItem("begifted-admin-view", key); } catch { /* quota */ }
  }, []);
  const [riskFilter, setRiskFilter] = useState<RiskFilter>("all");
  const [search, setSearch] = useState("");
  const [selectedStudentKey, setSelectedStudentKey] = useState("");
  const [selectedCalendarDate, setSelectedCalendarDate] = useState("");
  const [calendarView, setCalendarView] = useState<CalendarView>("month");
  const [calendarCursor, setCalendarCursor] = useState(startOfMonth(new Date()));
  const [selectedKeys, setSelectedKeys] = useState<string[]>([]);
  const [currentSort, setCurrentSort] = useState<SortState>({
    field: "priorityScore",
    dir: "desc",
  });
  const [toast, setToast] = useState<Toast>(null);
  const [submitting, setSubmitting] = useState(false);
  const [linePreview, setLinePreview] = useState<LinePreview>(null);
  const [showRemoved, setShowRemoved] = useState(false);
  const [refreshing, setRefreshing] = useState(false);
  const [optimisticKeys, setOptimisticKeys] = useState<Set<string>>(new Set());
  const [actionHistory, setActionHistory] = useState<ActionHistoryEntry[]>([]);
  const actionHistoryCache = useRef<Record<string, ActionHistoryEntry[]>>({});
  const deferredSearch = useDeferredValue(search.trim().toLowerCase());

  const queuePanelRef = useRef<QueuePanelHandle>(null);
  const searchInputRef = useRef<HTMLInputElement>(null);

  // ---------------------------------------------------------------------------
  // Data loading
  // ---------------------------------------------------------------------------
  const loadDashboard = useCallback(async (mode: "initial" | "refresh") => {
    if (mode === "initial") {
      setLoading(true);
      setError("");
    } else {
      if (!document.hasFocus()) return;
      setRefreshing(true);
    }

    try {
      const response = await fetch("/api/credit-control", { cache: "no-store" });
      if (!response.ok) {
        throw new Error(`Dashboard request failed (${response.status})`);
      }

      const payload = (await response.json()) as DashboardPayload;

      startTransition(() => {
        setData(payload);
        if (mode === "initial") {
          setSelectedStudentKey(payload.studentQueue[0]?.studentKey ?? payload.students[0]?.studentKey ?? "");
          const defaultDate = getDefaultCalendarDate(payload.calendar);
          setSelectedCalendarDate(defaultDate);
          setCalendarCursor(getCalendarCursorForView("month", parseDateKey(defaultDate)));
        }
      });
    } catch (loadError) {
      if (mode === "initial") {
        setError(loadError instanceof Error ? loadError.message : "Failed to load dashboard.");
      }
    } finally {
      if (mode === "initial") setLoading(false);
      setRefreshing(false);
    }
  }, []);

  useEffect(() => {
    void loadDashboard("initial");
    const interval = window.setInterval(() => {
      void loadDashboard("refresh");
    }, 60_000);
    return () => window.clearInterval(interval);
  }, [loadDashboard]);

  useEffect(() => {
    if (!toast) return;
    if (toast.tone === "error") return;
    if (toast.undo) {
      const timer = window.setTimeout(() => {
        setToast({ message: "Saved", tone: "success" });
      }, 5000);
      return () => window.clearTimeout(timer);
    }
    const timer = window.setTimeout(() => setToast(null), 3500);
    return () => window.clearTimeout(timer);
  }, [toast]);

  // ---------------------------------------------------------------------------
  // Derived data
  // ---------------------------------------------------------------------------
  const adminScopedStudents = useMemo(() => {
    if (!data) return [];
    return data.students.filter((student) => isStudentVisibleForCurrentAdmin(student, adminView));
  }, [adminView, data]);

  const adminScopedQueue = useMemo(() => {
    if (!data) return [];
    return data.studentQueue.filter((row) => isQueueRowVisibleForCurrentAdmin(row, adminView));
  }, [adminView, data]);

  // All active students (admin-scoped). Used as the worklist source only while a
  // search is active, so any active student is reachable by search — not just the
  // at-risk queue. The summary/calendar keep using the at-risk `adminScopedQueue`.
  const adminScopedQueueAll = useMemo(() => {
    if (!data) return [];
    const source = data.studentQueueAll ?? data.studentQueue;
    return source.filter((row) => isQueueRowVisibleForCurrentAdmin(row, adminView));
  }, [adminView, data]);

  const adminScopedSummary = useMemo(
    () => buildAdminScopedSummary(adminScopedStudents, adminScopedQueue),
    [adminScopedQueue, adminScopedStudents],
  );

  const filteredQueue = useMemo(() => {
    // While searching, widen the worklist to all active students so a searched
    // student appears even if they are not in the at-risk queue.
    const base = deferredSearch ? adminScopedQueueAll : adminScopedQueue;
    return base.filter((row) => {
      const matchesRisk =
        riskFilter === "all"
          ? true
          : riskFilter === "ok"
            ? row.worstStatus === "ok"
            : row.worstStatus === riskFilter;
      const matchesSearch = !deferredSearch || row.searchText.includes(deferredSearch);
      return matchesRisk && matchesSearch;
    });
  }, [adminScopedQueue, adminScopedQueueAll, deferredSearch, riskFilter]);

  const sortedQueue = useMemo(() => {
    const direction = currentSort.dir === "asc" ? 1 : -1;

    return filteredQueue.slice().sort((a, b) => {
      if (currentSort.field === "student") {
        return direction * a.student.localeCompare(b.student);
      }
      if (currentSort.field === "priorityScore") {
        return direction * (a.priorityScore - b.priorityScore);
      }
      if (currentSort.field === "totalCurrentRemaining") {
        return direction * (a.totalCurrentRemaining - b.totalCurrentRemaining);
      }
      if (currentSort.field === "totalAdjustedRemaining") {
        return direction * (a.totalAdjustedRemaining - b.totalAdjustedRemaining);
      }
      if (currentSort.field === "packageCount") {
        return direction * (a.packageCount - b.packageCount);
      }
      return direction * compareNullableDates(a.nextSessionDate, b.nextSessionDate);
    });
  }, [currentSort, filteredQueue]);

  const adminScopedCalendarDays = useMemo(() => {
    if (!data) return [];

    return data.calendar.days.map((day) => ({
      ...day,
      students: day.students.filter((student) =>
        adminView === "all"
          ? true
          : adminView === "unassigned"
            ? student.adminOwnerKey === "unassigned"
            : student.adminOwnerKey === adminView,
      ),
    }));
  }, [adminView, data]);

  const filteredCalendarDayMap = useMemo(
    () => buildFilteredCalendarDayMap(adminScopedCalendarDays, deferredSearch),
    [adminScopedCalendarDays, deferredSearch],
  );

  const selectedDay = useMemo(
    () => getSelectedCalendarDay(filteredCalendarDayMap, selectedCalendarDate),
    [filteredCalendarDayMap, selectedCalendarDate],
  );

  const selectedStudent = useMemo(() => {
    if (!data) return null;

    return (
      data.students.find(
        (student) =>
          student.studentKey === selectedStudentKey &&
          isStudentVisibleForCurrentAdmin(student, adminView),
      ) ??
      data.students.find((student) => student.studentKey === sortedQueue[0]?.studentKey) ??
      adminScopedStudents[0] ??
      null
    );
  }, [adminScopedStudents, adminView, data, selectedStudentKey, sortedQueue]);

  const visibleSelectedRows = useMemo(() => {
    const visibleSet = new Set(sortedQueue.map((row) => row.studentKey));
    return selectedKeys.filter((key) => visibleSet.has(key));
  }, [selectedKeys, sortedQueue]);

  const selectedDayStudentKeys = useMemo(() => {
    if (!selectedDay) return new Set<string>();
    return new Set(selectedDay.students.map((s) => s.key));
  }, [selectedDay]);

  // ---------------------------------------------------------------------------
  // Sync effects
  // ---------------------------------------------------------------------------
  useEffect(() => {
    if (!data) return;

    const nextKey =
      selectedStudent &&
      isStudentVisibleForCurrentAdmin(selectedStudent, adminView)
        ? selectedStudent.studentKey
        : sortedQueue[0]?.studentKey ?? adminScopedStudents[0]?.studentKey ?? "";

    if (nextKey !== selectedStudentKey) {
      setSelectedStudentKey(nextKey);
    }
  }, [adminScopedStudents, adminView, data, selectedStudent, selectedStudentKey, sortedQueue]);

  useEffect(() => {
    if (!data) return;

    const visibleDates = getVisibleCalendarDates(filteredCalendarDayMap);
    const nextDate =
      selectedCalendarDate && filteredCalendarDayMap[selectedCalendarDate]
        ? selectedCalendarDate
        : visibleDates[0] ?? getDefaultCalendarDate(data.calendar);

    if (nextDate !== selectedCalendarDate) {
      setSelectedCalendarDate(nextDate);
      setCalendarCursor(getCalendarCursorForView(calendarView, parseDateKey(nextDate)));
    }
  }, [calendarView, data, filteredCalendarDayMap, selectedCalendarDate]);

  // ---------------------------------------------------------------------------
  // Action history fetch
  // ---------------------------------------------------------------------------
  useEffect(() => {
    if (!selectedStudent) {
      setActionHistory([]);
      return;
    }
    const key = selectedStudent.studentKey;
    if (actionHistoryCache.current[key]) {
      setActionHistory(actionHistoryCache.current[key]);
      return;
    }
    let cancelled = false;
    fetch(`/api/credit-control/actions/history?studentKey=${encodeURIComponent(key)}`)
      .then((res) => (res.ok ? res.json() : { entries: [] }))
      .then((data: { history?: ActionHistoryEntry[]; entries?: ActionHistoryEntry[] }) => {
        if (cancelled) return;
        const entries = data.history ?? data.entries ?? [];
        actionHistoryCache.current[key] = entries;
        setActionHistory(entries);
      })
      .catch(() => {
        if (!cancelled) setActionHistory([]);
      });
    return () => { cancelled = true; };
  }, [selectedStudent?.studentKey]); // eslint-disable-line react-hooks/exhaustive-deps

  // ---------------------------------------------------------------------------
  // Action handlers
  // ---------------------------------------------------------------------------
  async function submitSingleAction(student: StudentRecord, status: StudentActionStatus | null) {
    const previousActionState = student.actionState;
    const previousStatus = previousActionState?.status ?? null;
    const optimisticActionState: StudentRecord["actionState"] = status
      ? { status, updatedAt: new Date().toISOString(), updatedByName: sessionUser.name, isToday: true }
      : null;

    // Optimistic update
    patchActionState(student.studentKey, optimisticActionState);
    setOptimisticKeys((prev) => new Set(prev).add(student.studentKey));
    setSubmitting(true);

    try {
      const response = await fetch("/api/credit-control/actions", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ studentKey: student.studentKey, status }),
      });
      if (!response.ok) {
        throw new Error(`Action request failed (${response.status})`);
      }

      const update = (await response.json()) as {
        studentKey: string;
        actionState: StudentRecord["actionState"];
      };
      patchActionState(update.studentKey, update.actionState);
      delete actionHistoryCache.current[student.studentKey];

      if (status) {
        setToast({
          message: `Marked ${student.student} as ${actionStatusLabel(status).toLowerCase()}.`,
          tone: "success",
          undo: { studentKey: student.studentKey, previousStatus, previousActionState },
        });
      } else {
        setToast({
          message: buildActionToastMessage(null, 1),
          tone: "success",
        });
      }
    } catch (submitError) {
      // Revert optimistic update
      patchActionState(student.studentKey, previousActionState);
      setToast({
        message: submitError instanceof Error ? submitError.message : "Failed to save action.",
        tone: "error",
      });
    } finally {
      setOptimisticKeys((prev) => {
        const next = new Set(prev);
        next.delete(student.studentKey);
        return next;
      });
      setSubmitting(false);
    }
  }

  async function submitSingleActionByKey(studentKey: string, status: StudentActionStatus) {
    const student = data?.students.find((s) => s.studentKey === studentKey);
    if (student) {
      await submitSingleAction(student, status);
    }
  }

  async function handleMarkInactive(student: StudentRecord) {
    setSubmitting(true);
    try {
      const response = await fetch("/api/credit-control/inactive", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ studentKey: student.studentKey }),
      });
      if (!response.ok) {
        throw new Error(`Failed to mark inactive (${response.status})`);
      }
      setToast({
        message: `${student.student} marked as no longer active.`,
        tone: "success",
        undo: {
          studentKey: student.studentKey,
          previousStatus: null,
          previousActionState: null,
          kind: "inactive",
        },
      });
      setSelectedStudentKey("");
      await loadDashboard("refresh");
    } catch (err) {
      setToast({
        message: err instanceof Error ? err.message : "Failed to mark inactive.",
        tone: "error",
      });
    } finally {
      setSubmitting(false);
    }
  }

  async function restoreInactive(studentKey: string) {
    setSubmitting(true);
    try {
      const response = await fetch("/api/credit-control/inactive", {
        method: "DELETE",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ studentKey }),
      });
      if (!response.ok) {
        throw new Error(`Failed to restore (${response.status})`);
      }
      setToast({ message: "Student restored to the worklist.", tone: "success" });
      await loadDashboard("refresh");
    } catch (err) {
      setToast({
        message: err instanceof Error ? err.message : "Failed to restore.",
        tone: "error",
      });
    } finally {
      setSubmitting(false);
    }
  }

  async function submitBulkAction(status: StudentActionStatus | null) {
    if (!visibleSelectedRows.length) {
      setToast({ message: "Select at least one student first.", tone: "error" });
      return;
    }

    // Save previous states for revert
    const previousStates = new Map<string, StudentRecord["actionState"]>();
    visibleSelectedRows.forEach((key) => {
      const student = data?.students.find((s) => s.studentKey === key);
      previousStates.set(key, student?.actionState ?? null);
    });

    const optimisticActionState: StudentRecord["actionState"] = status
      ? { status, updatedAt: new Date().toISOString(), updatedByName: sessionUser.name, isToday: true }
      : null;

    // Optimistic update
    visibleSelectedRows.forEach((key) => {
      patchActionState(key, optimisticActionState);
    });
    setOptimisticKeys((prev) => {
      const next = new Set(prev);
      visibleSelectedRows.forEach((key) => next.add(key));
      return next;
    });
    setSubmitting(true);

    try {
      const response = await fetch("/api/credit-control/actions/bulk", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ studentKeys: visibleSelectedRows, status }),
      });
      if (!response.ok) {
        throw new Error(`Bulk action request failed (${response.status})`);
      }

      const payload = (await response.json()) as {
        updated: Array<{ studentKey: string; actionState: StudentRecord["actionState"] }>;
      };
      payload.updated.forEach((update) => patchActionState(update.studentKey, update.actionState));
      payload.updated.forEach((update) => {
        delete actionHistoryCache.current[update.studentKey];
      });
      setSelectedKeys([]);
      setToast({
        message: buildActionToastMessage(status ? { status } : null, payload.updated.length),
        tone: "success",
      });
    } catch (submitError) {
      // Revert optimistic updates
      previousStates.forEach((prevState, key) => {
        patchActionState(key, prevState);
      });
      setToast({
        message: submitError instanceof Error ? submitError.message : "Failed to save bulk action.",
        tone: "error",
      });
    } finally {
      setOptimisticKeys((prev) => {
        const next = new Set(prev);
        visibleSelectedRows.forEach((key) => next.delete(key));
        return next;
      });
      setSubmitting(false);
    }
  }

  function patchActionState(studentKey: string, actionState: StudentRecord["actionState"]) {
    setData((current) => {
      if (!current) return current;
      return {
        ...current,
        students: current.students.map((student) =>
          student.studentKey === studentKey ? { ...student, actionState } : student,
        ),
        studentQueue: current.studentQueue.map((row) =>
          row.studentKey === studentKey ? { ...row, actionState } : row,
        ),
      };
    });
  }

  function toggleSort(field: SortField) {
    setCurrentSort((current) => {
      if (current.field === field) {
        return { field, dir: current.dir === "asc" ? "desc" : "asc" };
      }
      return { field, dir: field === "student" || field === "nextSessionDate" ? "asc" : "desc" };
    });
  }

  function toggleStudentSelection(studentKey: string) {
    setSelectedKeys((current) =>
      current.includes(studentKey)
        ? current.filter((item) => item !== studentKey)
        : [...current, studentKey],
    );
  }

  function toggleAllVisible() {
    setSelectedKeys((current) =>
      visibleSelectedRows.length === sortedQueue.length
        ? current.filter((key) => !sortedQueue.some((row) => row.studentKey === key))
        : Array.from(new Set([...current, ...sortedQueue.map((row) => row.studentKey)])),
    );
  }

  function openStudent(studentKey: string) {
    setSelectedStudentKey(studentKey);
    queuePanelRef.current?.scrollToStudent(studentKey);
  }

  function openStudentByIndex(studentIndex: number) {
    const student = data?.students[studentIndex];
    if (student) {
      openStudent(student.studentKey);
    }
  }

  // ---------------------------------------------------------------------------
  // Calendar handlers
  // ---------------------------------------------------------------------------
  function selectCalendarDate(dateKey: string) {
    setSelectedCalendarDate(dateKey);
    setCalendarCursor(getCalendarCursorForView(calendarView, parseDateKey(dateKey)));
  }

  function handleSetCalendarView(view: CalendarView) {
    setCalendarView(view);
    setCalendarCursor(getCalendarCursorForView(view, parseDateKey(selectedCalendarDate)));
  }

  function shiftCalendar(direction: number) {
    if (calendarView === "month") {
      const nextCursor = new Date(calendarCursor.getFullYear(), calendarCursor.getMonth() + direction, 1);
      setCalendarCursor(nextCursor);
      setSelectedCalendarDate(getDefaultDateForCurrentPeriod(nextCursor, "month", filteredCalendarDayMap));
      return;
    }

    if (calendarView === "week") {
      const nextCursor = addDays(calendarCursor, direction * 7);
      setCalendarCursor(nextCursor);
      setSelectedCalendarDate(getDefaultDateForCurrentPeriod(nextCursor, "week", filteredCalendarDayMap));
      return;
    }

    const nextCursor = addDays(calendarCursor, direction);
    setCalendarCursor(nextCursor);
    setSelectedCalendarDate(formatDateKey(nextCursor));
  }

  function jumpToToday() {
    selectCalendarDate(formatDateKey(new Date()));
  }

  function jumpToNextUrgentDay() {
    const target = findNextCalendarDate(
      getVisibleCalendarDates(filteredCalendarDayMap).filter(
        (dateKey) => filteredCalendarDayMap[dateKey].urgentStudents > 0,
      ),
      selectedCalendarDate || formatDateKey(new Date()),
    );
    if (target) selectCalendarDate(target);
  }

  function jumpToNextScheduledDay() {
    const target = findNextCalendarDate(
      getVisibleCalendarDates(filteredCalendarDayMap),
      selectedCalendarDate || formatDateKey(new Date()),
    );
    if (target) selectCalendarDate(target);
  }

  function jumpToAdjacentActionableDay(direction: number) {
    if (!selectedCalendarDate) return;
    const target = getAdjacentActionableDate(selectedCalendarDate, direction, filteredCalendarDayMap);
    if (target) selectCalendarDate(target);
  }

  // ---------------------------------------------------------------------------
  // LINE drawer handlers
  // ---------------------------------------------------------------------------
  async function copyLineMessage() {
    if (!linePreview) return;
    try {
      await navigator.clipboard.writeText(linePreview.message);
      setToast({ message: "LINE message copied.", tone: "success" });
    } catch (copyError) {
      setToast({
        message: copyError instanceof Error ? copyError.message : "Failed to copy message.",
        tone: "error",
      });
    }
  }

  async function copyAndMarkContacted() {
    if (!linePreview) return;
    try {
      await navigator.clipboard.writeText(linePreview.message);
      await submitSingleAction(linePreview.student, "contacted");
      setLinePreview(null);
    } catch (copyError) {
      setToast({
        message: copyError instanceof Error ? copyError.message : "Failed to copy message.",
        tone: "error",
      });
    }
  }

  // ---------------------------------------------------------------------------
  // Combo action: Copy + Contact + Next
  // ---------------------------------------------------------------------------
  async function comboContactNext(student: StudentRecord) {
    const worstPkg = [...student.packages].sort(
      (a, b) => (a.adjustedRemaining ?? 999) - (b.adjustedRemaining ?? 999),
    )[0];
    if (!worstPkg) return;

    const message = buildParentMessage(student, worstPkg);
    let copyFailed = false;
    try {
      await navigator.clipboard.writeText(message);
    } catch {
      copyFailed = true;
    }

    await submitSingleAction(student, "contacted");
    // Invalidate history cache for this student since we just marked them
    delete actionHistoryCache.current[student.studentKey];
    moveStudent(1);

    if (copyFailed) {
      setToast({
        message: `Marked ${student.student} as contacted, but clipboard copy failed.`,
        tone: "error",
      });
    } else {
      setToast({
        message: `Copied LINE message + marked ${student.student} as contacted.`,
        tone: "success",
      });
    }
  }

  // ---------------------------------------------------------------------------
  // Keyboard shortcuts
  // ---------------------------------------------------------------------------
  const moveStudent = useCallback(
    (direction: number) => {
      if (!sortedQueue.length) return;
      const currentIndex = sortedQueue.findIndex((row) => row.studentKey === selectedStudentKey);
      const nextIndex = Math.max(0, Math.min(sortedQueue.length - 1, currentIndex + direction));
      const nextKey = sortedQueue[nextIndex].studentKey;
      setSelectedStudentKey(nextKey);
      queuePanelRef.current?.scrollToStudent(nextKey);
    },
    [selectedStudentKey, sortedQueue],
  );

  const { ratio: splitRatio, containerRef: splitContainerRef, dividerProps } = useResizableSplit();

  const { showHelp, setShowHelp } = useKeyboardShortcuts({
    onNextStudent: () => moveStudent(1),
    onPrevStudent: () => moveStudent(-1),
    onMarkContacted: () => {
      if (selectedStudent) submitSingleAction(selectedStudent, "contacted");
    },
    onMarkPending: () => {
      if (selectedStudent) submitSingleAction(selectedStudent, "pending-callback");
    },
    onMarkResolved: () => {
      if (selectedStudent) submitSingleAction(selectedStudent, "resolved");
    },
    onOpenLineDrawer: () => {
      if (selectedStudent && selectedStudent.packages.length) {
        const worstPkg = [...selectedStudent.packages].sort(
          (a, b) => (a.adjustedRemaining ?? 999) - (b.adjustedRemaining ?? 999),
        )[0];
        setLinePreview({
          student: selectedStudent,
          pkg: worstPkg,
          message: buildParentMessage(selectedStudent, worstPkg),
        });
      }
    },
    onComboContactNext: () => {
      if (selectedStudent && selectedStudent.packages.length) {
        comboContactNext(selectedStudent);
      }
    },
    onFocusSearch: () => {
      searchInputRef.current?.focus();
    },
    onEscape: () => {
      if (linePreview) {
        setLinePreview(null);
      } else if (showHelp) {
        setShowHelp(false);
      } else if (search) {
        setSearch("");
      } else {
        setSelectedStudentKey("");
      }
    },
  });

  // ---------------------------------------------------------------------------
  // Escape key for drawer
  // ---------------------------------------------------------------------------
  useEffect(() => {
    function handleEscape(event: KeyboardEvent) {
      if (event.key === "Escape" && linePreview) {
        setLinePreview(null);
      }
    }
    window.addEventListener("keydown", handleEscape);
    return () => window.removeEventListener("keydown", handleEscape);
  }, [linePreview]);

  // ---------------------------------------------------------------------------
  // Admin rail data
  // ---------------------------------------------------------------------------
  const adminRailItems = useMemo(() => {
    if (!data) return [];
    return [
      { key: "all", label: "All owners", icon: "\u2630" },
      ...data.adminViews
        .filter((v) => v.key !== "all")
        .map((v) => ({
          key: v.key,
          label: v.label,
          icon: v.label.charAt(0).toUpperCase(),
        })),
    ];
  }, [data]);

  // ---------------------------------------------------------------------------
  // Render
  // ---------------------------------------------------------------------------
  return (
    <main className="dashboard-page">
      {/* ---- Compact header row ---- */}
      <header className="dashboard-header">
        <div style={{ display: "flex", alignItems: "center", gap: 10 }}>
          <h1>Credit Control</h1>
          {data ? (
            <SummaryBar summary={adminScopedSummary} adminScopedQueue={adminScopedQueue} />
          ) : null}
        </div>
        <div className="header-meta">
          <button
            className="help-pill"
            onClick={() => setShowHelp((prev) => !prev)}
            title="Keyboard shortcuts"
            type="button"
          >
            <CircleHelp aria-hidden="true" size={14} />
          </button>
          {data?.inactiveStudents?.length ? (
            <button
              className="meta-chip"
              onClick={() => setShowRemoved(true)}
              title="Removed students"
              type="button"
              style={{ padding: "4px 10px", fontSize: "0.78rem", cursor: "pointer" }}
            >
              Removed {data.inactiveStudents.length}
            </button>
          ) : null}
          <button
            className="meta-chip"
            onClick={() => loadDashboard("refresh")}
            disabled={refreshing}
            title="Refresh now"
            type="button"
            style={{ padding: "4px 10px", fontSize: "0.78rem", cursor: "pointer" }}
          >
            <RefreshCw aria-hidden="true" size={12} />
            {refreshing
              ? "Refreshing\u2026"
              : data
                ? `Updated ${formatShortTimestamp(data.lastUpdatedAt)}`
                : "Loading"}
          </button>
          <span className="meta-chip" style={{ padding: "4px 10px", fontSize: "0.78rem" }}>
            {sessionUser.name}
          </span>
          <button
            className="ghost-button"
            onClick={() => {
              window.location.href = "/api/auth/signout?callbackUrl=/login";
            }}
            style={{ padding: "4px 10px", fontSize: "0.78rem" }}
            type="button"
          >
            <LogOut aria-hidden="true" size={13} />
            Sign out
          </button>
        </div>
      </header>

      {loading ? <DashboardSkeleton /> : null}
      {!loading && error ? <ErrorState message={error} onRetry={() => loadDashboard("initial")} /> : null}

      {!loading && !error && data ? (
        <div className="workspace">
          {/* ---- Left rail: admin switcher ---- */}
          <nav className="workspace-rail" aria-label="Admin filter">
            {adminRailItems.map((item) => (
              <button
                key={item.key}
                className={item.key === adminView ? "rail-btn is-active" : "rail-btn"}
                onClick={() => setAdminView(item.key)}
                title={data.adminViews.find((v) => v.key === item.key)?.label ?? item.label}
                type="button"
              >
                <span className="rail-btn-icon">{item.icon}</span>
                {item.label}
              </button>
            ))}
          </nav>

          {/* ---- Center: filters + queue + planner ---- */}
          <div className="workspace-center">
            {/* Compact merged filter bar */}
            <div className="workspace-controls">
              <div className="search-wrap" style={{ flex: "0 1 330px" }}>
                <Search aria-hidden="true" size={15} style={{ color: "var(--muted)", marginLeft: 10 }} />
                <input
                  ref={searchInputRef}
                  aria-label="Search students"
                  className="search-input"
                  onChange={(event) => setSearch(event.target.value)}
                  placeholder="Search student, parent, package"
                  style={{ padding: "6px 10px", minWidth: 0 }}
                  value={search}
                />
                {search ? (
                  <button className="icon-button" onClick={() => setSearch("")} type="button" style={{ padding: "4px 8px" }}>
                    <X aria-hidden="true" size={14} />
                  </button>
                ) : null}
              </div>
              <div className="tab-row" style={{ gap: 4 }}>
                {(["all", "notify", "watch", "ok"] as RiskFilter[]).map((filter) => (
                  <button
                    key={filter}
                    className={filter === riskFilter ? "chip is-active" : "chip"}
                    onClick={() => setRiskFilter(filter)}
                    style={{ padding: "4px 10px", fontSize: "0.78rem" }}
                    type="button"
                  >
                    {filter === "all" ? "All" : filter === "ok" ? "OK" : filter.charAt(0).toUpperCase() + filter.slice(1)}
                  </button>
                ))}
              </div>
              <span className="meta-chip" style={{ padding: "4px 10px", fontSize: "0.78rem" }}>
                {sortedQueue.length} students
              </span>
            </div>

            <BulkActionBar
              visibleSelectedRows={visibleSelectedRows}
              totalFilteredCount={sortedQueue.length}
              onBulkAction={submitBulkAction}
              onSelectAllMatching={() => {
                setSelectedKeys((current) =>
                  Array.from(new Set([...current, ...filteredQueue.map((row) => row.studentKey)])),
                );
              }}
              onDeselectAll={() => setSelectedKeys([])}
              submitting={submitting}
            />

            {/* Queue + Planner split */}
            <div className="split-layout" ref={splitContainerRef as React.RefObject<HTMLDivElement>}>
              <div className="split-left" style={{ flex: `0 0 ${splitRatio * 100}%` }}>
                <QueuePanel
                  ref={queuePanelRef}
                  sortedQueue={sortedQueue}
                  selectedStudentKey={selectedStudent?.studentKey ?? ""}
                  onSelectStudent={openStudent}
                  onToggleSelection={toggleStudentSelection}
                  selectedKeys={selectedKeys}
                  currentSort={currentSort}
                  onToggleSort={toggleSort}
                  submitting={submitting}
                  onSubmitAction={submitSingleActionByKey}
                  adminScopedSummary={adminScopedSummary}
                  onToggleAllVisible={toggleAllVisible}
                  visibleSelectedCount={visibleSelectedRows.length}
                  optimisticKeys={optimisticKeys}
                  searchTerm={deferredSearch}
                  highlightedKeys={selectedDayStudentKeys}
                />
              </div>
              <div
                className="split-divider"
                {...dividerProps}
                role="separator"
                aria-orientation="vertical"
                aria-label="Resize queue and calendar panels"
                tabIndex={0}
              />
              <div className="split-right" style={{ flex: 1 }}>
                <CalendarPanel
                  calendarView={calendarView}
                  calendarCursor={calendarCursor}
                  selectedDay={selectedDay}
                  filteredCalendarDayMap={filteredCalendarDayMap}
                  adminScopedCalendarDays={adminScopedCalendarDays}
                  selectedCalendarDate={selectedCalendarDate}
                  onSetCalendarView={handleSetCalendarView}
                  onShiftCalendar={shiftCalendar}
                  onSelectCalendarDate={selectCalendarDate}
                  onJumpToToday={jumpToToday}
                  onJumpToNextUrgent={jumpToNextUrgentDay}
                  onJumpToNextScheduled={jumpToNextScheduledDay}
                  onJumpToAdjacentActionableDay={jumpToAdjacentActionableDay}
                  onOpenStudentByIndex={openStudentByIndex}
                  searchTerm={deferredSearch}
                />
              </div>
            </div>
          </div>

          {/* ---- Right pane: student detail inspector ---- */}
          <div className="workspace-inspector">
            <StudentDetail
              student={selectedStudent}
              onSubmitAction={submitSingleAction}
              onMarkInactive={handleMarkInactive}
              onPreviewLine={setLinePreview}
              onComboContactNext={comboContactNext}
              submitting={submitting}
              actionHistory={actionHistory}
            />
          </div>
        </div>
      ) : null}

      <LinePreviewDrawer
        linePreview={linePreview}
        onClose={() => setLinePreview(null)}
        onCopy={copyLineMessage}
        onCopyAndMark={copyAndMarkContacted}
      />

      <ToastNotification
        toast={toast}
        onDismiss={() => setToast(null)}
        onUndo={() => {
          if (!toast?.undo) return;
          const { studentKey, previousStatus, kind } = toast.undo;
          setToast(null);
          if (kind === "inactive") {
            restoreInactive(studentKey);
            return;
          }
          const student = data?.students.find((s) => s.studentKey === studentKey);
          if (student) {
            submitSingleAction(student, previousStatus);
          }
        }}
      />

      {showHelp ? (
        <div className="shortcut-overlay" onClick={() => setShowHelp(false)} role="presentation">
          <div className="shortcut-card" onClick={(e) => e.stopPropagation()} role="dialog" aria-modal="true">
            <div className="panel-header">
              <h3>Keyboard Shortcuts</h3>
              <button className="icon-button" onClick={() => setShowHelp(false)} type="button">
                <X aria-hidden="true" size={14} />
              </button>
            </div>
            <div className="shortcut-list">
              {SHORTCUT_LIST.map((item) => (
                <div className="shortcut-row" key={item.key}>
                  <kbd className="shortcut-key">{item.key}</kbd>
                  <span>{item.description}</span>
                </div>
              ))}
            </div>
          </div>
        </div>
      ) : null}

      {showRemoved ? (
        <div className="shortcut-overlay" onClick={() => setShowRemoved(false)} role="presentation">
          <div
            className="shortcut-card"
            onClick={(e) => e.stopPropagation()}
            role="dialog"
            aria-modal="true"
            style={{ width: "min(460px, 92vw)" }}
          >
            <div className="panel-header">
              <h3>Removed students ({data?.inactiveStudents?.length ?? 0})</h3>
              <button className="icon-button" onClick={() => setShowRemoved(false)} type="button">
                <X aria-hidden="true" size={14} />
              </button>
            </div>
            <p className="muted" style={{ fontSize: "0.78rem", marginTop: 6 }}>
              Hidden from the worklist. They rejoin automatically on a credit top-up, or restore one now.
            </p>
            <div style={{ display: "flex", flexDirection: "column", gap: 6, marginTop: 10, maxHeight: "58vh", overflowY: "auto" }}>
              {(data?.inactiveStudents ?? []).map((removed) => (
                <div
                  key={removed.studentKey}
                  style={{ display: "flex", alignItems: "center", justifyContent: "space-between", gap: 8, padding: "6px 8px", borderRadius: 8, border: "1px solid var(--panel-border)" }}
                >
                  <div style={{ minWidth: 0 }}>
                    <div className="table-primary" style={{ fontSize: "0.85rem", whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis" }}>
                      {removed.student}
                    </div>
                    <div className="table-subtle" style={{ fontSize: "0.72rem" }}>
                      {removed.parent || "No parent"} · {removed.source === "auto-churn" ? "Auto-removed" : "Manual"} · {formatShortTimestamp(removed.markedAt)}
                    </div>
                  </div>
                  <button
                    className="ghost-button"
                    disabled={submitting}
                    onClick={() => restoreInactive(removed.studentKey)}
                    type="button"
                    style={{ padding: "4px 8px", fontSize: "0.75rem", flexShrink: 0 }}
                  >
                    Restore
                  </button>
                </div>
              ))}
              {!data?.inactiveStudents?.length ? (
                <div className="empty-inline" style={{ fontSize: "0.8rem" }}>No removed students.</div>
              ) : null}
            </div>
          </div>
        </div>
      ) : null}
    </main>
  );
}

function DashboardSkeleton() {
  return (
    <div className="workspace">
      <nav className="workspace-rail" aria-label="Loading">
        <div className="skeleton" style={{ height: 200, borderRadius: 8 }} />
      </nav>
      <div className="workspace-center">
        <div className="panel skeleton-panel" style={{ flex: 1, minHeight: 0 }} />
      </div>
      <div className="workspace-inspector">
        <div className="panel skeleton-panel" style={{ flex: 1, minHeight: 0 }} />
      </div>
    </div>
  );
}

function ErrorState({ message, onRetry }: { message: string; onRetry: () => void }) {
  return (
    <section className="panel">
      <h2>Dashboard unavailable</h2>
      <p className="muted">{message}</p>
      <button className="primary-button" onClick={onRetry} type="button" style={{ marginTop: 10 }}>
        Retry
      </button>
    </section>
  );
}
