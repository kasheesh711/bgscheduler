"use client";

// ----------------------------------------------------------------------------
// Admissions cohort registry manager (design §4, PRD CM-20/CM-21). Table of
// cohorts (name + graduation year) with an add form and per-row template
// actions: "Edit template" hands off to the mounting shell via
// onEditTemplate(cohortId); "Push new items" (CM-21) appends the latest
// published template's newly-added items to every live case in the cohort —
// existing tasks are NEVER edited or deleted, so the action is guarded by an
// explanatory confirmation dialog and reports a per-cohort summary line.
//
// Role gate: none client-side — a wiring shell mounts this on an admin-only
// surface and the API re-resolves admin rights from Postgres on every write
// (requireAdmissionsAdmin, design §2.2). Mutations POST
// /api/admissions/cohorts[.../templates] then router.refresh() so the
// server-fetched registry (and case checklists) re-hydrate.
// ----------------------------------------------------------------------------

import { useCallback, useState } from "react";
import { useRouter } from "next/navigation";
import { GraduationCapIcon } from "lucide-react";

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
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { SELECT_FIELD_CLASSES } from "@/components/admissions/field-classes";
import type { AdmissionsCohortDto } from "@/lib/admissions/types";

const SELECT_CLASSES = `${SELECT_FIELD_CLASSES} h-9 w-full`;

// ── Pure helpers (exported for tests) ───────────────────────────────────

/** Earliest graduation year offered by the add form. */
export const COHORT_GRADUATION_YEAR_MIN = 2024;

/** Latest graduation year offered by the add form. */
export const COHORT_GRADUATION_YEAR_MAX = 2040;

/** Selectable graduation years (2024–2040 inclusive, ascending). */
export const COHORT_GRADUATION_YEARS: readonly number[] = Array.from(
  { length: COHORT_GRADUATION_YEAR_MAX - COHORT_GRADUATION_YEAR_MIN + 1 },
  (_, index) => COHORT_GRADUATION_YEAR_MIN + index,
);

/** Cohort add-form model; the year is the raw <select> string ("" = unset). */
export interface CohortFormValues {
  name: string;
  graduationYear: string;
}

/** Blank add form — the year deliberately unset (explicit choice required). */
export const EMPTY_COHORT_FORM: CohortFormValues = { name: "", graduationYear: "" };

/** buildCohortPayload result — a ready request body or an inline error. */
export type CohortPayloadResult =
  | { ok: true; body: { name: string; graduationYear: number } }
  | { ok: false; error: string };

/**
 * Validates the add form and builds the POST body: non-empty trimmed name
 * plus an integer graduation year within 2024–2040 (a stricter client-side
 * band than the route's 2000–2100 Zod bounds, which re-validate anyway).
 */
export function buildCohortPayload(form: CohortFormValues): CohortPayloadResult {
  const name = form.name.trim();
  if (!name) return { ok: false, error: "Cohort name is required." };
  const graduationYear = Number.parseInt(form.graduationYear, 10);
  if (
    !Number.isInteger(graduationYear) ||
    graduationYear < COHORT_GRADUATION_YEAR_MIN ||
    graduationYear > COHORT_GRADUATION_YEAR_MAX
  ) {
    return {
      ok: false,
      error: `Choose a graduation year between ${COHORT_GRADUATION_YEAR_MIN} and ${COHORT_GRADUATION_YEAR_MAX}.`,
    };
  }
  return { ok: true, body: { name, graduationYear } };
}

/** Inline error shown when POST /api/admissions/cohorts returns 409. */
export const DUPLICATE_COHORT_ERROR = "A cohort with this name already exists.";

/** Push summary line, e.g. "3 cases updated, 12 tasks created" (CM-21). */
export function formatPushResult(result: {
  casesUpdated: number;
  tasksCreated: number;
}): string {
  return `${result.casesUpdated} cases updated, ${result.tasksCreated} tasks created`;
}

/** Outcome of the cohort-create request. */
export type CohortMutationResult = { ok: true } | { ok: false; error: string };

/** Outcome of the push-new-items request (message = formatted summary). */
export type PushNewItemsOutcome =
  | { ok: true; message: string }
  | { ok: false; error: string };

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

function readPushCounts(payload: unknown): { casesUpdated: number; tasksCreated: number } {
  if (typeof payload === "object" && payload !== null) {
    const record = payload as { casesUpdated?: unknown; tasksCreated?: unknown };
    return {
      casesUpdated: typeof record.casesUpdated === "number" ? record.casesUpdated : 0,
      tasksCreated: typeof record.tasksCreated === "number" ? record.tasksCreated : 0,
    };
  }
  return { casesUpdated: 0, tasksCreated: 0 };
}

/**
 * Create flow — POST /api/admissions/cohorts. Validates client-side first;
 * a 409 (duplicate name, Error("Conflict") in the lib) maps to the inline
 * DUPLICATE_COHORT_ERROR message instead of the raw "Conflict" payload.
 */
export async function requestCohortCreate(
  form: CohortFormValues,
): Promise<CohortMutationResult> {
  const result = buildCohortPayload(form);
  if (!result.ok) return { ok: false, error: result.error };
  try {
    const response = await fetch("/api/admissions/cohorts", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(result.body),
    });
    const payload: unknown = await response.json().catch(() => null);
    if (response.status === 409) return { ok: false, error: DUPLICATE_COHORT_ERROR };
    if (!response.ok) {
      return { ok: false, error: readErrorMessage(payload, "Failed to create the cohort.") };
    }
    return { ok: true };
  } catch (err) {
    return {
      ok: false,
      error: err instanceof Error ? err.message : "Failed to create the cohort.",
    };
  }
}

/**
 * Push flow (CM-21) — POST { action: "push_new_items" } to the cohort's
 * templates route. Appends newly-added template items to every live case;
 * existing tasks are never mutated. A 404 means the cohort has no published
 * template yet (nothing to push), surfaced as a friendly inline error.
 */
export async function requestPushNewItems(cohortId: string): Promise<PushNewItemsOutcome> {
  try {
    const response = await fetch(`/api/admissions/cohorts/${cohortId}/templates`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ action: "push_new_items" }),
    });
    const payload: unknown = await response.json().catch(() => null);
    if (response.status === 404) {
      return { ok: false, error: "This cohort has no published template to push yet." };
    }
    if (!response.ok) {
      return { ok: false, error: readErrorMessage(payload, "Failed to push new items.") };
    }
    return { ok: true, message: formatPushResult(readPushCounts(payload)) };
  } catch (err) {
    return {
      ok: false,
      error: err instanceof Error ? err.message : "Failed to push new items.",
    };
  }
}

// ── Cohort row ──────────────────────────────────────────────────────────

/** Props for one cohort row. Hook-free so tests can invoke it directly. */
export interface CohortRowProps {
  cohort: AdmissionsCohortDto;
  busy: boolean;
  /** Success line from the last push for THIS cohort, or null. */
  pushMessage: string | null;
  onEditTemplate: (cohortId: string) => void;
  /** Opens the shared push-confirmation dialog (never pushes directly). */
  onRequestPush: (cohort: AdmissionsCohortDto) => void;
}

/**
 * One cohort registry row: name, graduation year, and the template actions
 * (Edit template hand-off + guarded Push new items with its summary line).
 */
export function CohortRow({
  cohort,
  busy,
  pushMessage,
  onEditTemplate,
  onRequestPush,
}: CohortRowProps) {
  return (
    <TableRow data-testid={`cohort-row-${cohort.id}`}>
      <TableCell className="font-medium">{cohort.name}</TableCell>
      <TableCell className="tabular-nums">{cohort.graduationYear}</TableCell>
      <TableCell>
        <div className="flex items-center justify-end gap-1">
          <Button
            type="button"
            size="sm"
            variant="ghost"
            data-testid={`cohort-edit-template-${cohort.id}`}
            disabled={busy}
            onClick={() => onEditTemplate(cohort.id)}
          >
            Edit template
          </Button>
          <Button
            type="button"
            size="sm"
            variant="ghost"
            data-testid={`cohort-push-${cohort.id}`}
            disabled={busy}
            onClick={() => onRequestPush(cohort)}
          >
            Push new items
          </Button>
        </div>
        {pushMessage ? (
          <p
            role="status"
            data-testid={`cohort-push-result-${cohort.id}`}
            className="mt-1 text-right text-xs text-muted-foreground"
          >
            {pushMessage}
          </p>
        ) : null}
      </TableCell>
    </TableRow>
  );
}

// ── Manager ─────────────────────────────────────────────────────────────

/** Props for CohortsManager — cohorts are server-fetched (staff surface). */
export interface CohortsManagerProps {
  cohorts: AdmissionsCohortDto[];
  /** Opens the cohort's template editor (owned by the mounting shell). */
  onEditTemplate: (cohortId: string) => void;
}

/**
 * Cohort registry manager (admin settings surface). Table of cohorts with
 * an add form (duplicate names surface the 409 as an inline error) and
 * per-row template actions. "Push new items" is append-only by design
 * (CM-21) but still fans out across every live case in the cohort, so it is
 * guarded by an explanatory confirmation dialog; its result renders as an
 * inline "{casesUpdated} cases updated, {tasksCreated} tasks created" line
 * on the row. Successful mutations router.refresh() so server data re-hydrates.
 */
export function CohortsManager({ cohorts, onEditTemplate }: CohortsManagerProps) {
  const router = useRouter();

  const [addForm, setAddForm] = useState<CohortFormValues>(EMPTY_COHORT_FORM);
  const [saving, setSaving] = useState(false);
  const [busyId, setBusyId] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [pendingPush, setPendingPush] = useState<AdmissionsCohortDto | null>(null);
  const [pushResult, setPushResult] = useState<{
    cohortId: string;
    message: string;
  } | null>(null);

  const canSubmitAdd = buildCohortPayload(addForm).ok;

  const handleCreate = useCallback(async () => {
    setSaving(true);
    setError(null);
    const result = await requestCohortCreate(addForm);
    setSaving(false);
    if (!result.ok) {
      setError(result.error);
      return;
    }
    setAddForm(EMPTY_COHORT_FORM);
    router.refresh();
  }, [addForm, router]);

  /** Runs only from the confirmation dialog — never from the row button. */
  const handlePushConfirmed = useCallback(async () => {
    const cohort = pendingPush;
    if (!cohort) return;
    setBusyId(cohort.id);
    setError(null);
    const result = await requestPushNewItems(cohort.id);
    setBusyId(null);
    setPendingPush(null);
    if (!result.ok) {
      setError(result.error);
      return;
    }
    setPushResult({ cohortId: cohort.id, message: result.message });
    router.refresh();
  }, [pendingPush, router]);

  return (
    <Card data-testid="cohorts-manager">
      <CardHeader>
        <CardTitle className="flex items-center gap-1.5">
          <GraduationCapIcon aria-hidden className="size-4" />
          Cohorts
        </CardTitle>
        <CardDescription>
          Graduation-year cohorts and their checklist templates.
        </CardDescription>
      </CardHeader>
      <CardContent className="space-y-4">
        <form
          data-testid="cohort-add-form"
          onSubmit={(event) => {
            event.preventDefault();
            void handleCreate();
          }}
          className="space-y-3 rounded-lg border border-border/60 p-3"
        >
          <p className="text-sm font-medium text-foreground">Add a cohort</p>
          <div className="grid gap-3 sm:grid-cols-2">
            <label className="block space-y-1 text-xs font-medium text-foreground">
              Name
              <span aria-hidden className="text-destructive">
                {" "}
                *
              </span>
              <Input
                placeholder="Class of 2027"
                value={addForm.name}
                onChange={(event) => setAddForm({ ...addForm, name: event.target.value })}
              />
            </label>
            <label className="block space-y-1 text-xs font-medium text-foreground">
              Graduation year
              <span aria-hidden className="text-destructive">
                {" "}
                *
              </span>
              <select
                className={SELECT_CLASSES}
                value={addForm.graduationYear}
                onChange={(event) =>
                  setAddForm({ ...addForm, graduationYear: event.target.value })
                }
              >
                <option value="">Choose a year…</option>
                {COHORT_GRADUATION_YEARS.map((year) => (
                  <option key={year} value={String(year)}>
                    {year}
                  </option>
                ))}
              </select>
            </label>
          </div>
          <Button
            type="submit"
            size="sm"
            data-testid="cohort-submit"
            disabled={!canSubmitAdd || saving}
          >
            {saving ? "Adding…" : "Add cohort"}
          </Button>
        </form>

        {error ? (
          <p role="alert" className="text-sm text-destructive">
            {error}
          </p>
        ) : null}

        {cohorts.length > 0 ? (
          <Table data-testid="cohorts-table">
            <TableHeader>
              <TableRow>
                <TableHead>Name</TableHead>
                <TableHead>Graduation year</TableHead>
                <TableHead>
                  <span className="sr-only">Actions</span>
                </TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {cohorts.map((cohort) => (
                <CohortRow
                  key={cohort.id}
                  cohort={cohort}
                  busy={busyId === cohort.id}
                  pushMessage={pushResult?.cohortId === cohort.id ? pushResult.message : null}
                  onEditTemplate={onEditTemplate}
                  onRequestPush={setPendingPush}
                />
              ))}
            </TableBody>
          </Table>
        ) : (
          <p className="text-sm text-muted-foreground">
            No cohorts yet. Add the first one above.
          </p>
        )}

        {/* ── Push confirmation (fan-out action guard, CM-21) ── */}
        <Dialog
          open={pendingPush !== null}
          onOpenChange={(open) => {
            if (!open) setPendingPush(null);
          }}
        >
          <DialogContent data-testid="cohort-push-dialog">
            <DialogHeader>
              <DialogTitle>Push new template items?</DialogTitle>
              <DialogDescription>
                {pendingPush
                  ? `Newly-added items in the latest published template for "${pendingPush.name}" will be appended to every live case in the cohort. Existing tasks are never edited or deleted — statuses, due dates, and edits all survive.`
                  : ""}
              </DialogDescription>
            </DialogHeader>
            <DialogFooter>
              <Button
                variant="outline"
                size="sm"
                onClick={() => setPendingPush(null)}
                disabled={busyId !== null}
              >
                Cancel
              </Button>
              <Button
                size="sm"
                data-testid="cohort-push-confirm"
                onClick={() => void handlePushConfirmed()}
                disabled={busyId !== null}
              >
                {busyId !== null ? "Pushing…" : "Push new items"}
              </Button>
            </DialogFooter>
          </DialogContent>
        </Dialog>
      </CardContent>
    </Card>
  );
}
