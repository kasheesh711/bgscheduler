"use client";

import { Clock, LockKeyhole, RefreshCw, X } from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import type { ProposalHoldSummary, ProposalPatchAction } from "@/lib/proposals/types";
import { cn } from "@/lib/utils";

interface ActiveHoldsDrawerProps {
  open: boolean;
  holds: ProposalHoldSummary[];
  loading?: boolean;
  actionLoadingId?: string | null;
  onClose: () => void;
  onRefresh: () => void;
  onAction: (itemId: string, action: ProposalPatchAction) => void;
}

const DAY_NAMES = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];

function formatHoldWhen(hold: ProposalHoldSummary): string {
  const day = hold.scope === "recurring"
    ? `Every ${DAY_NAMES[hold.weekday]}`
    : hold.date ?? DAY_NAMES[hold.weekday];
  return `${day}, ${hold.startTime}-${hold.endTime}`;
}

function formatExpiry(value?: string): string {
  if (!value) return "No expiry";
  const date = new Date(value);
  return date.toLocaleString(undefined, {
    month: "short",
    day: "numeric",
    hour: "numeric",
    minute: "2-digit",
  });
}

function statusVariant(status: ProposalHoldSummary["status"]): "secondary" | "outline" {
  return status === "confirmed" ? "outline" : "secondary";
}

export function ActiveHoldsDrawer({
  open,
  holds,
  loading,
  actionLoadingId,
  onClose,
  onRefresh,
  onAction,
}: ActiveHoldsDrawerProps) {
  if (!open) return null;

  return (
    <div
      className="fixed inset-0 z-50 flex justify-end"
      role="dialog"
      aria-modal="true"
      aria-label="Active proposal holds"
    >
      <div
        className="absolute inset-0 bg-black/30 animate-in fade-in"
        onClick={onClose}
        aria-hidden
      />
      <div
        className={cn(
          "relative flex h-full w-[460px] max-w-full flex-col border-l border-border bg-card shadow-2xl",
          "animate-in slide-in-from-right duration-200",
        )}
      >
        <div className="flex items-center gap-2 border-b border-border px-4 py-3">
          <LockKeyhole className="h-4 w-4 text-primary" aria-hidden />
          <div className="text-sm font-semibold">Active holds</div>
          <span className="text-[11px] text-muted-foreground">
            {holds.length}
          </span>
          <button
            type="button"
            onClick={onRefresh}
            className="ml-auto rounded-md p-1 text-muted-foreground hover:bg-muted hover:text-foreground"
            aria-label="Refresh holds"
            title="Refresh holds"
          >
            <RefreshCw className={cn("h-4 w-4", loading && "animate-spin")} />
          </button>
          <button
            onClick={onClose}
            aria-label="Close drawer"
            className="rounded-md p-1 text-muted-foreground hover:bg-muted hover:text-foreground"
          >
            <X className="h-4 w-4" />
          </button>
        </div>

        <div className="flex-1 overflow-y-auto p-3">
          {holds.length === 0 ? (
            <div className="flex h-full items-center justify-center text-sm text-muted-foreground">
              No active proposal holds
            </div>
          ) : (
            <div className="space-y-2">
              {holds.map((hold) => {
                const busy = actionLoadingId === hold.itemId;
                return (
                  <div
                    key={hold.itemId}
                    className="rounded-md border border-border bg-background px-3 py-2"
                  >
                    <div className="flex items-start gap-2">
                      <div className="min-w-0 flex-1">
                        <div className="truncate text-sm font-semibold">{hold.studentLabel}</div>
                        <div className="truncate text-xs text-muted-foreground">
                          {hold.tutorDisplayName}
                        </div>
                      </div>
                      <Badge variant={statusVariant(hold.status)} className="capitalize">
                        {hold.status}
                      </Badge>
                    </div>

                    <div className="mt-2 space-y-1 text-xs text-muted-foreground">
                      <div>{formatHoldWhen(hold)}</div>
                      <div className="flex items-center gap-1">
                        <Clock className="h-3 w-3" aria-hidden />
                        {hold.status === "pending"
                          ? `Expires ${formatExpiry(hold.expiresAt)}`
                          : "Blocks until Wise sync or release"}
                      </div>
                      {hold.createdByEmail && (
                        <div>Held by {hold.createdByName || hold.createdByEmail}</div>
                      )}
                      {hold.notes && <div className="text-foreground/80">{hold.notes}</div>}
                    </div>

                    <div className="mt-2 flex items-center gap-1.5">
                      {hold.status === "pending" && (
                        <>
                          <Button
                            variant="outline"
                            size="sm"
                            className="h-7 text-[11px]"
                            disabled={busy}
                            onClick={() => onAction(hold.itemId, "confirm")}
                          >
                            Confirm
                          </Button>
                          <Button
                            variant="outline"
                            size="sm"
                            className="h-7 text-[11px]"
                            disabled={busy}
                            onClick={() => onAction(hold.itemId, "extend")}
                          >
                            Extend 48h
                          </Button>
                        </>
                      )}
                      <Button
                        variant="outline"
                        size="sm"
                        className="ml-auto h-7 text-[11px] text-destructive hover:text-destructive"
                        disabled={busy}
                        onClick={() => onAction(hold.itemId, "release")}
                      >
                        Release
                      </Button>
                    </div>
                  </div>
                );
              })}
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
