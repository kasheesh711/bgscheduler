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
/** The ids that stood ahead of a dragged candidate, in order, so the place survives when some of them leave the queue. */
export type ManualPlace = { ahead: string[]; movedAt: string };
export type ScoreOverride = { score: number; reason: string; by: string; at: string };
export type QueueEntry = { id: string; subject: Subject; score: number; createdAt: Date; manual?: ManualPlace | null };

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

/**
 * Puts dragged rows back after the automatic rank, oldest drag first, so the latest drag wins. A dragged row goes right
 * after the last person still queued who stood ahead of it. When all of those have left, it goes before the first row that
 * was already here at the drag, or last if none was, so a later arrival does not fall behind someone a person put at the
 * back. A drag to the front has nobody ahead, so it stays first. A new arrival has no drag, so it takes its automatic place
 * among the undragged rows.
 */
export function mergeManualOrder(ranked: QueueEntry[]): QueueEntry[] {
  const out = ranked.filter((row) => !row.manual);
  const moved = ranked
    .filter((row) => row.manual)
    .sort((a, b) => a.manual!.movedAt.localeCompare(b.manual!.movedAt));
  for (const row of moved) {
    const { ahead, movedAt } = row.manual!;
    const anchor = Math.max(-1, ...ahead.map((id) => out.findIndex((other) => other.id === id)));
    if (anchor >= 0 || !ahead.length) {
      out.splice(anchor + 1, 0, row);
      continue;
    }
    const older = out.findIndex((other) => other.createdAt <= new Date(movedAt));
    out.splice(older === -1 ? out.length : older, 0, row);
  }
  return out;
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
  /** Every row in walk order, released or held. The screen numbers the queue from this. */
  order: string[];
} {
  const hiring = new Set(config.subjectPriority.filter((p) => p.hiring).map((p) => p.subject));
  const used: LimitUsage = { ...usage, bySubject: { ...usage.bySubject } };
  const release: QueueEntry[] = [];
  const held: (QueueEntry & { position: number; limit: LimitName })[] = [];
  const automatic = rankQueue(
    entries.filter((e) => hiring.has(e.subject)),
    config.subjectPriority,
  );
  // Only the pre-screen queue can be dragged.
  const ranked = funnel === "pre_screen" ? mergeManualOrder(automatic) : automatic;
  for (const [index, row] of ranked.entries()) {
    const limit = blockingLimit(funnel, row.subject, used, config);
    if (limit) {
      held.push({ ...row, position: index + 1, limit });
      continue;
    }
    release.push(row);
    used.perDay++;
    used.perWeek++;
    if (funnel === "pre_screen") used.waiting++;
    else used.unbooked++;
    used.bySubject[row.subject] = (used.bySubject[row.subject] ?? 0) + 1;
  }
  return { release, held, order: ranked.map((row) => row.id) };
}

/** Where one candidate stands in a queue after `releaseQueue`: next to send, or held by the named limit. */
export type QueueHold = {
  funnel: Funnel;
  state: "next" | "held";
  /** Place in that queue, counting released rows too, so it matches the numbered list. 0 when the row is next to send. */
  position: number;
  limit: LimitName | null;
  subject: Subject;
};

export type Meter = { label: string; used: number; max: number; over: number; pct: number; full: boolean };
const meter = (label: string, used: number, max: number): Meter => ({
  label,
  used,
  max,
  // Use can pass a limit that was lowered afterwards. The screen says how far over, not "17 of 12".
  over: Math.max(0, used - max),
  // A limit of 0 is closed, so it reads as full.
  pct: max ? Math.min(100, Math.round((used / max) * 100)) : 100,
  full: used >= max,
});
/** Subjects that hold a place, in the order Kevin ranked them. */
const subjectMeters = (bySubject: LimitUsage["bySubject"], max: number, config: HiringConfig) => {
  const order = config.subjectPriority.map((p) => p.subject);
  return (Object.keys(bySubject) as Subject[])
    .filter((subject) => (bySubject[subject] ?? 0) > 0)
    .sort((a, b) => (order.indexOf(a) + 1 || 99) - (order.indexOf(b) + 1 || 99) || a.localeCompare(b))
    .map((subject) => meter(`${subject} open`, bySubject[subject]!, max));
};

export function preScreenMeters(usage: LimitUsage, config: HiringConfig): Meter[] {
  const limits = config.preScreenLimits;
  return [
    meter("Sent today", usage.perDay, limits.perDay),
    meter("Sent this week", usage.perWeek, limits.perWeek),
    meter("Waiting for reply", usage.waiting, limits.waiting),
    ...subjectMeters(usage.bySubject, limits.perSubject, config),
  ];
}

export function onsiteMeters(
  usage: LimitUsage,
  headMocks: Record<string, number>,
  config: HiringConfig,
  names: Record<string, string> = {},
): Meter[] {
  const limits = config.onsiteLimits;
  return [
    meter("Invited this week", usage.perWeek, limits.perWeek),
    meter("Not booked", usage.unbooked, limits.unbooked),
    ...config.interviewers.map((head) =>
      meter(`${names[head.canonicalKey] ?? head.canonicalKey} this week`, headMocks[head.canonicalKey] ?? 0, limits.perHeadPerWeek),
    ),
    ...subjectMeters(usage.bySubject, limits.perSubject, config),
  ];
}

/** Confirmed mocks per head in the Bangkok week that holds `now`. Old-flow and visit mocks both use the head's hour. */
export function headWeekMocks(
  bookings: { kind: string; status: string; interviewerKey: string | null; startTime: Date }[],
  now: Date,
): Record<string, number> {
  const start = bangkokWeekStart(now).getTime();
  const end = start + 7 * 86400000;
  const counts: Record<string, number> = {};
  for (const b of bookings) {
    const at = b.startTime.getTime();
    if (b.kind === "mock" && b.status === "confirmed" && b.interviewerKey && at >= start && at < end)
      counts[b.interviewerKey] = (counts[b.interviewerKey] ?? 0) + 1;
  }
  return counts;
}
