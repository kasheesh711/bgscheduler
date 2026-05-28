"use client";

import { useEffect, useState } from "react";

interface OutcomeCounts {
  accept: number;
  edit: number;
  reject: number;
  dismiss: number;
  total: number;
}

interface ConfidenceRow extends OutcomeCounts {
  band: string;
}

interface CorrectionTelemetry {
  totalActions: number;
  acceptRate: number;
  editRate: number;
  rejectRate: number;
  dismissRate: number;
  avgTimeToReviewMs: number | null;
  p50TimeToReviewMs: number | null;
  confidenceByOutcome: ConfidenceRow[];
}

function pct(value: number): string {
  return `${Math.round(value * 100)}%`;
}

function formatDuration(ms: number | null): string {
  if (ms == null) return "—";
  const minutes = ms / 60000;
  if (minutes < 1) return `${Math.round(ms / 1000)}s`;
  if (minutes < 60) return `${Math.round(minutes)}m`;
  return `${(minutes / 60).toFixed(1)}h`;
}

function MetricCard({ label, value, detail }: { label: string; value: string; detail?: string }) {
  return (
    <div className="rounded-lg border border-border bg-card p-4">
      <div className="text-[11px] font-semibold uppercase tracking-wide text-muted-foreground">{label}</div>
      <div className="mt-1 text-2xl font-semibold text-foreground">{value}</div>
      {detail && <div className="mt-1 text-xs text-muted-foreground">{detail}</div>}
    </div>
  );
}

export function SchedulerMetricsView() {
  const [data, setData] = useState<CorrectionTelemetry | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    let cancelled = false;
    fetch("/api/ai-scheduler/metrics")
      .then(async (response) => {
        const payload = await response.json().catch(() => ({}));
        if (!response.ok) throw new Error(payload.error ?? `Request failed (${response.status})`);
        return payload as { correction: CorrectionTelemetry };
      })
      .then((payload) => {
        if (!cancelled) setData(payload.correction);
      })
      .catch((err) => {
        if (!cancelled) setError(err instanceof Error ? err.message : "Failed to load metrics");
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, []);

  return (
    <div className="min-h-0 flex-1 overflow-y-auto">
      <div className="mx-auto w-full max-w-4xl pb-6">
        <div className="mb-4">
          <h1 className="text-lg font-semibold text-foreground">Scheduler correction metrics</h1>
          <p className="text-sm text-muted-foreground">How admins correct AI-extracted LINE scheduling reviews.</p>
        </div>

        {loading && (
          <div className="rounded-md border border-border p-4 text-sm text-muted-foreground">Loading metrics…</div>
        )}
        {error && (
          <div className="rounded-md border border-conflict/30 bg-conflict/10 p-4 text-sm text-conflict">{error}</div>
        )}

        {data && (
          <>
            <div className="grid grid-cols-2 gap-3 sm:grid-cols-3 lg:grid-cols-6">
              <MetricCard label="Total actions" value={String(data.totalActions)} />
              <MetricCard label="Accept" value={pct(data.acceptRate)} />
              <MetricCard label="Edit" value={pct(data.editRate)} />
              <MetricCard label="Reject" value={pct(data.rejectRate)} />
              <MetricCard label="Dismiss" value={pct(data.dismissRate)} />
              <MetricCard
                label="Avg time"
                value={formatDuration(data.avgTimeToReviewMs)}
                detail={`p50 ${formatDuration(data.p50TimeToReviewMs)}`}
              />
            </div>

            <div className="mt-6">
              <h2 className="mb-2 text-sm font-semibold text-foreground">Confidence vs. outcome</h2>
              {data.confidenceByOutcome.length === 0 ? (
                <div className="rounded-md border border-border p-4 text-sm text-muted-foreground">No correction data yet.</div>
              ) : (
                <div className="overflow-x-auto rounded-lg border border-border">
                  <table className="w-full text-sm">
                    <thead className="bg-muted/50 text-left text-xs uppercase tracking-wide text-muted-foreground">
                      <tr>
                        <th className="px-3 py-2">AI confidence</th>
                        <th className="px-3 py-2 text-right">Accept</th>
                        <th className="px-3 py-2 text-right">Edit</th>
                        <th className="px-3 py-2 text-right">Reject</th>
                        <th className="px-3 py-2 text-right">Dismiss</th>
                        <th className="px-3 py-2 text-right">Total</th>
                      </tr>
                    </thead>
                    <tbody>
                      {data.confidenceByOutcome.map((row) => (
                        <tr key={row.band} className="border-t border-border">
                          <td className="px-3 py-2 capitalize text-foreground">{row.band}</td>
                          <td className="px-3 py-2 text-right">{row.accept}</td>
                          <td className="px-3 py-2 text-right">{row.edit}</td>
                          <td className="px-3 py-2 text-right">{row.reject}</td>
                          <td className="px-3 py-2 text-right">{row.dismiss}</td>
                          <td className="px-3 py-2 text-right font-medium">{row.total}</td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              )}
            </div>
          </>
        )}
      </div>
    </div>
  );
}
