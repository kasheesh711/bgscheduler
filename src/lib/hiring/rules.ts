import { applicableSchedule, type Week } from "@/lib/tutor-attendance/model";
import { configRuleErrors, localDate, SUBJECTS, VISIT_LINK_DAYS, type HiringConfig } from "./model";
import { answerKey, workRightsPenalty } from "./scoring";

/**
 * Pure helpers for the Rules and setup screen. The screen calls these, and the tests call them,
 * because the repo has no DOM test library to click with.
 */

type Funnel = "pre" | "on";
export type LimitField = {
  id: string;
  funnel: Funnel;
  label: string;
  min: number;
  max: number;
  get: (c: HiringConfig) => number;
  set: (c: HiringConfig, n: number) => HiringConfig;
};
const limit = (
  id: string,
  funnel: Funnel,
  label: string,
  key: "preScreenLimits" | "onsiteLimits",
  name: string,
): LimitField => ({
  id,
  funnel,
  label,
  min: 0,
  max: 1000,
  get: (c) => (c[key] as Record<string, number>)[name],
  set: (c, n) => ({ ...c, [key]: { ...c[key], [name]: n } }),
});
const followUp = (
  id: string,
  funnel: Funnel,
  label: string,
  key: "preScreenFollowUp" | "onsiteFollowUp",
  name: "remindDays" | "expireDays",
  max: number,
): LimitField => ({
  id,
  funnel,
  label,
  min: 1,
  max,
  get: (c) => c[key][name],
  set: (c, n) => ({ ...c, [key]: { ...c[key], [name]: n } }),
});
/** Every number on the two rule cards, in screen order. */
export const LIMIT_FIELDS: LimitField[] = [
  limit("pre.perDay", "pre", "Maximum sent each day", "preScreenLimits", "perDay"),
  limit("pre.perWeek", "pre", "Maximum sent each week", "preScreenLimits", "perWeek"),
  limit("pre.waiting", "pre", "Maximum waiting for reply", "preScreenLimits", "waiting"),
  limit("pre.perSubject", "pre", "Maximum open per subject", "preScreenLimits", "perSubject"),
  followUp("pre.remindDays", "pre", "Send reminder after (days)", "preScreenFollowUp", "remindDays", 60),
  followUp("pre.expireDays", "pre", "Mark no reply after (days)", "preScreenFollowUp", "expireDays", 120),
  limit("on.perWeek", "on", "Maximum invited each week", "onsiteLimits", "perWeek"),
  limit("on.unbooked", "on", "Maximum invited, not booked", "onsiteLimits", "unbooked"),
  limit("on.perHeadPerWeek", "on", "Maximum mocks per head each week", "onsiteLimits", "perHeadPerWeek"),
  limit("on.perSubject", "on", "Maximum open per subject", "onsiteLimits", "perSubject"),
  followUp("on.remindDays", "on", "Send reminder after (days)", "onsiteFollowUp", "remindDays", 60),
  followUp("on.expireDays", "on", "Expire the link after (days)", "onsiteFollowUp", "expireDays", VISIT_LINK_DAYS),
];
export const setLimit = (config: HiringConfig, id: string, n: number) =>
  LIMIT_FIELDS.find((f) => f.id === id)!.set(config, n);

/**
 * What would stop a save, in words, beyond the profile weight total that the save bar already shows.
 * The screen shows these and disables Save; the server checks the same rules.
 */
export function settingsProblems(config: HiringConfig): string[] {
  const problems: string[] = [];
  for (const f of LIMIT_FIELDS) {
    const n = f.get(config);
    if (!Number.isInteger(n) || n < f.min || n > f.max)
      problems.push(`${f.label}: use a whole number from ${f.min} to ${f.max}.`);
  }
  const t = config.preScreenThreshold;
  if (t !== null && (!Number.isInteger(t) || t < 0 || t > 100))
    problems.push("Pre-screen pass score: use a whole number from 0 to 100, or leave it empty.");
  if (!Number.isInteger(config.resumeRetentionMonths) || config.resumeRetentionMonths < 1 || config.resumeRetentionMonths > 120)
    problems.push("Résumé files: use a whole number of months from 1 to 120.");
  const whole = (n: number, min: number, max: number) => Number.isInteger(n) && n >= min && n <= max;
  for (const [key, label] of Object.entries(PROFILE_WEIGHT_LABELS))
    if (!whole(config.profileWeights[key as keyof typeof PROFILE_WEIGHT_LABELS], 0, 100))
      problems.push(`${label}: use a whole number from 0 to 100.`);
  for (const [key, label] of Object.entries(PRE_SCREEN_WEIGHT_LABELS))
    if (!whole(config.preScreenWeights[key as keyof typeof PRE_SCREEN_WEIGHT_LABELS], 0, 100))
      problems.push(`Pre-screen ${label.toLowerCase()}: use a whole number from 0 to 100.`);
  if (config.workRightsPenalties?.some((p) => !whole(p.points, 1, 100)))
    problems.push("Work-rights points off: use a whole number from 0 to 100.");
  if (!whole(config.profileThreshold, 0, 100)) problems.push("Invitation threshold: use a whole number from 0 to 100.");
  const total = Object.values(config.preScreenWeights).reduce((n, w) => n + w, 0);
  if (total !== 100) problems.push(`Pre-screen weights total ${total}. They must total 100.`);
  for (const e of configRuleErrors(config)) problems.push(e.message);
  return problems;
}

export const PROFILE_WEIGHT_LABELS = {
  degree: "Degree relevance",
  subject: "Subject evidence",
  curriculum: "Curriculum experience",
  teaching: "Teaching experience",
  english: "English evidence",
  prestige: "University prestige",
  school: "High school",
};
export const PRE_SCREEN_WEIGHT_LABELS = {
  degree: "Degree",
  subject: "Subject",
  curriculum: "Curriculum",
  teaching: "Teaching",
  english: "English",
  prestige: "University prestige",
  written: "Written answers",
  availability: "Availability",
};

export const minutesToTime = (minute: number) => {
  // A time field cannot show 24:00, so the last minute of the day stands in for it.
  const m = Math.min(minute, 1439);
  return `${String(Math.floor(m / 60)).padStart(2, "0")}:${String(m % 60).padStart(2, "0")}`;
};
export const timeToMinutes = (time: string) => {
  const m = /^(\d{2}):(\d{2})$/.exec(time);
  return m ? Number(m[1]) * 60 + Number(m[2]) : null;
};

type Priority = HiringConfig["subjectPriority"];
/** A subject listed twice keeps its first entry. The server refuses duplicates, so the screen drops them to let a save repair the list. */
export const dedupePriority = (list: Priority): Priority =>
  list.filter((p, i) => list.findIndex((q) => q.subject === p.subject) === i);
/** The saved order, then every subject missing from it as not hiring. A missing subject is not hiring in the queue, too. */
export const fullPriority = (list: Priority): Priority => {
  const clean = dedupePriority(list);
  return [...clean, ...SUBJECTS.filter((s) => !clean.some((p) => p.subject === s)).map((subject) => ({ subject, hiring: false }))];
};
export function movePriority(list: Priority, index: number, delta: -1 | 1): Priority {
  const to = index + delta;
  if (to < 0 || to >= list.length) return list;
  const next = [...list];
  [next[index], next[to]] = [next[to], next[index]];
  return next;
}
export const setHiring = (list: Priority, index: number, hiring: boolean): Priority =>
  list.map((p, i) => (i === index ? { ...p, hiring } : p));

/** Every answer the settings know, accepted or only seen, once each. A new answer from SEEK starts unticked. */
export function workRightsRows(config: HiringConfig): { answer: string; accepted: boolean; penalty: number }[] {
  const accepted = new Set(config.acceptedWorkRights.map(answerKey));
  const seen = new Set<string>();
  return [...config.acceptedWorkRights, ...config.seenWorkRights].flatMap((answer) => {
    const key = answerKey(answer);
    if (seen.has(key)) return [];
    seen.add(key);
    return [{ answer, accepted: accepted.has(key), penalty: workRightsPenalty(answer, config) }];
  });
}
export function setWorkRightsAccepted(config: HiringConfig, answer: string, on: boolean): HiringConfig {
  const key = answerKey(answer);
  const rest = config.acceptedWorkRights.filter((a) => answerKey(a) !== key);
  // An unticked answer must stay on the list so it can be ticked again, so record it as seen. The schema holds 200.
  const seen = config.seenWorkRights;
  const remember = !on && !seen.some((a) => answerKey(a) === key) && seen.length < 200;
  return {
    // An answer that is not accepted keeps no hidden penalty.
    ...(on ? config : setWorkRightsPenalty(config, answer, 0)),
    acceptedWorkRights: on ? [...rest, answer] : rest,
    seenWorkRights: remember ? [...seen, answer] : seen,
  };
}

/** 0 removes the row. Any other value replaces it. */
export function setWorkRightsPenalty(config: HiringConfig, answer: string, points: number): HiringConfig {
  const rest = (config.workRightsPenalties ?? []).filter((p) => answerKey(p.answer) !== answerKey(answer));
  const next = points ? [...rest, { answer, points }] : rest;
  // No rows: no key, so settings with no penalty stay readable by older code.
  return { ...config, workRightsPenalties: next.length ? next : undefined };
}

export const HEAD_DAYS = ["Mon", "Tue", "Wed", "Thu", "Fri"] as const;
export const DEFAULT_WINDOW = { start: "10:00", end: "16:00" };
// Tito's mock teaching week is managed in Hiring. His attendance week also covers other duties.
export function hiringMockWeek(head: { canonicalKey?: string; fallbackWeek?: Week }): Week | undefined {
  if (head.canonicalKey !== "Tito") return undefined;
  return head.fallbackWeek ?? [null, null, DEFAULT_WINDOW, null, DEFAULT_WINDOW, DEFAULT_WINDOW, null];
}
export type HeadDayState = {
  /**
   * `fallback`: no attendance record, hours live in Hiring settings. `ended`: the attendance enrollment is switched off.
   * `wise`: no attendance record, hours are the head's onsite Wise working hours.
   */
  state: "enrolled" | "ended" | "fallback" | "wise";
  week: Week | null;
  /** The date the newest saved schedule starts. Null for a fallback head. */
  from: string | null;
};
/** Monday to Friday as ticks. An attendance week starts on Sunday, so Monday is index 1. */
export const daysOf = (week: Week | null | undefined) => HEAD_DAYS.map((_, i) => !!week?.[i + 1]);
/** The week after ticking Monday to Friday. Saved hours stay, a new day gets the default hours, the weekend is untouched. */
export function weekWith(days: boolean[], current: Week | null | undefined): Week {
  const base: Week = current ?? (Array(7).fill(null) as Week);
  return base.map((window, i) => (i >= 1 && i <= 5 ? (days[i - 1] ? (window ?? DEFAULT_WINDOW) : null) : window));
}
/** A head with no weekday hours gets no visit times. Visits are Monday to Friday only. */
export const hasSavedHours = (week: Week | null | undefined) => daysOf(week).some(Boolean);
type WiseWindow = { weekday: number; startMinute: number; endMinute: number; modality: string };
const clock = (minute: number) => `${String(Math.floor(minute / 60)).padStart(2, "0")}:${String(minute % 60).padStart(2, "0")}`;
/**
 * Onsite Wise working hours as a week (index 0 is Sunday, as in Wise windows). Mocks are in person, so online
 * windows do not count. A week holds one window a day: with two onsite windows on a day the longer one is used,
 * so a mock never falls in the gap between them.
 */
export function wiseWeek(windows: WiseWindow[]): Week {
  const longest: (WiseWindow | undefined)[] = [];
  for (const w of windows) {
    if (w.modality !== "onsite" || !(w.weekday >= 0 && w.weekday <= 6) || !Number.isFinite(w.startMinute) || !(w.endMinute > w.startMinute)) continue;
    const best = longest[w.weekday];
    const gain = best ? w.endMinute - w.startMinute - (best.endMinute - best.startMinute) : 1;
    // Equal lengths: the earlier window wins, so the screen and the slot check agree whatever the row order.
    if (gain > 0 || (gain === 0 && w.startMinute < best!.startMinute)) longest[w.weekday] = w;
  }
  return Array.from({ length: 7 }, (_, i) => {
    const w = longest[i];
    // A window to midnight ends at 23:59, the last time a saved week can hold.
    return w ? { start: clock(w.startMinute), end: clock(Math.min(w.endMinute, 1439)) } : null;
  });
}
/**
 * The head as the hour checks see it. A head set to use Wise hours gets its onsite Wise week as its fallback week;
 * no Wise data gives no hours. An enrolled head still follows Tutor Attendance, which ignores the fallback week.
 */
export const withWiseHours = <H extends { canonicalKey?: string; hoursFromWise?: boolean; fallbackWeek?: Week }>(
  head: H,
  windows: WiseWindow[] | null | undefined,
): H => (head.hoursFromWise && !hiringMockWeek(head) ? { ...head, fallbackWeek: windows ? wiseWeek(windows) : undefined } : head);

/** The newest saved schedule counts, even one that starts tomorrow, so the screen shows what was last saved. */
export function headDayState(
  head: { canonicalKey: string; fallbackWeek?: Week; hoursFromWise?: boolean },
  enrollments: { canonicalKey: string; active: boolean; endDate?: string | null }[],
  schedules: { id: string; canonicalKey: string; effectiveFrom: string; week: Week; revision: number }[],
  today = localDate(new Date()),
  wiseWindows?: WiseWindow[],
): HeadDayState {
  const enrollment = enrollments.find((e) => e.canonicalKey === head.canonicalKey);
  const mockWeek = hiringMockWeek(head);
  if (mockWeek && (!enrollment || (enrollment.active && (!enrollment.endDate || enrollment.endDate >= today))))
    return { state: "fallback", week: mockWeek, from: null };
  if (!enrollment && head.hoursFromWise)
    return { state: "wise", week: withWiseHours(head, wiseWindows).fallbackWeek ?? null, from: null };
  if (!enrollment) return { state: "fallback", week: head.fallbackWeek ?? null, from: null };
  const version = applicableSchedule("9999-12-31", head.canonicalKey, schedules);
  // headOfficeWindow gives no hours after the end date, so a past end date is ended too.
  const ended = !enrollment.active || (!!enrollment.endDate && enrollment.endDate < today);
  return { state: ended ? "ended" : "enrolled", week: version?.week ?? null, from: version?.effectiveFrom ?? null };
}

/** The heads whose ticks differ from what is saved, by name, in name order. */
export function unsavedHeadDays(
  drafts: Record<string, boolean[]>,
  heads: Record<string, Pick<HeadDayState, "week">>,
  names: Record<string, string>,
): string[] {
  return Object.entries(drafts)
    .filter(([key, ticks]) => ticks.some((on, i) => on !== daysOf(heads[key]?.week)[i]))
    .map(([key]) => names[key] ?? key)
    .sort();
}
/** The message after a head-days save. Booked visits on a removed day are not moved, so staff are told. `null`: the count failed after the save. */
export const headDaysNotice = (affected: number | null) =>
  affected === null
    ? "Saved. Check Mock and paper for visits on a day you removed."
    : affected === 0
    ? "Saved."
    : `Saved. ${affected} booked ${affected === 1 ? "visit falls" : "visits fall"} on a day you removed. The app did not move ${affected === 1 ? "it" : "them"}. Staff must act.`;

export const startsSending = (
  saved: Pick<HiringConfig, "enabled" | "deliveryEnabled">,
  draft: Pick<HiringConfig, "enabled" | "deliveryEnabled">,
) => (draft.enabled && !saved.enabled) || (draft.deliveryEnabled && !saved.deliveryEnabled);
export function sendingNotice(config: HiringConfig) {
  const pre = config.preScreenLimits;
  const limits =
    `${pre.perDay} pre-screen forms a day, ${pre.perWeek} a week` +
    (config.preScreenThreshold === null
      ? ". No onsite invitation is sent until you set a pass score."
      : `, and ${config.onsiteLimits.perWeek} onsite invitations a week.`);
  if (config.enabled && config.deliveryEnabled) return `Saving starts sending. It stays within your limits: ${limits}`;
  if (!config.enabled && !config.deliveryEnabled) return "";
  // One switch alone sends nothing: the queue needs both.
  return `${config.enabled ? "Messages" : "Automation"} is off, so nothing is sent yet. Once both are on, it stays within your limits: ${limits}`;
}
