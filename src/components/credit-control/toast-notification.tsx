import type { Toast } from "@/lib/credit-control/ui-helpers";

export function ToastNotification({
  toast,
  onDismiss,
  onUndo,
}: {
  toast: Toast;
  onDismiss: () => void;
  onUndo?: () => void;
}) {
  if (!toast) return null;

  return (
    <div className={`toast tone-${toast.tone}`}>
      <span>{toast.message}</span>
      {toast.undo && onUndo ? (
        <button className="toast-undo" onClick={onUndo} type="button">
          Undo
        </button>
      ) : null}
      {toast.tone === "error" ? (
        <button className="toast-close" onClick={onDismiss} type="button">
          ×
        </button>
      ) : null}
    </div>
  );
}
