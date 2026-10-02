const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"] as const;
const BANGKOK_PARTS = new Intl.DateTimeFormat("en-GB", { timeZone: "Asia/Bangkok", year: "numeric", month: "numeric", day: "numeric" });

/**
 * "3 Jun" (or "3 Jun 2026") for an instant, on the Bangkok calendar. Month names are fixed rather than taken from the
 * runtime's locale data: Node writes "Sept" in en-GB where browsers write "Sep", which would also break hydration.
 */
export function bangkokDayLabel(iso: string, withYear = false): string {
  const parts = new Map(BANGKOK_PARTS.formatToParts(new Date(iso)).map((part) => [part.type, part.value]));
  const label = `${Number(parts.get("day"))} ${MONTHS[Number(parts.get("month")) - 1]}`;
  return withYear ? `${label} ${parts.get("year")}` : label;
}
