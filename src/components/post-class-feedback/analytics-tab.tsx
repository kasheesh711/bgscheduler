import { AlertTriangle, Bot, Clock3, MessageSquareText, TrendingUp, Users } from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { Card } from "@/components/ui/card";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { cn } from "@/lib/utils";
import type { FeedbackTutorMetric, PostClassFeedbackPayload } from "@/types/post-class-feedback";
import { EmptyPanel, KpiCell, formatRate } from "./feedback-ui";

function percentNumber(value: number | null): number {
  if (value === null || !Number.isFinite(value)) return 0;
  return Math.abs(value) <= 1 ? value * 100 : value;
}

export function sortTutorMetrics(metrics: FeedbackTutorMetric[]): FeedbackTutorMetric[] {
  return metrics.toSorted((left, right) => {
    const compliance = percentNumber(left.adjustedComplianceRate) - percentNumber(right.adjustedComplianceRate);
    if (compliance !== 0) return compliance;
    const unresolved = right.unresolvedViolations - left.unresolvedViolations;
    if (unresolved !== 0) return unresolved;
    return left.tutorName.localeCompare(right.tutorName);
  });
}

function MiniTrend({ metric }: { metric: FeedbackTutorMetric }) {
  const values = metric.trend.map((item) => percentNumber(item.adjustedComplianceRate));
  if (values.length < 2) return <span className="text-xs text-muted-foreground">Insufficient trend</span>;
  const width = 112;
  const height = 28;
  const points = values.map((value, index) => {
    const x = (index / (values.length - 1)) * width;
    const y = height - (Math.min(100, Math.max(0, value)) / 100) * height;
    return `${x},${y}`;
  }).join(" ");
  const improving = values.at(-1)! >= values[0];
  return (
    <svg role="img" aria-label={`Adjusted compliance trend for ${metric.tutorName}`} className="h-7 w-28" viewBox={`0 0 ${width} ${height}`}>
      <line x1="0" x2={width} y1={height - 1} y2={height - 1} className="stroke-border" />
      <polyline
        points={points}
        fill="none"
        stroke={improving ? "#16a34a" : "#d97706"}
        strokeWidth="2"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
    </svg>
  );
}

function OutcomeBand({ payload }: { payload: PostClassFeedbackPayload }) {
  const { assessed, rawOnTime, late, incomplete, waived } = payload.summary;
  const denominator = Math.max(1, assessed);
  const segments = [
    { label: "Raw on-time", value: rawOnTime, color: "bg-emerald-500" },
    { label: "Late", value: late, color: "bg-amber-500" },
    { label: "Incomplete", value: incomplete, color: "bg-red-500" },
    { label: "Waived", value: waived, color: "bg-sky-500" },
  ];
  return (
    <Card className="gap-3 rounded-xl p-4">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <h3 className="font-heading text-sm font-semibold">Assessed session outcomes</h3>
          <p className="mt-1 text-xs text-muted-foreground">Source-paused and not-yet-due sessions are excluded from the denominator.</p>
        </div>
        <Badge variant="outline">{assessed.toLocaleString()} assessed</Badge>
      </div>
      <div className="flex h-3 overflow-hidden rounded-full bg-muted">
        {segments.map((segment) => (
          <div
            key={segment.label}
            className={cn("h-full", segment.color)}
            style={{ width: `${Math.max(0, (segment.value / denominator) * 100)}%` }}
            title={`${segment.label}: ${segment.value}`}
          />
        ))}
      </div>
      <div className="flex flex-wrap gap-x-5 gap-y-2">
        {segments.map((segment) => (
          <div key={segment.label} className="flex items-center gap-2 text-xs">
            <span className={cn("size-2 rounded-full", segment.color)} />
            <span className="text-muted-foreground">{segment.label}</span>
            <strong className="tabular-nums">{segment.value.toLocaleString()}</strong>
          </div>
        ))}
      </div>
    </Card>
  );
}

export function AnalyticsTab({ payload }: { payload: PostClassFeedbackPayload }) {
  const metrics = sortTutorMetrics(payload.tutorMetrics);
  const summary = payload.summary;

  return (
    <div className="space-y-3">
      <div className="grid grid-cols-2 overflow-hidden rounded-xl border bg-card shadow-sm md:grid-cols-3 xl:grid-cols-6">
        <KpiCell label="Eligible sessions" value={summary.eligible.toLocaleString()} detail={`${summary.assessed.toLocaleString()} assessed`} icon={<Users className="size-3.5" />} />
        <KpiCell label="Raw on-time" value={formatRate(summary.rawOnTimeRate)} detail={`${summary.rawOnTime.toLocaleString()} proven on time`} tone="good" icon={<Clock3 className="size-3.5" />} />
        <KpiCell label="Adjusted compliance" value={formatRate(summary.adjustedComplianceRate)} detail={`${summary.adjustedCompliant.toLocaleString()} adjusted compliant`} tone="good" icon={<TrendingUp className="size-3.5" />} />
        <KpiCell label="Mean characters" value={summary.meanCharacters === null ? "—" : Math.round(summary.meanCharacters).toLocaleString()} detail={`Median ${summary.medianCharacters === null ? "—" : Math.round(summary.medianCharacters).toLocaleString()}`} icon={<MessageSquareText className="size-3.5" />} />
        <KpiCell label="Open violations" value={summary.openViolations.toLocaleString()} detail={`${summary.waived.toLocaleString()} waived`} tone={summary.openViolations > 0 ? "danger" : "good"} icon={<AlertTriangle className="size-3.5" />} />
        <KpiCell label="Confirmed AI concerns" value={summary.confirmedAiConcerns.toLocaleString()} detail="Advisory only" tone={summary.confirmedAiConcerns > 0 ? "warning" : "default"} icon={<Bot className="size-3.5" />} />
      </div>

      <OutcomeBand payload={payload} />

      <Card className="gap-0 rounded-xl py-0 shadow-sm">
        <div className="border-b px-4 py-3">
          <h3 className="font-heading text-sm font-semibold">Tutor compliance scorecards</h3>
          <p className="mt-1 text-xs text-muted-foreground">Lowest adjusted compliance first, then unresolved violations.</p>
        </div>
        {metrics.length === 0 ? (
          <EmptyPanel title="No tutor metrics yet" detail="Tutor scorecards appear after the first shadow sync produces eligible sessions." />
        ) : (
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead className="pl-4">Tutor</TableHead>
                <TableHead>Eligible</TableHead>
                <TableHead>Raw on-time</TableHead>
                <TableHead>Adjusted</TableHead>
                <TableHead>Open violations</TableHead>
                <TableHead>Mean characters</TableHead>
                <TableHead>AI concerns</TableHead>
                <TableHead className="pr-4">Trend</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {metrics.map((metric) => (
                <TableRow key={metric.tutorKey}>
                  <TableCell className="pl-4">
                    <div className="font-medium">{metric.tutorName}</div>
                    <div className="text-[11px] text-muted-foreground">{metric.tutorKey}</div>
                  </TableCell>
                  <TableCell className="tabular-nums">{metric.eligible}</TableCell>
                  <TableCell className="tabular-nums">{formatRate(metric.rawOnTimeRate)}</TableCell>
                  <TableCell>
                    <span className={cn(
                      "font-semibold tabular-nums",
                      percentNumber(metric.adjustedComplianceRate) < 80 ? "text-red-700" : "text-emerald-700",
                    )}>
                      {formatRate(metric.adjustedComplianceRate)}
                    </span>
                  </TableCell>
                  <TableCell>
                    <Badge variant={metric.unresolvedViolations > 0 ? "destructive" : "outline"}>{metric.unresolvedViolations}</Badge>
                  </TableCell>
                  <TableCell className="tabular-nums">{metric.meanCharacters === null ? "—" : Math.round(metric.meanCharacters).toLocaleString()}</TableCell>
                  <TableCell className="tabular-nums">{metric.confirmedAiConcerns}</TableCell>
                  <TableCell className="pr-4"><MiniTrend metric={metric} /></TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        )}
      </Card>
    </div>
  );
}
