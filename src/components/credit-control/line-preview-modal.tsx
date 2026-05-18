import type { LinePreview } from "@/lib/credit-control/ui-helpers";

export function LinePreviewDrawer({
  linePreview,
  onClose,
  onCopy,
  onCopyAndMark,
}: {
  linePreview: LinePreview;
  onClose: () => void;
  onCopy: () => void;
  onCopyAndMark: () => void;
}) {
  if (!linePreview) return null;

  return (
    <>
      <div
        className="drawer-backdrop"
        onClick={onClose}
        role="presentation"
      />
      <aside
        className="line-drawer"
        role="dialog"
        aria-modal="true"
        aria-label="LINE message preview"
      >
        <div className="panel-header">
          <div>
            <div className="panel-title">LINE Message Preview</div>
            <h3>{linePreview.pkg.name}</h3>
          </div>
          <button className="icon-button" onClick={onClose} type="button">
            ×
          </button>
        </div>
        <div className="drawer-context">
          <div className="table-subtle">Student: {linePreview.student.student}</div>
          <div className="table-subtle">Parent: {linePreview.student.parent}</div>
          <div className="table-subtle">
            Package: {linePreview.pkg.name} · {linePreview.pkg.adjustedRemaining.toFixed(1)} cr remaining
          </div>
        </div>
        <pre className="message-preview">{linePreview.message}</pre>
        <div className="action-row drawer-actions">
          <button onClick={onCopyAndMark} type="button">
            Copy + Mark Contacted
          </button>
          <button onClick={onCopy} type="button">
            Copy message
          </button>
          <button className="ghost-button" onClick={onClose} type="button">
            Close
          </button>
        </div>
      </aside>
    </>
  );
}
