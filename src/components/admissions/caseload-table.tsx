"use client";

// ----------------------------------------------------------------------------
// Admissions caseload — sortable/filterable table view (design §5.1).
// Columns: student, cohort, status, counselors, progress, next deadline,
// days-since-touch. Progress renders the live checklist percentage as a bar
// (CM-24) and next deadline renders relative to today's Bangkok date with
// overdue rows in --conflict red (CM-101/102); both arrive precomputed on the
// caseload DTO (getCaseloadForUser). Sorting, filtering, and the deadline
// formatter are pure exported helpers so they stay unit-testable without a
// DOM.
// ----------------------------------------------------------------------------

import Link from "next/link";
import { useRouter } from "next/navigation";
import { useMemo, useState, type KeyboardEvent, type MouseEvent } from "react";
import { ArrowDown, ArrowUp, ArrowUpDown, Search } from "lucide-react";
import { cn } from "@/lib/utils";
import { Badge } from "@/components/ui/badge";
import { Input } from "@/components/ui/input";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { todayBangkok } from "@/lib/room-capacity/dates";
import type { AdmissionsCaseStatus, AdmissionsCaseSummary } from "@/lib/admissions/types";
import {
  CASE_STATUS_BADGE_CLASSES,
  CASE_STATUS_LABELS,
  CASE_STATUS_ORDER,
  getCaseStatusRank,
} from "./case-status";

/** Sentinel value for "no filter" in the status/cohort selects. */
export const ALL_CASELOAD_FILTER = "all";

/** Sortable table columns. */
export type CaseloadSortKey =
  | "studentName"
  | "cohort"
  | "status"
  | "counselors"
  | "daysSinceLastTouch";

/** Sort direction for the caseload table. */
export type CaseloadSortDirection = "asc" | "desc";

/** Active sort state (column + direction). */
export interface CaseloadSort {
  key: CaseloadSortKey;
  direction: CaseloadSortDirection;
}

/** Active filter state for the caseload table. */
export interface CaseloadFilters {
  /** Free-text match against student/cohort/counselor names and emails. */
  search: string;
  /** A case status, or ALL_CASELOAD_FILTER. */
  status: AdmissionsCaseStatus | typeof ALL_CASELOAD_FILTER;
  /** A cohortId, or ALL_CASELOAD_FILTER. */
  cohortId: string;
}

/** Default sort: student name A→Z. */
export const DEFAULT_CASELOAD_SORT: CaseloadSort = {
  key: "studentName",
  direction: "asc",
};

/** Default filters: everything visible. */
export const DEFAULT_CASELOAD_FILTERS: CaseloadFilters = {
  search: "",
  status: ALL_CASELOAD_FILTER,
  cohortId: ALL_CASELOAD_FILTER,
};

/**
 * Applies the caseload filters to `rows` (pure, order-preserving).
 *
 * 1. Status filter: exact match unless ALL_CASELOAD_FILTER.
 * 2. Cohort filter: exact cohortId match unless ALL_CASELOAD_FILTER.
 * 3. Search: case-insensitive substring against student name, preferred name,
 *    cohort name, counselor names, and counselor emails.
 */
export function filterCaseloadRows(
  rows: AdmissionsCaseSummary[],
  filters: CaseloadFilters,
): AdmissionsCaseSummary[] {
  const query = filters.search.trim().toLowerCase();
  return rows.filter((row) => {
    if (filters.status !== ALL_CASELOAD_FILTER && row.status !== filters.status) return false;
    if (filters.cohortId !== ALL_CASELOAD_FILTER && row.cohortId !== filters.cohortId) {
      return false;
    }
    if (!query) return true;
    const haystacks = [
      row.studentName,
      row.preferredName ?? "",
      row.cohortName,
      ...row.counselorNames,
      ...row.counselorEmails,
    ];
    return haystacks.some((value) => value.toLowerCase().includes(query));
  });
}

/**
 * Sorts `rows` by the active sort (pure — returns a new array).
 *
 * 1. daysSinceLastTouch: rows with no logged meeting (null) always sort last,
 *    regardless of direction.
 * 2. Primary comparison per key (status uses the canonical lifecycle order;
 *    cohort compares name then graduation year; counselors compare the first
 *    counselor display name).
 * 3. Ties break by student name A→Z (direction-independent).
 */
export function sortCaseloadRows(
  rows: AdmissionsCaseSummary[],
  sort: CaseloadSort,
): AdmissionsCaseSummary[] {
  const factor = sort.direction === "asc" ? 1 : -1;
  return rows.slice().sort((a, b) => {
    if (sort.key === "daysSinceLastTouch") {
      const aNull = a.daysSinceLastTouch === null;
      const bNull = b.daysSinceLastTouch === null;
      if (aNull !== bNull) return aNull ? 1 : -1;
    }
    const primary = compareCaseloadRows(a, b, sort.key);
    if (primary !== 0) return primary * factor;
    return a.studentName.localeCompare(b.studentName);
  });
}

/** Toggles a header click: new column → asc; same column → flip direction. */
export function toggleCaseloadSort(current: CaseloadSort, key: CaseloadSortKey): CaseloadSort {
  if (current.key !== key) return { key, direction: "asc" };
  return { key, direction: current.direction === "asc" ? "desc" : "asc" };
}

/** "—" for never-touched, "Today" for 0, else "Nd ago". */
export function formatDaysSinceTouch(value: number | null): string {
  if (value === null) return "—";
  if (value === 0) return "Today";
  return `${value}d ago`;
}

const DATE_ONLY_PATTERN = /^(\d{4})-(\d{2})-(\d{2})$/;

/** Rendered next-deadline cell: relative label + overdue flag (CM-101/102). */
export interface NextDeadlineDisplay {
  label: string;
  /** True when the deadline is strictly before today (Bangkok). */
  overdue: boolean;
}

function toUtcMillis(dateOnly: string): number {
  const [year, month, day] = dateOnly.split("-").map(Number);
  return Date.UTC(year, month - 1, day);
}

/**
 * Formats a caseload row's next deadline relative to today's Bangkok date:
 * "—" for none, "Nd overdue" (flagged) for past dates, "Due today",
 * "Due tomorrow", else "In Nd". Malformed inputs pass through unflagged —
 * never guessed as overdue (fail-closed).
 */
export function formatNextDeadline(
  nextDeadline: string | null,
  todayIso: string,
): NextDeadlineDisplay {
  if (nextDeadline === null) return { label: "—", overdue: false };
  if (!DATE_ONLY_PATTERN.test(nextDeadline) || !DATE_ONLY_PATTERN.test(todayIso)) {
    return { label: nextDeadline, overdue: false };
  }
  const diffDays = Math.round(
    (toUtcMillis(nextDeadline) - toUtcMillis(todayIso)) / 86_400_000,
  );
  if (diffDays < 0) return { label: `${-diffDays}d overdue`, overdue: true };
  if (diffDays === 0) return { label: "Due today", overdue: false };
  if (diffDays === 1) return { label: "Due tomorrow", overdue: false };
  return { label: `In ${diffDays}d`, overdue: false };
}

/** "YYYY-MM-DD" → "D/M/YYYY" (repo-wide D/M convention); non-dates pass through. */
function formatDateOnly(value: string): string {
  const match = DATE_ONLY_PATTERN.exec(value);
  if (!match) return value;
  return `${Number(match[3])}/${Number(match[2])}/${match[1]}`;
}

/** Compact checklist-progress bar + percentage (shared table/board cell). */
export function CaseloadProgress({
  percent,
  studentName,
}: {
  percent: number;
  studentName: string;
}) {
  return (
    <span className="flex items-center gap-2">
      <span
        role="progressbar"
        aria-label={`Checklist progress for ${studentName}`}
        aria-valuenow={percent}
        aria-valuemin={0}
        aria-valuemax={100}
        className="h-1.5 w-16 shrink-0 overflow-hidden rounded-full bg-muted"
      >
        <span
          className="block h-full rounded-full bg-primary"
          style={{ width: `${percent}%` }}
        />
      </span>
      <span className="text-xs tabular-nums text-muted-foreground">{percent}%</span>
    </span>
  );
}

function compareCaseloadRows(
  a: AdmissionsCaseSummary,
  b: AdmissionsCaseSummary,
  key: CaseloadSortKey,
): number {
  switch (key) {
    case "studentName":
      return a.studentName.localeCompare(b.studentName);
    case "cohort":
      return (
        a.cohortName.localeCompare(b.cohortName) || a.graduationYear - b.graduationYear
      );
    case "status":
      return getCaseStatusRank(a.status) - getCaseStatusRank(b.status);
    case "counselors":
      return (a.counselorNames[0] ?? "").localeCompare(b.counselorNames[0] ?? "");
    case "daysSinceLastTouch":
      return (a.daysSinceLastTouch ?? 0) - (b.daysSinceLastTouch ?? 0);
  }
}

interface SortableHeadProps {
  label: string;
  sortKey: CaseloadSortKey;
  sort: CaseloadSort;
  onSort: (key: CaseloadSortKey) => void;
}

function SortableHead({ label, sortKey, sort, onSort }: SortableHeadProps) {
  const isActive = sort.key === sortKey;
  const ariaSort = isActive ? (sort.direction === "asc" ? "ascending" : "descending") : "none";
  const Icon = isActive ? (sort.direction === "asc" ? ArrowUp : ArrowDown) : ArrowUpDown;
  return (
    <TableHead aria-sort={ariaSort}>
      <button
        type="button"
        onClick={() => onSort(sortKey)}
        className="inline-flex items-center gap-1 rounded-sm font-medium outline-none hover:text-primary focus-visible:ring-2 focus-visible:ring-ring/50"
      >
        {label}
        <Icon aria-hidden className={isActive ? "size-3.5 text-primary" : "size-3.5 text-muted-foreground/60"} />
      </button>
    </TableHead>
  );
}

export interface CaseloadTableProps {
  rows: AdmissionsCaseSummary[];
}

/** Desktop-dense caseload table with toolbar filters + sortable headers. */
export function CaseloadTable({ rows }: CaseloadTableProps) {
  const router = useRouter();
  const [filters, setFilters] = useState<CaseloadFilters>(DEFAULT_CASELOAD_FILTERS);
  const [sort, setSort] = useState<CaseloadSort>(DEFAULT_CASELOAD_SORT);
  const todayIso = useMemo(() => todayBangkok(), []);

  const cohortOptions = useMemo(() => {
    const byId = new Map<string, string>();
    for (const row of rows) {
      if (!byId.has(row.cohortId)) byId.set(row.cohortId, row.cohortName);
    }
    return [...byId.entries()].map(([id, name]) => ({ id, name }));
  }, [rows]);

  const visibleRows = useMemo(
    () => sortCaseloadRows(filterCaseloadRows(rows, filters), sort),
    [rows, filters, sort],
  );

  const handleSort = (key: CaseloadSortKey) => setSort((current) => toggleCaseloadSort(current, key));

  const openCaseFromRow = (
    caseId: string,
    event: MouseEvent<HTMLTableRowElement> | KeyboardEvent<HTMLTableRowElement>,
  ) => {
    if (
      "key" in event &&
      event.key !== "Enter"
    ) {
      return;
    }
    if (
      event.target instanceof HTMLElement &&
      event.target.closest("a,button,input,select,textarea,[role='button']")
    ) {
      return;
    }
    router.push(`/admissions/${caseId}`);
  };

  return (
    <div className="flex flex-col gap-3">
      <div className="flex flex-wrap items-center gap-2">
        <div className="relative flex-1 sm:max-w-xs">
          <Search aria-hidden className="pointer-events-none absolute top-1/2 left-2.5 size-4 -translate-y-1/2 text-muted-foreground" />
          <Input
            aria-label="Search cases"
            placeholder="Search student, cohort, counselor…"
            value={filters.search}
            onChange={(event) => setFilters((current) => ({ ...current, search: event.target.value }))}
            className="pl-8"
          />
        </div>
        <Select
          value={filters.status}
          onValueChange={(value) =>
            setFilters((current) => ({
              ...current,
              status: (value as CaseloadFilters["status"] | null) ?? ALL_CASELOAD_FILTER,
            }))
          }
        >
          <SelectTrigger size="sm" className="w-36 bg-background" aria-label="Filter by status">
            <SelectValue placeholder="All statuses" />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value={ALL_CASELOAD_FILTER}>All statuses</SelectItem>
            {CASE_STATUS_ORDER.map((status) => (
              <SelectItem key={status} value={status}>
                {CASE_STATUS_LABELS[status]}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
        <Select
          value={filters.cohortId}
          onValueChange={(value) =>
            setFilters((current) => ({
              ...current,
              cohortId: (value as string | null) ?? ALL_CASELOAD_FILTER,
            }))
          }
        >
          <SelectTrigger size="sm" className="w-40 bg-background" aria-label="Filter by cohort">
            <SelectValue placeholder="All cohorts" />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value={ALL_CASELOAD_FILTER}>All cohorts</SelectItem>
            {cohortOptions.map((cohort) => (
              <SelectItem key={cohort.id} value={cohort.id}>
                {cohort.name}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
      </div>

      <div className="rounded-xl bg-card ring-1 ring-foreground/10">
        <Table>
          <TableHeader>
            <TableRow>
              <SortableHead label="Student" sortKey="studentName" sort={sort} onSort={handleSort} />
              <SortableHead label="Cohort" sortKey="cohort" sort={sort} onSort={handleSort} />
              <SortableHead label="Status" sortKey="status" sort={sort} onSort={handleSort} />
              <SortableHead label="Counselors" sortKey="counselors" sort={sort} onSort={handleSort} />
              <TableHead>Progress</TableHead>
              <TableHead>Next deadline</TableHead>
              <SortableHead label="Last touch" sortKey="daysSinceLastTouch" sort={sort} onSort={handleSort} />
            </TableRow>
          </TableHeader>
          <TableBody>
            {visibleRows.length === 0 ? (
              <TableRow>
                <TableCell colSpan={7} className="py-8 text-center text-muted-foreground">
                  {rows.length === 0
                    ? "No cases yet — create the first case to get started."
                    : "No cases match the current filters."}
                </TableCell>
              </TableRow>
            ) : (
              visibleRows.map((row) => {
                const deadline = formatNextDeadline(row.nextDeadline, todayIso);
                return (
                  <TableRow
                    key={row.caseId}
                    role="link"
                    tabIndex={0}
                    aria-label={`Open ${row.studentName}'s admissions case`}
                    data-case-href={`/admissions/${row.caseId}`}
                    className="cursor-pointer focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring/50"
                    onClick={(event) => openCaseFromRow(row.caseId, event)}
                    onKeyDown={(event) => openCaseFromRow(row.caseId, event)}
                  >
                    <TableCell>
                      <Link
                        href={`/admissions/${row.caseId}`}
                        className="rounded-sm font-medium outline-none hover:text-primary hover:underline focus-visible:ring-2 focus-visible:ring-ring/50"
                      >
                        {row.studentName}
                      </Link>
                      {row.preferredName ? (
                        <span className="ml-1.5 text-muted-foreground">({row.preferredName})</span>
                      ) : null}
                    </TableCell>
                    <TableCell>
                      {row.cohortName}
                      <span className="ml-1.5 text-xs text-muted-foreground">{row.graduationYear}</span>
                    </TableCell>
                    <TableCell>
                      <Badge className={CASE_STATUS_BADGE_CLASSES[row.status]}>
                        {CASE_STATUS_LABELS[row.status]}
                      </Badge>
                    </TableCell>
                    <TableCell className="max-w-52 truncate" title={row.counselorNames.join(", ")}>
                      {row.counselorNames.length > 0 ? row.counselorNames.join(", ") : "—"}
                    </TableCell>
                    <TableCell>
                      <CaseloadProgress
                        percent={row.progressPercent}
                        studentName={row.studentName}
                      />
                    </TableCell>
                    <TableCell
                      className={cn(
                        "tabular-nums",
                        deadline.overdue
                          ? "font-medium text-conflict"
                          : "text-muted-foreground",
                      )}
                      title={row.nextDeadline ? formatDateOnly(row.nextDeadline) : undefined}
                    >
                      {deadline.label}
                    </TableCell>
                    <TableCell className="tabular-nums">
                      {formatDaysSinceTouch(row.daysSinceLastTouch)}
                    </TableCell>
                  </TableRow>
                );
              })
            )}
          </TableBody>
        </Table>
      </div>
    </div>
  );
}
