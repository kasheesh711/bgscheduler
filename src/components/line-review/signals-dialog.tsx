"use client";

import { AlertTriangle, ShieldCheck, UserCheck } from "lucide-react";
import { Badge } from "@/components/ui/badge";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import type {
  Analytics,
  FalseNegativeCandidate,
  Review,
  StudentLink,
  WiseActionLog,
} from "./types";
import { formatDateTime, formatPercent } from "./utils";

export function SignalsDialog({
  open,
  onOpenChange,
  analytics,
  links,
  logs,
  falseNegatives,
  selected,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  analytics: Analytics | null;
  links: StudentLink[];
  logs: WiseActionLog[];
  falseNegatives: FalseNegativeCandidate[];
  selected: Review | null;
}) {
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="flex max-h-[86vh] max-w-4xl flex-col overflow-hidden">
        <DialogHeader>
          <DialogTitle>Review signals</DialogTitle>
          <DialogDescription>
            Secondary diagnostics for autonomy readiness, link coverage, false negatives, and Wise audit logs.
          </DialogDescription>
        </DialogHeader>

        <div className="grid gap-3 border-y border-border py-3 sm:grid-cols-4">
          <div className="rounded-lg border border-border bg-background p-3">
            <div className="text-xs text-muted-foreground">Pending</div>
            <div className="text-lg font-semibold text-foreground">
              {analytics?.pendingReviews ?? 0}
            </div>
          </div>
          <div className="rounded-lg border border-border bg-background p-3">
            <div className="text-xs text-muted-foreground">Reject rate</div>
            <div className="text-lg font-semibold text-foreground">
              {formatPercent(analytics?.rejectionRate)}
            </div>
          </div>
          <div className="rounded-lg border border-border bg-background p-3">
            <div className="text-xs text-muted-foreground">Target</div>
            <div className="text-lg font-semibold text-foreground">&lt;5%</div>
          </div>
          <div className="rounded-lg border border-border bg-background p-3">
            <div className="text-xs text-muted-foreground">Accuracy</div>
            <div className="text-lg font-semibold text-foreground">
              {formatPercent(analytics?.classificationAccuracy)}
            </div>
          </div>
        </div>

        <div className="min-h-0 flex-1 space-y-3 overflow-y-auto pr-1">
          <section className="rounded-lg border border-border bg-card p-3">
            <div className="flex items-center gap-2 text-sm font-semibold text-foreground">
              <UserCheck className="size-4" />
              Student link coverage
            </div>
            <div className="mt-3 grid gap-2 sm:grid-cols-3">
              <div className="flex items-center justify-between rounded-md border border-border bg-background p-2 text-sm">
                <span className="text-muted-foreground">Verified links</span>
                <span className="font-medium">{links.filter((link) => link.status === "verified").length}</span>
              </div>
              <div className="flex items-center justify-between rounded-md border border-border bg-background p-2 text-sm">
                <span className="text-muted-foreground">Suggested links</span>
                <span className="font-medium">{links.filter((link) => link.status === "suggested").length}</span>
              </div>
              <div className="flex items-center justify-between rounded-md border border-border bg-background p-2 text-sm">
                <span className="text-muted-foreground">Matched in review</span>
                <span className="font-medium">{selected?.matchedStudentKeys.length ?? 0}</span>
              </div>
            </div>
          </section>

          <section className="rounded-lg border border-border bg-card p-3">
            <div className="flex items-center gap-2 text-sm font-semibold text-foreground">
              <ShieldCheck className="size-4" />
              Wise action log
            </div>
            <div className="mt-3 space-y-2">
              {logs.length === 0 ? (
                <div className="text-xs text-muted-foreground">No Wise action logs for this review yet.</div>
              ) : logs.map((log) => (
                <div key={log.id} className="rounded-md border border-border bg-background p-2">
                  <div className="flex items-center justify-between gap-2">
                    <div className="text-sm font-medium text-foreground">{log.actionType}</div>
                    <Badge variant={log.status === "failed" ? "destructive" : "outline"}>
                      {log.status}
                    </Badge>
                  </div>
                  <div className="mt-1 text-xs text-muted-foreground">
                    {formatDateTime(log.createdAt)} / {log.dryRun ? "dry run" : "writeback"} / {log.wiseSessionIds.length} session(s)
                  </div>
                  {log.errorMessage ? (
                    <div className="mt-1 text-xs text-destructive">{log.errorMessage}</div>
                  ) : null}
                </div>
              ))}
            </div>
          </section>

          <section className="rounded-lg border border-border bg-card p-3">
            <div className="flex items-center gap-2 text-sm font-semibold text-foreground">
              <AlertTriangle className="size-4" />
              Possible false negatives
            </div>
            <div className="mt-3 space-y-2">
              {falseNegatives.length === 0 ? (
                <div className="text-xs text-muted-foreground">
                  No possible false negatives in the classifier queue.
                </div>
              ) : falseNegatives.slice(0, 12).map((candidate) => (
                <div key={candidate.id} className="rounded-md border border-border bg-background p-2">
                  <div className="flex items-center justify-between gap-2">
                    <div className="truncate text-sm font-medium text-foreground">
                      {candidate.contactDisplayName ?? candidate.lineUserId}
                    </div>
                    <Badge variant="outline">{formatPercent(candidate.classifierConfidence)}</Badge>
                  </div>
                  <div className="mt-1 line-clamp-2 text-xs text-muted-foreground">
                    {candidate.text}
                  </div>
                </div>
              ))}
            </div>
          </section>
        </div>
      </DialogContent>
    </Dialog>
  );
}
