"use client";

import { useEffect, useMemo, useState } from "react";
import {
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
}: {
  runId: string | null;
  className?: string;
  onChanged?: () => void;
  refreshKey?: number;
}) {
  const [scope, setScope] = useState<LineLinkValidationScope>("my");
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

  return (
    <div className={cn("flex min-h-0 flex-col rounded-lg border border-border bg-card", className)}>
      <div className="border-b border-border p-3">
        <div className="flex flex-wrap items-start justify-between gap-2">
          <div>
            <div className="flex items-center gap-2 text-sm font-semibold text-foreground">
              <UserCheck className="size-4 text-primary" />
              Mapping validation
            </div>
            <p className="mt-1 text-xs text-muted-foreground">
              Assign suggested resolver links, then verify each LINE account to student-code mapping.
            </p>
          </div>
          <Button type="button" size="sm" variant="outline" onClick={() => loadValidation(scope)} disabled={Boolean(busy)}>
            {busy === "load" ? <Loader2 className="animate-spin" /> : <RefreshCw />}
            Refresh
          </Button>
        </div>

        <div className="mt-3 flex flex-wrap gap-1">
          {SCOPES.map((item) => (
            <button
              key={item.value}
              type="button"
              className={cn(
                "rounded-md border px-2 py-1 text-xs font-medium",
                scope === item.value
                  ? "border-primary bg-primary/10 text-primary"
                  : "border-border bg-background text-muted-foreground hover:text-foreground",
              )}
              onClick={() => setScope(item.value)}
            >
              {item.label}
            </button>
          ))}
        </div>

        <div className="mt-3 rounded-md border border-border bg-background p-2">
          <div className="flex flex-wrap items-center justify-between gap-2">
            <div className="text-xs font-medium text-foreground">Assign open tasks evenly</div>
            <Button
              type="button"
              size="sm"
              onClick={assignValidation}
              disabled={!runId || selectedReviewerPayload.length === 0 || busy === "assign"}
            >
              {busy === "assign" ? <Loader2 className="animate-spin" /> : <UserCheck />}
              Assign validation
            </Button>
          </div>
          <div className="mt-2 grid gap-1 sm:grid-cols-2">
            {reviewers.map((reviewer) => (
              <label
                key={reviewer.email}
                className="flex cursor-pointer items-center gap-2 rounded-md px-1.5 py-1 text-xs hover:bg-muted"
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

        {message ? (
          <div className="mt-2 rounded-md border border-border bg-background px-2 py-1.5 text-xs text-muted-foreground">
            {message}
          </div>
        ) : null}
      </div>

      <div className="min-h-0 flex-1 overflow-y-auto">
        {openTasks.length === 0 && scope !== "verified" && scope !== "rejected" ? (
          <div className="p-4 text-sm text-muted-foreground">
            No open validation tasks for this filter. Commit resolver candidates first, then assign validation.
          </div>
        ) : tasks.length === 0 ? (
          <div className="p-4 text-sm text-muted-foreground">No validation rows for this filter.</div>
        ) : (
          <div className="divide-y divide-border">
            {tasks.map((task) => (
              <div key={task.id} className="space-y-2 p-3">
                <div className="flex flex-wrap items-start justify-between gap-2">
                  <div className="min-w-0">
                    <div className="truncate text-sm font-semibold text-foreground">
                      {task.studentName}
                    </div>
                    <div className="truncate text-xs text-muted-foreground">
                      {task.studentKey} / Parent: {task.parentName || "n/a"}
                    </div>
                  </div>
                  <Badge variant={statusVariant(task.status)}>{task.status}</Badge>
                </div>

                <div className="rounded-md border border-border bg-background px-2 py-1.5 text-xs text-muted-foreground">
                  <div className="truncate text-foreground">
                    {task.chatTitle || task.contactDisplayName || task.lineUserId}
                  </div>
                  <div className="truncate">{evidenceLabel(task) || "No LINE role evidence"}</div>
                  <div className="truncate">Assigned: {assignmentLabel(task)}</div>
                </div>

                <div className="flex flex-wrap gap-2">
                  <Button
                    type="button"
                    size="sm"
                    variant="outline"
                    onClick={() => task.lineChatUrl && window.open(task.lineChatUrl, "_blank", "noopener,noreferrer")}
                    disabled={!task.lineChatUrl}
                  >
                    <ExternalLink />
                    Open LINE
                  </Button>
                  <Button
                    type="button"
                    size="sm"
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
                    onClick={() => patchTask(task.id, "rejected")}
                    disabled={task.status !== "suggested" || busy === `rejected:${task.id}`}
                  >
                    {busy === `rejected:${task.id}` ? <Loader2 className="animate-spin" /> : <XCircle />}
                    Reject
                  </Button>
                </div>

                {task.status === "suggested" ? (
                  <div className="grid gap-2 sm:grid-cols-[minmax(0,1fr)_auto]">
                    <select
                      className="h-8 rounded-lg border border-input bg-background px-2 text-xs"
                      value={rowAssignees[task.id] ?? ""}
                      onChange={(event) => setRowAssignees((current) => ({
                        ...current,
                        [task.id]: event.target.value,
                      }))}
                    >
                      <option value="">Reassign to...</option>
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
                      onClick={() => reassignTask(task.id)}
                      disabled={!rowAssignees[task.id] || busy === `reassign:${task.id}`}
                    >
                      {busy === `reassign:${task.id}` ? <Loader2 className="animate-spin" /> : <UserCheck />}
                      Reassign
                    </Button>
                  </div>
                ) : null}
              </div>
            ))}
          </div>
        )}
      </div>
    </div>
  );
}
