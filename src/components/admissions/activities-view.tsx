"use client";

// ----------------------------------------------------------------------------
// Admissions Activities view (design §2.4/§5.2, PRD CM-70..CM-72) — the
// standalone Activities surface for both the staff case tab ("tab" variant)
// and the mobile student portal ("portal" variant).
//
// Master list: one card per live activity (name + unlimited internal
// write-up + platform fill-in badges) with CM-70 cap messaging (n of 20).
// The per-activity editor has THREE blocks — Internal (unlimited), Common
// App (position/organization/description with LIVE hard-stop character
// counters mirroring the lib's exported limits, hrs/week, weeks/yr, grade
// multiselect, participation timing) and UC (350-char description counter +
// official category select). Counters render n/limit and turn red at 90% of
// the limit; typing past a limit is blocked (clampToLimit + maxLength — the
// route's Zod schemas remain the hard backstop). Each platform field has a
// copy-to-clipboard button with a success tick (CM-72, UI-only).
//
// Common App top-10 rank mode (CM-71): select at most
// MAX_COMMON_APP_RANKED_ACTIVITIES activities and order them via drag
// handles (HTML5 DnD) or the ALWAYS-PRESENT up/down buttons (accessible
// fallback); Save persists through PATCH {action: "rank", orderedIds}.
//
// Write gates mirror the API (design §2.4): students OWN this list, so
// student/counselor/admin all read-write (counselor writes are attributed
// server-side via the audit actorRole, never disguised); parents are
// strictly read-only. Edits send expectedUpdatedAt captured when the editor
// opened (design §6) — a 409 surfaces as a "changed elsewhere" message,
// never a silent overwrite. All mutations end in router.refresh(); server
// rows land through the same freshness-guarded override merge as the
// checklist tab.
// ----------------------------------------------------------------------------

import { useCallback, useEffect, useId, useMemo, useRef, useState } from "react";
import { useRouter } from "next/navigation";
import {
  ArrowDownIcon,
  ArrowUpIcon,
  CheckIcon,
  CopyIcon,
  GripVerticalIcon,
  ListOrderedIcon,
  PencilIcon,
  PlusIcon,
  Trash2Icon,
  XIcon,
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
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import {
  ADMISSIONS_ACTIVITY_GRADES,
  ADMISSIONS_ACTIVITY_TIMINGS,
  COMMON_APP_DESCRIPTION_MAX_CHARS,
  COMMON_APP_HOURS_PER_WEEK_MAX,
  COMMON_APP_ORGANIZATION_MAX_CHARS,
  COMMON_APP_POSITION_MAX_CHARS,
  COMMON_APP_WEEKS_PER_YEAR_MAX,
  MAX_ACTIVE_ACTIVITIES_PER_CASE,
  MAX_COMMON_APP_RANKED_ACTIVITIES,
  UC_ACTIVITY_CATEGORIES,
  UC_ACTIVITY_CATEGORY_LABELS,
  UC_DESCRIPTION_MAX_CHARS,
  type AdmissionsActivityDto,
  type AdmissionsActivityGrade,
  type AdmissionsActivityTiming,
  type AdmissionsCommonAppBlock,
  type AdmissionsUcBlock,
  type UcActivityCategory,
} from "@/lib/admissions/activities";
import { roleAtLeast } from "@/lib/admissions/config";
import type { CaseRole } from "@/lib/admissions/types";

// ── Display labels ──────────────────────────────────────────────────────

/** Display labels for the Common App grade-level options. */
export const ACTIVITY_GRADE_LABELS: Record<AdmissionsActivityGrade, string> = {
  "9": "9",
  "10": "10",
  "11": "11",
  "12": "12",
  post: "Post-graduate",
};

/** Display labels for the Common App participation-timing options. */
export const ACTIVITY_TIMING_LABELS: Record<AdmissionsActivityTiming, string> = {
  school_year: "During school year",
  school_break: "During school break",
  all_year: "All year",
};

/** How long the per-field copy success tick stays visible (ms). */
export const COPY_FEEDBACK_MS = 2000;

/** Which surface hosts the view: staff case tab or mobile student portal. */
export type ActivitiesViewVariant = "tab" | "portal";

const SELECT_CLASSES =
  "h-8 w-full rounded-lg border border-input bg-transparent px-2 text-sm outline-none focus-visible:border-ring focus-visible:ring-3 focus-visible:ring-ring/50 dark:bg-input/30";

// ── Pure helpers (exported for tests) ───────────────────────────────────

/**
 * Hard-stop clamp for the platform char limits: returns `value` unchanged
 * while within `limit`, otherwise the first `limit` characters. Used in every
 * counted field's onChange (paste included) so typing past a limit is
 * blocked, mirroring the lib's hard Zod caps.
 */
export function clampToLimit(value: string, limit: number): string {
  return value.length <= limit ? value : value.slice(0, limit);
}

/**
 * True when a live counter should turn red: at or past 90% of the hard
 * limit (e.g. 135/150, 45/50). Zero/negative limits never warn.
 */
export function isCounterWarning(length: number, limit: number): boolean {
  return limit > 0 && length >= Math.ceil(limit * 0.9);
}

/**
 * Toggles an activity in the Common App top-10 selection (CM-71). Removing
 * always succeeds; adding is refused with null once the list already holds
 * MAX_COMMON_APP_RANKED_ACTIVITIES ids (the caller keeps the previous
 * selection and shows the "top 10 full" message).
 */
export function toggleRankedId(
  ids: readonly string[],
  id: string,
): string[] | null {
  if (ids.includes(id)) return ids.filter((existing) => existing !== id);
  if (ids.length >= MAX_COMMON_APP_RANKED_ACTIVITIES) return null;
  return [...ids, id];
}

/**
 * Moves the id at `index` one position up or down (the accessible
 * button-based reorder). Out-of-range moves return the list unchanged.
 */
export function moveRankedId(
  ids: readonly string[],
  index: number,
  direction: "up" | "down",
): string[] {
  const next = [...ids];
  const target = direction === "up" ? index - 1 : index + 1;
  if (index < 0 || index >= next.length || target < 0 || target >= next.length) {
    return next;
  }
  const moved = next[index];
  next[index] = next[target];
  next[target] = moved;
  return next;
}

/**
 * Moves the id at `fromIndex` to `toIndex` preserving the order of the rest
 * (the HTML5 drag-and-drop reorder). Invalid indices return the list
 * unchanged.
 */
export function moveRankedIdToIndex(
  ids: readonly string[],
  fromIndex: number,
  toIndex: number,
): string[] {
  const next = [...ids];
  if (
    fromIndex < 0 ||
    fromIndex >= next.length ||
    toIndex < 0 ||
    toIndex >= next.length
  ) {
    return next;
  }
  const [moved] = next.splice(fromIndex, 1);
  next.splice(toIndex, 0, moved);
  return next;
}

/**
 * The current Common App top-10 selection derived from persisted ranks:
 * ranked activities only, ordered by ascending commonAppRank (id tiebreak
 * for stability). Seeds rank mode.
 */
export function deriveRankedIds(
  activities: ReadonlyArray<Pick<AdmissionsActivityDto, "id" | "commonAppRank">>,
): string[] {
  return activities
    .filter((activity) => activity.commonAppRank !== null)
    .sort((a, b) => {
      const rankA = a.commonAppRank as number;
      const rankB = b.commonAppRank as number;
      if (rankA !== rankB) return rankA - rankB;
      return a.id < b.id ? -1 : a.id > b.id ? 1 : 0;
    })
    .map((activity) => activity.id);
}

/**
 * Toggles one grade in the Common App grade multiselect, keeping the result
 * in canonical ADMISSIONS_ACTIVITY_GRADES order (matches the lib's
 * duplicate-free subset rule).
 */
export function toggleGradeSelection(
  grades: readonly AdmissionsActivityGrade[],
  grade: AdmissionsActivityGrade,
): AdmissionsActivityGrade[] {
  const selected = new Set(grades);
  if (selected.has(grade)) selected.delete(grade);
  else selected.add(grade);
  return ADMISSIONS_ACTIVITY_GRADES.filter((option) => selected.has(option));
}

/**
 * Write gate mirroring the API (design §2.4): students own the activities
 * list, counselor/admin writes pass through (attributed server-side);
 * parents are read-only.
 */
export function canEditActivities(viewerRole: CaseRole): boolean {
  return roleAtLeast(viewerRole, "student");
}

/** Editor form state — numbers kept as raw input strings until submit. */
export interface ActivityDraft {
  name: string;
  fullDescription: string;
  caPosition: string;
  caOrganization: string;
  caDescription: string;
  caHrsWeek: string;
  caWeeksYear: string;
  caGrades: AdmissionsActivityGrade[];
  caTiming: AdmissionsActivityTiming | "";
  ucDescription: string;
  ucCategory: UcActivityCategory | "";
}

/** Empty editor draft (the create form's initial state). */
export const EMPTY_ACTIVITY_DRAFT: ActivityDraft = {
  name: "",
  fullDescription: "",
  caPosition: "",
  caOrganization: "",
  caDescription: "",
  caHrsWeek: "",
  caWeeksYear: "",
  caGrades: [],
  caTiming: "",
  ucDescription: "",
  ucCategory: "",
};

/**
 * Editor draft seeded from an existing activity (null → the empty create
 * draft). Stored numbers render as strings; absent block fields as "".
 */
export function makeActivityDraft(
  activity: AdmissionsActivityDto | null,
): ActivityDraft {
  if (!activity) return { ...EMPTY_ACTIVITY_DRAFT, caGrades: [] };
  return {
    name: activity.name,
    fullDescription: activity.fullDescription ?? "",
    caPosition: activity.commonApp?.position ?? "",
    caOrganization: activity.commonApp?.organization ?? "",
    caDescription: activity.commonApp?.description ?? "",
    caHrsWeek:
      activity.commonApp?.hrsWeek !== undefined
        ? String(activity.commonApp.hrsWeek)
        : "",
    caWeeksYear:
      activity.commonApp?.weeksYear !== undefined
        ? String(activity.commonApp.weeksYear)
        : "",
    caGrades: [...(activity.commonApp?.grades ?? [])],
    caTiming: activity.commonApp?.timing ?? "",
    ucDescription: activity.uc?.description ?? "",
    ucCategory: activity.uc?.category ?? "",
  };
}

/** Body shared by the create POST and the update PATCH. */
export interface ActivityWritePayload {
  name: string;
  fullDescription: string | null;
  commonApp: AdmissionsCommonAppBlock | null;
  uc: AdmissionsUcBlock | null;
}

/** buildActivityPayload result — first validation problem wins. */
export type ActivityPayloadResult =
  | { ok: true; payload: ActivityWritePayload }
  | { ok: false; error: string };

/**
 * Validates an editor draft into the API write payload. Mirrors the lib's
 * hard rules fail-closed: char limits are re-checked (the inputs clamp, this
 * is the belt-and-braces), hrs/week must be 0–168, weeks/year a whole number
 * 0–52. Blank platform fields are omitted; a block with no fields collapses
 * to null (clears it server-side).
 */
export function buildActivityPayload(draft: ActivityDraft): ActivityPayloadResult {
  const name = draft.name.trim();
  if (!name) return { ok: false, error: "Activity name is required." };

  if (draft.caPosition.length > COMMON_APP_POSITION_MAX_CHARS) {
    return {
      ok: false,
      error: `Position exceeds ${COMMON_APP_POSITION_MAX_CHARS} characters.`,
    };
  }
  if (draft.caOrganization.length > COMMON_APP_ORGANIZATION_MAX_CHARS) {
    return {
      ok: false,
      error: `Organization exceeds ${COMMON_APP_ORGANIZATION_MAX_CHARS} characters.`,
    };
  }
  if (draft.caDescription.length > COMMON_APP_DESCRIPTION_MAX_CHARS) {
    return {
      ok: false,
      error: `Common App description exceeds ${COMMON_APP_DESCRIPTION_MAX_CHARS} characters.`,
    };
  }
  if (draft.ucDescription.length > UC_DESCRIPTION_MAX_CHARS) {
    return {
      ok: false,
      error: `UC description exceeds ${UC_DESCRIPTION_MAX_CHARS} characters.`,
    };
  }

  let hrsWeek: number | undefined;
  if (draft.caHrsWeek.trim() !== "") {
    const parsed = Number(draft.caHrsWeek);
    if (
      !Number.isFinite(parsed) ||
      parsed < 0 ||
      parsed > COMMON_APP_HOURS_PER_WEEK_MAX
    ) {
      return {
        ok: false,
        error: `Hours per week must be a number between 0 and ${COMMON_APP_HOURS_PER_WEEK_MAX}.`,
      };
    }
    hrsWeek = parsed;
  }

  let weeksYear: number | undefined;
  if (draft.caWeeksYear.trim() !== "") {
    const parsed = Number(draft.caWeeksYear);
    if (
      !Number.isInteger(parsed) ||
      parsed < 0 ||
      parsed > COMMON_APP_WEEKS_PER_YEAR_MAX
    ) {
      return {
        ok: false,
        error: `Weeks per year must be a whole number between 0 and ${COMMON_APP_WEEKS_PER_YEAR_MAX}.`,
      };
    }
    weeksYear = parsed;
  }

  const commonApp: AdmissionsCommonAppBlock = {};
  if (draft.caPosition.trim() !== "") commonApp.position = draft.caPosition;
  if (draft.caOrganization.trim() !== "") commonApp.organization = draft.caOrganization;
  if (draft.caDescription.trim() !== "") commonApp.description = draft.caDescription;
  if (hrsWeek !== undefined) commonApp.hrsWeek = hrsWeek;
  if (weeksYear !== undefined) commonApp.weeksYear = weeksYear;
  if (draft.caGrades.length > 0) commonApp.grades = [...draft.caGrades];
  if (draft.caTiming !== "") commonApp.timing = draft.caTiming;

  const uc: AdmissionsUcBlock = {};
  if (draft.ucDescription.trim() !== "") uc.description = draft.ucDescription;
  if (draft.ucCategory !== "") uc.category = draft.ucCategory;

  const fullDescription = draft.fullDescription.trim();

  return {
    ok: true,
    payload: {
      name,
      fullDescription: fullDescription === "" ? null : fullDescription,
      commonApp: Object.keys(commonApp).length > 0 ? commonApp : null,
      uc: Object.keys(uc).length > 0 ? uc : null,
    },
  };
}

/**
 * Copies `text` via the async clipboard API (CM-72). Returns false — never
 * throws — when the API is unavailable (insecure context, old browser) or
 * the write is rejected, so callers simply skip the success tick.
 */
export async function copyTextToClipboard(text: string): Promise<boolean> {
  if (typeof navigator === "undefined" || !navigator.clipboard?.writeText) {
    return false;
  }
  try {
    await navigator.clipboard.writeText(text);
    return true;
  } catch {
    return false;
  }
}

/**
 * Merges optimistic overrides into the server activity list (same contract
 * as the checklist tab's mergeTaskOverrides):
 *
 * 1. A null override hides the row (optimistic delete).
 * 2. A row override replaces the base row only while its updatedAt is >= the
 *    base row's — once router.refresh() delivers fresher server data, the
 *    stale override stops shadowing it.
 * 3. Overrides whose id is not in the base list append at the end
 *    (optimistically created activities, until the refresh lands).
 */
export function mergeActivityOverrides(
  activities: readonly AdmissionsActivityDto[],
  overrides: Readonly<Record<string, AdmissionsActivityDto | null>>,
): AdmissionsActivityDto[] {
  const merged: AdmissionsActivityDto[] = [];
  const seen = new Set<string>();
  for (const activity of activities) {
    seen.add(activity.id);
    if (!(activity.id in overrides)) {
      merged.push(activity);
      continue;
    }
    const override = overrides[activity.id];
    if (override === null) continue;
    if (override === undefined) {
      merged.push(activity);
      continue;
    }
    merged.push(override.updatedAt >= activity.updatedAt ? override : activity);
  }
  for (const [id, override] of Object.entries(overrides)) {
    if (override !== null && override !== undefined && !seen.has(id)) {
      merged.push(override);
    }
  }
  return merged;
}

/**
 * Rank-first display order (client mirror of listActivitiesForCase): ranked
 * rows by ascending commonAppRank, then the rest by sortOrder, id tiebreak.
 */
export function compareActivityRows(
  a: Pick<AdmissionsActivityDto, "id" | "commonAppRank" | "sortOrder">,
  b: Pick<AdmissionsActivityDto, "id" | "commonAppRank" | "sortOrder">,
): number {
  if (a.commonAppRank !== null || b.commonAppRank !== null) {
    if (a.commonAppRank === null) return 1;
    if (b.commonAppRank === null) return -1;
    if (a.commonAppRank !== b.commonAppRank) return a.commonAppRank - b.commonAppRank;
  }
  if (a.sortOrder !== b.sortOrder) return a.sortOrder - b.sortOrder;
  return a.id < b.id ? -1 : a.id > b.id ? 1 : 0;
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

function readActivityFromPayload(payload: unknown): AdmissionsActivityDto | null {
  if (typeof payload === "object" && payload !== null && "activity" in payload) {
    const activity = (payload as { activity?: unknown }).activity;
    if (
      typeof activity === "object" &&
      activity !== null &&
      typeof (activity as { id?: unknown }).id === "string"
    ) {
      return activity as AdmissionsActivityDto;
    }
  }
  return null;
}

// ── Live character counter (n/limit, red at 90%) ────────────────────────

/** Props for the live n/limit counter next to each hard-capped field. */
export interface CharCounterProps {
  length: number;
  limit: number;
  testId: string;
}

/**
 * Live character counter: renders "n/limit" and turns red (destructive)
 * once length reaches 90% of the hard limit.
 */
export function CharCounter({ length, limit, testId }: CharCounterProps) {
  const warn = isCounterWarning(length, limit);
  return (
    <span
      data-testid={testId}
      aria-live="polite"
      className={cn(
        "text-xs tabular-nums",
        warn ? "font-medium text-destructive" : "text-muted-foreground",
      )}
    >
      {length}/{limit}
    </span>
  );
}

// ── Copy-per-field button (CM-72) ───────────────────────────────────────

function CopyFieldButton({
  fieldLabel,
  copied,
  disabled,
  onCopy,
}: {
  fieldLabel: string;
  copied: boolean;
  disabled: boolean;
  onCopy: () => void;
}) {
  return (
    <Button
      type="button"
      size="xs"
      variant="ghost"
      disabled={disabled}
      onClick={onCopy}
      aria-label={`Copy ${fieldLabel}`}
    >
      {copied ? (
        <CheckIcon aria-hidden className="text-available" />
      ) : (
        <CopyIcon aria-hidden />
      )}
      {copied ? "Copied" : "Copy"}
    </Button>
  );
}

// ── Per-activity editor (three blocks) ──────────────────────────────────

/** The four copyable platform fields (CM-72). */
export type CopyFieldKey =
  | "caPosition"
  | "caOrganization"
  | "caDescription"
  | "ucDescription";

/** Props for the three-block activity editor form. */
export interface ActivityEditorProps {
  heading: string;
  draft: ActivityDraft;
  busy: boolean;
  errorMessage: string | null;
  submitLabel: string;
  onDraftChange: (draft: ActivityDraft) => void;
  onSubmit: () => void;
  onCancel: () => void;
}

/**
 * Three-block activity editor (CM-70): Internal (unlimited), Common App
 * (hard-stop counters at 50/100/150 + hrs/week, weeks/yr, grades, timing)
 * and UC (350 counter + category). Copy buttons copy the LIVE draft value
 * per field and show a success tick for COPY_FEEDBACK_MS. Exported so the
 * student portal slot can reuse it directly.
 */
export function ActivityEditor({
  heading,
  draft,
  busy,
  errorMessage,
  submitLabel,
  onDraftChange,
  onSubmit,
  onCancel,
}: ActivityEditorProps) {
  const fieldIdPrefix = useId();
  const [copiedField, setCopiedField] = useState<CopyFieldKey | null>(null);
  const copyTimeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(() => {
    return () => {
      if (copyTimeoutRef.current) clearTimeout(copyTimeoutRef.current);
    };
  }, []);

  const handleCopy = useCallback(async (field: CopyFieldKey, value: string) => {
    const copied = await copyTextToClipboard(value);
    if (!copied) return;
    setCopiedField(field);
    if (copyTimeoutRef.current) clearTimeout(copyTimeoutRef.current);
    copyTimeoutRef.current = setTimeout(() => setCopiedField(null), COPY_FEEDBACK_MS);
  }, []);

  const setField = useCallback(
    <K extends keyof ActivityDraft>(field: K, value: ActivityDraft[K]) => {
      onDraftChange({ ...draft, [field]: value });
    },
    [draft, onDraftChange],
  );

  return (
    <form
      data-testid="activity-editor"
      onSubmit={(event) => {
        event.preventDefault();
        onSubmit();
      }}
      className="space-y-4"
    >
      <h3 className="text-sm font-semibold text-foreground">{heading}</h3>

      {/* ── Block 1: internal (unlimited) ── */}
      <section aria-label="Internal details" className="space-y-3">
        <div className="space-y-1">
          <label
            htmlFor={`${fieldIdPrefix}-name`}
            className="text-xs font-medium text-foreground"
          >
            Activity name
            <span aria-hidden className="text-destructive">
              {" "}
              *
            </span>
          </label>
          <Input
            id={`${fieldIdPrefix}-name`}
            value={draft.name}
            disabled={busy}
            onChange={(event) => setField("name", event.target.value)}
          />
        </div>
        <div className="space-y-1">
          <label
            htmlFor={`${fieldIdPrefix}-full-description`}
            className="text-xs font-medium text-foreground"
          >
            Full description
          </label>
          <Textarea
            id={`${fieldIdPrefix}-full-description`}
            value={draft.fullDescription}
            disabled={busy}
            rows={4}
            onChange={(event) => setField("fullDescription", event.target.value)}
          />
          <p className="text-xs text-muted-foreground">
            Internal write-up — no character limit. Platform versions below are
            hard-capped.
          </p>
        </div>
      </section>

      {/* ── Block 2: Common App (hard-stop counters) ── */}
      <section
        aria-label="Common App version"
        className="space-y-3 rounded-lg border border-border/60 p-3"
      >
        <h4 className="text-xs font-semibold tracking-wide text-muted-foreground uppercase">
          Common App
        </h4>

        <div className="space-y-1">
          <div className="flex items-center justify-between gap-2">
            <label
              htmlFor={`${fieldIdPrefix}-ca-position`}
              className="text-xs font-medium text-foreground"
            >
              Position / leadership
            </label>
            <div className="flex items-center gap-1">
              <CharCounter
                length={draft.caPosition.length}
                limit={COMMON_APP_POSITION_MAX_CHARS}
                testId="counter-ca-position"
              />
              <CopyFieldButton
                fieldLabel="position"
                copied={copiedField === "caPosition"}
                disabled={draft.caPosition === ""}
                onCopy={() => void handleCopy("caPosition", draft.caPosition)}
              />
            </div>
          </div>
          <Input
            id={`${fieldIdPrefix}-ca-position`}
            value={draft.caPosition}
            disabled={busy}
            maxLength={COMMON_APP_POSITION_MAX_CHARS}
            onChange={(event) =>
              setField(
                "caPosition",
                clampToLimit(event.target.value, COMMON_APP_POSITION_MAX_CHARS),
              )
            }
          />
        </div>

        <div className="space-y-1">
          <div className="flex items-center justify-between gap-2">
            <label
              htmlFor={`${fieldIdPrefix}-ca-organization`}
              className="text-xs font-medium text-foreground"
            >
              Organization name
            </label>
            <div className="flex items-center gap-1">
              <CharCounter
                length={draft.caOrganization.length}
                limit={COMMON_APP_ORGANIZATION_MAX_CHARS}
                testId="counter-ca-organization"
              />
              <CopyFieldButton
                fieldLabel="organization"
                copied={copiedField === "caOrganization"}
                disabled={draft.caOrganization === ""}
                onCopy={() => void handleCopy("caOrganization", draft.caOrganization)}
              />
            </div>
          </div>
          <Input
            id={`${fieldIdPrefix}-ca-organization`}
            value={draft.caOrganization}
            disabled={busy}
            maxLength={COMMON_APP_ORGANIZATION_MAX_CHARS}
            onChange={(event) =>
              setField(
                "caOrganization",
                clampToLimit(event.target.value, COMMON_APP_ORGANIZATION_MAX_CHARS),
              )
            }
          />
        </div>

        <div className="space-y-1">
          <div className="flex items-center justify-between gap-2">
            <label
              htmlFor={`${fieldIdPrefix}-ca-description`}
              className="text-xs font-medium text-foreground"
            >
              Description
            </label>
            <div className="flex items-center gap-1">
              <CharCounter
                length={draft.caDescription.length}
                limit={COMMON_APP_DESCRIPTION_MAX_CHARS}
                testId="counter-ca-description"
              />
              <CopyFieldButton
                fieldLabel="Common App description"
                copied={copiedField === "caDescription"}
                disabled={draft.caDescription === ""}
                onCopy={() => void handleCopy("caDescription", draft.caDescription)}
              />
            </div>
          </div>
          <Textarea
            id={`${fieldIdPrefix}-ca-description`}
            value={draft.caDescription}
            disabled={busy}
            rows={3}
            maxLength={COMMON_APP_DESCRIPTION_MAX_CHARS}
            onChange={(event) =>
              setField(
                "caDescription",
                clampToLimit(event.target.value, COMMON_APP_DESCRIPTION_MAX_CHARS),
              )
            }
          />
        </div>

        <div className="grid gap-3 sm:grid-cols-2">
          <div className="space-y-1">
            <label
              htmlFor={`${fieldIdPrefix}-ca-hrs-week`}
              className="text-xs font-medium text-foreground"
            >
              Hours / week
            </label>
            <Input
              id={`${fieldIdPrefix}-ca-hrs-week`}
              type="number"
              min={0}
              max={COMMON_APP_HOURS_PER_WEEK_MAX}
              step="0.5"
              value={draft.caHrsWeek}
              disabled={busy}
              onChange={(event) => setField("caHrsWeek", event.target.value)}
            />
          </div>
          <div className="space-y-1">
            <label
              htmlFor={`${fieldIdPrefix}-ca-weeks-year`}
              className="text-xs font-medium text-foreground"
            >
              Weeks / year
            </label>
            <Input
              id={`${fieldIdPrefix}-ca-weeks-year`}
              type="number"
              min={0}
              max={COMMON_APP_WEEKS_PER_YEAR_MAX}
              step={1}
              value={draft.caWeeksYear}
              disabled={busy}
              onChange={(event) => setField("caWeeksYear", event.target.value)}
            />
          </div>
        </div>

        <fieldset className="space-y-1">
          <legend className="text-xs font-medium text-foreground">
            Grade levels
          </legend>
          <div className="flex flex-wrap gap-x-4 gap-y-1">
            {ADMISSIONS_ACTIVITY_GRADES.map((grade) => (
              <label
                key={grade}
                className="flex items-center gap-1.5 text-sm text-foreground"
              >
                <input
                  type="checkbox"
                  data-testid={`grade-checkbox-${grade}`}
                  className="size-4 accent-primary"
                  checked={draft.caGrades.includes(grade)}
                  disabled={busy}
                  onChange={() =>
                    setField("caGrades", toggleGradeSelection(draft.caGrades, grade))
                  }
                />
                {ACTIVITY_GRADE_LABELS[grade]}
              </label>
            ))}
          </div>
        </fieldset>

        <div className="space-y-1">
          <label
            htmlFor={`${fieldIdPrefix}-ca-timing`}
            className="text-xs font-medium text-foreground"
          >
            Participation timing
          </label>
          <select
            id={`${fieldIdPrefix}-ca-timing`}
            className={SELECT_CLASSES}
            value={draft.caTiming}
            disabled={busy}
            onChange={(event) =>
              setField("caTiming", event.target.value as ActivityDraft["caTiming"])
            }
          >
            <option value="">Not set</option>
            {ADMISSIONS_ACTIVITY_TIMINGS.map((timing) => (
              <option key={timing} value={timing}>
                {ACTIVITY_TIMING_LABELS[timing]}
              </option>
            ))}
          </select>
        </div>
      </section>

      {/* ── Block 3: UC (350 counter + official category) ── */}
      <section
        aria-label="UC version"
        className="space-y-3 rounded-lg border border-border/60 p-3"
      >
        <h4 className="text-xs font-semibold tracking-wide text-muted-foreground uppercase">
          UC
        </h4>

        <div className="space-y-1">
          <div className="flex items-center justify-between gap-2">
            <label
              htmlFor={`${fieldIdPrefix}-uc-description`}
              className="text-xs font-medium text-foreground"
            >
              Description
            </label>
            <div className="flex items-center gap-1">
              <CharCounter
                length={draft.ucDescription.length}
                limit={UC_DESCRIPTION_MAX_CHARS}
                testId="counter-uc-description"
              />
              <CopyFieldButton
                fieldLabel="UC description"
                copied={copiedField === "ucDescription"}
                disabled={draft.ucDescription === ""}
                onCopy={() => void handleCopy("ucDescription", draft.ucDescription)}
              />
            </div>
          </div>
          <Textarea
            id={`${fieldIdPrefix}-uc-description`}
            value={draft.ucDescription}
            disabled={busy}
            rows={4}
            maxLength={UC_DESCRIPTION_MAX_CHARS}
            onChange={(event) =>
              setField(
                "ucDescription",
                clampToLimit(event.target.value, UC_DESCRIPTION_MAX_CHARS),
              )
            }
          />
        </div>

        <div className="space-y-1">
          <label
            htmlFor={`${fieldIdPrefix}-uc-category`}
            className="text-xs font-medium text-foreground"
          >
            Category
          </label>
          <select
            id={`${fieldIdPrefix}-uc-category`}
            className={SELECT_CLASSES}
            value={draft.ucCategory}
            disabled={busy}
            onChange={(event) =>
              setField("ucCategory", event.target.value as ActivityDraft["ucCategory"])
            }
          >
            <option value="">Not set</option>
            {UC_ACTIVITY_CATEGORIES.map((category) => (
              <option key={category} value={category}>
                {UC_ACTIVITY_CATEGORY_LABELS[category]}
              </option>
            ))}
          </select>
        </div>
      </section>

      {errorMessage ? (
        <p role="alert" className="text-sm text-destructive">
          {errorMessage}
        </p>
      ) : null}

      <div className="flex justify-end gap-2">
        <Button
          type="button"
          variant="outline"
          size="sm"
          disabled={busy}
          onClick={onCancel}
        >
          Cancel
        </Button>
        <Button type="submit" size="sm" disabled={busy}>
          {busy ? "Saving…" : submitLabel}
        </Button>
      </div>
    </form>
  );
}

// ── Activities view ─────────────────────────────────────────────────────

/** Editor session: which activity (null = create) + the §6 concurrency token. */
interface EditorState {
  activityId: string | null;
  /** Row updatedAt captured when the editor opened (design §6). */
  expectedUpdatedAt: string | null;
  draft: ActivityDraft;
}

/** Props for ActivitiesView — activities are server-fetched by the page. */
export interface ActivitiesViewProps {
  caseId: string;
  /** Live activities (listActivitiesForCase order: ranked first). */
  activities: AdmissionsActivityDto[];
  viewerRole: CaseRole;
  variant: ActivitiesViewVariant;
}

/**
 * Activities master list + three-block editor + Common App top-10 rank mode
 * (CM-70..72). See the file header for the full behavior contract.
 */
export function ActivitiesView({
  caseId,
  activities,
  viewerRole,
  variant,
}: ActivitiesViewProps) {
  const router = useRouter();
  const canEdit = canEditActivities(viewerRole);
  const apiPath = `/api/admissions/cases/${caseId}/activities`;

  const [overrides, setOverrides] = useState<
    Record<string, AdmissionsActivityDto | null>
  >({});
  const [editor, setEditor] = useState<EditorState | null>(null);
  const [editorError, setEditorError] = useState<string | null>(null);
  const [editorSaving, setEditorSaving] = useState(false);
  const [rankMode, setRankMode] = useState(false);
  const [rankIds, setRankIds] = useState<string[]>([]);
  const [rankSaving, setRankSaving] = useState(false);
  const [rankError, setRankError] = useState<string | null>(null);
  const [pendingDelete, setPendingDelete] = useState<AdmissionsActivityDto | null>(
    null,
  );
  const [deleteSaving, setDeleteSaving] = useState(false);
  const [listError, setListError] = useState<string | null>(null);
  const dragIndexRef = useRef<number | null>(null);

  const merged = useMemo(
    () =>
      mergeActivityOverrides(activities, overrides).sort(compareActivityRows),
    [activities, overrides],
  );
  const activityById = useMemo(
    () => new Map(merged.map((activity) => [activity.id, activity])),
    [merged],
  );
  const liveCount = merged.length;
  const atCap = liveCount >= MAX_ACTIVE_ACTIVITIES_PER_CASE;
  const rankFull = rankIds.length >= MAX_COMMON_APP_RANKED_ACTIVITIES;
  const unrankedActivities = useMemo(
    () => merged.filter((activity) => !rankIds.includes(activity.id)),
    [merged, rankIds],
  );

  // ── Editor open/close ──
  const handleOpenCreate = useCallback(() => {
    setEditorError(null);
    setEditor({
      activityId: null,
      expectedUpdatedAt: null,
      draft: makeActivityDraft(null),
    });
  }, []);

  const handleOpenEdit = useCallback((activity: AdmissionsActivityDto) => {
    setEditorError(null);
    setEditor({
      activityId: activity.id,
      expectedUpdatedAt: activity.updatedAt,
      draft: makeActivityDraft(activity),
    });
  }, []);

  const handleCloseEditor = useCallback(() => {
    setEditor(null);
    setEditorError(null);
  }, []);

  // ── Create / update save (POST / PATCH action:"update", design §6) ──
  const handleSubmitEditor = useCallback(async () => {
    if (!editor) return;
    const result = buildActivityPayload(editor.draft);
    if (!result.ok) {
      setEditorError(result.error);
      return;
    }
    setEditorError(null);
    setEditorSaving(true);
    try {
      const isUpdate = editor.activityId !== null;
      const response = await fetch(apiPath, {
        method: isUpdate ? "PATCH" : "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(
          isUpdate
            ? {
                action: "update",
                activityId: editor.activityId,
                ...(editor.expectedUpdatedAt !== null
                  ? { expectedUpdatedAt: editor.expectedUpdatedAt }
                  : {}),
                ...result.payload,
              }
            : result.payload,
        ),
      });
      const payload: unknown = await response.json().catch(() => null);
      if (!response.ok) {
        if (response.status === 409) {
          setEditorError(
            isUpdate
              ? "This activity was changed elsewhere. Refresh the page to load the latest version, then reapply your edits."
              : `The list is full (${MAX_ACTIVE_ACTIVITIES_PER_CASE} of ${MAX_ACTIVE_ACTIVITIES_PER_CASE} activities). Delete one to add another.`,
          );
        } else {
          setEditorError(readErrorMessage(payload, "Failed to save the activity."));
        }
        return;
      }
      const serverActivity = readActivityFromPayload(payload);
      if (serverActivity) {
        setOverrides((previous) => ({
          ...previous,
          [serverActivity.id]: serverActivity,
        }));
      }
      setEditor(null);
      router.refresh();
    } catch (error) {
      setEditorError(
        error instanceof Error ? error.message : "Failed to save the activity.",
      );
    } finally {
      setEditorSaving(false);
    }
  }, [editor, apiPath, router]);

  // ── Delete (soft, confirmed via dialog) ──
  const handleDeleteConfirmed = useCallback(async () => {
    const activity = pendingDelete;
    if (!activity) return;
    setListError(null);
    setDeleteSaving(true);
    try {
      const response = await fetch(
        `${apiPath}?activityId=${encodeURIComponent(activity.id)}`,
        { method: "DELETE" },
      );
      const payload: unknown = await response.json().catch(() => null);
      if (!response.ok) {
        setListError(readErrorMessage(payload, "Failed to delete the activity."));
        return;
      }
      setOverrides((previous) => ({ ...previous, [activity.id]: null }));
      setRankIds((previous) => previous.filter((id) => id !== activity.id));
      setPendingDelete(null);
      if (editor?.activityId === activity.id) setEditor(null);
      router.refresh();
    } catch (error) {
      setListError(
        error instanceof Error ? error.message : "Failed to delete the activity.",
      );
    } finally {
      setDeleteSaving(false);
    }
  }, [pendingDelete, apiPath, editor, router]);

  // ── Rank mode (CM-71) ──
  const handleEnterRankMode = useCallback(() => {
    setRankIds(deriveRankedIds(merged));
    setRankError(null);
    setRankMode(true);
  }, [merged]);

  const handleExitRankMode = useCallback(() => {
    setRankMode(false);
    setRankError(null);
    dragIndexRef.current = null;
  }, []);

  const handleToggleRank = useCallback((activityId: string) => {
    setRankIds((previous) => toggleRankedId(previous, activityId) ?? previous);
  }, []);

  const handleMoveRank = useCallback(
    (index: number, direction: "up" | "down") => {
      setRankIds((previous) => moveRankedId(previous, index, direction));
    },
    [],
  );

  const handleDropOnRank = useCallback((toIndex: number) => {
    const fromIndex = dragIndexRef.current;
    dragIndexRef.current = null;
    if (fromIndex === null || fromIndex === toIndex) return;
    setRankIds((previous) => moveRankedIdToIndex(previous, fromIndex, toIndex));
  }, []);

  const handleSaveRanks = useCallback(async () => {
    // Drop ids of rows deleted while rank mode was open (defensive).
    const orderedIds = rankIds.filter((id) => activityById.has(id));
    setRankError(null);
    setRankSaving(true);
    try {
      const response = await fetch(apiPath, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ action: "rank", orderedIds }),
      });
      const payload: unknown = await response.json().catch(() => null);
      if (!response.ok) {
        setRankError(readErrorMessage(payload, "Failed to save the order."));
        return;
      }
      // Optimistic rank overrides until router.refresh() delivers server rows.
      setOverrides((previous) => {
        const next = { ...previous };
        for (const activity of merged) {
          const position = orderedIds.indexOf(activity.id);
          const targetRank = position === -1 ? null : position + 1;
          if (activity.commonAppRank !== targetRank) {
            next[activity.id] = { ...activity, commonAppRank: targetRank };
          }
        }
        return next;
      });
      setRankMode(false);
      router.refresh();
    } catch (error) {
      setRankError(
        error instanceof Error ? error.message : "Failed to save the order.",
      );
    } finally {
      setRankSaving(false);
    }
  }, [rankIds, activityById, apiPath, merged, router]);

  return (
    <div
      data-variant={variant}
      className={cn(variant === "portal" ? "space-y-3" : "space-y-4")}
    >
      {/* ── Header: CM-70 cap messaging + actions ── */}
      <Card>
        <CardHeader>
          <CardTitle>Activities</CardTitle>
          <CardDescription data-testid="activities-cap">
            {liveCount} of {MAX_ACTIVE_ACTIVITIES_PER_CASE} activities
            {canEdit && variant === "tab"
              ? " · Common App and UC versions with hard character limits"
              : ""}
          </CardDescription>
          {canEdit ? (
            <CardAction>
              <div className="flex items-center gap-2">
                <Button
                  size="sm"
                  variant="outline"
                  data-testid="rank-mode-toggle"
                  disabled={rankMode || merged.length === 0}
                  onClick={handleEnterRankMode}
                >
                  <ListOrderedIcon aria-hidden />
                  Rank top {MAX_COMMON_APP_RANKED_ACTIVITIES}
                </Button>
                <Button
                  size="sm"
                  data-testid="activities-add"
                  disabled={atCap || editor !== null}
                  onClick={handleOpenCreate}
                >
                  <PlusIcon aria-hidden />
                  Add activity
                </Button>
              </div>
            </CardAction>
          ) : null}
        </CardHeader>
        {atCap && canEdit ? (
          <CardContent>
            <p data-testid="cap-warning" className="text-xs text-muted-foreground">
              The master list is full ({MAX_ACTIVE_ACTIVITIES_PER_CASE} of{" "}
              {MAX_ACTIVE_ACTIVITIES_PER_CASE}). Delete an activity to add
              another.
            </p>
          </CardContent>
        ) : null}
      </Card>

      {listError ? (
        <p role="alert" className="text-sm text-destructive">
          {listError}
        </p>
      ) : null}

      {/* ── Rank mode panel (CM-71) ── */}
      {rankMode ? (
        <Card data-testid="rank-panel">
          <CardHeader>
            <CardTitle>Common App top {MAX_COMMON_APP_RANKED_ACTIVITIES}</CardTitle>
            <CardDescription>
              {rankIds.length} of {MAX_COMMON_APP_RANKED_ACTIVITIES} selected —
              drag rows or use the arrow buttons to set the order that goes on
              the Common App.
            </CardDescription>
          </CardHeader>
          <CardContent className="space-y-3">
            {rankIds.length > 0 ? (
              <ol className="space-y-2">
                {rankIds.map((id, index) => {
                  const activity = activityById.get(id);
                  if (!activity) return null;
                  return (
                    <li
                      key={id}
                      data-testid={`rank-row-${id}`}
                      draggable={!rankSaving}
                      onDragStart={() => {
                        dragIndexRef.current = index;
                      }}
                      onDragOver={(event) => event.preventDefault()}
                      onDrop={(event) => {
                        event.preventDefault();
                        handleDropOnRank(index);
                      }}
                      className="flex items-center gap-2 rounded-lg border border-border/60 bg-background p-2"
                    >
                      <GripVerticalIcon
                        aria-hidden
                        className="size-4 shrink-0 cursor-grab text-muted-foreground"
                      />
                      <span className="w-6 shrink-0 text-center text-xs font-semibold text-muted-foreground">
                        {index + 1}
                      </span>
                      <span className="min-w-0 flex-1 truncate text-sm text-foreground">
                        {activity.name}
                      </span>
                      <Button
                        type="button"
                        size="icon-sm"
                        variant="ghost"
                        disabled={rankSaving || index === 0}
                        onClick={() => handleMoveRank(index, "up")}
                        aria-label={`Move ${activity.name} up`}
                      >
                        <ArrowUpIcon aria-hidden />
                      </Button>
                      <Button
                        type="button"
                        size="icon-sm"
                        variant="ghost"
                        disabled={rankSaving || index === rankIds.length - 1}
                        onClick={() => handleMoveRank(index, "down")}
                        aria-label={`Move ${activity.name} down`}
                      >
                        <ArrowDownIcon aria-hidden />
                      </Button>
                      <Button
                        type="button"
                        size="icon-sm"
                        variant="ghost"
                        disabled={rankSaving}
                        onClick={() => handleToggleRank(id)}
                        aria-label={`Remove ${activity.name} from the top ${MAX_COMMON_APP_RANKED_ACTIVITIES}`}
                      >
                        <XIcon aria-hidden />
                      </Button>
                    </li>
                  );
                })}
              </ol>
            ) : (
              <p className="text-sm text-muted-foreground">
                Nothing selected yet — add activities from the list below.
              </p>
            )}

            {rankFull ? (
              <p data-testid="rank-full-notice" className="text-xs text-muted-foreground">
                Top {MAX_COMMON_APP_RANKED_ACTIVITIES} is full — remove an
                activity to add another.
              </p>
            ) : null}

            {unrankedActivities.length > 0 ? (
              <ul className="space-y-2 border-t border-border/60 pt-3">
                {unrankedActivities.map((activity) => (
                  <li
                    key={activity.id}
                    data-testid={`rank-candidate-${activity.id}`}
                    className="flex items-center gap-2"
                  >
                    <span className="min-w-0 flex-1 truncate text-sm text-foreground">
                      {activity.name}
                    </span>
                    <Button
                      type="button"
                      size="xs"
                      variant="outline"
                      disabled={rankSaving || rankFull}
                      onClick={() => handleToggleRank(activity.id)}
                      aria-label={`Add ${activity.name} to the top ${MAX_COMMON_APP_RANKED_ACTIVITIES}`}
                    >
                      <PlusIcon aria-hidden />
                      Add
                    </Button>
                  </li>
                ))}
              </ul>
            ) : null}

            {rankError ? (
              <p role="alert" className="text-sm text-destructive">
                {rankError}
              </p>
            ) : null}

            <div className="flex justify-end gap-2">
              <Button
                type="button"
                variant="outline"
                size="sm"
                disabled={rankSaving}
                onClick={handleExitRankMode}
              >
                Cancel
              </Button>
              <Button
                type="button"
                size="sm"
                data-testid="rank-save"
                disabled={rankSaving}
                onClick={() => void handleSaveRanks()}
              >
                {rankSaving ? "Saving…" : "Save order"}
              </Button>
            </div>
          </CardContent>
        </Card>
      ) : null}

      {/* ── Create editor ── */}
      {editor && editor.activityId === null ? (
        <Card>
          <CardContent>
            <ActivityEditor
              heading="Add activity"
              draft={editor.draft}
              busy={editorSaving}
              errorMessage={editorError}
              submitLabel="Add activity"
              onDraftChange={(draft) =>
                setEditor((previous) => (previous ? { ...previous, draft } : previous))
              }
              onSubmit={() => void handleSubmitEditor()}
              onCancel={handleCloseEditor}
            />
          </CardContent>
        </Card>
      ) : null}

      {/* ── Master list (CM-70) ── */}
      {merged.length === 0 ? (
        <Card>
          <CardContent>
            <p className="text-sm text-muted-foreground">
              {canEdit
                ? "No activities yet. Add your clubs, jobs, awards, and projects — the internal write-up has no length limit."
                : "No activities recorded yet."}
            </p>
          </CardContent>
        </Card>
      ) : (
        <ul className="space-y-3">
          {merged.map((activity) => {
            const isEditing = editor?.activityId === activity.id;
            return (
              <li key={activity.id}>
                <Card data-testid={`activity-card-${activity.id}`}>
                  <CardContent>
                    {isEditing && editor ? (
                      <ActivityEditor
                        heading={`Edit: ${activity.name}`}
                        draft={editor.draft}
                        busy={editorSaving}
                        errorMessage={editorError}
                        submitLabel="Save changes"
                        onDraftChange={(draft) =>
                          setEditor((previous) =>
                            previous ? { ...previous, draft } : previous,
                          )
                        }
                        onSubmit={() => void handleSubmitEditor()}
                        onCancel={handleCloseEditor}
                      />
                    ) : (
                      <div className="flex items-start gap-3">
                        <div className="min-w-0 flex-1">
                          <div className="flex flex-wrap items-center gap-1.5">
                            <span className="text-sm font-medium text-foreground">
                              {activity.name}
                            </span>
                            {activity.commonAppRank !== null ? (
                              <Badge data-testid={`rank-badge-${activity.id}`}>
                                Common App #{activity.commonAppRank}
                              </Badge>
                            ) : null}
                            {activity.commonApp ? (
                              <Badge variant="secondary">Common App ready</Badge>
                            ) : null}
                            {activity.uc ? (
                              <Badge variant="secondary">UC ready</Badge>
                            ) : null}
                          </div>
                          {activity.fullDescription ? (
                            <p className="mt-1 text-sm whitespace-pre-wrap text-muted-foreground">
                              {activity.fullDescription}
                            </p>
                          ) : null}
                        </div>
                        {canEdit ? (
                          <div className="flex shrink-0 items-center gap-1">
                            <Button
                              size="xs"
                              variant="ghost"
                              data-testid={`activity-edit-${activity.id}`}
                              disabled={editorSaving || (editor !== null && !isEditing)}
                              onClick={() => handleOpenEdit(activity)}
                              aria-label={`Edit ${activity.name}`}
                            >
                              <PencilIcon aria-hidden />
                              Edit
                            </Button>
                            <Button
                              size="icon-sm"
                              variant="ghost"
                              disabled={deleteSaving}
                              onClick={() => setPendingDelete(activity)}
                              aria-label={`Delete ${activity.name}`}
                            >
                              <Trash2Icon aria-hidden />
                            </Button>
                          </div>
                        ) : null}
                      </div>
                    )}
                  </CardContent>
                </Card>
              </li>
            );
          })}
        </ul>
      )}

      {/* ── Delete confirmation (destructive action guard) ── */}
      <Dialog
        open={pendingDelete !== null}
        onOpenChange={(open) => {
          if (!open) setPendingDelete(null);
        }}
      >
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Delete this activity?</DialogTitle>
            <DialogDescription>
              {pendingDelete
                ? `"${pendingDelete.name}" will be removed from the master list${
                    pendingDelete.commonAppRank !== null
                      ? " and cleared from the Common App top 10"
                      : ""
                  }.`
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
              Keep activity
            </Button>
            <Button
              variant="destructive"
              size="sm"
              onClick={() => void handleDeleteConfirmed()}
              disabled={deleteSaving}
            >
              {deleteSaving ? "Deleting…" : "Delete activity"}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}
