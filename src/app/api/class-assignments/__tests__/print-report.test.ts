import { beforeEach, expect, it, vi, type Mock } from "vitest";
import { NextRequest } from "next/server";
vi.mock("@/lib/auth", () => ({ auth: vi.fn() }));
vi.mock("@/lib/db", () => ({ getDb: vi.fn(() => ({})) }));
vi.mock("@/lib/classrooms/print-report", async original => ({ ...await original<object>(), loadClassroomPrintReport: vi.fn() }));
import { auth } from "@/lib/auth";
import { ClassroomPrintConflictError, loadClassroomPrintReport } from "@/lib/classrooms/print-report";
import { GET } from "../print-report/route";
const id = "11111111-1111-4111-8111-111111111111";
const request = (ids = id) => new NextRequest(`http://localhost/api/class-assignments/print-report?runIds=${ids}`);
beforeEach(() => { vi.resetAllMocks(); (auth as Mock).mockResolvedValue({ user: { email: "admin@example.com", allowedPages: ["/class-assignments"] } }); });
it("checks both authentication and Class Assignments permission before reading", async () => {
  (auth as Mock).mockResolvedValueOnce(null).mockResolvedValueOnce({ user: { email: "limited@example.com", allowedPages: ["/search"] } });
  expect((await GET(request())).status).toBe(401); expect((await GET(request())).status).toBe(403); expect(loadClassroomPrintReport).not.toHaveBeenCalled();
});
it("validates one to seven distinct UUIDs", async () => {
  for (const ids of ["", "bad", `${id},${id}`, Array.from({ length: 8 }, () => crypto.randomUUID()).join(",")]) expect((await GET(request(ids))).status).toBe(400);
  expect(loadClassroomPrintReport).not.toHaveBeenCalled();
});
it("returns fresh data with private no-store headers", async () => {
  const body = { days: [], generatedAt: "now", rosterCheckedAt: "now", refreshFailed: false };
  vi.mocked(loadClassroomPrintReport).mockResolvedValue(body);
  const response = await GET(request());
  expect(response.status).toBe(200); expect(response.headers.get("cache-control")).toContain("no-store"); expect(await response.json()).toEqual(body);
  expect(loadClassroomPrintReport).toHaveBeenCalledWith({}, [id]);
});
it("requires reload for concurrent edits and hides upstream failure details", async () => {
  vi.mocked(loadClassroomPrintReport).mockRejectedValueOnce(new ClassroomPrintConflictError("Assignments changed while loading. Refresh to print the latest saved version.")).mockRejectedValueOnce(new Error("Wise private upstream payload could not be saved"));
  expect((await GET(request())).status).toBe(409);
  const response = await GET(request()); expect(response.status).toBe(503);
  expect(await response.json()).toEqual({ error: expect.stringMatching(/Retry before printing/) });
  expect(response.headers.get("cache-control")).toContain("no-store");
});
