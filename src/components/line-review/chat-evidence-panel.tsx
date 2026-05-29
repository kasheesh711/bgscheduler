"use client";

import { Bot, MessageSquareText } from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { cn } from "@/lib/utils";
import type { LineReviewChatContext, Review } from "./types";
import { EmptyState } from "./status-badges";
import { asString, formatDateTime } from "./utils";

export function ChatEvidencePanel({
  context,
  selected,
}: {
  context: LineReviewChatContext | null;
  selected: Review;
}) {
  const timeline = context?.combinedTimeline ?? [];
  const hasLineText = Boolean(context?.lineMessages.some((message) => message.text.trim()));
  const hasWebsiteText = Boolean(context?.websiteMessages.some((message) => message.text.trim()));

  return (
    <div className="flex min-h-full flex-col rounded-lg border border-border bg-card">
      <div className="border-b border-border p-3">
        <div className="flex flex-col gap-2 xl:flex-row xl:items-start xl:justify-between">
          <div className="min-w-0">
            <div className="flex items-center gap-2 text-sm font-semibold text-foreground">
              <MessageSquareText className="size-4 text-primary" />
              Chat context
            </div>
            <p className="mt-1 text-xs text-muted-foreground">
              Read the actual LINE thread and website scheduler history first. Operational evidence below should explain this conversation.
            </p>
          </div>
          <div className="flex shrink-0 items-center gap-1.5">
            <Badge variant="outline">{context?.lineMessages.length ?? 0} LINE</Badge>
            <Badge variant="outline">{context?.websiteMessages.length ?? 0} website</Badge>
          </div>
        </div>

        <div className="mt-3 rounded-md border border-border bg-background p-3">
          <div className="flex items-center gap-2 text-xs font-semibold uppercase tracking-wide text-muted-foreground">
            <Bot className="size-3.5" />
            AI interpretation
          </div>
          <div className="mt-2 grid gap-3 xl:grid-cols-[minmax(0,1fr)_280px]">
            <div>
              <p className="text-sm font-medium leading-relaxed text-foreground">
                {selected.classifierSummary ?? "No classifier summary recorded."}
              </p>
              {selected.classifierRationale ? (
                <p className="mt-1 text-xs leading-relaxed text-muted-foreground">
                  {selected.classifierRationale}
                </p>
              ) : null}
            </div>
            <div className="grid grid-cols-2 gap-2 text-xs">
              <div>
                <div className="text-muted-foreground">Target date</div>
                <div className="font-medium text-foreground">
                  {asString(selected.intentPayload.targetDate) ?? "n/a"}
                </div>
              </div>
              <div>
                <div className="text-muted-foreground">Target time</div>
                <div className="font-medium text-foreground">
                  {asString(selected.intentPayload.targetStartTime) ?? "n/a"}
                </div>
              </div>
              <div>
                <div className="text-muted-foreground">Resume date</div>
                <div className="font-medium text-foreground">
                  {asString(selected.intentPayload.resumeDate) ?? "n/a"}
                </div>
              </div>
              <div>
                <div className="text-muted-foreground">Matched students</div>
                <div className="truncate font-medium text-foreground">
                  {selected.matchedStudentKeys.join(", ") || "none"}
                </div>
              </div>
            </div>
          </div>
        </div>
      </div>

      {!context ? (
        <div className="p-3">
          <EmptyState
            title="No chat context loaded"
            detail="Select a review to load the parent LINE thread and linked website conversation."
          />
        </div>
      ) : timeline.length === 0 ? (
        <div className="p-3">
          <EmptyState
            title="No chat messages found"
            detail="This review does not have LINE thread messages or linked website conversation messages yet."
          />
        </div>
      ) : (
        <div className="min-h-[360px] flex-1 space-y-2 overflow-y-auto bg-background/70 p-3">
          {timeline.map((message) => {
            const isLine = message.source === "line";
            const isParent = message.direction === "inbound" || message.role === "parent";
            return (
              <div
                key={`${message.source}-${message.id}`}
                className={cn(
                  "rounded-md border px-3 py-2.5",
                  isLine
                    ? "border-sky-500/25 bg-sky-500/10"
                    : "border-amber-500/25 bg-amber-500/10",
                  message.isRetracted && "opacity-70",
                )}
              >
                <div className="flex flex-wrap items-center justify-between gap-2 text-[11px]">
                  <div className="flex items-center gap-2">
                    <Badge variant={isLine ? "secondary" : "outline"}>
                      {isLine ? "LINE" : "Website"}
                    </Badge>
                    <span className="font-medium text-foreground">{message.roleLabel}</span>
                    <span className="text-muted-foreground">
                      {isParent ? "parent-side" : "ops-side"}
                    </span>
                    {message.isRetracted ? <Badge variant="destructive">retracted</Badge> : null}
                  </div>
                  <span className="text-muted-foreground">{formatDateTime(message.timestamp)}</span>
                </div>
                <div className="mt-2 whitespace-pre-wrap text-sm leading-relaxed text-foreground">
                  {message.text.trim() || `[${message.messageType ?? "non-text message"}]`}
                </div>
              </div>
            );
          })}
        </div>
      )}

      {context ? (
        <div className="grid shrink-0 gap-2 border-t border-border p-3 text-xs text-muted-foreground lg:grid-cols-2">
          {!hasLineText ? (
            <div className="rounded-md border border-border bg-background p-2">
              No text content was found in the recent LINE thread messages.
            </div>
          ) : null}
          {!context.conversationId ? (
            <div className="rounded-md border border-border bg-background p-2">
              No linked website AI Scheduler conversation exists for this review.
            </div>
          ) : !hasWebsiteText ? (
            <div className="rounded-md border border-border bg-background p-2">
              The linked website conversation has no text messages yet.
            </div>
          ) : null}
        </div>
      ) : null}
    </div>
  );
}
