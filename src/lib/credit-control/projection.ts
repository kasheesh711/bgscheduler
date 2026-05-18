import { ALERT_THRESHOLD, DAY_MS, NOTIFY_WINDOW_DAYS } from "@/lib/credit-control/config";
import { daysBetween, formatDate, roundToHundredth } from "@/lib/credit-control/helpers";
import type { PackageRecord } from "@/types/credit-control";

export interface UpcomingProjectionSession {
  date: Date;
  durationMin: number;
}

export function computeProjection(
  startBalance: number,
  sessions: UpcomingProjectionSession[],
  today: Date,
) {
  if (!sessions.length) {
    if (startBalance < ALERT_THRESHOLD) {
      return {
        alertDate: formatDate(today),
        exhaustDate: startBalance <= 0 ? formatDate(today) : null,
        daysUntilAlert: 0,
        daysUntilExhaust: startBalance <= 0 ? 0 : null,
        status: "notify" as const,
        rows: [],
      };
    }

    return {
      alertDate: null,
      exhaustDate: null,
      daysUntilAlert: null,
      daysUntilExhaust: null,
      status: "nodata" as const,
      rows: [],
    };
  }

  let balance = startBalance;
  let alertDate: Date | null = null;
  let exhaustDate: Date | null = null;

  const rows = sessions.map((session) => {
    const deductedCredits = roundToHundredth(session.durationMin / 60);
    balance = roundToHundredth(balance - deductedCredits);

    const flags: string[] = [];
    if (!alertDate && balance < ALERT_THRESHOLD) {
      alertDate = session.date;
      flags.push("alert");
    }
    if (!exhaustDate && balance <= 0) {
      exhaustDate = session.date;
      flags.push("exhaust");
    }

    return {
      date: formatDate(session.date) ?? "",
      dur: session.durationMin,
      deduct: deductedCredits,
      bal: balance,
      flag: flags.join(" "),
    };
  });

  const daysUntilAlert = alertDate ? daysBetween(alertDate, today) : null;
  const daysUntilExhaust = exhaustDate ? daysBetween(exhaustDate, today) : null;

  const status =
    startBalance < ALERT_THRESHOLD
      ? ("notify" as const)
      : alertDate && daysUntilAlert !== null && daysUntilAlert <= NOTIFY_WINDOW_DAYS
        ? ("watch" as const)
        : ("ok" as const);

  return {
    alertDate: formatDate(alertDate),
    exhaustDate: formatDate(exhaustDate),
    daysUntilAlert,
    daysUntilExhaust,
    status,
    rows,
  };
}

export function worstStatus(packages: PackageRecord[]): PackageRecord["status"] {
  if (packages.some((pkg) => pkg.status === "notify")) return "notify";
  if (packages.some((pkg) => pkg.status === "watch")) return "watch";
  if (packages.some((pkg) => pkg.status === "ok")) return "ok";
  return "nodata";
}

export function diffDays(dateA: Date, dateB: Date): number {
  return Math.round((dateA.getTime() - dateB.getTime()) / DAY_MS);
}
