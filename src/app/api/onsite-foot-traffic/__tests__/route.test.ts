import { NextRequest } from "next/server";
import { beforeEach, describe, expect, it, vi, type Mock } from "vitest";

vi.mock("server-only", () => ({}));
vi.mock("@/lib/auth", () => ({ auth: vi.fn() }));
vi.mock("@/lib/db", () => ({ getDb: vi.fn(() => ({ test: true })) }));
vi.mock("@/lib/internal/cron-auth", () => ({ rejectInvalidCronSecret: vi.fn(() => null) }));
vi.mock("@/lib/data-health/cron-audit", () => ({
  withCronInvocationAudit: vi.fn((_input, handler: () => Promise<Response>) => handler()),
}));
vi.mock("@/lib/onsite-foot-traffic/data", () => ({
  parseFootTrafficFilters: vi.fn(() => ({ startDate: "2026-03-01", endDate: "2026-09-30" })),
  normalizeFootTrafficFilters: vi.fn((value) => value),
  getFootTrafficDashboard: vi.fn(),
  createFootTrafficReportSnapshot: vi.fn(),
}));
vi.mock("@/lib/onsite-foot-traffic/sync", () => ({ runOnsiteFootTrafficSync: vi.fn() }));

import { auth } from "@/lib/auth";
import { createFootTrafficReportSnapshot, getFootTrafficDashboard } from "@/lib/onsite-foot-traffic/data";
import { runOnsiteFootTrafficSync } from "@/lib/onsite-foot-traffic/sync";
import { GET as syncFootTraffic } from "../../internal/sync-onsite-foot-traffic/route";
import { GET as getDashboard } from "../route";
import { GET as getExport } from "../export/route";
import { POST as createReport } from "../reports/route";

const authMock = auth as unknown as Mock;

const summary = { studentVisits: 1, uniqueStudents: 1, onsiteClasses: 1, averageVisitsPerClass: 1, unidentifiedVisits: 0 };
const payload = {
  meta: { requestedStartDate: "2026-03-01", requestedEndDate: "2026-09-30", effectiveStartDate: "2026-03-01", effectiveEndDate: "2026-09-03", coverageStartDate: "2026-03-01", coverageEndDate: "2026-09-03", latestCompletedDate: "2026-09-03", dataAsOf: "2026-09-03", lastSuccessfulSyncAt: "2026-09-04T01:18:00Z", sourceSyncRunId: "run-1", timeZone: "Asia/Bangkok", source: "Wise PAST sessions", isEndDateCapped: true, isSeptemberMonthToDate: true, rooms: [], weekdays: [], availableRooms: ["Focus"] },
  summary,
  weekly: [], monthly: [], byWeekday: [], byRoom: [],
  dataQuality: { totalPastSessions: 1, countedOnsiteSessions: 1, excludedSessions: 0, cancelledSessions: 0, missedSessions: 0, notEndedSessions: 0, nonOnsiteSessions: 0, missingLocationSessions: 0, unknownRoomSessions: 0, onlineOnlyRoomSessions: 0, sessionsWithoutAttendanceEvidence: 0, participantsWithoutAttendanceEvidence: 0, unidentifiedVisits: 0 },
  visits: [{ attendanceDate: "2026-03-02", startTime: "10:00", weekStart: "2026-03-02", month: "2026-03", studentFingerprint: "fingerprint", wiseSessionId: "session-1", room: "Focus", subject: "Math", tutor: "Tutor", consumedCredits: 1 }],
};

beforeEach(() => {
  vi.resetAllMocks();
  authMock.mockResolvedValue({ user: { email: "admin@example.com" } });
  vi.mocked(getFootTrafficDashboard).mockResolvedValue(payload as never);
  vi.mocked(createFootTrafficReportSnapshot).mockResolvedValue({
    id: "report-1", createdByEmail: "admin@example.com", createdAt: "2026-09-04T02:00:00Z",
    expiresAt: "2026-10-04T02:00:00Z", payload,
  } as never);
  vi.mocked(runOnsiteFootTrafficSync).mockResolvedValue({
    ok: true,
    skipped: false,
    runId: "run-1",
    mode: "rolling",
    startDate: "2026-08-01",
    endDate: "2026-09-03",
    fetchedSessionCount: 1,
    storedSessionCount: 1,
    visitCount: 1,
    unknownRoomCount: 0,
    missingAttendanceEvidenceCount: 0,
    missingStableIdCount: 0,
  });
});

describe("onsite foot-traffic API", () => {
  it("requires authentication", async () => {
    authMock.mockResolvedValue(null);
    const response = await getDashboard(new Request("https://app.test/api/onsite-foot-traffic"));
    expect(response.status).toBe(401);
    expect(getFootTrafficDashboard).not.toHaveBeenCalled();
  });

  it("returns only aggregate dashboard fields, never visit details", async () => {
    const response = await getDashboard(new Request("https://app.test/api/onsite-foot-traffic"));
    const body = await response.json();
    expect(response.status).toBe(200);
    expect(body.summary.studentVisits).toBe(1);
    expect(body.visits).toBeUndefined();
  });

  it("rejects unknown CSV grains and exports a de-identified visit CSV", async () => {
    const invalid = await getExport(new Request("https://app.test/api/onsite-foot-traffic/export?grain=daily"));
    expect(invalid.status).toBe(400);
    const response = await getExport(new Request("https://app.test/api/onsite-foot-traffic/export?grain=visits"));
    expect(response.status).toBe(200);
    expect(response.headers.get("content-type")).toContain("text/csv");
    const bytes = new Uint8Array(await response.arrayBuffer());
    expect([...bytes.slice(0, 3)]).toEqual([0xef, 0xbb, 0xbf]);
    expect(new TextDecoder().decode(bytes)).toContain("fingerprint");
  });

  it("captures an immutable report and returns both download URLs", async () => {
    const response = await createReport(new Request("https://app.test/api/onsite-foot-traffic/reports", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ startDate: "2026-03-01", endDate: "2026-09-30" }),
    }));
    expect(response.status).toBe(201);
    await expect(response.json()).resolves.toMatchObject({
      reportId: "report-1",
      htmlUrl: "/api/onsite-foot-traffic/reports/report-1/html",
      pdfUrl: "/api/onsite-foot-traffic/reports/report-1/pdf",
    });
  });

  it("keeps scheduled syncs rolling and allows a secret-authenticated full backfill", async () => {
    const scheduled = await syncFootTraffic(new NextRequest("https://app.test/api/internal/sync-onsite-foot-traffic"));
    expect(scheduled.status).toBe(200);
    expect(runOnsiteFootTrafficSync).toHaveBeenLastCalledWith(
      { test: true },
      { triggerType: "cron" },
    );

    const backfill = await syncFootTraffic(new NextRequest(
      "https://app.test/api/internal/sync-onsite-foot-traffic?mode=backfill&startDate=2026-03-01&endDate=2026-09-03",
    ));
    expect(backfill.status).toBe(200);
    expect(runOnsiteFootTrafficSync).toHaveBeenLastCalledWith(
      { test: true },
      {
        mode: "backfill",
        startDate: "2026-03-01",
        endDate: "2026-09-03",
        triggerType: "manual",
      },
    );
  });

  it("rejects date overrides on the scheduled sync mode", async () => {
    const response = await syncFootTraffic(new NextRequest(
      "https://app.test/api/internal/sync-onsite-foot-traffic?startDate=2026-03-01",
    ));
    expect(response.status).toBe(400);
    expect(runOnsiteFootTrafficSync).not.toHaveBeenCalled();
  });
});
