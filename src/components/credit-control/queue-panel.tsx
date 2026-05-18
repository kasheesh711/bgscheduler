import React, { forwardRef, useImperativeHandle, useRef, useState, useCallback } from "react";

import { formatShortTimestamp } from "@/lib/credit-control/helpers";
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

export const QueuePanel = React.memo(
  forwardRef<
    QueuePanelHandle,
    {
      sortedQueue: StudentQueueRow[];
      selectedStudentKey: string;
      onSelectStudent: (studentKey: string) => void;
      onToggleSelection: (studentKey: string) => void;
      selectedKeys: string[];
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
  >(function QueuePanel(
    {
      sortedQueue,
      selectedStudentKey,
      onSelectStudent,
      onToggleSelection,
      selectedKeys,
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

    const displayQueue = hideWorked
      ? sortedQueue.filter((row) => !row.actionState)
      : sortedQueue;

    useImperativeHandle(ref, () => ({
      scrollToStudent(studentKey: string) {
        const el = rowRefs.current.get(studentKey);
        if (el) {
          el.scrollIntoView({ behavior: "smooth", block: "nearest" });
          el.classList.add("row-flash");
          const onEnd = () => {
            el.classList.remove("row-flash");
            el.removeEventListener("animationend", onEnd);
          };
          el.addEventListener("animationend", onEnd);
        }
      },
    }));

    const severityColor = (status: string) =>
      status === "notify" ? "var(--notify)" : status === "watch" ? "var(--watch)" : status === "ok" ? "var(--ok)" : "var(--nodata)";

    return (
      <section className="panel queue-panel">
        <div className="panel-header" style={{ padding: "4px 0", gap: 6 }}>
          <div style={{ display: "flex", alignItems: "center", gap: 6 }}>
            <h2 style={{ fontSize: "0.9rem" }}>{displayQueue.length} students</h2>
            <span className="mini-pill" style={{ padding: "2px 6px", fontSize: "0.7rem" }}>{adminScopedSummary.queue.pinnedStudents} pinned</span>
          </div>
          <label style={{ display: "flex", alignItems: "center", gap: 4, fontSize: "0.72rem", color: "var(--muted)", cursor: "pointer" }}>
            <input type="checkbox" checked={hideWorked} onChange={toggleHideWorked} />
            Hide worked
          </label>
        </div>

        {/* Tablet card layout (below 1024px) */}
        <div className="queue-card-list">
          {displayQueue.length ? (
            displayQueue.map((row) => {
              const checked = selectedKeys.includes(row.studentKey);
              return (
                <div
                  className={[
                    "queue-card",
                    row.studentKey === selectedStudentKey ? "is-active" : "",
                    optimisticKeys?.has(row.studentKey) ? "row-optimistic" : "",
                  ].filter(Boolean).join(" ")}
                  key={row.studentKey}
                  onClick={() => onSelectStudent(row.studentKey)}
                  ref={(el) => {
                    if (el) rowRefs.current.set(`card-${row.studentKey}`, el);
                    else rowRefs.current.delete(`card-${row.studentKey}`);
                  }}
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
                        checked={checked}
                        onChange={() => onToggleSelection(row.studentKey)}
                        type="checkbox"
                      />
                    </label>
                    {row.actionState ? (
                      <span
                        className={`status-pill tone-action-${row.actionState.status}`}
                        title={formatActionStateSummary(row.actionState)}
                        style={{ padding: "2px 6px", fontSize: "0.7rem" }}
                      >
                        {actionStatusLabel(row.actionState.status)} {formatShortTimestamp(row.actionState.updatedAt)}
                      </span>
                    ) : null}
                    <div className="quick-action-icons" style={{ display: "flex" }} onClick={(e) => e.stopPropagation()}>
                      <button
                        className="quick-action-btn"
                        disabled={submitting}
                        onClick={() => onSubmitAction(row.studentKey, "contacted")}
                        title="Contacted"
                        type="button"
                      >
                        📞
                      </button>
                      <button
                        className="quick-action-btn"
                        disabled={submitting}
                        onClick={() => onSubmitAction(row.studentKey, "pending-callback")}
                        title="Pending callback"
                        type="button"
                      >
                        &#9203;
                      </button>
                      <button
                        className="quick-action-btn"
                        disabled={submitting}
                        onClick={() => onSubmitAction(row.studentKey, "resolved")}
                        title="Resolved"
                        type="button"
                      >
                        &#10004;
                      </button>
                    </div>
                  </div>
                </div>
              );
            })
          ) : (
            <div className="empty-state empty-state-styled">
              <div className="empty-state-pattern" />
              <div className="empty-state-title">All clear — no students need action</div>
              <div className="empty-state-hint">Try changing your admin tab or risk filter to see more students.</div>
            </div>
          )}
        </div>

        {/* Desktop table layout */}
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
                {displayQueue.map((row) => {
                  const checked = selectedKeys.includes(row.studentKey);
                  return (
                    <tr
                      className={[
                        row.studentKey === selectedStudentKey ? "is-active" : "",
                        optimisticKeys?.has(row.studentKey) ? "row-optimistic" : "",
                        highlightedKeys?.has(row.studentKey) ? "row-day-highlight" : "",
                      ].filter(Boolean).join(" ")}
                      key={row.studentKey}
                      onClick={() => onSelectStudent(row.studentKey)}
                      ref={(el) => {
                        if (el) rowRefs.current.set(row.studentKey, el);
                        else rowRefs.current.delete(row.studentKey);
                      }}
                    >
                      {/* Severity bar */}
                      <td style={{ width: 4, padding: 0, position: "relative" }}>
                        <div style={{ position: "absolute", left: 0, top: 0, bottom: 0, width: 4, borderRadius: "4px 0 0 4px", background: severityColor(row.worstStatus) }} />
                      </td>
                      <td className="select-col" onClick={(event) => event.stopPropagation()}>
                        <input
                          aria-label={`Select ${row.student}`}
                          checked={checked}
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
                            <span className={`status-pill tone-action-${row.actionState.status}`} style={{ padding: "2px 6px", fontSize: "0.7rem" }}>
                              {actionStatusLabel(row.actionState.status)}
                            </span>
                            <div className="table-subtle" style={{ fontSize: "0.68rem", marginTop: 2 }}>
                              {formatShortTimestamp(row.actionState.updatedAt)}
                            </div>
                          </div>
                        ) : null}
                        <div className="quick-action-icons" onClick={(e) => e.stopPropagation()}>
                          <button
                            className="quick-action-btn"
                            disabled={submitting}
                            onClick={() => onSubmitAction(row.studentKey, "contacted")}
                            title="Contacted (c)"
                            type="button"
                          >
                            📞
                          </button>
                          <button
                            className="quick-action-btn"
                            disabled={submitting}
                            onClick={() => onSubmitAction(row.studentKey, "pending-callback")}
                            title="Pending (p)"
                            type="button"
                          >
                            ⏳
                          </button>
                          <button
                            className="quick-action-btn"
                            disabled={submitting}
                            onClick={() => onSubmitAction(row.studentKey, "resolved")}
                            title="Resolved (r)"
                            type="button"
                          >
                            ✔
                          </button>
                        </div>
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          ) : (
            <div className="empty-state empty-state-styled">
              <div className="empty-state-pattern" />
              <div className="empty-state-title">All clear — no students need action</div>
              <div className="empty-state-hint">Try changing your admin tab or risk filter to see more students.</div>
            </div>
          )}
        </div>
      </section>
    );
  }),
);

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
