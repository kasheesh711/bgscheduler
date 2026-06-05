import { AlertTriangle, ArrowRight, CheckCircle2, Database, FileWarning, Link2Off } from "lucide-react";
import Link from "next/link";
import { Badge } from "@/components/ui/badge";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import type { HomeActionSummary, HomeFreshnessSummary, HomeSummaryPayload } from "@/lib/home/summary";
import { shortcutTools } from "@/lib/navigation/tools";
import { cn } from "@/lib/utils";

function formatSyncAge(minutes: number | null): string {
  if (minutes === null) return "No successful sync recorded";
  if (minutes < 60) return `${minutes} min ago`;
  const hours = Math.floor(minutes / 60);
  const remainder = minutes % 60;
  return remainder > 0 ? `${hours}h ${remainder}m ago` : `${hours}h ago`;
}

function actionTone(action: HomeActionSummary): string {
  if (action.status === "error") return "border-red-200 bg-red-50/70 dark:border-red-900/60 dark:bg-red-950/20";
  if ((action.value ?? 0) > 0) return "border-amber-200 bg-amber-50/70 dark:border-amber-900/60 dark:bg-amber-950/20";
  return "border-emerald-200 bg-emerald-50/60 dark:border-emerald-900/60 dark:bg-emerald-950/20";
}

function actionValueClass(action: HomeActionSummary): string {
  if (action.status === "error") return "text-red-700 dark:text-red-300";
  if ((action.value ?? 0) > 0) return "text-amber-700 dark:text-amber-300";
  return "text-emerald-700 dark:text-emerald-300";
}

function ActionCard({ action }: { action: HomeActionSummary }) {
  return (
    <Link
      href={action.href}
      className={cn(
        "group flex min-h-28 flex-col justify-between rounded-lg border p-4 transition-colors hover:border-primary/40 hover:bg-primary/5",
        actionTone(action),
      )}
    >
      <span className="flex items-start justify-between gap-3">
        <span className="min-w-0">
          <span className="block text-sm font-semibold text-foreground">{action.label}</span>
          <span className="mt-1 block text-xs leading-snug text-muted-foreground">{action.detail}</span>
        </span>
        <ArrowRight className="mt-0.5 size-4 flex-shrink-0 text-muted-foreground transition-transform group-hover:translate-x-0.5" />
      </span>
      <span className={cn("mt-4 text-3xl font-semibold tracking-tight", actionValueClass(action))}>
        {action.status === "error" ? "!" : action.value}
      </span>
    </Link>
  );
}

function FreshnessItem({
  icon: Icon,
  label,
  value,
  detail,
  tone = "default",
}: {
  icon: typeof CheckCircle2;
  label: string;
  value: string;
  detail: string;
  tone?: "default" | "warn" | "danger";
}) {
  return (
    <div className="flex min-h-20 gap-3 rounded-lg border bg-card p-3">
      <Icon
        className={cn(
          "mt-0.5 size-4 flex-shrink-0",
          tone === "danger" ? "text-red-600" : tone === "warn" ? "text-amber-600" : "text-emerald-600",
        )}
        aria-hidden="true"
      />
      <div className="min-w-0">
        <div className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">{label}</div>
        <div className="mt-1 truncate text-sm font-medium text-foreground">{value}</div>
        <div className="mt-1 text-xs leading-snug text-muted-foreground">{detail}</div>
      </div>
    </div>
  );
}

function FreshnessStrip({ freshness }: { freshness: HomeFreshnessSummary }) {
  const cronIssueCount = freshness.cronCounts.late + freshness.cronCounts.failing;
  const syncTone = freshness.staleMinutes !== null && freshness.staleMinutes > 120 ? "warn" : "default";
  const cronTone = freshness.status === "error" || freshness.cronCounts.failing > 0
    ? "danger"
    : cronIssueCount > 0
      ? "warn"
      : "default";
  return (
    <section className="grid gap-3 lg:grid-cols-3">
      <FreshnessItem
        icon={freshness.status === "error" ? AlertTriangle : Database}
        label="Wise snapshot"
        value={freshness.status === "error" ? "Unavailable" : formatSyncAge(freshness.staleMinutes)}
        detail={freshness.wiseSnapshotLastSuccess ? `Last success ${freshness.wiseSnapshotLastSuccess}` : freshness.overallHeadline}
        tone={freshness.status === "error" ? "danger" : syncTone}
      />
      <FreshnessItem
        icon={cronTone === "danger" ? FileWarning : CheckCircle2}
        label="Cron health"
        value={`${freshness.cronCounts.healthy} healthy, ${cronIssueCount} issues`}
        detail={`${freshness.cronCounts.running} running, ${freshness.cronCounts.manualOnly} manual-only, ${freshness.cronCounts.unknown} unknown`}
        tone={cronTone}
      />
      <FreshnessItem
        icon={freshness.googleSheets.connected ? CheckCircle2 : Link2Off}
        label="Google Sheets"
        value={freshness.googleSheets.writeConnected ? "Connected with write access" : freshness.googleSheets.connected ? "Connected read-only" : "Not connected"}
        detail={freshness.googleSheets.lastError ?? freshness.googleSheets.email ?? "No connected account found"}
        tone={freshness.googleSheets.connected ? "default" : "warn"}
      />
    </section>
  );
}

export function HomeHub({
  summary,
  allowedPages,
}: {
  summary: HomeSummaryPayload;
  allowedPages: string[] | null;
}) {
  const shortcuts = shortcutTools(allowedPages);
  const hasAction = summary.actions.some((action) => action.status === "error" || (action.value ?? 0) > 0);

  return (
    <div className="flex min-h-0 flex-1 flex-col gap-4 overflow-auto pb-6">
      <header className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <h1 className="text-2xl font-semibold tracking-tight">BeGifted Ops</h1>
          <p className="text-sm text-muted-foreground">Action queues, data freshness, and shortcuts for daily operations.</p>
        </div>
        <Badge variant="outline" className="border-sky-200 bg-sky-50 text-sky-900">
          Updated {new Date(summary.generatedAt).toLocaleTimeString("en-GB", { hour: "2-digit", minute: "2-digit" })}
        </Badge>
      </header>

      <section>
        <div className="mb-2 flex items-center justify-between gap-3">
          <div>
            <h2 className="text-sm font-semibold uppercase tracking-wide text-muted-foreground">Action Queues</h2>
            <p className="text-xs text-muted-foreground">
              {hasAction ? "Open a workspace to triage the queue." : "No urgent admin queues right now."}
            </p>
          </div>
        </div>
        {summary.actions.length > 0 ? (
          <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-4 2xl:grid-cols-7">
            {summary.actions.map((action) => <ActionCard key={action.id} action={action} />)}
          </div>
        ) : (
          <Card>
            <CardContent className="py-6 text-sm text-muted-foreground">
              No accessible action queues for this account.
            </CardContent>
          </Card>
        )}
      </section>

      <section>
        <div className="mb-2">
          <h2 className="text-sm font-semibold uppercase tracking-wide text-muted-foreground">Data Freshness</h2>
        </div>
        <FreshnessStrip freshness={summary.freshness} />
      </section>

      <section>
        <div className="mb-2">
          <h2 className="text-sm font-semibold uppercase tracking-wide text-muted-foreground">Curated Shortcuts</h2>
        </div>
        <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-4">
          {shortcuts.map((tool) => (
            <Link key={tool.href} href={tool.href}>
              <Card className="h-full transition-colors hover:bg-muted/60" size="sm">
                <CardHeader>
                  <CardTitle className="flex items-center justify-between gap-3">
                    <span>{tool.label}</span>
                    <ArrowRight className="size-4 text-muted-foreground" aria-hidden="true" />
                  </CardTitle>
                </CardHeader>
                <CardContent className="text-xs leading-snug text-muted-foreground">
                  {tool.description}
                </CardContent>
              </Card>
            </Link>
          ))}
        </div>
      </section>
    </div>
  );
}
