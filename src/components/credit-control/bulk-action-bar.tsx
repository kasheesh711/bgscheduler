import type { StudentActionStatus } from "@/types/credit-control";

export function BulkActionBar({
  visibleSelectedRows,
  totalFilteredCount,
  onBulkAction,
  onSelectAllMatching,
  onDeselectAll,
  submitting,
}: {
  visibleSelectedRows: string[];
  totalFilteredCount: number;
  onBulkAction: (status: StudentActionStatus | null) => void;
  onSelectAllMatching: () => void;
  onDeselectAll: () => void;
  submitting: boolean;
}) {
  return (
    <section className="bulk-bar">
      <div className="bulk-bar-left">
        {visibleSelectedRows.length > 0 ? (
          <span className="selection-badge">
            {visibleSelectedRows.length} of {totalFilteredCount} selected
          </span>
        ) : null}
        <button
          className="ghost-button"
          onClick={onSelectAllMatching}
          type="button"
        >
          Select all matching
        </button>
        {visibleSelectedRows.length > 0 ? (
          <button
            className="ghost-button"
            onClick={onDeselectAll}
            type="button"
          >
            Deselect all
          </button>
        ) : null}
      </div>
      {visibleSelectedRows.length > 0 ? (
        <div className="action-row">
          <button disabled={submitting} onClick={() => onBulkAction("contacted")} type="button">
            Contacted
          </button>
          <button
            disabled={submitting}
            onClick={() => onBulkAction("pending-callback")}
            type="button"
          >
            Pending callback
          </button>
          <button disabled={submitting} onClick={() => onBulkAction("resolved")} type="button">
            Resolved
          </button>
          <button
            className="ghost-button"
            disabled={submitting}
            onClick={() => {
              if (window.confirm(`Clear action state for ${visibleSelectedRows.length} student${visibleSelectedRows.length === 1 ? "" : "s"}?`)) {
                onBulkAction(null);
              }
            }}
            type="button"
          >
            Clear
          </button>
        </div>
      ) : null}
    </section>
  );
}
