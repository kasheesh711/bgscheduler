import { applicableSchedule, type Week } from "@/lib/tutor-attendance/model";
import { configRuleErrors, localDate, SUBJECTS, VISIT_LINK_DAYS, type HiringConfig } from "./model";
import { answerKey } from "./scoring";

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
export function workRightsRows(config: HiringConfig): { answer: string; accepted: boolean }[] {
  const accepted = new Set(config.acceptedWorkRights.map(answerKey));
  const seen = new Set<string>();
  return [...config.acceptedWorkRights, ...config.seenWorkRights].flatMap((answer) => {
    const key = answerKey(answer);
    if (seen.has(key)) return [];
    seen.add(key);
    return [{ answer, accepted: accepted.has(key) }];
  });
}
export function setWorkRightsAccepted(config: HiringConfig, answer: string, on: boolean): HiringConfig {
  const key = answerKey(answer);
  const rest = config.acceptedWorkRights.filter((a) => answerKey(a) !== key);
  // An unticked answer must stay on the list so it can be ticked again, so record it as seen. The schema holds 200.
  const seen = config.seenWorkRights;
  const remember = !on && !seen.some((a) => answerKey(a) === key) && seen.length < 200;
  return {
    ...config,
    acceptedWorkRights: on ? [...rest, answer] : rest,
    seenWorkRights: remember ? [...seen, answer] : seen,
  };
}

export const HEAD_DAYS = ["Mon", "Tue", "Wed", "Thu", "Fri"] as const;
export const DEFAULT_WINDOW = { start: "10:00", end: "16:00" };
export type HeadDayState = {
  /** `fallback`: no attendance record, hours live in Hiring settings. `ended`: the attendance enrollment is switched off. */
  state: "enrolled" | "ended" | "fallback";
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
/** The newest saved schedule counts, even one that starts tomorrow, so the screen shows what was last saved. */
export function headDayState(
  head: { canonicalKey: string; fallbackWeek?: Week },
  enrollments: { canonicalKey: string; active: boolean; endDate?: string | null }[],
  schedules: { id: string; canonicalKey: string; effectiveFrom: string; week: Week; revision: number }[],
  today = localDate(new Date()),
): HeadDayState {
  const enrollment = enrollments.find((e) => e.canonicalKey === head.canonicalKey);
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
/** The message after a head-days save. Booked visits on a removed day are not moved, so staff are told. */
export const headDaysNotice = (affected: number) =>
  affected === 0
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
