// Admissions Case Management — student home: "This Week" next actions and
// season-scoped per-phase progress (CM-120).
//
// Design: docs/casemanagementsystem_design.md §5.2 (Home = "This Week" 3–5
// actions + season-relevant phase rings). PRD CM-120.
//
// Core rules:
// - buildThisWeek merges three ranked sources into one capped action list:
//   (a) open calendar deadlines — overdue OR due within the next 7 days —
//   from calendar.ts's collector aggregation (tasks, application deadlines,
//   essay deadlines, and test registrations/sittings via
//   CALENDAR_COLLECTORS), (b) stale-essay nudges (student has not touched
//   the essay for ≥14 days AND its deadline is within 30 days),
//   (c) unsubmitted-section nudges (self-report sections still in "draft").
// - Ranking is deterministic: calendar items first (overdue first, longest
//   overdue at the top, then soonest due — the getUpcomingDeadlines order),
//   then stale-essay nudges (the CM-63 deadline × staleness order), then
//   section nudges (definition display order), capped at `limit`.
// - getPhaseProgress reuses checklists.ts's computeProgressCounts per phase
//   and hides phases that are not season-relevant yet (documented month
//   heuristic below: Applications unlocks in August of senior year,
//   Decisions & Aid in December, Transition in senior spring — March of the
//   graduation year). Phases with zero tasks are omitted (no meaningful ring).
// - All dates are Asia/Bangkok calendar semantics, matching calendar.ts.
//
// Error contract (admissionsErrorResponse maps these): malformed caseId /
// missing case → Error("NotFound"); guards upstream own Forbidden.

import { and, eq, isNull } from "drizzle-orm";
import { getDb, type Database } from "@/lib/db";
import {
  admissionsCases,
  admissionsCaseTasks,
  admissionsCohorts,
} from "@/lib/db/schema";
import { BANGKOK_TIME_ZONE } from "@/lib/bangkok-time";
import {
  getUpcomingDeadlines,
  UPCOMING_DEADLINES_MAX_LIMIT,
  type CalendarItemSource,
} from "./calendar";
import {
  computeProgressCounts,
  type AdmissionsChecklistProgress,
} from "./checklists";
import {
  ADMISSIONS_CHECKLIST_PHASES,
  isAdmissionsPhaseKey,
  type AdmissionsPhaseKey,
} from "./config";
import { listEssaysForCase } from "./essays";
import { isUuidShaped } from "./members";
import { listSectionStates } from "./sections";

const DAY_IN_MS = 86_400_000;

/** Max prompt characters kept in an essay-nudge title before "…" truncation. */
const ESSAY_NUDGE_MAX_PROMPT_LENGTH = 60;

// ── "This Week" (CM-120) ────────────────────────────────────────────────

/** Default number of "This Week" actions (CM-120: 3–5 actions). */
export const THIS_WEEK_DEFAULT_LIMIT = 5;

/** Hard cap on "This Week" actions per call. */
export const THIS_WEEK_MAX_LIMIT = 10;

/** Look-ahead window for calendar deadlines feeding "This Week" (days). */
export const THIS_WEEK_WINDOW_DAYS = 7;

/** Min days since the student's last essay touch before a stale nudge fires. */
export const ESSAY_NUDGE_MIN_STALENESS_DAYS = 14;

/** Max days until the essay deadline for a stale nudge to be relevant. */
export const ESSAY_NUDGE_MAX_DEADLINE_DAYS = 30;

/**
 * Action source kind: a calendar source ("task" | "application" | "essay" |
 * "testing"), a stale-essay nudge ("essay"), or an unsubmitted-section nudge
 * ("section").
 */
export type ThisWeekActionKind = CalendarItemSource | "essay" | "section";

/** One ranked next action on the student home (CM-120). */
export interface ThisWeekAction {
  kind: ThisWeekActionKind;
  title: string;
  /** "YYYY-MM-DD" due date; null for undated nudges (sections). */
  dueDate: string | null;
  /** True when the underlying item is open and past due (Bangkok). */
  overdue: boolean;
  /**
   * Href-ish anchor key "{kind}:{rowId-or-sectionKey}" the mobile shell
   * resolves to a tab/deep-link (e.g. "task:{uuid}", "section:about_you").
   */
  anchor: string;
}

/** buildThisWeek options. */
export interface BuildThisWeekOptions {
  /** Reference instant; defaults to the current time. */
  now?: Date;
  /** Max actions returned; clamped to [1, THIS_WEEK_MAX_LIMIT]; default 5. */
  limit?: number;
}

/**
 * Builds the student home's ranked "This Week" action list (CM-120).
 *
 * 1. Calendar deadlines: getUpcomingDeadlines (open items only, overdue
 *    first, date ascending) filtered to due-or-overdue within the next
 *    THIS_WEEK_WINDOW_DAYS days (inclusive, Bangkok calendar). Sources
 *    follow calendar.ts's registered collectors.
 * 2. Stale-essay nudges: live essays whose effective stage is not "final",
 *    with a deadline within ESSAY_NUDGE_MAX_DEADLINE_DAYS days (overdue
 *    included), that the student has not touched for
 *    ESSAY_NUDGE_MIN_STALENESS_DAYS+ days — a never-touched essay (null
 *    staleness) counts as maximally stale, matching the CM-63 comparator.
 *    Essays already present as calendar items (via the registered essay
 *    collector) are deduped by anchor.
 * 3. Unsubmitted-section nudges: self-report sections still in "draft"
 *    (including never-saved ones), in definition display order.
 * 4. Concatenate 1→2→3 (deadline-driven work outranks nudges) and cap at
 *    `limit`.
 *
 * @returns at most `limit` ranked actions, most urgent first.
 */
export async function buildThisWeek(
  caseId: string,
  options: BuildThisWeekOptions = {},
  db: Database = getDb(),
): Promise<ThisWeekAction[]> {
  if (!isUuidShaped(caseId)) throw new Error("NotFound");

  const now = options.now ?? new Date();
  const limit = Math.min(
    THIS_WEEK_MAX_LIMIT,
    Math.max(1, Math.trunc(options.limit ?? THIS_WEEK_DEFAULT_LIMIT)),
  );
  const todayKey = getBangkokDateKey(now);
  const deadlineHorizonKey = getBangkokDateKey(
    new Date(now.getTime() + THIS_WEEK_WINDOW_DAYS * DAY_IN_MS),
  );
  const essayHorizonKey = getBangkokDateKey(
    new Date(now.getTime() + ESSAY_NUDGE_MAX_DEADLINE_DAYS * DAY_IN_MS),
  );

  const actions: ThisWeekAction[] = [];
  const seenAnchors = new Set<string>();

  // 1. Overdue + next-7-day open calendar items (already urgency-sorted).
  const deadlineItems = await getUpcomingDeadlines(
    caseId,
    UPCOMING_DEADLINES_MAX_LIMIT,
    now,
    db,
  );
  for (const item of deadlineItems) {
    if (item.date > deadlineHorizonKey) continue;
    const anchor = `${item.source}:${item.id}`;
    if (seenAnchors.has(anchor)) continue;
    seenAnchors.add(anchor);
    actions.push({
      kind: item.source,
      title: item.title,
      dueDate: item.date,
      overdue: item.overdue,
      anchor,
    });
  }

  // 2. Stale-essay nudges (CM-61 staleness × deadline proximity).
  const essays = await listEssaysForCase(caseId, { now }, db);
  for (const essay of essays) {
    if (essay.effectiveStage === "final") continue;
    if (essay.deadline === null || essay.deadline > essayHorizonKey) continue;
    const staleEnough =
      essay.stalenessDays === null || essay.stalenessDays >= ESSAY_NUDGE_MIN_STALENESS_DAYS;
    if (!staleEnough) continue;
    const anchor = `essay:${essay.id}`;
    if (seenAnchors.has(anchor)) continue;
    seenAnchors.add(anchor);
    actions.push({
      kind: "essay",
      title: `Update essay: ${clipPrompt(essay.prompt)}`,
      dueDate: essay.deadline,
      overdue: essay.deadline < todayKey,
      anchor,
    });
  }

  // 3. Unsubmitted-section nudges (definition display order).
  const sections = await listSectionStates(caseId, db);
  for (const section of sections) {
    if (section.state !== "draft") continue;
    actions.push({
      kind: "section",
      title: `Complete section: ${section.title}`,
      dueDate: null,
      overdue: false,
      anchor: `section:${section.sectionKey}`,
    });
  }

  return actions.slice(0, limit);
}

// ── Season-scoped phase progress (CM-120) ───────────────────────────────

/** One phase's progress ring (checklists.ts rollup + phase identity). */
export interface AdmissionsPhaseProgress extends AdmissionsChecklistProgress {
  phase: AdmissionsPhaseKey;
  label: string;
}

/** getPhaseProgress options. */
export interface GetPhaseProgressOptions {
  /** Season-relevance reference instant; defaults to the current time. */
  now?: Date;
}

/** Graduation is assumed June of the cohort's graduationYear (month 6). */
const GRADUATION_MONTH = 6;

/**
 * Season unlock thresholds (documented month heuristic): a phase becomes
 * relevant once `monthsUntilGraduation` (June of the cohort's graduation
 * year, Bangkok calendar) drops to the listed value. Phases absent from
 * this map are always relevant.
 *
 * - applications: 10 → August of senior year
 * - decisions_aid: 6 → December of senior year
 * - transition: 3 → March of the graduation year (senior spring)
 */
export const PHASE_SEASON_UNLOCK_MONTHS: Partial<Record<AdmissionsPhaseKey, number>> = {
  applications: 10,
  decisions_aid: 6,
  transition: 3,
};

/**
 * True when `phase` is season-relevant for a cohort graduating in June of
 * `graduationYear` at instant `now` (Bangkok calendar). Phases without an
 * unlock threshold are always relevant; past graduation everything is
 * relevant (monthsUntilGraduation goes negative).
 */
export function isPhaseSeasonRelevant(
  phase: AdmissionsPhaseKey,
  graduationYear: number,
  now: Date,
): boolean {
  const threshold = PHASE_SEASON_UNLOCK_MONTHS[phase];
  if (threshold === undefined) return true;
  const { year, month } = getBangkokYearMonth(now);
  const monthsUntilGraduation = (graduationYear - year) * 12 + (GRADUATION_MONTH - month);
  return monthsUntilGraduation <= threshold;
}

/**
 * Per-phase checklist progress for the student home's rings (CM-120),
 * scoped to season-relevant phases.
 *
 * 1. Resolve the case's cohort graduationYear (missing/soft-deleted case →
 *    NotFound).
 * 2. Roll up the case's live tasks per canonical phase via checklists.ts's
 *    computeProgressCounts. Tasks on non-canonical phases (e.g. the "custom"
 *    meeting-action-item phase) are excluded from the rings — they still
 *    count in the global CM-24 rollup, which lives on staff/parent views.
 * 3. Keep phases that have at least one task AND are season-relevant per
 *    isPhaseSeasonRelevant (e.g. Transition is hidden before senior spring).
 *
 * @returns phase rings in canonical phase order.
 */
export async function getPhaseProgress(
  caseId: string,
  options: GetPhaseProgressOptions = {},
  db: Database = getDb(),
): Promise<AdmissionsPhaseProgress[]> {
  if (!isUuidShaped(caseId)) throw new Error("NotFound");
  const now = options.now ?? new Date();

  const caseRows = await db
    .select({ graduationYear: admissionsCohorts.graduationYear })
    .from(admissionsCases)
    .innerJoin(admissionsCohorts, eq(admissionsCases.cohortId, admissionsCohorts.id))
    .where(and(eq(admissionsCases.id, caseId), isNull(admissionsCases.deletedAt)))
    .limit(1);
  const caseRow = caseRows[0];
  if (!caseRow) throw new Error("NotFound");

  const taskRows = await db
    .select({
      phase: admissionsCaseTasks.phase,
      status: admissionsCaseTasks.status,
      verifiedAt: admissionsCaseTasks.verifiedAt,
    })
    .from(admissionsCaseTasks)
    .where(and(
      eq(admissionsCaseTasks.caseId, caseId),
      isNull(admissionsCaseTasks.deletedAt),
    ));

  const rowsByPhase = new Map<AdmissionsPhaseKey, Array<{ status: string; verifiedAt: Date | null }>>();
  for (const row of taskRows) {
    if (!isAdmissionsPhaseKey(row.phase)) continue;
    const list = rowsByPhase.get(row.phase);
    if (list) list.push(row);
    else rowsByPhase.set(row.phase, [row]);
  }

  const rings: AdmissionsPhaseProgress[] = [];
  for (const { key, label } of ADMISSIONS_CHECKLIST_PHASES) {
    const rows = rowsByPhase.get(key);
    if (!rows || rows.length === 0) continue;
    if (!isPhaseSeasonRelevant(key, caseRow.graduationYear, now)) continue;
    rings.push({ phase: key, label, ...computeProgressCounts(rows) });
  }
  return rings;
}

// ── Internal helpers ────────────────────────────────────────────────────

/**
 * Asia/Bangkok calendar date ("YYYY-MM-DD") for an instant (mirrors the
 * private helper in calendar.ts / essays.ts).
 */
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

/** Asia/Bangkok calendar year + month (1–12) for an instant. */
function getBangkokYearMonth(now: Date): { year: number; month: number } {
  const key = getBangkokDateKey(now);
  return { year: Number(key.slice(0, 4)), month: Number(key.slice(5, 7)) };
}

/** Trims and clips an essay prompt for the nudge title ("…" past 60 chars). */
function clipPrompt(prompt: string): string {
  const trimmed = prompt.trim();
  return trimmed.length > ESSAY_NUDGE_MAX_PROMPT_LENGTH
    ? `${trimmed.slice(0, ESSAY_NUDGE_MAX_PROMPT_LENGTH - 1)}…`
    : trimmed;
}
