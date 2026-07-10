"use client";

// ----------------------------------------------------------------------------
// Recommenders & college documents panel (design §5.1, PRD CM-46/50/51) —
// rendered inside the Colleges tab (the tab that owns the per-college
// completeness rollup the panel's data feeds).
//
// Data arrives as server-fetched props (the page reads listRecommenders +
// listCollegeDocs; the shell passes them down through the Colleges tab); every
// successful mutation calls router.refresh() so the server re-reads Postgres.
//
// Role gates mirror the API (design §2.4): all writes here are counselor+ —
// students see the same data read-only (chips, disabled checkboxes); parents
// never reach this surface (the recommenders GET is student+ and the page
// fetches nothing for them). Ask-status advances follow the forward-only
// machine from the lib (planned → asked → agreed|declined) so the UI only
// offers moves the API would accept. Score-send doc rows require a test
// sitting (CM-46) — until the Testing tab lands (phase 4) they are shown
// read-only as sent counts, never created here.
// ----------------------------------------------------------------------------

import { useCallback, useState } from "react";
import { useRouter } from "next/navigation";
import { Link2Icon, PlusIcon, Trash2Icon } from "lucide-react";

import { cn } from "@/lib/utils";
import { SELECT_FIELD_CLASSES } from "@/components/admissions/field-classes";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { roleAtLeast } from "@/lib/admissions/config";
import {
  RECOMMENDER_ASK_STATUS_TRANSITIONS,
  type AdmissionsCollegeDocType,
  type AdmissionsRecommenderAskStatus,
} from "@/lib/admissions/shared/recommenders";
import type { AdmissionsCollegeDocDto, AdmissionsRecommenderWithCollegesDto } from "@/lib/admissions/recommenders";
import type { CaseRole } from "@/lib/admissions/types";

// ── Pure helpers (exported for tests) ───────────────────────────────────

/** Display labels for the recommender ask lifecycle (CM-50). */
export const ASK_STATUS_LABELS: Record<AdmissionsRecommenderAskStatus, string> = {
  planned: "Planned",
  asked: "Asked",
  agreed: "Agreed",
  declined: "Declined",
};

/** Chip classes per ask status (semantic tokens, design §5.4). */
export const ASK_STATUS_CLASSES: Record<AdmissionsRecommenderAskStatus, string> = {
  planned: "bg-muted text-muted-foreground",
  asked: "bg-primary/10 text-primary",
  agreed: "bg-available/15 text-available",
  declined: "bg-blocked/15 text-blocked",
};

/** Action-button labels for advancing the ask machine ("planned" is the start). */
export const ASK_STATUS_ACTION_LABELS: Record<AdmissionsRecommenderAskStatus, string> = {
  planned: "Mark planned",
  asked: "Mark asked",
  agreed: "Mark agreed",
  declined: "Mark declined",
};

/**
 * The single transcript / school-report doc row for a college, or null when
 * none has been recorded yet. Score sends are per-sitting (multiple rows) —
 * use countScoreSends for those, never this single-row lookup.
 */
export function findCollegeDoc(
  docs: readonly AdmissionsCollegeDocDto[],
  listItemId: string,
  docType: Exclude<AdmissionsCollegeDocType, "score_send">,
): AdmissionsCollegeDocDto | null {
  return (
    docs.find((doc) => doc.listItemId === listItemId && doc.docType === docType) ?? null
  );
}

/** Sent/total tallies of a college's per-sitting score-send doc rows (CM-46). */
export function countScoreSends(
  docs: readonly AdmissionsCollegeDocDto[],
  listItemId: string,
): { sent: number; total: number } {
  let sent = 0;
  let total = 0;
  for (const doc of docs) {
    if (doc.listItemId !== listItemId || doc.docType !== "score_send") continue;
    total += 1;
    if (doc.sent) sent += 1;
  }
  return { sent, total };
}

/** Minimal college shape the panel needs (id + display name). */
export interface RecommenderPanelCollege {
  id: string;
  instName: string;
}

/** Colleges a recommender is NOT yet linked to (the "link college" options). */
export function unlinkedColleges(
  recommender: Pick<AdmissionsRecommenderWithCollegesDto, "colleges">,
  colleges: readonly RecommenderPanelCollege[],
): RecommenderPanelCollege[] {
  const linkedIds = new Set(recommender.colleges.map((link) => link.listItemId));
  return colleges.filter((college) => !linkedIds.has(college.id));
}

// ── Internal helpers ────────────────────────────────────────────────────

const SELECT_CLASSES = cn(SELECT_FIELD_CLASSES, "h-8");

function readErrorMessage(payload: unknown, fallback: string): string {
  if (
    typeof payload === "object" &&
    payload !== null &&
    "error" in payload &&
    typeof (payload as { error?: unknown }).error === "string"
  ) {
    return (payload as { error: string }).error;
  }
  return fallback;
}

// ── Panel ───────────────────────────────────────────────────────────────

/** Props for RecommendersPanel — all data is server-fetched by the page. */
export interface RecommendersPanelProps {
  caseId: string;
  recommenders: AdmissionsRecommenderWithCollegesDto[];
  collegeDocs: AdmissionsCollegeDocDto[];
  /** The case's live college rows (for names + doc/link targets). */
  colleges: RecommenderPanelCollege[];
  viewerRole: CaseRole;
}

/**
 * Recommenders & documents panel (CM-46/50/51): recommender list with
 * ask-status chips and forward-only advances, per-college submission
 * checkboxes, and transcript / school-report send toggles per college.
 * Counselor+ writes; students read-only.
 */
export function RecommendersPanel({
  caseId,
  recommenders,
  collegeDocs,
  colleges,
  viewerRole,
}: RecommendersPanelProps) {
  const router = useRouter();
  const isStaff = roleAtLeast(viewerRole, "counselor");
  const endpoint = `/api/admissions/cases/${caseId}/recommenders`;

  const [actionError, setActionError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [newName, setNewName] = useState("");
  const [newRoleSubject, setNewRoleSubject] = useState("");
  const [newContact, setNewContact] = useState("");
  const [linkSelections, setLinkSelections] = useState<Record<string, string>>({});
  const [pendingDelete, setPendingDelete] =
    useState<AdmissionsRecommenderWithCollegesDto | null>(null);

  const collegeNameById = new Map(colleges.map((college) => [college.id, college.instName]));

  const runMutation = useCallback(
    async (request: () => Promise<Response>, fallback: string): Promise<boolean> => {
      setActionError(null);
      setBusy(true);
      try {
        const response = await request();
        const payload: unknown = await response.json().catch(() => null);
        if (!response.ok) {
          setActionError(readErrorMessage(payload, fallback));
          return false;
        }
        router.refresh();
        return true;
      } catch (error) {
        setActionError(error instanceof Error ? error.message : fallback);
        return false;
      } finally {
        setBusy(false);
      }
    },
    [router],
  );

  const handleCreate = useCallback(async () => {
    if (!newName.trim()) {
      setActionError("Recommender name is required.");
      return;
    }
    const created = await runMutation(
      () =>
        fetch(endpoint, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            name: newName.trim(),
            roleSubject: newRoleSubject.trim() || null,
            contact: newContact.trim() || null,
          }),
        }),
      "Failed to add the recommender.",
    );
    if (created) {
      setNewName("");
      setNewRoleSubject("");
      setNewContact("");
    }
  }, [endpoint, newName, newRoleSubject, newContact, runMutation]);

  const handleAskStatus = useCallback(
    (recommenderId: string, askStatus: AdmissionsRecommenderAskStatus) =>
      runMutation(
        () =>
          fetch(endpoint, {
            method: "PATCH",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ action: "update", recommenderId, askStatus }),
          }),
        "Failed to update the ask status.",
      ),
    [endpoint, runMutation],
  );

  const handleLink = useCallback(
    async (recommenderId: string) => {
      const listItemId = linkSelections[recommenderId];
      if (!listItemId) return;
      const linked = await runMutation(
        () =>
          fetch(endpoint, {
            method: "PATCH",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ action: "link", recommenderId, listItemId }),
          }),
        "Failed to link the college.",
      );
      if (linked) {
        setLinkSelections((previous) => ({ ...previous, [recommenderId]: "" }));
      }
    },
    [endpoint, linkSelections, runMutation],
  );

  const handleSubmission = useCallback(
    (recommenderId: string, listItemId: string, submitted: boolean) =>
      runMutation(
        () =>
          fetch(endpoint, {
            method: "PATCH",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ action: "submission", recommenderId, listItemId, submitted }),
          }),
        "Failed to update the submission.",
      ),
    [endpoint, runMutation],
  );

  const handleDocToggle = useCallback(
    (listItemId: string, docType: "transcript" | "school_report", sent: boolean) =>
      runMutation(
        () =>
          fetch(endpoint, {
            method: "PATCH",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ action: "college_doc", listItemId, docType, sent }),
          }),
        "Failed to update the document status.",
      ),
    [endpoint, runMutation],
  );

  const handleDeleteConfirmed = useCallback(async () => {
    if (!pendingDelete) return;
    const deleted = await runMutation(
      () =>
        fetch(`${endpoint}?recommenderId=${pendingDelete.id}`, { method: "DELETE" }),
      "Failed to remove the recommender.",
    );
    if (deleted) setPendingDelete(null);
  }, [endpoint, pendingDelete, runMutation]);

  return (
    <Card data-testid="recommenders-panel">
      <CardHeader>
        <CardTitle>Recommenders &amp; documents</CardTitle>
        <CardDescription>
          Ask status per recommender, letter submissions per college, and
          transcript / school-report sends (CM-46).
        </CardDescription>
      </CardHeader>
      <CardContent className="space-y-4">
        {actionError ? (
          <p role="alert" className="text-sm text-destructive">
            {actionError}
          </p>
        ) : null}

        {/* ── Add recommender (counselor+) ── */}
        {isStaff ? (
          <form
            onSubmit={(event) => {
              event.preventDefault();
              void handleCreate();
            }}
            className="flex flex-wrap items-end gap-2"
          >
            <label className="min-w-40 flex-1 space-y-1 text-xs font-medium text-foreground">
              Name
              <span aria-hidden className="text-destructive">
                {" "}
                *
              </span>
              <Input
                value={newName}
                data-testid="recommender-name-input"
                onChange={(event) => setNewName(event.target.value)}
              />
            </label>
            <label className="min-w-32 flex-1 space-y-1 text-xs font-medium text-foreground">
              Role / subject
              <Input
                value={newRoleSubject}
                onChange={(event) => setNewRoleSubject(event.target.value)}
              />
            </label>
            <label className="min-w-32 flex-1 space-y-1 text-xs font-medium text-foreground">
              Contact
              <Input
                value={newContact}
                onChange={(event) => setNewContact(event.target.value)}
              />
            </label>
            <Button type="submit" size="sm" disabled={busy} data-testid="recommender-add">
              <PlusIcon aria-hidden />
              Add recommender
            </Button>
          </form>
        ) : null}

        {/* ── Recommender list ── */}
        {recommenders.length > 0 ? (
          <ul className="space-y-3">
            {recommenders.map((recommender) => {
              const linkable = unlinkedColleges(recommender, colleges);
              const nextStatuses = RECOMMENDER_ASK_STATUS_TRANSITIONS[recommender.askStatus];
              return (
                <li
                  key={recommender.id}
                  data-testid="recommender-row"
                  className="space-y-2 rounded-lg border border-border/60 p-3"
                >
                  <div className="flex flex-wrap items-center gap-2">
                    <span className="text-sm font-medium text-foreground">
                      {recommender.name}
                    </span>
                    {recommender.roleSubject ? (
                      <span className="text-xs text-muted-foreground">
                        {recommender.roleSubject}
                      </span>
                    ) : null}
                    <Badge
                      data-testid={`ask-status-${recommender.id}`}
                      className={ASK_STATUS_CLASSES[recommender.askStatus]}
                    >
                      {ASK_STATUS_LABELS[recommender.askStatus]}
                    </Badge>
                    {isStaff ? (
                      <span className="ml-auto flex items-center gap-1">
                        {nextStatuses.map((status) => (
                          <Button
                            key={status}
                            size="xs"
                            variant="outline"
                            disabled={busy}
                            onClick={() => void handleAskStatus(recommender.id, status)}
                          >
                            {ASK_STATUS_ACTION_LABELS[status]}
                          </Button>
                        ))}
                        <Button
                          size="icon-sm"
                          variant="ghost"
                          disabled={busy}
                          aria-label={`Remove recommender ${recommender.name}`}
                          onClick={() => setPendingDelete(recommender)}
                        >
                          <Trash2Icon aria-hidden />
                        </Button>
                      </span>
                    ) : null}
                  </div>
                  {recommender.contact ? (
                    <p className="text-xs text-muted-foreground">{recommender.contact}</p>
                  ) : null}

                  {/* Per-college submission checkboxes (CM-51). */}
                  {recommender.colleges.length > 0 ? (
                    <ul className="flex flex-wrap gap-x-4 gap-y-1">
                      {recommender.colleges.map((link) => (
                        <li key={link.id} className="flex items-center gap-1.5 text-sm">
                          <input
                            type="checkbox"
                            className="size-4 accent-primary"
                            data-testid={`submission-${recommender.id}-${link.listItemId}`}
                            checked={link.submitted}
                            disabled={!isStaff || busy}
                            onChange={() =>
                              void handleSubmission(
                                recommender.id,
                                link.listItemId,
                                !link.submitted,
                              )
                            }
                            aria-label={`Letter submitted to ${
                              collegeNameById.get(link.listItemId) ?? "college"
                            }`}
                          />
                          <span
                            className={cn(
                              link.submitted ? "text-foreground" : "text-muted-foreground",
                            )}
                          >
                            {collegeNameById.get(link.listItemId) ?? "Removed college"}
                          </span>
                        </li>
                      ))}
                    </ul>
                  ) : (
                    <p className="text-xs text-muted-foreground">
                      Not linked to any college yet.
                    </p>
                  )}

                  {/* Link to a college (counselor+). */}
                  {isStaff && linkable.length > 0 ? (
                    <div className="flex items-center gap-2">
                      <select
                        className={cn(SELECT_CLASSES, "min-w-44")}
                        value={linkSelections[recommender.id] ?? ""}
                        data-testid={`link-select-${recommender.id}`}
                        aria-label={`Link ${recommender.name} to a college`}
                        onChange={(event) =>
                          setLinkSelections((previous) => ({
                            ...previous,
                            [recommender.id]: event.target.value,
                          }))
                        }
                      >
                        <option value="">Link a college…</option>
                        {linkable.map((college) => (
                          <option key={college.id} value={college.id}>
                            {college.instName}
                          </option>
                        ))}
                      </select>
                      <Button
                        size="xs"
                        variant="outline"
                        disabled={busy || !linkSelections[recommender.id]}
                        onClick={() => void handleLink(recommender.id)}
                      >
                        <Link2Icon aria-hidden />
                        Link
                      </Button>
                    </div>
                  ) : null}
                </li>
              );
            })}
          </ul>
        ) : (
          <p className="text-sm text-muted-foreground">
            {isStaff
              ? "No recommenders yet. Add the first recommender above."
              : "No recommenders recorded yet."}
          </p>
        )}

        {/* ── College documents (transcript / school report / score sends) ── */}
        {colleges.length > 0 ? (
          <div className="space-y-2">
            <h3 className="text-sm font-semibold text-foreground">
              Documents per college
            </h3>
            <ul className="space-y-1.5">
              {colleges.map((college) => {
                const transcript = findCollegeDoc(collegeDocs, college.id, "transcript");
                const schoolReport = findCollegeDoc(collegeDocs, college.id, "school_report");
                const scoreSends = countScoreSends(collegeDocs, college.id);
                return (
                  <li
                    key={college.id}
                    className="flex flex-wrap items-center gap-x-4 gap-y-1 rounded-lg border border-border/60 px-3 py-2 text-sm"
                  >
                    <span className="min-w-0 flex-1 truncate font-medium text-foreground">
                      {college.instName}
                    </span>
                    <label className="flex items-center gap-1.5 text-xs text-muted-foreground">
                      <input
                        type="checkbox"
                        className="size-4 accent-primary"
                        data-testid={`doc-transcript-${college.id}`}
                        checked={transcript?.sent ?? false}
                        disabled={!isStaff || busy}
                        onChange={() =>
                          void handleDocToggle(
                            college.id,
                            "transcript",
                            !(transcript?.sent ?? false),
                          )
                        }
                        aria-label={`Transcript sent to ${college.instName}`}
                      />
                      Transcript
                    </label>
                    <label className="flex items-center gap-1.5 text-xs text-muted-foreground">
                      <input
                        type="checkbox"
                        className="size-4 accent-primary"
                        data-testid={`doc-school-report-${college.id}`}
                        checked={schoolReport?.sent ?? false}
                        disabled={!isStaff || busy}
                        onChange={() =>
                          void handleDocToggle(
                            college.id,
                            "school_report",
                            !(schoolReport?.sent ?? false),
                          )
                        }
                        aria-label={`School report sent to ${college.instName}`}
                      />
                      School report
                    </label>
                    <span
                      className="text-xs text-muted-foreground"
                      data-testid={`score-sends-${college.id}`}
                    >
                      Score sends: {scoreSends.total === 0
                        ? "none recorded"
                        : `${scoreSends.sent}/${scoreSends.total} sent`}
                    </span>
                  </li>
                );
              })}
            </ul>
            <p className="text-xs text-muted-foreground">
              Score sends are recorded per test sitting from the Testing tab.
            </p>
          </div>
        ) : null}
      </CardContent>

      {/* ── Delete confirmation (destructive action guard) ── */}
      <Dialog
        open={pendingDelete !== null}
        onOpenChange={(open) => {
          if (!open) setPendingDelete(null);
        }}
      >
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Remove this recommender?</DialogTitle>
            <DialogDescription>
              {pendingDelete
                ? `"${pendingDelete.name}" will stop counting toward every college's completeness. The audit history is kept.`
                : ""}
            </DialogDescription>
          </DialogHeader>
          <DialogFooter>
            <Button
              variant="outline"
              size="sm"
              onClick={() => setPendingDelete(null)}
              disabled={busy}
            >
              Keep recommender
            </Button>
            <Button
              variant="destructive"
              size="sm"
              onClick={() => void handleDeleteConfirmed()}
              disabled={busy}
            >
              Remove recommender
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </Card>
  );
}
