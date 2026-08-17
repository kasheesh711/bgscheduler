import { beforeEach, describe, expect, it, vi, type Mock } from "vitest";
import { NextRequest } from "next/server";

vi.mock("@/lib/auth", () => ({ auth: vi.fn() }));
vi.mock("@/lib/db", () => ({ getDb: vi.fn() }));
vi.mock("@/lib/student-report/db", () => ({ getParentClassReport: vi.fn() }));

import { auth } from "@/lib/auth";
import { getDb } from "@/lib/db";
import { getParentClassReport } from "@/lib/student-report/db";
import type { ParentReportPayload } from "@/lib/student-report/types";
import { GET as getReport } from "../route";

const authMock = auth as unknown as Mock;
const database = { name: "test-db" };

const payload: ParentReportPayload = {
  meta: {
    snapshotId: "snapshot-report-42",
    snapshotGeneratedAt: "2026-06-02T00:00:00.000Z",
    generatedAt: "2026-06-02T01:00:00.000Z",
    window: {
      fromDateKey: "2026-05-01",
      toDateKey: "2026-06-01",
      startUtc: "2026-04-30T17:00:00.000Z",
      endUtc: "2026-06-01T17:00:00.000Z",
      label: "1 May – 1 June 2026",
    },
    snapshotFloorDateKey: "2026-05-01",
    snapshotCeilingDateKey: "2026-06-01",
    floorWarning: false,
    ceilingWarning: false,
  },
  combined: { bucketTotals: [] },
  students: [],
};

function reportRequest(query: string) {
  return new NextRequest(`https://app.test/api/student-report?${query}`);
}

beforeEach(() => {
  vi.clearAllMocks();
  authMock.mockResolvedValue({ user: { email: "admin@begifted.test" } });
  vi.mocked(getDb).mockReturnValue(database as never);
});

describe("GET /api/student-report", () => {
  it("401s without a session", async () => {
    authMock.mockResolvedValue(null);
    const response = await getReport(
      reportRequest("student=a%3A%3Ab&from=2026-05-01&to=2026-06-01"),
    );
    expect(response.status).toBe(401);
    await expect(response.json()).resolves.toEqual({ error: "Unauthorized" });
    expect(getParentClassReport).not.toHaveBeenCalled();
  });

  it("400s when the student parameter is absent", async () => {
    const response = await getReport(reportRequest("from=2026-05-01&to=2026-06-01"));
    expect(response.status).toBe(400);
    await expect(response.json()).resolves.toMatchObject({ error: "Invalid request" });
    expect(getParentClassReport).not.toHaveBeenCalled();
  });

  it("400s on a malformed from date", async () => {
    const response = await getReport(
      reportRequest("student=a%3A%3Ab&from=2026-5-01&to=2026-06-01"),
    );
    expect(response.status).toBe(400);
    expect(getParentClassReport).not.toHaveBeenCalled();
  });

  it("400s when from is after to", async () => {
    const response = await getReport(
      reportRequest("student=a%3A%3Ab&from=2026-06-02&to=2026-06-01"),
    );
    expect(response.status).toBe(400);
    expect(getParentClassReport).not.toHaveBeenCalled();
  });

  it("400s when more than eight students are requested", async () => {
    const students = Array.from({ length: 9 }, (_, index) => `student=student-${index}`).join(
      "&",
    );
    const response = await getReport(
      reportRequest(`${students}&from=2026-05-01&to=2026-06-01`),
    );
    expect(response.status).toBe(400);
    expect(getParentClassReport).not.toHaveBeenCalled();
  });

  it("404s with the missing students from the report loader", async () => {
    const missing = ["ghost::one", "ghost::two"];
    vi.mocked(getParentClassReport).mockResolvedValue({
      status: "students-not-found",
      missing,
    });

    const response = await getReport(
      reportRequest("student=ghost%3A%3Aone&from=2026-05-01&to=2026-06-01"),
    );
    expect(response.status).toBe(404);
    await expect(response.json()).resolves.toEqual({
      error: "Some students were not found on the active snapshot",
      missing,
    });
  });

  it("503s when there is no active snapshot", async () => {
    vi.mocked(getParentClassReport).mockResolvedValue({ status: "no-snapshot" });
    const response = await getReport(
      reportRequest("student=a%3A%3Ab&from=2026-05-01&to=2026-06-01"),
    );
    expect(response.status).toBe(503);
    await expect(response.json()).resolves.toEqual({
      error: "No active credit-control snapshot",
    });
  });

  it("returns the payload verbatim and forwards repeated students", async () => {
    vi.mocked(getParentClassReport).mockResolvedValue({ status: "ok", payload });
    const response = await getReport(
      reportRequest(
        "student=student%3A%3Aone&student=student%3A%3Atwo&from=2026-05-01&to=2026-06-01",
      ),
    );

    expect(response.status).toBe(200);
    const body = await response.json();
    expect(body).toEqual(payload);
    expect(body.meta.snapshotId).toBe("snapshot-report-42");
    expect(vi.mocked(getParentClassReport)).toHaveBeenCalledWith(database, {
      studentKeys: ["student::one", "student::two"],
      from: "2026-05-01",
      to: "2026-06-01",
    });
  });

  it("500s with the failure message when the report loader throws", async () => {
    const error = new Error("db down");
    const consoleError = vi.spyOn(console, "error").mockImplementation(() => {});
    vi.mocked(getParentClassReport).mockRejectedValue(error);

    const response = await getReport(
      reportRequest("student=a%3A%3Ab&from=2026-05-01&to=2026-06-01"),
    );
    expect(response.status).toBe(500);
    await expect(response.json()).resolves.toEqual({ error: "db down" });
    expect(consoleError).toHaveBeenCalledWith("student-report GET failed", error);
    consoleError.mockRestore();
  });
});
