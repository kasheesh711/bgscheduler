"use client";

// ----------------------------------------------------------------------------
// Admissions resource library panel (design §4, PRD CM-92) — the curated link
// library grouped by topic (the 10 checklist phases then General). Rendered
// in two places: the student portal's More → Resources sub-view (read-only
// list) and the staff caseload's Resources dialog (list + add/edit/delete).
//
// Role gate (presentation only — the API re-resolves staff rights from
// Postgres on every write): canManageResources mirrors the route's
// requireCounselorOrAdmin bar. Family viewers get links only; no mutation
// affordances are rendered for them (fail-closed).
//
// Data is server-fetched by the owning page (listResources) and passed in as
// props; successful mutations router.refresh() so the server list re-hydrates.
// ----------------------------------------------------------------------------

import { useCallback, useState } from "react";
import { useRouter } from "next/navigation";
import { BookOpenIcon, ExternalLinkIcon } from "lucide-react";

import { cn } from "@/lib/utils";
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
import { SELECT_FIELD_CLASSES } from "@/components/admissions/field-classes";
import { roleAtLeast } from "@/lib/admissions/config";
import { ADMISSIONS_RESOURCE_TOPICS } from "@/lib/admissions/shared/resources";
import type { AdmissionsResourceDto, AdmissionsResourceTopicGroup } from "@/lib/admissions/resources";
import type { CaseRole } from "@/lib/admissions/types";

const SELECT_CLASSES = cn(SELECT_FIELD_CLASSES, "h-8 w-full");

// ── Pure helpers (exported for tests) ───────────────────────────────────

/** True when the viewer may manage resources (counselor/admin, design §4). */
export function canManageResources(viewerRole: CaseRole): boolean {
  return roleAtLeast(viewerRole, "counselor");
}

/** Resource add/edit form model; topic is "" until the author picks one. */
export interface ResourceFormValues {
  topic: string;
  title: string;
  url: string;
}

/** Blank form — topic deliberately unset (explicit choice required). */
export const EMPTY_RESOURCE_FORM: ResourceFormValues = {
  topic: "",
  title: "",
  url: "",
};

/** buildResourcePayload result — a ready request body or an inline error. */
export type ResourcePayloadResult =
  | { ok: true; body: { topic: string; title: string; url: string } }
  | { ok: false; error: string };

/**
 * Validates the form and builds the POST/PATCH body (CM-92). Returns an
 * inline error instead of guessing: a missing topic choice, a blank title,
 * and a non-https URL are all rejected — mirroring the route schemas (which
 * re-validate on every request).
 */
export function buildResourcePayload(form: ResourceFormValues): ResourcePayloadResult {
  const title = form.title.trim();
  const url = form.url.trim();
  if (!form.topic) return { ok: false, error: "Choose a topic for the resource." };
  if (!title) return { ok: false, error: "Resource title is required." };
  if (!url.startsWith("https://")) {
    return { ok: false, error: "Resource URLs must start with https://." };
  }
  return { ok: true, body: { topic: form.topic, title, url } };
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

// ── Form fields (shared by the add and edit forms) ──────────────────────

function ResourceFormFields({
  form,
  onChange,
}: {
  form: ResourceFormValues;
  onChange: (form: ResourceFormValues) => void;
}) {
  return (
    <div className="space-y-3">
      <label className="block space-y-1 text-xs font-medium text-foreground">
        Topic
        <span aria-hidden className="text-destructive">
          {" "}
          *
        </span>
        <select
          className={SELECT_CLASSES}
          value={form.topic}
          onChange={(event) => onChange({ ...form, topic: event.target.value })}
        >
          <option value="">Choose a topic…</option>
          {ADMISSIONS_RESOURCE_TOPICS.map((topic) => (
            <option key={topic.key} value={topic.key}>
              {topic.label}
            </option>
          ))}
        </select>
      </label>
      <label className="block space-y-1 text-xs font-medium text-foreground">
        Title
        <span aria-hidden className="text-destructive">
          {" "}
          *
        </span>
        <Input
          value={form.title}
          onChange={(event) => onChange({ ...form, title: event.target.value })}
        />
      </label>
      <label className="block space-y-1 text-xs font-medium text-foreground">
        Link (https)
        <span aria-hidden className="text-destructive">
          {" "}
          *
        </span>
        <Input
          type="url"
          placeholder="https://…"
          value={form.url}
          onChange={(event) => onChange({ ...form, url: event.target.value })}
        />
      </label>
    </div>
  );
}

// ── Resource row ────────────────────────────────────────────────────────

function ResourceRow({
  resource,
  canManage,
  busy,
  editing,
  onStartEdit,
  onCancelEdit,
  onSaveEdit,
  onRequestDelete,
}: {
  resource: AdmissionsResourceDto;
  canManage: boolean;
  busy: boolean;
  editing: boolean;
  onStartEdit: (resource: AdmissionsResourceDto) => void;
  onCancelEdit: () => void;
  onSaveEdit: (resourceId: string, form: ResourceFormValues) => void;
  /** Opens the shared delete-confirmation dialog (never deletes directly). */
  onRequestDelete: (resource: AdmissionsResourceDto) => void;
}) {
  const [editForm, setEditForm] = useState<ResourceFormValues>({
    topic: resource.topic,
    title: resource.title,
    url: resource.url,
  });

  if (editing) {
    return (
      <li
        data-testid="resource-item"
        className="space-y-3 rounded-lg border border-border/60 p-3"
      >
        <form
          data-testid={`resource-edit-form-${resource.id}`}
          onSubmit={(event) => {
            event.preventDefault();
            onSaveEdit(resource.id, editForm);
          }}
          className="space-y-3"
        >
          <ResourceFormFields form={editForm} onChange={setEditForm} />
          <div className="flex items-center gap-2">
            <Button
              type="submit"
              size="sm"
              data-testid={`resource-save-${resource.id}`}
              disabled={!buildResourcePayload(editForm).ok || busy}
            >
              {busy ? "Saving…" : "Save"}
            </Button>
            <Button type="button" size="sm" variant="ghost" onClick={onCancelEdit}>
              Cancel
            </Button>
          </div>
        </form>
      </li>
    );
  }

  return (
    <li
      data-testid="resource-item"
      className="flex items-center gap-2 rounded-lg border border-border/60 px-3 py-2"
    >
      <a
        href={resource.url}
        target="_blank"
        rel="noreferrer"
        className="inline-flex min-w-0 flex-1 items-center gap-2 text-sm font-medium text-primary underline-offset-4 outline-none hover:underline focus-visible:ring-3 focus-visible:ring-ring/50"
      >
        <ExternalLinkIcon aria-hidden className="size-4 shrink-0" />
        <span className="truncate">{resource.title}</span>
      </a>
      {canManage ? (
        <div className="flex shrink-0 items-center gap-1">
          <Button
            type="button"
            size="sm"
            variant="ghost"
            data-testid={`resource-edit-${resource.id}`}
            disabled={busy}
            onClick={() => {
              setEditForm({
                topic: resource.topic,
                title: resource.title,
                url: resource.url,
              });
              onStartEdit(resource);
            }}
          >
            Edit
          </Button>
          <Button
            type="button"
            size="sm"
            variant="ghost"
            data-testid={`resource-delete-${resource.id}`}
            className="text-destructive"
            disabled={busy}
            onClick={() => onRequestDelete(resource)}
          >
            Delete
          </Button>
        </div>
      ) : null}
    </li>
  );
}

// ── Panel ───────────────────────────────────────────────────────────────

/** Props for ResourcesPanel — groups are server-fetched (listResources). */
export interface ResourcesPanelProps {
  /** Non-empty topic groups in canonical order (10 phases then General). */
  groups: AdmissionsResourceTopicGroup[];
  viewerRole: CaseRole;
}

/**
 * Resource library grouped by topic (CM-92). Family viewers get a read-only
 * link list with external-link icons; counselor/admin viewers additionally
 * get an add form plus per-resource edit/delete. The library is global
 * (shared across every student), so Delete is guarded by a confirmation
 * dialog (design §5.1 destructive-action rule) — one stray tap must never
 * remove a link for the whole org. Successful mutations reset the form and
 * router.refresh() so the server-fetched groups re-hydrate.
 */
export function ResourcesPanel({ groups, viewerRole }: ResourcesPanelProps) {
  const router = useRouter();
  const canManage = canManageResources(viewerRole);

  const [addForm, setAddForm] = useState<ResourceFormValues>(EMPTY_RESOURCE_FORM);
  const [editingId, setEditingId] = useState<string | null>(null);
  const [busyId, setBusyId] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [pendingDelete, setPendingDelete] = useState<AdmissionsResourceDto | null>(null);

  const canSubmitAdd = buildResourcePayload(addForm).ok;

  const handleCreate = useCallback(async () => {
    const result = buildResourcePayload(addForm);
    if (!result.ok) {
      setError(result.error);
      return;
    }
    setSaving(true);
    setError(null);
    try {
      const response = await fetch("/api/admissions/resources", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(result.body),
      });
      const payload: unknown = await response.json().catch(() => null);
      if (!response.ok) {
        setError(readErrorMessage(payload, "Failed to add the resource."));
        return;
      }
      setAddForm(EMPTY_RESOURCE_FORM);
      router.refresh();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to add the resource.");
    } finally {
      setSaving(false);
    }
  }, [addForm, router]);

  const handleSaveEdit = useCallback(
    async (resourceId: string, form: ResourceFormValues) => {
      const result = buildResourcePayload(form);
      if (!result.ok) {
        setError(result.error);
        return;
      }
      setBusyId(resourceId);
      setError(null);
      try {
        const response = await fetch("/api/admissions/resources", {
          method: "PATCH",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ resourceId, ...result.body }),
        });
        const payload: unknown = await response.json().catch(() => null);
        if (!response.ok) {
          setError(readErrorMessage(payload, "Failed to update the resource."));
          return;
        }
        setEditingId(null);
        router.refresh();
      } catch (err) {
        setError(err instanceof Error ? err.message : "Failed to update the resource.");
      } finally {
        setBusyId(null);
      }
    },
    [router],
  );

  /** Runs only from the confirmation dialog — never from the row button. */
  const handleDeleteConfirmed = useCallback(async () => {
    const resource = pendingDelete;
    if (!resource) return;
    setBusyId(resource.id);
    setError(null);
    try {
      const response = await fetch(
        `/api/admissions/resources?resourceId=${resource.id}`,
        { method: "DELETE" },
      );
      const payload: unknown = await response.json().catch(() => null);
      if (!response.ok) {
        setError(readErrorMessage(payload, "Failed to delete the resource."));
        return;
      }
      setPendingDelete(null);
      router.refresh();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to delete the resource.");
    } finally {
      setBusyId(null);
    }
  }, [pendingDelete, router]);

  return (
    <Card data-testid="resources-panel">
      <CardHeader>
        <CardTitle className="flex items-center gap-1.5">
          <BookOpenIcon aria-hidden className="size-4" />
          Resources
        </CardTitle>
        <CardDescription>
          {canManage
            ? "Curated links grouped by topic — visible to every student."
            : "Helpful links curated by your counselors."}
        </CardDescription>
      </CardHeader>
      <CardContent className="space-y-4">
        {canManage ? (
          <form
            data-testid="resource-add-form"
            onSubmit={(event) => {
              event.preventDefault();
              void handleCreate();
            }}
            className="space-y-3 rounded-lg border border-border/60 p-3"
          >
            <p className="text-sm font-medium text-foreground">Add a resource</p>
            <ResourceFormFields form={addForm} onChange={setAddForm} />
            <Button
              type="submit"
              size="sm"
              data-testid="resource-submit"
              disabled={!canSubmitAdd || saving}
            >
              {saving ? "Adding…" : "Add resource"}
            </Button>
          </form>
        ) : null}

        {error ? (
          <p role="alert" className="text-sm text-destructive">
            {error}
          </p>
        ) : null}

        {groups.length > 0 ? (
          <div className="space-y-4">
            {groups.map((group) => (
              <section
                key={group.topic}
                aria-label={group.label}
                data-testid={`resource-group-${group.topic}`}
                className="space-y-2"
              >
                <h3 className="text-sm font-semibold text-foreground">
                  {group.label}
                </h3>
                <ul className="space-y-2">
                  {group.resources.map((resource) => (
                    <ResourceRow
                      key={resource.id}
                      resource={resource}
                      canManage={canManage}
                      busy={busyId === resource.id}
                      editing={editingId === resource.id}
                      onStartEdit={(target) => setEditingId(target.id)}
                      onCancelEdit={() => setEditingId(null)}
                      onSaveEdit={(resourceId, form) => void handleSaveEdit(resourceId, form)}
                      onRequestDelete={setPendingDelete}
                    />
                  ))}
                </ul>
              </section>
            ))}
          </div>
        ) : (
          <p className="text-sm text-muted-foreground">
            {canManage
              ? "No resources yet. Add the first one above."
              : "No resources yet."}
          </p>
        )}

        {/* ── Delete confirmation (destructive action guard) ── */}
        <Dialog
          open={pendingDelete !== null}
          onOpenChange={(open) => {
            if (!open) setPendingDelete(null);
          }}
        >
          <DialogContent data-testid="resource-delete-dialog">
            <DialogHeader>
              <DialogTitle>Delete this resource?</DialogTitle>
              <DialogDescription>
                {pendingDelete
                  ? `"${pendingDelete.title}" will be removed for every student — the library is shared org-wide.`
                  : ""}
              </DialogDescription>
            </DialogHeader>
            <DialogFooter>
              <Button
                variant="outline"
                size="sm"
                onClick={() => setPendingDelete(null)}
                disabled={busyId !== null}
              >
                Keep resource
              </Button>
              <Button
                variant="destructive"
                size="sm"
                data-testid="resource-delete-confirm"
                onClick={() => void handleDeleteConfirmed()}
                disabled={busyId !== null}
              >
                {busyId !== null ? "Deleting…" : "Delete resource"}
              </Button>
            </DialogFooter>
          </DialogContent>
        </Dialog>
      </CardContent>
    </Card>
  );
}
