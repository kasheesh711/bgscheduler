import { bangkokDateKey } from "@/lib/room-capacity/dates";
import { baseGoneProbability, daysBetweenDateKeys, HISTORY_START, HISTORY_START_KEY, type CalibrationCurve } from "./calibration";
import { bangkokDayLabel } from "./day-label";
import type { OffboardingBand, OffboardingExclusion, PersonScore, PersonSignals, ScoreReason } from "./types";

// ----------------------------------------------------------------------------
// Tutor Offboarding score (spec §4.4-4.5): calibrated base likelihood plus fixed
// evidence weights, bands, exclusions and the removal checks. Pure.
// ----------------------------------------------------------------------------

/** Log-odds added by each piece of evidence (spec §4.4). */
export const EVIDENCE_WEIGHTS = {
  noWorkingHours: 0.8,
  noCourses: 0.8,
  neverActivated: 0.5,
  recentWiseAction: -2,
  onLeave: -1.5,
} as const;

/** OFF-14: the page never claims certainty. */
export const MAX_LIKELIHOOD = 99;
/** OFF-05: a never-taught account younger than this is a new hire, not a departure. */
export const NEW_ACCOUNT_GRACE_DAYS = 60;
/** OFF-06: removal needs the last class at least this long ago. */
export const REMOVAL_MIN_IDLE_DAYS = 45;
export const RECENT_ACTION_DAYS = 30;

const DAY_MS = 86_400_000;

export interface ScoreContext {
  now: Date;
  curve: CalibrationCurve;
  /** Canonical keys with an open "Still with us" decision. */
  snoozedKeys: ReadonlySet<string>;
  /** OFF-07: every feed is fresh. */
  freshnessOk: boolean;
}

export function bandFor(likelihood: number): OffboardingBand {
  if (likelihood >= 90) return "very_likely_gone";
  if (likelihood >= 70) return "likely_gone";
  if (likelihood >= 40) return "unclear";
  return "active";
}

function day(iso: string): string {
  return bangkokDayLabel(iso);
}

function plural(count: number, word: string, many = `${word}s`): string {
  return `${count} ${count === 1 ? word : many}`;
}

/** Earliest joined date across the accounts, or null when any of them is unknown. */
function earliestJoined(signals: PersonSignals): string | null {
  const dates = signals.accounts.map((account) => account.joinedOn);
  if (dates.length === 0 || dates.some((date) => date === null)) return null;
  return (dates as string[]).reduce((earliest, date) => (date < earliest ? date : earliest));
}

function exclusionFor(signals: PersonSignals, ctx: ScoreContext, neverTaught: boolean, accountAgeDays: number | null): PersonScore["exclusion"] {
  const exclude = (code: OffboardingExclusion, text: string) => ({ code, text });
  // OFF-03: staff accounts are never in the review list.
  if (signals.accounts.some((account) => account.relation === "ADMIN")) return exclude("wise_admin", "Wise admin account (staff)");
  // OFF-04: anyone with an upcoming class is teaching.
  if (signals.upcomingSessions > 0) return exclude("teaching", `Teaching: ${plural(signals.upcomingSessions, "upcoming class", "upcoming classes")}`);
  if (signals.fullTime) return exclude("full_time", "Full-time tutor (office attendance)");
  if (signals.accounts.some((account) => account.status === "identity_conflict")) return exclude("identity_conflict", "Identity needs fixing in Wise first");
  // OFF-02: a never-taught person with an unknown joined date could be a brand-new hire.
  if (neverTaught && accountAgeDays === null) return exclude("awaiting_details", "Waiting for Wise account details (next sync)");
  // OFF-05
  if (neverTaught && accountAgeDays !== null && accountAgeDays < NEW_ACCOUNT_GRACE_DAYS) return exclude("new_account", "New account, not started yet");
  if (ctx.snoozedKeys.has(signals.canonicalKey)) return exclude("still_with_us", "Marked still with us");
  return null;
}

export function scorePerson(signals: PersonSignals, ctx: ScoreContext): PersonScore {
  const todayKey = bangkokDateKey(ctx.now);
  const joined = earliestJoined(signals);
  const joinedKey = joined ? bangkokDateKey(new Date(joined)) : null;
  const accountAgeDays = joinedKey ? daysBetweenDateKeys(joinedKey, todayKey) : null;
  const neverTaught = signals.lastTaughtAt === null;
  // OFF-14: a never-taught person is measured from 1 Mar or their joined date, whichever is later.
  const anchorIso = !neverTaught ? signals.lastTaughtAt! : joined && joinedKey! > HISTORY_START_KEY ? joined : HISTORY_START.toISOString();
  const idleDays = Math.max(0, daysBetweenDateKeys(bangkokDateKey(new Date(anchorIso)), todayKey));

  const reasons: ScoreReason[] = [neverTaught
    ? { code: "no_class_on_record", direction: "toward_gone", text: `No class on record since ${day(anchorIso)}` }
    : {
      code: "idle_gap",
      direction: idleDays >= 21 ? "toward_gone" : "toward_active",
      text: idleDays === 0 ? "Taught today" : `Last class ${plural(idleDays, "day")} ago (${day(anchorIso)})`,
    }];
  const base = baseGoneProbability(ctx.curve, idleDays);
  let logOdds = Math.log(base / (1 - base));

  // OFF-02: each piece of evidence must hold for every account; unknown values never count.
  const accounts = signals.accounts;
  if (accounts.length > 0 && accounts.every((account) => account.availabilityKnown && account.workingHourWindows === 0)) {
    logOdds += EVIDENCE_WEIGHTS.noWorkingHours;
    reasons.push({ code: "no_working_hours", direction: "toward_gone", text: "No working hours set in Wise" });
  }
  if (accounts.length > 0 && accounts.every((account) => account.courseCount === 0)) {
    logOdds += EVIDENCE_WEIGHTS.noCourses;
    reasons.push({ code: "no_courses", direction: "toward_gone", text: "Not assigned to any Wise course" });
  }
  if (accounts.length > 0 && accounts.every((account) => account.activated === false)) {
    logOdds += EVIDENCE_WEIGHTS.neverActivated;
    reasons.push({ code: "never_activated", direction: "toward_gone", text: "Never activated their Wise login" });
  }
  if (signals.lastTeacherActionAt && ctx.now.getTime() - Date.parse(signals.lastTeacherActionAt) <= RECENT_ACTION_DAYS * DAY_MS) {
    logOdds += EVIDENCE_WEIGHTS.recentWiseAction;
    reasons.push({ code: "recent_wise_action", direction: "toward_active", text: `Used Wise on ${day(signals.lastTeacherActionAt)}` });
  }
  if (signals.upcomingLeaveUntil && Date.parse(signals.upcomingLeaveUntil) > ctx.now.getTime()) {
    logOdds += EVIDENCE_WEIGHTS.onLeave;
    reasons.push({ code: "on_leave", direction: "toward_active", text: `On leave until ${day(signals.upcomingLeaveUntil)}` });
  }

  const likelihood = Math.min(MAX_LIKELIHOOD, Math.round(100 / (1 + Math.exp(-logOdds))));
  const band = bandFor(likelihood);
  const exclusion = exclusionFor(signals, ctx, neverTaught, accountAgeDays);

  let removableBlockedBy: string | null = null;
  if (!exclusion) {
    if (!ctx.freshnessOk) removableBlockedBy = "Data is out of date"; // OFF-07
    else if (accounts.some((account) => account.relation !== "TEACHER")) removableBlockedBy = "Waiting for Wise account details";
    else if (band === "active") removableBlockedBy = "Looks active";
    else if (!neverTaught && idleDays < REMOVAL_MIN_IDLE_DAYS) {
      removableBlockedBy = `Last class ${plural(idleDays, "day")} ago; removal opens at ${REMOVAL_MIN_IDLE_DAYS} days`; // OFF-06
    }
  }

  return { likelihood, band, idleDays, neverTaught, reasons, exclusion, removable: exclusion === null && removableBlockedBy === null, removableBlockedBy };
}
