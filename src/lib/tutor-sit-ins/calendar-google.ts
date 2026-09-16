import { fromZonedTime } from "date-fns-tz";
import { SitInError, ZONE } from "./model";
import type {
  CalendarProvider,
  CalendarRequest,
  CalendarSummary,
  CalendarEvent,
  CalendarBusyOptions,
} from "./calendar-provider";

async function list(request: CalendarRequest) {
  const result: CalendarSummary[] = [];
  let page: string | undefined;
  do {
    const response: { items?: CalendarSummary[]; nextPageToken?: string } =
      await request(
        "users/me/calendarList?maxResults=250" +
          (page ? "&pageToken=" + encodeURIComponent(page) : ""),
        {},
      );
    if (!Array.isArray(response.items))
      throw new SitInError(502, "Google returned an incomplete calendar list.");
    result.push(...response.items);
    page = response.nextPageToken;
    if (result.length > 1000)
      throw new SitInError(400, "Too many calendars to list.");
  } while (page);
  return result;
}
async function busy(
  request: CalendarRequest,
  start: Date,
  end: Date,
  connection: CalendarBusyOptions,
) {
  const exclude = connection.exclude;
  const calendars = await list(request);
  const primaryId = calendars.find((c) => c.primary)?.id;
  const ids = [
    ...new Set(
      ["primary", connection.calendarId, ...connection.busyCalendarIds].map(
        (id) => (id === "primary" ? primaryId || "primary" : id),
      ),
    ),
  ];
  const excludedCalendar =
    exclude?.calendarId === "primary"
      ? primaryId || "primary"
      : exclude?.calendarId;
  const queryIds = ids.filter((id) => !exclude || id !== excludedCalendar);
  const busy: Array<{ start: Date; end: Date }> = [];
  if (queryIds.length) {
    const body = await request<{
      calendars?: Record<
        string,
        { busy?: Array<{ start: string; end: string }>; errors?: unknown[] }
      >;
    }>("freeBusy", {
      method: "POST",
      body: JSON.stringify({
        timeMin: start.toISOString(),
        timeMax: end.toISOString(),
        timeZone: ZONE,
        items: queryIds.map((id) => ({ id })),
      }),
    });
    for (const id of queryIds) {
      const calendar = body.calendars?.[id];
      if (!calendar || calendar.errors?.length || !Array.isArray(calendar.busy))
        throw new SitInError(
          409,
          "Calendar availability is incomplete. Try again before booking.",
        );
      for (const b of calendar.busy) {
        if (
          !Number.isFinite(Date.parse(b.start)) ||
          !Number.isFinite(Date.parse(b.end)) ||
          Date.parse(b.end) <= Date.parse(b.start)
        )
          throw new SitInError(502, "Google returned invalid availability.");
        busy.push({ start: new Date(b.start), end: new Date(b.end) });
      }
    }
  }
  // FreeBusy intervals are merged. Subtracting our own event would hide a
  // simultaneous personal event. Read only the owned destination's time window.
  if (exclude && excludedCalendar && ids.includes(excludedCalendar)) {
    let page: string | undefined;
    let pages = 0;
    do {
      const params = new URLSearchParams({
        timeMin: start.toISOString(),
        timeMax: end.toISOString(),
        singleEvents: "true",
        maxResults: "2500",
      });
      if (page) params.set("pageToken", page);
      const result: {
        items?: CalendarEvent[];
        nextPageToken?: string;
        timeZone?: string;
      } = await request(
        "calendars/" +
          encodeURIComponent(exclude.calendarId) +
          "/events?" +
          params,
        {},
      );
      if (!Array.isArray(result.items) || ++pages > 10)
        throw new SitInError(502, "Calendar event availability is incomplete.");
      for (const event of result.items) {
        if (
          event.id === exclude.eventId ||
          event.status === "cancelled" ||
          event.transparency === "transparent"
        )
          continue;
        const eventStart = event.start?.dateTime
          ? new Date(event.start.dateTime)
          : event.start?.date && result.timeZone
            ? fromZonedTime(event.start.date + "T00:00:00", result.timeZone)
            : start;
        const eventEnd = event.end?.dateTime
          ? new Date(event.end.dateTime)
          : event.end?.date && result.timeZone
            ? fromZonedTime(event.end.date + "T00:00:00", result.timeZone)
            : end;
        if (
          !Number.isFinite(eventStart.getTime()) ||
          !Number.isFinite(eventEnd.getTime())
        )
          throw new SitInError(502, "Calendar event times are invalid.");
        busy.push({ start: eventStart, end: eventEnd });
      }
      page = result.nextPageToken;
    } while (page);
  }
  return busy;
}

export function googleCalendarProvider(
  request: CalendarRequest,
): CalendarProvider {
  const findEvent: CalendarProvider["findEvent"] = async (ref) => {
    if (!ref.eventId)
      throw new SitInError(409, "Google event identity is missing.");
    try {
      return await request<CalendarEvent>(
        "calendars/" +
          encodeURIComponent(ref.calendarId) +
          "/events/" +
          encodeURIComponent(ref.eventId),
      );
    } catch (e) {
      if (e instanceof SitInError && e.status === 404) return null;
      throw e;
    }
  };
  return {
    list: () => list(request),
    busy: (start, end, options) => busy(request, start, end, options),
    findEvent,
    async createEvent(input) {
      const body = {
        id: input.eventId,
        summary: input.summary,
        description: input.description,
        location: input.location,
        start: { dateTime: input.start.toISOString(), timeZone: ZONE },
        end: { dateTime: input.end.toISOString(), timeZone: ZONE },
        attendees: [{ email: input.tutorEmail }],
        guestsCanModify: false,
        guestsCanInviteOthers: false,
        visibility: "private",
        extendedProperties: {
          private: { sitInObservationId: input.observationId },
        },
      };
      try {
        return await request<CalendarEvent>(
          "calendars/" +
            encodeURIComponent(input.calendarId) +
            "/events?sendUpdates=all",
          { method: "POST", body: JSON.stringify(body) },
        );
      } catch (e) {
        if (!(e instanceof SitInError) || e.code !== "GOOGLE_409") throw e;
        const recovered = await findEvent(input);
        if (!recovered) throw e;
        return recovered;
      }
    },
    async cancelEvent(ref) {
      if (!ref.eventId)
        throw new SitInError(409, "Google event identity is missing.");
      try {
        await request(
          "calendars/" +
            encodeURIComponent(ref.calendarId) +
            "/events/" +
            encodeURIComponent(ref.eventId) +
            "?sendUpdates=all",
          { method: "DELETE" },
        );
      } catch (e) {
        if (!(e instanceof SitInError) || e.status !== 404) throw e;
      }
    },
  };
}
