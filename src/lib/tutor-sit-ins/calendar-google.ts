import { SitInError, ZONE } from "./model";
import type {
  CalendarProvider,
  CalendarRequest,
  CalendarSummary,
  CalendarEvent,
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
