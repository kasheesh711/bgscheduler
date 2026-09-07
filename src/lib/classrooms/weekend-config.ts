import { z } from "zod";
import { addBangkokDays, bangkokWeekday, todayBangkok } from "@/lib/room-capacity/dates";

export const WEEKEND_CHECK_JOB_KEY = "classroom_weekend_check";
export const WEEKEND_CHECK_WEEKDAYS = [3, 4, 5];
export const WEEKEND_CHECK_LEASE_MS = 15 * 60_000;

export function weekendDates(now: Date): [string, string] {
  const today = todayBangkok(now);
  // On Sunday the report still belongs to the weekend currently in progress.
  const weekday = bangkokWeekday(now);
  const saturday = addBangkokDays(today, weekday === 0 ? -1 : 6 - weekday);
  return [saturday, addBangkokDays(saturday, 1)];
}

export function weekendAlertRecipient(): string {
  return z.email().parse(process.env.CLASSROOM_WEEKEND_ALERT_EMAIL?.trim().toLowerCase());
}

/** An explicit activation instant prevents the watchdog backdating missed checks on rollout. */
export function weekendAlertsEnabledAt(): Date | null {
  const value = process.env.CLASSROOM_WEEKEND_ALERTS_ENABLED_AT?.trim();
  if (!value) return null;
  return new Date(z.iso.datetime({ offset: true }).parse(value));
}

export function isWeekendCheckDue(now: Date): boolean {
  const enabled = weekendAlertsEnabledAt();
  return Boolean(enabled && now >= enabled && WEEKEND_CHECK_WEEKDAYS.includes(bangkokWeekday(now)));
}
