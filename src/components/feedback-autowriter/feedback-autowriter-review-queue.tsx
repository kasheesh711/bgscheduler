"use client";

import { useState } from "react";
import { Button } from "@/components/ui/button";
import type { AutowriterReview, ReviewQueueItem } from "@/lib/feedback-autowriter/review-data";
import { when } from "./format";
import { ReviewDetail } from "./review-detail";
import { REVIEW_FILTERS, matchesFilter, type ReviewFilter } from "./review-helpers";
import { VerdictForm } from "./verdict-form";

function QueueItem({ item, canControl, onRecorded }: { item: ReviewQueueItem; canControl: boolean; onRecorded: () => Promise<void> | void }) {
  return (
    <details className="rounded-lg border bg-card" open={item.status === "flagged"}>
      <summary className="flex cursor-pointer flex-wrap items-center gap-2 px-4 py-3 text-sm">
        <span className="whitespace-nowrap font-medium">{when(item.classEndedAt)}</span>
        <span className="whitespace-nowrap">{item.tutor}</span>
        <span className="max-w-64 truncate text-muted-foreground" title={item.className ?? undefined}>{item.className ?? "—"}</span>
      </summary>
      <div className="space-y-4 border-t px-4 py-3">
        <ReviewDetail item={item} />
        {canControl ? <VerdictForm item={item} onRecorded={() => onRecorded()} /> : (
          <p className="text-xs text-muted-foreground">Read-only: only Kevin records verdicts.</p>
        )}
        {item.wiseUrl ? <a className="text-xs text-primary underline" href={item.wiseUrl} target="_blank" rel="noreferrer">Open in Wise</a> : null}
      </div>
    </details>
  );
}

export function FeedbackAutowriterReviewQueue({ review, canControl, onRecorded }: {
  review: AutowriterReview;
  canControl: boolean;
  onRecorded: () => Promise<void> | void;
}) {
  const [filter, setFilter] = useState<ReviewFilter>("required");
  // Exact counts from the database: the queue itself may be a subset (every flagged and unreviewed class is in it).
  const counts: Record<ReviewFilter, number> = {
    required: review.queueTotals.needsReview,
    flagged: review.queueTotals.flagged,
    all: review.queueTotals.all,
  };
  const items = review.queue.filter((item) => matchesFilter(item, filter));
  return (
    <div className="flex flex-col gap-3">
      <div className="flex flex-wrap items-center gap-2">
        <div className="flex rounded-md border p-0.5" role="group" aria-label="Review filter">
          {REVIEW_FILTERS.map((option) => (
            <Button key={option.key} size="xs" variant={filter === option.key ? "default" : "ghost"} onClick={() => setFilter(option.key)}>
              {option.label} ({counts[option.key]})
            </Button>
          ))}
        </div>
        <p className="text-xs text-muted-foreground">
          Every post is reviewed until the tutor&apos;s cohort passes a gate. Judge the first shot: cosmetic fixes still count as accurate.
        </p>
      </div>
      {review.queueTotals.shown < review.queueTotals.all ? (
        <p className="text-xs text-muted-foreground">
          Showing {review.queueTotals.shown} of {review.queueTotals.all}: every flagged and unreviewed class, then the latest reviewed ones.
        </p>
      ) : null}
      {items.length === 0 ? (
        <p className="rounded-lg border bg-card px-4 py-8 text-center text-sm text-muted-foreground">Nothing here.</p>
      ) : items.map((item) => <QueueItem key={item.wiseSessionId} item={item} canControl={canControl} onRecorded={onRecorded} />)}
    </div>
  );
}
