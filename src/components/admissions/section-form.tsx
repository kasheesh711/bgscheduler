"use client";

// ----------------------------------------------------------------------------
// Guided self-report section form (design §2.4/§5.2/§6, PRD CM-121) — the
// multi-step renderer for SECTION_DEFINITIONS: step progress dots, helper
// microcopy + example placeholders, live hard-stop char counters, autosave on
// blur (PUT partial draft; "Saved" flash), and the explicit Draft → Submitted
// → Reviewed state machine.
//
// Autosave sends ONLY the blurred field's value when it actually changed
// since the last save (buildAutosavePayload — blur replays are no-ops, so a
// tab-through never spams the API). The server merges partial payloads and
// reverts a submitted/reviewed section to draft on any effective edit; the
// form mirrors that from the response and warns BEFORE the edit happens.
//
// Role gates mirror the API (design §2.4): the self-report surface is
// student-writable (counselor/admin edits are attributed via the audit
// actorRole); parents render read-only (fail-closed). Submit runs at the
// student bar; Review is counselor+ AND renders only on the staff variant.
// Autosave does not router.refresh() (a refresh per blur would churn the
// server tree mid-typing); submit/review do.
// ----------------------------------------------------------------------------

import { useCallback, useRef, useState } from "react";
import { useRouter } from "next/navigation";
import { ArrowLeftIcon } from "lucide-react";

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
import { Textarea } from "@/components/ui/textarea";
import { roleAtLeast } from "@/lib/admissions/config";
import type {
  AdmissionsSectionDefinition,
  AdmissionsSectionField,
  AdmissionsSectionStateDto,
  AdmissionsSubmissionState,
} from "@/lib/admissions/sections";
import type { CaseRole } from "@/lib/admissions/types";

/** Which shell hosts the form: staff sees the review action, students never do. */
export type SectionFormVariant = "staff" | "student";

// ── Presentation maps (exported for tests + sections-list reuse) ────────

/** Display labels for the CM-121 review states. */
export const SECTION_STATE_LABELS: Record<AdmissionsSubmissionState, string> = {
  draft: "Draft",
  submitted: "Submitted",
  reviewed: "Reviewed",
};

/** Chip classes per review state (semantic tokens, design §5.4). */
export const SECTION_STATE_CLASSES: Record<AdmissionsSubmissionState, string> = {
  draft: "bg-muted text-muted-foreground",
  submitted: "bg-primary/10 text-primary",
  reviewed: "bg-available/15 text-available",
};

// ── Pure helpers (exported for tests) ───────────────────────────────────

/**
 * The autosave body for one blurred field, or null when the value has not
 * effectively changed since the last save (blur replays fire no request).
 * Text-family values are trimmed before comparing; an emptied field clears
 * with null; a multiselect sends its (deduped, order-preserving) array — an
 * empty array clears server-side.
 */
export function buildAutosavePayload(
  field: AdmissionsSectionField,
  rawValue: string | readonly string[],
  savedValue: unknown,
): Record<string, unknown> | null {
  if (field.type === "multiselect") {
    const current = Array.isArray(rawValue) ? [...new Set(rawValue as string[])] : [];
    const saved = Array.isArray(savedValue) ? savedValue : [];
    const same =
      current.length === saved.length && current.every((entry, index) => entry === saved[index]);
    if (same) return null;
    return { [field.key]: current };
  }
  const current = typeof rawValue === "string" ? rawValue.trim() : "";
  const saved = typeof savedValue === "string" ? savedValue : "";
  if (current === saved) return null;
  return { [field.key]: current === "" ? null : current };
}

/** Answered/total rollup for a section's payload (sections-list completion). */
export interface SectionCompletion {
  answered: number;
  total: number;
  /** 0–100 integer. */
  percent: number;
}

/**
 * Counts answered fields (non-empty trimmed string or non-empty array)
 * across every step of the definition — the completion meter on section
 * cards. Unknown payload keys never count (the definition is the contract).
 */
export function computeSectionCompletion(
  definition: AdmissionsSectionDefinition,
  payload: Record<string, unknown>,
): SectionCompletion {
  let answered = 0;
  let total = 0;
  for (const step of definition.steps) {
    for (const field of step.fields) {
      total += 1;
      const value = payload[field.key];
      if (typeof value === "string" && value.trim() !== "") answered += 1;
      else if (Array.isArray(value) && value.length > 0) answered += 1;
    }
  }
  return { answered, total, percent: total === 0 ? 0 : Math.round((answered / total) * 100) };
}

/**
 * True when the section can be submitted for review: it is a draft AND has
 * been saved at least once (updatedAt null is the never-saved virtual draft —
 * the API would 409, so the button stays disabled, CM-121).
 */
export function canSubmitSection(
  state: AdmissionsSubmissionState,
  updatedAt: string | null,
): boolean {
  return state === "draft" && updatedAt !== null;
}

// ── Internal helpers ────────────────────────────────────────────────────

type SectionFieldValue = string | string[];

const SELECT_CLASSES =
  "h-9 w-full rounded-lg border border-input bg-transparent px-2 text-sm outline-none focus-visible:border-ring focus-visible:ring-3 focus-visible:ring-ring/50 dark:bg-input/30";

/** The controlled value for a field from a saved payload (fail-closed to empty). */
function toFieldValue(field: AdmissionsSectionField, payloadValue: unknown): SectionFieldValue {
  if (field.type === "multiselect") {
    return Array.isArray(payloadValue)
      ? payloadValue.filter((entry): entry is string => typeof entry === "string")
      : [];
  }
  return typeof payloadValue === "string" ? payloadValue : "";
}

/** Controlled values for every field of the definition. */
function buildInitialValues(
  definition: AdmissionsSectionDefinition,
  payload: Record<string, unknown>,
): Record<string, SectionFieldValue> {
  const values: Record<string, SectionFieldValue> = {};
  for (const step of definition.steps) {
    for (const field of step.fields) {
      values[field.key] = toFieldValue(field, payload[field.key]);
    }
  }
  return values;
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

/** The section DTO out of a route response body, or null when malformed. */
function readSectionFromPayload(payload: unknown): AdmissionsSectionStateDto | null {
  if (typeof payload === "object" && payload !== null && "section" in payload) {
    const section = (payload as { section?: unknown }).section;
    if (
      typeof section === "object" &&
      section !== null &&
      typeof (section as { sectionKey?: unknown }).sectionKey === "string"
    ) {
      return section as AdmissionsSectionStateDto;
    }
  }
  return null;
}

// ── Form ────────────────────────────────────────────────────────────────

/** Props for SectionForm — the full section state is server-fetched. */
export interface SectionFormProps {
  caseId: string;
  /** Definition + saved answers + review state (getSectionState). */
  section: AdmissionsSectionStateDto;
  viewerRole: CaseRole;
  variant: SectionFormVariant;
  /** Renders a back affordance when provided (sections-list host). */
  onClose?: () => void;
}

/**
 * Guided multi-step section form (CM-121, design §5.2): step dots, 5–10
 * fields per step with helper microcopy + example placeholders, hard-stop
 * char counters, autosave on blur with a "Saved" flash, explicit
 * submit-for-review, and the staff-only review action.
 */
export function SectionForm({
  caseId,
  section,
  viewerRole,
  variant,
  onClose,
}: SectionFormProps) {
  const router = useRouter();
  const definition = section.definition;
  const canWrite = roleAtLeast(viewerRole, "student");
  const canReview = variant === "staff" && roleAtLeast(viewerRole, "counselor");
  const endpoint = `/api/admissions/cases/${caseId}/sections/${section.sectionKey}`;

  const [values, setValues] = useState<Record<string, SectionFieldValue>>(() =>
    buildInitialValues(definition, section.payload),
  );
  const [savedPayload, setSavedPayload] = useState<Record<string, unknown>>(section.payload);
  const [state, setState] = useState<AdmissionsSubmissionState>(section.state);
  const [updatedAt, setUpdatedAt] = useState<string | null>(section.updatedAt);
  const [stepIndex, setStepIndex] = useState(0);
  const [saveStatus, setSaveStatus] = useState<"idle" | "saving" | "saved">("idle");
  const [actionError, setActionError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const flashTimerRef = useRef<number | null>(null);

  const step = definition.steps[Math.min(stepIndex, definition.steps.length - 1)];

  const applySection = useCallback((next: AdmissionsSectionStateDto) => {
    setSavedPayload(next.payload);
    setState(next.state);
    setUpdatedAt(next.updatedAt);
  }, []);

  const flashSaved = useCallback(() => {
    setSaveStatus("saved");
    if (flashTimerRef.current !== null) window.clearTimeout(flashTimerRef.current);
    flashTimerRef.current = window.setTimeout(() => {
      flashTimerRef.current = null;
      setSaveStatus((previous) => (previous === "saved" ? "idle" : previous));
    }, 2000);
  }, []);

  /** Autosave one field on blur — no-op when the value did not change. */
  const autosaveField = useCallback(
    async (field: AdmissionsSectionField, rawValue: SectionFieldValue) => {
      if (!canWrite) return;
      const payload = buildAutosavePayload(field, rawValue, savedPayload[field.key]);
      if (payload === null) return;
      setActionError(null);
      setSaveStatus("saving");
      try {
        const response = await fetch(endpoint, {
          method: "PUT",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ payload }),
        });
        const body: unknown = await response.json().catch(() => null);
        if (!response.ok) {
          setSaveStatus("idle");
          setActionError(readErrorMessage(body, "Failed to save your answer."));
          return;
        }
        const next = readSectionFromPayload(body);
        if (next) applySection(next);
        flashSaved();
      } catch (error) {
        setSaveStatus("idle");
        setActionError(
          error instanceof Error ? error.message : "Failed to save your answer.",
        );
      }
    },
    [applySection, canWrite, endpoint, flashSaved, savedPayload],
  );

  const runAction = useCallback(
    async (action: "submit" | "review", fallback: string) => {
      setActionError(null);
      setBusy(true);
      try {
        const response = await fetch(endpoint, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ action }),
        });
        const body: unknown = await response.json().catch(() => null);
        if (!response.ok) {
          setActionError(readErrorMessage(body, fallback));
          return;
        }
        const next = readSectionFromPayload(body);
        if (next) applySection(next);
        router.refresh();
      } catch (error) {
        setActionError(error instanceof Error ? error.message : fallback);
      } finally {
        setBusy(false);
      }
    },
    [applySection, endpoint, router],
  );

  const setFieldValue = useCallback((key: string, value: SectionFieldValue) => {
    setValues((previous) => ({ ...previous, [key]: value }));
  }, []);

  const toggleOption = useCallback(
    (field: AdmissionsSectionField, option: string) => {
      const current = values[field.key];
      const list = Array.isArray(current) ? current : [];
      const next = list.includes(option)
        ? list.filter((entry) => entry !== option)
        : [...list, option];
      setFieldValue(field.key, next);
      // Checkbox toggles commit immediately — there is no meaningful blur.
      void autosaveField(field, next);
    },
    [autosaveField, setFieldValue, values],
  );

  const editWarning = canWrite && state !== "draft";

  return (
    <Card data-testid={`section-form-${section.sectionKey}`}>
      <CardHeader>
        <div className="flex flex-wrap items-center gap-2">
          {onClose ? (
            <Button
              size="icon-sm"
              variant="ghost"
              aria-label="Back to all sections"
              data-testid="section-form-back"
              onClick={onClose}
            >
              <ArrowLeftIcon aria-hidden />
            </Button>
          ) : null}
          <CardTitle>{definition.title}</CardTitle>
          <Badge data-testid="section-state-chip" className={SECTION_STATE_CLASSES[state]}>
            {SECTION_STATE_LABELS[state]}
          </Badge>
          <span
            data-testid="autosave-status"
            aria-live="polite"
            className="ml-auto text-xs text-muted-foreground"
          >
            {saveStatus === "saving" ? "Saving…" : saveStatus === "saved" ? "Saved" : ""}
          </span>
        </div>
        <CardDescription>{definition.description}</CardDescription>
      </CardHeader>
      <CardContent className="space-y-4">
        {actionError ? (
          <p role="alert" className="text-sm text-destructive">
            {actionError}
          </p>
        ) : null}

        {editWarning ? (
          <p
            data-testid="submitted-edit-warning"
            className="rounded-lg bg-amber-500/10 px-3 py-2 text-xs text-amber-600 dark:text-amber-400"
          >
            This section was {SECTION_STATE_LABELS[state].toLowerCase()} — editing any
            answer returns it to Draft and your counselor will review it again.
          </p>
        ) : null}

        {/* ── Step progress dots (design §5.2) ── */}
        {definition.steps.length > 1 ? (
          <div className="flex items-center gap-2" role="tablist" aria-label="Form steps">
            {definition.steps.map((formStep, index) => (
              <button
                key={formStep.key}
                type="button"
                role="tab"
                data-testid={`step-dot-${index}`}
                aria-label={`Step ${index + 1}: ${formStep.title}`}
                aria-current={index === stepIndex ? "step" : undefined}
                className={cn(
                  "size-3 rounded-full outline-none focus-visible:ring-3 focus-visible:ring-ring/50",
                  index === stepIndex ? "bg-primary" : "bg-muted",
                )}
                onClick={() => setStepIndex(index)}
              />
            ))}
            <span className="text-xs text-muted-foreground">
              Step {stepIndex + 1} of {definition.steps.length}: {step.title}
            </span>
          </div>
        ) : (
          <p className="text-xs font-medium text-muted-foreground">{step.title}</p>
        )}

        {/* ── Current step fields ── */}
        <div className="space-y-4">
          {step.fields.map((field) => {
            const value = values[field.key];
            const text = typeof value === "string" ? value : "";
            const list = Array.isArray(value) ? value : [];
            return (
              <div key={field.key} className="space-y-1">
                <label
                  htmlFor={`section-field-${field.key}`}
                  className="text-sm font-medium text-foreground"
                >
                  {field.label}
                </label>
                <p className="text-xs text-muted-foreground">{field.helper}</p>
                {field.type === "text" ? (
                  <Input
                    id={`section-field-${field.key}`}
                    data-testid={`field-${field.key}`}
                    value={text}
                    maxLength={field.maxLength}
                    placeholder={field.example ? `e.g. ${field.example}` : undefined}
                    disabled={!canWrite}
                    onChange={(event) =>
                      setFieldValue(
                        field.key,
                        field.maxLength !== undefined
                          ? event.target.value.slice(0, field.maxLength)
                          : event.target.value,
                      )
                    }
                    onBlur={(event) => void autosaveField(field, event.target.value)}
                  />
                ) : null}
                {field.type === "textarea" ? (
                  <Textarea
                    id={`section-field-${field.key}`}
                    data-testid={`field-${field.key}`}
                    value={text}
                    rows={4}
                    maxLength={field.maxLength}
                    placeholder={field.example ? `e.g. ${field.example}` : undefined}
                    disabled={!canWrite}
                    onChange={(event) =>
                      setFieldValue(
                        field.key,
                        field.maxLength !== undefined
                          ? event.target.value.slice(0, field.maxLength)
                          : event.target.value,
                      )
                    }
                    onBlur={(event) => void autosaveField(field, event.target.value)}
                  />
                ) : null}
                {field.type === "select" ? (
                  <select
                    id={`section-field-${field.key}`}
                    data-testid={`field-${field.key}`}
                    className={SELECT_CLASSES}
                    value={text}
                    disabled={!canWrite}
                    onChange={(event) => {
                      setFieldValue(field.key, event.target.value);
                      void autosaveField(field, event.target.value);
                    }}
                  >
                    <option value="">Choose…</option>
                    {(field.options ?? []).map((option) => (
                      <option key={option} value={option}>
                        {option}
                      </option>
                    ))}
                  </select>
                ) : null}
                {field.type === "multiselect" ? (
                  <ul className="flex flex-wrap gap-x-4 gap-y-1.5">
                    {(field.options ?? []).map((option) => (
                      <li key={option} className="flex items-center gap-1.5 text-sm">
                        <input
                          type="checkbox"
                          className="size-4 accent-primary"
                          data-testid={`field-${field.key}-${option}`}
                          checked={list.includes(option)}
                          disabled={!canWrite}
                          onChange={() => toggleOption(field, option)}
                          aria-label={`${field.label}: ${option}`}
                        />
                        <span className="text-foreground">{option}</span>
                      </li>
                    ))}
                  </ul>
                ) : null}
                {field.maxLength !== undefined ? (
                  <p
                    data-testid={`char-counter-${field.key}`}
                    className="text-right text-xs tabular-nums text-muted-foreground"
                  >
                    {text.length}/{field.maxLength}
                  </p>
                ) : null}
              </div>
            );
          })}
        </div>

        {/* ── Step navigation + state machine actions ── */}
        <div className="flex flex-wrap items-center gap-2">
          {definition.steps.length > 1 ? (
            <>
              <Button
                size="sm"
                variant="outline"
                disabled={stepIndex === 0}
                onClick={() => setStepIndex((index) => Math.max(0, index - 1))}
              >
                Back
              </Button>
              <Button
                size="sm"
                variant="outline"
                disabled={stepIndex >= definition.steps.length - 1}
                onClick={() =>
                  setStepIndex((index) => Math.min(definition.steps.length - 1, index + 1))
                }
              >
                Next
              </Button>
            </>
          ) : null}
          <span className="ml-auto flex items-center gap-2">
            {canWrite ? (
              <Button
                size="sm"
                data-testid="section-submit"
                disabled={busy || !canSubmitSection(state, updatedAt)}
                onClick={() => void runAction("submit", "Failed to submit the section.")}
              >
                Submit for review
              </Button>
            ) : null}
            {canReview && state === "submitted" ? (
              <Button
                size="sm"
                variant="outline"
                data-testid="section-review"
                disabled={busy}
                onClick={() => void runAction("review", "Failed to mark the section reviewed.")}
              >
                Mark reviewed
              </Button>
            ) : null}
          </span>
        </div>
        {canWrite && state === "draft" && updatedAt === null ? (
          <p className="text-xs text-muted-foreground">
            Save at least one answer before submitting for review.
          </p>
        ) : null}
      </CardContent>
    </Card>
  );
}
