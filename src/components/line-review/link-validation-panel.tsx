"use client";

import { useEffect, useMemo, useState } from "react";
import {
  ChevronUp,
  ExternalLink,
  Loader2,
  RefreshCw,
  ShieldCheck,
  UserCheck,
  XCircle,
} from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";
import type {
  LineLinkValidationReviewer,
  LineLinkValidationScope,
  LineLinkValidationTask,
} from "./types";
import { jsonFetch } from "./utils";

const SCOPES: Array<{ value: LineLinkValidationScope; label: string }> = [
  { value: "my", label: "My assignments" },
  { value: "all", label: "All open" },
  { value: "unassigned", label: "Unassigned" },
  { value: "verified", label: "Verified" },
  { value: "rejected", label: "Rejected" },
];

function statusVariant(status: LineLinkValidationTask["status"]): "default" | "outline" | "destructive" | "secondary" {
  if (status === "verified") return "default";
  if (status === "rejected") return "destructive";
  return "secondary";
}

function assignmentLabel(task: LineLinkValidationTask): string {
  if (!task.validationAssignedToEmail) return "Unassigned";
  return task.validationAssignedToName
    ? `${task.validationAssignedToName} · ${task.validationAssignedToEmail}`
    : task.validationAssignedToEmail;
}

function evidenceLabel(task: LineLinkValidationTask): string {
  return [
    task.relationshipRole || "unknown role",
    task.adminNoteRaw,
    task.chatTitle,
  ].filter(Boolean).join(" / ");
}

export function LinkValidationPanel({
  runId,
  className,
  onChanged,
  refreshKey = 0,
  defaultScope = "my",
  assignmentOpen = false,
  onAssignmentOpenChange,
}: {
  runId: string | null;
  className?: string;
  onChanged?: () => void;
  refreshKey?: number;
  defaultScope?: LineLinkValidationScope;
  assignmentOpen?: boolean;
  onAssignmentOpenChange?: (open: boolean) => void;
}) {
  const [scope, setScope] = useState<LineLinkValidationScope>(defaultScope);
  const [scopeTouched, setScopeTouched] = useState(false);
  const [tasks, setTasks] = useState<LineLinkValidationTask[]>([]);
  const [reviewers, setReviewers] = useState<LineLinkValidationReviewer[]>([]);
  const [selectedReviewers, setSelectedReviewers] = useState<Set<string>>(new Set());
  const [rowAssignees, setRowAssignees] = useState<Record<string, string>>({});
  const [busy, setBusy] = useState<"load" | "assign" | string | null>(null);
  const [message, setMessage] = useState<string | null>(null);

  const openTasks = useMemo(() => tasks.filter((task) => task.status === "suggested"), [tasks]);
  const selectedReviewerPayload = useMemo(() => [...selectedReviewers], [selectedReviewers]);

  async function loadValidation(nextScope = scope) {
    setBusy("load");
    setMessage(null);
    try {
      const params = new URLSearchParams({ scope: nextScope });
      if (runId) params.set("runId", runId);
      const payload = await jsonFetch<{
        tasks: LineLinkValidationTask[];
        reviewers: LineLinkValidationReviewer[];
      }>(`/api/line/contacts/link-validation?${params.toString()}`);
      setTasks(payload.tasks);
      setReviewers(payload.reviewers);
    } catch (error) {
      setMessage(error instanceof Error ? error.message : "Failed to load validation queue");
    } finally {
      setBusy(null);
    }
  }

  function toggleReviewer(email: string) {
    setSelectedReviewers((current) => {
      const next = new Set(current);
      if (next.has(email)) next.delete(email);
      else next.add(email);
      return next;
    });
  }

  function updateScope(nextScope: LineLinkValidationScope) {
    setScopeTouched(true);
    setScope(nextScope);
  }

  async function assignValidation() {
    if (!runId || selectedReviewerPayload.length === 0) return;
    setBusy("assign");
    setMessage(null);
    try {
      const payload = await jsonFetch<{ assigned: number }>(
        "/api/line/contacts/link-validation/assign",
        {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ runId, reviewerEmails: selectedReviewerPayload }),
        },
      );
      setMessage(`Assigned ${payload.assigned} open validation task(s).`);
      await loadValidation(scope);
      onChanged?.();
    } catch (error) {
      setMessage(error instanceof Error ? error.message : "Assignment failed");
    } finally {
      setBusy(null);
    }
  }

  async function reassignTask(taskId: string) {
    if (!runId) return;
    const reviewerEmail = rowAssignees[taskId];
    if (!reviewerEmail) return;
    setBusy(`reassign:${taskId}`);
    setMessage(null);
    try {
      await jsonFetch<{ assigned: number }>(
        "/api/line/contacts/link-validation/assign",
        {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ runId, reviewerEmails: [reviewerEmail], linkIds: [taskId] }),
        },
      );
      setMessage("Task reassigned.");
      await loadValidation(scope);
      onChanged?.();
    } catch (error) {
      setMessage(error instanceof Error ? error.message : "Reassignment failed");
    } finally {
      setBusy(null);
    }
  }

  async function patchTask(taskId: string, status: "verified" | "rejected") {
    const note = status === "rejected"
      ? window.prompt("Optional rejection note for this mapping", "") ?? null
      : null;
    if (status === "rejected" && note === null) return;
    setBusy(`${status}:${taskId}`);
    setMessage(null);
    try {
      await jsonFetch<{ task: LineLinkValidationTask }>(
        `/api/line/contacts/link-validation/${taskId}`,
        {
          method: "PATCH",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ status, note }),
        },
      );
      setMessage(status === "verified" ? "Mapping verified." : "Mapping rejected.");
      await loadValidation(scope);
      onChanged?.();
    } catch (error) {
      setMessage(error instanceof Error ? error.message : "Validation update failed");
    } finally {
      setBusy(null);
    }
  }

  useEffect(() => {
    void loadValidation(scope);
  }, [runId, scope, refreshKey]);

  useEffect(() => {
    if (scopeTouched) return;
    setScope(defaultScope);
  }, [defaultScope, scopeTouched]);

  return (
    <div className={cn("flex min-h-0 flex-col rounded-lg border border-border bg-card", className)}>
      <div className="shrink-0 border-b border-border bg-card px-3 py-2">
        <div className="flex flex-wrap items-center justify-between gap-2">
          <div className="flex flex-wrap gap-1">
          {SCOPES.map((item) => (
            <button
              key={item.value}
              type="button"
              className={cn(
                "rounded-md border px-2.5 py-1 text-xs font-medium",
                scope === item.value
                  ? "border-primary bg-primary/10 text-primary"
                  : "border-border bg-background text-muted-foreground hover:text-foreground",
              )}
              onClick={() => updateScope(item.value)}
            >
              {item.label}
            </button>
          ))}
          </div>

          <div className="flex items-center gap-2 text-xs text-muted-foreground">
            <span>{tasks.length} shown</span>
            {busy === "load" ? <Loader2 className="size-3.5 animate-spin" /> : null}
            <Button
              type="button"
              size="sm"
              variant="ghost"
              onClick={() => loadValidation(scope)}
              disabled={Boolean(busy)}
            >
              <RefreshCw />
              Refresh rows
            </Button>
          </div>
        </div>

        {assignmentOpen ? (
          <div className="mt-2 rounded-lg border border-border bg-background p-2">
            <div className="flex flex-wrap items-center justify-between gap-2">
              <div className="flex items-center gap-2 text-xs font-semibold text-foreground">
                <UserCheck className="size-3.5 text-primary" />
                Assign open tasks evenly
              </div>
              <div className="flex items-center gap-2">
                <Button
                  type="button"
                  size="sm"
                  onClick={assignValidation}
                  disabled={!runId || selectedReviewerPayload.length === 0 || busy === "assign"}
                >
                  {busy === "assign" ? <Loader2 className="animate-spin" /> : <UserCheck />}
                  Assign validation
                </Button>
                <Button
                  type="button"
                  size="sm"
                  variant="ghost"
                  onClick={() => onAssignmentOpenChange?.(false)}
                >
                  <ChevronUp />
                  Hide
                </Button>
              </div>
            </div>
            <div className="mt-2 grid gap-1 md:grid-cols-3 xl:grid-cols-4 2xl:grid-cols-5">
            {reviewers.map((reviewer) => (
              <label
                key={reviewer.email}
                className="flex cursor-pointer items-center gap-2 rounded-md border border-transparent px-1.5 py-1 text-xs hover:border-border hover:bg-muted"
              >
                <input
                  type="checkbox"
                  checked={selectedReviewers.has(reviewer.email)}
                  onChange={() => toggleReviewer(reviewer.email)}
                />
                <span className="min-w-0 flex-1 truncate">
                  {reviewer.name || reviewer.email}
                </span>
                <Badge variant="outline">{reviewer.openAssignments}</Badge>
              </label>
            ))}
            </div>
          </div>
        ) : null}

        {message ? (
          <div className="mt-2 rounded-md border border-border bg-background px-2 py-1.5 text-xs text-muted-foreground">
            {message}
          </div>
        ) : null}
      </div>

      <div className="min-h-0 flex-1 overflow-auto">
        {openTasks.length === 0 && scope !== "verified" && scope !== "rejected" ? (
          <div className="p-4 text-sm text-muted-foreground">
            No open validation tasks for this filter. Commit resolver candidates first, then assign validation.
          </div>
        ) : tasks.length === 0 ? (
          <div className="p-4 text-sm text-muted-foreground">No validation rows for this filter.</div>
        ) : (
          <table className="w-full min-w-[1180px] table-fixed text-left text-sm">
            <thead className="sticky top-0 z-10 border-b border-border bg-muted/90 text-xs font-medium uppercase tracking-wide text-muted-foreground backdrop-blur">
              <tr>
                <th className="w-[28%] px-3 py-2">Student</th>
                <th className="w-[31%] px-3 py-2">LINE account</th>
                <th className="w-[18%] px-3 py-2">Assigned</th>
                <th className="w-[9%] px-3 py-2">Status</th>
                <th className="w-[14%] px-3 py-2 text-right">Actions</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-border">
              {tasks.map((task) => (
                <tr key={task.id} className="align-top hover:bg-muted/35">
                  <td className="px-3 py-2">
                    <div className="truncate font-semibold text-foreground">{task.studentName}</div>
                    <div className="truncate text-xs text-muted-foreground">
                      {task.studentKey} / Parent: {task.parentName || "n/a"}
                    </div>
                    <div className="mt-1 flex flex-wrap gap-1">
                      {task.currentStudentActivated === false ? (
                        <Badge variant="outline" className="text-[10px]">Inactive in Wise</Badge>
                      ) : null}
                      {task.currentStudentHasFutureSessions ? (
                        <Badge variant="outline" className="text-[10px]">Future sessions</Badge>
                      ) : null}
                    </div>
                  </td>
                  <td className="px-3 py-2">
                    <div className="truncate font-medium text-foreground">
                      {task.chatTitle || task.contactDisplayName || task.lineUserId}
                    </div>
                    <div className="truncate text-xs text-muted-foreground">
                      {evidenceLabel(task) || "No LINE role evidence"}
                    </div>
                    <div className="truncate text-[11px] text-muted-foreground">{task.lineUserId}</div>
                  </td>
                  <td className="px-3 py-2">
                    <div className="truncate text-xs text-muted-foreground">{assignmentLabel(task)}</div>
                    {task.status === "suggested" ? (
                      <div className="mt-1 flex gap-1">
                        <select
                          className="h-7 min-w-0 flex-1 rounded-md border border-input bg-background px-2 text-xs"
                          value={rowAssignees[task.id] ?? ""}
                          onChange={(event) => setRowAssignees((current) => ({
                            ...current,
                            [task.id]: event.target.value,
                          }))}
                        >
                          <option value="">Reassign...</option>
                          {reviewers.map((reviewer) => (
                            <option key={reviewer.email} value={reviewer.email}>
                              {reviewer.name || reviewer.email}
                            </option>
                          ))}
                        </select>
                        <Button
                          type="button"
                          size="sm"
                          variant="outline"
                          className="h-7 px-2"
                          onClick={() => reassignTask(task.id)}
                          disabled={!rowAssignees[task.id] || busy === `reassign:${task.id}`}
                        >
                          {busy === `reassign:${task.id}` ? <Loader2 className="animate-spin" /> : <UserCheck />}
                          <span className="sr-only">Reassign</span>
                        </Button>
                      </div>
                    ) : null}
                  </td>
                  <td className="px-3 py-2">
                    <Badge variant={statusVariant(task.status)}>{task.status}</Badge>
                  </td>
                  <td className="px-3 py-2">
                    <div className="flex justify-end gap-1">
                      <Button
                        type="button"
                        size="sm"
                        variant="outline"
                        className="h-7 px-2"
                        onClick={() => task.lineChatUrl && window.open(task.lineChatUrl, "_blank", "noopener,noreferrer")}
                        disabled={!task.lineChatUrl}
                      >
                        <ExternalLink />
                        LINE
                      </Button>
                      <Button
                        type="button"
                        size="sm"
                        className="h-7 px-2"
                        onClick={() => patchTask(task.id, "verified")}
                        disabled={task.status !== "suggested" || busy === `verified:${task.id}`}
                      >
                        {busy === `verified:${task.id}` ? <Loader2 className="animate-spin" /> : <ShieldCheck />}
                        Verify
                      </Button>
                      <Button
                        type="button"
                        size="sm"
                        variant="outline"
                        className="h-7 px-2"
                        onClick={() => patchTask(task.id, "rejected")}
                        disabled={task.status !== "suggested" || busy === `rejected:${task.id}`}
                      >
                        {busy === `rejected:${task.id}` ? <Loader2 className="animate-spin" /> : <XCircle />}
                        Reject
                      </Button>
                    </div>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </div>
    </div>
  );
}
