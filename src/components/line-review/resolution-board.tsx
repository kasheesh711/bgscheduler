"use client";

import type { ReactNode } from "react";
import { AlertTriangle, CheckCircle2, Circle, Link2, Loader2, Send, ShieldCheck } from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";
import type { CandidateSession, ProposedWiseAction, Review, StudentLink } from "./types";
import { EmptyState, StudentStateBadges } from "./status-badges";
import { issueList, verifiedLinks } from "./utils";

type StepState = "complete" | "ready" | "attention" | "blocked" | "idle";

export function getResolutionStepStates({
  review,
  links,
  candidates,
  actions,
  selectedSessionCount,
}: {
  review: Review;
  links: StudentLink[];
  candidates: CandidateSession[];
  actions: ProposedWiseAction[];
  selectedSessionCount: number;
}): {
  student: StepState;
  session: StepState;
  wiseAction: StepState;
  parentReply: StepState;
} {
  const verifiedCount = verifiedLinks(links).length;
  const suggestedCount = links.filter((link) => link.status === "suggested").length;
  const issues = issueList(review);
  const needsSession = review.intentType !== "new_request" && review.intentType !== "unclear_change";

  return {
    student: verifiedCount > 0 ? "complete" : suggestedCount > 0 ? "attention" : "blocked",
    session: !needsSession
      ? "idle"
      : selectedSessionCount > 0
        ? "complete"
        : candidates.length === 1 && candidates[0].score >= 85
          ? "ready"
          : candidates.length > 0
            ? "attention"
            : verifiedCount === 0 || issues.length > 0
              ? "blocked"
              : "attention",
    wiseAction: actions.length === 0
      ? "idle"
      : review.writebackStatus === "confirmed"
        ? "complete"
        : selectedSessionCount > 0
          ? "ready"
          : "blocked",
    parentReply: (review.finalText ?? review.proposedDraft).trim() ? "ready" : "attention",
  };
}

function StateIcon({ state }: { state: StepState }) {
  if (state === "complete") return <CheckCircle2 className="size-4 text-emerald-600" />;
  if (state === "blocked") return <AlertTriangle className="size-4 text-destructive" />;
  if (state === "ready") return <Circle className="size-4 fill-primary text-primary" />;
  if (state === "attention") return <AlertTriangle className="size-4 text-amber-600" />;
  return <Circle className="size-4 text-muted-foreground" />;
}

function StepShell({
  number,
  title,
  state,
  children,
}: {
  number: number;
  title: string;
  state: StepState;
  children: ReactNode;
}) {
  return (
    <section className="rounded-lg border border-border bg-card">
      <div className="flex items-center gap-2 border-b border-border px-3 py-2.5">
        <div className="flex size-6 items-center justify-center rounded-full border border-border bg-background text-xs font-semibold text-muted-foreground">
          {number}
        </div>
        <div className="min-w-0 flex-1 text-sm font-semibold text-foreground">{title}</div>
        <StateIcon state={state} />
      </div>
      <div className="p-3">{children}</div>
    </section>
  );
}

function CandidateCard({
  candidate,
  selected,
  onToggle,
}: {
  candidate: CandidateSession;
  selected: boolean;
  onToggle: () => void;
}) {
  return (
    <button
      type="button"
      onClick={onToggle}
      className={cn(
        "block w-full rounded-md border p-2 text-left transition-colors hover:bg-muted/70",
        selected ? "border-primary/40 bg-primary/10" : "border-border bg-background",
      )}
    >
      <div className="flex items-start justify-between gap-2">
        <div className="min-w-0">
          <div className="truncate text-sm font-semibold text-foreground">
            {candidate.studentName}
          </div>
          <div className="text-xs text-muted-foreground">{candidate.studentKey}</div>
        </div>
        <Badge variant={selected ? "default" : "outline"}>{candidate.score}</Badge>
      </div>
      <div className="mt-2 text-sm font-medium text-foreground">
        {candidate.startLocalDate} {candidate.startLocalTime}
        {candidate.endLocalTime ? `-${candidate.endLocalTime}` : ""}
      </div>
      <div className="mt-0.5 text-xs text-muted-foreground">
        {candidate.subject || candidate.packageName || "No subject"} / {candidate.teacherName ?? "Unknown teacher"} / {candidate.location ?? "No location"}
      </div>
      <div className="mt-1 truncate font-mono text-[11px] text-muted-foreground">
        class {candidate.wiseClassId || "n/a"} / session {candidate.wiseSessionId || "n/a"}
      </div>
      {candidate.reasons.length > 0 ? (
        <div className="mt-1 text-[11px] leading-snug text-muted-foreground">
          {candidate.reasons.slice(0, 2).join(", ")}
        </div>
      ) : null}
    </button>
  );
}

export function ResolutionBoard({
  selected,
  links,
  candidates,
  actions,
  selectedSessionIds,
  busy,
  onToggleSession,
  onConfirmWiseAction,
  onOpenStudentLink,
}: {
  selected: Review;
  links: StudentLink[];
  candidates: CandidateSession[];
  actions: ProposedWiseAction[];
  selectedSessionIds: Set<string>;
  busy: string | null;
  onToggleSession: (sessionId: string) => void;
  onConfirmWiseAction: (action: ProposedWiseAction) => void;
  onOpenStudentLink: () => void;
}) {
  const verified = verifiedLinks(links);
  const suggested = links.filter((link) => link.status === "suggested");
  const issues = issueList(selected);
  const stepStates = getResolutionStepStates({
    review: selected,
    links,
    candidates,
    actions,
    selectedSessionCount: selectedSessionIds.size,
  });

  return (
    <div className="flex min-h-full flex-col gap-3">
      <div>
        <h3 className="text-sm font-semibold text-foreground">Resolution board</h3>
        <p className="mt-1 text-xs text-muted-foreground">
          Work top to bottom: student, class/session, Wise action, then parent reply.
        </p>
      </div>

      <StepShell number={1} title="Student" state={stepStates.student}>
        {verified.length > 0 ? (
          <div className="space-y-2">
            {verified.map((link) => (
              <div key={link.id} className="rounded-md border border-emerald-500/25 bg-emerald-500/10 p-2">
                <div className="text-sm font-medium text-foreground">{link.studentName}</div>
                <div className="text-xs text-muted-foreground">
                  {link.studentKey} / Parent: {link.parentName || "n/a"}
                </div>
                <StudentStateBadges
                  activated={link.currentStudentActivated}
                  hasFutureSessions={link.currentStudentHasFutureSessions}
                  hasLivePackage={link.currentStudentHasLivePackage}
                />
              </div>
            ))}
            <Button type="button" size="xs" variant="outline" onClick={onOpenStudentLink}>
              <Link2 />
              Add another
            </Button>
          </div>
        ) : (
          <div className="rounded-md border border-destructive/25 bg-destructive/10 p-2.5">
            <div className="text-sm font-medium text-destructive">
              Student link required before operational suggestions are trusted.
            </div>
            {suggested.length > 0 ? (
              <div className="mt-1 text-xs text-muted-foreground">
                {suggested.length} suggested link(s) are waiting for verification.
              </div>
            ) : null}
            <Button type="button" size="sm" className="mt-2" onClick={onOpenStudentLink}>
              <Link2 />
              Link student
            </Button>
          </div>
        )}
      </StepShell>

      <StepShell number={2} title="Class/session" state={stepStates.session}>
        {candidates.length === 0 ? (
          <EmptyState
            title="No session candidate"
            detail={selected.intentType === "new_request"
              ? "New requests do not require an existing class match."
              : "Resolve the student link or ask for clarification before Wise action evidence can be trusted."}
          />
        ) : (
          <div className="space-y-2">
            <div className="flex items-center justify-between gap-2 text-xs text-muted-foreground">
              <span>{candidates.length === 1 ? "Single candidate" : "Ranked candidates"}</span>
              <Badge variant="outline">{selectedSessionIds.size} selected</Badge>
            </div>
            {candidates.map((candidate) => (
              <CandidateCard
                key={candidate.wiseSessionId}
                candidate={candidate}
                selected={selectedSessionIds.has(candidate.wiseSessionId)}
                onToggle={() => onToggleSession(candidate.wiseSessionId)}
              />
            ))}
          </div>
        )}
        {issues.length > 0 ? (
          <div className="mt-2 rounded-md border border-amber-500/30 bg-amber-500/10 p-2 text-xs text-amber-800 dark:text-amber-300">
            {issues.slice(0, 2).map((issue) => (
              <div key={issue}>- {issue}</div>
            ))}
          </div>
        ) : null}
      </StepShell>

      <StepShell number={3} title="Wise action" state={stepStates.wiseAction}>
        {actions.length === 0 ? (
          <EmptyState
            title="No Wise operation proposed"
            detail="The case may only need a parent reply, or it still needs a verified student and class/session match."
          />
        ) : (
          <div className="space-y-2">
            {actions.map((action) => (
              <div key={action.id} className="rounded-md border border-border bg-background p-2.5">
                <div className="flex items-start justify-between gap-2">
                  <div className="min-w-0">
                    <div className="text-sm font-semibold text-foreground">{action.label}</div>
                    <div className="mt-1 flex flex-wrap gap-1">
                      <Badge variant={action.endpointVerified ? "default" : "destructive"}>
                        {action.endpointVerified ? "Endpoint verified" : "Manual Wise action"}
                      </Badge>
                      <Badge variant="outline">dry-run first</Badge>
                    </div>
                    <div className="mt-1 text-xs text-muted-foreground">
                      {action.type} / {action.wiseSessionIds.length} session(s) / {action.wiseClassIds.length} class(es)
                    </div>
                    {action.disabledReason ? (
                      <div className="mt-1 text-xs text-destructive">{action.disabledReason}</div>
                    ) : null}
                  </div>
                  <Button
                    type="button"
                    size="xs"
                    variant={action.disabledReason ? "outline" : "default"}
                    onClick={() => onConfirmWiseAction(action)}
                    disabled={Boolean(busy) || selectedSessionIds.size === 0}
                  >
                    {busy === `action-${action.id}` ? (
                      <Loader2 className="animate-spin" />
                    ) : (
                      <ShieldCheck />
                    )}
                    {action.disabledReason ? "Record" : "Confirm"}
                  </Button>
                </div>
              </div>
            ))}
          </div>
        )}
      </StepShell>

      <StepShell number={4} title="Parent reply" state={stepStates.parentReply}>
        <div className="rounded-md border border-border bg-background p-2 text-sm text-foreground">
          {(selected.finalText ?? selected.proposedDraft).trim() || "No AI draft exists yet."}
        </div>
        <div className="mt-2 flex items-center gap-2 text-xs text-muted-foreground">
          <Send className="size-3.5" />
          Use the reply dock below to edit, approve, accept already handled, or reject with feedback.
        </div>
      </StepShell>
    </div>
  );
}
