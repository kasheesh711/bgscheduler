import { SearchSlot } from "./types";
import { v4 as uuidv4 } from "uuid";

const WEEKDAY_MAP: Record<string, number> = {
  sunday: 0, sun: 0,
  monday: 1, mon: 1,
  tuesday: 2, tue: 2, tues: 2,
  wednesday: 3, wed: 3,
  thursday: 4, thu: 4, thur: 4, thurs: 4,
  friday: 5, fri: 5,
  saturday: 6, sat: 6,
};

// Match patterns like "Monday 11:00-12:00" or "Mon 9:00 - 10:30"
const SLOT_PATTERN =
  /(\w+)\s+(\d{1,2}:\d{2})\s*[-–]\s*(\d{1,2}:\d{2})/gi;

export interface ParseResult {
  slots: SearchSlot[];
  warnings: string[];
  unparsed: string[];
}

/**
 * Parse free-text availability input into structured slots.
 * Supports: "Monday 11:00-12:00, Tuesday 15:00-17:00"
 */
export function parseSlotInput(
  input: string,
  defaultMode: "online" | "onsite" | "either" = "either"
): ParseResult {
  const slots: SearchSlot[] = [];
  const warnings: string[] = [];

  // Split by comma or newline for multi-slot
  const segments = input.split(/[,\n]+/).map((s) => s.trim()).filter(Boolean);

  for (const segment of segments) {
    const match = SLOT_PATTERN.exec(segment);
    SLOT_PATTERN.lastIndex = 0; // Reset regex state

    if (!match) {
      warnings.push(`Could not parse: "${segment}"`);
      continue;
    }

    const [, dayStr, startStr, endStr] = match;
    const weekday = WEEKDAY_MAP[dayStr.toLowerCase()];

    if (weekday === undefined) {
      warnings.push(`Unknown day: "${dayStr}" in "${segment}"`);
      continue;
    }

    slots.push({
      id: uuidv4(),
      dayOfWeek: weekday,
      start: normalizeTime(startStr),
      end: normalizeTime(endStr),
      mode: defaultMode,
    });
  }

  return {
    slots,
    warnings,
    unparsed: [],
  };
}

/**
 * Normalize a time string to "HH:mm" format.
 */
function normalizeTime(time: string): string {
  const [h, m] = time.split(":").map(Number);
  return `${String(h).padStart(2, "0")}:${String(m ?? 0).padStart(2, "0")}`;
}
