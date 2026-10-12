import { and, eq, gte, isNotNull, sql } from "drizzle-orm";
import { getDb, type Database } from "@/lib/db";
import * as schema from "@/lib/db/schema";
import { AUTOWRITER_PAIR_THAI_MIN_MEDIAN_SHARE, AUTOWRITER_ZOOM_ENGLISH_MAX_THAI_SHARE } from "./config";
import { isMissingRelationError } from "./db-errors";
import { AUTOWRITER_ROSTER } from "./roster";
import { median } from "./trends";

const S = schema.feedbackAutowriterSessions;
const R = schema.feedbackAutowriterRosterAccounts;
const P = schema.feedbackAutowriterPairLanguages;

export const PAIR_LANGUAGES = ["english", "bilingual", "thai"] as const;
export type PairLanguage = (typeof PAIR_LANGUAGES)[number];
export type AutoPairLanguage = PairLanguage | "unknown";

export const PAIR_LANGUAGE_LOOKBACK_DAYS = 90;
const DAY_MS = 24 * 60 * 60 * 1000;
/** The code roster, as routing uses it (`rosterAccountIds`): a new account maps at once, before the review job records it. */
const ROSTER_TUTOR_KEY = new Map(AUTOWRITER_ROSTER.map((tutor) => [tutor.wiseUserId, tutor.canonicalKey]));

export interface PairLessonRow {
  wiseClassId: string;
  tutorKey: string;
  className: string | null;
  source: string;
  thaiShare: string | number | null;
  endedAt: Date | null;
}

export interface PairOverrideRow {
  wiseClassId: string;
  tutorKey: string;
  language: PairLanguage;
}

export interface PairLanguageRow {
  wiseClassId: string;
  tutorKey: string;
  className: string | null;
  /** Soniox transcripts with a Thai share. */
  lessons: number;
  /** Lessons written from Zoom's captions (display only; their shares are not evidence of the mix). */
  zoomLessons: number;
  medianThaiShare: number | null;
  maxThaiShare: number | null;
  lastLessonAt: string | null;
  auto: AutoPairLanguage;
  override: PairLanguage | null;
  effective: AutoPairLanguage;
}

export interface PairLanguages {
  overridesAvailable: boolean;
  lookbackDays: number;
  englishMaxThaiShare: number;
  thaiMinMedianShare: number;
  pairs: PairLanguageRow[];
}

/**
 * The automatic language of a pair from its Soniox transcripts' Thai shares: unknown without any; English when every
 * share is under the Zoom-English bar (0.03); Thai when the median is at least 0.30; otherwise bilingual.
 */
export function classifyPairLanguage(shares: readonly number[]): AutoPairLanguage {
  if (shares.length === 0) return "unknown";
  if (shares.every((share) => share < AUTOWRITER_ZOOM_ENGLISH_MAX_THAI_SHARE)) return "english";
  const valid = shares.filter(Number.isFinite);
  return valid.length > 0 && median(valid)! >= AUTOWRITER_PAIR_THAI_MIN_MEDIAN_SHARE ? "thai" : "bilingual";
}

/**
 * Pure: group lesson rows by (class, tutor), classify each pair and merge the owner overrides (an override without
 * lessons still yields a row). Sorted by tutor, then class name (or the class id when it has none).
 */
export function buildPairLanguages(lessons: readonly PairLessonRow[], overrides: readonly PairOverrideRow[]): PairLanguageRow[] {
  interface Group { wiseClassId: string; tutorKey: string; shares: number[]; zoomLessons: number; className: string | null; classNameAt: number; lastAt: number | null; override: PairLanguage | null }
  const groups = new Map<string, Group>();
  const groupOf = (wiseClassId: string, tutorKey: string): Group => {
    const key = `${wiseClassId}\u0000${tutorKey}`;
    let group = groups.get(key);
    if (!group) {
      group = { wiseClassId, tutorKey, shares: [], zoomLessons: 0, className: null, classNameAt: -Infinity, lastAt: null, override: null };
      groups.set(key, group);
    }
    return group;
  };

  for (const row of lessons) {
    const group = groupOf(row.wiseClassId, row.tutorKey);
    const at = row.endedAt ? row.endedAt.getTime() : -Infinity;
    if (row.source === "zoom") group.zoomLessons += 1;
    // A share that is not a number stays in: like the Zoom-English check, it keeps the pair from reading English.
    else if (row.thaiShare !== null) group.shares.push(Number(row.thaiShare));
    if (row.className && at >= group.classNameAt) {
      group.className = row.className;
      group.classNameAt = at;
    }
    if (row.endedAt && (group.lastAt === null || at > group.lastAt)) group.lastAt = at;
  }
  for (const override of overrides) groupOf(override.wiseClassId, override.tutorKey).override = override.language;

  return [...groups.values()]
    .map((group): PairLanguageRow => {
      const auto = classifyPairLanguage(group.shares);
      const valid = group.shares.filter(Number.isFinite);
      return {
        wiseClassId: group.wiseClassId,
        tutorKey: group.tutorKey,
        className: group.className,
        lessons: group.shares.length,
        zoomLessons: group.zoomLessons,
        medianThaiShare: median(valid),
        maxThaiShare: valid.length ? Math.max(...valid) : null,
        lastLessonAt: group.lastAt === null ? null : new Date(group.lastAt).toISOString(),
        auto,
        override: group.override,
        effective: group.override ?? auto,
      };
    })
    .sort((a, b) => a.tutorKey.localeCompare(b.tutorKey) || (a.className ?? a.wiseClassId).localeCompare(b.className ?? b.wiseClassId));
}

/**
 * Every (class, tutor) pair with transcribed lessons in the last 90 days, labelled English / Bilingual / Thai /
 * Unknown, with the owner's overrides. Display only: routing (job.ts) does not read these labels. One tutor's several
 * Wise accounts collapse into one tutor_key (`feedback_autowriter_roster_accounts`); unmapped accounts fall back to the
 * Wise teacher id. Uses the Zoom-English check's filters (no too-short transcripts, Soniox shares only); Zoom-captioned
 * lessons are counted for display. Before migration 0116 the overrides are absent (`overridesAvailable: false`).
 */
export async function loadPairLanguages(db: Database = getDb(), now: Date = new Date()): Promise<PairLanguages> {
  const since = new Date(now.getTime() - PAIR_LANGUAGE_LOOKBACK_DAYS * DAY_MS);
  const lessons = await db.select({
    wiseClassId: sql<string>`${S.wiseClassId}`,
    wiseTeacherUserId: sql<string>`${S.wiseTeacherUserId}`,
    tutorKey: sql<string>`coalesce(${R.tutorKey}, ${S.wiseTeacherUserId})`,
    className: sql<string | null>`${S.metadata} ->> 'className'`,
    source: sql<string>`coalesce(${S.metadata} -> 'transcript' ->> 'source', 'soniox')`,
    thaiShare: sql<string | null>`${S.metadata} -> 'transcript' ->> 'thaiShare'`,
    endedAt: S.scheduledEndAt,
  }).from(S).leftJoin(R, eq(R.wiseTeacherUserId, S.wiseTeacherUserId)).where(and(
    isNotNull(S.wiseClassId),
    isNotNull(S.wiseTeacherUserId),
    gte(S.scheduledEndAt, since),
    // A transcript too short to write from is no evidence of how the class talks.
    sql`coalesce(${S.reason}, '') not in ('recording_too_short', 'transcript_too_short')`,
    sql`(${S.metadata} -> 'transcript' ->> 'thaiShare' is not null or ${S.metadata} -> 'transcript' ->> 'source' = 'zoom')`,
  ));

  let overrides: PairOverrideRow[] = [];
  let overridesAvailable = true;
  try {
    overrides = await db.select({ wiseClassId: P.wiseClassId, tutorKey: P.tutorKey, language: P.language }).from(P);
  } catch (error) {
    if (!isMissingRelationError(error)) throw error;
    overridesAvailable = false;
  }

  return {
    overridesAvailable,
    lookbackDays: PAIR_LANGUAGE_LOOKBACK_DAYS,
    englishMaxThaiShare: AUTOWRITER_ZOOM_ENGLISH_MAX_THAI_SHARE,
    thaiMinMedianShare: AUTOWRITER_PAIR_THAI_MIN_MEDIAN_SHARE,
    pairs: buildPairLanguages(
      lessons.map(({ wiseTeacherUserId, ...row }) => ({ ...row, tutorKey: ROSTER_TUTOR_KEY.get(wiseTeacherUserId) ?? row.tutorKey })),
      overrides,
    ),
  };
}

/** Store (or replace) the owner's language for a pair. Errors propagate (the route maps a missing table to 409). */
export async function setPairLanguageOverride(
  input: { wiseClassId: string; tutorKey: string; language: PairLanguage; setBy: string },
  db: Database = getDb(),
): Promise<void> {
  await db.insert(P).values(input).onConflictDoUpdate({
    target: [P.wiseClassId, P.tutorKey],
    set: { language: input.language, setBy: input.setBy, setAt: sql`now()` },
  });
}

/** Remove the owner's language for a pair (back to automatic); true when a row was deleted. */
export async function clearPairLanguageOverride(
  input: { wiseClassId: string; tutorKey: string },
  db: Database = getDb(),
): Promise<boolean> {
  const rows = await db.delete(P)
    .where(and(eq(P.wiseClassId, input.wiseClassId), eq(P.tutorKey, input.tutorKey)))
    .returning({ tutorKey: P.tutorKey });
  return rows.length > 0;
}
