"use client";

import type { ReactNode } from "react";
import { BarChart3, Loader2, RefreshCw, RotateCcw, ShieldCheck, UserCheck } from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import type { Analytics, Review, StudentLink } from "./types";
import { StudentStateBadges, IntentBadge, WritebackBadge } from "./status-badges";
import { formatPercent, verifiedLinks } from "./utils";

function QualityChip({ label, value }: { label: string; value: string }) {
  return (
    <div className="rounded-md border border-border bg-background px-2.5 py-1.5">
      <div className="text-[10px] font-medium uppercase tracking-wide text-muted-foreground">
        {label}
      </div>
      <div className="text-sm font-semibold leading-none text-foreground">{value}</div>
    </div>
  );
}

export function CaseHeader({
  selected,
  links,
  analytics,
  falseNegativeCount,
  logCount,
  busy,
  loading,
  onRefresh,
  onRebuild,
  onOpenSignals,
  aliasImportCommand,
  studentLinkCommand,
}: {
  selected: Review | null;
  links: StudentLink[];
  analytics: Analytics | null;
  falseNegativeCount: number;
  logCount: number;
  busy: string | null;
  loading: boolean;
  onRefresh: () => void;
  onRebuild: () => void;
  onOpenSignals: () => void;
  aliasImportCommand: ReactNode;
  studentLinkCommand: ReactNode;
}) {
  const verified = verifiedLinks(links);
  const suggestedCount = links.filter((link) => link.status === "suggested").length;
  const selectedName = selected?.contactDisplayName ?? selected?.lineUserId ?? "No selected review";

  return (
    <header className="shrink-0 border-b border-border bg-card px-4 py-3 lg:px-5">
      <div className="flex flex-col gap-3 xl:flex-row xl:items-start xl:justify-between">
        <div className="min-w-0">
          <div className="flex flex-wrap items-center gap-2">
            <h1 className="truncate text-lg font-semibold tracking-tight text-foreground">
              LINE AI Review
            </h1>
            {selected ? (
              <>
                <span className="text-muted-foreground">/</span>
                <h2 className="truncate text-base font-semibold text-foreground">
                  {selectedName}
                </h2>
                <IntentBadge intent={selected.intentType} />
                <WritebackBadge status={selected.writebackStatus} />
              </>
            ) : null}
          </div>
          <div className="mt-1 flex flex-wrap items-center gap-x-3 gap-y-1 text-xs text-muted-foreground">
            <span>Validate parent replies and Wise action suggestions before autonomy.</span>
            {selected ? (
              <span>
                LINE user {selected.lineUserId} / confidence {formatPercent(selected.classifierConfidence)}
              </span>
            ) : null}
          </div>

          <div className="mt-2 flex flex-wrap items-center gap-2">
            {verified.length === 0 ? (
              <Badge variant="destructive">No verified student</Badge>
            ) : (
              <>
                <Badge variant="default">
                  <UserCheck className="mr-1 size-3" />
                  {verified.length === 1 ? "Verified student" : `${verified.length} verified students`}
                </Badge>
                {verified.slice(0, 3).map((link) => (
                  <div
                    key={link.id}
                    className="rounded-md border border-emerald-500/25 bg-emerald-500/10 px-2 py-1"
                  >
                    <div className="text-xs font-medium text-foreground">
                      {link.studentName}
                    </div>
                    <div className="text-[11px] text-muted-foreground">
                      {link.studentKey} / {link.parentName || "No parent"}
                    </div>
                    <StudentStateBadges
                      activated={link.currentStudentActivated}
                      hasFutureSessions={link.currentStudentHasFutureSessions}
                      hasLivePackage={link.currentStudentHasLivePackage}
                    />
                  </div>
                ))}
              </>
            )}
            {suggestedCount > 0 ? (
              <Badge variant="outline">{suggestedCount} suggested link(s)</Badge>
            ) : null}
            {selected ? studentLinkCommand : null}
          </div>
        </div>

        <div className="flex shrink-0 flex-col gap-2">
          <div className="grid grid-cols-2 gap-1.5 sm:grid-cols-4">
            <QualityChip label="Reject rate" value={formatPercent(analytics?.rejectionRate)} />
            <QualityChip label="Link backlog" value={String(analytics?.unverifiedLinkBacklog ?? 0)} />
            <QualityChip label="False neg." value={String(falseNegativeCount)} />
            <QualityChip label="Wise logs" value={String(logCount)} />
          </div>
          <div className="flex flex-wrap justify-start gap-2 xl:justify-end">
            {aliasImportCommand}
            <Button type="button" size="sm" variant="outline" onClick={onOpenSignals}>
              <BarChart3 />
              Signals
            </Button>
            <Button
              type="button"
              size="sm"
              variant="outline"
              onClick={onRebuild}
              disabled={!selected || Boolean(busy)}
            >
              {busy === "rebuild-plan" ? <Loader2 className="animate-spin" /> : <RotateCcw />}
              Rebuild
            </Button>
            <Button
              type="button"
              size="sm"
              variant="outline"
              onClick={onRefresh}
              disabled={busy === "refresh" || loading}
            >
              {busy === "refresh" ? <Loader2 className="animate-spin" /> : <RefreshCw />}
              Refresh
            </Button>
            <Badge variant="outline" className="h-7 px-2">
              <ShieldCheck className="mr-1 size-3.5" />
              Confirm-only Wise
            </Badge>
          </div>
        </div>
      </div>
    </header>
  );
}
