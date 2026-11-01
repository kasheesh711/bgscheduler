import { formatInTimeZone, fromZonedTime } from "date-fns-tz";
import { ZONE, localDate, type HiringConfig, type Subject } from "./model";

export type Funnel = "pre_screen" | "onsite";
export type LimitName = "perDay" | "perWeek" | "waiting" | "unbooked" | "perSubject";
export type LimitUsage = {
  perDay: number;
  perWeek: number;
  waiting: number;
  unbooked: number;
  bySubject: Partial<Record<Subject, number>>;
};
export type QueueEntry = { id: string; subject: Subject; score: number; createdAt: Date };

/** Midnight in Bangkok for the day that holds `now`. Bangkok has no daylight saving. */
export function bangkokDayStart(now: Date): Date {
  return fromZonedTime(`${localDate(now)}T00:00:00`, ZONE);
}

/** Monday 00:00 in Bangkok for the week that holds `now`. */
export function bangkokWeekStart(now: Date): Date {
  const monday = new Date(`${localDate(now)}T12:00:00Z`);
  monday.setUTCDate(monday.getUTCDate() - (Number(formatInTimeZone(now, ZONE, "i")) - 1));
  return fromZonedTime(`${monday.toISOString().slice(0, 10)}T00:00:00`, ZONE);
}

/** Subject rank, then higher score, then earlier application, then id. A subject missing from the list ranks last. */
export function rankQueue(
  entries: QueueEntry[],
  priority: HiringConfig["subjectPriority"],
): QueueEntry[] {
  const rank = (subject: Subject) => {
    const index = priority.findIndex((p) => p.subject === subject);
    return index === -1 ? Number.MAX_SAFE_INTEGER : index;
  };
  return [...entries].sort(
    (a, b) =>
      rank(a.subject) - rank(b.subject) ||
      b.score - a.score ||
      a.createdAt.getTime() - b.createdAt.getTime() ||
      (a.id < b.id ? -1 : a.id > b.id ? 1 : 0),
  );
}

/** The first limit that is used up for this funnel and subject. A limit the funnel does not have never blocks. */
export function blockingLimit(
  funnel: Funnel,
  subject: Subject,
  usage: LimitUsage,
  config: HiringConfig,
): LimitName | null {
  const checks: [LimitName, number, number][] =
    funnel === "pre_screen"
      ? [
          ["perDay", usage.perDay, config.preScreenLimits.perDay],
          ["perWeek", usage.perWeek, config.preScreenLimits.perWeek],
          ["waiting", usage.waiting, config.preScreenLimits.waiting],
          ["perSubject", usage.bySubject[subject] ?? 0, config.preScreenLimits.perSubject],
        ]
      : [
          ["perWeek", usage.perWeek, config.onsiteLimits.perWeek],
          ["unbooked", usage.unbooked, config.onsiteLimits.unbooked],
          ["perSubject", usage.bySubject[subject] ?? 0, config.onsiteLimits.perSubject],
        ];
  return checks.find(([, used, max]) => used >= max)?.[0] ?? null;
}

/** Walks the ranked queue and releases a row only while every limit has room. Not-hiring subjects are left out. */
export function releaseQueue(
  funnel: Funnel,
  entries: QueueEntry[],
  usage: LimitUsage,
  config: HiringConfig,
): {
  release: QueueEntry[];
  held: (QueueEntry & { position: number; limit: LimitName })[];
} {
  const hiring = new Set(config.subjectPriority.filter((p) => p.hiring).map((p) => p.subject));
  const used: LimitUsage = { ...usage, bySubject: { ...usage.bySubject } };
  const release: QueueEntry[] = [];
  const held: (QueueEntry & { position: number; limit: LimitName })[] = [];
  for (const row of rankQueue(
    entries.filter((e) => hiring.has(e.subject)),
    config.subjectPriority,
  )) {
    const limit = blockingLimit(funnel, row.subject, used, config);
    if (limit) {
      held.push({ ...row, position: held.length + 1, limit });
      continue;
    }
    release.push(row);
    used.perDay++;
    used.perWeek++;
    if (funnel === "pre_screen") used.waiting++;
    else used.unbooked++;
    used.bySubject[row.subject] = (used.bySubject[row.subject] ?? 0) + 1;
  }
  return { release, held };
}
