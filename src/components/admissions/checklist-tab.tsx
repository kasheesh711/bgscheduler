"use client";

// ----------------------------------------------------------------------------
// Admissions checklist tab (design §5.1, PRD CM-21..CM-24) — replaces the
// phase-2 placeholder in case-detail-shell.tsx.
//
// Tasks arrive as server-fetched props (the page reads listCaseTasks; the
// shell passes them down) and group into the 10 canonical SummitEd phases in
// ADMISSIONS_CHECKLIST_PHASES order, with custom / meeting-action-item rows
// (phase "custom" — or any unknown phase, fail-closed) in a trailing group.
// Sections are collapsible with per-phase done counts + progress bars.
//
// Status ticks are OPTIMISTIC: the row flips immediately via a local override
// map, the PATCH fires, and a failure rolls the override back and surfaces
// the error. Leaving "done" also clears the verification stamp locally,
// mirroring the lib's fail-closed rule. Verification toggles and deletes are
// awaited (low-frequency actions). All mutations end in router.refresh() so
// the server-computed progress on the Overview tab stays consistent.
//
// Role gates mirror the API (design §2.4): parents get a read-only progress
// summary (the tasks GET is student+); students see enabled checkboxes ONLY
// on student-owned tasks; verification, custom tasks, and deletes are
// counselor+. Template-derived tasks (itemKey != null) show no delete
// affordance — the API rejects deleting them with 409 (CM-21).
// ----------------------------------------------------------------------------

import { useCallback, useMemo, useState } from "react";
import { useRouter } from "next/navigation";
import {
  BadgeCheckIcon,
  ChevronDownIcon,
  PlusIcon,
  RepeatIcon,
  Trash2Icon,
} from "lucide-react";

import { cn } from "@/lib/utils";
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
import {
  ADMISSIONS_CHECKLIST_PHASES,
  isAdmissionsPhaseKey,
  roleAtLeast,
} from "@/lib/admissions/config";
import { MEETING_ACTION_ITEM_PHASE } from "@/lib/admissions/shared/meetings";
import { todayBangkok } from "@/lib/room-capacity/dates";
import { CustomTaskDialog, TASK_OWNER_LABELS } from "./custom-task-dialog";
import type { AdmissionsChecklistProgress, AdmissionsTaskDto, AdmissionsTaskRecurrence, AdmissionsTaskStatus } from "@/lib/admissions/checklists";
import type { CaseRole } from "@/lib/admissions/types";

// ── Pure helpers (exported for tests) ───────────────────────────────────

/** Display label for the trailing custom / meeting-action-item group. */
export const CUSTOM_PHASE_LABEL = "Custom & action items";

/** One rendered checklist section: a phase key, its label, and its tasks. */
export interface ChecklistPhaseGroup {
  key: string;
  label: string;
  tasks: AdmissionsTaskDto[];
}

/**
 * Groups tasks into the 10 canonical phases (ADMISSIONS_CHECKLIST_PHASES
 * order), then a trailing custom group. Tasks whose phase is "custom" — or
 * any unknown value — land in the custom group (fail-closed: never guess a
 * canonical phase). Empty phases are omitted; input order is preserved
 * within each group (the server sorts by sortOrder, createdAt).
 */
export function groupTasksByPhase(
  tasks: readonly AdmissionsTaskDto[],
): ChecklistPhaseGroup[] {
  const byPhase = new Map<string, AdmissionsTaskDto[]>();
  for (const task of tasks) {
    const key = isAdmissionsPhaseKey(task.phase)
      ? task.phase
      : MEETING_ACTION_ITEM_PHASE;
    const bucket = byPhase.get(key);
    if (bucket) bucket.push(task);
    else byPhase.set(key, [task]);
  }

  const groups: ChecklistPhaseGroup[] = [];
  for (const phase of ADMISSIONS_CHECKLIST_PHASES) {
    const phaseTasks = byPhase.get(phase.key);
    if (phaseTasks && phaseTasks.length > 0) {
      groups.push({ key: phase.key, label: phase.label, tasks: phaseTasks });
    }
  }
  const customTasks = byPhase.get(MEETING_ACTION_ITEM_PHASE);
  if (customTasks && customTasks.length > 0) {
    groups.push({
      key: MEETING_ACTION_ITEM_PHASE,
      label: CUSTOM_PHASE_LABEL,
      tasks: customTasks,
    });
  }
  return groups;
}

/**
 * Progress rollup over task DTOs — the client-side mirror of the CM-24 math
 * in computeProgressCounts (checklists.ts), operating on ISO-string
 * verifiedAt. Used for the header and per-phase counts so optimistic ticks
 * update every rollup immediately.
 */
export function computeTaskProgress(
  tasks: ReadonlyArray<Pick<AdmissionsTaskDto, "status" | "verifiedAt">>,
): AdmissionsChecklistProgress {
  const total = tasks.length;
  let done = 0;
  let verifiedCount = 0;
  for (const task of tasks) {
    if (task.status === "done") done += 1;
    if (task.verifiedAt !== null) verifiedCount += 1;
  }
  return {
    done,
    total,
    percent: total === 0 ? 0 : Math.round((done / total) * 100),
    verifiedCount,
  };
}

/**
 * True when a task is overdue: it has a due date strictly before today's
 * Bangkok calendar date and is not done. Date-only ISO strings compare
 * lexicographically, so no Date parsing is needed.
 */
export function isTaskOverdue(
  task: Pick<AdmissionsTaskDto, "dueDate" | "status">,
  todayIso: string,
): boolean {
  return task.dueDate !== null && task.status !== "done" && task.dueDate < todayIso;
}

/**
 * Role gate for the status checkbox (CM-22): counselors and admins may tick
 * any task; students only tasks owned by "student"; parents never (view-only,
 * design §2.4). Mirrors the updateTaskStatus rule so disabled checkboxes
 * match what the API would reject.
 */
export function canToggleTask(
  viewerRole: CaseRole,
  task: Pick<AdmissionsTaskDto, "owner">,
): boolean {
  if (roleAtLeast(viewerRole, "counselor")) return true;
  if (viewerRole === "student") return task.owner === "student";
  return false;
}

/**
 * Merges optimistic overrides into the server task list:
 *
 * 1. An override of null hides the task (optimistic delete).
 * 2. A task override replaces the base row only while its updatedAt is >= the
 *    base row's — once router.refresh() delivers fresher server data, the
 *    stale override stops shadowing it.
 * 3. Overrides whose id is not in the base list append at the end
 *    (optimistically created custom tasks, until the refresh lands).
 */
export function mergeTaskOverrides(
  tasks: readonly AdmissionsTaskDto[],
  overrides: Readonly<Record<string, AdmissionsTaskDto | null>>,
): AdmissionsTaskDto[] {
  const merged: AdmissionsTaskDto[] = [];
  const seen = new Set<string>();
  for (const task of tasks) {
    seen.add(task.id);
    if (!(task.id in overrides)) {
      merged.push(task);
      continue;
    }
    const override = overrides[task.id];
    if (override === null) continue;
    if (override === undefined) {
      merged.push(task);
      continue;
    }
    merged.push(override.updatedAt >= task.updatedAt ? override : task);
  }
  for (const [id, override] of Object.entries(overrides)) {
    if (override !== null && override !== undefined && !seen.has(id)) {
      merged.push(override);
    }
  }
  return merged;
}

/** "Weekly until 5/7/2026" / "Biweekly until …" for a recurrence payload. */
export function describeRecurrence(recurrence: AdmissionsTaskRecurrence): string {
  const freq = recurrence.freq === "weekly" ? "Weekly" : "Biweekly";
  return `${freq} until ${formatDateOnly(recurrence.until)}`;
}

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

// ── Task row ────────────────────────────────────────────────────────────

function TaskRow({
  task,
  viewerRole,
  isStaff,
  todayIso,
  busy,
  onToggleStatus,
  onToggleVerified,
  onRequestDelete,
}: {
  task: AdmissionsTaskDto;
  viewerRole: CaseRole;
  isStaff: boolean;
  todayIso: string;
  busy: boolean;
  onToggleStatus: (task: AdmissionsTaskDto) => void;
  onToggleVerified: (task: AdmissionsTaskDto) => void;
  onRequestDelete: (task: AdmissionsTaskDto) => void;
}) {
  const done = task.status === "done";
  const verified = task.verifiedAt !== null;
  const overdue = isTaskOverdue(task, todayIso);
  const toggleAllowed = canToggleTask(viewerRole, task);

  return (
    <li
      data-testid="task-row"
      className="flex items-start gap-3 rounded-lg border border-border/60 p-2.5"
    >
      <input
        type="checkbox"
        data-testid={`task-checkbox-${task.id}`}
        className="mt-0.5 size-4 shrink-0 accent-primary"
        checked={done}
        disabled={!toggleAllowed || busy}
        onChange={() => onToggleStatus(task)}
        aria-label={done ? `Mark ${task.title} not done` : `Mark ${task.title} done`}
      />
      <div className="min-w-0 flex-1">
        <div className="flex flex-wrap items-center gap-1.5">
          <span
            className={cn(
              "text-sm font-medium text-foreground",
              done && "text-muted-foreground line-through",
            )}
          >
            {task.title}
          </span>
          {verified ? (
            <Badge data-testid="verified-badge" className="bg-available/15 text-available">
              <BadgeCheckIcon aria-hidden />
              Verified
            </Badge>
          ) : null}
          {task.status === "in_progress" ? (
            <Badge variant="secondary">In progress</Badge>
          ) : null}
          {task.recurrence ? (
            <Badge variant="outline">
              <RepeatIcon aria-hidden />
              {describeRecurrence(task.recurrence)}
            </Badge>
          ) : null}
          {task.itemKey === null ? <Badge variant="outline">Custom</Badge> : null}
        </div>
        {task.description ? (
          <p className="mt-0.5 text-xs text-muted-foreground">{task.description}</p>
        ) : null}
        <div className="mt-1 flex flex-wrap items-center gap-x-3 gap-y-0.5 text-xs text-muted-foreground">
          <span>Owner: {TASK_OWNER_LABELS[task.owner]}</span>
          {task.dueDate ? (
            <span
              data-testid={`task-due-${task.id}`}
              className={cn(overdue && "font-medium text-conflict")}
            >
              Due {formatDateOnly(task.dueDate)}
              {overdue ? " · Overdue" : ""}
            </span>
          ) : null}
        </div>
      </div>
      <div className="flex shrink-0 items-center gap-1">
        {isStaff && task.owner === "student" ? (
          <Button
            size="xs"
            variant={verified ? "outline" : "ghost"}
            disabled={busy}
            onClick={() => onToggleVerified(task)}
            aria-label={
              verified
                ? `Remove verification from ${task.title}`
                : `Verify ${task.title}`
            }
          >
            <BadgeCheckIcon aria-hidden />
            {verified ? "Unverify" : "Verify"}
          </Button>
        ) : null}
        {isStaff && task.itemKey === null ? (
          <Button
            size="icon-sm"
            variant="ghost"
            disabled={busy}
            onClick={() => onRequestDelete(task)}
            aria-label={`Delete task ${task.title}`}
          >
            <Trash2Icon aria-hidden />
          </Button>
        ) : null}
      </div>
    </li>
  );
}

// ── Checklist tab ───────────────────────────────────────────────────────

/** Props for ChecklistTab — tasks and progress are server-fetched by the page. */
export interface ChecklistTabProps {
  caseId: string;
  /** Live tasks; empty for parent viewers (the tasks API is student+). */
  tasks: AdmissionsTaskDto[];
  /** Server-computed rollup (used verbatim for the parent summary). */
  progress: AdmissionsChecklistProgress;
  viewerRole: CaseRole;
}

/**
 * Checklist tab (design §5.1): 10-phase collapsible sections with per-phase
 * progress, optimistic status ticks, counselor verification, custom tasks
 * with recurrence, and delete for custom tasks only.
 */
export function ChecklistTab({
  caseId,
  tasks,
  progress,
  viewerRole,
}: ChecklistTabProps) {
  const router = useRouter();
  const isStaff = roleAtLeast(viewerRole, "counselor");
  const todayIso = useMemo(() => todayBangkok(), []);

  const [overrides, setOverrides] = useState<Record<string, AdmissionsTaskDto | null>>({});
  const [collapsedPhases, setCollapsedPhases] = useState<ReadonlySet<string>>(
    new Set(),
  );
  const [busyTaskIds, setBusyTaskIds] = useState<ReadonlySet<string>>(new Set());
  const [actionError, setActionError] = useState<string | null>(null);
  const [dialogOpen, setDialogOpen] = useState(false);
  const [pendingDelete, setPendingDelete] = useState<AdmissionsTaskDto | null>(null);
  const [deleteSaving, setDeleteSaving] = useState(false);

  const mergedTasks = useMemo(
    () => mergeTaskOverrides(tasks, overrides),
    [tasks, overrides],
  );
  const groups = useMemo(() => groupTasksByPhase(mergedTasks), [mergedTasks]);
  const liveProgress = useMemo(() => computeTaskProgress(mergedTasks), [mergedTasks]);

  const setTaskBusy = useCallback((taskId: string, busy: boolean) => {
    setBusyTaskIds((previous) => {
      const next = new Set(previous);
      if (busy) next.add(taskId);
      else next.delete(taskId);
      return next;
    });
  }, []);

  const togglePhase = useCallback((phaseKey: string) => {
    setCollapsedPhases((previous) => {
      const next = new Set(previous);
      if (next.has(phaseKey)) next.delete(phaseKey);
      else next.add(phaseKey);
      return next;
    });
  }, []);

  // ── Status tick: optimistic update, rollback on error (design §6) ──
  const handleToggleStatus = useCallback(
    async (task: AdmissionsTaskDto) => {
      if (!canToggleTask(viewerRole, task)) return;
      const nextStatus: AdmissionsTaskStatus =
        task.status === "done" ? "not_started" : "done";
      const hadOverride = Object.prototype.hasOwnProperty.call(overrides, task.id);
      const previousOverride = hadOverride ? overrides[task.id] : undefined;
      // Leaving "done" clears verification locally, mirroring the lib's
      // fail-closed rule (a re-opened task is no longer verified).
      const optimistic: AdmissionsTaskDto = {
        ...task,
        status: nextStatus,
        ...(nextStatus !== "done" && task.verifiedAt !== null
          ? { verifiedAt: null, verifiedByEmail: null }
          : {}),
      };
      setActionError(null);
      setOverrides((previous) => ({ ...previous, [task.id]: optimistic }));
      setTaskBusy(task.id, true);
      try {
        const response = await fetch(`/api/admissions/cases/${caseId}/tasks`, {
          method: "PATCH",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            action: "status",
            taskId: task.id,
            status: nextStatus,
          }),
        });
        const payload: unknown = await response.json().catch(() => null);
        if (!response.ok) {
          throw new Error(readErrorMessage(payload, "Failed to update the task."));
        }
        const serverTask = readTaskFromPayload(payload);
        if (serverTask) {
          setOverrides((previous) => ({ ...previous, [serverTask.id]: serverTask }));
        }
        router.refresh();
      } catch (error) {
        // Roll back the optimistic tick.
        setOverrides((previous) => {
          const next = { ...previous };
          if (previousOverride === undefined) delete next[task.id];
          else next[task.id] = previousOverride;
          return next;
        });
        setActionError(
          error instanceof Error ? error.message : "Failed to update the task.",
        );
      } finally {
        setTaskBusy(task.id, false);
      }
    },
    [viewerRole, overrides, caseId, router, setTaskBusy],
  );

  // ── Verification toggle (counselor+, student-owned tasks only) ──
  const handleToggleVerified = useCallback(
    async (task: AdmissionsTaskDto) => {
      setActionError(null);
      setTaskBusy(task.id, true);
      try {
        const response = await fetch(`/api/admissions/cases/${caseId}/tasks`, {
          method: "PATCH",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            action: "verify",
            taskId: task.id,
            verified: task.verifiedAt === null,
          }),
        });
        const payload: unknown = await response.json().catch(() => null);
        if (!response.ok) {
          setActionError(readErrorMessage(payload, "Failed to update verification."));
          return;
        }
        const serverTask = readTaskFromPayload(payload);
        if (serverTask) {
          setOverrides((previous) => ({ ...previous, [serverTask.id]: serverTask }));
        }
        router.refresh();
      } catch (error) {
        setActionError(
          error instanceof Error ? error.message : "Failed to update verification.",
        );
      } finally {
        setTaskBusy(task.id, false);
      }
    },
    [caseId, router, setTaskBusy],
  );

  // ── Delete (custom tasks only; confirmed via dialog) ──
  const handleDeleteConfirmed = useCallback(async () => {
    const task = pendingDelete;
    if (!task) return;
    setActionError(null);
    setDeleteSaving(true);
    try {
      const response = await fetch(`/api/admissions/cases/${caseId}/tasks`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ action: "delete", taskId: task.id }),
      });
      const payload: unknown = await response.json().catch(() => null);
      if (!response.ok) {
        setActionError(readErrorMessage(payload, "Failed to delete the task."));
        return;
      }
      setOverrides((previous) => ({ ...previous, [task.id]: null }));
      setPendingDelete(null);
      router.refresh();
    } catch (error) {
      setActionError(
        error instanceof Error ? error.message : "Failed to delete the task.",
      );
    } finally {
      setDeleteSaving(false);
    }
  }, [pendingDelete, caseId, router]);

  const handleTaskCreated = useCallback(
    (task: AdmissionsTaskDto | null) => {
      if (task) {
        setOverrides((previous) => ({ ...previous, [task.id]: task }));
      }
      router.refresh();
    },
    [router],
  );

  // ── Parent view: read-only summary (the tasks API is student+) ──
  if (viewerRole === "parent") {
    return (
      <Card>
        <CardHeader>
          <CardTitle>Checklist</CardTitle>
          <CardDescription>
            {progress.done}/{progress.total} tasks done · {progress.percent}%
          </CardDescription>
        </CardHeader>
        <CardContent>
          <p className="text-sm text-muted-foreground">
            Task details are managed by the student and counselor. Progress
            updates appear here as tasks are completed.
          </p>
        </CardContent>
      </Card>
    );
  }

  return (
    <div className="space-y-4">
      {/* ── Header: overall progress + add-task action ── */}
      <Card>
        <CardHeader>
          <CardTitle>Checklist</CardTitle>
          <CardDescription>
            {liveProgress.done}/{liveProgress.total} tasks done ·{" "}
            {liveProgress.verifiedCount} verified
          </CardDescription>
          {isStaff ? (
            <CardAction>
              <Button
                size="sm"
                data-testid="checklist-add-task"
                onClick={() => setDialogOpen(true)}
              >
                <PlusIcon aria-hidden />
                Add task
              </Button>
            </CardAction>
          ) : null}
        </CardHeader>
        <CardContent className="flex items-center gap-3">
          <div
            role="progressbar"
            aria-label="Checklist progress"
            aria-valuenow={liveProgress.percent}
            aria-valuemin={0}
            aria-valuemax={100}
            className="h-2 flex-1 overflow-hidden rounded-full bg-muted"
          >
            <div
              className="h-full rounded-full bg-primary transition-all"
              style={{ width: `${liveProgress.percent}%` }}
            />
          </div>
          <span className="text-sm font-medium text-foreground">
            {liveProgress.percent}%
          </span>
        </CardContent>
      </Card>

      {actionError ? (
        <p role="alert" className="text-sm text-destructive">
          {actionError}
        </p>
      ) : null}

      {/* ── Phase sections ── */}
      {groups.length === 0 ? (
        <Card>
          <CardContent>
            <p className="text-sm text-muted-foreground">
              {isStaff
                ? "No checklist tasks yet. Publish a cohort template or add a custom task to get started."
                : "No checklist tasks yet — your counselor will set these up."}
            </p>
          </CardContent>
        </Card>
      ) : (
        groups.map((group) => {
          const phaseProgress = computeTaskProgress(group.tasks);
          const isCollapsed = collapsedPhases.has(group.key);
          return (
            <section key={group.key} className="rounded-xl border border-border">
              <button
                type="button"
                aria-expanded={!isCollapsed}
                aria-controls={`checklist-phase-${group.key}`}
                data-testid={`phase-header-${group.key}`}
                onClick={() => togglePhase(group.key)}
                className="flex w-full items-center gap-2 rounded-xl px-3 py-2.5 text-left outline-none hover:bg-muted/50 focus-visible:ring-3 focus-visible:ring-ring/50"
              >
                <ChevronDownIcon
                  aria-hidden
                  className={cn(
                    "size-4 shrink-0 text-muted-foreground transition-transform",
                    isCollapsed && "-rotate-90",
                  )}
                />
                <span className="flex-1 text-sm font-semibold text-foreground">
                  {group.label}
                </span>
                <span className="text-xs text-muted-foreground">
                  {phaseProgress.done}/{phaseProgress.total} done
                </span>
                <span
                  aria-hidden
                  className="h-1.5 w-16 shrink-0 overflow-hidden rounded-full bg-muted"
                >
                  <span
                    className="block h-full rounded-full bg-primary"
                    style={{ width: `${phaseProgress.percent}%` }}
                  />
                </span>
              </button>
              {!isCollapsed ? (
                <ul
                  id={`checklist-phase-${group.key}`}
                  className="space-y-2 px-3 pb-3"
                >
                  {group.tasks.map((task) => (
                    <TaskRow
                      key={task.id}
                      task={task}
                      viewerRole={viewerRole}
                      isStaff={isStaff}
                      todayIso={todayIso}
                      busy={busyTaskIds.has(task.id)}
                      onToggleStatus={(target) => void handleToggleStatus(target)}
                      onToggleVerified={(target) => void handleToggleVerified(target)}
                      onRequestDelete={setPendingDelete}
                    />
                  ))}
                </ul>
              ) : null}
            </section>
          );
        })
      )}

      {/* ── Custom-task dialog (counselor+) ── */}
      {isStaff ? (
        <CustomTaskDialog
          caseId={caseId}
          open={dialogOpen}
          onOpenChange={setDialogOpen}
          onCreated={handleTaskCreated}
        />
      ) : null}

      {/* ── Delete confirmation (destructive action guard) ── */}
      <Dialog
        open={pendingDelete !== null}
        onOpenChange={(open) => {
          if (!open) setPendingDelete(null);
        }}
      >
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Delete this task?</DialogTitle>
            <DialogDescription>
              {pendingDelete
                ? `"${pendingDelete.title}" will be removed from this case's checklist.`
                : ""}
            </DialogDescription>
          </DialogHeader>
          <DialogFooter>
            <Button
              variant="outline"
              size="sm"
              onClick={() => setPendingDelete(null)}
              disabled={deleteSaving}
            >
              Keep task
            </Button>
            <Button
              variant="destructive"
              size="sm"
              onClick={() => void handleDeleteConfirmed()}
              disabled={deleteSaving}
            >
              {deleteSaving ? "Deleting…" : "Delete task"}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}
