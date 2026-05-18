import React, { useMemo, useState } from "react";

import type { PackageRecord, StudentActionStatus, StudentRecord } from "@/types/credit-control";
import type { LinePreview } from "@/lib/credit-control/ui-helpers";
import {
  actionStatusLabel,
  buildParentMessage,
  clampPercentage,
  compareNullableDates,
  flagLabel,
  formatActionStateSummary,
  formatLongDate,
  formatNumber,
  formatShortDate,
  statusLabel,
  worstStatus,
} from "@/lib/credit-control/ui-helpers";

export interface ActionHistoryEntry {
  status: string | null;
  updatedAt: string;
  updatedByName: string;
  actionType: "set" | "clear" | "bulk-set" | "bulk-clear";
}

export const StudentDetail = React.memo(function StudentDetail({
  student,
  onSubmitAction,
  onMarkInactive,
  onPreviewLine,
  onComboContactNext,
  submitting,
  actionHistory,
}: {
  student: StudentRecord | null;
  onSubmitAction: (student: StudentRecord, status: StudentActionStatus | null) => void;
  onMarkInactive: (student: StudentRecord) => void;
  onPreviewLine: (preview: LinePreview) => void;
  onComboContactNext: (student: StudentRecord) => void;
  submitting: boolean;
  actionHistory: ActionHistoryEntry[];
}) {
  // Package tab: default to highest-risk package
  const defaultPkgKey = useMemo(() => {
    if (!student || !student.packages.length) return "";
    const sorted = [...student.packages].sort(
      (a, b) => (a.adjustedRemaining ?? 999) - (b.adjustedRemaining ?? 999),
    );
    return sorted[0].key;
  }, [student]);

  const [activePkgKey, setActivePkgKey] = useState(defaultPkgKey);
  // Reset tab when student changes
  const effectiveKey = student?.packages.some((p) => p.key === activePkgKey) ? activePkgKey : defaultPkgKey;
  const activePkg = student?.packages.find((p) => p.key === effectiveKey) ?? student?.packages[0] ?? null;

  // Collapsible sections
  const [showActivity, setShowActivity] = useState(false);
  const [showUpcoming, setShowUpcoming] = useState(false);

  if (!student) {
    return (
      <section className="detail-stack">
        <section className="panel">
          <div className="empty-state empty-state-styled" style={{ padding: "24px 16px" }}>
            <div className="empty-state-pattern" />
            <div className="empty-state-title" style={{ fontSize: "0.88rem" }}>No student selected</div>
            <div className="empty-state-hint" style={{ fontSize: "0.78rem" }}>
              Press <kbd className="shortcut-key">j</kbd>/<kbd className="shortcut-key">k</kbd> to navigate
            </div>
          </div>
        </section>
      </section>
    );
  }

  return (
    <section className="detail-stack">
      {/* ---- Sticky student header ---- */}
      <section className="panel" style={{ position: "sticky", top: 0, zIndex: 5, padding: "8px 10px" }}>
        <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", gap: 8 }}>
          <div style={{ minWidth: 0 }}>
            <h2 style={{ fontSize: "1rem", whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis" }}>{student.student}</h2>
            <div className="muted" style={{ fontSize: "0.75rem" }}>
              {student.parent || "No parent"} · {student.adminOwnerName || "Unassigned"}
            </div>
          </div>
          <div className="mini-pills" style={{ gap: 4, flexShrink: 0 }}>
            <span className={`status-pill tone-${worstStatus(student.packages)}`} style={{ padding: "2px 8px", fontSize: "0.72rem" }}>
              {statusLabel(worstStatus(student.packages))}
            </span>
          </div>
        </div>

        {/* Action state + action buttons */}
        <div style={{ marginTop: 6, fontSize: "0.78rem" }}>
          {student.actionState ? (
            <span>
              <span className={`status-pill tone-action-${student.actionState.status}`} style={{ padding: "2px 6px", fontSize: "0.7rem" }}>
                {actionStatusLabel(student.actionState.status)}
              </span>
              {" "}<span className="muted">{formatActionStateSummary(student.actionState)}</span>
            </span>
          ) : (
            <span className="muted">No active follow-up status</span>
          )}
        </div>

        {/* Sticky action row */}
        <div className="action-row" style={{ marginTop: 6, gap: 4, flexWrap: "wrap" }}>
          {student.packages.length > 0 && (
            <button
              className="combo-cta"
              disabled={submitting}
              onClick={() => onComboContactNext(student)}
              title="Copy LINE + mark contacted + next (Shift+L)"
              type="button"
              style={{ padding: "4px 10px", fontSize: "0.78rem" }}
            >
              Contact via LINE
            </button>
          )}
          <button disabled={submitting} onClick={() => onSubmitAction(student, "contacted")} type="button" style={{ padding: "4px 8px", fontSize: "0.75rem" }}>
            Contacted <kbd style={{ fontSize: "0.65rem", opacity: 0.6 }}>c</kbd>
          </button>
          <button disabled={submitting} onClick={() => onSubmitAction(student, "pending-callback")} type="button" style={{ padding: "4px 8px", fontSize: "0.75rem" }}>
            Pending <kbd style={{ fontSize: "0.65rem", opacity: 0.6 }}>p</kbd>
          </button>
          <button disabled={submitting} onClick={() => onSubmitAction(student, "resolved")} type="button" style={{ padding: "4px 8px", fontSize: "0.75rem" }}>
            Resolved <kbd style={{ fontSize: "0.65rem", opacity: 0.6 }}>r</kbd>
          </button>
          <button
            className="ghost-button"
            disabled={submitting}
            onClick={() => {
              if (window.confirm(`Clear action state for ${student.student}?`)) {
                onSubmitAction(student, null);
              }
            }}
            type="button"
            style={{ padding: "4px 8px", fontSize: "0.75rem" }}
          >
            Clear
          </button>
          <span style={{ flex: 1 }} />
          <button
            className="ghost-button"
            disabled={submitting}
            onClick={() => {
              if (window.confirm(`Mark ${student.student} as no longer taking classes?\nThey will be hidden from the dashboard.`)) {
                onMarkInactive(student);
              }
            }}
            type="button"
            style={{ padding: "4px 8px", fontSize: "0.75rem", color: "var(--tone-notify, #c44)" }}
          >
            No Longer Active
          </button>
        </div>
      </section>

      {/* ---- Compact snapshot metrics ---- */}
      <div style={{ display: "flex", gap: 6, flexWrap: "wrap", padding: "0 2px" }}>
        <div className="mini-pill" style={{ padding: "3px 8px", fontSize: "0.72rem" }}>
          {student.packages.filter((p) => p.status === "notify" || p.status === "watch").length} risky
        </div>
        <div className="mini-pill" style={{ padding: "3px 8px", fontSize: "0.72rem" }}>
          {formatNumber(student.packages.reduce((s, p) => s + p.pendingDeduction, 0))} pending
        </div>
        <div className="mini-pill" style={{ padding: "3px 8px", fontSize: "0.72rem" }}>
          {student.packages.length} pkgs
        </div>
      </div>

      {/* ---- Package tabs (compact pills) ---- */}
      {student.packages.length > 1 && (
        <div style={{ display: "flex", gap: 4, flexWrap: "wrap", padding: "0 2px" }}>
          {student.packages.map((pkg) => (
            <button
              key={pkg.key}
              className={pkg.key === effectiveKey ? "chip is-active" : "chip"}
              onClick={() => setActivePkgKey(pkg.key)}
              type="button"
              style={{ padding: "3px 8px", fontSize: "0.72rem", borderRadius: 999 }}
            >
              {pkg.name.length > 18 ? pkg.name.slice(0, 16) + "\u2026" : pkg.name}
              {" "}
              <span className={`status-pill tone-${pkg.status}`} style={{ padding: "1px 5px", fontSize: "0.65rem", marginLeft: 2 }}>
                {formatNumber(pkg.adjustedRemaining)} cr
              </span>
            </button>
          ))}
        </div>
      )}

      {/* ---- Active package detail ---- */}
      {activePkg && (
        <section className="panel" style={{ padding: 10 }}>
          {/* "What to do now" block */}
          <div style={{ marginBottom: 8, padding: "6px 8px", borderRadius: 8, background: "rgba(156,79,34,0.04)", border: "1px solid rgba(156,79,34,0.08)" }}>
            <div style={{ fontSize: "0.72rem", fontWeight: 700, color: "var(--accent)", marginBottom: 2 }}>What to do now</div>
            <div className="table-primary" style={{ fontSize: "0.85rem" }}>{activePkg.recommendedAction}</div>
            <div className="table-subtle" style={{ fontSize: "0.75rem" }}>{activePkg.whyNow}</div>
            <div style={{ marginTop: 4 }}>
              <button
                onClick={() =>
                  onPreviewLine({
                    student,
                    pkg: activePkg,
                    message: buildParentMessage(student, activePkg),
                  })
                }
                type="button"
                style={{ padding: "3px 8px", fontSize: "0.72rem" }}
              >
                Preview LINE message
              </button>
            </div>
          </div>

          {/* Package header */}
          <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", gap: 6, marginBottom: 6 }}>
            <h3 style={{ fontSize: "0.88rem" }}>{activePkg.name}</h3>
            <div className="mini-pills" style={{ gap: 4 }}>
              <span className={`status-pill tone-${activePkg.status}`} style={{ padding: "2px 6px", fontSize: "0.7rem" }}>{statusLabel(activePkg.status)}</span>
            </div>
          </div>

          {/* Balance snapshot */}
          <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 6, marginBottom: 6 }}>
            <MiniStat label="Actual" value={`${formatNumber(activePkg.adjustedRemaining)} cr`} />
            <MiniStat label="System" value={`${formatNumber(activePkg.currentRemaining)} cr`} />
            <MiniStat label="Pending" value={`${formatNumber(activePkg.pendingDeduction)} cr`} />
            <MiniStat label="Total" value={`${formatNumber(activePkg.totalCredits)} cr`} />
          </div>

          {/* Waterfall */}
          <div className="waterfall" style={{ gap: 6, marginBottom: 6 }}>{renderWaterfall(activePkg)}</div>

          {/* Projection */}
          <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 6, marginBottom: 6 }}>
            <MiniStat label="Below 2 cr" value={activePkg.alertDate ? formatShortDate(activePkg.alertDate) : "-"} />
            <MiniStat label="Exhausted" value={activePkg.exhaustDate ? formatShortDate(activePkg.exhaustDate) : "-"} />
            <MiniStat label="Next session" value={activePkg.nextSessionDate ? formatShortDate(activePkg.nextSessionDate) : "None"} />
            <MiniStat label="Cadence" value={activePkg.cadenceLabel} />
          </div>

          {activePkg.projection.length > 0 && (
            <div className="projection-table-wrap" style={{ marginBottom: 6 }}>
              <table className="projection-table" style={{ fontSize: "0.75rem" }}>
                <thead>
                  <tr>
                    <th>Date</th>
                    <th>Deduct</th>
                    <th>Balance</th>
                  </tr>
                </thead>
                <tbody>
                  {activePkg.projection.slice(0, 5).map((item) => (
                    <tr key={`${activePkg.key}-${item.date}`}>
                      <td className="mono">{item.date}</td>
                      <td>{formatNumber(item.deduct)} cr</td>
                      <td>{formatNumber(item.bal)} cr</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}

          {/* Data quality flags */}
          {activePkg.dataQualityFlags.length > 0 && (
            <div className="mini-pills wrap-pills" style={{ gap: 4, marginBottom: 4 }}>
              {activePkg.dataQualityFlags.map((flag) => (
                <span className="flag-pill" key={`${activePkg.key}-${flag}`} style={{ padding: "2px 6px", fontSize: "0.7rem" }}>
                  {flagLabel(flag)}
                </span>
              ))}
            </div>
          )}
        </section>
      )}

      {/* ---- Collapsible: Recent Activity ---- */}
      <section className="panel" style={{ padding: "6px 10px" }}>
        <button
          onClick={() => setShowActivity((v) => !v)}
          type="button"
          style={{ background: "none", border: "none", padding: 0, width: "100%", textAlign: "left", display: "flex", alignItems: "center", justifyContent: "space-between", cursor: "pointer" }}
        >
          <span className="panel-title" style={{ fontSize: "0.78rem" }}>Recent Activity ({actionHistory.length})</span>
          <span style={{ fontSize: "0.72rem", color: "var(--muted)" }}>{showActivity ? "−" : "+"}</span>
        </button>
        {showActivity && (
          <div className="history-timeline" style={{ marginTop: 4 }}>
            {actionHistory.length ? (
              actionHistory.map((entry, idx) => (
                <div className="history-entry" key={`${entry.updatedAt}-${idx}`} style={{ padding: "3px 0" }}>
                  <div className="history-date" style={{ fontSize: "0.72rem" }}>{formatShortDate(entry.updatedAt.slice(0, 10))}</div>
                  <div className="history-detail" style={{ fontSize: "0.78rem" }}>
                    {entry.actionType === "clear" || entry.actionType === "bulk-clear"
                      ? `Cleared by ${entry.updatedByName}`
                      : `${entry.actionType === "bulk-set" ? "Bulk " : ""}${actionStatusLabel(entry.status as StudentActionStatus)} by ${entry.updatedByName}`}
                  </div>
                </div>
              ))
            ) : (
              <div className="empty-inline" style={{ fontSize: "0.78rem" }}>No recent activity</div>
            )}
          </div>
        )}
      </section>

      {/* ---- Collapsible: Upcoming Sessions ---- */}
      <section className="panel" style={{ padding: "6px 10px" }}>
        <button
          onClick={() => setShowUpcoming((v) => !v)}
          type="button"
          style={{ background: "none", border: "none", padding: 0, width: "100%", textAlign: "left", display: "flex", alignItems: "center", justifyContent: "space-between", cursor: "pointer" }}
        >
          <span className="panel-title" style={{ fontSize: "0.78rem" }}>Upcoming Sessions</span>
          <span style={{ fontSize: "0.72rem", color: "var(--muted)" }}>{showUpcoming ? "−" : "+"}</span>
        </button>
        {showUpcoming && (
          <div className="upcoming-list" style={{ marginTop: 4 }}>
            {renderUpcomingSessions(student)}
          </div>
        )}
      </section>
    </section>
  );
});

// ---------------------------------------------------------------------------
// Internal presentational components & helpers
// ---------------------------------------------------------------------------

function MiniStat({ label, value }: { label: string; value: string }) {
  return (
    <div style={{ padding: "4px 6px", borderRadius: 6, background: "var(--panel-strong)", border: "1px solid var(--panel-border)" }}>
      <div style={{ fontSize: "0.65rem", color: "var(--muted)" }}>{label}</div>
      <div style={{ fontSize: "0.82rem", fontWeight: 700 }}>{value}</div>
    </div>
  );
}

function WaterfallRow({
  label,
  width,
  value,
  color,
}: {
  label: string;
  width: number;
  value: string;
  color: string;
}) {
  return (
    <div className="waterfall-row">
      <div className="table-subtle">{label}</div>
      <div className="waterfall-track">
        <div className="waterfall-fill" style={{ width: `${width}%`, background: color }} />
      </div>
      <div className="table-primary">{value}</div>
    </div>
  );
}

function renderWaterfall(pkg: PackageRecord) {
  const safeTotal = Math.max(1, pkg.totalCredits || 1);
  const systemPct = clampPercentage((pkg.currentRemaining / safeTotal) * 100);
  const pendingPct = clampPercentage((pkg.pendingDeduction / safeTotal) * 100);
  const actualPct = clampPercentage((pkg.adjustedRemaining / safeTotal) * 100);

  return (
    <>
      <WaterfallRow
        color="var(--accent-strong)"
        label="System balance"
        value={formatNumber(pkg.currentRemaining)}
        width={systemPct}
      />
      <WaterfallRow
        color="var(--watch)"
        label="Pending deduction"
        value={`-${formatNumber(pkg.pendingDeduction)}`}
        width={pendingPct}
      />
      <WaterfallRow
        color={
          pkg.adjustedRemaining <= 0
            ? "var(--notify)"
            : pkg.adjustedRemaining < 2
              ? "var(--notify)"
              : pkg.adjustedRemaining < 4
                ? "var(--watch)"
                : "var(--ok)"
        }
        label="Actual remaining"
        value={formatNumber(pkg.adjustedRemaining)}
        width={actualPct}
      />
    </>
  );
}

function renderUpcomingSessions(student: StudentRecord) {
  const rows = student.packages
    .flatMap((pkg) =>
      (pkg.upcomingSessions || []).map((session) => ({
        packageName: pkg.name,
        date: session.date,
        durationMin: session.durationMin,
        deduct: session.deduct,
      })),
    )
    .sort((a, b) => compareNullableDates(a.date, b.date));

  if (!rows.length) {
    return <div className="empty-state">No upcoming sessions are scheduled for this student.</div>;
  }

  return rows.slice(0, 12).map((row) => (
    <div className="upcoming-row" key={`${row.packageName}-${row.date}-${row.durationMin}`}>
      <div>
        <div className="table-primary">{row.packageName}</div>
        <div className="table-subtle">{formatLongDate(row.date)}</div>
      </div>
      <div className="action-row compact">
        <div className="table-primary">
          {row.durationMin}m / {formatNumber(row.deduct)} cr
        </div>
      </div>
    </div>
  ));
}
