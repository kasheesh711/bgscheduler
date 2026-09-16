import { describe, expect, it, vi } from "vitest";
import {
  microsoftCalendarProvider,
  OBSERVATION_PROPERTY,
} from "../calendar-microsoft";
import { SitInError } from "../model";
import type { CalendarEventInput, CalendarRequest } from "../calendar-provider";
const primary = {
  id: "Primary-ID",
  name: "Personal",
  canEdit: true,
  canShare: true,
  owner: { address: "apivit.s@hotmail.com" },
};
const start = new Date("2026-10-01T17:00:00Z"),
  end = new Date("2026-10-02T17:00:00Z");
const eventTime = {
  start: { dateTime: "2026-10-02T00:00:00.0000000", timeZone: "UTC" },
  end: { dateTime: "2026-10-02T01:00:00.0000000", timeZone: "UTC" },
};
function fixture(
  handler: (path: string, init?: RequestInit) => unknown = () => ({
    value: [],
  }),
) {
  const request = vi.fn(async (path: string, init?: RequestInit) => {
    if (path === "me/calendar") return primary;
    if (path === "me/calendars?$top=100")
      return { value: [primary, { ...primary, id: "Work-ID", name: "Work" }] };
    return handler(path, init);
  });
  return {
    request,
    provider: microsoftCalendarProvider(request as CalendarRequest),
  };
}
const input: CalendarEventInput = {
  calendarId: primary.id,
  eventId: null,
  observationId: "34352dce-21e8-432c-96da-c05f3e619bd7",
  summary: "Observation",
  description: "Details",
  location: "Room A",
  start,
  end,
  tutorEmail: "tutor@example.test",
};
const graphEvent = {
  id: "IMMUTABLE+/Case-Sensitive",
  subject: input.summary,
  body: { contentType: "text", content: input.description },
  location: { displayName: input.location },
  ...eventTime,
  attendees: [{ emailAddress: { address: input.tutorEmail } }],
  sensitivity: "private",
  singleValueExtendedProperties: [
    { id: OBSERVATION_PROPERTY, value: input.observationId },
  ],
};
describe("Microsoft personal and work calendar provider", () => {
  it("does not treat someone else's editable shared calendar as owned", async () => {
    const request = vi.fn(async (path: string) =>
      path === "me/calendar"
        ? primary
        : {
            value: [
              primary,
              {
                ...primary,
                id: "shared",
                owner: { address: "another@example.test" },
              },
            ],
          },
    );
    const provider = microsoftCalendarProvider(request as CalendarRequest);
    expect((await provider.list())[1].accessRole).toBe("reader");
    await expect(
      provider.createEvent({ ...input, calendarId: "shared" }),
    ).rejects.toThrow("owned");
  });
  it("creates private invitations with transaction ID and marker, then reads back the immutable ID", async () => {
    const { provider, request } = fixture((path, init) =>
      init?.method === "POST"
        ? { id: graphEvent.id }
        : path.includes("/events/")
          ? graphEvent
          : { value: [] },
    );
    const result = await provider.createEvent(input);
    expect(result.id).toBe(graphEvent.id);
    expect(result.visibility).toBe("private");
    const body = JSON.parse(
      request.mock.calls.find(([, init]) => init?.method === "POST")![1]!
        .body as string,
    );
    expect(body).toMatchObject({
      transactionId: input.observationId,
      sensitivity: "private",
      showAs: "busy",
      singleValueExtendedProperties: [{ value: input.observationId }],
      attendees: [{ emailAddress: { address: input.tutorEmail } }],
    });
    expect(
      request.mock.calls.some(([p]) =>
        p.includes("IMMUTABLE%2B%2FCase-Sensitive"),
      ),
    ).toBe(true);
  });
  it("recovers an uncertain creation by marker without sending a duplicate invitation", async () => {
    const { provider, request } = fixture(() => ({ value: [graphEvent] }));
    expect((await provider.createEvent(input)).id).toBe(graphEvent.id);
    expect(request.mock.calls.some(([, init]) => init?.method === "POST")).toBe(
      false,
    );
  });
  it("fails ambiguous recovery instead of inviting twice", async () => {
    const { provider } = fixture(() => ({
      value: [graphEvent, { ...graphEvent, id: "second" }],
    }));
    await expect(provider.findEvent(input)).rejects.toThrow("Multiple");
  });
  it("keeps missing or unverifiable readback pending", async () => {
    const { provider } = fixture((path, init) => {
      if (init?.method === "POST") return { id: graphEvent.id };
      if (path.includes("/events/")) throw new SitInError(404, "missing");
      return { value: [] };
    });
    await expect(provider.createEvent(input)).rejects.toThrow(
      "verification retry",
    );
  });
  it("cancels by immutable ID; a retry after deletion succeeds without resending", async () => {
    const { provider, request } = fixture(() => {
      throw new SitInError(404, "already deleted");
    });
    await expect(
      provider.cancelEvent({ ...input, eventId: graphEvent.id }),
    ).resolves.toBeUndefined();
    expect(request.mock.calls[0][1]?.method).toBe("DELETE");
    expect(request.mock.calls[0][0]).toContain("IMMUTABLE%2B%2FCase-Sensitive");
  });
});
