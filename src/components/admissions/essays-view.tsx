"use client";

// ----------------------------------------------------------------------------
// Admissions Essays view (design §5.1 Essays tab + §5.2 student portal slot,
// PRD CM-60..CM-63) — one role-aware component serving both surfaces:
//
// - variant "student": mobile-first single-column cards (≥44px targets) for
//   the portal's Essays view.
// - variant "staff": a denser table for the case-detail Essays tab.
//
// Rows render in the ORDER THE LIB RETURNS THEM (listEssaysForCase's CM-63
// "deadline proximity × staleness" urgency sort) — this component never
// re-sorts. Each row shows the CM-61 staleness badge ("Updated N days ago" /
// "Never updated", amber at ≥14 days or never), a deadline chip (overdue in
// conflict color while the effective stage is not "final"), the Drive
// link-out (driveUrl is a pointer — writing stays in Google Docs, CM-60), and
// the CM-62 counselor-confirmed stage (a read-only badge when set; staff see
// an editable select).
//
// Write surface (design §2.4): the status select is the student self-report
// surface — students and staff may change it (a staff change is a counselor
// override, attributed via the audit actorRole server-side). counselorStage
// is counselor+ only and the add form's deadline field is staff-only; both
// are gated by roleAtLeast(viewerRole, "counselor") regardless of variant
// (fail-closed — a staff layout rendered for a student still hides them).
// Parents never get editable controls. Every PATCH carries the row's
// updatedAt as the §6 optimistic-concurrency token; a 409 surfaces a
// conflict message and refreshes to the latest server values.
// ----------------------------------------------------------------------------

import { useCallback, useMemo, useState } from "react";
import { useRouter } from "next/navigation";
import { ExternalLinkIcon, PenLineIcon, PlusIcon } from "lucide-react";

import { cn } from "@/lib/utils";
import { Badge } from "@/components/ui/badge";
import { Button, buttonVariants } from "@/components/ui/button";
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
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { Textarea } from "@/components/ui/textarea";
import { SELECT_FIELD_CLASSES } from "@/components/admissions/field-classes";
import { roleAtLeast } from "@/lib/admissions/config";
import {
  ADMISSIONS_ESSAY_STATUSES,
  type AdmissionsEssayStatus,
} from "@/lib/admissions/shared/essays";
import { todayBangkok } from "@/lib/room-capacity/dates";
import type { AdmissionsEssayListRowDto } from "@/lib/admissions/essays";
import type { CaseRole } from "@/lib/admissions/types";
import { EssayPromptChooser } from "./essay-prompt-chooser";

// ── Pure helpers (exported for tests) ───────────────────────────────────

/** Display labels for essay stages (CM-60 status + CM-62 counselor stage). */
export const ESSAY_STATUS_LABELS: Record<AdmissionsEssayStatus, string> = {
  not_started: "Not started",
  brainstorming: "Brainstorming",
  drafting: "Drafting",
  feedback: "Feedback",
  final: "Final",
};

/** Staleness (whole days) at which the CM-61 badge turns amber. */
export const ESSAY_STALENESS_AMBER_DAYS = 14;

/**
 * CM-61 staleness badge copy: "Never updated" when the student never touched
 * the row (null), "Updated today" at 0 days, else "Updated N day(s) ago".
 */
export function formatStalenessLabel(stalenessDays: number | null): string {
  if (stalenessDays === null) return "Never updated";
  if (stalenessDays === 0) return "Updated today";
  return `Updated ${stalenessDays} day${stalenessDays === 1 ? "" : "s"} ago`;
}

/**
 * True when the CM-61 badge should render amber: the student never updated
 * the row (null counts as most stale — mirrors the CM-63 comparator) or the
 * last update is ≥ ESSAY_STALENESS_AMBER_DAYS days old.
 */
export function isStalenessAmber(stalenessDays: number | null): boolean {
  return stalenessDays === null || stalenessDays >= ESSAY_STALENESS_AMBER_DAYS;
}

/**
 * True when the deadline chip should render in conflict color: a dated essay
 * whose deadline is strictly before today while the effective stage is not
 * "final" (a finished essay is never "overdue").
 */
export function isEssayOverdue(
  essay: Pick<AdmissionsEssayListRowDto, "deadline" | "effectiveStage">,
  todayIso: string,
): boolean {
  return (
    essay.deadline !== null &&
    essay.deadline < todayIso &&
    essay.effectiveStage !== "final"
  );
}

/** One college option for the add form's link select (a live list item). */
export interface EssayCollegeOption {
  /** admissions_college_list_items id (the essays.listItemId target). */
  id: string;
  instName: string;
}

/** Add-essay form state ("" = not set for the optional fields). */
export interface AddEssayFormValues {
  prompt: string;
  /** Selected college list item id; "" = no linked college. */
  listItemId: string;
  /** "YYYY-MM-DD" from the date input; "" = no deadline (staff-only field). */
  deadline: string;
  driveUrl: string;
}

/** Fresh add-essay form: everything empty. */
export const EMPTY_ADD_ESSAY_FORM: AddEssayFormValues = {
  prompt: "",
  listItemId: "",
  deadline: "",
  driveUrl: "",
};

/** True when the add-essay form may submit: a non-blank prompt (CM-60). */
export function canSubmitAddEssay(values: AddEssayFormValues): boolean {
  return values.prompt.trim().length > 0;
}

/**
 * POST body for /cases/[caseId]/essays from the add form. The deadline is
 * included ONLY for staff callers (design §2.4 — deadline is counselor+; the
 * student form never renders the field, and this omission keeps a student
 * payload clean even if form state carried one). Callers must gate on
 * canSubmitAddEssay first.
 */
export function buildAddEssayPayload(
  values: AddEssayFormValues,
  isStaff: boolean,
): Record<string, unknown> {
  const payload: Record<string, unknown> = {
    prompt: values.prompt.trim(),
    driveUrl: values.driveUrl.trim() || null,
  };
  if (isStaff) {
    payload.listItemId = values.listItemId || null;
    payload.deadline = values.deadline || null;
  }
  return payload;
}

// ── Internal helpers ────────────────────────────────────────────────────

const SELECT_CLASSES = SELECT_FIELD_CLASSES;

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

// ── Row atoms (exported for tests) ──────────────────────────────────────

/**
 * CM-61 staleness badge: "Updated N days ago" / "Never updated", amber when
 * the row is ≥14 days stale or was never student-updated.
 */
export function EssayStalenessBadge({
  stalenessDays,
}: {
  stalenessDays: number | null;
}) {
  const amber = isStalenessAmber(stalenessDays);
  return (
    <Badge
      data-testid="essay-staleness"
      data-amber={amber}
      className={cn(
        amber
          ? "border-accent bg-accent/15 text-foreground"
          : "bg-muted text-muted-foreground",
      )}
    >
      {formatStalenessLabel(stalenessDays)}
    </Badge>
  );
}

/** Deadline chip ("Due D/M/YYYY", conflict color while overdue). */
function EssayDeadlineChip({
  essay,
  todayIso,
}: {
  essay: AdmissionsEssayListRowDto;
  todayIso: string;
}) {
  if (essay.deadline === null) return null;
  const overdue = isEssayOverdue(essay, todayIso);
  return (
    <Badge
      data-testid="essay-deadline"
      className={cn(
        "tabular-nums",
        overdue ? "bg-conflict/15 text-conflict" : "bg-muted text-muted-foreground",
      )}
    >
      Due {formatDateOnly(essay.deadline)}
      {overdue ? " · Overdue" : ""}
    </Badge>
  );
}

/** Drive link-out (CM-60: writing stays in Google Docs); http(s) URLs only. */
function EssayDriveLink({ essay }: { essay: AdmissionsEssayListRowDto }) {
  if (!essay.driveUrl || !essay.driveUrl.startsWith("http")) return null;
  return (
    <a
      href={essay.driveUrl}
      target="_blank"
      rel="noreferrer"
      data-testid="essay-drive-link"
      className={buttonVariants({ variant: "outline", size: "sm" })}
    >
      <ExternalLinkIcon aria-hidden className="size-4" />
      Open in Drive
    </a>
  );
}

// ── Add form fields (exported for tests) ────────────────────────────────

/**
 * Add-essay form fields: prompt (required), linked-college select from the
 * case's live list, deadline (rendered ONLY when showDeadline — the §2.4
 * staff-only field), and the Drive URL pointer.
 */
export function AddEssayFormFields({
  values,
  collegeOptions,
  showDeadline,
  onChange,
}: {
  values: AddEssayFormValues;
  collegeOptions: EssayCollegeOption[];
  /** True for counselor+ viewers only (deadline is not self-report). */
  showDeadline: boolean;
  onChange: (values: AddEssayFormValues) => void;
}) {
  return (
    <div className="space-y-3">
      <label className="block space-y-1 text-xs font-medium text-foreground">
        Prompt
        <span aria-hidden className="text-destructive">
          {" "}
          *
        </span>
        <Textarea
          value={values.prompt}
          data-testid="add-essay-prompt"
          placeholder="e.g. Common App personal statement"
          onChange={(event) => onChange({ ...values, prompt: event.target.value })}
        />
      </label>
      {showDeadline ? (
        <label className="block space-y-1 text-xs font-medium text-foreground">
          College
          <select
            className={cn(SELECT_CLASSES, "h-9 w-full")}
            value={values.listItemId}
            data-testid="add-essay-college"
            onChange={(event) =>
              onChange({ ...values, listItemId: event.target.value })
            }
          >
            <option value="">No college (personal statement)</option>
            {collegeOptions.map((option) => (
              <option key={option.id} value={option.id}>
                {option.instName}
              </option>
            ))}
          </select>
        </label>
      ) : null}
      {showDeadline ? (
        <label className="block space-y-1 text-xs font-medium text-foreground">
          Deadline
          <Input
            type="date"
            value={values.deadline}
            data-testid="add-essay-deadline"
            onChange={(event) =>
              onChange({ ...values, deadline: event.target.value })
            }
          />
        </label>
      ) : null}
      <label className="block space-y-1 text-xs font-medium text-foreground">
        Google Drive link
        <Input
          type="url"
          inputMode="url"
          placeholder="https://docs.google.com/…"
          value={values.driveUrl}
          data-testid="add-essay-drive-url"
          onChange={(event) => onChange({ ...values, driveUrl: event.target.value })}
        />
      </label>
    </div>
  );
}

// ── Essays view ─────────────────────────────────────────────────────────

/** Props for EssaysView — all data is server-fetched by the page. */
export interface EssaysViewProps {
  caseId: string;
  /** listEssaysForCase rows in CM-63 urgency order — rendered as given. */
  essays: AdmissionsEssayListRowDto[];
  /** The case's live college list items (add-form link targets). */
  collegeOptions: EssayCollegeOption[];
  /** Per-case role from requireCaseAccess (parents render read-only). */
  viewerRole: CaseRole;
  /** Layout: mobile-first cards (student portal) vs dense table (staff tab). */
  variant: "student" | "staff";
}

/**
 * Role-aware essay tracker (CM-60..63): urgency-ordered rows with the
 * student-editable status select, CM-61 staleness badge, deadline chip,
 * Drive link-out, the CM-62 counselor stage (badge for students, editable
 * select for staff), and the add-essay dialog (deadline field staff-only).
 */
export function EssaysView({
  caseId,
  essays,
  collegeOptions,
  viewerRole,
  variant,
}: EssaysViewProps) {
  const router = useRouter();
  const endpoint = `/api/admissions/cases/${caseId}/essays`;
  const todayIso = useMemo(() => todayBangkok(), []);

  // §2.4 gates: status is the self-report surface (student+; parents are
  // read-only); counselorStage / deadline are counselor+ regardless of the
  // requested layout (fail-closed).
  const canEditStatus = roleAtLeast(viewerRole, "student");
  const isStaff = roleAtLeast(viewerRole, "counselor");

  const [actionError, setActionError] = useState<string | null>(null);
  const [busyEssayIds, setBusyEssayIds] = useState<ReadonlySet<string>>(new Set());

  // ── Add dialog state ──
  const [addOpen, setAddOpen] = useState(false);
  const [addForm, setAddForm] = useState<AddEssayFormValues>(EMPTY_ADD_ESSAY_FORM);
  const [addError, setAddError] = useState<string | null>(null);
  const [addSaving, setAddSaving] = useState(false);

  const collegeNamesById = useMemo(
    () => new Map(collegeOptions.map((option) => [option.id, option.instName])),
    [collegeOptions],
  );

  const setEssayBusy = useCallback((essayId: string, busy: boolean) => {
    setBusyEssayIds((previous) => {
      const next = new Set(previous);
      if (busy) next.add(essayId);
      else next.delete(essayId);
      return next;
    });
  }, []);

  /**
   * PATCHes one field with the row's updatedAt as the optimistic-concurrency
   * token (design §6): a 409 surfaces a conflict message and refreshes so
   * the list shows the latest server values.
   */
  const handleFieldUpdate = useCallback(
    async (row: AdmissionsEssayListRowDto, patch: Record<string, unknown>) => {
      setActionError(null);
      setEssayBusy(row.id, true);
      try {
        const response = await fetch(endpoint, {
          method: "PATCH",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            essayId: row.id,
            expectedUpdatedAt: row.updatedAt,
            ...patch,
          }),
        });
        const payload: unknown = await response.json().catch(() => null);
        if (response.status === 409) {
          setActionError(
            "This essay changed in another session — showing the latest values.",
          );
          router.refresh();
          return;
        }
        if (!response.ok) {
          setActionError(readErrorMessage(payload, "Failed to update the essay."));
          return;
        }
        router.refresh();
      } catch (error) {
        setActionError(
          error instanceof Error ? error.message : "Failed to update the essay.",
        );
      } finally {
        setEssayBusy(row.id, false);
      }
    },
    [endpoint, router, setEssayBusy],
  );

  const handleAddSubmit = useCallback(async () => {
    if (!canSubmitAddEssay(addForm)) {
      setAddError("An essay needs a prompt.");
      return;
    }
    setAddSaving(true);
    setAddError(null);
    try {
      const response = await fetch(endpoint, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(buildAddEssayPayload(addForm, isStaff)),
      });
      const payload: unknown = await response.json().catch(() => null);
      if (!response.ok) {
        setAddError(readErrorMessage(payload, "Failed to add the essay."));
        return;
      }
      setAddOpen(false);
      setAddForm(EMPTY_ADD_ESSAY_FORM);
      router.refresh();
    } catch (error) {
      setAddError(error instanceof Error ? error.message : "Failed to add the essay.");
    } finally {
      setAddSaving(false);
    }
  }, [addForm, endpoint, isStaff, router]);

  // ── Shared row fragments ──

  const renderCollegeName = (row: AdmissionsEssayListRowDto) => {
    if (row.listItemId === null) return null;
    const name = collegeNamesById.get(row.listItemId);
    return (
      <Badge variant="outline" data-testid="essay-college">
        {name ?? "College no longer on the list"}
      </Badge>
    );
  };

  const renderStatusControl = (
    row: AdmissionsEssayListRowDto,
    heightClass: string,
  ) => {
    if (!canEditStatus) {
      return (
        <span className="text-sm text-foreground">
          {ESSAY_STATUS_LABELS[row.status]}
        </span>
      );
    }
    return (
      <select
        className={cn(SELECT_CLASSES, heightClass)}
        value={row.status}
        disabled={busyEssayIds.has(row.id)}
        aria-label={`Status for ${row.prompt}`}
        onChange={(event) =>
          void handleFieldUpdate(row, {
            status: event.target.value as AdmissionsEssayStatus,
          })
        }
      >
        {ADMISSIONS_ESSAY_STATUSES.map((status) => (
          <option key={status} value={status}>
            {ESSAY_STATUS_LABELS[status]}
          </option>
        ))}
      </select>
    );
  };

  const renderCounselorStage = (
    row: AdmissionsEssayListRowDto,
    heightClass: string,
  ) => {
    if (isStaff) {
      return (
        <select
          className={cn(SELECT_CLASSES, heightClass)}
          value={row.counselorStage ?? ""}
          disabled={busyEssayIds.has(row.id)}
          aria-label={`Counselor stage for ${row.prompt}`}
          onChange={(event) =>
            void handleFieldUpdate(row, {
              counselorStage:
                event.target.value === ""
                  ? null
                  : (event.target.value as AdmissionsEssayStatus),
            })
          }
        >
          <option value="">No override</option>
          {ADMISSIONS_ESSAY_STATUSES.map((status) => (
            <option key={status} value={status}>
              {ESSAY_STATUS_LABELS[status]}
            </option>
          ))}
        </select>
      );
    }
    if (row.counselorStage === null) return null;
    return (
      <Badge variant="secondary" data-testid="counselor-stage-badge">
        Counselor: {ESSAY_STATUS_LABELS[row.counselorStage]}
      </Badge>
    );
  };

  const emptyCopy = canEditStatus
    ? "No essays yet — add your first prompt to start tracking."
    : "No essays tracked yet.";

  return (
    <div className="space-y-4">
      <Card>
        <CardHeader>
          <CardTitle className="flex items-center gap-2">
            <PenLineIcon aria-hidden className="size-4 text-primary" />
            Essays
          </CardTitle>
          <CardDescription>
            {essays.length > 0
              ? `${essays.length} essay${essays.length === 1 ? "" : "s"} · most urgent first. Writing lives in Google Docs — track status here.`
              : "Track prompts, stages, deadlines, and Drive links."}
          </CardDescription>
          {canEditStatus ? (
            <CardAction>
              <div className="flex flex-wrap justify-end gap-2">
                <EssayPromptChooser
                  caseId={caseId}
                  collegeOptions={collegeOptions}
                  viewerRole={viewerRole}
                />
                <Button
                  size="sm"
                  data-testid="add-essay"
                  onClick={() => {
                    setAddForm(EMPTY_ADD_ESSAY_FORM);
                    setAddError(null);
                    setAddOpen(true);
                  }}
                >
                  <PlusIcon aria-hidden />
                  Add manually
                </Button>
              </div>
            </CardAction>
          ) : null}
        </CardHeader>
        <CardContent>
          {actionError ? (
            <p role="alert" className="mb-2 text-sm text-destructive">
              {actionError}
            </p>
          ) : null}

          {essays.length === 0 ? (
            <p className="text-sm text-muted-foreground">{emptyCopy}</p>
          ) : variant === "student" ? (
            <ul className="space-y-2">
              {essays.map((row) => (
                <li
                  key={row.id}
                  data-testid="essay-row"
                  className="space-y-2 rounded-lg border border-border/60 p-3"
                >
                  <p className="text-sm font-medium text-foreground">{row.prompt}</p>
                  <div className="flex flex-wrap items-center gap-1.5">
                    {renderCollegeName(row)}
                    <EssayDeadlineChip essay={row} todayIso={todayIso} />
                    <EssayStalenessBadge stalenessDays={row.stalenessDays} />
                    {renderCounselorStage(row, "min-h-11 w-full")}
                  </div>
                  <div className="flex flex-wrap items-center gap-2">
                    {renderStatusControl(row, "min-h-11 flex-1")}
                    <EssayDriveLink essay={row} />
                  </div>
                </li>
              ))}
            </ul>
          ) : (
            <div className="overflow-x-auto">
              <Table>
                <TableHeader>
                  <TableRow>
                    <TableHead>Essay</TableHead>
                    <TableHead>Status</TableHead>
                    <TableHead>Counselor stage</TableHead>
                    <TableHead>Deadline</TableHead>
                    <TableHead>Last update</TableHead>
                    <TableHead>Drive</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {essays.map((row) => (
                    <TableRow key={row.id} data-testid="essay-row">
                      <TableCell>
                        <p className="max-w-72 truncate text-sm font-medium text-foreground">
                          {row.prompt}
                        </p>
                        {renderCollegeName(row)}
                      </TableCell>
                      <TableCell>{renderStatusControl(row, "h-8")}</TableCell>
                      <TableCell>{renderCounselorStage(row, "h-8")}</TableCell>
                      <TableCell>
                        <EssayDeadlineChip essay={row} todayIso={todayIso} />
                      </TableCell>
                      <TableCell>
                        <EssayStalenessBadge stalenessDays={row.stalenessDays} />
                      </TableCell>
                      <TableCell>
                        <EssayDriveLink essay={row} />
                      </TableCell>
                    </TableRow>
                  ))}
                </TableBody>
              </Table>
            </div>
          )}
        </CardContent>
      </Card>

      {/* ── Add-essay dialog (CM-60; deadline field staff-only, §2.4) ── */}
      <Dialog open={addOpen} onOpenChange={setAddOpen}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Add an essay</DialogTitle>
            <DialogDescription>
              Track a prompt with its stage and Google Drive link.
            </DialogDescription>
          </DialogHeader>
          <AddEssayFormFields
            values={addForm}
            collegeOptions={collegeOptions}
            showDeadline={isStaff}
            onChange={setAddForm}
          />
          {addError ? (
            <p role="alert" className="text-sm text-destructive">
              {addError}
            </p>
          ) : null}
          <DialogFooter>
            <Button
              variant="ghost"
              size="sm"
              onClick={() => setAddOpen(false)}
              disabled={addSaving}
            >
              Cancel
            </Button>
            <Button
              size="sm"
              data-testid="add-essay-submit"
              disabled={!canSubmitAddEssay(addForm) || addSaving}
              onClick={() => void handleAddSubmit()}
            >
              {addSaving ? "Adding…" : "Add essay"}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}
