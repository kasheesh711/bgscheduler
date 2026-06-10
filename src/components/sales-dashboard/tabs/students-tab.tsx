"use client";

import { useMemo, useState } from "react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import {
  STATUS_BADGE_VARIANTS,
  StudentDetailPanel,
} from "@/components/sales-dashboard/student-detail-panel";
import { formatCurrency } from "@/lib/sales-dashboard/format";
import type {
  ExploreSeed,
  SalesTabProps,
  StudentDirectoryEntry,
  StudentLiveStatus,
} from "@/lib/sales-dashboard/types";
import { cn } from "@/lib/utils";

// ----------------------------------------------------------------------------
// Students panel — instant client-side search over the student directory,
// status chips + quick-filter chips (Expiring soon / Churned / Trials not
// converted), three sorts, and a per-student detail panel. All statuses are
// recomputed live (validUntil + 14-day grace), never the stored churn_status.
// The directory is whole-history by design — the shell period selector does
// not filter this tab.
// ----------------------------------------------------------------------------

export const STUDENT_STATUSES: readonly StudentLiveStatus[] = [
  "Active",
  "Pending",
  "Retained",
  "Churned",
  "Trial-only",
];

export type StudentFilterId = `status:${StudentLiveStatus}` | "quick:expiring";
export type StudentSortKey = "recent" | "ltv" | "expiring";

export const EXPIRING_HORIZON_DAYS = 30;

const VISIBLE_LIMIT = 50;

const SORT_OPTIONS: { key: StudentSortKey; label: string }[] = [
  { key: "recent", label: "Recent payment" },
  { key: "ltv", label: "Lifetime value" },
  { key: "expiring", label: "Expiring soon" },
];

/** Quick-filter chips (graft from explorer-first): renewal-pipeline views. */
const QUICK_FILTERS: { id: StudentFilterId; label: string }[] = [
  { id: "quick:expiring", label: `Expiring soon (≤${EXPIRING_HORIZON_DAYS}d)` },
  { id: "status:Churned", label: "Churned" },
  { id: "status:Trial-only", label: "Trials not converted" },
];

/** Bangkok-local ISO date (YYYY-MM-DD) — the panel's "today" for live flags. */
export function bangkokTodayIso(now = new Date()): string {
  return new Intl.DateTimeFormat("en-CA", {
    timeZone: "Asia/Bangkok",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).format(now);
}

/** Add whole days to an ISO date (UTC math; date-only strings). */
export function addDaysToIso(date: string, days: number): string {
  const [year, month, day] = date.split("-").map(Number);
  return new Date(Date.UTC(year, month - 1, day + days)).toISOString().slice(0, 10);
}

/**
 * "Expiring soon" = the renewal decision window (decisionDate = validUntil +
 * 14d) closes within the next EXPIRING_HORIZON_DAYS days, today inclusive.
 */
export function isExpiringSoon(
  entry: Pick<StudentDirectoryEntry, "decisionDate">,
  today: string,
): boolean {
  if (!entry.decisionDate) return false;
  return entry.decisionDate >= today && entry.decisionDate <= addDaysToIso(today, EXPIRING_HORIZON_DAYS);
}

/** Single-select chip predicate over the directory. */
export function matchesStudentFilter(
  entry: Pick<StudentDirectoryEntry, "status" | "decisionDate">,
  filterId: StudentFilterId | null,
  today: string,
): boolean {
  if (filterId === null) return true;
  if (filterId === "quick:expiring") return isExpiringSoon(entry, today);
  return entry.status === filterId.slice("status:".length);
}

/**
 * Instant client-side directory filter: chip predicate first, then a
 * case-insensitive substring match over display name, all nickname variants,
 * programs, and reps.
 */
export function filterStudentDirectory(
  students: StudentDirectoryEntry[],
  query: string,
  filterId: StudentFilterId | null,
  today: string,
): StudentDirectoryEntry[] {
  const needle = query.trim().toLowerCase();
  return students.filter((entry) => {
    if (!matchesStudentFilter(entry, filterId, today)) return false;
    if (!needle) return true;
    const haystack = [entry.displayName, ...entry.displayNameVariants, ...entry.programs, ...entry.reps]
      .join(" ")
      .toLowerCase();
    return haystack.includes(needle);
  });
}

/**
 * Directory sorts: recent payment (default, desc), lifetime value (desc), and
 * expiring soon (decision date asc; entries without a decision date last).
 */
export function sortStudentDirectory(
  students: StudentDirectoryEntry[],
  sortKey: StudentSortKey,
): StudentDirectoryEntry[] {
  const rows = [...students];
  if (sortKey === "ltv") {
    rows.sort(
      (left, right) =>
        right.totalRevenue - left.totalRevenue || left.displayName.localeCompare(right.displayName),
    );
  } else if (sortKey === "expiring") {
    rows.sort((left, right) => {
      if (left.decisionDate && right.decisionDate) {
        return (
          left.decisionDate.localeCompare(right.decisionDate) ||
          left.displayName.localeCompare(right.displayName)
        );
      }
      if (left.decisionDate) return -1;
      if (right.decisionDate) return 1;
      return left.displayName.localeCompare(right.displayName);
    });
  } else {
    rows.sort(
      (left, right) =>
        right.lastPaymentDate.localeCompare(left.lastPaymentDate) ||
        left.displayName.localeCompare(right.displayName),
    );
  }
  return rows;
}

export interface StudentsSeedState {
  query: string;
  selectedKey: string | null;
}

/** Translate a GM cross-link seed into panel state; null when not applicable. */
export function seedToState(seed: ExploreSeed | null | undefined): StudentsSeedState | null {
  if (!seed || seed.tab !== "students") return null;
  if (seed.studentKey === undefined && seed.filter === undefined) return null;
  return { query: seed.filter ?? "", selectedKey: seed.studentKey ?? null };
}

function FilterChip({
  label,
  count,
  active,
  onClick,
}: {
  label: string;
  count?: number;
  active: boolean;
  onClick: () => void;
}) {
  return (
    <Button
      size="sm"
      variant={active ? "default" : "outline"}
      className="h-7 rounded-full px-2.5 text-xs"
      onClick={onClick}
    >
      {label}
      {count !== undefined ? (
        <span className={cn("text-[10px]", active ? "text-primary-foreground/80" : "text-muted-foreground")}>
          {count.toLocaleString("en-US")}
        </span>
      ) : null}
    </Button>
  );
}

export function StudentsTab({ dimensions, loading, seed }: SalesTabProps) {
  const initialSeedState = seedToState(seed);
  const [appliedSeed, setAppliedSeed] = useState<ExploreSeed | null>(seed ?? null);
  const [query, setQuery] = useState(initialSeedState?.query ?? "");
  const [filterId, setFilterId] = useState<StudentFilterId | null>(null);
  const [sortKey, setSortKey] = useState<StudentSortKey>("recent");
  const [showAll, setShowAll] = useState(false);
  const [selectedKey, setSelectedKey] = useState<string | null>(initialSeedState?.selectedKey ?? null);

  // Adopt later GM cross-link seeds during render (sanctioned derived-state
  // adjustment, same pattern as workspace-tabs' ?tab= adoption).
  if (seed && seed !== appliedSeed) {
    setAppliedSeed(seed);
    const seedState = seedToState(seed);
    if (seedState) {
      setQuery(seedState.query);
      setSelectedKey(seedState.selectedKey);
      setFilterId(null);
      setShowAll(false);
    }
  }

  const today = useMemo(() => bangkokTodayIso(), []);
  const students = useMemo(() => dimensions?.students ?? [], [dimensions]);

  const counts = useMemo(() => {
    const map = new Map<StudentFilterId, number>();
    for (const status of STUDENT_STATUSES) map.set(`status:${status}`, 0);
    map.set("quick:expiring", 0);
    for (const entry of students) {
      const statusId: StudentFilterId = `status:${entry.status}`;
      map.set(statusId, (map.get(statusId) ?? 0) + 1);
      if (isExpiringSoon(entry, today)) {
        map.set("quick:expiring", (map.get("quick:expiring") ?? 0) + 1);
      }
    }
    return map;
  }, [students, today]);

  const visibleStudents = useMemo(
    () => sortStudentDirectory(filterStudentDirectory(students, query, filterId, today), sortKey),
    [students, query, filterId, today, sortKey],
  );

  const shown = showAll ? visibleStudents : visibleStudents.slice(0, VISIBLE_LIMIT);
  const remaining = visibleStudents.length - shown.length;
  const selectedStudent = selectedKey
    ? (students.find((entry) => entry.key === selectedKey) ?? null)
    : null;

  const toggleFilter = (id: StudentFilterId) => {
    setFilterId((current) => (current === id ? null : id));
    setShowAll(false);
  };

  if (!dimensions) {
    return (
      <section className="rounded-lg border bg-card p-4 shadow-sm">
        <h2 className="text-sm font-semibold">Students</h2>
        {loading ? (
          <div className="mt-4 space-y-2">
            {Array.from({ length: 8 }).map((_, index) => (
              <div key={index} className="h-10 animate-pulse rounded-md bg-muted/50" />
            ))}
          </div>
        ) : (
          <p className="mt-1 text-xs text-muted-foreground">
            Sales dimensions are unavailable. Import a monthly source from the Overview tab, then revisit.
          </p>
        )}
      </section>
    );
  }

  return (
    <div className="space-y-3">
      <section className="rounded-lg border bg-card p-4 shadow-sm">
        <div className="flex flex-wrap items-baseline justify-between gap-2">
          <h2 className="text-sm font-semibold">Students</h2>
          <span className="text-[11px] text-muted-foreground">
            {students.length.toLocaleString("en-US")} students · whole history · status recomputed (live)
          </span>
        </div>

        <Input
          type="search"
          value={query}
          onChange={(event) => {
            setQuery(event.target.value);
            setShowAll(false);
          }}
          placeholder="Search students, nicknames, programs, reps…"
          className="mt-3"
          aria-label="Search students"
        />

        <div className="mt-3 flex flex-wrap items-center gap-1.5">
          {STUDENT_STATUSES.map((status) => (
            <FilterChip
              key={status}
              label={status}
              count={counts.get(`status:${status}`) ?? 0}
              active={filterId === `status:${status}`}
              onClick={() => toggleFilter(`status:${status}`)}
            />
          ))}
        </div>

        <div className="mt-2 flex flex-wrap items-center gap-1.5">
          <span className="text-[11px] text-muted-foreground">Quick filters:</span>
          {QUICK_FILTERS.map((quick) => (
            <FilterChip
              key={quick.id}
              label={quick.label}
              count={counts.get(quick.id) ?? 0}
              active={filterId === quick.id}
              onClick={() => toggleFilter(quick.id)}
            />
          ))}
        </div>

        <div className="mt-3 flex flex-wrap items-center gap-1.5">
          <span className="text-[11px] text-muted-foreground">Sort:</span>
          {SORT_OPTIONS.map((option) => (
            <Button
              key={option.key}
              size="sm"
              variant={sortKey === option.key ? "secondary" : "ghost"}
              className="h-7 px-2.5 text-xs"
              onClick={() => setSortKey(option.key)}
            >
              {option.label}
            </Button>
          ))}
        </div>
      </section>

      <section className="overflow-hidden rounded-lg border bg-card shadow-sm">
        <div className="hidden border-b bg-muted/30 px-3 py-1.5 text-[11px] uppercase tracking-wide text-muted-foreground md:grid md:grid-cols-[minmax(0,1.8fr)_110px_minmax(0,1.4fr)_96px_112px_minmax(110px,0.8fr)] md:items-center md:gap-x-3">
          <span>Student</span>
          <span>Status</span>
          <span>Programs</span>
          <span>Last paid</span>
          <span>Valid until</span>
          <span className="text-right">Revenue</span>
        </div>

        {shown.length === 0 ? (
          <p className="px-4 py-6 text-center text-sm text-muted-foreground">
            No students match this search or filter.
          </p>
        ) : (
          shown.map((entry) => (
            <button
              key={entry.key}
              type="button"
              onClick={() => setSelectedKey(entry.key)}
              className="grid w-full grid-cols-1 gap-x-3 gap-y-1 border-b px-3 py-2 text-left text-sm transition-colors last:border-b-0 hover:bg-muted/50 md:grid-cols-[minmax(0,1.8fr)_110px_minmax(0,1.4fr)_96px_112px_minmax(110px,0.8fr)] md:items-center"
            >
              <span className="flex min-w-0 items-center gap-1.5">
                <span className="truncate font-medium">{entry.displayName}</span>
                {entry.displayNameVariants.length > 1 ? (
                  <Badge
                    variant="outline"
                    className="shrink-0 text-[10px]"
                    title="Matched by nickname — multiple spellings collapse into this entry"
                  >
                    {entry.displayNameVariants.length} names
                  </Badge>
                ) : null}
              </span>
              <span>
                <Badge
                  variant={STATUS_BADGE_VARIANTS[entry.status]}
                  title="Recomputed live: churned when no payment lands within 14 days after the valid-until date"
                >
                  {entry.status}
                </Badge>
              </span>
              <span className="truncate text-xs text-muted-foreground">
                {entry.programs.join(", ") || "—"}
              </span>
              <span className="text-xs whitespace-nowrap text-muted-foreground">{entry.lastPaymentDate}</span>
              <span className="flex items-center gap-1.5 text-xs whitespace-nowrap text-muted-foreground">
                {entry.latestValidUntil ?? "—"}
                {isExpiringSoon(entry, today) ? (
                  <span
                    className="size-1.5 shrink-0 rounded-full bg-blocked"
                    title={`Renewal decision window closes by ${entry.decisionDate}`}
                  />
                ) : null}
              </span>
              <span className="text-right font-medium whitespace-nowrap">
                {formatCurrency(entry.totalRevenue)}{" "}
                <span className="text-[10px] font-normal text-muted-foreground">
                  {entry.txnCount + entry.addTxnCount} txn
                </span>
              </span>
            </button>
          ))
        )}

        {remaining > 0 ? (
          <div className="flex items-center justify-between gap-3 border-t px-4 py-2 text-xs text-muted-foreground">
            <span>
              +{remaining.toLocaleString("en-US")} more student{remaining === 1 ? "" : "s"}
            </span>
            <Button size="sm" variant="outline" onClick={() => setShowAll(true)}>
              Show all
            </Button>
          </div>
        ) : visibleStudents.length > 0 ? (
          <div className="border-t px-4 py-2 text-xs text-muted-foreground">
            {visibleStudents.length.toLocaleString("en-US")} student
            {visibleStudents.length === 1 ? "" : "s"}
          </div>
        ) : null}
      </section>

      <p className="px-1 text-[11px] text-muted-foreground">
        Students are matched by nickname — distinct spellings collapse into one entry (variants shown in
        the detail panel). Status is recomputed live (no payment within 14 days after the valid-until date
        = churned) and may disagree with the Overview churn list.
      </p>

      <StudentDetailPanel student={selectedStudent} today={today} onClose={() => setSelectedKey(null)} />
    </div>
  );
}
