import type { ReactNode } from "react";
import {
  AlertCircle,
  CheckCircle2,
  CircleDashed,
  Clock3,
  PauseCircle,
} from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { Card } from "@/components/ui/card";
import { cn } from "@/lib/utils";
import type {
  FeedbackContentStatus,
  FeedbackDeductionStatus,
  FeedbackEligibilityReason,
  FeedbackSessionRow,
  FeedbackSourceStatus,
  FeedbackSubmitter,
  FeedbackTimingStatus,
} from "@/types/post-class-feedback";

const BANGKOK_TIME_ZONE = "Asia/Bangkok";

export function currentBangkokMonthRange(): { startDate: string; endDate: string } {
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone: BANGKOK_TIME_ZONE,
    year: "numeric",
    month: "2-digit",
  }).formatToParts(new Date());
  const map = new Map(parts.map((part) => [part.type, part.value]));
  const year = Number(map.get("year"));
  const month = Number(map.get("month"));
  const endDay = new Date(Date.UTC(year, month, 0)).getUTCDate();
  return {
    startDate: `${year}-${String(month).padStart(2, "0")}-01`,
    endDate: `${year}-${String(month).padStart(2, "0")}-${endDay}`,
  };
}

export function formatBangkokDate(value: string | null, withTime = false): string {
  if (!value) return "—";
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return value;
  return new Intl.DateTimeFormat("en-GB", {
    timeZone: BANGKOK_TIME_ZONE,
    day: "numeric",
    month: "short",
    year: "numeric",
    ...(withTime ? { hour: "2-digit", minute: "2-digit", hour12: false } : {}),
  }).format(date);
}

export function formatBangkokMonth(value: string | null): string {
  if (!value) return "Unassigned";
  const match = /^(\d{4})-(\d{2})$/.exec(value);
  if (!match) return value;
  return new Intl.DateTimeFormat("en-GB", {
    timeZone: BANGKOK_TIME_ZONE,
    month: "short",
    year: "numeric",
  }).format(new Date(Date.UTC(Number(match[1]), Number(match[2]) - 1, 1, 12)));
}

export function formatMoney(value: number): string {
  return new Intl.NumberFormat("en-TH", {
    style: "currency",
    currency: "THB",
    maximumFractionDigits: 0,
  }).format(value);
}

export function formatRate(value: number | null): string {
  if (value === null || !Number.isFinite(value)) return "—";
  const percent = Math.abs(value) <= 1 ? value * 100 : value;
  return `${percent.toFixed(1)}%`;
}

export function feedbackOutcome(session: Pick<
  FeedbackSessionRow,
  "sourceStatus" | "contentStatus" | "timingStatus"
> & Partial<Pick<FeedbackSessionRow, "eligible" | "eligibilityReason">>): "on_time" | "late" | "missing" | "not_due" | "timing_unknown" | "source_paused" | "excluded" {
  if (session.eligible === false) {
    return session.eligibilityReason === "billing_evidence_missing" ? "source_paused" : "excluded";
  }
  if (session.sourceStatus !== "ready") return "source_paused";
  if (session.timingStatus === "on_time") return "on_time";
  if (session.timingStatus === "unknown") return "timing_unknown";
  if (session.timingStatus === "not_due") return "not_due";
  if (session.contentStatus === "substantive") return "late";
  return "missing";
}

const OUTCOME_STYLES = {
  on_time: "border-emerald-200 bg-emerald-50 text-emerald-800 dark:border-emerald-900 dark:bg-emerald-950/50 dark:text-emerald-300",
  late: "border-amber-200 bg-amber-50 text-amber-800 dark:border-amber-900 dark:bg-amber-950/50 dark:text-amber-300",
  missing: "border-red-200 bg-red-50 text-red-800 dark:border-red-900 dark:bg-red-950/50 dark:text-red-300",
  not_due: "border-sky-200 bg-sky-50 text-sky-800 dark:border-sky-900 dark:bg-sky-950/50 dark:text-sky-300",
  timing_unknown: "border-violet-200 bg-violet-50 text-violet-800 dark:border-violet-900 dark:bg-violet-950/50 dark:text-violet-300",
  source_paused: "border-slate-200 bg-slate-50 text-slate-700 dark:border-slate-700 dark:bg-slate-900 dark:text-slate-300",
  excluded: "border-slate-200 bg-slate-100 text-slate-700 dark:border-slate-700 dark:bg-slate-900 dark:text-slate-300",
} as const;

const OUTCOME_LABELS = {
  on_time: "On time",
  late: "Late",
  missing: "Missing",
  not_due: "Not due",
  timing_unknown: "Timing unknown",
  source_paused: "Source paused",
  excluded: "Excluded",
} as const;

export function OutcomeBadge({ session }: { session: Pick<FeedbackSessionRow, "sourceStatus" | "contentStatus" | "timingStatus"> & Partial<Pick<FeedbackSessionRow, "eligible" | "eligibilityReason">> }) {
  const outcome = feedbackOutcome(session);
  return (
    <Badge variant="outline" className={OUTCOME_STYLES[outcome]}>
      {OUTCOME_LABELS[outcome]}
    </Badge>
  );
}

const ELIGIBILITY_REASON_LABELS: Record<FeedbackEligibilityReason, string> = {
  ended_positive_credits: "Ended with consumed credits",
  ended_payout_eligible: "Ended and payout-eligible",
  not_ended: "Session did not end",
  cancelled: "Cancelled session",
  missed_or_no_show: "Missed / no-show",
  excluded_session_type: "Excluded session type",
  complimentary_or_trial: "Complimentary / trial",
  non_billable: "Zero-credit, non-payable",
  billing_evidence_missing: "Billing or payout evidence needs review",
};

export function formatEligibilityReason(reason: string | null): string {
  if (!reason) return "Eligibility evidence unavailable";
  if (Object.prototype.hasOwnProperty.call(ELIGIBILITY_REASON_LABELS, reason)) {
    return ELIGIBILITY_REASON_LABELS[reason as FeedbackEligibilityReason];
  }
  return `Unknown eligibility reason: ${reason}`;
}

export function EligibilityBadge({
  eligible,
  reason,
}: {
  eligible: boolean;
  reason: FeedbackEligibilityReason | null;
}) {
  if (eligible) {
    return <Badge variant="outline" className="border-emerald-200 bg-emerald-50 text-emerald-800">Eligible</Badge>;
  }
  if (reason === "billing_evidence_missing") {
    return <Badge variant="outline" className="border-violet-200 bg-violet-50 text-violet-800">Eligibility review</Badge>;
  }
  return <Badge variant="outline" className="border-slate-200 bg-slate-100 text-slate-700">Excluded</Badge>;
}

const DEDUCTION_STYLES: Record<FeedbackDeductionStatus, string> = {
  none: "border-slate-200 bg-slate-50 text-slate-700",
  pending_review: "border-amber-200 bg-amber-50 text-amber-800",
  approved: "border-sky-200 bg-sky-50 text-sky-800",
  waived: "border-emerald-200 bg-emerald-50 text-emerald-800",
  processed: "border-violet-200 bg-violet-50 text-violet-800",
  reversed: "border-slate-300 bg-slate-100 text-slate-700",
};

export function DeductionBadge({ status }: { status: FeedbackDeductionStatus }) {
  return (
    <Badge variant="outline" className={cn("capitalize", DEDUCTION_STYLES[status])}>
      {status.replaceAll("_", " ")}
    </Badge>
  );
}

export function SourceBadge({ status }: { status: FeedbackSourceStatus }) {
  const content: Record<FeedbackSourceStatus, { label: string; className: string }> = {
    ready: { label: "Ready", className: "border-emerald-200 bg-emerald-50 text-emerald-800" },
    unavailable: { label: "Unavailable", className: "border-red-200 bg-red-50 text-red-800" },
    form_drift: { label: "Form drift", className: "border-amber-200 bg-amber-50 text-amber-800" },
    identity_review: { label: "Identity review", className: "border-violet-200 bg-violet-50 text-violet-800" },
  };
  return <Badge variant="outline" className={content[status].className}>{content[status].label}</Badge>;
}

export function TimingBadge({ status }: { status: FeedbackTimingStatus }) {
  return (
    <Badge variant="outline" className="capitalize">
      {status.replaceAll("_", " ")}
    </Badge>
  );
}

const SUBMITTER_LABELS: Record<FeedbackSubmitter, string> = {
  tutor: "Tutor",
  admin: "Admin",
  auto: "Auto",
  other: "Other",
  none: "None",
};

// Only a tutor submission reflects the tutor doing the work; admin and auto
// are surfaced in warning tones so a rescued session cannot read as compliant.
const SUBMITTER_TONES: Record<FeedbackSubmitter, string> = {
  tutor: "border-emerald-300 text-emerald-700 dark:border-emerald-700 dark:text-emerald-300",
  admin: "border-amber-300 text-amber-700 dark:border-amber-700 dark:text-amber-300",
  auto: "border-orange-300 text-orange-700 dark:border-orange-700 dark:text-orange-300",
  other: "border-slate-300 text-slate-600 dark:border-slate-600 dark:text-slate-300",
  none: "border-red-300 text-red-700 dark:border-red-700 dark:text-red-300",
};

export function SubmitterBadge({ submitter }: { submitter: FeedbackSubmitter }) {
  return (
    <Badge variant="outline" className={SUBMITTER_TONES[submitter]}>
      {SUBMITTER_LABELS[submitter]}
    </Badge>
  );
}

export function ContentBadge({ status }: { status: FeedbackContentStatus }) {
  return (
    <Badge variant="outline" className="capitalize">
      {status}
    </Badge>
  );
}

export function KpiCell({
  label,
  value,
  detail,
  tone = "default",
  icon,
}: {
  label: string;
  value: string;
  detail?: string;
  tone?: "default" | "good" | "warning" | "danger";
  icon?: ReactNode;
}) {
  const toneClass = {
    default: "text-foreground",
    good: "text-emerald-700 dark:text-emerald-400",
    warning: "text-amber-700 dark:text-amber-400",
    danger: "text-red-700 dark:text-red-400",
  }[tone];

  return (
    <div className="min-w-0 border-r px-4 py-3 last:border-r-0">
      <div className="flex items-center gap-1.5 text-[11px] font-medium text-muted-foreground">
        {icon}
        {label}
      </div>
      <div className={cn("mt-1 text-xl font-semibold tracking-tight", toneClass)}>{value}</div>
      {detail ? <div className="mt-0.5 truncate text-[11px] text-muted-foreground">{detail}</div> : null}
    </div>
  );
}

export function EmptyPanel({
  title,
  detail,
  kind = "empty",
  action,
}: {
  title: string;
  detail: string;
  kind?: "empty" | "error" | "paused";
  action?: ReactNode;
}) {
  const Icon = kind === "error" ? AlertCircle : kind === "paused" ? PauseCircle : CircleDashed;
  return (
    <div className="flex min-h-52 flex-col items-center justify-center px-6 py-10 text-center">
      <span className={cn(
        "mb-3 flex size-10 items-center justify-center rounded-full",
        kind === "error" ? "bg-red-50 text-red-600" : "bg-muted text-muted-foreground",
      )}>
        <Icon className="size-5" aria-hidden="true" />
      </span>
      <h3 className="font-medium">{title}</h3>
      <p className="mt-1 max-w-md text-sm text-muted-foreground">{detail}</p>
      {action ? <div className="mt-4">{action}</div> : null}
    </div>
  );
}

export function HealthMark({ healthy, label }: { healthy: boolean; label: string }) {
  const Icon = healthy ? CheckCircle2 : AlertCircle;
  return (
    <span className={cn("inline-flex items-center gap-1.5 text-xs", healthy ? "text-emerald-700" : "text-amber-700")}>
      <Icon className="size-4" aria-hidden="true" />
      {label}
    </span>
  );
}

export function LoadingSurface() {
  return (
    <div className="space-y-3" aria-label="Loading post-class feedback" aria-busy="true">
      <div className="grid grid-cols-2 overflow-hidden rounded-xl border bg-card md:grid-cols-3 xl:grid-cols-6">
        {Array.from({ length: 6 }, (_, index) => (
          <div className="border-r p-4 last:border-r-0" key={index}>
            <div className="h-3 w-20 animate-pulse rounded bg-muted" />
            <div className="mt-3 h-7 w-14 animate-pulse rounded bg-muted" />
          </div>
        ))}
      </div>
      <div className="grid gap-3 lg:grid-cols-[minmax(0,1.05fr)_minmax(420px,0.95fr)]">
        <Card className="h-[540px] animate-pulse bg-muted/40" />
        <Card className="h-[540px] animate-pulse bg-muted/40" />
      </div>
    </div>
  );
}

export function DeadlineIcon() {
  return <Clock3 className="size-3.5" aria-hidden="true" />;
}
