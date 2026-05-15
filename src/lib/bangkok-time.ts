export const BANGKOK_TIME_ZONE = "Asia/Bangkok";

type DateInput = string | number | Date;

export function formatBangkokDateTime(
  value: DateInput,
  options: Intl.DateTimeFormatOptions = {
    year: "numeric",
    month: "short",
    day: "numeric",
    hour: "2-digit",
    minute: "2-digit",
  },
  locale = "en-GB",
): string {
  return new Intl.DateTimeFormat(locale, {
    timeZone: BANGKOK_TIME_ZONE,
    hour12: false,
    ...options,
  }).format(new Date(value));
}

export function formatBangkokShortDateTime(value: DateInput): string {
  return formatBangkokDateTime(value, {
    month: "short",
    day: "numeric",
    hour: "2-digit",
    minute: "2-digit",
  });
}

function bangkokInstantForIsoDate(value: string): Date {
  return new Date(`${value}T00:00:00+07:00`);
}

export function formatBangkokIsoDate(
  value: string,
  options: Intl.DateTimeFormatOptions = { day: "numeric", month: "short" },
  locale = "en-GB",
): string {
  return formatBangkokDateTime(bangkokInstantForIsoDate(value), options, locale);
}

export function getBangkokWeekdayForIsoDate(value: string): number {
  const weekday = formatBangkokDateTime(
    bangkokInstantForIsoDate(value),
    { weekday: "short" },
    "en-US",
  );
  return ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"].indexOf(weekday);
}
