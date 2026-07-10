"use client";

// ----------------------------------------------------------------------------
// Admissions checklist-template editor (design §4, PRD CM-20/CM-21) — the
// admin workspace for a cohort's version-controlled checklist template.
//
// Picking a cohort lazily fetches GET /api/admissions/cohorts/{id}/templates
// ({ latest, versions }); the version history lists every version (Draft
// badge + Publish action on unpublished ones) and the editor below prefills
// from the LATEST version. Published versions are immutable (CM-20), so
// every save is POST { action: "create_version" } — "Save draft" leaves the
// new version unpublished, "Save & publish" sets publish: true.
//
// ITEMKEY RULE (load-bearing — push-new-items dedupes case tasks by itemKey,
// CM-21): items prefilled from an existing version keep their itemKey
// VERBATIM and the key is never editable; renaming a title must not mint a
// new key, or a push would duplicate the task on every live case. Only newly
// added rows derive a key from their title (slugified, numeric suffix on
// collision against all current keys) at save time.
//
// Role gate: the routes are admin-only server-side (requireAdmissionsAdmin);
// this component is mounted only on admin-facing manage surfaces.
// ----------------------------------------------------------------------------

import { useCallback, useEffect, useState } from "react";
import { ArrowDownIcon, ArrowUpIcon, ListChecksIcon } from "lucide-react";

import { cn } from "@/lib/utils";
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
import { Separator } from "@/components/ui/separator";
import { Textarea } from "@/components/ui/textarea";
import { SELECT_FIELD_CLASSES } from "@/components/admissions/field-classes";
import {
  ADMISSIONS_CHECKLIST_PHASES,
  getAdmissionsPhaseLabel,
} from "@/lib/admissions/shared/config";
import { ADMISSIONS_TASK_OWNERS } from "@/lib/admissions/shared/meetings";
import type { AdmissionsPhaseKey } from "@/lib/admissions/shared/config";
import type { AdmissionsTaskOwner } from "@/lib/admissions/shared/meetings";
import type { AdmissionsCohortDto } from "@/lib/admissions/types";
import type { AdmissionsTemplateDto, AdmissionsTemplateVersionDto } from "@/lib/admissions/checklists";

const SELECT_CLASSES = cn(SELECT_FIELD_CLASSES, "h-9 w-full");

const OWNER_LABELS: Record<AdmissionsTaskOwner, string> = {
  student: "Student",
  counselor: "Counselor",
  parent: "Parent",
};

// ── Pure helpers (exported for tests) ───────────────────────────────────

/** One editable checklist-item row in the template editor. */
export interface TemplateEditorItem {
  /**
   * Verbatim itemKey for rows loaded from an existing version — NEVER
   * regenerated or editable (push-new-items dedupes on it, CM-21). Null for
   * newly added rows; their key derives from the title at save time.
   */
  itemKey: string | null;
  phase: AdmissionsPhaseKey;
  title: string;
  description: string;
  defaultOwner: AdmissionsTaskOwner;
}

/**
 * Slugifies a title into an itemKey candidate: lowercase, every non-
 * alphanumeric run collapsed to "_", leading/trailing "_" trimmed. The
 * route requires /^[a-z][a-z0-9_]*$/, so an empty result falls back to
 * "item" and a leading digit is prefixed with "item_".
 */
export function slugifyItemKey(title: string): string {
  const slug = title
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "_")
    .replace(/^_+|_+$/g, "");
  if (!slug) return "item";
  return /^[a-z]/.test(slug) ? slug : `item_${slug}`;
}

/**
 * Derives a unique itemKey from a title: the slugified base when free, else
 * the first free numeric suffix ("essay_draft" → "essay_draft_2", "_3", …)
 * against every currently taken key.
 */
export function makeUniqueItemKey(title: string, takenKeys: readonly string[]): string {
  const taken = new Set(takenKeys);
  const base = slugifyItemKey(title);
  if (!taken.has(base)) return base;
  let suffix = 2;
  while (taken.has(`${base}_${suffix}`)) suffix += 1;
  return `${base}_${suffix}`;
}

/**
 * Final itemKeys for every editor row, index-aligned with `items`. Prefilled
 * rows keep their key verbatim; all verbatim keys are reserved up front so a
 * new row can never steal one, then each new row (itemKey null) gets a
 * slugified-title key with a numeric collision suffix, in row order.
 */
export function computeItemKeys(items: readonly TemplateEditorItem[]): string[] {
  const taken = new Set<string>();
  for (const item of items) {
    if (item.itemKey !== null) taken.add(item.itemKey);
  }
  return items.map((item) => {
    if (item.itemKey !== null) return item.itemKey;
    const key = makeUniqueItemKey(item.title, [...taken]);
    taken.add(key);
    return key;
  });
}

/**
 * Maps a template DTO into editor rows (sorted by sortOrder then itemKey,
 * mirroring the server read order). ItemKeys are copied VERBATIM; null
 * descriptions become "" for the controlled textarea. Null template → [].
 */
export function toEditorItems(template: AdmissionsTemplateDto | null): TemplateEditorItem[] {
  if (!template) return [];
  return [...template.items]
    .sort((a, b) => a.sortOrder - b.sortOrder || a.itemKey.localeCompare(b.itemKey))
    .map((item) => ({
      itemKey: item.itemKey,
      phase: item.phase as AdmissionsPhaseKey,
      title: item.title,
      description: item.description ?? "",
      defaultOwner: item.defaultOwner,
    }));
}

/**
 * Moves the row at `index` one step up/down WITHIN its phase group (the
 * editor renders per-phase sections, so reordering only swaps same-phase
 * neighbours). Returns a new array; a boundary move is a no-op.
 */
export function moveEditorItem(
  items: readonly TemplateEditorItem[],
  index: number,
  direction: "up" | "down",
): TemplateEditorItem[] {
  const current = items[index];
  if (!current) return [...items];
  let neighbour = -1;
  if (direction === "up") {
    for (let i = index - 1; i >= 0; i -= 1) {
      if (items[i]?.phase === current.phase) {
        neighbour = i;
        break;
      }
    }
  } else {
    for (let i = index + 1; i < items.length; i += 1) {
      if (items[i]?.phase === current.phase) {
        neighbour = i;
        break;
      }
    }
  }
  const swapped = items[neighbour];
  if (neighbour === -1 || !swapped) return [...items];
  const next = [...items];
  next[index] = swapped;
  next[neighbour] = current;
  return next;
}

/** One item entry in the create_version POST payload. */
export interface CreateVersionBodyItem {
  itemKey: string;
  phase: AdmissionsPhaseKey;
  title: string;
  description: string | null;
  defaultOwner: AdmissionsTaskOwner;
  sortOrder: number;
}

/** buildCreateVersionBody result — a ready POST body or an inline error. */
export type CreateVersionBodyResult =
  | {
      ok: true;
      body: {
        action: "create_version";
        items: CreateVersionBodyItem[];
        name?: string;
        publish?: boolean;
      };
    }
  | { ok: false; error: string };

/**
 * Validates the editor rows and builds the POST { action: "create_version" }
 * body (CM-20). Empty item lists and blank titles are rejected with inline
 * errors (the route re-validates with Zod). Items are emitted in canonical
 * phase order (stable within a phase) with sortOrder recomputed 0..n-1;
 * prefilled itemKeys pass through verbatim and new rows get derived keys
 * (computeItemKeys). Blank descriptions serialize as null.
 */
export function buildCreateVersionBody(
  items: readonly TemplateEditorItem[],
  options: { name?: string; publish?: boolean } = {},
): CreateVersionBodyResult {
  if (items.length === 0) {
    return { ok: false, error: "Add at least one checklist item before saving." };
  }
  if (items.some((item) => !item.title.trim())) {
    return { ok: false, error: "Every checklist item needs a title." };
  }

  const keys = computeItemKeys(items);
  const phaseRank = new Map<string, number>(
    ADMISSIONS_CHECKLIST_PHASES.map((phase, index) => [phase.key, index]),
  );
  const ordered = items
    .map((item, index) => ({ item, key: keys[index] ?? slugifyItemKey(item.title) }))
    .sort(
      (a, b) =>
        (phaseRank.get(a.item.phase) ?? ADMISSIONS_CHECKLIST_PHASES.length) -
        (phaseRank.get(b.item.phase) ?? ADMISSIONS_CHECKLIST_PHASES.length),
    );

  const name = options.name?.trim();
  return {
    ok: true,
    body: {
      action: "create_version",
      items: ordered.map(({ item, key }, index) => ({
        itemKey: key,
        phase: item.phase,
        title: item.title.trim(),
        description: item.description.trim() ? item.description.trim() : null,
        defaultOwner: item.defaultOwner,
        sortOrder: index,
      })),
      ...(name ? { name } : {}),
      ...(options.publish ? { publish: true } : {}),
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

function formatPublishedDate(iso: string): string {
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return iso;
  return date.toLocaleDateString("en-GB", { day: "numeric", month: "short", year: "numeric" });
}

// ── Item row ────────────────────────────────────────────────────────────

function TemplateItemRow({
  item,
  derivedKey,
  position,
  count,
  submitAttempted,
  disabled,
  onChange,
  onMove,
  onRemove,
}: {
  item: TemplateEditorItem;
  /** The final key this row saves with — verbatim or derived from the title. */
  derivedKey: string;
  /** Zero-based position within the row's phase group. */
  position: number;
  /** Number of rows in the phase group (for the Down-button boundary). */
  count: number;
  submitAttempted: boolean;
  disabled: boolean;
  onChange: (patch: Partial<TemplateEditorItem>) => void;
  onMove: (direction: "up" | "down") => void;
  onRemove: () => void;
}) {
  const showTitleError = submitAttempted && !item.title.trim();

  return (
    <li
      data-testid={`template-item-${derivedKey}`}
      className="space-y-2 rounded-lg border border-border/60 p-3"
    >
      <div className="flex items-center gap-2">
        <code className="min-w-0 flex-1 truncate text-xs text-muted-foreground">
          {item.itemKey !== null ? item.itemKey : `${derivedKey} (auto)`}
        </code>
        <div className="flex shrink-0 items-center gap-1">
          <Button
            type="button"
            size="sm"
            variant="ghost"
            aria-label={`Move "${item.title.trim() || derivedKey}" up`}
            data-testid={`template-item-up-${derivedKey}`}
            disabled={disabled || position === 0}
            onClick={() => onMove("up")}
          >
            <ArrowUpIcon aria-hidden className="size-4" />
          </Button>
          <Button
            type="button"
            size="sm"
            variant="ghost"
            aria-label={`Move "${item.title.trim() || derivedKey}" down`}
            data-testid={`template-item-down-${derivedKey}`}
            disabled={disabled || position === count - 1}
            onClick={() => onMove("down")}
          >
            <ArrowDownIcon aria-hidden className="size-4" />
          </Button>
          <Button
            type="button"
            size="sm"
            variant="ghost"
            className="text-destructive"
            data-testid={`template-item-remove-${derivedKey}`}
            disabled={disabled}
            onClick={onRemove}
          >
            Remove
          </Button>
        </div>
      </div>
      <label className="block space-y-1 text-xs font-medium text-foreground">
        Title
        <span aria-hidden className="text-destructive">
          {" "}
          *
        </span>
        <Input
          value={item.title}
          aria-invalid={showTitleError || undefined}
          onChange={(event) => onChange({ title: event.target.value })}
        />
      </label>
      {showTitleError ? (
        <p role="alert" className="text-xs text-destructive">
          Title is required.
        </p>
      ) : null}
      <div className="grid gap-2 sm:grid-cols-2">
        <label className="block space-y-1 text-xs font-medium text-foreground">
          Phase
          <select
            className={SELECT_CLASSES}
            value={item.phase}
            onChange={(event) => onChange({ phase: event.target.value as AdmissionsPhaseKey })}
          >
            {ADMISSIONS_CHECKLIST_PHASES.map((phase) => (
              <option key={phase.key} value={phase.key}>
                {getAdmissionsPhaseLabel(phase.key) ?? phase.key}
              </option>
            ))}
          </select>
        </label>
        <label className="block space-y-1 text-xs font-medium text-foreground">
          Default owner
          <select
            className={SELECT_CLASSES}
            value={item.defaultOwner}
            onChange={(event) =>
              onChange({ defaultOwner: event.target.value as AdmissionsTaskOwner })
            }
          >
            {ADMISSIONS_TASK_OWNERS.map((owner) => (
              <option key={owner} value={owner}>
                {OWNER_LABELS[owner]}
              </option>
            ))}
          </select>
        </label>
      </div>
      <label className="block space-y-1 text-xs font-medium text-foreground">
        Description
        <Textarea
          className="min-h-12"
          value={item.description}
          onChange={(event) => onChange({ description: event.target.value })}
        />
      </label>
    </li>
  );
}

// ── Workspace (version history + editor for one loaded cohort) ──────────

/** Props for TemplateWorkspace — data comes from the templates GET. */
export interface TemplateWorkspaceProps {
  cohortId: string;
  /** Latest version (any publish state) with items; null when none exist. */
  latest: AdmissionsTemplateDto | null;
  /** Full version history, newest first (no items). */
  versions: AdmissionsTemplateVersionDto[];
  /** Called with a success banner message after a save/publish; the owner re-fetches. */
  onSaved: (message: string) => void;
}

/**
 * Version history + editor for one cohort's checklist template. Exported
 * separately from TemplateEditor so tests can render it with fixture data
 * (the outer component owns the lazy GET). The editor prefills from the
 * latest version; prefilled itemKeys are locked verbatim (CM-21 dedupe key)
 * and saves always create a new version (CM-20 immutability).
 */
export function TemplateWorkspace({ cohortId, latest, versions, onSaved }: TemplateWorkspaceProps) {
  const [items, setItems] = useState<TemplateEditorItem[]>(() => toEditorItems(latest));
  const [name, setName] = useState("");
  const [formError, setFormError] = useState<string | null>(null);
  const [submitAttempted, setSubmitAttempted] = useState(false);
  const [saving, setSaving] = useState<"draft" | "publish" | null>(null);
  const [pendingPublish, setPendingPublish] = useState<AdmissionsTemplateVersionDto | null>(null);
  const [publishing, setPublishing] = useState(false);
  const [publishError, setPublishError] = useState<string | null>(null);
  const [showRemoveNote, setShowRemoveNote] = useState(false);

  const nextVersion = (latest?.version ?? 0) + 1;
  const derivedKeys = computeItemKeys(items);
  const busy = saving !== null;

  const handleItemChange = useCallback((index: number, patch: Partial<TemplateEditorItem>) => {
    setItems((current) => current.map((item, i) => (i === index ? { ...item, ...patch } : item)));
  }, []);

  const handleAddItem = useCallback((phase: AdmissionsPhaseKey) => {
    setItems((current) => [
      ...current,
      { itemKey: null, phase, title: "", description: "", defaultOwner: "student" },
    ]);
  }, []);

  const handleRemoveItem = useCallback((index: number) => {
    setShowRemoveNote(true);
    setItems((current) => current.filter((_, i) => i !== index));
  }, []);

  const handleMoveItem = useCallback((index: number, direction: "up" | "down") => {
    setItems((current) => moveEditorItem(current, index, direction));
  }, []);

  const handleSave = useCallback(
    async (publish: boolean) => {
      setSubmitAttempted(true);
      const result = buildCreateVersionBody(items, { name, publish });
      if (!result.ok) {
        setFormError(result.error);
        return;
      }
      setSaving(publish ? "publish" : "draft");
      setFormError(null);
      try {
        const response = await fetch(`/api/admissions/cohorts/${cohortId}/templates`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(result.body),
        });
        const payload: unknown = await response.json().catch(() => null);
        if (!response.ok) {
          setFormError(readErrorMessage(payload, "Failed to save the template version."));
          return;
        }
        const template = (payload as { template?: { version?: number } } | null)?.template;
        const savedVersion = typeof template?.version === "number" ? template.version : null;
        onSaved(
          savedVersion === null
            ? "Template version saved."
            : publish
              ? `Saved and published version ${savedVersion}.`
              : `Saved version ${savedVersion} as a draft.`,
        );
      } catch (err) {
        setFormError(err instanceof Error ? err.message : "Failed to save the template version.");
      } finally {
        setSaving(null);
      }
    },
    [cohortId, items, name, onSaved],
  );

  /** Runs only from the confirmation dialog — never from the row button. */
  const handlePublishConfirmed = useCallback(async () => {
    const target = pendingPublish;
    if (!target) return;
    setPublishing(true);
    setPublishError(null);
    try {
      const response = await fetch(`/api/admissions/cohorts/${cohortId}/templates`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ templateId: target.id }),
      });
      const payload: unknown = await response.json().catch(() => null);
      if (!response.ok) {
        setPublishError(readErrorMessage(payload, "Failed to publish the version."));
        return;
      }
      setPendingPublish(null);
      onSaved(`Published version ${target.version}.`);
    } catch (err) {
      setPublishError(err instanceof Error ? err.message : "Failed to publish the version.");
    } finally {
      setPublishing(false);
    }
  }, [cohortId, onSaved, pendingPublish]);

  return (
    <div className="space-y-4" data-testid="template-workspace">
      {/* ── Version history ── */}
      <section aria-label="Version history" className="space-y-2">
        <h3 className="text-sm font-semibold text-foreground">Version history</h3>
        {versions.length === 0 ? (
          <p className="text-sm text-muted-foreground">
            No template versions yet — build the first one below.
          </p>
        ) : (
          <ul className="space-y-2">
            {versions.map((version) => (
              <li
                key={version.id}
                data-testid={`template-version-${version.version}`}
                className="flex flex-wrap items-center gap-2 rounded-lg border border-border/60 px-3 py-2"
              >
                <span className="text-sm font-medium tabular-nums">v{version.version}</span>
                <span className="min-w-0 flex-1 truncate text-sm text-muted-foreground">
                  {version.name}
                </span>
                {version.id === latest?.id ? (
                  <span className="shrink-0 text-xs text-muted-foreground">
                    {latest.items.length} item{latest.items.length === 1 ? "" : "s"}
                  </span>
                ) : null}
                {version.publishedAt !== null ? (
                  <span className="shrink-0 text-xs text-muted-foreground">
                    Published {formatPublishedDate(version.publishedAt)}
                  </span>
                ) : (
                  <>
                    <Badge variant="outline">Draft</Badge>
                    <Button
                      type="button"
                      size="sm"
                      variant="outline"
                      data-testid={`template-publish-${version.version}`}
                      disabled={publishing}
                      onClick={() => setPendingPublish(version)}
                    >
                      Publish
                    </Button>
                  </>
                )}
              </li>
            ))}
          </ul>
        )}
        {publishError ? (
          <p role="alert" className="text-sm text-destructive">
            {publishError}
          </p>
        ) : null}
      </section>

      <Separator />

      {/* ── Editor (prefilled from the latest version) ── */}
      <section aria-label="Template editor" className="space-y-3">
        <div>
          <h3 className="text-sm font-semibold text-foreground">Edit checklist</h3>
          <p className="text-xs text-muted-foreground">
            {latest
              ? `Prefilled from v${latest.version}. Saving creates version ${nextVersion} — published versions are never changed in place.`
              : "This cohort has no template yet — saving creates version 1."}
          </p>
        </div>

        <label className="block space-y-1 text-xs font-medium text-foreground">
          Version name (optional)
          <Input
            data-testid="template-name-input"
            value={name}
            placeholder={`Checklist v${nextVersion}`}
            onChange={(event) => setName(event.target.value)}
          />
        </label>

        {showRemoveNote ? (
          <p data-testid="template-remove-note" className="text-xs text-muted-foreground">
            Removing an item only changes future versions — it never deletes tasks already
            created on existing cases.
          </p>
        ) : null}

        <div className="space-y-3">
          {ADMISSIONS_CHECKLIST_PHASES.map((phase) => {
            const entries = items
              .map((item, index) => ({ item, index }))
              .filter(({ item }) => item.phase === phase.key);
            return (
              <section
                key={phase.key}
                aria-label={phase.label}
                data-testid={`template-phase-${phase.key}`}
                className="space-y-2 rounded-lg border border-border/60 p-3"
              >
                <div className="flex items-center justify-between gap-2">
                  <h4 className="text-sm font-semibold text-foreground">
                    {phase.label}{" "}
                    <span className="text-xs font-normal text-muted-foreground">
                      ({entries.length})
                    </span>
                  </h4>
                  <Button
                    type="button"
                    size="sm"
                    variant="ghost"
                    data-testid={`template-add-item-${phase.key}`}
                    disabled={busy}
                    onClick={() => handleAddItem(phase.key)}
                  >
                    Add item
                  </Button>
                </div>
                {entries.length === 0 ? (
                  <p className="text-xs text-muted-foreground">No items in this phase.</p>
                ) : (
                  <ul className="space-y-2">
                    {entries.map(({ item, index }, position) => (
                      <TemplateItemRow
                        key={index}
                        item={item}
                        derivedKey={derivedKeys[index] ?? slugifyItemKey(item.title)}
                        position={position}
                        count={entries.length}
                        submitAttempted={submitAttempted}
                        disabled={busy}
                        onChange={(patch) => handleItemChange(index, patch)}
                        onMove={(direction) => handleMoveItem(index, direction)}
                        onRemove={() => handleRemoveItem(index)}
                      />
                    ))}
                  </ul>
                )}
              </section>
            );
          })}
        </div>

        {formError ? (
          <p role="alert" className="text-sm text-destructive">
            {formError}
          </p>
        ) : null}

        <div className="flex flex-wrap items-center gap-2">
          <Button
            type="button"
            size="sm"
            data-testid="template-save-draft"
            disabled={busy}
            onClick={() => void handleSave(false)}
          >
            {saving === "draft" ? "Saving…" : "Save draft"}
          </Button>
          <Button
            type="button"
            size="sm"
            variant="outline"
            data-testid="template-save-publish"
            disabled={busy}
            onClick={() => void handleSave(true)}
          >
            {saving === "publish" ? "Publishing…" : "Save & publish"}
          </Button>
        </div>
      </section>

      {/* ── Publish confirmation (immutability guard) ── */}
      <Dialog
        open={pendingPublish !== null}
        onOpenChange={(open) => {
          if (!open) setPendingPublish(null);
        }}
      >
        <DialogContent data-testid="template-publish-dialog">
          <DialogHeader>
            <DialogTitle>Publish this version?</DialogTitle>
            <DialogDescription>
              {pendingPublish
                ? `Version ${pendingPublish.version} ("${pendingPublish.name}") becomes the template new cases copy. Published versions are immutable — later edits create a new version.`
                : ""}
            </DialogDescription>
          </DialogHeader>
          <DialogFooter>
            <Button
              variant="outline"
              size="sm"
              onClick={() => setPendingPublish(null)}
              disabled={publishing}
            >
              Keep as draft
            </Button>
            <Button
              size="sm"
              data-testid="template-publish-confirm"
              onClick={() => void handlePublishConfirmed()}
              disabled={publishing}
            >
              {publishing ? "Publishing…" : "Publish version"}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}

// ── Editor (cohort picker + lazy fetch) ─────────────────────────────────

/** GET /api/admissions/cohorts/{id}/templates response shape. */
interface TemplatesPayload {
  latest: AdmissionsTemplateDto | null;
  versions: AdmissionsTemplateVersionDto[];
}

/** Props for TemplateEditor — cohorts come from the server-fetched page. */
export interface TemplateEditorProps {
  cohorts: AdmissionsCohortDto[];
  /** Owner-controlled cohort selection; null renders the picker prompt. */
  selectedCohortId: string | null;
  onSelectCohort: (cohortId: string) => void;
}

/**
 * Cohort checklist-template manager (CM-20/CM-21): a cohort Select that
 * lazily fetches { latest, versions }, a version history with Draft badges
 * and confirm-gated Publish, and an editor prefilled from the latest version
 * whose saves POST create_version (optionally publishing). After a save or
 * publish the data re-fetches and a success banner shows the outcome; the
 * workspace remounts only when the latest version id changes, so publishing
 * an old draft never clobbers in-progress edits.
 */
export function TemplateEditor({ cohorts, selectedCohortId, onSelectCohort }: TemplateEditorProps) {
  const [data, setData] = useState<TemplatesPayload | null>(null);
  const [loading, setLoading] = useState(false);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [banner, setBanner] = useState<string | null>(null);
  const [reloadNonce, setReloadNonce] = useState(0);

  useEffect(() => {
    if (!selectedCohortId) {
      setData(null);
      return;
    }
    let cancelled = false;
    setLoading(true);
    setLoadError(null);
    void (async () => {
      try {
        const response = await fetch(`/api/admissions/cohorts/${selectedCohortId}/templates`);
        const payload: unknown = await response.json().catch(() => null);
        if (cancelled) return;
        if (!response.ok) {
          setLoadError(readErrorMessage(payload, "Failed to load the cohort's templates."));
          setData(null);
          return;
        }
        setData(payload as TemplatesPayload);
      } catch (err) {
        if (cancelled) return;
        setLoadError(
          err instanceof Error ? err.message : "Failed to load the cohort's templates.",
        );
        setData(null);
      } finally {
        if (!cancelled) setLoading(false);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [selectedCohortId, reloadNonce]);

  const handleSaved = useCallback((message: string) => {
    setBanner(message);
    setReloadNonce((nonce) => nonce + 1);
  }, []);

  return (
    <Card data-testid="template-editor">
      <CardHeader>
        <CardTitle className="flex items-center gap-1.5">
          <ListChecksIcon aria-hidden className="size-4" />
          Checklist templates
        </CardTitle>
        <CardDescription>
          Version-controlled checklists per cohort. Published versions are immutable — every
          edit saves a new version.
        </CardDescription>
      </CardHeader>
      <CardContent className="space-y-4">
        <label className="block space-y-1 text-xs font-medium text-foreground">
          Cohort
          <select
            data-testid="template-cohort-select"
            className={SELECT_CLASSES}
            value={selectedCohortId ?? ""}
            onChange={(event) => {
              if (event.target.value) onSelectCohort(event.target.value);
            }}
          >
            <option value="">Choose a cohort…</option>
            {cohorts.map((cohort) => (
              <option key={cohort.id} value={cohort.id}>
                {cohort.name} — Class of {cohort.graduationYear}
              </option>
            ))}
          </select>
        </label>

        {banner ? (
          <p
            role="status"
            data-testid="template-success"
            className="rounded-lg border border-border/60 bg-muted/50 px-3 py-2 text-sm text-foreground"
          >
            {banner}
          </p>
        ) : null}
        {loadError ? (
          <p role="alert" className="text-sm text-destructive">
            {loadError}
          </p>
        ) : null}

        {!selectedCohortId ? (
          <p className="text-sm text-muted-foreground">
            Choose a cohort to view and edit its checklist template.
          </p>
        ) : loading && data === null ? (
          <p className="text-sm text-muted-foreground">Loading template…</p>
        ) : data !== null ? (
          <TemplateWorkspace
            key={`${selectedCohortId}:${data.latest?.id ?? "none"}`}
            cohortId={selectedCohortId}
            latest={data.latest}
            versions={data.versions}
            onSaved={handleSaved}
          />
        ) : null}
      </CardContent>
    </Card>
  );
}
