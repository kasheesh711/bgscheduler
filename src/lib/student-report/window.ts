import { BANGKOK_TIME_ZONE } from "@/lib/bangkok-time";
import {
  FUTURE_WINDOW_DAYS,
  PAST_WINDOW_DAYS,
} from "@/lib/credit-control/sync";
import {
  addBangkokDays,
  bangkokDateKey,
  bangkokDateStartUtc,
} from "@/lib/room-capacity/dates";

const DATE_WITH_YEAR_FORMATTER = new Intl.DateTimeFormat("en-GB", {
  timeZone: BANGKOK_TIME_ZONE,
  day: "numeric",
  month: "short",
  year: "numeric",
});

const DATE_WITHOUT_YEAR_FORMATTER = new Intl.DateTimeFormat("en-GB", {
  timeZone: BANGKOK_TIME_ZONE,
  day: "numeric",
  month: "short",
});

export interface ResolvedReportWindow {
  fromDateKey: string;
  toDateKey: string;
  startUtc: Date;
  endUtc: Date;
  label: string;
}

function formatWindowLabel(fromDateKey: string, toDateKey: string): string {
  const from = bangkokDateStartUtc(fromDateKey);
  if (fromDateKey === toDateKey) {
    return DATE_WITH_YEAR_FORMATTER.format(from);
  }

  const to = bangkokDateStartUtc(toDateKey);
  const fromLabel = fromDateKey.slice(0, 4) === toDateKey.slice(0, 4)
    ? DATE_WITHOUT_YEAR_FORMATTER.format(from)
    : DATE_WITH_YEAR_FORMATTER.format(from);
  return `${fromLabel} – ${DATE_WITH_YEAR_FORMATTER.format(to)}`;
}

/**
 * Resolves an inclusive Bangkok date range into half-open UTC instants.
 * The end instant is midnight at the start of the day after `toDateKey`.
 */
export function resolveReportWindow(
  fromDateKey: string,
  toDateKey: string,
): ResolvedReportWindow {
  return {
    fromDateKey,
    toDateKey,
    startUtc: bangkokDateStartUtc(fromDateKey),
    endUtc: bangkokDateStartUtc(addBangkokDays(toDateKey, 1)),
    label: formatWindowLabel(fromDateKey, toDateKey),
  };
}

/** Returns the snapshot's retained past and future bounds as Bangkok date keys. */
export function snapshotDataBounds(snapshotGeneratedAt: Date): {
  floorDateKey: string;
  ceilingDateKey: string;
} {
  const generatedDateKey = bangkokDateKey(snapshotGeneratedAt);
  return {
    floorDateKey: addBangkokDays(generatedDateKey, -PAST_WINDOW_DAYS),
    ceilingDateKey: addBangkokDays(generatedDateKey, FUTURE_WINDOW_DAYS),
  };
}

/** Flags either side of a requested window that exceeds the snapshot's retained bounds. */
export function windowWarnings(
  window: ResolvedReportWindow,
  bounds: { floorDateKey: string; ceilingDateKey: string },
): { floorWarning: boolean; ceilingWarning: boolean } {
  return {
    floorWarning: window.fromDateKey < bounds.floorDateKey,
    ceilingWarning: window.toDateKey > bounds.ceilingDateKey,
  };
}
