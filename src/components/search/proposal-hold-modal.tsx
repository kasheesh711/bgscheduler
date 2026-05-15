"use client";

import { useMemo, useState } from "react";
import { Clock, LockKeyhole, X } from "lucide-react";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Badge } from "@/components/ui/badge";
import type { ProposalCreateItemInput, ProposalHoldSummary, ProposalScope } from "@/lib/proposals/types";

export interface ProposalDraftItem extends ProposalCreateItemInput {
  tutorDisplayName: string;
}

export interface ProposalDraft {
  sourceLabel: string;
  items: ProposalDraftItem[];
}

interface ProposalHoldModalProps {
  draft: ProposalDraft | null;
  onClose: () => void;
  onCreated: (items: ProposalHoldSummary[]) => void;
}

const DAY_NAMES = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];

function formatMinute(minute: number): string {
  const h = Math.floor(minute / 60);
  const m = minute % 60;
  const suffix = h >= 12 ? "pm" : "am";
  const h12 = h === 0 ? 12 : h > 12 ? h - 12 : h;
  return m === 0 ? `${h12}${suffix}` : `${h12}:${String(m).padStart(2, "0")}${suffix}`;
}

function itemLabel(item: ProposalDraftItem): string {
  const day = item.scope === "one_time"
    ? item.date
    : item.weekday !== undefined
      ? DAY_NAMES[item.weekday]
      : "";
  return `${day} ${formatMinute(item.startMinute)}-${formatMinute(item.endMinute)}`;
}

function scopeLabel(scope: ProposalScope): string {
  return scope === "recurring" ? "Recurring" : "One-time";
}

export function ProposalHoldModal({ draft, onClose, onCreated }: ProposalHoldModalProps) {
  const [studentLabel, setStudentLabel] = useState("");
  const [notes, setNotes] = useState("");
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const dedupedItems = useMemo(() => {
    if (!draft) return [];
    const seen = new Set<string>();
    return draft.items.filter((item) => {
      const key = [
        item.tutorGroupId,
        item.scope,
        item.weekday ?? "",
        item.date ?? "",
        item.startMinute,
        item.endMinute,
      ].join("|");
      if (seen.has(key)) return false;
      seen.add(key);
      return true;
    });
  }, [draft]);

  const open = draft !== null;

  const resetAndClose = () => {
    setStudentLabel("");
    setNotes("");
    setError(null);
    onClose();
  };

  const handleSubmit = async () => {
    if (!draft || studentLabel.trim().length === 0 || dedupedItems.length === 0) return;
    setSubmitting(true);
    setError(null);

    try {
      const res = await fetch("/api/proposals", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          studentLabel: studentLabel.trim(),
          notes: notes.trim() || undefined,
          items: dedupedItems.map((item) => ({
            tutorGroupId: item.tutorGroupId,
            scope: item.scope,
            weekday: item.weekday,
            date: item.date,
            startMinute: item.startMinute,
            endMinute: item.endMinute,
            subject: item.subject,
            curriculum: item.curriculum,
            level: item.level,
          })),
        }),
      });

      const data = await res.json().catch(() => ({}));
      if (!res.ok) {
        if (res.status === 409 && data.conflict) {
          throw new Error(
            `${data.conflict.tutorDisplayName} is already held for ${data.conflict.studentLabel} at ${data.conflict.startTime}-${data.conflict.endTime}`,
          );
        }
        throw new Error(data.error ?? `Failed to mark proposal (${res.status})`);
      }

      setStudentLabel("");
      setNotes("");
      onCreated(data.items ?? []);
      onClose();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to mark proposal");
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <Dialog open={open} onOpenChange={(next) => {
      if (!next) resetAndClose();
    }}>
      <DialogContent className="sm:max-w-xl">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            <LockKeyhole className="h-4 w-4 text-primary" aria-hidden />
            Mark proposed
          </DialogTitle>
          <DialogDescription>
            Holds block overlapping searches for 48 hours unless confirmed or released.
          </DialogDescription>
        </DialogHeader>

        <div className="space-y-3">
          <div className="grid grid-cols-[1fr_auto] gap-2">
            <div>
              <label className="text-xs font-medium text-muted-foreground">Student / parent</label>
              <input
                value={studentLabel}
                onChange={(e) => setStudentLabel(e.target.value)}
                autoFocus
                placeholder="e.g. K. Nan / Beam"
                className="mt-1 h-8 w-full rounded-md border border-input bg-background px-2 text-sm outline-none focus:ring-2 focus:ring-ring/50"
              />
            </div>
            <div className="flex items-end">
              <Badge variant="secondary" className="h-7 gap-1">
                <Clock className="h-3 w-3" aria-hidden />
                48h
              </Badge>
            </div>
          </div>

          <div>
            <label className="text-xs font-medium text-muted-foreground">Notes</label>
            <textarea
              value={notes}
              onChange={(e) => setNotes(e.target.value)}
              rows={2}
              placeholder="Optional"
              className="mt-1 w-full resize-none rounded-md border border-input bg-background px-2 py-1.5 text-sm outline-none focus:ring-2 focus:ring-ring/50"
            />
          </div>

          <div>
            <div className="mb-1 flex items-center justify-between">
              <div className="text-[10px] font-semibold uppercase tracking-wider text-muted-foreground">
                {draft?.sourceLabel ?? "Proposal"}
              </div>
              <span className="text-[10px] text-muted-foreground">
                {dedupedItems.length} hold{dedupedItems.length !== 1 ? "s" : ""}
              </span>
            </div>
            <div className="max-h-56 overflow-y-auto rounded-md border border-border">
              {dedupedItems.map((item, i) => (
                <div
                  key={`${item.tutorGroupId}-${item.scope}-${item.date ?? item.weekday}-${item.startMinute}-${item.endMinute}-${i}`}
                  className="flex items-center gap-2 border-b border-border px-2 py-1.5 last:border-b-0"
                >
                  <span className="w-5 shrink-0 font-mono text-[10px] text-muted-foreground">
                    {i + 1}
                  </span>
                  <div className="min-w-0 flex-1">
                    <div className="truncate text-xs font-medium">{item.tutorDisplayName}</div>
                    <div className="truncate text-[10px] text-muted-foreground">{itemLabel(item)}</div>
                  </div>
                  <Badge variant="outline" className="text-[10px]">
                    {scopeLabel(item.scope)}
                  </Badge>
                </div>
              ))}
            </div>
          </div>

          {error && (
            <div className="rounded-md bg-destructive/10 px-2 py-1.5 text-xs text-destructive">
              {error}
            </div>
          )}
        </div>

        <DialogFooter>
          <Button variant="outline" size="sm" onClick={resetAndClose}>
            <X className="h-3.5 w-3.5" aria-hidden />
            Cancel
          </Button>
          <Button
            size="sm"
            onClick={handleSubmit}
            disabled={submitting || studentLabel.trim().length === 0 || dedupedItems.length === 0}
          >
            {submitting ? "Marking..." : "Hold proposal"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
