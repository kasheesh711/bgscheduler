import { afterEach, describe, expect, it, vi } from "vitest";
import { WiseClient } from "../client";
import {
  checkTeacherAvailabilityForSessions,
  fetchAllFutureSessions,
  fetchAllTeachers,
  fetchInstituteLocations,
  fetchTeacherAvailability,
  updateSessionLocation,
} from "../fetchers";

describe("Wise fetchers", () => {
  const originalFetch = global.fetch;

  afterEach(() => {
    global.fetch = originalFetch;
    vi.restoreAllMocks();
  });

  function makeClient() {
    return new WiseClient({
      userId: "user-123",
      apiKey: "api-key-456",
      namespace: "begifted-education",
      maxRetries: 0,
    });
  }

  it("parses teachers from data.teachers", async () => {
    const fetchMock = vi.fn().mockResolvedValue(
      new Response(
        JSON.stringify({
          status: 200,
          message: "Success",
          data: {
            teachers: [
              {
                _id: "teacher-record-1",
                userId: {
                  _id: "wise-user-1",
                  name: "Teacher One",
                },
                tags: ["Math (Int.) Y2-8"],
              },
            ],
          },
        }),
        { status: 200, headers: { "Content-Type": "application/json" } }
      )
    );
    global.fetch = fetchMock as typeof fetch;

    const teachers = await fetchAllTeachers(makeClient(), "center-1");

    expect(teachers).toEqual([
      expect.objectContaining({
        _id: "teacher-record-1",
        userId: expect.objectContaining({
          _id: "wise-user-1",
          name: "Teacher One",
        }),
        tags: ["Math (Int.) Y2-8"],
      }),
    ]);
  });

  it("unwraps availability from data and uses startTime/endTime params", async () => {
    const fetchMock = vi.fn().mockResolvedValue(
      new Response(
        JSON.stringify({
          status: 200,
          message: "Success",
          data: {
            workingHours: {
              slots: [{ day: "Sunday", startTime: "09:00", endTime: "12:00" }],
            },
            leaves: [],
          },
        }),
        { status: 200, headers: { "Content-Type": "application/json" } }
      )
    );
    global.fetch = fetchMock as typeof fetch;

    const startTime = new Date("2026-04-07T00:00:00.000Z");
    const endTime = new Date("2026-04-14T00:00:00.000Z");
    const availability = await fetchTeacherAvailability(
      makeClient(),
      "center-1",
      "wise-user-1",
      startTime,
      endTime
    );

    expect(availability.workingHours?.slots).toHaveLength(1);

    const calledUrl = new URL(fetchMock.mock.calls[0][0] as string);
    expect(calledUrl.pathname).toBe("/institutes/center-1/teachers/wise-user-1/availability");
    expect(calledUrl.searchParams.get("startTime")).toBe(startTime.toISOString());
    expect(calledUrl.searchParams.get("endTime")).toBe(endTime.toISOString());
  });

  it("paginates sessions using COUNT mode and page_number/page_size", async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(
        new Response(
          JSON.stringify({
            status: 200,
            message: "Success",
            data: {
              sessions: [
                {
                  _id: "s1",
                  scheduledStartTime: "2026-04-07T00:00:00.000Z",
                  scheduledEndTime: "2026-04-07T01:00:00.000Z",
                },
              ],
              page_number: 1,
              page_count: 2,
              totalRecords: 2,
            },
          }),
          { status: 200, headers: { "Content-Type": "application/json" } }
        )
      )
      .mockResolvedValueOnce(
        new Response(
          JSON.stringify({
            status: 200,
            message: "Success",
            data: {
              sessions: [
                {
                  _id: "s2",
                  scheduledStartTime: "2026-04-08T00:00:00.000Z",
                  scheduledEndTime: "2026-04-08T01:00:00.000Z",
                },
              ],
              page_number: 2,
              page_count: 2,
              totalRecords: 2,
            },
          }),
          { status: 200, headers: { "Content-Type": "application/json" } }
        )
      );
    global.fetch = fetchMock as typeof fetch;

    const sessions = await fetchAllFutureSessions(makeClient(), "center-1");

    expect(sessions.map((session) => session._id)).toEqual(["s1", "s2"]);
    const firstUrl = new URL(fetchMock.mock.calls[0][0] as string);
    expect(firstUrl.searchParams.get("paginateBy")).toBe("COUNT");
    expect(firstUrl.searchParams.get("page_number")).toBe("1");
    expect(firstUrl.searchParams.get("page_size")).toBe("1000");
  });

  it("fetches institute location strings from data.locations", async () => {
    const fetchMock = vi.fn().mockResolvedValue(
      new Response(
        JSON.stringify({
          status: 200,
          data: { locations: ["Joy", "Relax"] },
        }),
        { status: 200, headers: { "Content-Type": "application/json" } }
      )
    );
    global.fetch = fetchMock as typeof fetch;

    const locations = await fetchInstituteLocations(makeClient(), "center-1");

    expect(locations).toEqual(["Joy", "Relax"]);
    expect(new URL(fetchMock.mock.calls[0][0] as string).pathname).toBe("/institutes/center-1/locations");
  });

  it("checks teacher availability for sessions with the Wise webapp endpoint", async () => {
    const fetchMock = vi.fn().mockResolvedValue(
      new Response(
        JSON.stringify({
          status: 200,
          data: { sessions: [{ sessionId: "session-1", conflict: false }] },
        }),
        { status: 200, headers: { "Content-Type": "application/json" } }
      )
    );
    global.fetch = fetchMock as typeof fetch;

    const body = {
      sessions: [
        {
          teacherId: "teacher-user-1",
          sessionId: "session-1",
          scheduledStartTime: "2026-05-14T09:00:00.000Z",
          scheduledEndTime: "2026-05-14T10:00:00.000Z",
          type: "OFFLINE",
        },
      ],
      locationToCheck: "Joy (TV)",
    };
    const result = await checkTeacherAvailabilityForSessions(makeClient(), "center-1", body);

    expect(result.sessions?.[0]).toEqual({ sessionId: "session-1", conflict: false });
    expect(new URL(fetchMock.mock.calls[0][0] as string).pathname).toBe(
      "/institutes/center-1/checkSessionsAvailability",
    );
    expect(JSON.parse(fetchMock.mock.calls[0][1].body as string)).toEqual(body);
  });

  it("updates a single session location with PUT body { location }", async () => {
    const fetchMock = vi.fn().mockResolvedValue(
      new Response(JSON.stringify({ status: 200, data: { ok: true } }), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      })
    );
    global.fetch = fetchMock as typeof fetch;

    await updateSessionLocation(makeClient(), "class-1", "session-1", "Joy (TV)");

    const calledUrl = new URL(fetchMock.mock.calls[0][0] as string);
    expect(calledUrl.pathname).toBe("/teacher/classes/class-1/sessions/session-1");
    expect(calledUrl.searchParams.get("updateType")).toBe("SINGLE");
    expect(fetchMock.mock.calls[0][1]).toEqual(
      expect.objectContaining({
        method: "PUT",
        body: JSON.stringify({ location: "Joy (TV)" }),
      }),
    );
  });
});
