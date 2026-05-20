export interface SchedulerCompareSuggestion {
  searchMode: "recurring" | "one_time";
  dayOfWeek?: number;
  date?: string;
  tutors: { tutorGroupId: string }[];
}

export interface SchedulerCompareFocusTarget {
  tutorIds: string[];
  weekStart: string;
  activeDay: number | null;
}

const ISO_DATE_RE = /^(\d{4})-(\d{2})-(\d{2})$/;

function isValidIsoDate(value: string): boolean {
  const match = ISO_DATE_RE.exec(value);
  if (!match) return false;

  const year = Number(match[1]);
  const month = Number(match[2]);
  const day = Number(match[3]);
  const date = new Date(Date.UTC(year, month - 1, day));

  return (
    date.getUTCFullYear() === year &&
    date.getUTCMonth() === month - 1 &&
    date.getUTCDate() === day
  );
}

function addDaysIso(value: string, days: number): string | null {
  if (!isValidIsoDate(value)) return null;

  const [year, month, day] = value.split("-").map(Number);
  const date = new Date(Date.UTC(year, month - 1, day + days));

  return [
    date.getUTCFullYear(),
    String(date.getUTCMonth() + 1).padStart(2, "0"),
    String(date.getUTCDate()).padStart(2, "0"),
  ].join("-");
}

export function getSchedulerSuggestionTutorIds(suggestion: SchedulerCompareSuggestion): string[] {
  return suggestion.tutors.slice(0, 3).map((tutor) => tutor.tutorGroupId);
}

export function getSchedulerWeekdayForIsoDate(value: string): number | null {
  if (!isValidIsoDate(value)) return null;

  const [year, month, day] = value.split("-").map(Number);
  return new Date(Date.UTC(year, month - 1, day)).getUTCDay();
}

export function getSchedulerMondayForIsoDate(value: string): string | null {
  const weekday = getSchedulerWeekdayForIsoDate(value);
  if (weekday === null) return null;

  const mondayOffset = weekday === 0 ? -6 : 1 - weekday;
  return addDaysIso(value, mondayOffset);
}

export function buildSchedulerCompareFocusTarget(
  suggestion: SchedulerCompareSuggestion,
  currentWeekStart: string,
): SchedulerCompareFocusTarget {
  if (suggestion.searchMode === "one_time" && suggestion.date) {
    return {
      tutorIds: getSchedulerSuggestionTutorIds(suggestion),
      weekStart: getSchedulerMondayForIsoDate(suggestion.date) ?? currentWeekStart,
      activeDay: getSchedulerWeekdayForIsoDate(suggestion.date),
    };
  }

  return {
    tutorIds: getSchedulerSuggestionTutorIds(suggestion),
    weekStart: currentWeekStart,
    activeDay: typeof suggestion.dayOfWeek === "number" ? suggestion.dayOfWeek : null,
  };
}
