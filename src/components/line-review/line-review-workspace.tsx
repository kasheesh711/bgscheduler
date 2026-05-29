"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import { Loader2, ScanSearch, Upload } from "lucide-react";
import { Button } from "@/components/ui/button";
import { AliasImportDialog } from "./alias-import-dialog";
import { EmptyState } from "./status-badges";
import { CaseHeader } from "./case-header";
import { ChatEvidencePanel } from "./chat-evidence-panel";
import { OaResolverDialog } from "./oa-resolver-dialog";
import { ReplyDock } from "./reply-dock";
import { ResolutionBoard } from "./resolution-board";
import { ReviewQueue } from "./review-queue";
import { SignalsDialog } from "./signals-dialog";
import { StudentLinkCommand } from "./student-link-command";
import type {
  Analytics,
  CandidateSession,
  FalseNegativeCandidate,
  IntentType,
  LineReviewChatContext,
  ProposedWiseAction,
  Review,
  StudentDirectoryRow,
  StudentLink,
  WiseActionLog,
} from "./types";
import {
  jsonFetch,
  toAction,
  toCandidate,
} from "./utils";

export { studentLinkVisibilityForReview } from "./utils";

export function LineReviewWorkspace() {
  const [intentFilter, setIntentFilter] = useState<IntentType>("all");
  const [reviews, setReviews] = useState<Review[]>([]);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [analytics, setAnalytics] = useState<Analytics | null>(null);
  const [falseNegatives, setFalseNegatives] = useState<FalseNegativeCandidate[]>([]);
  const [links, setLinks] = useState<StudentLink[]>([]);
  const [logs, setLogs] = useState<WiseActionLog[]>([]);
  const [chatContext, setChatContext] = useState<LineReviewChatContext | null>(null);
  const [draft, setDraft] = useState("");
  const [rejectCorrection, setRejectCorrection] = useState("");
  const [rejectReason, setRejectReason] = useState("");
  const [labelInput, setLabelInput] = useState("");
  const [studentSearch, setStudentSearch] = useState("");
  const [studentResults, setStudentResults] = useState<StudentDirectoryRow[]>([]);
  const [selectedSessionIds, setSelectedSessionIds] = useState<Set<string>>(new Set());
  const [studentLinkOpen, setStudentLinkOpen] = useState(false);
  const [aliasImportOpen, setAliasImportOpen] = useState(false);
  const [oaResolverOpen, setOaResolverOpen] = useState(false);
  const [signalsOpen, setSignalsOpen] = useState(false);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  const selected = useMemo(
    () => reviews.find((review) => review.id === selectedId) ?? reviews[0] ?? null,
    [reviews, selectedId],
  );

  const candidates = useMemo<CandidateSession[]>(
    () => (selected?.candidateSessions ?? []).map(toCandidate),
    [selected],
  );

  const actions = useMemo<ProposedWiseAction[]>(
    () => (selected?.proposedWiseActions ?? []).map(toAction),
    [selected],
  );

  const loadReviews = useCallback(async () => {
    const params = new URLSearchParams({ status: "pending_review", analytics: "true" });
    if (intentFilter !== "all") params.set("intentType", intentFilter);
    const data = await jsonFetch<{ reviews: Review[]; analytics: Analytics | null }>(
      `/api/line/scheduler-reviews?${params.toString()}`,
    );
    setReviews(data.reviews);
    setAnalytics(data.analytics);
    setSelectedId((current) => (
      current && data.reviews.some((review) => review.id === current)
        ? current
        : data.reviews[0]?.id ?? null
    ));
  }, [intentFilter]);

  const loadFalseNegatives = useCallback(async () => {
    const data = await jsonFetch<{ candidates: FalseNegativeCandidate[] }>(
      "/api/line/scheduler-reviews/false-negatives",
    );
    setFalseNegatives(data.candidates);
  }, []);

  const loadSelectedSideData = useCallback(async (review: Review | null) => {
    if (!review) {
      setLinks([]);
      setLogs([]);
      setChatContext(null);
      return;
    }

    const [linkPayload, logPayload, contextPayload] = await Promise.all([
      jsonFetch<{ links: StudentLink[] }>(`/api/line/contacts/${review.contactId}/student-links`),
      jsonFetch<{ logs: WiseActionLog[] }>(`/api/line/scheduler-reviews/${review.id}/wise-actions`),
      jsonFetch<{ context: LineReviewChatContext }>(`/api/line/scheduler-reviews/${review.id}/context`),
    ]);
    setLinks(linkPayload.links);
    setLogs(logPayload.logs);
    setChatContext(contextPayload.context);
  }, []);

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    setError(null);
    Promise.all([loadReviews(), loadFalseNegatives()])
      .catch((err: unknown) => {
        if (!cancelled) setError(err instanceof Error ? err.message : "Failed to load review queue");
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [loadReviews, loadFalseNegatives]);

  useEffect(() => {
    setDraft(selected?.finalText ?? selected?.proposedDraft ?? "");
    setRejectCorrection("");
    setRejectReason("");
    setLabelInput("");
    setSelectedSessionIds(new Set(selected?.adminSelectedSessionIds ?? []));
    void loadSelectedSideData(selected).catch((err: unknown) => {
      setError(err instanceof Error ? err.message : "Failed to load review details");
    });
  }, [selected, loadSelectedSideData]);

  useEffect(() => {
    const query = studentSearch.trim();
    if (query.length < 2) {
      setStudentResults([]);
      return;
    }
    const controller = new AbortController();
    const timeout = window.setTimeout(() => {
      jsonFetch<{ students: StudentDirectoryRow[] }>(
        `/api/line/students?q=${encodeURIComponent(query)}`,
        { signal: controller.signal },
      )
        .then((payload) => setStudentResults(payload.students))
        .catch((err: unknown) => {
          if (!controller.signal.aborted) {
            setError(err instanceof Error ? err.message : "Failed to search students");
          }
        });
    }, 250);
    return () => {
      controller.abort();
      window.clearTimeout(timeout);
    };
  }, [studentSearch]);

  async function refreshAll() {
    setBusy("refresh");
    setError(null);
    try {
      await Promise.all([loadReviews(), loadFalseNegatives()]);
      await loadSelectedSideData(selected);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Refresh failed");
    } finally {
      setBusy(null);
    }
  }

  async function updateReview(body: Record<string, unknown>) {
    if (!selected) return;
    setBusy(String(body.action ?? "review"));
    setError(null);
    try {
      const payload = await jsonFetch<{ review: Review }>(
        `/api/line/scheduler-reviews/${selected.id}`,
        {
          method: "PATCH",
          headers: { "content-type": "application/json" },
          body: JSON.stringify(body),
        },
      );
      setReviews((current) => current.filter((review) => review.id !== payload.review.id));
      setSelectedId((current) => (current === payload.review.id ? null : current));
      await loadReviews();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to update review");
    } finally {
      setBusy(null);
    }
  }

  async function rebuildOperationalPlan(reviewId = selected?.id) {
    if (!reviewId) return;
    setBusy("rebuild-plan");
    setError(null);
    try {
      const payload = await jsonFetch<{ review: Review | null }>(
        `/api/line/scheduler-reviews/${reviewId}/operational-plan`,
        { method: "POST" },
      );
      const updated = payload.review;
      if (!updated) throw new Error("Review not found");
      setReviews((current) => current.map((review) => (
        review.id === updated.id ? updated : review
      )));
      setSelectedId(updated.id);
      setDraft(updated.finalText ?? updated.proposedDraft ?? "");
      setSelectedSessionIds(new Set(updated.adminSelectedSessionIds ?? []));
      await loadSelectedSideData(updated);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to rebuild operational plan");
    } finally {
      setBusy(null);
    }
  }

  async function updateLink(linkId: string, action: "verify" | "reject") {
    if (!selected) return;
    setBusy(`link-${linkId}`);
    setError(null);
    try {
      const payload = await jsonFetch<{ links: StudentLink[] }>(
        `/api/line/contacts/${selected.contactId}/student-links`,
        {
          method: "PATCH",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ linkId, action }),
        },
      );
      setLinks(payload.links);
      if (action === "verify" && selected.intentType !== "new_request") {
        await rebuildOperationalPlan(selected.id);
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to update student link");
    } finally {
      setBusy(null);
    }
  }

  async function saveContactLabel() {
    if (!selected || !labelInput.trim()) return;
    setBusy("label");
    setError(null);
    try {
      const payload = await jsonFetch<{ links: StudentLink[] }>(
        `/api/line/contacts/${selected.contactId}`,
        {
          method: "PATCH",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ linkedStudentLabel: labelInput.trim() }),
        },
      );
      setLinks(payload.links);
      setLabelInput("");
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to save contact label");
    } finally {
      setBusy(null);
    }
  }

  async function addStudentLink(studentKey: string) {
    if (!selected) return;
    setBusy(`add-${studentKey}`);
    setError(null);
    try {
      const payload = await jsonFetch<{ links: StudentLink[] }>(
        `/api/line/contacts/${selected.contactId}/student-links`,
        {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ studentKey }),
        },
      );
      setLinks(payload.links);
      setStudentSearch("");
      setStudentResults([]);
      if (selected.intentType !== "new_request") {
        await rebuildOperationalPlan(selected.id);
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to add student link");
    } finally {
      setBusy(null);
    }
  }

  async function confirmWiseAction(action: ProposedWiseAction) {
    if (!selected) return;
    setBusy(`action-${action.id}`);
    setError(null);
    try {
      const payload = await jsonFetch<{ log: WiseActionLog }>(
        `/api/line/scheduler-reviews/${selected.id}/wise-actions`,
        {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({
            actionId: action.id,
            selectedSessionIds: Array.from(selectedSessionIds),
          }),
        },
      );
      setLogs((current) => [payload.log, ...current]);
      await loadReviews();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to confirm Wise action");
    } finally {
      setBusy(null);
    }
  }

  function toggleSession(sessionId: string) {
    setSelectedSessionIds((current) => {
      const next = new Set(current);
      if (next.has(sessionId)) next.delete(sessionId);
      else next.add(sessionId);
      return next;
    });
  }

  const studentLinkCommand = (
    <StudentLinkCommand
      open={studentLinkOpen}
      onOpenChange={setStudentLinkOpen}
      labelInput={labelInput}
      onLabelInputChange={setLabelInput}
      onParseLabel={saveContactLabel}
      studentSearch={studentSearch}
      onStudentSearchChange={setStudentSearch}
      studentResults={studentResults}
      links={links}
      onAddStudentLink={addStudentLink}
      onUpdateLink={updateLink}
      busy={busy}
    />
  );

  return (
    <main className="flex h-[calc(100vh-2.75rem)] flex-col overflow-hidden bg-background">
      <CaseHeader
        selected={selected}
        links={links}
        analytics={analytics}
        falseNegativeCount={falseNegatives.length}
        logCount={logs.length}
        busy={busy}
        loading={loading}
        onRefresh={refreshAll}
        onRebuild={() => rebuildOperationalPlan(selected?.id)}
        onOpenSignals={() => setSignalsOpen(true)}
        aliasImportCommand={(
          <>
            <Button
              type="button"
              size="sm"
              variant="default"
              onClick={() => setOaResolverOpen(true)}
            >
              <ScanSearch />
              Bulk OA resolver
            </Button>
            <Button
              type="button"
              size="sm"
              variant="outline"
              onClick={() => setAliasImportOpen(true)}
            >
              <Upload />
              Screenshot aliases
            </Button>
          </>
        )}
        studentLinkCommand={studentLinkCommand}
      />

      {error ? (
        <div className="shrink-0 border-b border-destructive/30 bg-destructive/10 px-4 py-2 text-sm text-destructive lg:px-5">
          {error}
        </div>
      ) : null}

      <div className="grid min-h-0 flex-1 grid-cols-1 overflow-hidden lg:grid-cols-[310px_minmax(0,1fr)]">
        <ReviewQueue
          reviews={reviews}
          selected={selected}
          links={links}
          loading={loading}
          intentFilter={intentFilter}
          onIntentFilterChange={setIntentFilter}
          onSelect={setSelectedId}
          className="hidden lg:flex"
        />

        <section className="flex min-h-0 flex-col overflow-hidden bg-background">
          {!selected ? (
            <div className="flex min-h-0 flex-1 items-center justify-center p-6">
              {loading ? (
                <div className="flex items-center text-sm text-muted-foreground">
                  <Loader2 className="mr-2 size-4 animate-spin" />
                  Loading reviews
                </div>
              ) : (
                <EmptyState
                  title="No review selected"
                  detail="Select a pending LINE review to validate the AI response and operational suggestion."
                />
              )}
            </div>
          ) : (
            <>
              <div className="grid min-h-0 flex-1 grid-cols-1 overflow-hidden 2xl:grid-cols-[minmax(0,1fr)_410px]">
                <div className="min-h-0 overflow-y-auto p-3">
                  <ChatEvidencePanel context={chatContext} selected={selected} />
                  <div className="mt-3 2xl:hidden">
                    <ResolutionBoard
                      selected={selected}
                      links={links}
                      candidates={candidates}
                      actions={actions}
                      selectedSessionIds={selectedSessionIds}
                      busy={busy}
                      onToggleSession={toggleSession}
                      onConfirmWiseAction={confirmWiseAction}
                      onOpenStudentLink={() => setStudentLinkOpen(true)}
                    />
                  </div>
                </div>

                <aside className="hidden min-h-0 overflow-y-auto border-l border-border bg-card/35 p-3 2xl:block">
                  <ResolutionBoard
                    selected={selected}
                    links={links}
                    candidates={candidates}
                    actions={actions}
                    selectedSessionIds={selectedSessionIds}
                    busy={busy}
                    onToggleSession={toggleSession}
                    onConfirmWiseAction={confirmWiseAction}
                    onOpenStudentLink={() => setStudentLinkOpen(true)}
                  />
                </aside>
              </div>

              <ReplyDock
                draft={draft}
                onDraftChange={setDraft}
                rejectCorrection={rejectCorrection}
                onRejectCorrectionChange={setRejectCorrection}
                rejectReason={rejectReason}
                onRejectReasonChange={setRejectReason}
                busy={busy}
                onReject={() => updateReview({
                  action: "reject",
                  reasonCategory: "other",
                  rejectionReason: rejectReason.trim() || "Operational review rejected",
                  staffCorrection: rejectCorrection.trim() || draft.trim() || "Needs manual handling",
                })}
                onAcceptHandled={() => updateReview({ action: "accept_no_send", finalText: draft })}
                onApproveSend={() => updateReview({ action: "approve_send", finalText: draft })}
              />
            </>
          )}
        </section>
      </div>

      <SignalsDialog
        open={signalsOpen}
        onOpenChange={setSignalsOpen}
        analytics={analytics}
        links={links}
        logs={logs}
        falseNegatives={falseNegatives}
        selected={selected}
      />
      <AliasImportDialog
        open={aliasImportOpen}
        onOpenChange={setAliasImportOpen}
        preferredContactId={selected?.contactId ?? null}
        onCommitted={() => {
          void refreshAll();
        }}
      />
      <OaResolverDialog
        open={oaResolverOpen}
        onOpenChange={setOaResolverOpen}
        onCommitted={() => {
          void refreshAll();
        }}
      />
    </main>
  );
}
