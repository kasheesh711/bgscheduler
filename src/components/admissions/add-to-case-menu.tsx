"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { ListPlus } from "lucide-react";
import { buttonVariants } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import { cn } from "@/lib/utils";
import type { AdmissionsCaseSummary } from "@/lib/admissions/types";

// ─────────────────────────────────────────────────────────────────────────────
// "Add to case" menu (PRD CM-41): a self-contained staff action that drops an
// IPEDS institution onto a student's college list from any /us-universities
// surface (browse table row, dossier action row, shortlist chip). The staff
// caseload is fetched lazily on first open (GET /api/admissions/cases); a
// 401/403 means the viewer is not admissions staff, so the control hides
// itself permanently (fail-closed). Picking a case POSTs
// /api/admissions/cases/[caseId]/colleges with the unitId and the default
// Regular Decision round (mirrors the colleges-tab add-form default) —
// counselors refine round/deadline/category inside the case workspace.
// A duplicate row (409) surfaces as "Already on the list".
// ─────────────────────────────────────────────────────────────────────────────

const CASES_ENDPOINT = "/api/admissions/cases";
const SUCCESS_CLOSE_MS = 1600;

/** Lazy caseload access state; "denied" (401/403) hides the menu for good. */
export type AddToCaseAccess = "unknown" | "loading" | "granted" | "denied";

/** The caseload fields the picker needs (subset of AdmissionsCaseSummary). */
export type AddToCaseCandidate = Pick<
  AdmissionsCaseSummary,
  "caseId" | "studentName" | "preferredName" | "cohortName" | "status"
>;

/** Outcome message shown inside the menu after a caseload pick. */
export interface AddToCaseNotice {
  kind: "success" | "conflict" | "error";
  message: string;
}

/** Result of the lazy caseload fetch (loadCaseload). */
export type CaseloadLoadResult =
  | { kind: "granted"; cases: AddToCaseCandidate[] }
  | { kind: "denied" }
  | { kind: "error" };

// ── Pure helpers (exported for tests) ───────────────────────────────────

/**
 * Caseload rows eligible to receive a college: active cases only. Committed /
 * completed / withdrawn / archived cases are excluded (list edits belong in
 * the case workspace once a case leaves "active"). Order is preserved — the
 * API already sorts by recency.
 */
export function addableCases(cases: AddToCaseCandidate[]): AddToCaseCandidate[] {
  return cases.filter((candidate) => candidate.status === "active");
}

/**
 * Case-insensitive picker filter over the student's full name, preferred
 * name, and cohort name. A blank query returns every case unchanged.
 */
export function filterCaseOptions(
  cases: AddToCaseCandidate[],
  query: string,
): AddToCaseCandidate[] {
  const term = query.trim().toLowerCase();
  if (term === "") return cases;
  return cases.filter(
    (candidate) =>
      candidate.studentName.toLowerCase().includes(term) ||
      (candidate.preferredName ?? "").toLowerCase().includes(term) ||
      candidate.cohortName.toLowerCase().includes(term),
  );
}

/** Picker display name: preferred name when set, else the full name. */
export function caseDisplayName(candidate: AddToCaseCandidate): string {
  const preferred = (candidate.preferredName ?? "").trim();
  return preferred !== "" ? preferred : candidate.studentName;
}

/**
 * Map the add-college HTTP status to the notice shown in the menu: 2xx →
 * success ("Added to {student}'s list"), 409 → the CM-40 duplicate conflict
 * ("Already on the list"), anything else → a generic retryable error.
 */
export function addToCaseNotice(status: number, studentName: string): AddToCaseNotice {
  if (status >= 200 && status < 300) {
    return { kind: "success", message: `Added to ${studentName}'s list` };
  }
  if (status === 409) {
    return { kind: "conflict", message: "Already on the list" };
  }
  return { kind: "error", message: "Could not add to case — try again" };
}

/**
 * POST body for /cases/[caseId]/colleges: the IPEDS unitId plus the default
 * Regular Decision round (the route schema requires a round; "rd" mirrors
 * EMPTY_ADD_COLLEGE_FORM in colleges-tab.tsx).
 */
export function buildAddToCasePayload(unitId: number): { unitId: number; round: "rd" } {
  return { unitId, round: "rd" };
}

/** Endpoint for a case's college list (POST target). */
export function caseCollegesEndpoint(caseId: string): string {
  return `/api/admissions/cases/${encodeURIComponent(caseId)}/colleges`;
}

// ── Fetch helpers (exported for tests; fetch injectable) ────────────────

/**
 * Fetch the staff caseload and reduce it to a picker-ready result. 401/403 →
 * "denied" (the viewer is not admissions staff; the menu hides fail-closed);
 * any other failure → "error" (retryable, never treated as access granted);
 * success → active cases only.
 */
export async function loadCaseload(
  fetchImpl: typeof fetch = fetch,
): Promise<CaseloadLoadResult> {
  try {
    const response = await fetchImpl(CASES_ENDPOINT);
    if (response.status === 401 || response.status === 403) return { kind: "denied" };
    if (!response.ok) return { kind: "error" };
    const data = (await response.json()) as { cases?: AdmissionsCaseSummary[] };
    return {
      kind: "granted",
      cases: addableCases(Array.isArray(data.cases) ? data.cases : []),
    };
  } catch (error) {
    console.error("Add-to-case caseload load failed", error);
    return { kind: "error" };
  }
}

/**
 * POST the college onto the chosen case and map the outcome to a notice
 * (2xx success / 409 duplicate / other error). Network failures map to the
 * generic error notice.
 */
export async function submitAddToCase(
  unitId: number,
  candidate: AddToCaseCandidate,
  fetchImpl: typeof fetch = fetch,
): Promise<AddToCaseNotice> {
  try {
    const response = await fetchImpl(caseCollegesEndpoint(candidate.caseId), {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(buildAddToCasePayload(unitId)),
    });
    return addToCaseNotice(response.status, caseDisplayName(candidate));
  } catch (error) {
    console.error("Add-to-case submit failed", error);
    return { kind: "error", message: "Could not add to case — try again" };
  }
}

// ── Picker (presentational; exported for tests) ─────────────────────────

export interface AddToCasePickerProps {
  cases: AddToCaseCandidate[];
  query: string;
  onQueryChange: (value: string) => void;
  onPick: (candidate: AddToCaseCandidate) => void;
  loading: boolean;
  loadFailed: boolean;
  onRetry: () => void;
  submittingCaseId: string | null;
  notice: AddToCaseNotice | null;
}

/**
 * Popover body: notice banner + searchable list of active cases. Pure
 * presenter — all fetch/submit state lives in AddToCaseMenu — so tests can
 * render each state directly to static markup.
 */
export function AddToCasePicker({
  cases,
  query,
  onQueryChange,
  onPick,
  loading,
  loadFailed,
  onRetry,
  submittingCaseId,
  notice,
}: AddToCasePickerProps): React.JSX.Element {
  const filtered = filterCaseOptions(cases, query);

  return (
    <div className="flex flex-col gap-2">
      <p className="text-xs font-semibold text-foreground">Add to case</p>
      {notice ? (
        <p
          role="status"
          data-testid="add-to-case-notice"
          className={cn(
            "rounded-md border px-2 py-1.5 text-xs",
            notice.kind === "success" && "border-available/40 bg-available/10 text-foreground",
            notice.kind === "conflict" && "border-accent/50 bg-accent/15 text-foreground",
            notice.kind === "error" && "border-destructive/40 bg-destructive/10 text-destructive",
          )}
        >
          {notice.message}
        </p>
      ) : null}
      {loading ? (
        <p className="py-4 text-center text-xs text-muted-foreground">Loading cases…</p>
      ) : loadFailed ? (
        <div className="flex flex-col items-start gap-2 py-1">
          <p className="text-xs text-destructive">Could not load cases.</p>
          <button
            type="button"
            onClick={onRetry}
            className={buttonVariants({ variant: "outline", size: "xs" })}
          >
            Retry
          </button>
        </div>
      ) : cases.length === 0 ? (
        <p className="py-4 text-center text-xs text-muted-foreground">No active cases.</p>
      ) : (
        <>
          <Input
            value={query}
            onChange={(event) => onQueryChange(event.target.value)}
            placeholder="Search students…"
            aria-label="Search cases"
          />
          <ul className="flex max-h-56 flex-col overflow-y-auto" aria-label="Active cases">
            {filtered.length === 0 ? (
              <li className="py-3 text-center text-xs text-muted-foreground">
                No matching cases.
              </li>
            ) : (
              filtered.map((candidate) => (
                <li key={candidate.caseId}>
                  <button
                    type="button"
                    data-testid={`add-to-case-option-${candidate.caseId}`}
                    disabled={submittingCaseId !== null}
                    onClick={() => onPick(candidate)}
                    className="w-full rounded-md px-2 py-1.5 text-left hover:bg-muted disabled:pointer-events-none disabled:opacity-50"
                  >
                    <span className="block truncate text-sm text-foreground">
                      {caseDisplayName(candidate)}
                    </span>
                    <span className="block truncate text-xs text-muted-foreground">
                      {candidate.cohortName}
                    </span>
                  </button>
                </li>
              ))
            )}
          </ul>
        </>
      )}
    </div>
  );
}

// ── Menu ────────────────────────────────────────────────────────────────

export interface AddToCaseMenuProps {
  unitId: number;
  instName: string;
  /** Compact icon-only trigger for dense surfaces (table rows, chips). */
  compact?: boolean;
  /** SSR/test seam: seed the lazy access state (default "unknown"). */
  initialAccess?: AddToCaseAccess;
}

/**
 * "Add to case" trigger + case-picker popover. Renders null once the
 * caseload endpoint answers 401/403 (non-staff, fail-closed); us-universities
 * is admin-only today, so the check is a lazy backstop, not a hot path.
 */
export function AddToCaseMenu({
  unitId,
  instName,
  compact = false,
  initialAccess = "unknown",
}: AddToCaseMenuProps): React.JSX.Element | null {
  const [access, setAccess] = useState<AddToCaseAccess>(initialAccess);
  const [open, setOpen] = useState(false);
  const [cases, setCases] = useState<AddToCaseCandidate[]>([]);
  const [query, setQuery] = useState("");
  const [loadFailed, setLoadFailed] = useState(false);
  const [notice, setNotice] = useState<AddToCaseNotice | null>(null);
  const [submittingCaseId, setSubmittingCaseId] = useState<string | null>(null);
  const closeTimerRef = useRef<number | null>(null);

  useEffect(
    () => () => {
      if (closeTimerRef.current !== null) window.clearTimeout(closeTimerRef.current);
    },
    [],
  );

  const refreshCases = useCallback(() => {
    setAccess("loading");
    setLoadFailed(false);
    void loadCaseload().then((result) => {
      if (result.kind === "denied") {
        setAccess("denied");
        setOpen(false);
        return;
      }
      if (result.kind === "error") {
        setAccess("unknown");
        setLoadFailed(true);
        return;
      }
      setCases(result.cases);
      setAccess("granted");
    });
  }, []);

  const handleOpenChange = useCallback(
    (nextOpen: boolean) => {
      setOpen(nextOpen);
      if (!nextOpen) return;
      if (closeTimerRef.current !== null) {
        window.clearTimeout(closeTimerRef.current);
        closeTimerRef.current = null;
      }
      setNotice(null);
      setQuery("");
      // Refetch on every open so the picker reflects the current caseload.
      if (access !== "loading") refreshCases();
    },
    [access, refreshCases],
  );

  const handlePick = useCallback(
    (candidate: AddToCaseCandidate) => {
      setSubmittingCaseId(candidate.caseId);
      setNotice(null);
      void submitAddToCase(unitId, candidate).then((result) => {
        setSubmittingCaseId(null);
        setNotice(result);
        if (result.kind === "success") {
          if (closeTimerRef.current !== null) window.clearTimeout(closeTimerRef.current);
          closeTimerRef.current = window.setTimeout(() => setOpen(false), SUCCESS_CLOSE_MS);
        }
      });
    },
    [unitId],
  );

  // Fail-closed: a confirmed non-staff viewer never sees the control again.
  if (access === "denied") return null;

  const label = `Add ${instName} to a case`;

  return (
    <Popover open={open} onOpenChange={handleOpenChange}>
      <PopoverTrigger
        render={(props) => (
          <button
            {...props}
            type="button"
            aria-label={label}
            title={compact ? label : undefined}
            className={
              compact
                ? cn(
                    buttonVariants({ variant: "ghost", size: "icon-xs" }),
                    "text-muted-foreground hover:text-foreground",
                  )
                : buttonVariants({ variant: "outline", size: "sm" })
            }
          >
            <ListPlus aria-hidden className={compact ? "size-3.5" : "size-4"} />
            {compact ? null : "Add to case"}
          </button>
        )}
      />
      <PopoverContent align="end" className="w-72 p-3">
        <AddToCasePicker
          cases={cases}
          query={query}
          onQueryChange={setQuery}
          onPick={handlePick}
          loading={access === "loading"}
          loadFailed={loadFailed}
          onRetry={refreshCases}
          submittingCaseId={submittingCaseId}
          notice={notice}
        />
      </PopoverContent>
    </Popover>
  );
}
