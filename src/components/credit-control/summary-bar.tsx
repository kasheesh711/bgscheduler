import { Bell, Clock3, Pin, Users } from "lucide-react";
import type { ReactNode } from "react";
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
        icon={<Users aria-hidden="true" />}
        label="Students in queue"
        value={String(summary.queue.students)}
        secondary={total > 0 ? `${actioned} of ${total} actioned today` : undefined}
        progress={total > 0 ? (actioned / total) * 100 : undefined}
      />
      <SummaryCard icon={<Pin aria-hidden="true" />} label="Pinned students" value={String(summary.queue.pinnedStudents)} />
      <SummaryCard icon={<Bell aria-hidden="true" />} label="Notify packages" value={String(summary.packages.notify)} />
      <SummaryCard
        icon={<Clock3 aria-hidden="true" />}
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
  icon,
}: {
  label: string;
  value: string;
  secondary?: string;
  progress?: number;
  icon?: ReactNode;
}) {
  return (
    <article className="summary-card">
      {icon ? <span className="summary-icon">{icon}</span> : null}
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
