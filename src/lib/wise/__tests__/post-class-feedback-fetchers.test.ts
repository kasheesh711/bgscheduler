import { afterEach, describe, expect, it, vi } from "vitest";
import { WiseClient } from "../client";
import { fetchWisePastSessionsByBangkokDate, fetchWiseSessionDetail } from "../fetchers";

describe("Wise post-class feedback fetchers", () => {
  const originalFetch = global.fetch;

  afterEach(() => {
    global.fetch = originalFetch;
    vi.restoreAllMocks();
  });

  function makeClient() {
    return new WiseClient({
      userId: "user",
      apiKey: "key",
      namespace: "begifted-education",
      maxRetries: 0,
    });
  }

  it("uses a bounded DATE-mode PAST session query", async () => {
    const fetchMock = vi.fn().mockResolvedValue(new Response(JSON.stringify({
      data: {
        sessions: [{
          _id: "session-1",
          scheduledStartTime: "2026-07-20T09:00:00Z",
          scheduledEndTime: "2026-07-20T10:00:00Z",
        }],
        page_count: 1,
      },
    }), { status: 200, headers: { "content-type": "application/json" } }));
    global.fetch = fetchMock as typeof fetch;

    const result = await fetchWisePastSessionsByBangkokDate(
      makeClient(),
      "institute-1",
      "2026-07-18",
      "2026-07-21",
    );
    expect(result).toHaveLength(1);
    const url = new URL(fetchMock.mock.calls[0][0] as string);
    expect(url.pathname).toBe("/institutes/institute-1/sessions");
    expect(Object.fromEntries(url.searchParams)).toMatchObject({
      status: "PAST",
      paginateBy: "DATE",
      startDate: "2026-07-18",
      endDate: "2026-07-21",
    });
  });

  it("requests the canonical feedback form, submission, and insight data", async () => {
    const fetchMock = vi.fn().mockResolvedValue(new Response(JSON.stringify({
      data: {
        _id: "session-1",
        scheduledStartTime: "2026-07-20T09:00:00Z",
        scheduledEndTime: "2026-07-20T10:00:00Z",
        feedbackForm: { questions: [] },
        feedbackSubmissions: [],
      },
    }), { status: 200, headers: { "content-type": "application/json" } }));
    global.fetch = fetchMock as typeof fetch;

    await fetchWiseSessionDetail(makeClient(), "class-1", "session-1");
    const url = new URL(fetchMock.mock.calls[0][0] as string);
    expect(url.pathname).toBe("/user/classes/class-1/sessions/session-1");
    expect(Object.fromEntries(url.searchParams)).toMatchObject({
      showLiveClassInsight: "true",
      showFeedbackConfig: "true",
      showFeedbackSubmission: "true",
    });
  });
});

