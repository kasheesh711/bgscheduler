"use client";

// ----------------------------------------------------------------------------
// Admissions Applications tab (design §5.1, PRD CM-43/44) — replaces the
// phase-3 placeholder in case-detail-shell.tsx.
//
// Per-college decision timelines render the append-only CM-43 event chains
// (server-fetched by the page, oldest first — deferred → accepted stays two
// visible rows). Counselors append dated events through a per-college inline
// form; "committed" is deliberately NOT in that form — it routes through the
// committed selector, whose confirm dialog makes the CM-44 semantics explicit
// ("this marks the final matriculation choice") before POSTing the committed
// event (the API moves the case pointer + appends the event in one
// transaction). A second commit while another college holds the pointer is a
// 409 — the selector disables itself once a committed college exists.
//
// Role gates mirror the API (design §2.4): event appends and the committed
// selector are counselor+; students see the timelines read-only. Parents
// never reach this surface (the events GET is student+).
// ----------------------------------------------------------------------------

import { useCallback, useMemo, useState } from "react";
import { useRouter } from "next/navigation";
import {
  CheckCircle2Icon,
  ClockIcon,
  HourglassIcon,
  PlusIcon,
  SendIcon,
  TrophyIcon,
  Undo2Icon,
  XCircleIcon,
} from "lucide-react";

import { cn } from "@/lib/utils";
import { SELECT_FIELD_CLASSES } from "@/components/admissions/field-classes";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import {
  Card,
  CardAction,
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
import { Textarea } from "@/components/ui/textarea";
import { roleAtLeast } from "@/lib/admissions/config";
import { ADMISSIONS_APP_ROUND_LABELS } from "@/lib/admissions/colleges";
import { todayBangkok } from "@/lib/room-capacity/dates";
import type {
  AdmissionsApplicationEventDto,
  AdmissionsCollegeListRowDto,
  AdmissionsDecisionEvent,
} from "@/lib/admissions/colleges";
import type { CaseRole } from "@/lib/admissions/types";

// ── Pure helpers (exported for tests) ───────────────────────────────────

/** Display labels for decision events (CM-43 chains + the CM-44 commit). */
export const DECISION_EVENT_LABELS: Record<AdmissionsDecisionEvent, string> = {
  submitted: "Submitted",
  deferred: "Deferred",
  waitlisted: "Waitlisted",
  accepted: "Accepted",
  denied: "Denied",
  withdrawn: "Withdrawn",
  committed: "Committed",
};

/** Icon color per event type (semantic status tokens, design §5.4). */
export const DECISION_EVENT_ICON_CLASSES: Record<AdmissionsDecisionEvent, string> = {
  submitted: "text-primary",
  deferred: "text-conflict",
  waitlisted: "text-conflict",
  accepted: "text-available",
  denied: "text-blocked",
  withdrawn: "text-muted-foreground",
  committed: "text-available",
};

/**
 * Event types the append form offers — every decision event EXCEPT
 * "committed", which must route through the committed selector (CM-44: the
 * pointer move and the event commit in one transaction server-side).
 */
export const APPEND_EVENT_TYPES: readonly Exclude<
  AdmissionsDecisionEvent,
  "committed"
>[] = ["submitted", "deferred", "waitlisted", "accepted", "denied", "withdrawn"];

/**
 * Sorts a decision chain oldest-first (eventDate asc, createdAt asc tiebreak
 * for same-day events) without mutating the input — the timeline render
 * order (CM-43). Both keys compare lexicographically ("YYYY-MM-DD" / ISO).
 */
export function sortEventsAscending(
  events: readonly AdmissionsApplicationEventDto[],
): AdmissionsApplicationEventDto[] {
  return [...events].sort((a, b) => {
    if (a.eventDate !== b.eventDate) return a.eventDate < b.eventDate ? -1 : 1;
    if (a.createdAt !== b.createdAt) return a.createdAt < b.createdAt ? -1 : 1;
    return 0;
  });
}

/** Confirm-dialog copy for marking a college committed (CM-44). */
export const COMMITTED_CONFIRM_MESSAGE =
  "This marks the final matriculation choice.";

/**
 * True when the committed selector may open the confirm dialog: a college is
 * selected AND no college is committed yet (a second commit would 409 —
 * CM-44 allows exactly one committed college per case).
 */
export function canRequestCommit(
  selectedItemId: string,
  committedListItemId: string | null,
): boolean {
  return selectedItemId !== "" && committedListItemId === null;
}

// ── Internal helpers ────────────────────────────────────────────────────

const SELECT_CLASSES = cn(SELECT_FIELD_CLASSES, "h-8");

/** "YYYY-MM-DD" → "D/M/YYYY" (repo-wide D/M convention); non-dates pass through. */
function formatDateOnly(value: string): string {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(value);
  if (!match) return value;
  return `${Number(match[3])}/${Number(match[2])}/${match[1]}`;
}

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

function EventIcon({ event }: { event: AdmissionsDecisionEvent }) {
  const className = cn("size-4 shrink-0", DECISION_EVENT_ICON_CLASSES[event]);
  switch (event) {
    case "submitted":
      return <SendIcon aria-hidden className={className} />;
    case "deferred":
      return <ClockIcon aria-hidden className={className} />;
    case "waitlisted":
      return <HourglassIcon aria-hidden className={className} />;
    case "accepted":
      return <CheckCircle2Icon aria-hidden className={className} />;
    case "denied":
      return <XCircleIcon aria-hidden className={className} />;
    case "withdrawn":
      return <Undo2Icon aria-hidden className={className} />;
    case "committed":
      return <TrophyIcon aria-hidden className={className} />;
  }
}

interface AppendEventFormValues {
  event: Exclude<AdmissionsDecisionEvent, "committed">;
  eventDate: string;
  notes: string;
}

// ── Applications tab ────────────────────────────────────────────────────

/** Props for ApplicationsTab — all data is server-fetched by the page. */
export interface ApplicationsTabProps {
  caseId: string;
  /** caseDetail.collegeList (the timelines hang off these rows). */
  colleges: AdmissionsCollegeListRowDto[];
  /** caseDetail.committedListItemId (CM-44 pointer). */
  committedListItemId: string | null;
  /** caseDetail.committedCollegeName (denormalized display name). */
  committedCollegeName: string | null;
  /** Decision chains keyed by list item id; empty for parent viewers. */
  eventsByItem: Record<string, AdmissionsApplicationEventDto[]>;
  viewerRole: CaseRole;
}

/**
 * Applications tab (design §5.1): per-college decision-event timelines
 * (CM-43, append-only, oldest first), a counselor append-event form, and the
 * committed-college selector with its confirm dialog (CM-44).
 */
export function ApplicationsTab({
  caseId,
  colleges,
  committedListItemId,
  committedCollegeName,
  eventsByItem,
  viewerRole,
}: ApplicationsTabProps) {
  const router = useRouter();
  const isStaff = roleAtLeast(viewerRole, "counselor");
  const todayIso = useMemo(() => todayBangkok(), []);

  const [actionError, setActionError] = useState<string | null>(null);
  // null = no append form open; otherwise the list item id being appended to.
  const [appendTarget, setAppendTarget] = useState<string | null>(null);
  const [appendForm, setAppendForm] = useState<AppendEventFormValues>({
    event: "submitted",
    eventDate: todayIso,
    notes: "",
  });
  const [appendSaving, setAppendSaving] = useState(false);

  // ── Committed selector state ──
  const [commitSelection, setCommitSelection] = useState("");
  const [commitConfirmOpen, setCommitConfirmOpen] = useState(false);
  const [commitSaving, setCommitSaving] = useState(false);

  const openAppendForm = useCallback(
    (itemId: string) => {
      setAppendTarget(itemId);
      setAppendForm({ event: "submitted", eventDate: todayIso, notes: "" });
      setActionError(null);
    },
    [todayIso],
  );

  const handleAppendSubmit = useCallback(async () => {
    if (!appendTarget) return;
    if (!appendForm.eventDate) {
      setActionError("An event date is required.");
      return;
    }
    setAppendSaving(true);
    setActionError(null);
    try {
      const response = await fetch(
        `/api/admissions/cases/${caseId}/colleges/${appendTarget}/events`,
        {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            event: appendForm.event,
            eventDate: appendForm.eventDate,
            notes: appendForm.notes.trim() || null,
          }),
        },
      );
      const payload: unknown = await response.json().catch(() => null);
      if (!response.ok) {
        setActionError(readErrorMessage(payload, "Failed to record the event."));
        return;
      }
      setAppendTarget(null);
      router.refresh();
    } catch (error) {
      setActionError(
        error instanceof Error ? error.message : "Failed to record the event.",
      );
    } finally {
      setAppendSaving(false);
    }
  }, [appendTarget, appendForm, caseId, router]);

  const handleCommitConfirmed = useCallback(async () => {
    if (!commitSelection) return;
    setCommitSaving(true);
    setActionError(null);
    try {
      const response = await fetch(
        `/api/admissions/cases/${caseId}/colleges/${commitSelection}/events`,
        {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ event: "committed", eventDate: todayIso }),
        },
      );
      const payload: unknown = await response.json().catch(() => null);
      if (response.status === 409) {
        setActionError(
          "Another college is already committed on this case — only one committed college is allowed.",
        );
        return;
      }
      if (!response.ok) {
        setActionError(readErrorMessage(payload, "Failed to mark the college committed."));
        return;
      }
      setCommitConfirmOpen(false);
      setCommitSelection("");
      router.refresh();
    } catch (error) {
      setActionError(
        error instanceof Error ? error.message : "Failed to mark the college committed.",
      );
    } finally {
      setCommitSaving(false);
    }
  }, [commitSelection, caseId, todayIso, router]);

  const committedName =
    committedCollegeName ??
    colleges.find((row) => row.id === committedListItemId)?.instName ??
    null;
  const commitCandidate = colleges.find((row) => row.id === commitSelection) ?? null;

  return (
    <div className="space-y-4">
      {actionError ? (
        <p role="alert" className="text-sm text-destructive">
          {actionError}
        </p>
      ) : null}

      {/* ── Committed college (CM-44) ── */}
      <Card>
        <CardHeader>
          <CardTitle>Committed college</CardTitle>
          <CardDescription>
            Exactly one college can be committed per case — the final
            matriculation choice.
          </CardDescription>
        </CardHeader>
        <CardContent className="space-y-2">
          {committedListItemId !== null ? (
            <p
              data-testid="committed-banner"
              className="flex items-center gap-2 rounded-lg border border-available/40 bg-available/10 p-3 text-sm font-medium text-foreground"
            >
              <TrophyIcon aria-hidden className="size-4 shrink-0 text-available" />
              Committed to {committedName ?? "a college on this list"}
            </p>
          ) : isStaff ? (
            <div className="flex flex-wrap items-center gap-2">
              <select
                className={cn(SELECT_CLASSES, "min-w-56")}
                value={commitSelection}
                data-testid="committed-select"
                aria-label="Choose the committed college"
                onChange={(event) => setCommitSelection(event.target.value)}
              >
                <option value="">Choose a college…</option>
                {colleges.map((row) => (
                  <option key={row.id} value={row.id}>
                    {row.instName}
                  </option>
                ))}
              </select>
              <Button
                size="sm"
                data-testid="committed-request"
                disabled={!canRequestCommit(commitSelection, committedListItemId)}
                onClick={() => setCommitConfirmOpen(true)}
              >
                <TrophyIcon aria-hidden />
                Mark as committed
              </Button>
            </div>
          ) : (
            <p className="text-sm text-muted-foreground">
              No committed college yet.
            </p>
          )}
        </CardContent>
      </Card>

      {/* ── Per-college decision timelines (CM-43) ── */}
      {colleges.length === 0 ? (
        <Card>
          <CardContent>
            <p className="text-sm text-muted-foreground">
              No colleges on the list yet — add them in the Colleges tab to
              start tracking decisions.
            </p>
          </CardContent>
        </Card>
      ) : (
        colleges.map((row) => {
          const events = sortEventsAscending(eventsByItem[row.id] ?? []);
          const isAppending = appendTarget === row.id;
          return (
            <Card key={row.id} data-testid={`application-card-${row.id}`}>
              <CardHeader>
                <CardTitle className="flex flex-wrap items-center gap-2 text-sm">
                  {row.instName}
                  <Badge variant="outline">
                    {ADMISSIONS_APP_ROUND_LABELS[row.round]}
                  </Badge>
                  {row.id === committedListItemId ? (
                    <Badge className="bg-available/15 text-available">
                      <TrophyIcon aria-hidden />
                      Committed
                    </Badge>
                  ) : null}
                </CardTitle>
                {row.deadline ? (
                  <CardDescription>
                    Deadline {formatDateOnly(row.deadline)}
                  </CardDescription>
                ) : null}
                {isStaff && !isAppending ? (
                  <CardAction>
                    <Button
                      size="xs"
                      variant="outline"
                      data-testid={`add-event-${row.id}`}
                      onClick={() => openAppendForm(row.id)}
                    >
                      <PlusIcon aria-hidden />
                      Add event
                    </Button>
                  </CardAction>
                ) : null}
              </CardHeader>
              <CardContent className="space-y-3">
                {events.length > 0 ? (
                  <ol data-testid={`timeline-${row.id}`} className="space-y-2">
                    {events.map((event) => (
                      <li key={event.id} className="flex items-start gap-2 text-sm">
                        <EventIcon event={event.event} />
                        <div className="min-w-0">
                          <p>
                            <span className="font-medium text-foreground">
                              {DECISION_EVENT_LABELS[event.event]}
                            </span>{" "}
                            <span className="text-xs text-muted-foreground tabular-nums">
                              {formatDateOnly(event.eventDate)}
                            </span>
                          </p>
                          {event.notes ? (
                            <p className="text-xs whitespace-pre-wrap text-muted-foreground">
                              {event.notes}
                            </p>
                          ) : null}
                        </div>
                      </li>
                    ))}
                  </ol>
                ) : (
                  <p className="text-sm text-muted-foreground">
                    No decision events yet.
                  </p>
                )}

                {isAppending ? (
                  <form
                    onSubmit={(event) => {
                      event.preventDefault();
                      void handleAppendSubmit();
                    }}
                    className="space-y-2 rounded-lg border border-border p-3"
                  >
                    <div className="flex flex-wrap items-end gap-2">
                      <label className="space-y-1 text-xs font-medium text-foreground">
                        Event
                        <select
                          className={cn(SELECT_CLASSES, "block min-w-36")}
                          value={appendForm.event}
                          onChange={(event) =>
                            setAppendForm((previous) => ({
                              ...previous,
                              event: event.target
                                .value as AppendEventFormValues["event"],
                            }))
                          }
                        >
                          {APPEND_EVENT_TYPES.map((eventType) => (
                            <option key={eventType} value={eventType}>
                              {DECISION_EVENT_LABELS[eventType]}
                            </option>
                          ))}
                        </select>
                      </label>
                      <label className="space-y-1 text-xs font-medium text-foreground">
                        Date
                        <Input
                          type="date"
                          className="w-36"
                          required
                          value={appendForm.eventDate}
                          onChange={(event) =>
                            setAppendForm((previous) => ({
                              ...previous,
                              eventDate: event.target.value,
                            }))
                          }
                        />
                      </label>
                    </div>
                    <label className="block space-y-1 text-xs font-medium text-foreground">
                      Notes
                      <Textarea
                        value={appendForm.notes}
                        onChange={(event) =>
                          setAppendForm((previous) => ({
                            ...previous,
                            notes: event.target.value,
                          }))
                        }
                      />
                    </label>
                    <div className="flex gap-2">
                      <Button type="submit" size="sm" disabled={appendSaving}>
                        {appendSaving ? "Saving…" : "Record event"}
                      </Button>
                      <Button
                        type="button"
                        size="sm"
                        variant="ghost"
                        disabled={appendSaving}
                        onClick={() => setAppendTarget(null)}
                      >
                        Cancel
                      </Button>
                    </div>
                  </form>
                ) : null}
              </CardContent>
            </Card>
          );
        })
      )}

      {/* ── Committed confirmation (CM-44 destructive-adjacent guard) ── */}
      <Dialog open={commitConfirmOpen} onOpenChange={setCommitConfirmOpen}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>
              Commit to {commitCandidate?.instName ?? "this college"}?
            </DialogTitle>
            <DialogDescription data-testid="committed-confirm-message">
              {COMMITTED_CONFIRM_MESSAGE} The case gets exactly one committed
              college, and a &quot;Committed&quot; event is added to its
              decision history.
            </DialogDescription>
          </DialogHeader>
          <DialogFooter>
            <Button
              variant="outline"
              size="sm"
              onClick={() => setCommitConfirmOpen(false)}
              disabled={commitSaving}
            >
              Cancel
            </Button>
            <Button
              size="sm"
              data-testid="committed-confirm"
              onClick={() => void handleCommitConfirmed()}
              disabled={commitSaving}
            >
              {commitSaving ? "Committing…" : "Confirm commitment"}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}
