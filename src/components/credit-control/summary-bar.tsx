import type { StudentQueueRow, SummaryPayload } from "@/types/credit-control";

export function SummaryBar({
  summary,
  adminScopedQueue,
}: {
  summary: SummaryPayload;
  adminScopedQueue: StudentQueueRow[];
}) {
  const actioned = adminScopedQueue.filter((row) => row.actionState?.isToday).length;
  const total = summary.queue.students;

  return (
    <section className="summary-grid">
      <SummaryCard
        label="Students in queue"
        value={String(summary.queue.students)}
        secondary={total > 0 ? `${actioned} of ${total} actioned today` : undefined}
        progress={total > 0 ? (actioned / total) * 100 : undefined}
      />
      <SummaryCard label="Pinned students" value={String(summary.queue.pinnedStudents)} />
      <SummaryCard label="Notify packages" value={String(summary.packages.notify)} />
      <SummaryCard
        label="Pending deduction backlog"
        value={summary.portfolio.pendingDeductionBacklog.toFixed(1)}
      />
    </section>
  );
}

export function SummaryCard({
  label,
  value,
  secondary,
  progress,
}: {
  label: string;
  value: string;
  secondary?: string;
  progress?: number;
}) {
  return (
    <article className="summary-card">
      <span className="summary-label">{label}</span>
      <strong className="summary-value">{value}</strong>
      {secondary ? <div className="summary-secondary">{secondary}</div> : null}
      {progress !== undefined ? (
        <div className="summary-progress-track">
          <div
            className="summary-progress-fill"
            style={{ width: `${Math.min(100, Math.max(0, progress))}%` }}
          />
        </div>
      ) : null}
    </article>
  );
}
