"use client";

// ----------------------------------------------------------------------------
// Admissions checklist — counselor custom-task dialog (design §5.1, CM-23).
//
// Collects title, description, owner, due date, and simple recurrence
// (weekly/biweekly until an end date) and POSTs to
// /api/admissions/cases/[caseId]/tasks. Custom tasks carry no template
// linkage (null itemKey) so they stay deletable, unlike template-derived
// rows. Validation mirrors the route's Zod schema client-side so users get
// inline errors instead of a 400 round-trip; the API remains the authority.
// ----------------------------------------------------------------------------

import { useCallback, useState } from "react";
import { cn } from "@/lib/utils";
import { SELECT_FIELD_CLASSES } from "@/components/admissions/field-classes";
import { Button } from "@/components/ui/button";
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
import {
  ADMISSIONS_TASK_OWNERS,
  type AdmissionsTaskOwner,
} from "@/lib/admissions/shared/meetings";
import type { AdmissionsTaskDto, AdmissionsTaskRecurrence } from "@/lib/admissions/checklists";

const SELECT_CLASSES = cn(SELECT_FIELD_CLASSES, "h-8 w-full");

/** Display labels for task owners (checklist rows + the owner select). */
export const TASK_OWNER_LABELS: Record<AdmissionsTaskOwner, string> = {
  student: "Student",
  counselor: "Counselor",
  parent: "Parent",
};

/** Custom-task form model — all fields as strings ("" = unset). */
export interface CustomTaskFormValues {
  title: string;
  description: string;
  owner: AdmissionsTaskOwner;
  dueDate: string;
  recurrenceFreq: "none" | "weekly" | "biweekly";
  recurrenceUntil: string;
}

/** Blank custom-task form (owner defaults to student — most custom tasks are theirs). */
export const EMPTY_CUSTOM_TASK_FORM: CustomTaskFormValues = {
  title: "",
  description: "",
  owner: "student",
  dueDate: "",
  recurrenceFreq: "none",
  recurrenceUntil: "",
};

/** POST body for /api/admissions/cases/[caseId]/tasks. */
export interface CustomTaskRequestBody {
  title: string;
  description: string | null;
  owner: AdmissionsTaskOwner;
  dueDate: string | null;
  recurrence: AdmissionsTaskRecurrence | null;
}

/** buildCustomTaskPayload result — a ready request body or an inline error. */
export type CustomTaskPayloadResult =
  | { ok: true; body: CustomTaskRequestBody }
  | { ok: false; error: string };

/**
 * Validates the custom-task form and builds the POST body (CM-23). Returns an
 * inline error instead of guessing: a blank title is rejected, and a weekly/
 * biweekly recurrence without an end date is rejected (the recurrence schema
 * requires `until`). Blank optional fields serialize as null.
 */
export function buildCustomTaskPayload(
  form: CustomTaskFormValues,
): CustomTaskPayloadResult {
  const title = form.title.trim();
  if (!title) {
    return { ok: false, error: "Task title is required." };
  }
  if (form.recurrenceFreq !== "none" && !form.recurrenceUntil) {
    return { ok: false, error: "Recurring tasks need an end date." };
  }
  return {
    ok: true,
    body: {
      title,
      description: form.description.trim() || null,
      owner: form.owner,
      dueDate: form.dueDate || null,
      recurrence:
        form.recurrenceFreq === "none"
          ? null
          : { freq: form.recurrenceFreq, until: form.recurrenceUntil },
    },
  };
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

function readTaskFromPayload(payload: unknown): AdmissionsTaskDto | null {
  if (typeof payload === "object" && payload !== null && "task" in payload) {
    const task = (payload as { task?: unknown }).task;
    if (
      typeof task === "object" &&
      task !== null &&
      typeof (task as { id?: unknown }).id === "string"
    ) {
      return task as AdmissionsTaskDto;
    }
  }
  return null;
}

/** Props for CustomTaskDialog — open state is owned by the checklist tab. */
export interface CustomTaskDialogProps {
  caseId: string;
  open: boolean;
  onOpenChange: (open: boolean) => void;
  /** Called after a successful create with the server task (null if unparseable). */
  onCreated: (task: AdmissionsTaskDto | null) => void;
}

/**
 * Counselor custom-task dialog (CM-23): title, description, owner, due date,
 * and optional weekly/biweekly recurrence. Closing the dialog resets the form
 * so a reopen always starts blank.
 */
export function CustomTaskDialog({
  caseId,
  open,
  onOpenChange,
  onCreated,
}: CustomTaskDialogProps) {
  const [form, setForm] = useState<CustomTaskFormValues>(EMPTY_CUSTOM_TASK_FORM);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const handleOpenChange = useCallback(
    (next: boolean) => {
      if (!next) {
        setForm(EMPTY_CUSTOM_TASK_FORM);
        setError(null);
      }
      onOpenChange(next);
    },
    [onOpenChange],
  );

  const handleSubmit = useCallback(async () => {
    const result = buildCustomTaskPayload(form);
    if (!result.ok) {
      setError(result.error);
      return;
    }
    setSaving(true);
    setError(null);
    try {
      const response = await fetch(`/api/admissions/cases/${caseId}/tasks`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(result.body),
      });
      const payload: unknown = await response.json().catch(() => null);
      if (!response.ok) {
        setError(readErrorMessage(payload, "Failed to add the task."));
        return;
      }
      const task = readTaskFromPayload(payload);
      setForm(EMPTY_CUSTOM_TASK_FORM);
      onOpenChange(false);
      onCreated(task);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to add the task.");
    } finally {
      setSaving(false);
    }
  }, [form, caseId, onOpenChange, onCreated]);

  return (
    <Dialog open={open} onOpenChange={handleOpenChange}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Add a custom task</DialogTitle>
          <DialogDescription>
            Custom tasks are specific to this case — they are not part of the
            cohort template and can be deleted later.
          </DialogDescription>
        </DialogHeader>
        <form
          onSubmit={(event) => {
            event.preventDefault();
            void handleSubmit();
          }}
          className="space-y-3"
        >
          <label className="block space-y-1 text-xs font-medium text-foreground">
            Title
            <span aria-hidden className="text-destructive">
              {" "}
              *
            </span>
            <Input
              value={form.title}
              onChange={(event) =>
                setForm((previous) => ({ ...previous, title: event.target.value }))
              }
            />
          </label>
          <label className="block space-y-1 text-xs font-medium text-foreground">
            Description
            <Textarea
              value={form.description}
              onChange={(event) =>
                setForm((previous) => ({
                  ...previous,
                  description: event.target.value,
                }))
              }
            />
          </label>
          <div className="grid gap-3 sm:grid-cols-2">
            <label className="space-y-1 text-xs font-medium text-foreground">
              Owner
              <select
                className={SELECT_CLASSES}
                value={form.owner}
                onChange={(event) =>
                  setForm((previous) => ({
                    ...previous,
                    owner: event.target.value as AdmissionsTaskOwner,
                  }))
                }
              >
                {ADMISSIONS_TASK_OWNERS.map((owner) => (
                  <option key={owner} value={owner}>
                    {TASK_OWNER_LABELS[owner]}
                  </option>
                ))}
              </select>
            </label>
            <label className="space-y-1 text-xs font-medium text-foreground">
              Due date
              <Input
                type="date"
                value={form.dueDate}
                onChange={(event) =>
                  setForm((previous) => ({
                    ...previous,
                    dueDate: event.target.value,
                  }))
                }
              />
            </label>
            <label className="space-y-1 text-xs font-medium text-foreground">
              Repeats
              <select
                className={SELECT_CLASSES}
                value={form.recurrenceFreq}
                onChange={(event) =>
                  setForm((previous) => ({
                    ...previous,
                    recurrenceFreq: event.target
                      .value as CustomTaskFormValues["recurrenceFreq"],
                  }))
                }
              >
                <option value="none">Does not repeat</option>
                <option value="weekly">Weekly</option>
                <option value="biweekly">Biweekly</option>
              </select>
            </label>
            {form.recurrenceFreq !== "none" ? (
              <label className="space-y-1 text-xs font-medium text-foreground">
                Repeats until
                <span aria-hidden className="text-destructive">
                  {" "}
                  *
                </span>
                <Input
                  type="date"
                  value={form.recurrenceUntil}
                  onChange={(event) =>
                    setForm((previous) => ({
                      ...previous,
                      recurrenceUntil: event.target.value,
                    }))
                  }
                />
              </label>
            ) : null}
          </div>
          {error ? (
            <p role="alert" className="text-sm text-destructive">
              {error}
            </p>
          ) : null}
          <DialogFooter>
            <Button
              type="button"
              size="sm"
              variant="ghost"
              onClick={() => handleOpenChange(false)}
              disabled={saving}
            >
              Cancel
            </Button>
            <Button
              type="submit"
              size="sm"
              data-testid="custom-task-submit"
              disabled={saving}
              className={cn(saving && "opacity-80")}
            >
              {saving ? "Adding…" : "Add task"}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}
