"use client";

// ----------------------------------------------------------------------------
// Testing view (design §2.4/§5.2, PRD CM-80..CM-83) — test sittings with
// registration-deadline chips, best-score summary, per-college score-send
// status, and the counselor-only release-to-parent toggle.
//
// Data arrives as server-fetched props (the page reads listSittingsForCase +
// getBestScores; score-send rows come from the recommenders college-docs
// endpoint data); every successful mutation calls router.refresh() so the
// server re-reads Postgres.
//
// Role gates mirror the API (design §2.4): sittings are the student's
// self-report surface, so student+ may add/edit (counselor edits are
// attributed via the audit actorRole); parents never write (read-only render,
// fail-closed). scoreReleasedToParent is COUNSELOR-ONLY (CM-83) and its
// toggle renders ONLY on the staff variant — the student variant never shows
// it regardless of role. Edits carry expectedUpdatedAt (design §6) so a
// concurrent counselor edit surfaces as a conflict instead of a silent
// overwrite. Registration deadlines are auto-derived at create (CM-80) — the
// form previews the derived deadline per test type and never guesses one for
// school-managed/unknown types.
// ----------------------------------------------------------------------------

import { useCallback, useState } from "react";
import { useRouter } from "next/navigation";
import { PencilIcon, PlusIcon } from "lucide-react";

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
import { Input } from "@/components/ui/input";
import { BANGKOK_TIME_ZONE } from "@/lib/bangkok-time";
import { SELECT_FIELD_CLASSES } from "@/components/admissions/field-classes";
import { roleAtLeast } from "@/lib/admissions/config";
import {
  ADMISSIONS_TEST_TYPES,
  ADMISSIONS_TEST_TYPE_LABELS,
  deriveRegistrationDeadline,
  type AdmissionsTestType,
} from "@/lib/admissions/shared/testing";
import type { AdmissionsBestScore, AdmissionsTestSittingDto } from "@/lib/admissions/testing";
import type { AdmissionsCollegeDocDto } from "@/lib/admissions/recommenders";
import type { CaseRole } from "@/lib/admissions/types";

const DATE_ONLY_PATTERN = /^\d{4}-\d{2}-\d{2}$/;

// ── Pure helpers (exported for tests) ───────────────────────────────────

/**
 * Sittings in strict chronological order (testDate ascending, id ascending
 * tiebreak for a stable render). The input array is not mutated.
 */
export function sortSittingsChronologically(
  sittings: readonly AdmissionsTestSittingDto[],
): AdmissionsTestSittingDto[] {
  return [...sittings].sort((a, b) => {
    if (a.testDate !== b.testDate) return a.testDate < b.testDate ? -1 : 1;
    return a.id < b.id ? -1 : a.id > b.id ? 1 : 0;
  });
}

/**
 * True when a sitting's registration deadline has passed (Bangkok calendar)
 * and the sitting has no actual score yet — a scored sitting needs no
 * registration reminder (mirrors the CM-81 calendar-completed rule).
 */
export function isRegistrationOverdue(
  sitting: Pick<AdmissionsTestSittingDto, "registrationDeadline" | "actualScore">,
  todayKey: string,
): boolean {
  if (sitting.registrationDeadline === null) return false;
  if (sitting.actualScore !== null) return false;
  return sitting.registrationDeadline < todayKey;
}

/**
 * The registration-deadline preview line for the add/edit form (CM-80): the
 * auto-derived deadline for the selected (testType, testDate), a "no
 * auto-derived deadline" note for school-managed/unknown types (never
 * guessed, fail-closed), or a pick-a-date prompt while the date is empty.
 */
export function formatDeadlinePreview(
  testType: AdmissionsTestType,
  testDate: string,
): string {
  if (!DATE_ONLY_PATTERN.test(testDate)) {
    return "Pick a test date to preview the registration deadline.";
  }
  const derived = deriveRegistrationDeadline(testType, testDate);
  if (derived === null) {
    return `No auto-derived registration deadline for ${
      ADMISSIONS_TEST_TYPE_LABELS[testType]
    } — set one manually if needed.`;
  }
  return `Registration closes ${formatDateOnly(derived)}.`;
}

/** Minimal college shape the view needs (id + display name). */
export interface TestingViewCollege {
  id: string;
  instName: string;
}

/** One college's score-send status for a sitting (CM-82). */
export interface SittingScoreSendStatus {
  listItemId: string;
  instName: string;
  sent: boolean;
}

/**
 * Per-college score-send status for ONE sitting (CM-82): the score_send doc
 * rows referencing the sitting, resolved to college display names. Colleges
 * with no doc row for the sitting are omitted — score sends are recorded
 * per sitting, never assumed.
 */
export function scoreSendStatusForSitting(
  docs: readonly AdmissionsCollegeDocDto[],
  colleges: readonly TestingViewCollege[],
  sittingId: string,
): SittingScoreSendStatus[] {
  const nameById = new Map(colleges.map((college) => [college.id, college.instName]));
  return docs
    .filter((doc) => doc.docType === "score_send" && doc.testSittingId === sittingId)
    .map((doc) => ({
      listItemId: doc.listItemId,
      instName: nameById.get(doc.listItemId) ?? "Removed college",
      sent: doc.sent,
    }));
}

/** Controlled add/edit form values; "" means empty/cleared throughout. */
export interface SittingFormValues {
  testType: AdmissionsTestType;
  testDate: string;
  registrationDeadline: string;
  targetScore: string;
  actualScore: string;
  accommodations: string;
}

/** The blank create-mode form. */
export const EMPTY_SITTING_FORM: SittingFormValues = {
  testType: "sat",
  testDate: "",
  registrationDeadline: "",
  targetScore: "",
  actualScore: "",
  accommodations: "",
};

/** Form values pre-filled from an existing sitting (nulls become ""). */
export function toSittingFormValues(
  sitting: AdmissionsTestSittingDto,
): SittingFormValues {
  return {
    testType: sitting.testType,
    testDate: sitting.testDate,
    registrationDeadline: sitting.registrationDeadline ?? "",
    targetScore: sitting.targetScore,
    actualScore: sitting.actualScore ?? "",
    accommodations: sitting.accommodations ?? "",
  };
}

/**
 * The PATCH body for an edit: only the fields the user actually changed
 * (undefined fields are left untouched by updateSitting, so an untouched
 * registration deadline keeps its still-auto re-derivation behavior).
 * Emptied optional fields clear with null; no effective change returns null
 * so the caller can skip the request entirely.
 */
export function buildSittingPatch(
  initial: SittingFormValues,
  current: SittingFormValues,
): Record<string, unknown> | null {
  const patch: Record<string, unknown> = {};
  if (current.testType !== initial.testType) patch.testType = current.testType;
  if (current.testDate !== initial.testDate) patch.testDate = current.testDate;
  if (current.registrationDeadline !== initial.registrationDeadline) {
    patch.registrationDeadline =
      current.registrationDeadline === "" ? null : current.registrationDeadline;
  }
  if (current.targetScore.trim() !== initial.targetScore) {
    patch.targetScore = current.targetScore.trim();
  }
  if (current.actualScore.trim() !== initial.actualScore) {
    patch.actualScore = current.actualScore.trim() === "" ? null : current.actualScore.trim();
  }
  if (current.accommodations.trim() !== initial.accommodations) {
    patch.accommodations =
      current.accommodations.trim() === "" ? null : current.accommodations.trim();
  }
  return Object.keys(patch).length === 0 ? null : patch;
}

// ── Internal helpers ────────────────────────────────────────────────────

const SELECT_CLASSES = cn(SELECT_FIELD_CLASSES, "h-8");

/** "YYYY-MM-DD" → "D/M/YYYY" (repo-wide D/M convention); non-dates pass through. */
function formatDateOnly(value: string): string {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(value);
  if (!match) return value;
  return `${Number(match[3])}/${Number(match[2])}/${match[1]}`;
}

/** Asia/Bangkok calendar date ("YYYY-MM-DD") for an instant. */
function getBangkokDateKey(now: Date): string {
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone: BANGKOK_TIME_ZONE,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).formatToParts(now);
  const pick = (type: string) => parts.find((part) => part.type === type)?.value ?? "";
  return `${pick("year")}-${pick("month")}-${pick("day")}`;
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

// ── View ────────────────────────────────────────────────────────────────

/** Props for TestingView — all data is server-fetched by the page. */
export interface TestingViewProps {
  caseId: string;
  /** The case's sittings (any order; the view sorts chronologically). */
  sittings: AdmissionsTestSittingDto[];
  /** Best actual score per test type (getBestScores, CM-82). */
  bestScores: AdmissionsBestScore[];
  /** College-doc rows from the recommenders endpoint (score sends, CM-82). */
  collegeDocs?: AdmissionsCollegeDocDto[];
  /** The case's live college rows (names for the score-send chips). */
  colleges?: TestingViewCollege[];
  viewerRole: CaseRole;
  /** "staff" shows the CM-83 release toggle; "student" never does. */
  variant: "staff" | "student";
}

/**
 * Testing view (CM-80..83): chronological sittings with type badge,
 * registration-deadline chip (overdue red), target-vs-actual scores,
 * accommodations, per-college score-send status, best-score summary, and an
 * add/edit sitting form with a live registration-deadline preview. The
 * release-to-parent toggle renders only on the staff variant for counselor+.
 */
export function TestingView({
  caseId,
  sittings,
  bestScores,
  collegeDocs = [],
  colleges = [],
  viewerRole,
  variant,
}: TestingViewProps) {
  const router = useRouter();
  const canWrite = roleAtLeast(viewerRole, "student");
  const canRelease = variant === "staff" && roleAtLeast(viewerRole, "counselor");
  const endpoint = `/api/admissions/cases/${caseId}/testing`;
  const todayKey = getBangkokDateKey(new Date());
  const ordered = sortSittingsChronologically(sittings);

  const [actionError, setActionError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [editing, setEditing] = useState<AdmissionsTestSittingDto | null>(null);
  const [form, setForm] = useState<SittingFormValues>(EMPTY_SITTING_FORM);
  const [initial, setInitial] = useState<SittingFormValues>(EMPTY_SITTING_FORM);

  const runMutation = useCallback(
    async (request: () => Promise<Response>, fallback: string): Promise<boolean> => {
      setActionError(null);
      setBusy(true);
      try {
        const response = await request();
        const payload: unknown = await response.json().catch(() => null);
        if (!response.ok) {
          setActionError(readErrorMessage(payload, fallback));
          return false;
        }
        router.refresh();
        return true;
      } catch (error) {
        setActionError(error instanceof Error ? error.message : fallback);
        return false;
      } finally {
        setBusy(false);
      }
    },
    [router],
  );

  const startEdit = useCallback((sitting: AdmissionsTestSittingDto) => {
    const values = toSittingFormValues(sitting);
    setEditing(sitting);
    setForm(values);
    setInitial(values);
    setActionError(null);
  }, []);

  const cancelEdit = useCallback(() => {
    setEditing(null);
    setForm(EMPTY_SITTING_FORM);
    setInitial(EMPTY_SITTING_FORM);
  }, []);

  const handleSave = useCallback(async () => {
    if (!DATE_ONLY_PATTERN.test(form.testDate)) {
      setActionError("Test date is required.");
      return;
    }
    if (editing === null) {
      const created = await runMutation(
        () =>
          fetch(endpoint, {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({
              testType: form.testType,
              testDate: form.testDate,
              targetScore: form.targetScore.trim(),
              accommodations: form.accommodations.trim() || null,
            }),
          }),
        "Failed to add the sitting.",
      );
      if (created) setForm(EMPTY_SITTING_FORM);
      return;
    }
    const patch = buildSittingPatch(initial, form);
    if (patch === null) {
      cancelEdit();
      return;
    }
    const saved = await runMutation(
      () =>
        fetch(endpoint, {
          method: "PATCH",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            sittingId: editing.id,
            expectedUpdatedAt: editing.updatedAt,
            ...patch,
          }),
        }),
      "Failed to update the sitting.",
    );
    if (saved) cancelEdit();
  }, [cancelEdit, editing, endpoint, form, initial, runMutation]);

  const handleRelease = useCallback(
    (sitting: AdmissionsTestSittingDto) =>
      runMutation(
        () =>
          fetch(endpoint, {
            method: "PATCH",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({
              sittingId: sitting.id,
              expectedUpdatedAt: sitting.updatedAt,
              scoreReleasedToParent: !sitting.scoreReleasedToParent,
            }),
          }),
        "Failed to update the release flag.",
      ),
    [endpoint, runMutation],
  );

  return (
    <Card data-testid="testing-view">
      <CardHeader>
        <CardTitle>Testing</CardTitle>
        <CardDescription>
          Test sittings, registration deadlines, scores, and per-college score
          sends (CM-80..83).
        </CardDescription>
      </CardHeader>
      <CardContent className="space-y-4">
        {actionError ? (
          <p role="alert" className="text-sm text-destructive">
            {actionError}
          </p>
        ) : null}

        {/* ── Best-score summary (CM-82) ── */}
        <div data-testid="best-scores" className="flex flex-wrap items-center gap-2">
          <span className="text-xs font-medium text-muted-foreground">Best scores:</span>
          {bestScores.length > 0 ? (
            bestScores.map((score) => (
              <Badge
                key={score.testType}
                variant="secondary"
                data-testid={`best-score-${score.testType}`}
              >
                {ADMISSIONS_TEST_TYPE_LABELS[score.testType]} {score.actualScore}
              </Badge>
            ))
          ) : (
            <span className="text-xs text-muted-foreground">No scores recorded yet.</span>
          )}
        </div>

        {/* ── Sittings, chronological (CM-80) ── */}
        {ordered.length > 0 ? (
          <ul className="space-y-3">
            {ordered.map((sitting) => {
              const label = ADMISSIONS_TEST_TYPE_LABELS[sitting.testType];
              const overdue = isRegistrationOverdue(sitting, todayKey);
              const sends = scoreSendStatusForSitting(collegeDocs, colleges, sitting.id);
              return (
                <li
                  key={sitting.id}
                  data-testid="sitting-row"
                  className="space-y-2 rounded-lg border border-border/60 p-3"
                >
                  <div className="flex flex-wrap items-center gap-2">
                    <Badge
                      data-testid={`test-type-${sitting.id}`}
                      className="bg-primary/10 text-primary"
                    >
                      {label}
                    </Badge>
                    <span className="text-sm font-medium text-foreground">
                      {formatDateOnly(sitting.testDate)}
                    </span>
                    {sitting.registrationDeadline ? (
                      <span
                        data-testid={`registration-chip-${sitting.id}`}
                        className={cn(
                          "rounded-full px-2 py-0.5 text-xs",
                          overdue
                            ? "bg-conflict/15 text-conflict"
                            : "bg-muted text-muted-foreground",
                        )}
                      >
                        Register by {formatDateOnly(sitting.registrationDeadline)}
                        {overdue ? " · Overdue" : ""}
                      </span>
                    ) : null}
                    {canWrite ? (
                      <Button
                        size="icon-sm"
                        variant="ghost"
                        // ≥44px touch target (design §5.2), compact visuals.
                        className="ml-auto min-h-11 min-w-11"
                        disabled={busy}
                        aria-label={`Edit ${label} sitting on ${formatDateOnly(sitting.testDate)}`}
                        data-testid={`sitting-edit-${sitting.id}`}
                        onClick={() => startEdit(sitting)}
                      >
                        <PencilIcon aria-hidden />
                      </Button>
                    ) : null}
                  </div>
                  <p className="text-sm text-muted-foreground">
                    Target {sitting.targetScore.trim() === "" ? "—" : sitting.targetScore} ·
                    Actual {sitting.actualScore ?? "—"}
                  </p>
                  {sitting.accommodations ? (
                    <p className="text-xs text-muted-foreground">
                      Accommodations: {sitting.accommodations}
                    </p>
                  ) : null}
                  {sends.length > 0 ? (
                    <ul
                      data-testid={`score-sends-${sitting.id}`}
                      className="flex flex-wrap gap-1.5"
                    >
                      {sends.map((send) => (
                        <li
                          key={send.listItemId}
                          className={cn(
                            "rounded-full px-2 py-0.5 text-xs",
                            send.sent
                              ? "bg-available/15 text-available"
                              : "bg-muted text-muted-foreground",
                          )}
                        >
                          {send.instName}: {send.sent ? "Sent" : "Pending"}
                        </li>
                      ))}
                    </ul>
                  ) : null}
                  {canRelease ? (
                    <label className="flex w-fit items-center gap-1.5 text-xs text-muted-foreground">
                      <input
                        type="checkbox"
                        className="size-4 accent-primary"
                        data-testid={`release-toggle-${sitting.id}`}
                        checked={sitting.scoreReleasedToParent}
                        disabled={busy}
                        onChange={() => void handleRelease(sitting)}
                        aria-label={`Release ${label} score to parent`}
                      />
                      Released to parent (CM-83)
                    </label>
                  ) : null}
                </li>
              );
            })}
          </ul>
        ) : (
          <p className="text-sm text-muted-foreground">
            {canWrite
              ? "No test sittings yet. Add the first one below."
              : "No test sittings recorded yet."}
          </p>
        )}

        {/* ── Add/edit sitting form (student+, design §2.4) ── */}
        {canWrite ? (
          <form
            data-testid="sitting-form"
            onSubmit={(event) => {
              event.preventDefault();
              void handleSave();
            }}
            className="space-y-2 rounded-lg border border-border/60 p-3"
          >
            <p className="text-sm font-semibold text-foreground">
              {editing ? "Edit sitting" : "Add a sitting"}
            </p>
            <div className="flex flex-wrap items-end gap-2">
              <label className="space-y-1 text-xs font-medium text-foreground">
                Test
                <br />
                <select
                  className={cn(SELECT_CLASSES, "min-w-28")}
                  data-testid="sitting-type-select"
                  value={form.testType}
                  onChange={(event) =>
                    setForm((previous) => ({
                      ...previous,
                      testType: event.target.value as AdmissionsTestType,
                    }))
                  }
                >
                  {ADMISSIONS_TEST_TYPES.map((testType) => (
                    <option key={testType} value={testType}>
                      {ADMISSIONS_TEST_TYPE_LABELS[testType]}
                    </option>
                  ))}
                </select>
              </label>
              <label className="space-y-1 text-xs font-medium text-foreground">
                Test date
                <Input
                  type="date"
                  data-testid="sitting-date-input"
                  value={form.testDate}
                  onChange={(event) =>
                    setForm((previous) => ({ ...previous, testDate: event.target.value }))
                  }
                />
              </label>
              {editing ? (
                <label className="space-y-1 text-xs font-medium text-foreground">
                  Registration deadline
                  <Input
                    type="date"
                    data-testid="sitting-deadline-input"
                    value={form.registrationDeadline}
                    onChange={(event) =>
                      setForm((previous) => ({
                        ...previous,
                        registrationDeadline: event.target.value,
                      }))
                    }
                  />
                </label>
              ) : null}
              <label className="space-y-1 text-xs font-medium text-foreground">
                Target score
                <Input
                  className="w-24"
                  data-testid="sitting-target-input"
                  value={form.targetScore}
                  onChange={(event) =>
                    setForm((previous) => ({ ...previous, targetScore: event.target.value }))
                  }
                />
              </label>
              {editing ? (
                <label className="space-y-1 text-xs font-medium text-foreground">
                  Actual score
                  <Input
                    className="w-24"
                    data-testid="sitting-actual-input"
                    value={form.actualScore}
                    onChange={(event) =>
                      setForm((previous) => ({ ...previous, actualScore: event.target.value }))
                    }
                  />
                </label>
              ) : null}
              <label className="min-w-40 flex-1 space-y-1 text-xs font-medium text-foreground">
                Accommodations
                <Input
                  data-testid="sitting-accommodations-input"
                  value={form.accommodations}
                  onChange={(event) =>
                    setForm((previous) => ({
                      ...previous,
                      accommodations: event.target.value,
                    }))
                  }
                />
              </label>
            </div>
            <p data-testid="deadline-preview" className="text-xs text-muted-foreground">
              {formatDeadlinePreview(form.testType, form.testDate)}
            </p>
            <div className="flex gap-2">
              <Button type="submit" size="sm" disabled={busy} data-testid="sitting-save">
                <PlusIcon aria-hidden />
                {editing ? "Save changes" : "Add sitting"}
              </Button>
              {editing ? (
                <Button
                  type="button"
                  size="sm"
                  variant="outline"
                  disabled={busy}
                  onClick={cancelEdit}
                >
                  Cancel
                </Button>
              ) : null}
            </div>
          </form>
        ) : null}
      </CardContent>
    </Card>
  );
}
