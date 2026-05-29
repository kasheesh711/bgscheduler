import { Badge } from "@/components/ui/badge";
import type { IntentType, WritebackStatus } from "./types";
import { intentLabel, STATUS_LABELS } from "./utils";

export function IntentBadge({ intent }: { intent: Exclude<IntentType, "all"> }) {
  const variant = intent === "unclear_change"
    ? "destructive"
    : intent === "new_request"
      ? "secondary"
      : "outline";
  return (
    <Badge variant={variant} className="capitalize">
      {intentLabel(intent)}
    </Badge>
  );
}

export function WritebackBadge({ status }: { status: WritebackStatus }) {
  const isReady = status === "ready" || status === "confirmed";
  const isManual = status === "manual_required" || status === "failed";
  return (
    <Badge
      variant={isManual ? "destructive" : isReady ? "default" : "outline"}
      className="whitespace-nowrap"
    >
      {STATUS_LABELS[status]}
    </Badge>
  );
}

export function StudentStateBadges({
  activated,
  hasFutureSessions,
  hasLivePackage,
}: {
  activated: boolean | null;
  hasFutureSessions: boolean | null;
  hasLivePackage: boolean | null;
}) {
  if (activated === null) {
    return (
      <div className="mt-1 flex flex-wrap gap-1">
        <Badge variant="outline">Current status unknown</Badge>
      </div>
    );
  }

  return (
    <div className="mt-1 flex flex-wrap gap-1">
      <Badge variant={activated ? "outline" : "destructive"}>
        {activated ? "Active" : "Inactive in Wise"}
      </Badge>
      <Badge variant={hasFutureSessions ? "outline" : "secondary"}>
        {hasFutureSessions ? "Future sessions" : "No future sessions"}
      </Badge>
      {hasLivePackage ? <Badge variant="outline">Live package</Badge> : null}
    </div>
  );
}

export function EmptyState({ title, detail }: { title: string; detail: string }) {
  return (
    <div className="flex min-h-32 flex-col items-center justify-center rounded-lg border border-dashed border-border bg-muted/20 p-6 text-center">
      <div className="text-sm font-medium text-foreground">{title}</div>
      <div className="mt-1 max-w-sm text-xs text-muted-foreground">{detail}</div>
    </div>
  );
}
