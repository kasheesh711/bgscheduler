import { afterEach, describe, expect, it, vi } from "vitest";
import { WiseClient } from "../client";
import {
  checkTeacherAvailabilityForSessions,
  fetchWiseActivityEvents,
  fetchWiseClassroomStats,
  fetchWiseClassroomTrends,
  fetchWiseFeesPaidTrends,
  fetchWiseReceiptTransactions,
  fetchWiseSessionStats,
  fetchAllFutureSessions,
  fetchAllInstituteSessions,
  fetchAllTeachers,
  fetchInstituteLocations,
  fetchTeacherAvailability,
  fetchWiseAcceptedStudents,
  fetchWiseCourse,
  fetchWiseCourseParticipants,
  fetchWiseStudentRegistrationData,
  updateSessionLocation,
  updateWiseCourseSubject,
  updateWiseStudentRegistrationAnswers,
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

  it("paginates all institute sessions without status filter", async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(
        new Response(
          JSON.stringify({
            status: 200,
            data: {
              sessions: [{ _id: "feb", scheduledStartTime: "2026-02-28T17:00:00.000Z" }],
              page_number: 1,
              page_count: 2,
              totalRecords: 2,
            },
          }),
          { status: 200, headers: { "Content-Type": "application/json" } },
        ),
      )
      .mockResolvedValueOnce(
        new Response(
          JSON.stringify({
            status: 200,
            data: {
              sessions: [{ _id: "mar", scheduledStartTime: "2026-03-01T03:00:00.000Z" }],
              page_number: 2,
              page_count: 2,
              totalRecords: 2,
            },
          }),
          { status: 200, headers: { "Content-Type": "application/json" } },
        ),
      );
    global.fetch = fetchMock as typeof fetch;

    const sessions = await fetchAllInstituteSessions(makeClient(), "center-1");

    expect(sessions.map((session) => session._id)).toEqual(["feb", "mar"]);
    const firstUrl = new URL(fetchMock.mock.calls[0][0] as string);
    expect(firstUrl.pathname).toBe("/institutes/center-1/sessions");
    expect(firstUrl.searchParams.get("status")).toBeNull();
    expect(firstUrl.searchParams.get("paginateBy")).toBe("COUNT");
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

  it("fetches accepted students with registration-related query flags", async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(
        new Response(
          JSON.stringify({ data: { students: Array.from({ length: 100 }, (_, index) => ({ _id: `student-${index}` })) } }),
          { status: 200, headers: { "Content-Type": "application/json" } },
        ),
      )
      .mockResolvedValueOnce(
        new Response(
          JSON.stringify({ data: { students: [{ _id: "last-student" }] } }),
          { status: 200, headers: { "Content-Type": "application/json" } },
        ),
      );
    global.fetch = fetchMock as typeof fetch;

    const students = await fetchWiseAcceptedStudents(makeClient(), "center-1");

    expect(students).toHaveLength(101);
    const calledUrl = new URL(fetchMock.mock.calls[0][0] as string);
    expect(calledUrl.pathname).toBe("/institutes/v3/center-1/students");
    expect(calledUrl.searchParams.get("status")).toBe("ACCEPTED");
    expect(calledUrl.searchParams.get("showParents")).toBe("true");
    expect(calledUrl.searchParams.get("showFeedbackData")).toBe("true");
    expect(calledUrl.searchParams.get("showContractStatus")).toBe("true");
  });

  it("fetches and updates student registration fields", async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(
        new Response(
          JSON.stringify({
            data: {
              registrationData: {
                fields: [{ questionId: "if89sblj", answer: "Year 8" }],
              },
            },
          }),
          { status: 200, headers: { "Content-Type": "application/json" } },
        ),
      )
      .mockResolvedValueOnce(
        new Response(JSON.stringify({ status: 200, data: { ok: true } }), {
          status: 200,
          headers: { "Content-Type": "application/json" },
        }),
      );
    global.fetch = fetchMock as typeof fetch;

    const registration = await fetchWiseStudentRegistrationData(makeClient(), "center-1", "student-1");
    await updateWiseStudentRegistrationAnswers(makeClient(), "center-1", "student-1", [
      { questionId: "if89sblj", answer: "Year 9 / Grade 8" },
    ]);

    expect(registration.registrationData?.fields?.[0].answer).toBe("Year 8");
    expect(new URL(fetchMock.mock.calls[0][0] as string).pathname).toBe(
      "/institutes/center-1/participants/student-1",
    );
    expect(new URL(fetchMock.mock.calls[0][0] as string).searchParams.get("showRegistrationData")).toBe("true");
    expect(new URL(fetchMock.mock.calls[1][0] as string).pathname).toBe(
      "/institutes/center-1/students/student-1/registration",
    );
    expect(fetchMock.mock.calls[1][1]).toEqual(expect.objectContaining({
      method: "PUT",
      body: JSON.stringify({ answers: [{ questionId: "if89sblj", answer: "Year 9 / Grade 8" }] }),
    }));
  });

  it("fetches courses, course participants, and updates course subject", async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(
        new Response(JSON.stringify({ data: { _id: "class-1", subject: "Y2-8 / G1-7 (Int.)" } }), {
          status: 200,
          headers: { "Content-Type": "application/json" },
        }),
      )
      .mockResolvedValueOnce(
        new Response(JSON.stringify({ data: { students: [{ _id: "student-1", profile: "student" }] } }), {
          status: 200,
          headers: { "Content-Type": "application/json" },
        }),
      )
      .mockResolvedValueOnce(
        new Response(JSON.stringify({ status: 200, data: { ok: true } }), {
          status: 200,
          headers: { "Content-Type": "application/json" },
        }),
      );
    global.fetch = fetchMock as typeof fetch;

    const course = await fetchWiseCourse(makeClient(), "class-1");
    const participants = await fetchWiseCourseParticipants(makeClient(), "class-1");
    await updateWiseCourseSubject(makeClient(), "class-1", "Y9-11 / G8-10 (Int.)");

    expect(course?.subject).toBe("Y2-8 / G1-7 (Int.)");
    expect(participants).toEqual([{ _id: "student-1", profile: "student" }]);
    expect(new URL(fetchMock.mock.calls[0][0] as string).pathname).toBe("/user/v2/classes/class-1");
    expect(new URL(fetchMock.mock.calls[0][0] as string).searchParams.get("full")).toBe("true");
    expect(new URL(fetchMock.mock.calls[1][0] as string).pathname).toBe("/user/classes/class-1/participants");
    expect(new URL(fetchMock.mock.calls[1][0] as string).searchParams.get("showCoTeachers")).toBe("true");
    expect(new URL(fetchMock.mock.calls[2][0] as string).pathname).toBe("/teacher/editClass");
    expect(fetchMock.mock.calls[2][1]).toEqual(expect.objectContaining({
      method: "PUT",
      body: JSON.stringify({ classId: "class-1", subject: "Y9-11 / G8-10 (Int.)" }),
    }));
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
      locationToCheck: "Joy",
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

    await updateSessionLocation(makeClient(), "class-1", "session-1", "Joy");

    const calledUrl = new URL(fetchMock.mock.calls[0][0] as string);
    expect(calledUrl.pathname).toBe("/teacher/classes/class-1/sessions/session-1");
    expect(calledUrl.searchParams.get("updateType")).toBe("SINGLE");
    expect(fetchMock.mock.calls[0][1]).toEqual(
      expect.objectContaining({
        method: "PUT",
        body: JSON.stringify({ location: "Joy" }),
      }),
    );
  });

  it("fetches Wise activity events with supported filters and caps page size at 50", async () => {
    const fetchMock = vi.fn().mockResolvedValue(
      new Response(
        JSON.stringify({
          status: 200,
          data: {
            events: [
              {
                event: {
                  eventId: "event-1",
                  eventName: "SessionUpdatedEvent",
                  eventTimestamp: "2026-05-28T05:00:00.000Z",
                  type: "SESSION",
                },
              },
            ],
          },
        }),
        { status: 200, headers: { "Content-Type": "application/json" } },
      ),
    );
    global.fetch = fetchMock as typeof fetch;

    const events = await fetchWiseActivityEvents(makeClient(), "center-1", {
      pageNumber: 2,
      pageSize: 100,
      type: "SESSION",
      eventName: "SessionUpdatedEvent",
      userId: "user-1",
      classIds: ["class-1", "class-2"],
    });

    expect(events).toHaveLength(1);
    const calledUrl = new URL(fetchMock.mock.calls[0][0] as string);
    expect(calledUrl.pathname).toBe("/institutes/center-1/events");
    expect(calledUrl.searchParams.get("page_number")).toBe("2");
    expect(calledUrl.searchParams.get("page_size")).toBe("50");
    expect(calledUrl.searchParams.get("type")).toBe("SESSION");
    expect(calledUrl.searchParams.get("eventName")).toBe("SessionUpdatedEvent");
    expect(calledUrl.searchParams.get("userId")).toBe("user-1");
    expect(calledUrl.searchParams.get("classIds")).toBe("class-1,class-2");
  });

  it("fetches Wise analytics summary endpoints", async () => {
    const fetchMock = vi.fn().mockImplementation(() => Promise.resolve(
      new Response(JSON.stringify({ status: 200, data: { ok: true } }), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      }),
    ));
    global.fetch = fetchMock as typeof fetch;

    await fetchWiseSessionStats(makeClient(), "center-1", {
      from: new Date("2026-05-01T00:00:00.000Z"),
      to: new Date("2026-05-28T00:00:00.000Z"),
    });
    await fetchWiseClassroomStats(makeClient(), "center-1");
    await fetchWiseClassroomTrends(makeClient(), "center-1");

    const paths = fetchMock.mock.calls.map((call) => new URL(call[0] as string).pathname);
    expect(paths).toEqual([
      "/institutes/center-1/analytics/sessionStats",
      "/institutes/center-1/analytics/classroomStats",
      "/institutes/center-1/analytics/classroomTrends",
    ]);
    const sessionStatsUrl = new URL(fetchMock.mock.calls[0][0] as string);
    expect(sessionStatsUrl.searchParams.get("from")).toBe("2026-05-01T00:00:00.000Z");
    expect(sessionStatsUrl.searchParams.get("to")).toBe("2026-05-28T00:00:00.000Z");
  });

  it("fetches Wise fees-paid trends with Bangkok web headers and normalizes THB minor units", async () => {
    const fetchMock = vi.fn().mockResolvedValue(
      new Response(JSON.stringify({
        status: 200,
        data: {
          trends: {
            feesPaid: {
              trends: [{
                timestamp: "2026-04-30T17:00:00.000Z",
                count: 148,
                amount: { value: 344046000, currency: "THB" },
              }],
            },
          },
        },
      }), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      }),
    );
    global.fetch = fetchMock as typeof fetch;

    const trends = await fetchWiseFeesPaidTrends(makeClient(), "center-1");

    const calledUrl = new URL(fetchMock.mock.calls[0][0] as string);
    expect(calledUrl.pathname).toBe("/institutes/center-1/trends");
    expect(calledUrl.searchParams.get("showFeeCollectionTrends")).toBe("true");
    expect(calledUrl.searchParams.get("showPayoutTrends")).toBe("true");
    expect(fetchMock.mock.calls[0][1]).toEqual(expect.objectContaining({
      headers: expect.objectContaining({
        "x-wise-timezone": "Asia/Bangkok",
        "x-wise-platform": "web",
      }),
    }));
    expect(trends).toEqual([{
      timestamp: "2026-04-30T17:00:00.000Z",
      count: 148,
      amountMinor: 344046000,
      amount: 3440460,
      currency: "THB",
    }]);
  });

  it("fetches Wise receipt transactions with web filters, Bangkok dates, pagination, and normalized THB amounts", async () => {
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(
        new Response(JSON.stringify({
          status: 200,
          data: {
            transactions: [{
              _id: "receipt-1",
              type: "OFFLINE_PAYMENT",
              status: "CHARGED",
              amount: { value: 3_569_360_00, currency: "THB" },
              note: "Paid Offline",
              chargedAt: "2026-05-28T10:49:03.973Z",
              createdAt: "2026-05-28T10:49:03.975Z",
              classId: "class-1",
              studentId: "student-1",
              metadata: {
                classId: "class-1",
                invoiceNumber: "INV-100",
                paymentOptionId: "payment-option-1",
              },
              classroom: { _id: "class-1", name: "Minnie Math", subject: "Math" },
              student: { _id: "student-1", name: "Minnie Smith" },
              parents: [{ _id: "parent-1", name: "Parent Minnie" }],
            }],
            page_count: 2,
            page_number: 1,
            page_size: 50,
            totalRecords: 2,
          },
        }), {
          status: 200,
          headers: { "Content-Type": "application/json" },
        }),
      )
      .mockResolvedValueOnce(
        new Response(JSON.stringify({
          status: 200,
          data: {
            transactions: [{
              _id: "receipt-2",
              type: "PAYMENT",
              status: "CHARGED",
              amount: { value: 10_000, currency: "THB" },
              chargedAt: "2026-05-28T11:00:00.000Z",
            }],
            page_count: 2,
            page_number: 2,
            page_size: 50,
            totalRecords: 2,
          },
        }), {
          status: 200,
          headers: { "Content-Type": "application/json" },
        }),
      );
    global.fetch = fetchMock as typeof fetch;

    const receipts = await fetchWiseReceiptTransactions(makeClient(), "center-1", {
      startDate: "2026-05-01",
      endDate: "2026-05-28",
    });

    expect(fetchMock).toHaveBeenCalledTimes(2);
    const firstUrl = new URL(fetchMock.mock.calls[0][0] as string);
    expect(firstUrl.pathname).toBe("/institutes/center-1/fees/transactions");
    expect(firstUrl.searchParams.get("type")).toBe("PAYMENT,OFFLINE_PAYMENT,DISBURSAL");
    expect(firstUrl.searchParams.get("status")).toBe("CHARGED,PENDING_CONFIRMATION");
    expect(firstUrl.searchParams.get("populateParticipant")).toBe("true");
    expect(firstUrl.searchParams.get("populateClassroom")).toBe("true");
    expect(firstUrl.searchParams.get("page_size")).toBe("50");
    expect(firstUrl.searchParams.get("page_number")).toBe("1");
    expect(firstUrl.searchParams.get("startDate")).toBe("2026-04-30T17:00:00.000Z");
    expect(firstUrl.searchParams.get("endDate")).toBe("2026-05-28T16:59:59.999Z");
    expect(fetchMock.mock.calls[0][1]).toEqual(expect.objectContaining({
      headers: expect.objectContaining({
        "x-wise-timezone": "Asia/Bangkok",
        "x-wise-platform": "web",
      }),
    }));
    const secondUrl = new URL(fetchMock.mock.calls[1][0] as string);
    expect(secondUrl.searchParams.get("page_number")).toBe("2");
    expect(receipts).toMatchObject([{
      id: "receipt-1",
      type: "OFFLINE_PAYMENT",
      status: "CHARGED",
      amountMinor: 356_936_000,
      amount: 3_569_360,
      currency: "THB",
      chargedAt: "2026-05-28T10:49:03.973Z",
      classId: "class-1",
      studentId: "student-1",
      studentName: "Minnie Smith",
      parentNames: ["Parent Minnie"],
      identifiers: expect.arrayContaining(["receipt-1", "INV-100", "payment-option-1"]),
    }, {
      id: "receipt-2",
      amountMinor: 10_000,
      amount: 100,
    }]);
  });
});
