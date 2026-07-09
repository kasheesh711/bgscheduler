"use client";

// ----------------------------------------------------------------------------
// Admissions parent dashboard (design §5.3, PRD CM-130..CM-131) — the
// mobile-first, READ-ONLY single-scroll page a parent lands on for their
// child's case.
//
// Section order is fixed by design §5.3: child header → progress (overall
// bar + compact phase rings) → upcoming deadlines (grouped by week, overdue
// red) → college list (name, round label, status chip) → announcements →
// released testing milestones → shared notes.
//
// Data arrives exclusively as props: the server page builds the closed
// ParentDashboard DTO via buildParentDashboard (the structural whitelist,
// §2.3) and this component fetches NOTHING — no API calls, no mutations, no
// links to staff surfaces. The only interactive controls are the two th/en
// language-toggle buttons (CM-131), which touch localStorage and nothing
// else. Raw scores render ONLY when the DTO carries a `score` key (CM-83 —
// the projection omits the key entirely for unreleased scores).
//
// Bilingual statics (CM-131): every static string renders Thai-FIRST via
// strings.ts; the persisted toggle switches to English. Data values (names,
// college names, round labels, bodies, dates, scores) render verbatim.
// ----------------------------------------------------------------------------

import { useCallback, useEffect, useMemo, useState } from "react";
import { CircleCheckIcon, CircleIcon, LanguagesIcon } from "lucide-react";

import { cn } from "@/lib/utils";
import { Badge } from "@/components/ui/badge";
import {
  Card,
  CardContent,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import { BANGKOK_TIME_ZONE } from "@/lib/bangkok-time";
import { todayBangkok } from "@/lib/room-capacity/dates";
import {
  PARENT_APP_STATUS_STRINGS,
  PARENT_CASE_STATUS_STRINGS,
  PARENT_DEADLINE_SOURCE_STRINGS,
  PARENT_STRINGS,
  PARENT_TEST_TYPE_STRINGS,
  formatParentString,
  pickParentString,
  readStoredParentLocale,
  writeStoredParentLocale,
  type ParentLocale,
} from "./strings";
import type {
  ParentDashboard,
  ParentDeadline,
  ParentPhaseProgress,
  ParentTestingMilestone,
} from "@/lib/admissions/parent-projection";

// ── Section order (design §5.3 — tests assert this exact sequence) ──────

/** The §5.3 single-scroll section test-ids in their mandated order. */
export const PARENT_SECTION_TEST_IDS = [
  "parent-header",
  "parent-progress",
  "parent-deadlines",
  "parent-colleges",
  "parent-announcements",
  "parent-testing",
  "parent-notes",
] as const;

// ── Week grouping (deadlines, design §5.3) ──────────────────────────────

/** One rendered deadline group: overdue, this week, next week, or a later week. */
export interface ParentDeadlineGroup {
  /** Stable key: "overdue", "week-0", "week-1", "week-N", or "week-unknown". */
  key: string;
  kind: "overdue" | "thisWeek" | "nextWeek" | "laterWeek";
  /** Monday of the group's week ("YYYY-MM-DD"); null for overdue/unparsable. */
  weekStart: string | null;
  items: ParentDeadline[];
}

const DATE_ONLY_PATTERN = /^(\d{4})-(\d{2})-(\d{2})$/;
const MS_PER_DAY = 86_400_000;

/** "YYYY-MM-DD" → days since the Unix epoch, or null when malformed. */
function epochDayOf(dateOnly: string): number | null {
  const match = DATE_ONLY_PATTERN.exec(dateOnly);
  if (!match) return null;
  return Math.floor(
    Date.UTC(Number(match[1]), Number(match[2]) - 1, Number(match[3])) / MS_PER_DAY,
  );
}

/** Epoch day of the Monday starting the week that contains `day`. */
function mondayEpochDayOf(day: number): number {
  // Epoch day 0 (1970-01-01) was a Thursday, so Monday-index = (day + 3) mod 7.
  return day - ((((day + 3) % 7) + 7) % 7);
}

/** Days since the Unix epoch → "YYYY-MM-DD". */
function isoFromEpochDay(day: number): string {
  return new Date(day * MS_PER_DAY).toISOString().slice(0, 10);
}

/**
 * Groups the parent deadline list by week (design §5.3): overdue items
 * first, then this week, next week, and one group per later week (ascending).
 *
 * 1. `overdue` items (already flagged by the projection with Bangkok
 *    semantics) form the leading "overdue" group regardless of date.
 * 2. Everything else buckets by the Monday of its week relative to the
 *    Monday of `todayIso`'s week: offset ≤0 → this week (fail-safe: an
 *    un-flagged past date never invents an overdue group), 1 → next week,
 *    ≥2 → a "week of {Monday}" group.
 * 3. Unparsable dates land in a trailing "week-unknown" group (fail-closed:
 *    shown last, never dropped).
 *
 * Items keep date-ascending order inside each group; empty groups are omitted.
 *
 * @returns the ordered, non-empty groups.
 */
export function groupParentDeadlinesByWeek(
  deadlines: ParentDeadline[],
  todayIso: string,
): ParentDeadlineGroup[] {
  const todayDay = epochDayOf(todayIso);
  const todayMonday = todayDay === null ? null : mondayEpochDayOf(todayDay);

  const overdueItems: ParentDeadline[] = [];
  const byOffset = new Map<number, ParentDeadline[]>();
  const unknownItems: ParentDeadline[] = [];

  for (const item of deadlines) {
    if (item.overdue) {
      overdueItems.push(item);
      continue;
    }
    const itemDay = epochDayOf(item.date);
    if (itemDay === null || todayMonday === null) {
      unknownItems.push(item);
      continue;
    }
    const offset = Math.max(0, (mondayEpochDayOf(itemDay) - todayMonday) / 7);
    const bucket = byOffset.get(offset);
    if (bucket) bucket.push(item);
    else byOffset.set(offset, [item]);
  }

  const byDate = (a: ParentDeadline, b: ParentDeadline) =>
    a.date.localeCompare(b.date);

  const groups: ParentDeadlineGroup[] = [];
  if (overdueItems.length > 0) {
    groups.push({
      key: "overdue",
      kind: "overdue",
      weekStart: null,
      items: overdueItems.slice().sort(byDate),
    });
  }
  for (const offset of Array.from(byOffset.keys()).sort((a, b) => a - b)) {
    const items = byOffset.get(offset)!.slice().sort(byDate);
    const weekStart =
      todayMonday === null ? null : isoFromEpochDay(todayMonday + offset * 7);
    groups.push({
      key: `week-${offset}`,
      kind: offset === 0 ? "thisWeek" : offset === 1 ? "nextWeek" : "laterWeek",
      weekStart,
      items,
    });
  }
  if (unknownItems.length > 0) {
    groups.push({
      key: "week-unknown",
      kind: "laterWeek",
      weekStart: null,
      items: unknownItems,
    });
  }
  return groups;
}

// ── Private formatting helpers (mirror the sibling shells) ──────────────

/** "YYYY-MM-DD" → "D/M/YYYY" (repo-wide D/M convention); non-dates pass through. */
function formatDateOnly(value: string): string {
  const match = DATE_ONLY_PATTERN.exec(value);
  if (!match) return value;
  return `${Number(match[3])}/${Number(match[2])}/${match[1]}`;
}

/** ISO timestamp → "D/M/YYYY, HH:mm" on the Asia/Bangkok clock. */
function formatBangkokTimestamp(iso: string): string {
  const parsed = new Date(iso);
  if (Number.isNaN(parsed.getTime())) return iso;
  return new Intl.DateTimeFormat("en-GB", {
    timeZone: BANGKOK_TIME_ZONE,
    day: "numeric",
    month: "numeric",
    year: "numeric",
    hour: "2-digit",
    minute: "2-digit",
  }).format(parsed);
}

// ── Atoms ───────────────────────────────────────────────────────────────

/** Compact SVG progress ring for one phase (parent read-only variant). */
function ParentPhaseRing({ ring }: { ring: ParentPhaseProgress }) {
  const size = 64;
  const strokeWidth = 6;
  const radius = (size - strokeWidth) / 2;
  const circumference = 2 * Math.PI * radius;
  const offset = circumference * (1 - ring.percent / 100);
  return (
    <div data-testid="parent-phase-ring" className="flex flex-col items-center gap-1">
      <div role="img" aria-label={`${ring.label}: ${ring.percent}%`} className="relative">
        <svg width={size} height={size} viewBox={`0 0 ${size} ${size}`} aria-hidden>
          <circle
            cx={size / 2}
            cy={size / 2}
            r={radius}
            fill="none"
            strokeWidth={strokeWidth}
            className="stroke-muted"
          />
          <circle
            cx={size / 2}
            cy={size / 2}
            r={radius}
            fill="none"
            strokeWidth={strokeWidth}
            strokeLinecap="round"
            strokeDasharray={circumference}
            strokeDashoffset={offset}
            transform={`rotate(-90 ${size / 2} ${size / 2})`}
            className="stroke-primary"
          />
        </svg>
        <span className="absolute inset-0 flex items-center justify-center text-xs font-semibold text-foreground">
          {ring.percent}%
        </span>
      </div>
      <span className="max-w-20 text-center text-xs leading-tight text-muted-foreground">
        {ring.label}
      </span>
    </div>
  );
}

/** One registered/taken/score-received milestone step (read-only). */
function MilestoneStep({ done, label }: { done: boolean; label: string }) {
  return (
    <li className="flex items-center gap-1.5">
      {done ? (
        <CircleCheckIcon aria-hidden className="size-4 shrink-0 text-available" />
      ) : (
        <CircleIcon aria-hidden className="size-4 shrink-0 text-muted-foreground/50" />
      )}
      <span
        className={cn(
          "text-xs",
          done ? "font-medium text-foreground" : "text-muted-foreground",
        )}
      >
        {label}
      </span>
    </li>
  );
}

/** One released testing milestone row (CM-83: score only when present). */
function TestingMilestoneRow({
  milestone,
  locale,
}: {
  milestone: ParentTestingMilestone;
  locale: ParentLocale;
}) {
  return (
    <li
      data-testid="parent-milestone-row"
      className="space-y-2 rounded-lg border border-border/60 p-3"
    >
      <div className="flex flex-wrap items-baseline justify-between gap-x-3 gap-y-1">
        <span className="text-sm font-medium text-foreground">
          {pickParentString(PARENT_TEST_TYPE_STRINGS[milestone.testType], locale)}
        </span>
        <span className="text-xs text-muted-foreground">
          {formatParentString(PARENT_STRINGS.testingDate, locale, {
            date: formatDateOnly(milestone.testDate),
          })}
        </span>
      </div>
      <ul className="flex flex-wrap items-center gap-x-4 gap-y-1.5">
        <MilestoneStep
          done={milestone.registered}
          label={pickParentString(PARENT_STRINGS.testingRegistered, locale)}
        />
        <MilestoneStep
          done={milestone.taken}
          label={pickParentString(PARENT_STRINGS.testingTaken, locale)}
        />
        <MilestoneStep
          done={milestone.scoreReceived}
          label={pickParentString(PARENT_STRINGS.testingScoreReceived, locale)}
        />
      </ul>
      {milestone.score !== undefined ? (
        <p data-testid="parent-milestone-score" className="text-sm text-foreground">
          {pickParentString(PARENT_STRINGS.testingScore, locale)}:{" "}
          <span className="font-semibold tabular-nums">{milestone.score}</span>
        </p>
      ) : null}
    </li>
  );
}

// ── Dashboard ───────────────────────────────────────────────────────────

/** Props for the parent dashboard — all data is server-built by the page. */
export interface ParentDashboardViewProps {
  /** The closed parent projection (buildParentDashboard, design §2.3). */
  dashboard: ParentDashboard;
  /**
   * Locale used for the first render (defaults to "th", CM-131). The mount
   * effect re-reads the persisted choice from localStorage, so this only
   * controls SSR markup and tests.
   */
  initialLocale?: ParentLocale;
}

/**
 * Parent dashboard (design §5.3): mobile-first, read-only single scroll in
 * the mandated section order, Thai-first bilingual statics with a persisted
 * th/en toggle (CM-131). Zero mutation affordances and zero staff links —
 * the only buttons on the page are the two language toggles.
 */
export function ParentDashboardView({
  dashboard,
  initialLocale = "th",
}: ParentDashboardViewProps) {
  const [locale, setLocale] = useState<ParentLocale>(initialLocale);

  // Re-read the persisted choice once after hydration (SSR always renders
  // the Thai-first default; localStorage only exists on the client, so a
  // lazy useState initializer would cause a hydration mismatch).
  useEffect(() => {
    // eslint-disable-next-line react-hooks/set-state-in-effect -- one-shot post-hydration localStorage read (CM-131)
    setLocale(readStoredParentLocale(
      typeof window === "undefined" ? null : window.localStorage,
    ));
  }, []);

  const handleLocaleChange = useCallback((next: ParentLocale) => {
    setLocale(next);
    writeStoredParentLocale(
      typeof window === "undefined" ? null : window.localStorage,
      next,
    );
  }, []);

  const todayIso = useMemo(() => todayBangkok(), []);
  const deadlineGroups = useMemo(
    () => groupParentDeadlinesByWeek(dashboard.upcomingDeadlines, todayIso),
    [dashboard.upcomingDeadlines, todayIso],
  );

  const t = useCallback(
    (entry: { th: string; en: string }) => pickParentString(entry, locale),
    [locale],
  );

  const groupLabel = (group: ParentDeadlineGroup): string => {
    switch (group.kind) {
      case "overdue":
        return t(PARENT_STRINGS.deadlinesGroupOverdue);
      case "thisWeek":
        return t(PARENT_STRINGS.deadlinesGroupThisWeek);
      case "nextWeek":
        return t(PARENT_STRINGS.deadlinesGroupNextWeek);
      case "laterWeek":
        return formatParentString(PARENT_STRINGS.deadlinesGroupWeekOf, locale, {
          date: group.weekStart ? formatDateOnly(group.weekStart) : "—",
        });
    }
  };

  return (
    <div
      data-testid="parent-dashboard"
      className="mx-auto w-full max-w-screen-sm space-y-4 px-1 pt-2 pb-8 text-base"
    >
      {/* ── Language toggle (the ONLY buttons on the page, CM-131) ── */}
      <div
        role="group"
        aria-label={t(PARENT_STRINGS.languageToggle)}
        className="flex items-center justify-end gap-1"
      >
        <LanguagesIcon aria-hidden className="mr-1 size-4 text-muted-foreground" />
        {(["th", "en"] as const).map((option) => (
          <button
            key={option}
            type="button"
            data-testid={`parent-locale-${option}`}
            aria-pressed={locale === option}
            onClick={() => handleLocaleChange(option)}
            className={cn(
              "min-h-11 min-w-11 rounded-lg px-3 text-sm font-medium outline-none transition-colors focus-visible:ring-3 focus-visible:ring-ring/50",
              locale === option
                ? "bg-primary text-primary-foreground"
                : "text-muted-foreground hover:bg-muted/50 hover:text-foreground",
            )}
          >
            {option === "th"
              ? t(PARENT_STRINGS.languageThai)
              : t(PARENT_STRINGS.languageEnglish)}
          </button>
        ))}
      </div>

      {/* ── 1. Child header (design §5.3) ── */}
      <header data-testid="parent-header" className="space-y-1 px-1">
        <div className="flex flex-wrap items-center gap-2">
          <h1 className="text-xl font-semibold text-foreground">
            {dashboard.studentName}
          </h1>
          <Badge variant="secondary">
            {t(PARENT_CASE_STATUS_STRINGS[dashboard.caseStatus])}
          </Badge>
        </div>
        <p className="text-sm text-muted-foreground">{dashboard.cohortName}</p>
      </header>

      {/* ── 2. Progress: overall bar + compact phase rings ── */}
      <Card data-testid="parent-progress">
        <CardHeader>
          <CardTitle>{t(PARENT_STRINGS.progressTitle)}</CardTitle>
        </CardHeader>
        <CardContent className="space-y-4">
          <div className="space-y-1.5">
            <div className="flex items-center gap-3">
              <div
                role="progressbar"
                aria-label={t(PARENT_STRINGS.progressOverall)}
                aria-valuenow={dashboard.progress.percent}
                aria-valuemin={0}
                aria-valuemax={100}
                className="h-2 flex-1 overflow-hidden rounded-full bg-muted"
              >
                <div
                  className="h-full rounded-full bg-primary transition-all"
                  style={{ width: `${dashboard.progress.percent}%` }}
                />
              </div>
              <span className="text-sm font-medium text-foreground">
                {dashboard.progress.percent}%
              </span>
            </div>
            <p className="text-xs text-muted-foreground">
              {formatParentString(PARENT_STRINGS.progressDoneOfTotal, locale, {
                done: String(dashboard.progress.done),
                total: String(dashboard.progress.total),
              })}
            </p>
          </div>
          {dashboard.phaseProgress.length > 0 ? (
            <div className="space-y-2">
              <p className="text-xs font-medium text-muted-foreground">
                {t(PARENT_STRINGS.progressByPhase)}
              </p>
              <div className="grid grid-cols-3 gap-x-2 gap-y-3">
                {dashboard.phaseProgress.map((ring) => (
                  <ParentPhaseRing key={ring.phase} ring={ring} />
                ))}
              </div>
            </div>
          ) : null}
        </CardContent>
      </Card>

      {/* ── 3. Upcoming deadlines (grouped by week, overdue red) ── */}
      <Card data-testid="parent-deadlines">
        <CardHeader>
          <CardTitle>{t(PARENT_STRINGS.deadlinesTitle)}</CardTitle>
        </CardHeader>
        <CardContent>
          {deadlineGroups.length > 0 ? (
            <div className="space-y-4">
              {deadlineGroups.map((group) => (
                <section
                  key={group.key}
                  data-testid={`parent-deadline-group-${group.key}`}
                  aria-label={groupLabel(group)}
                  className="space-y-1.5"
                >
                  <h3
                    className={cn(
                      "text-xs font-semibold",
                      group.kind === "overdue" ? "text-conflict" : "text-muted-foreground",
                    )}
                  >
                    {groupLabel(group)}
                  </h3>
                  <ul className="space-y-1.5">
                    {group.items.map((item) => (
                      <li
                        key={`${item.source}:${item.title}:${item.date}`}
                        data-testid="parent-deadline-row"
                        className={cn(
                          "flex items-center justify-between gap-3 rounded-lg border px-3 py-2",
                          item.overdue ? "border-conflict/40 bg-conflict/5" : "border-border/60",
                        )}
                      >
                        <span className="min-w-0 flex-1">
                          <span className="block text-sm font-medium text-foreground">
                            {item.title}
                          </span>
                          <span className="text-xs text-muted-foreground">
                            {t(PARENT_DEADLINE_SOURCE_STRINGS[item.source])}
                          </span>
                        </span>
                        <span
                          className={cn(
                            "shrink-0 text-xs tabular-nums",
                            item.overdue
                              ? "font-medium text-conflict"
                              : "text-muted-foreground",
                          )}
                        >
                          {formatDateOnly(item.date)}
                          {item.overdue ? ` · ${t(PARENT_STRINGS.overdueMarker)}` : ""}
                        </span>
                      </li>
                    ))}
                  </ul>
                </section>
              ))}
            </div>
          ) : (
            <p className="text-sm text-muted-foreground">
              {t(PARENT_STRINGS.deadlinesEmpty)}
            </p>
          )}
        </CardContent>
      </Card>

      {/* ── 4. College list (name, round label, status chip — read-only) ── */}
      <Card data-testid="parent-colleges">
        <CardHeader>
          <CardTitle>{t(PARENT_STRINGS.collegesTitle)}</CardTitle>
        </CardHeader>
        <CardContent>
          {dashboard.collegeList.length > 0 ? (
            <ul className="space-y-2">
              {dashboard.collegeList.map((college, index) => (
                <li
                  key={`${college.instName}:${college.round}:${index}`}
                  data-testid="parent-college-row"
                  className="space-y-1.5 rounded-lg border border-border/60 p-3"
                >
                  <p className="text-sm font-medium text-foreground">
                    {college.instName}
                  </p>
                  <div className="flex flex-wrap items-center gap-1.5">
                    {/* Round label is server-provided display data — verbatim. */}
                    <Badge variant="outline">{college.roundLabel}</Badge>
                    <Badge variant="secondary">
                      {t(PARENT_APP_STATUS_STRINGS[college.appStatus])}
                    </Badge>
                    {college.deadline ? (
                      <Badge className="bg-muted text-muted-foreground">
                        {formatParentString(PARENT_STRINGS.collegeDue, locale, {
                          date: formatDateOnly(college.deadline),
                        })}
                      </Badge>
                    ) : null}
                  </div>
                </li>
              ))}
            </ul>
          ) : (
            <p className="text-sm text-muted-foreground">
              {t(PARENT_STRINGS.collegesEmpty)}
            </p>
          )}
        </CardContent>
      </Card>

      {/* ── 5. Announcements ── */}
      <Card data-testid="parent-announcements">
        <CardHeader>
          <CardTitle>{t(PARENT_STRINGS.announcementsTitle)}</CardTitle>
        </CardHeader>
        <CardContent>
          {dashboard.announcements.length > 0 ? (
            <ul className="space-y-3">
              {dashboard.announcements.map((announcement, index) => (
                <li
                  key={`${announcement.createdAt}:${index}`}
                  data-testid="parent-announcement-row"
                  className="space-y-0.5"
                >
                  <p className="text-sm font-medium text-foreground">
                    {announcement.title}
                  </p>
                  <p className="text-xs text-muted-foreground">
                    {formatBangkokTimestamp(announcement.createdAt)}
                  </p>
                  <p className="text-sm whitespace-pre-wrap text-foreground">
                    {announcement.body}
                  </p>
                </li>
              ))}
            </ul>
          ) : (
            <p className="text-sm text-muted-foreground">
              {t(PARENT_STRINGS.announcementsEmpty)}
            </p>
          )}
        </CardContent>
      </Card>

      {/* ── 6. Released testing milestones (CM-83) ── */}
      <Card data-testid="parent-testing">
        <CardHeader>
          <CardTitle>{t(PARENT_STRINGS.testingTitle)}</CardTitle>
        </CardHeader>
        <CardContent>
          {dashboard.testingMilestones.length > 0 ? (
            <ul className="space-y-2">
              {dashboard.testingMilestones.map((milestone, index) => (
                <TestingMilestoneRow
                  key={`${milestone.testType}:${milestone.testDate}:${index}`}
                  milestone={milestone}
                  locale={locale}
                />
              ))}
            </ul>
          ) : (
            <p className="text-sm text-muted-foreground">
              {t(PARENT_STRINGS.testingEmpty)}
            </p>
          )}
        </CardContent>
      </Card>

      {/* ── 7. Shared notes ── */}
      <Card data-testid="parent-notes">
        <CardHeader>
          <CardTitle>{t(PARENT_STRINGS.notesTitle)}</CardTitle>
        </CardHeader>
        <CardContent>
          {dashboard.sharedNotes.length > 0 ? (
            <ul className="space-y-3">
              {dashboard.sharedNotes.map((note, index) => (
                <li
                  key={`${note.createdAt}:${index}`}
                  data-testid="parent-note-row"
                  className="space-y-0.5"
                >
                  <p className="text-sm whitespace-pre-wrap text-foreground">
                    {note.body}
                  </p>
                  <p className="text-xs text-muted-foreground">
                    {formatBangkokTimestamp(note.createdAt)}
                  </p>
                </li>
              ))}
            </ul>
          ) : (
            <p className="text-sm text-muted-foreground">
              {t(PARENT_STRINGS.notesEmpty)}
            </p>
          )}
        </CardContent>
      </Card>
    </div>
  );
}
