import { beforeEach, expect, it, vi, type Mock } from "vitest";
import { NextRequest } from "next/server";
vi.mock("@/lib/auth", () => ({ auth: vi.fn() }));
vi.mock("@/lib/db", () => ({ getDb: vi.fn(() => ({})) }));
vi.mock("@/lib/classrooms/room-profiles", async original => ({ ...await original<object>(), listTutorRoomProfiles: vi.fn(), updateTutorRoomProfile: vi.fn() }));
vi.mock("@/lib/classrooms/print-report", async original => ({ ...await original<object>(), listPrintRuns: vi.fn() }));
import { auth } from "@/lib/auth";
import { RoomProfileError, listTutorRoomProfiles, updateTutorRoomProfile } from "@/lib/classrooms/room-profiles";
import { listPrintRuns } from "@/lib/classrooms/print-report";
import { GET } from "../room-profiles/route";
import { PATCH } from "../room-profiles/[canonicalKey]/route";
import { GET as getPrintRuns } from "../print-runs/route";
const params = { params: Promise.resolve({ canonicalKey: "teacher" }) };
const request = (data: unknown) => new NextRequest("http://localhost/api/class-assignments/room-profiles/teacher", { method: "PATCH", body: JSON.stringify(data) });
beforeEach(() => { vi.clearAllMocks(); (auth as Mock).mockResolvedValue({ user: { email: "admin@example.com" } }); });
it("requires authentication for profiles, edits and print manifests", async () => {
  (auth as Mock).mockResolvedValue(null);
  expect((await GET()).status).toBe(401);
  expect((await PATCH(request({}), params)).status).toBe(401);
  expect((await getPrintRuns(new NextRequest("http://localhost/api/class-assignments/print-runs?date=2026-09-12"))).status).toBe(401);
  expect(listTutorRoomProfiles).not.toHaveBeenCalled(); expect(updateTutorRoomProfile).not.toHaveBeenCalled(); expect(listPrintRuns).not.toHaveBeenCalled();
});
it("validates edits and records the authenticated actor, preserving revision conflicts", async () => {
  expect((await PATCH(request({ roomIds: [] }), params)).status).toBe(400);
  const body = { roomIds: [crypto.randomUUID()], revision: 2 };
  vi.mocked(updateTutorRoomProfile).mockRejectedValue(new RoomProfileError("Reload before saving", 409));
  expect((await PATCH(request(body), params)).status).toBe(409);
  expect(updateTutorRoomProfile).toHaveBeenCalledWith({}, { ...body, canonicalKey: "teacher", actor: "admin@example.com" });
});
it("rejects impossible calendar dates instead of normalizing them to a different day", async () => {
  expect((await getPrintRuns(new NextRequest("http://localhost/api/class-assignments/print-runs?date=2026-02-31"))).status).toBe(400);
  expect(listPrintRuns).not.toHaveBeenCalled();
});
