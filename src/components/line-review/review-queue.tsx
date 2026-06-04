import {
  AlertTriangle,
  CircleSlash,
  Loader2,
  MessageSquareText,
  PauseCircle,
  PlayCircle,
  Repeat2,
  Search,
} from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { cn } from "@/lib/utils";
import type { IntentType, Review, StudentLink } from "./types";
import { formatDateTime, formatPercent, issueList, studentLinkVisibilityForReview } from "./utils";
import { EmptyState, IntentBadge } from "./status-badges";

const INTENT_OPTIONS: Array<{
  value: IntentType;
  label: string;
  icon: typeof MessageSquareText;
}> = [
  { value: "all", label: "All", icon: MessageSquareText },
  { value: "new_request", label: "New", icon: Search },
  { value: "cancel_one_off", label: "Cancel", icon: CircleSlash },
  { value: "pause_until", label: "Pause", icon: PauseCircle },
  { value: "resume", label: "Resume", icon: PlayCircle },
  { value: "reschedule", label: "Reschedule", icon: Repeat2 },
  { value: "unclear_change", label: "Unclear", icon: AlertTriangle },
];

function ReviewLinkBadge(props: {
  review: Review;
  activeLinks: StudentLink[];
  isSelected: boolean;
}) {
  const visibility = studentLinkVisibilityForReview(props);
  return <Badge variant={visibility.variant}>{visibility.label}</Badge>;
}

export function ReviewQueue({
  reviews,
  selected,
  links,
  loading,
  intentFilter,
  onIntentFilterChange,
  onSelect,
  className,
}: {
  reviews: Review[];
  selected: Review | null;
  links: StudentLink[];
  loading: boolean;
  intentFilter: IntentType;
  onIntentFilterChange: (intent: IntentType) => void;
  onSelect: (id: string) => void;
  className?: string;
}) {
  return (
    <aside className={cn("flex min-h-0 flex-col border-r border-border bg-card/70", className)}>
      <div className="shrink-0 border-b border-border p-2.5">
        <div className="grid grid-cols-2 gap-1">
          {INTENT_OPTIONS.map((option) => {
            const Icon = option.icon;
            const active = intentFilter === option.value;
            return (
              <button
                key={option.value}
                type="button"
                onClick={() => onIntentFilterChange(option.value)}
                className={cn(
                  "flex h-8 items-center justify-center gap-1.5 rounded-md border px-2 text-xs font-medium transition-colors",
                  active
                    ? "border-primary/30 bg-primary/10 text-primary"
                    : "border-border bg-background text-muted-foreground hover:text-foreground",
                )}
              >
                <Icon className="size-3.5" aria-hidden="true" />
                {option.label}
              </button>
            );
          })}
        </div>
      </div>

      <div className="min-h-0 flex-1 overflow-y-auto">
        {loading ? (
          <div className="flex h-full items-center justify-center text-sm text-muted-foreground">
            <Loader2 className="mr-2 size-4 animate-spin" />
            Loading reviews
          </div>
        ) : reviews.length === 0 ? (
          <div className="p-3">
            <EmptyState
              title="Queue is clear"
              detail="No pending LINE AI reviews match this intent filter."
            />
          </div>
        ) : (
          <div className="divide-y divide-border">
            {reviews.map((review) => {
              const reviewIssues = issueList(review);
              const active = selected?.id === review.id;
              return (
                <button
                  key={review.id}
                  type="button"
                  onClick={() => onSelect(review.id)}
                  className={cn(
                    "block w-full px-3 py-2.5 text-left transition-colors hover:bg-muted/60",
                    active && "bg-primary/10 shadow-[inset_3px_0_0_hsl(var(--primary))]",
                  )}
                >
                  <div className="flex min-w-0 items-center justify-between gap-2">
                    <div className="truncate text-sm font-semibold text-foreground">
                      {review.contactDisplayName ?? review.lineUserId}
                    </div>
                    <IntentBadge intent={review.intentType} />
                  </div>
                  <div className="mt-1 line-clamp-2 text-xs leading-snug text-muted-foreground">
                    {review.classifierSummary ?? review.classifierRationale ?? "No classifier summary"}
                  </div>
                  <div className="mt-2 flex items-center justify-between gap-2 text-[11px] text-muted-foreground">
                    <span>{formatDateTime(review.createdAt)}</span>
                    <span>{formatPercent(review.classifierConfidence)}</span>
                  </div>
                  <div className="mt-2 flex flex-wrap items-center gap-1.5">
                    {reviewIssues.length > 0 ? (
                      <Badge variant="destructive">{reviewIssues.length} blockers</Badge>
                    ) : (
                      <Badge variant="outline">No blockers</Badge>
                    )}
                    <ReviewLinkBadge
                      review={review}
                      activeLinks={links}
                      isSelected={active}
                    />
                  </div>
                </button>
              );
            })}
          </div>
        )}
      </div>
    </aside>
  );
}
