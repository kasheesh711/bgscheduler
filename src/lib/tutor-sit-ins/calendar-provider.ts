/** Common calendar contract. Provider identifiers remain opaque and case-sensitive. */
export type CalendarProviderName = "google" | "microsoft";
export type CalendarSummary = {
  id: string;
  summary: string;
  accessRole: string;
  primary?: boolean;
};
export type CalendarEvent = {
  id: string;
  status?: string;
  etag?: string;
  htmlLink?: string;
  summary?: string;
  description?: string;
  location?: string;
  start?: { dateTime?: string; date?: string; timeZone?: string };
  end?: { dateTime?: string; date?: string; timeZone?: string };
  transparency?: string;
  visibility?: string;
  attendees?: Array<{ email?: string }>;
  extendedProperties?: { private?: Record<string, string> };
};
export type CalendarEventRef = {
  calendarId: string;
  eventId: string | null;
  observationId: string;
};
export type CalendarEventInput = CalendarEventRef & {
  summary: string;
  description: string;
  location: string;
  start: Date;
  end: Date;
  tutorEmail: string;
};
export type CalendarBusyOptions = {
  calendarId: string;
  busyCalendarIds: string[];
  exclude?: { calendarId: string; eventId: string };
};
export type CalendarRequest = <T>(
  path: string,
  init?: RequestInit,
) => Promise<T>;
export interface CalendarProvider {
  list(): Promise<CalendarSummary[]>;
  busy(
    start: Date,
    end: Date,
    options: CalendarBusyOptions,
  ): Promise<Array<{ start: Date; end: Date }>>;
  findEvent(ref: CalendarEventRef): Promise<CalendarEvent | null>;
  createEvent(input: CalendarEventInput): Promise<CalendarEvent>;
  cancelEvent(ref: CalendarEventRef): Promise<void>;
}
