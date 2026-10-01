import { afterEach, describe, expect, it, vi } from "vitest";

import {
  fetchWorkforceAvailabilityWindow,
  fetchWorkforceSourceWindow,
  WorkforceRequestBudget,
  WorkforceSourceFetchError,
  normalizeStudentCreditEvidence,
  probeWorkforceSources,
} from "../wise-source";
import { WiseClient } from "@/lib/wise/client";

const originalFetch = globalThis.fetch;
afterEach(() => { globalThis.fetch = originalFetch; vi.restoreAllMocks(); vi.unstubAllEnvs(); });

function client(maxRequests = 20) {
  const budget = new WorkforceRequestBudget(maxRequests);
  const wise = new WiseClient({
    userId: "fixture", apiKey: "fixture", namespace: "fixture",
    maxRetries: 0, maxConcurrency: 1, stopOnRateLimit: true,
    beforeRequest: budget.beforeRequest,
  });
  return { wise, budget };
}

function session(id: string, extra: Record<string, unknown> = {}) {
  return {
    _id: id, classId: { _id: "class-1", name: "Year 8 Mathematics" },
    scheduledStartTime: "2026-03-02T03:00:00.000Z", scheduledEndTime: "2026-03-02T04:00:00.000Z",
    meetingStatus: "ENDED", userId: { _id: "wise-user-1" }, teacherId: "wise-teacher-1",
    students: ["student-1"], ...extra,
  };
}

describe("workforce Wise source adapter", () => {
  it("keeps an unexpectedly empty final advertised page incomplete", async () => {
    const { wise, budget } = client();
    const pages = [ { data: { sessions: [session("s1")], page_count: 2 } }, { data: { sessions: [], page_count: 2 } } ];
    globalThis.fetch = vi.fn(async () => Response.json(pages.shift()));
    const result = await fetchWorkforceSourceWindow({ from: "2026-03-01", to: "2026-03-02", maxRequests: 4 }, { client: wise, budget, instituteId: "inst" });
    expect(result.complete).toBe(false);
    expect(result.contractIssues).toContain("EMPTY_ADVERTISED_SESSION_PAGE");
  });

  it("reports consumed requests and returned pages when a later page fails", async () => {
    const { wise, budget } = client(4);
    globalThis.fetch = vi.fn().mockResolvedValueOnce(Response.json({ data: { sessions: [session("s1")], page_count: 2 } }))
      .mockRejectedValueOnce(new Error("fixture connection failure"));
    let failure: unknown;
    try { await fetchWorkforceSourceWindow({ from: "2026-03-01", to: "2026-03-02", maxRequests: 4 }, { client: wise, budget, instituteId: "inst" }); }
    catch (error) { failure = error; }
    expect(failure).toBeInstanceOf(WorkforceSourceFetchError);
    expect(failure).toMatchObject({ requests: 2, pagesReturned: 1 });
    expect(globalThis.fetch).toHaveBeenCalledTimes(2);
  });

  it("does not conclude credit normal charges when the probe budget never reached them", async () => {
    vi.stubEnv("WISE_USER_ID", "fixture"); vi.stubEnv("WISE_API_KEY", "fixture"); vi.stubEnv("WISE_INSTITUTE_ID", "fixture");
    globalThis.fetch = vi.fn(async () => Response.json({ data: { sessions: [session("s1")], page_count: 1 } }));
    const result = await probeWorkforceSources({ from: "2026-03-01", to: "2026-03-01", maxRequests: 1, maxPages: 1, maxDates: 1, maxCreditExamples: 1, availabilityTeacherUserIds: [], creditExamples: [{ label: "normal", classId: "class-1", studentId: "student-1", sessionId: "s1" }] });
    expect(result.conclusions.historicalNormalCharges).toBe("unknown");
    expect(result.contractIssues).toContain("REQUEST_CAP_EXHAUSTED");
  });
  it("requests the next page at an exact page-size boundary and deduplicates by session ID", async () => {
    const { wise, budget } = client();
    const pages: unknown[] = [
      { data: { sessions: [session("s1", { title: "In-Person Session - Physics", purpose: "TRIAL", classId: { _id: "class-1", name: "Year 8 Mathematics", classType: "GROUP" } }), session("s2")], page_number: 1, page_count: 2 } },
      { data: { sessions: [session("s2"), session("s3")], page_number: 2, page_count: 2 } },
    ];
    globalThis.fetch = vi.fn(async () => Response.json(pages.shift()));

    const result = await fetchWorkforceSourceWindow({ from: "2026-03-01", to: "2026-03-02", pageSize: 2, maxPages: 4, maxRequests: 4 }, { client: wise, budget, instituteId: "inst" });
    expect(result.paging.pagesReturned).toBe(2);
    expect(result.sessions.map((row) => row.wiseSessionId)).toEqual(["s1", "s2", "s3"]);
    expect(result.sessions[0].classTitle).toBe("In-Person Session - Physics");
    expect(result.sessions[0].wiseClassId).toBe("class-1");
    expect(result.sessions[0].bookingClassificationSource).toEqual({ classType: "GROUP", purpose: "TRIAL", title: "In-Person Session - Physics" });
    expect(result.contractIssues).toContain("DUPLICATE_SESSION_ID");
  });

  it("collects exact session credit rows by deduplicated class/student pairs without supplied examples", async () => {
    const { wise, budget } = client(3);
    const urls: string[] = [];
    globalThis.fetch = vi.fn(async (url) => {
      urls.push(String(url));
      if (String(url).includes("sessionCredits")) return Response.json({ data: { credits: { consumed: 99 }, sessionCreditHistory: [
        { _id: "s1", type: "SESSION", credit: 1 }, { _id: "s2", type: "SESSION", credit: 0 }, { _id: "s3", type: "SESSION" },
      ] } });
      return Response.json({ data: { sessions: [session("s1"), session("s2"), session("s3")], page_count: 1 } });
    });
    const result = await fetchWorkforceSourceWindow({ from: "2026-03-01", to: "2026-03-03", maxRequests: 3 }, { client: wise, budget, instituteId: "inst" });
    expect(urls.filter(url => url.includes("sessionCredits"))).toHaveLength(1);
    expect(result.credits.map(row => row.netCredits)).toEqual([1, 0, null]);
    expect(result.credits.map(row => row.evidenceStatus)).toEqual(["verified", "verified", "unknown"]);
    expect(result.sessions.every(row => row.participantCompleteness === "partial")).toBe(true);
    expect(result.paging.requests).toBe(2);
  });

  it("retains unknown financial rows when session retrieval consumes the budget", async () => {
    const { wise, budget } = client(1);
    globalThis.fetch = vi.fn(async () => Response.json({ data: { sessions: [session("s1")], page_count: 1 } }));
    const result = await fetchWorkforceSourceWindow({ from: "2026-03-01", to: "2026-03-03", maxRequests: 1 }, { client: wise, budget, instituteId: "inst" });
    expect(result).toMatchObject({ complete: true, paging: { requests: 1 } });
    expect(result.credits[0]).toMatchObject({ netCredits: null, evidenceStatus: "unknown", normalCredits: 1 });
    expect(globalThis.fetch).toHaveBeenCalledTimes(1);
  });

  it("keeps absent historical participant arrays unknown", async () => {
    const { wise, budget } = client();
    globalThis.fetch = vi.fn(async () => Response.json({ data: { sessions: [session("s1", { students: undefined })], page_count: 1 } }));
    const result = await fetchWorkforceSourceWindow({ from: "2026-03-01", to: "2026-03-01", maxRequests: 2 }, { client: wise, budget, instituteId: "inst" });
    expect(result.sessions[0].historicalBookedStudentIds).toBeNull();
    expect(result.sessions[0].participantCompleteness).toBe("unknown");
  });

  it("marks session-credit history and normal charges unknown until their semantics are verified", () => {
    const ambiguousRefund = normalizeStudentCreditEvidence({
      wiseSessionId: "s1", wiseStudentId: "student-1", observedAt: "2026-10-01T00:00:00.000Z",
      history: [{ _id: "s1", credit: -1, type: "refund" }],
    });
    const unverifiedNormal = normalizeStudentCreditEvidence({
      wiseSessionId: "s2", wiseStudentId: "student-2", observedAt: "2026-10-01T00:00:00.000Z",
      history: [{ _id: "s2", credit: 1, type: "normal" }],
    });
    expect(ambiguousRefund.netCredits).toBeNull();
    expect(ambiguousRefund.evidenceStatus).toBe("unknown");
    expect(unverifiedNormal.normalCredits).toBeNull();
    expect(unverifiedNormal.sourceInterpretation).toBe("unverified_historical_normal_charge");
    const verifiedNetWithoutNormal = normalizeStudentCreditEvidence({
      wiseSessionId: "s3", wiseStudentId: "student-3", observedAt: "2026-10-01T00:00:00.000Z",
      history: [{ _id: "s3", credit: 2, type: "SESSION" }, { _id: "other", credit: -1, type: "CREDIT" }],
    });
    expect(verifiedNetWithoutNormal.netCredits).toBe(2);
    expect(verifiedNetWithoutNormal.normalCredits).toBeNull();
    expect(verifiedNetWithoutNormal.evidenceStatus).toBe("verified");
  });

  it("derives the normal charge from scheduled duration under the owner-confirmed credit-hour rule", () => {
    const twoHourSession = normalizeStudentCreditEvidence({
      wiseSessionId: "s4", wiseStudentId: "student-4", observedAt: "2026-10-01T00:00:00.000Z",
      scheduledMinutes: 120, history: [{ _id: "s4", credit: 1, type: "SESSION" }],
    });
    expect(twoHourSession.normalCredits).toBe(2);
    expect(twoHourSession.netCredits).toBe(1);
    expect(twoHourSession.issueCodes).toContain("OWNER_CONFIRMED_ONE_CREDIT_PER_HOUR");
  });

  it("keeps coverage incomplete when the request cap prevents fetching a page", async () => {
    const { wise, budget } = client(1);
    globalThis.fetch = vi.fn(async () => Response.json({ data: { sessions: [session("s1")], page_count: 2 } }));
    const result = await fetchWorkforceSourceWindow({ from: "2026-03-01", to: "2026-03-01", pageSize: 1, maxPages: 4, maxRequests: 1 }, { client: wise, budget, instituteId: "inst" });
    expect(result.complete).toBe(false);
    expect(result.completeness).toBe("partial");
    expect(result.contractIssues).toContain("REQUEST_CAP_EXHAUSTED");
  });

  it("keeps every outbound request GET-only", async () => {
    const { wise, budget } = client();
    const methods: string[] = [];
    globalThis.fetch = vi.fn(async (_url, init) => {
      methods.push(String(init?.method));
      return Response.json({ data: { sessions: [], page_count: 0 } });
    });
    await fetchWorkforceSourceWindow({ from: "2026-03-01", to: "2026-03-01", maxRequests: 2 }, { client: wise, budget, instituteId: "inst" });
    expect(methods.length).toBeGreaterThan(0);
    expect(methods.every((method) => method === "GET")).toBe(true);
  });
  it("rejects availability spans wider than seven days", async () => {
    const { wise } = client();
    const spy = vi.fn(async () => Response.json({ data: { workingHours: { slots: [] } } }));
    globalThis.fetch = spy;
    const start = new Date("2026-03-01T00:00:00.000Z");
    await expect(fetchWorkforceAvailabilityWindow(wise, "inst", "teacher", start, new Date("2026-03-08T00:00:00.000Z"))).resolves.toBeDefined();
    await expect(fetchWorkforceAvailabilityWindow(wise, "inst", "teacher", start, new Date("2026-03-08T00:00:00.001Z"))).rejects.toThrow("no wider than 7 days");
    expect(spy).toHaveBeenCalledTimes(1);
  });

  it("keeps complete session coverage when the request cap only blocks a credit example", async () => {
    const { wise, budget } = client(1);
    globalThis.fetch = vi.fn(async () => Response.json({ data: { sessions: [], page_count: 0 } }));
    const result = await fetchWorkforceSourceWindow({
      from: "2026-03-01", to: "2026-03-01", maxRequests: 1,
      creditExamples: [{ classId: "class-1", studentId: "student-1", sessionId: "session-1" }],
    }, { client: wise, budget, instituteId: "inst" });
    expect(result.complete).toBe(true);
    expect(result.completeness).toBe("complete");
    expect(result.contractIssues).toContain("CREDIT_EXAMPLE_REQUEST_CAP_EXHAUSTED");
  });
});
