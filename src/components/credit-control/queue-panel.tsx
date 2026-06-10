import { Check, Clock3, Phone } from "lucide-react";
import React, { forwardRef, useCallback, useEffect, useImperativeHandle, useRef, useState } from "react";

import { formatShortTimestamp } from "@/lib/credit-control/helpers";
import {
  QUEUE_WINDOW_INITIAL,
  getNextWindowSize,
  getWindowSizeForIndex,
} from "@/lib/credit-control/queue-window";
import type { StudentActionStatus, StudentQueueRow, SummaryPayload } from "@/types/credit-control";
import type { SortField, SortState } from "@/lib/credit-control/ui-helpers";
import {
  actionStatusLabel,
  balanceTone,
  formatActionStateSummary,
  formatNumber,
  formatShortDate,
  statusLabel,
} from "@/lib/credit-control/ui-helpers";

export interface QueuePanelHandle {
  scrollToStudent: (studentKey: string) => void;
}

// Matches the credit-control.css breakpoint that swaps table for cards.
const COMPACT_LAYOUT_QUERY = "(max-width: 1024px)";

/**
 * True below the tablet breakpoint. Lets the panel mount only the layout the
 * viewport can show (card list OR table) instead of rendering both and hiding
 * one with CSS — halving the worklist DOM.
 */
function useCompactLayout(): boolean {
  // The initializer runs client-side on mount (the panel only mounts after the
  // dashboard payload loads, well past hydration), so it already holds the
  // current viewport; the effect only subscribes to subsequent changes.
  const [compact, setCompact] = useState(() => {
    if (typeof window === "undefined" || typeof window.matchMedia !== "function") return false;
    return window.matchMedia(COMPACT_LAYOUT_QUERY).matches;
  });

  useEffect(() => {
    if (typeof window.matchMedia !== "function") return;
    const mediaQuery = window.matchMedia(COMPACT_LAYOUT_QUERY);
    const onChange = (event: MediaQueryListEvent) => setCompact(event.matches);
    mediaQuery.addEventListener("change", onChange);
    return () => mediaQuery.removeEventListener("change", onChange);
  }, []);

  return compact;
}

function severityColor(status: string): string {
  return status === "notify"
    ? "var(--notify)"
    : status === "watch"
      ? "var(--watch)"
      : status === "ok"
        ? "var(--ok)"
        : "var(--nodata)";
}

interface QueuePanelProps {
  sortedQueue: StudentQueueRow[];
  selectedStudentKey: string;
  onSelectStudent: (studentKey: string) => void;
  onToggleSelection: (studentKey: string) => void;
  selectedKeySet: ReadonlySet<string>;
  currentSort: SortState;
  onToggleSort: (field: SortField) => void;
  submitting: boolean;
  onSubmitAction: (studentKey: string, status: StudentActionStatus) => void;
  adminScopedSummary: SummaryPayload;
  onToggleAllVisible: () => void;
  visibleSelectedCount: number;
  optimisticKeys?: Set<string>;
  searchTerm?: string;
  highlightedKeys?: Set<string>;
}

export const QueuePanel = React.memo(
  forwardRef<QueuePanelHandle, QueuePanelProps>(function QueuePanel(
    {
      sortedQueue,
      selectedStudentKey,
      onSelectStudent,
      onToggleSelection,
      selectedKeySet,
      currentSort,
      onToggleSort,
      submitting,
      onSubmitAction,
      adminScopedSummary,
      onToggleAllVisible,
      visibleSelectedCount,
      optimisticKeys,
      searchTerm,
      highlightedKeys,
    },
    ref,
  ) {
    const rowRefs = useRef<Map<string, HTMLElement>>(new Map());
    const [hideWorked, setHideWorked] = useState(() => {
      if (typeof window === "undefined") return false;
      return localStorage.getItem("begifted-hide-worked") === "true";
    });

    const toggleHideWorked = useCallback(() => {
      setHideWorked((prev) => {
        const next = !prev;
        try { localStorage.setItem("begifted-hide-worked", String(next)); } catch { /* quota */ }
        return next;
      });
    }, []);

    const isCompact = useCompactLayout();

    const displayQueue = hideWorked
      ? sortedQueue.filter((row) => !row.actionState)
      : sortedQueue;

    // Latest display queue for the sentinel observer and the imperative scroll
    // handle — both fire after commit, so an effect-synced mirror is never stale.
    const displayQueueRef = useRef(displayQueue);
    useEffect(() => {
      displayQueueRef.current = displayQueue;
    }, [displayQueue]);

    // Slice windowing: mount only the first `visibleCount` rows and grow when
    // the sentinel scrolls into view. The window never resets, so a 60s poll
    // cannot collapse the user's scroll position.
    const [visibleCount, setVisibleCount] = useState(QUEUE_WINDOW_INITIAL);
    const windowedQueue =
      displayQueue.length > visibleCount ? displayQueue.slice(0, visibleCount) : displayQueue;
    const hasMoreRows = windowedQueue.length < displayQueue.length;

    const handleRowRef = useCallback((key: string, el: HTMLElement | null) => {
      if (el) rowRefs.current.set(key, el);
      else rowRefs.current.delete(key);
    }, []);

    const flashRow = useCallback((studentKey: string) => {
      const el = rowRefs.current.get(studentKey) ?? rowRefs.current.get(`card-${studentKey}`);
      if (!el) return false;
      el.scrollIntoView({ behavior: "smooth", block: "nearest" });
      el.classList.add("row-flash");
      const onEnd = () => {
        el.classList.remove("row-flash");
        el.removeEventListener("animationend", onEnd);
      };
      el.addEventListener("animationend", onEnd);
      return true;
    }, []);

    const pendingScrollKeyRef = useRef<string | null>(null);

    useImperativeHandle(
      ref,
      () => ({
        scrollToStudent(studentKey: string) {
          if (flashRow(studentKey)) return;
          // Row not mounted yet — grow the window past its index, then scroll
          // after the next commit (see the pending-scroll effect below).
          const index = displayQueueRef.current.findIndex((row) => row.studentKey === studentKey);
          if (index === -1) return;
          pendingScrollKeyRef.current = studentKey;
          setVisibleCount((current) => getWindowSizeForIndex(index, current));
        },
      }),
      [flashRow],
    );

    useEffect(() => {
      const pendingKey = pendingScrollKeyRef.current;
      if (!pendingKey) return;
      pendingScrollKeyRef.current = null;
      flashRow(pendingKey);
    });

    // "Load more" sentinel — grows the window when it becomes visible inside
    // the scroll container. Callback ref so layout swaps re-observe cleanly.
    const observerRef = useRef<IntersectionObserver | null>(null);
    const sentinelRef = useCallback((node: HTMLElement | null) => {
      observerRef.current?.disconnect();
      observerRef.current = null;
      if (!node) return;
      if (typeof IntersectionObserver === "undefined") {
        // No observer support: fall back to mounting the full list.
        setVisibleCount(Number.MAX_SAFE_INTEGER);
        return;
      }
      const observer = new IntersectionObserver((entries) => {
        if (entries.some((entry) => entry.isIntersecting)) {
          setVisibleCount((current) => getNextWindowSize(current, displayQueueRef.current.length));
        }
      });
      observer.observe(node);
      observerRef.current = observer;
    }, []);

    const emptyState = (
      <div className="empty-state empty-state-styled">
        <div className="empty-state-pattern" />
        <div className="empty-state-title">All clear — no students need action</div>
        <div className="empty-state-hint">Try changing your admin tab or risk filter to see more students.</div>
      </div>
    );

    return (
      <section className="panel queue-panel">
        <div className="panel-header" style={{ padding: "4px 0", gap: 6 }}>
          <div style={{ display: "flex", alignItems: "center", gap: 6 }}>
            <h2 style={{ fontSize: "0.9rem" }}>{displayQueue.length} students</h2>
            <span className="mini-pill" style={{ padding: "2px 6px", fontSize: "0.72rem" }}>{adminScopedSummary.queue.pinnedStudents} pinned</span>
          </div>
          <label style={{ display: "flex", alignItems: "center", gap: 4, fontSize: "0.72rem", color: "var(--muted)", cursor: "pointer" }}>
            <input type="checkbox" checked={hideWorked} onChange={toggleHideWorked} />
            Hide worked
          </label>
        </div>

        {isCompact ? (
          /* Tablet card layout (below 1024px) */
          <div className="queue-card-list">
            {displayQueue.length ? (
              <>
                {windowedQueue.map((row) => (
                  <QueueCard
                    key={row.studentKey}
                    row={row}
                    isActive={row.studentKey === selectedStudentKey}
                    isChecked={selectedKeySet.has(row.studentKey)}
                    isOptimistic={optimisticKeys?.has(row.studentKey) ?? false}
                    submitting={submitting}
                    searchTerm={searchTerm}
                    onSelectStudent={onSelectStudent}
                    onToggleSelection={onToggleSelection}
                    onSubmitAction={onSubmitAction}
                    onRowRef={handleRowRef}
                  />
                ))}
                {hasMoreRows ? (
                  <div className="queue-sentinel" ref={sentinelRef}>
                    Loading more…
                  </div>
                ) : null}
              </>
            ) : (
              emptyState
            )}
          </div>
        ) : (
          /* Desktop table layout */
          <div className="queue-table-wrap">
            {displayQueue.length ? (
              <table className="queue-table">
                <thead>
                  <tr>
                    <th style={{ width: 4, padding: 0 }} />
                    <th className="select-col">
                      <input
                        aria-label="Select all visible students"
                        checked={displayQueue.length > 0 && visibleSelectedCount === displayQueue.length}
                        onChange={onToggleAllVisible}
                        type="checkbox"
                      />
                    </th>
                    <SortableHeader currentSort={currentSort} field="student" label="Student" onSort={onToggleSort} />
                    <SortableHeader currentSort={currentSort} field="totalAdjustedRemaining" label="Actual" onSort={onToggleSort} />
                    <SortableHeader currentSort={currentSort} field="nextSessionDate" label="Next" onSort={onToggleSort} />
                    <th>Action</th>
                  </tr>
                </thead>
                <tbody>
                  {windowedQueue.map((row) => (
                    <QueueTableRow
                      key={row.studentKey}
                      row={row}
                      isActive={row.studentKey === selectedStudentKey}
                      isChecked={selectedKeySet.has(row.studentKey)}
                      isOptimistic={optimisticKeys?.has(row.studentKey) ?? false}
                      isDayHighlighted={highlightedKeys?.has(row.studentKey) ?? false}
                      submitting={submitting}
                      searchTerm={searchTerm}
                      onSelectStudent={onSelectStudent}
                      onToggleSelection={onToggleSelection}
                      onSubmitAction={onSubmitAction}
                      onRowRef={handleRowRef}
                    />
                  ))}
                  {hasMoreRows ? (
                    <tr className="queue-sentinel-row">
                      <td className="queue-sentinel" colSpan={6} ref={sentinelRef}>
                        Loading more…
                      </td>
                    </tr>
                  ) : null}
                </tbody>
              </table>
            ) : (
              emptyState
            )}
          </div>
        )}
      </section>
    );
  }),
);

interface QueueRowProps {
  row: StudentQueueRow;
  isActive: boolean;
  isChecked: boolean;
  isOptimistic: boolean;
  submitting: boolean;
  searchTerm?: string;
  onSelectStudent: (studentKey: string) => void;
  onToggleSelection: (studentKey: string) => void;
  onSubmitAction: (studentKey: string, status: StudentActionStatus) => void;
  onRowRef: (key: string, el: HTMLElement | null) => void;
}

/** Tablet card row. Memoized so per-row state flips don't re-render the list. */
const QueueCard = React.memo(function QueueCard({
  row,
  isActive,
  isChecked,
  isOptimistic,
  submitting,
  searchTerm,
  onSelectStudent,
  onToggleSelection,
  onSubmitAction,
  onRowRef,
}: QueueRowProps) {
  return (
    <div
      className={[
        "queue-card",
        isActive ? "is-active" : "",
        isOptimistic ? "row-optimistic" : "",
      ].filter(Boolean).join(" ")}
      onClick={() => onSelectStudent(row.studentKey)}
      ref={(el) => onRowRef(`card-${row.studentKey}`, el)}
    >
      <div className="queue-card-top">
        <div>
          <div className="queue-card-name">
            <HighlightText text={row.student} term={searchTerm} />
          </div>
          <div className="queue-card-parent">
            <HighlightText text={row.parent} term={searchTerm} />
          </div>
        </div>
        <span className={`status-pill tone-${row.worstStatus}`}>
          {statusLabel(row.worstStatus)}
        </span>
      </div>
      <div className="queue-card-meta">
        <span className={balanceTone(row.totalAdjustedRemaining)}>
          {formatNumber(row.totalAdjustedRemaining)} cr actual
        </span>
        <span className="table-subtle">
          {row.nextSessionDate ? formatShortDate(row.nextSessionDate) : "No session"}
        </span>
      </div>
      <div className="queue-card-bottom">
        <label className="queue-card-checkbox" onClick={(e) => e.stopPropagation()}>
          <input
            aria-label={`Select ${row.student}`}
            checked={isChecked}
            onChange={() => onToggleSelection(row.studentKey)}
            type="checkbox"
          />
        </label>
        {row.actionState ? (
          <span
            className={`status-pill tone-action-${row.actionState.status}`}
            title={formatActionStateSummary(row.actionState)}
            style={{ padding: "2px 6px", fontSize: "0.72rem" }}
          >
            {actionStatusLabel(row.actionState.status)} {formatShortTimestamp(row.actionState.updatedAt)}
          </span>
        ) : null}
        <div className="quick-action-icons" style={{ display: "flex" }} onClick={(e) => e.stopPropagation()}>
          <button
            aria-label={`Mark ${row.student} contacted`}
            className="quick-action-btn"
            disabled={submitting}
            onClick={() => onSubmitAction(row.studentKey, "contacted")}
            title="Contacted"
            type="button"
          >
            <Phone aria-hidden="true" />
          </button>
          <button
            aria-label={`Mark ${row.student} pending callback`}
            className="quick-action-btn"
            disabled={submitting}
            onClick={() => onSubmitAction(row.studentKey, "pending-callback")}
            title="Pending callback"
            type="button"
          >
            <Clock3 aria-hidden="true" />
          </button>
          <button
            aria-label={`Mark ${row.student} resolved`}
            className="quick-action-btn"
            disabled={submitting}
            onClick={() => onSubmitAction(row.studentKey, "resolved")}
            title="Resolved"
            type="button"
          >
            <Check aria-hidden="true" />
          </button>
        </div>
      </div>
    </div>
  );
});

/** Desktop table row. Memoized so per-row state flips don't re-render the list. */
const QueueTableRow = React.memo(function QueueTableRow({
  row,
  isActive,
  isChecked,
  isOptimistic,
  isDayHighlighted,
  submitting,
  searchTerm,
  onSelectStudent,
  onToggleSelection,
  onSubmitAction,
  onRowRef,
}: QueueRowProps & { isDayHighlighted: boolean }) {
  return (
    <tr
      className={[
        isActive ? "is-active" : "",
        isOptimistic ? "row-optimistic" : "",
        isDayHighlighted ? "row-day-highlight" : "",
      ].filter(Boolean).join(" ")}
      onClick={() => onSelectStudent(row.studentKey)}
      ref={(el) => onRowRef(row.studentKey, el)}
    >
      {/* Severity bar */}
      <td style={{ width: 4, padding: 0, position: "relative" }}>
        <div style={{ position: "absolute", left: 0, top: 0, bottom: 0, width: 4, borderRadius: "4px 0 0 4px", background: severityColor(row.worstStatus) }} />
      </td>
      <td className="select-col" onClick={(event) => event.stopPropagation()}>
        <input
          aria-label={`Select ${row.student}`}
          checked={isChecked}
          onChange={() => onToggleSelection(row.studentKey)}
          type="checkbox"
        />
      </td>
      <td>
        <div className="table-primary" style={{ fontSize: "0.88rem" }}>
          <HighlightText text={row.student} term={searchTerm} />
        </div>
        <div className="table-subtle" style={{ fontSize: "0.75rem", marginTop: 1 }}>
          <HighlightText text={row.parent} term={searchTerm} />
          {" · "}
          <HighlightText text={row.packageNames.join(", ")} term={searchTerm} />
          {row.nextSessionDate ? ` · ${formatShortDate(row.nextSessionDate)}` : ""}
        </div>
      </td>
      <td style={{ whiteSpace: "nowrap" }}>
        <div className={`table-primary ${balanceTone(row.totalAdjustedRemaining)}`} style={{ fontSize: "1.1rem", fontWeight: 800 }}>
          {formatNumber(row.totalAdjustedRemaining)} cr
        </div>
        <div className="table-subtle" style={{ fontSize: "0.72rem" }}>
          {formatNumber(row.totalPendingDeduction)} pending
        </div>
      </td>
      <td style={{ whiteSpace: "nowrap" }}>
        <div className="table-primary" style={{ fontSize: "0.82rem" }}>
          {row.nextSessionDate ? formatShortDate(row.nextSessionDate) : "-"}
        </div>
      </td>
      <td>
        {row.actionState ? (
          <div>
            <span className={`status-pill tone-action-${row.actionState.status}`} style={{ padding: "2px 6px", fontSize: "0.72rem" }}>
              {actionStatusLabel(row.actionState.status)}
            </span>
            <div className="table-subtle" style={{ fontSize: "0.72rem", marginTop: 2 }}>
              {formatShortTimestamp(row.actionState.updatedAt)}
            </div>
          </div>
        ) : null}
        <div className="quick-action-icons" onClick={(e) => e.stopPropagation()}>
          <button
            aria-label={`Mark ${row.student} contacted`}
            className="quick-action-btn"
            disabled={submitting}
            onClick={() => onSubmitAction(row.studentKey, "contacted")}
            title="Contacted (c)"
            type="button"
          >
            <Phone aria-hidden="true" />
          </button>
          <button
            aria-label={`Mark ${row.student} pending callback`}
            className="quick-action-btn"
            disabled={submitting}
            onClick={() => onSubmitAction(row.studentKey, "pending-callback")}
            title="Pending (p)"
            type="button"
          >
            <Clock3 aria-hidden="true" />
          </button>
          <button
            aria-label={`Mark ${row.student} resolved`}
            className="quick-action-btn"
            disabled={submitting}
            onClick={() => onSubmitAction(row.studentKey, "resolved")}
            title="Resolved (r)"
            type="button"
          >
            <Check aria-hidden="true" />
          </button>
        </div>
      </td>
    </tr>
  );
});

function SortableHeader({
  field,
  label,
  currentSort,
  onSort,
}: {
  field: SortField;
  label: string;
  currentSort: SortState;
  onSort: (field: SortField) => void;
}) {
  const isActive = currentSort.field === field;
  const arrow = !isActive ? "↕" : currentSort.dir === "asc" ? "↑" : "↓";

  return (
    <th className="sortable" onClick={() => onSort(field)}>
      <span className="sort-label">
        {label} <span>{arrow}</span>
      </span>
    </th>
  );
}

export function HighlightText({ text, term }: { text: string; term?: string }) {
  if (!term || !text) return <>{text}</>;
  const lowerText = text.toLowerCase();
  const lowerTerm = term.toLowerCase();
  const index = lowerText.indexOf(lowerTerm);
  if (index === -1) return <>{text}</>;

  return (
    <>
      {text.slice(0, index)}
      <mark className="search-highlight">{text.slice(index, index + term.length)}</mark>
      {text.slice(index + term.length)}
    </>
  );
}
