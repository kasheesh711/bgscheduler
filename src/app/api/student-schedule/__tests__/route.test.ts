import { beforeEach, describe, expect, it, vi, type Mock } from "vitest";
import { NextRequest } from "next/server";

vi.mock("@/lib/auth", () => ({ auth: vi.fn() }));
vi.mock("@/lib/db", () => ({ getDb: vi.fn() }));
vi.mock("@/lib/student-schedule/data", () => ({ getStudentMonthlySchedule: vi.fn() }));
vi.mock("@/lib/student-schedule/links", () => ({
  DEFAULT_LINK_TTL_DAYS: 30,
  mintStudentScheduleLink: vi.fn(),
  studentScheduleLinkUrl: (base: string, token: string) => `${base}/schedule/${token}`,
}));

import { auth } from "@/lib/auth";
import { getStudentMonthlySchedule } from "@/lib/student-schedule/data";
import { mintStudentScheduleLink } from "@/lib/student-schedule/links";
import { GET as getSchedule } from "../route";
import { POST as postLink } from "../link/route";

const authMock = auth as unknown as Mock;

const payload = {
  student: {
    studentKey: "aadhiya srisethi::nok srisethi",
    wiseStudentId: "stu_1",
    studentName: "Aadhiya (Aadhu.Sr) Srisethi",
    parentName: "Nok Srisethi",
    code: "Aadhu.Sr",
    shortName: "Aadhu",
  },
  monthKey: "2026-08",
  monthLabel: "August 2026",
  sessions: [],
  generatedAt: "2026-08-01T00:00:00.000Z",
};

function scheduleRequest(query: string) {
  return new NextRequest(`https://app.test/api/student-schedule?${query}`);
}

function linkRequest(body: unknown) {
  return new NextRequest("https://app.test/api/student-schedule/link", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: typeof body === "string" ? body : JSON.stringify(body),
  });
}

beforeEach(() => {
  vi.clearAllMocks();
  authMock.mockResolvedValue({ user: { email: "admin@begifted.test" } });
});

describe("GET /api/student-schedule", () => {
  it("401s without a session", async () => {
    authMock.mockResolvedValue(null);
    const response = await getSchedule(scheduleRequest("studentKey=k&month=2026-08"));
    expect(response.status).toBe(401);
    expect(getStudentMonthlySchedule).not.toHaveBeenCalled();
  });

  it("400s on a missing or malformed month", async () => {
    for (const query of ["studentKey=k", "studentKey=k&month=2026-8", "month=2026-08"]) {
      const response = await getSchedule(scheduleRequest(query));
      expect(response.status).toBe(400);
    }
    expect(getStudentMonthlySchedule).not.toHaveBeenCalled();
  });

  it("404s for an unknown student", async () => {
    vi.mocked(getStudentMonthlySchedule).mockResolvedValue(null);
    const response = await getSchedule(scheduleRequest("studentKey=ghost&month=2026-08"));
    expect(response.status).toBe(404);
  });

  it("returns the payload for a valid request", async () => {
    vi.mocked(getStudentMonthlySchedule).mockResolvedValue(payload as never);
    const response = await getSchedule(scheduleRequest("studentKey=k&month=2026-08"));
    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toMatchObject({ monthKey: "2026-08" });
  });

  it("500s with the failure message when the read throws", async () => {
    vi.mocked(getStudentMonthlySchedule).mockRejectedValue(new Error("db down"));
    const response = await getSchedule(scheduleRequest("studentKey=k&month=2026-08"));
    expect(response.status).toBe(500);
    await expect(response.json()).resolves.toMatchObject({ error: "db down" });
  });
});

describe("POST /api/student-schedule/link", () => {
  it("401s without a session and mints nothing", async () => {
    authMock.mockResolvedValue(null);
    const response = await postLink(linkRequest({ studentKey: "k", month: "2026-08" }));
    expect(response.status).toBe(401);
    expect(mintStudentScheduleLink).not.toHaveBeenCalled();
  });

  it("400s on unparseable JSON", async () => {
    const response = await postLink(linkRequest("{not json"));
    expect(response.status).toBe(400);
    expect(mintStudentScheduleLink).not.toHaveBeenCalled();
  });

  it("400s on a malformed month", async () => {
    const response = await postLink(linkRequest({ studentKey: "k", month: "August" }));
    expect(response.status).toBe(400);
    expect(mintStudentScheduleLink).not.toHaveBeenCalled();
  });

  it("refuses to mint for a student that does not resolve", async () => {
    vi.mocked(getStudentMonthlySchedule).mockResolvedValue(null);
    const response = await postLink(linkRequest({ studentKey: "ghost", month: "2026-08" }));
    expect(response.status).toBe(404);
    expect(mintStudentScheduleLink).not.toHaveBeenCalled();
  });

  it("mints against the resolved student, not the raw input key", async () => {
    vi.mocked(getStudentMonthlySchedule).mockResolvedValue(payload as never);
    vi.mocked(mintStudentScheduleLink).mockResolvedValue({
      token: "tok_abc",
      expiresAt: new Date("2026-09-04T03:00:00Z"),
      id: "link-1",
    } as never);

    const response = await postLink(linkRequest({ studentKey: "k", month: "2026-08" }));
    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toMatchObject({
      url: expect.stringContaining("/schedule/tok_abc"),
    });

    expect(vi.mocked(mintStudentScheduleLink).mock.calls[0][1]).toMatchObject({
      studentKey: payload.student.studentKey,
      wiseStudentId: "stu_1",
      monthKey: "2026-08",
      createdByEmail: "admin@begifted.test",
    });
  });
});
