// ————————————————————————————————————————————————————————————————————————————
// Package-hours parsing + banding for the Packages dimension.
// Fail-soft: unparseable values land in the "Other" band and are counted via
// unparsedPackageCount — revenue is never dropped.
// ————————————————————————————————————————————————————————————————————————————

export const PACKAGE_BANDS = ["Trial", "1-10h", "20h", "30h", "40h+", "Other"] as const;

export type PackageBand = (typeof PACKAGE_BANDS)[number];

export interface ParsedPackageHours {
  hours: number | null;
  band: PackageBand;
  label: string;
}

/** Hour token: "20 Hours", "30h", "40 hrs", "20 ชม.", "10 ชั่วโมง", bare "20". */
const HOURS_PATTERN = /(\d+(?:\.\d+)?)\s*(?:h(?:ou)?rs?\.?\b|h\b|hr\.?\b|ชม\.?|ชั่วโมง)/i;
const BARE_NUMBER_PATTERN = /^(\d+(?:\.\d+)?)$/;

function bandForHours(hours: number): PackageBand {
  if (hours >= 40) return "40h+";
  if (hours >= 25) return "30h";
  if (hours > 10) return "20h";
  if (hours > 0) return "1-10h";
  return "Other";
}

/**
 * Parse a `packageHoursClean` value into { hours, band, label }.
 *
 * 1. Trial packages (any case) → band "Trial", hours null.
 * 2. Hour token (English/abbreviated/Thai) or bare number → numeric band.
 * 3. Anything else → band "Other", hours null (counted, never dropped).
 */
export function parsePackageHours(raw: string): ParsedPackageHours {
  const label = raw.trim().replace(/\s+/g, " ");
  if (!label) {
    return { hours: null, band: "Other", label: "Unspecified" };
  }

  if (/trial/i.test(label) || label.includes("ทดลอง")) {
    return { hours: null, band: "Trial", label };
  }

  const match = label.match(HOURS_PATTERN) ?? label.match(BARE_NUMBER_PATTERN);
  if (!match) {
    return { hours: null, band: "Other", label };
  }

  const hours = Number(match[1]);
  if (!Number.isFinite(hours) || hours <= 0) {
    return { hours: null, band: "Other", label };
  }

  return { hours, band: bandForHours(hours), label };
}
