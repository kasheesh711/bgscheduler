import { SitInError } from "./model";
import type {
  CalendarProvider,
  CalendarRequest,
  CalendarEvent,
  CalendarEventRef,
} from "./calendar-provider";

export const MICROSOFT_SCOPES = [
  "User.Read",
  "Calendars.ReadWrite",
  "offline_access",
];
export const OBSERVATION_PROPERTY =
  "String {84a06496-f84e-48a4-9256-68e64debb7d0} Name BeGiftedSitInObservationId";
type GraphTime = { dateTime?: string; timeZone?: string };
type GraphEvent = {
  id?: string;
  isCancelled?: boolean;
  showAs?: string;
  sensitivity?: string;
  "@odata.etag"?: string;
  webLink?: string;
  subject?: string;
  body?: { content?: string; contentType?: string };
  start?: GraphTime;
  end?: GraphTime;
  location?: { displayName?: string };
  attendees?: Array<{ emailAddress?: { address?: string } }>;
  singleValueExtendedProperties?: Array<{ id: string; value: string }>;
};
type GraphCalendar = {
  id?: string;
  name?: string;
  canEdit?: boolean;
  canShare?: boolean;
  owner?: { address?: string };
};
const calendarPath = (id: string) =>
  id === "primary" ? "me/calendar" : "me/calendars/" + encodeURIComponent(id);
const literal = (s: string) => "'" + s.replaceAll("'", "''") + "'";
const expand =
  "singleValueExtendedProperties($filter=id eq " +
  literal(OBSERVATION_PROPERTY) +
  ")";

/** Graph honors the UTC Prefer header. Never guess a returned floating timezone. */
export function microsoftTime(value: GraphTime | undefined) {
  if (!value?.dateTime)
    throw new SitInError(502, "Outlook returned incomplete event times.");
  const time = value.dateTime;
  const offset = /(?:Z|[+-]\d{2}:\d{2})$/i.test(time);
  if (!offset && !["UTC", "Etc/UTC", "GMT"].includes(value.timeZone || ""))
    throw new SitInError(
      502,
      "Outlook returned an unsupported event timezone.",
    );
  const date = new Date(offset ? time : time + "Z");
  if (!Number.isFinite(date.getTime()))
    throw new SitInError(502, "Outlook returned invalid event times.");
  return date;
}
function normalize(event: GraphEvent): CalendarEvent {
  if (!event.id)
    throw new SitInError(502, "Outlook returned an incomplete event.");
  if (event.isCancelled) return { id: event.id, status: "cancelled" };
  if (event.body?.contentType?.toLowerCase() !== "text")
    throw new SitInError(502, "Outlook event contents could not be verified.");
  return {
    id: event.id,
    status: "confirmed",
    visibility: event.sensitivity,
    etag: event["@odata.etag"],
    htmlLink: event.webLink,
    summary: event.subject,
    description: event.body.content?.replaceAll("\r\n", "\n").trim(),
    location: event.location?.displayName,
    start: { dateTime: microsoftTime(event.start).toISOString() },
    end: { dateTime: microsoftTime(event.end).toISOString() },
    attendees: event.attendees?.map((a) => ({
      email: a.emailAddress?.address,
    })),
    extendedProperties: {
      private: {
        sitInObservationId:
          event.singleValueExtendedProperties?.find(
            (p) => p.id === OBSERVATION_PROPERTY,
          )?.value || "",
      },
    },
  };
}
async function pages<T>(request: CalendarRequest, first: string): Promise<T[]> {
  const result: T[] = [],
    seen = new Set<string>();
  const base = new URL(first, "https://graph.microsoft.com/v1.0/");
  let path: string | undefined = first;
  for (let count = 0; path; count++) {
    if (count >= 40 || seen.has(path))
      throw new SitInError(502, "Outlook returned incomplete calendar data.");
    seen.add(path);
    const response: { value?: T[]; "@odata.nextLink"?: string } =
      await request(path);
    if (!Array.isArray(response.value))
      throw new SitInError(502, "Outlook returned incomplete calendar data.");
    result.push(...response.value);
    const next: string | undefined = response["@odata.nextLink"];
    if (next) {
      const url = new URL(next);
      if (
        url.origin !== base.origin ||
        url.pathname !== base.pathname ||
        url.username ||
        url.password ||
        url.hash
      )
        throw new SitInError(
          502,
          "Outlook returned an invalid pagination link.",
        );
      path = url.pathname.slice("/v1.0/".length) + url.search;
    } else path = undefined;
  }
  return result;
}
export function microsoftCalendarProvider(
  request: CalendarRequest,
): CalendarProvider {
  const list: CalendarProvider["list"] = async () => {
    const primary = await request<GraphCalendar>("me/calendar");
    const owner = primary.owner?.address?.toLowerCase();
    if (!primary.id || !owner)
      throw new SitInError(
        502,
        "Outlook primary calendar could not be verified.",
      );
    const calendars = await pages<GraphCalendar>(
      request,
      "me/calendars?$top=100",
    );
    if (!calendars.some((c) => c.id === primary.id))
      throw new SitInError(502, "Outlook calendar list is incomplete.");
    return calendars.map((c) => {
      if (!c.id || !c.name)
        throw new SitInError(502, "Outlook calendar list is incomplete.");
      return {
        id: c.id,
        summary: c.name,
        primary: c.id === primary.id,
        accessRole:
          c.canEdit && c.canShare && c.owner?.address?.toLowerCase() === owner
            ? "owner"
            : "reader",
      };
    });
  };
  const read = async (calendarId: string, eventId: string) => {
    try {
      return normalize(
        await request<GraphEvent>(
          calendarPath(calendarId) +
            "/events/" +
            encodeURIComponent(eventId) +
            "?" +
            new URLSearchParams({ $expand: expand }),
        ),
      );
    } catch (e) {
      if (e instanceof SitInError && e.status === 404) return null;
      throw e;
    }
  };
  const findEvent: CalendarProvider["findEvent"] = async (ref) => {
    if (ref.eventId) return read(ref.calendarId, ref.eventId);
    // Recover a server-accepted create whose response was lost. The durable marker
    // is independent of Graph's transactionId deduplication window.
    const query = new URLSearchParams({
      $filter:
        "singleValueExtendedProperties/Any(ep: ep/id eq " +
        literal(OBSERVATION_PROPERTY) +
        " and ep/value eq " +
        literal(ref.observationId) +
        ")",
      $expand: expand,
      $top: "50",
    });
    const found = await pages<GraphEvent>(
      request,
      calendarPath(ref.calendarId) + "/events?" + query,
    );
    if (found.length > 1)
      throw new SitInError(
        409,
        "Multiple Outlook events need administrator review.",
      );
    return found.length ? normalize(found[0]) : null;
  };
  return {
    list,
    findEvent,
    async createEvent(input) {
      const calendars = await list();
      if (
        !calendars.some(
          (c) =>
            c.accessRole === "owner" &&
            (c.id === input.calendarId ||
              (input.calendarId === "primary" && c.primary)),
        )
      )
        throw new SitInError(
          409,
          "Choose an owned Outlook calendar for event delivery.",
        );
      const recovered = await findEvent(input);
      if (recovered) return recovered;
      const event = await request<GraphEvent>(
        calendarPath(input.calendarId) + "/events",
        {
          method: "POST",
          body: JSON.stringify({
            subject: input.summary,
            body: { contentType: "text", content: input.description },
            start: { dateTime: input.start.toISOString(), timeZone: "UTC" },
            end: { dateTime: input.end.toISOString(), timeZone: "UTC" },
            location: { displayName: input.location },
            sensitivity: "private",
            showAs: "busy",
            allowNewTimeProposals: false,
            attendees: [
              { emailAddress: { address: input.tutorEmail }, type: "required" },
            ],
            transactionId: input.observationId,
            singleValueExtendedProperties: [
              { id: OBSERVATION_PROPERTY, value: input.observationId },
            ],
          }),
        },
      );
      if (!event.id)
        throw new SitInError(
          502,
          "Outlook creation needs a verification retry.",
        );
      // A response alone is not delivery evidence. Read the immutable ID back.
      const verified = await read(input.calendarId, event.id);
      if (!verified)
        throw new SitInError(
          502,
          "Outlook creation needs a verification retry.",
        );
      return verified;
    },
    async cancelEvent(ref: CalendarEventRef) {
      if (!ref.eventId)
        throw new SitInError(409, "Outlook event identity is missing.");
      try {
        await request(
          calendarPath(ref.calendarId) +
            "/events/" +
            encodeURIComponent(ref.eventId),
          { method: "DELETE" },
        );
      } catch (e) {
        if (!(e instanceof SitInError) || e.status !== 404) throw e;
      }
    },
  };
}
