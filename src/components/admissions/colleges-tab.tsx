"use client";

// ----------------------------------------------------------------------------
// Admissions Colleges tab (design §5.1, PRD CM-40..CM-42/44/45/46) — replaces
// the phase-3 placeholder in case-detail-shell.tsx.
//
// The college list arrives as server-fetched props (caseDetail.collegeList,
// which already carries live IPEDS stats + the stale fallback flag + the
// CM-46 completeness rollup); every successful mutation calls
// router.refresh() so the server component re-reads Postgres.
//
// Table columns: college (IPEDS link-out to /us-universities/[unitId], or a
// Manual badge for free-text rows; a Stale badge when the unitId no longer
// resolves and the denormalized copy is showing), round / deadline / status /
// category (inline counselor edits with expectedUpdatedAt optimistic
// concurrency — a 409 surfaces a conflict message), live stats (acceptance /
// avg net price / 6-yr grad rate), the completeness icon row, and aid.
//
// The ED/REA banner renders the WARN-only CM-45 warnings from the case detail
// (amber — warnings never block). The add dialog offers the CM-40 entry
// union: IPEDS search (reusing the us-universities combobox) or manual entry
// (name + country required). Deletes are soft and confirmed.
//
// Role gates mirror the API (design §2.4): list composition and every edit
// here are counselor+; students see the table read-only. Parents never reach
// this surface (the colleges GET is student+ — their projection lives on the
// parent dashboard).
// ----------------------------------------------------------------------------

import { useCallback, useState } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import {
  CheckCircle2Icon,
  ClipboardListIcon,
  ExternalLinkIcon,
  FileTextIcon,
  PencilIcon,
  PlusIcon,
  SendIcon,
  Trash2Icon,
  TriangleAlertIcon,
  UsersIcon,
} from "lucide-react";

import { cn } from "@/lib/utils";
import { SELECT_FIELD_CLASSES } from "@/components/admissions/field-classes";
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
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { Textarea } from "@/components/ui/textarea";
import { InstitutionSearchCombobox } from "@/components/us-universities/institution-search-combobox";
import { EM_DASH, formatPct, formatUsd } from "@/lib/us-universities/format";
import { roleAtLeast } from "@/lib/admissions/config";
import {
  ADMISSIONS_APP_ROUNDS,
  ADMISSIONS_APP_ROUND_LABELS,
  ADMISSIONS_APP_STATUSES,
  ADMISSIONS_COLLEGE_CATEGORIES,
  type AdmissionsAppRound,
  type AdmissionsAppStatus,
  type AdmissionsCollegeCategory,
} from "@/lib/admissions/shared/colleges";
import { RecommendersPanel } from "./recommenders-panel";
import type { AdmissionsCollegeCompleteness, AdmissionsCollegeListRowDto, ApplicationWarning } from "@/lib/admissions/colleges";
import type { AdmissionsCollegeDocDto, AdmissionsRecommenderWithCollegesDto } from "@/lib/admissions/recommenders";
import type { CaseRole } from "@/lib/admissions/types";

// ── Pure helpers (exported for tests) ───────────────────────────────────

/** Display labels for application progress statuses. */
export const APP_STATUS_LABELS: Record<AdmissionsAppStatus, string> = {
  researching: "Researching",
  applying: "Applying",
  submitted: "Submitted",
  complete: "Complete",
};

/** Display labels for reach/match/safety categories. */
export const COLLEGE_CATEGORY_LABELS: Record<AdmissionsCollegeCategory, string> = {
  reach: "Reach",
  match: "Match",
  safety: "Safety",
  unset: "Unset",
};

/** Add-college dialog form state (CM-40 entry union as a mode toggle). */
export interface AddCollegeFormValues {
  mode: "ipeds" | "manual";
  /** Selected IPEDS unitId (ipeds mode); null until a search row is picked. */
  unitId: number | null;
  /** Display name of the selected IPEDS row (never sent — display only). */
  unitName: string;
  manualName: string;
  manualCountry: string;
  round: AdmissionsAppRound;
  /** "" = no deadline (sent as null). */
  deadline: string;
  category: AdmissionsCollegeCategory;
}

/** Fresh add-college form: IPEDS mode, RD round, unset category. */
export const EMPTY_ADD_COLLEGE_FORM: AddCollegeFormValues = {
  mode: "ipeds",
  unitId: null,
  unitName: "",
  manualName: "",
  manualCountry: "",
  round: "rd",
  deadline: "",
  category: "unset",
};

/**
 * True when the add-college dialog may submit: IPEDS mode requires a selected
 * institution; manual mode requires a non-blank name AND country (CM-40).
 * The inactive mode's fields never gate submission (switching modes re-arms
 * validation against the active mode only).
 */
export function canSubmitAddCollege(values: AddCollegeFormValues): boolean {
  if (values.mode === "ipeds") return values.unitId !== null;
  return values.manualName.trim().length > 0 && values.manualCountry.trim().length > 0;
}

/**
 * POST body for /cases/[caseId]/colleges from the dialog form — the CM-40
 * entry union ({ unitId } XOR { manual }) plus the shared plan fields.
 * Callers must gate on canSubmitAddCollege first.
 */
export function buildAddCollegePayload(
  values: AddCollegeFormValues,
): Record<string, unknown> {
  const plan = {
    round: values.round,
    deadline: values.deadline || null,
    category: values.category,
  };
  if (values.mode === "ipeds") {
    return { unitId: values.unitId, ...plan };
  }
  return {
    manual: {
      instName: values.manualName.trim(),
      country: values.manualCountry.trim(),
    },
    ...plan,
  };
}

/** One rendered completeness icon: what it tracks and whether it is done. */
export interface CompletenessItem {
  key: "recs" | "transcript" | "school_report" | "scores";
  label: string;
  done: boolean;
}

/**
 * Flattens the CM-46 completeness rollup into the icon row. "recs" is done
 * when every linked recommender submitted (vacuously true at zero linked —
 * mirrors computeCompletenessEntry). "scores" lights once at least one score
 * send is recorded as sent; it does NOT decide overall completeness — the
 * authoritative flag is completeness.complete (test-optional colleges can be
 * complete with zero score sends).
 */
export function completenessItems(
  completeness: AdmissionsCollegeCompleteness,
): CompletenessItem[] {
  return [
    {
      key: "recs",
      label: `Recommendations ${completeness.recsSubmitted}/${completeness.recsTotal} submitted`,
      done:
        completeness.recsTotal === 0 ||
        completeness.recsSubmitted >= completeness.recsTotal,
    },
    {
      key: "transcript",
      label: completeness.transcriptSent ? "Transcript sent" : "Transcript not sent",
      done: completeness.transcriptSent,
    },
    {
      key: "school_report",
      label: completeness.schoolReportSent
        ? "School report sent"
        : "School report not sent",
      done: completeness.schoolReportSent,
    },
    {
      key: "scores",
      label: `Score sends: ${completeness.scoreSendsSent} sent`,
      done: completeness.scoreSendsSent > 0,
    },
  ];
}

// ── Internal helpers ────────────────────────────────────────────────────

const SELECT_CLASSES = cn(SELECT_FIELD_CLASSES, "h-8");

/** Mirrors AID_AMOUNT_PATTERN in src/lib/admissions/colleges.ts (client 400 guard). */
const AID_AMOUNT_PATTERN = /^\d{1,12}(\.\d{1,2})?$/;

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

// ── Warning banner (exported for tests) ─────────────────────────────────

/**
 * WARN-only ED/REA plan banner (CM-45 — amber, never blocking). Lists every
 * warning with the affected college names resolved from the live list.
 */
export function ApplicationWarningBanner({
  warnings,
  collegeNamesById,
}: {
  warnings: ApplicationWarning[];
  collegeNamesById: ReadonlyMap<string, string>;
}) {
  if (warnings.length === 0) return null;
  return (
    <div
      role="alert"
      data-testid="application-warning-banner"
      className="rounded-lg border border-accent bg-accent/15 p-3"
    >
      <p className="flex items-center gap-1.5 text-sm font-semibold text-foreground">
        <TriangleAlertIcon aria-hidden className="size-4 shrink-0" />
        Application plan warnings
      </p>
      <ul className="mt-1.5 space-y-1">
        {warnings.map((warning) => {
          const names = warning.listItemIds
            .map((id) => collegeNamesById.get(id))
            .filter((name): name is string => !!name);
          return (
            <li key={warning.code} className="text-xs text-foreground">
              {warning.message}
              {names.length > 0 ? (
                <span className="text-muted-foreground"> — {names.join(", ")}</span>
              ) : null}
            </li>
          );
        })}
      </ul>
    </div>
  );
}

// ── Colleges tab ────────────────────────────────────────────────────────

/** Props for CollegesTab — all data is server-fetched by the page. */
export interface CollegesTabProps {
  caseId: string;
  /** caseDetail.collegeList: items + live IPEDS stats + completeness. */
  colleges: AdmissionsCollegeListRowDto[];
  /** caseDetail.applicationWarnings (CM-45, WARN-only). */
  warnings: ApplicationWarning[];
  /** Empty for parent viewers (the recommenders API is student+). */
  recommenders: AdmissionsRecommenderWithCollegesDto[];
  /** Empty for parent viewers (fetched alongside recommenders). */
  collegeDocs: AdmissionsCollegeDocDto[];
  viewerRole: CaseRole;
}

/**
 * Colleges tab (design §5.1): the case's college list table with inline plan
 * edits, live IPEDS stats with stale fallback badges, the CM-46 completeness
 * icon row, aid tracking, the CM-45 ED/REA warning banner, the CM-40
 * add-college dialog (IPEDS search or manual entry), and the recommenders &
 * documents panel.
 */
export function CollegesTab({
  caseId,
  colleges,
  warnings,
  recommenders,
  collegeDocs,
  viewerRole,
}: CollegesTabProps) {
  const router = useRouter();
  const isStaff = roleAtLeast(viewerRole, "counselor");
  const endpoint = `/api/admissions/cases/${caseId}/colleges`;

  const [actionError, setActionError] = useState<string | null>(null);
  const [busyItemIds, setBusyItemIds] = useState<ReadonlySet<string>>(new Set());
  const [pendingDelete, setPendingDelete] =
    useState<AdmissionsCollegeListRowDto | null>(null);
  const [deleteSaving, setDeleteSaving] = useState(false);

  // ── Add dialog state ──
  const [addOpen, setAddOpen] = useState(false);
  const [addForm, setAddForm] = useState<AddCollegeFormValues>(EMPTY_ADD_COLLEGE_FORM);
  const [addError, setAddError] = useState<string | null>(null);
  const [addSaving, setAddSaving] = useState(false);

  // ── Aid dialog state ──
  const [aidTarget, setAidTarget] = useState<AdmissionsCollegeListRowDto | null>(null);
  const [aidOffered, setAidOffered] = useState("");
  const [aidNotes, setAidNotes] = useState("");
  const [aidError, setAidError] = useState<string | null>(null);
  const [aidSaving, setAidSaving] = useState(false);

  const collegeNamesById = new Map(colleges.map((row) => [row.id, row.instName]));

  const setItemBusy = useCallback((itemId: string, busy: boolean) => {
    setBusyItemIds((previous) => {
      const next = new Set(previous);
      if (busy) next.add(itemId);
      else next.delete(itemId);
      return next;
    });
  }, []);

  /**
   * PATCHes one plan field with the row's updatedAt as the optimistic
   * concurrency token (design §6): a 409 surfaces a conflict message and
   * refreshes so the table shows the latest server values.
   */
  const handleFieldUpdate = useCallback(
    async (
      row: AdmissionsCollegeListRowDto,
      patch: Record<string, unknown>,
    ) => {
      setActionError(null);
      setItemBusy(row.id, true);
      try {
        const response = await fetch(endpoint, {
          method: "PATCH",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            itemId: row.id,
            expectedUpdatedAt: row.updatedAt,
            ...patch,
          }),
        });
        const payload: unknown = await response.json().catch(() => null);
        if (response.status === 409) {
          setActionError(
            `${row.instName} changed in another session — showing the latest values.`,
          );
          router.refresh();
          return false;
        }
        if (!response.ok) {
          setActionError(readErrorMessage(payload, "Failed to update the college."));
          return false;
        }
        router.refresh();
        return true;
      } catch (error) {
        setActionError(
          error instanceof Error ? error.message : "Failed to update the college.",
        );
        return false;
      } finally {
        setItemBusy(row.id, false);
      }
    },
    [endpoint, router, setItemBusy],
  );

  const handleAddSubmit = useCallback(async () => {
    if (!canSubmitAddCollege(addForm)) {
      setAddError(
        addForm.mode === "ipeds"
          ? "Search and select an institution first."
          : "Manual entries need a name and a country.",
      );
      return;
    }
    setAddSaving(true);
    setAddError(null);
    try {
      const response = await fetch(endpoint, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(buildAddCollegePayload(addForm)),
      });
      const payload: unknown = await response.json().catch(() => null);
      if (response.status === 409) {
        setAddError("This college is already on the list.");
        return;
      }
      if (!response.ok) {
        setAddError(readErrorMessage(payload, "Failed to add the college."));
        return;
      }
      setAddOpen(false);
      setAddForm(EMPTY_ADD_COLLEGE_FORM);
      router.refresh();
    } catch (error) {
      setAddError(error instanceof Error ? error.message : "Failed to add the college.");
    } finally {
      setAddSaving(false);
    }
  }, [addForm, endpoint, router]);

  const openAidDialog = useCallback((row: AdmissionsCollegeListRowDto) => {
    setAidTarget(row);
    setAidOffered(row.aidOffered ?? "");
    setAidNotes(row.aidNotes ?? "");
    setAidError(null);
  }, []);

  const handleAidSave = useCallback(async () => {
    if (!aidTarget) return;
    const trimmedAid = aidOffered.trim();
    if (trimmedAid !== "" && !AID_AMOUNT_PATTERN.test(trimmedAid)) {
      setAidError("Aid must be a non-negative amount (up to 2 decimal places).");
      return;
    }
    setAidSaving(true);
    setAidError(null);
    const saved = await handleFieldUpdate(aidTarget, {
      aidOffered: trimmedAid === "" ? null : trimmedAid,
      aidNotes: aidNotes.trim() === "" ? null : aidNotes.trim(),
    });
    setAidSaving(false);
    if (saved) setAidTarget(null);
  }, [aidTarget, aidOffered, aidNotes, handleFieldUpdate]);

  const handleDeleteConfirmed = useCallback(async () => {
    if (!pendingDelete) return;
    setActionError(null);
    setDeleteSaving(true);
    try {
      const response = await fetch(`${endpoint}?itemId=${pendingDelete.id}`, {
        method: "DELETE",
      });
      const payload: unknown = await response.json().catch(() => null);
      if (!response.ok) {
        setActionError(readErrorMessage(payload, "Failed to remove the college."));
        return;
      }
      setPendingDelete(null);
      router.refresh();
    } catch (error) {
      setActionError(
        error instanceof Error ? error.message : "Failed to remove the college.",
      );
    } finally {
      setDeleteSaving(false);
    }
  }, [endpoint, pendingDelete, router]);

  return (
    <div className="space-y-4">
      <ApplicationWarningBanner
        warnings={warnings}
        collegeNamesById={collegeNamesById}
      />

      <Card>
        <CardHeader>
          <CardTitle>College list</CardTitle>
          <CardDescription>
            Rounds, deadlines, live IPEDS stats, and per-college completeness.
          </CardDescription>
          {isStaff ? (
            <CardAction>
              <Button
                size="sm"
                data-testid="add-college"
                onClick={() => {
                  setAddForm(EMPTY_ADD_COLLEGE_FORM);
                  setAddError(null);
                  setAddOpen(true);
                }}
              >
                <PlusIcon aria-hidden />
                Add college
              </Button>
            </CardAction>
          ) : null}
        </CardHeader>
        <CardContent>
          {actionError ? (
            <p role="alert" className="mb-2 text-sm text-destructive">
              {actionError}
            </p>
          ) : null}
          {colleges.length === 0 ? (
            <p className="text-sm text-muted-foreground">
              {isStaff
                ? "No colleges yet. Add the first college from the US-universities database or as a manual entry."
                : "No colleges on the list yet."}
            </p>
          ) : (
            <div className="overflow-x-auto">
              <Table>
                <TableHeader>
                  <TableRow>
                    <TableHead>College</TableHead>
                    <TableHead>Round</TableHead>
                    <TableHead>Deadline</TableHead>
                    <TableHead>Status</TableHead>
                    <TableHead>Category</TableHead>
                    <TableHead>Accept.</TableHead>
                    <TableHead>Net price</TableHead>
                    <TableHead>Grad rate</TableHead>
                    <TableHead>Completeness</TableHead>
                    <TableHead>Aid</TableHead>
                    {isStaff ? <TableHead aria-label="Actions" /> : null}
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {colleges.map((row) => {
                    const busy = busyItemIds.has(row.id);
                    return (
                      <TableRow key={row.id} data-testid="college-row">
                        <TableCell>
                          <div className="flex flex-wrap items-center gap-1.5">
                            {row.unitId !== null && !row.stale ? (
                              <Link
                                href={`/us-universities/${row.unitId}`}
                                className="inline-flex items-center gap-1 font-medium text-primary hover:underline"
                              >
                                {row.instName}
                                <ExternalLinkIcon aria-hidden className="size-3" />
                              </Link>
                            ) : (
                              <span className="font-medium text-foreground">
                                {row.instName}
                              </span>
                            )}
                            {row.isManual ? (
                              <Badge variant="outline">Manual</Badge>
                            ) : null}
                            {row.stale ? (
                              <Badge
                                data-testid={`stale-badge-${row.id}`}
                                className="bg-conflict/15 text-conflict"
                              >
                                Stale IPEDS
                              </Badge>
                            ) : null}
                          </div>
                          <p className="text-xs text-muted-foreground">
                            {[row.city, row.stateAbbr].filter(Boolean).join(", ") ||
                              row.country}
                          </p>
                        </TableCell>
                        <TableCell>
                          {isStaff ? (
                            <select
                              className={SELECT_CLASSES}
                              value={row.round}
                              disabled={busy}
                              aria-label={`Round for ${row.instName}`}
                              onChange={(event) =>
                                void handleFieldUpdate(row, {
                                  round: event.target.value as AdmissionsAppRound,
                                })
                              }
                            >
                              {ADMISSIONS_APP_ROUNDS.map((round) => (
                                <option key={round} value={round}>
                                  {ADMISSIONS_APP_ROUND_LABELS[round]}
                                </option>
                              ))}
                            </select>
                          ) : (
                            ADMISSIONS_APP_ROUND_LABELS[row.round]
                          )}
                        </TableCell>
                        <TableCell>
                          {isStaff ? (
                            <Input
                              type="date"
                              className="h-8 w-36"
                              value={row.deadline ?? ""}
                              disabled={busy}
                              aria-label={`Deadline for ${row.instName}`}
                              onChange={(event) =>
                                void handleFieldUpdate(row, {
                                  deadline: event.target.value || null,
                                })
                              }
                            />
                          ) : row.deadline ? (
                            formatDateOnly(row.deadline)
                          ) : (
                            EM_DASH
                          )}
                        </TableCell>
                        <TableCell>
                          {isStaff ? (
                            <select
                              className={SELECT_CLASSES}
                              value={row.appStatus}
                              disabled={busy}
                              aria-label={`Status for ${row.instName}`}
                              onChange={(event) =>
                                void handleFieldUpdate(row, {
                                  appStatus: event.target.value as AdmissionsAppStatus,
                                })
                              }
                            >
                              {ADMISSIONS_APP_STATUSES.map((status) => (
                                <option key={status} value={status}>
                                  {APP_STATUS_LABELS[status]}
                                </option>
                              ))}
                            </select>
                          ) : (
                            APP_STATUS_LABELS[row.appStatus]
                          )}
                        </TableCell>
                        <TableCell>
                          {isStaff ? (
                            <select
                              className={SELECT_CLASSES}
                              value={row.category}
                              disabled={busy}
                              aria-label={`Category for ${row.instName}`}
                              onChange={(event) =>
                                void handleFieldUpdate(row, {
                                  category: event.target.value as AdmissionsCollegeCategory,
                                })
                              }
                            >
                              {ADMISSIONS_COLLEGE_CATEGORIES.map((category) => (
                                <option key={category} value={category}>
                                  {COLLEGE_CATEGORY_LABELS[category]}
                                </option>
                              ))}
                            </select>
                          ) : (
                            COLLEGE_CATEGORY_LABELS[row.category]
                          )}
                        </TableCell>
                        <TableCell className="tabular-nums">
                          {formatPct(row.stats?.acceptanceRate)}
                        </TableCell>
                        <TableCell className="tabular-nums">
                          {formatUsd(row.stats?.avgNetPrice)}
                        </TableCell>
                        <TableCell className="tabular-nums">
                          {formatPct(row.stats?.gradRateBach6yr)}
                        </TableCell>
                        <TableCell>
                          {row.completeness ? (
                            <span className="flex items-center gap-1.5">
                              {completenessItems(row.completeness).map((item) => {
                                const iconClass = cn(
                                  "size-4",
                                  item.done ? "text-available" : "text-muted-foreground/50",
                                );
                                return (
                                  <span
                                    key={item.key}
                                    title={item.label}
                                    data-testid={`completeness-${item.key}-${row.id}`}
                                    data-done={item.done}
                                  >
                                    {item.key === "recs" ? (
                                      <UsersIcon aria-hidden className={iconClass} />
                                    ) : item.key === "transcript" ? (
                                      <FileTextIcon aria-hidden className={iconClass} />
                                    ) : item.key === "school_report" ? (
                                      <ClipboardListIcon aria-hidden className={iconClass} />
                                    ) : (
                                      <SendIcon aria-hidden className={iconClass} />
                                    )}
                                    <span className="sr-only">{item.label}</span>
                                  </span>
                                );
                              })}
                              {row.completeness.complete ? (
                                <CheckCircle2Icon
                                  aria-hidden
                                  data-testid={`completeness-complete-${row.id}`}
                                  className="size-4 text-available"
                                />
                              ) : null}
                            </span>
                          ) : (
                            EM_DASH
                          )}
                        </TableCell>
                        <TableCell>
                          <div className="flex items-center gap-1">
                            <span className="text-sm tabular-nums">
                              {row.aidOffered !== null
                                ? formatUsd(Number(row.aidOffered))
                                : EM_DASH}
                            </span>
                            {isStaff ? (
                              <Button
                                size="icon-sm"
                                variant="ghost"
                                disabled={busy}
                                aria-label={`Edit aid for ${row.instName}`}
                                onClick={() => openAidDialog(row)}
                              >
                                <PencilIcon aria-hidden />
                              </Button>
                            ) : null}
                          </div>
                          {row.aidNotes ? (
                            <p className="max-w-40 truncate text-xs text-muted-foreground">
                              {row.aidNotes}
                            </p>
                          ) : null}
                        </TableCell>
                        {isStaff ? (
                          <TableCell>
                            <Button
                              size="icon-sm"
                              variant="ghost"
                              disabled={busy}
                              aria-label={`Remove ${row.instName} from the list`}
                              onClick={() => setPendingDelete(row)}
                            >
                              <Trash2Icon aria-hidden />
                            </Button>
                          </TableCell>
                        ) : null}
                      </TableRow>
                    );
                  })}
                </TableBody>
              </Table>
            </div>
          )}
        </CardContent>
      </Card>

      <RecommendersPanel
        caseId={caseId}
        recommenders={recommenders}
        collegeDocs={collegeDocs}
        colleges={colleges.map((row) => ({ id: row.id, instName: row.instName }))}
        viewerRole={viewerRole}
      />

      {/* ── Add-college dialog (CM-40 entry union) ── */}
      <Dialog open={addOpen} onOpenChange={setAddOpen}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Add a college</DialogTitle>
            <DialogDescription>
              Search the US-universities database, or enter a non-US /
              unlisted institution manually.
            </DialogDescription>
          </DialogHeader>
          <div className="space-y-3">
            <div className="flex gap-1.5" role="group" aria-label="Entry mode">
              <Button
                type="button"
                size="xs"
                data-testid="add-mode-ipeds"
                variant={addForm.mode === "ipeds" ? "default" : "outline"}
                aria-pressed={addForm.mode === "ipeds"}
                onClick={() =>
                  setAddForm((previous) => ({ ...previous, mode: "ipeds" }))
                }
              >
                US institution search
              </Button>
              <Button
                type="button"
                size="xs"
                data-testid="add-mode-manual"
                variant={addForm.mode === "manual" ? "default" : "outline"}
                aria-pressed={addForm.mode === "manual"}
                onClick={() =>
                  setAddForm((previous) => ({ ...previous, mode: "manual" }))
                }
              >
                Manual entry
              </Button>
            </div>

            {addForm.mode === "ipeds" ? (
              <div className="space-y-2">
                <InstitutionSearchCombobox
                  placeholder="Search US institutions…"
                  onSelect={(unitId, name) =>
                    setAddForm((previous) => ({
                      ...previous,
                      unitId,
                      unitName: name,
                    }))
                  }
                />
                {addForm.unitId !== null ? (
                  <p className="text-sm text-foreground" data-testid="add-selected">
                    Selected:{" "}
                    <span className="font-medium">{addForm.unitName}</span>
                  </p>
                ) : (
                  <p className="text-xs text-muted-foreground">
                    Type to search, then pick an institution.
                  </p>
                )}
              </div>
            ) : (
              <div className="grid gap-3 sm:grid-cols-2">
                <label className="space-y-1 text-xs font-medium text-foreground">
                  Institution name
                  <span aria-hidden className="text-destructive">
                    {" "}
                    *
                  </span>
                  <Input
                    value={addForm.manualName}
                    data-testid="manual-name-input"
                    onChange={(event) =>
                      setAddForm((previous) => ({
                        ...previous,
                        manualName: event.target.value,
                      }))
                    }
                  />
                </label>
                <label className="space-y-1 text-xs font-medium text-foreground">
                  Country
                  <span aria-hidden className="text-destructive">
                    {" "}
                    *
                  </span>
                  <Input
                    value={addForm.manualCountry}
                    data-testid="manual-country-input"
                    onChange={(event) =>
                      setAddForm((previous) => ({
                        ...previous,
                        manualCountry: event.target.value,
                      }))
                    }
                  />
                </label>
              </div>
            )}

            <div className="grid gap-3 sm:grid-cols-3">
              <label className="space-y-1 text-xs font-medium text-foreground">
                Round
                <select
                  className={cn(SELECT_CLASSES, "w-full")}
                  value={addForm.round}
                  onChange={(event) =>
                    setAddForm((previous) => ({
                      ...previous,
                      round: event.target.value as AdmissionsAppRound,
                    }))
                  }
                >
                  {ADMISSIONS_APP_ROUNDS.map((round) => (
                    <option key={round} value={round}>
                      {ADMISSIONS_APP_ROUND_LABELS[round]}
                    </option>
                  ))}
                </select>
              </label>
              <label className="space-y-1 text-xs font-medium text-foreground">
                Deadline
                <Input
                  type="date"
                  value={addForm.deadline}
                  onChange={(event) =>
                    setAddForm((previous) => ({
                      ...previous,
                      deadline: event.target.value,
                    }))
                  }
                />
              </label>
              <label className="space-y-1 text-xs font-medium text-foreground">
                Category
                <select
                  className={cn(SELECT_CLASSES, "w-full")}
                  value={addForm.category}
                  onChange={(event) =>
                    setAddForm((previous) => ({
                      ...previous,
                      category: event.target.value as AdmissionsCollegeCategory,
                    }))
                  }
                >
                  {ADMISSIONS_COLLEGE_CATEGORIES.map((category) => (
                    <option key={category} value={category}>
                      {COLLEGE_CATEGORY_LABELS[category]}
                    </option>
                  ))}
                </select>
              </label>
            </div>

            {addError ? (
              <p role="alert" className="text-sm text-destructive">
                {addError}
              </p>
            ) : null}
          </div>
          <DialogFooter>
            <Button
              variant="ghost"
              size="sm"
              onClick={() => setAddOpen(false)}
              disabled={addSaving}
            >
              Cancel
            </Button>
            <Button
              size="sm"
              data-testid="add-college-submit"
              disabled={!canSubmitAddCollege(addForm) || addSaving}
              onClick={() => void handleAddSubmit()}
            >
              {addSaving ? "Adding…" : "Add college"}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* ── Aid dialog (CM-44 aid fields) ── */}
      <Dialog
        open={aidTarget !== null}
        onOpenChange={(open) => {
          if (!open) setAidTarget(null);
        }}
      >
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Merit / financial aid</DialogTitle>
            <DialogDescription>
              {aidTarget ? `Aid offered by ${aidTarget.instName}.` : ""}
            </DialogDescription>
          </DialogHeader>
          <div className="space-y-3">
            <label className="space-y-1 text-xs font-medium text-foreground">
              Amount offered (USD)
              <Input
                inputMode="decimal"
                placeholder="e.g. 25000"
                value={aidOffered}
                onChange={(event) => setAidOffered(event.target.value)}
              />
            </label>
            <label className="space-y-1 text-xs font-medium text-foreground">
              Notes
              <Textarea
                value={aidNotes}
                onChange={(event) => setAidNotes(event.target.value)}
              />
            </label>
            {aidError ? (
              <p role="alert" className="text-sm text-destructive">
                {aidError}
              </p>
            ) : null}
          </div>
          <DialogFooter>
            <Button
              variant="ghost"
              size="sm"
              onClick={() => setAidTarget(null)}
              disabled={aidSaving}
            >
              Cancel
            </Button>
            <Button size="sm" disabled={aidSaving} onClick={() => void handleAidSave()}>
              {aidSaving ? "Saving…" : "Save aid"}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* ── Delete confirmation (destructive action guard) ── */}
      <Dialog
        open={pendingDelete !== null}
        onOpenChange={(open) => {
          if (!open) setPendingDelete(null);
        }}
      >
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Remove this college?</DialogTitle>
            <DialogDescription>
              {pendingDelete
                ? `"${pendingDelete.instName}" will be removed from the list. Its decision history is kept for the record.`
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
              Keep college
            </Button>
            <Button
              variant="destructive"
              size="sm"
              data-testid="delete-college-confirm"
              onClick={() => void handleDeleteConfirmed()}
              disabled={deleteSaving}
            >
              {deleteSaving ? "Removing…" : "Remove college"}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}
