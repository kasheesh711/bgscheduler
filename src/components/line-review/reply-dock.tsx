"use client";

import { ClipboardCheck, Loader2, Send, XCircle } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";

export function ReplyDock({
  draft,
  onDraftChange,
  rejectCorrection,
  onRejectCorrectionChange,
  rejectReason,
  onRejectReasonChange,
  busy,
  onReject,
  onAcceptHandled,
  onApproveSend,
}: {
  draft: string;
  onDraftChange: (value: string) => void;
  rejectCorrection: string;
  onRejectCorrectionChange: (value: string) => void;
  rejectReason: string;
  onRejectReasonChange: (value: string) => void;
  busy: string | null;
  onReject: () => void;
  onAcceptHandled: () => void;
  onApproveSend: () => void;
}) {
  return (
    <section className="shrink-0 border-t border-border bg-card p-3 shadow-[0_-10px_24px_rgba(15,23,42,0.06)]">
      <div className="grid gap-3 xl:grid-cols-[minmax(0,1fr)_360px]">
        <div className="min-w-0">
          <div className="mb-1 text-xs font-semibold uppercase tracking-wide text-muted-foreground">
            Parent reply review
          </div>
          <Textarea
            value={draft}
            onChange={(event) => onDraftChange(event.target.value)}
            className="min-h-20 resize-none"
            placeholder="AI reply to parent"
          />
        </div>

        <div className="flex min-w-0 flex-col gap-2">
          <div className="grid gap-2 sm:grid-cols-2 xl:grid-cols-1">
            <Input
              value={rejectCorrection}
              onChange={(event) => onRejectCorrectionChange(event.target.value)}
              placeholder="Staff correction for rejected AI output"
            />
            <Input
              value={rejectReason}
              onChange={(event) => onRejectReasonChange(event.target.value)}
              placeholder="Reject reason"
            />
          </div>
          <div className="flex flex-wrap justify-end gap-2">
            <Button
              type="button"
              variant="destructive"
              size="sm"
              onClick={onReject}
              disabled={Boolean(busy)}
            >
              {busy === "reject" ? <Loader2 className="animate-spin" /> : <XCircle />}
              Reject
            </Button>
            <Button
              type="button"
              variant="outline"
              size="sm"
              onClick={onAcceptHandled}
              disabled={Boolean(busy)}
            >
              {busy === "accept_no_send" ? <Loader2 className="animate-spin" /> : <ClipboardCheck />}
              Accept handled
            </Button>
            <Button
              type="button"
              size="sm"
              onClick={onApproveSend}
              disabled={Boolean(busy) || !draft.trim()}
            >
              {busy === "approve_send" ? <Loader2 className="animate-spin" /> : <Send />}
              Approve & send
            </Button>
          </div>
        </div>
      </div>
    </section>
  );
}
