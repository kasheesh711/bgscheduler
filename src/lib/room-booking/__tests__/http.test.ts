import { beforeEach, describe, it, expect, vi } from "vitest";
import { NextRequest } from "next/server";
import { GET } from "@/app/api/room/availability/route";
import { POST } from "@/app/api/room/reservations/route";
import { DELETE } from "@/app/api/room/reservations/[id]/route";
import {
  resolveRoomLink,
  getRoomDayView,
  createRoomReservation,
  cancelRoomReservation,
} from "../service";
import { RoomBookingError } from "../model";
vi.mock("@/lib/db", () => ({ getDb: () => ({}) }));
vi.mock("../service", () => ({
  resolveRoomLink: vi.fn(),
  getRoomDayView: vi.fn(),
  createRoomReservation: vi.fn(),
  cancelRoomReservation: vi.fn(),
}));
const req = (
  path: string,
  options: ConstructorParameters<typeof NextRequest>[1] = {},
) => new NextRequest(`https://example.test/api/room/${path}`, options);
beforeEach(() => {
  vi.clearAllMocks();
  vi.mocked(resolveRoomLink).mockImplementation(async (_db, token) => {
    if (token !== "valid")
      throw new RoomBookingError("LINK_EXPIRED", "Expired", 401);
    return "alice";
  });
});
describe("room HTTP boundary", () => {
  it("rejects anonymous access before reading availability", async () => {
    expect((await GET(req("availability"))).status).toBe(401);
    expect(getRoomDayView).not.toHaveBeenCalled();
  });
  it("marks authenticated responses private and uncacheable", async () => {
    vi.mocked(getRoomDayView).mockResolvedValue({
      date: "2026-09-11",
    } as never);
    const res = await GET(
      req("availability", { headers: { Authorization: "Bearer valid" } }),
    );
    expect(res.status).toBe(200);
    expect(res.headers.get("Cache-Control")).toContain("no-store");
    expect(res.headers.get("Referrer-Policy")).toBe("no-referrer");
  });
  it("rejects body-supplied identities rather than overriding the credential", async () => {
    const res = await POST(
      req("reservations", {
        method: "POST",
        headers: { Authorization: "Bearer valid" },
        body: JSON.stringify({
          roomId: crypto.randomUUID(),
          date: "2026-09-11",
          startMinute: 600,
          endMinute: 660,
          idempotencyKey: crypto.randomUUID(),
          lineUserId: "bob",
        }),
      }),
    );
    expect(res.status).toBe(400);
    expect(createRoomReservation).not.toHaveBeenCalled();
  });
  it("uses the validated actor and retains conflict status", async () => {
    vi.mocked(createRoomReservation).mockRejectedValue(
      new RoomBookingError("ROOM_CONFLICT", "Taken"),
    );
    const res = await POST(
      req("reservations", {
        method: "POST",
        headers: { Authorization: "Bearer valid" },
        body: JSON.stringify({
          roomId: crypto.randomUUID(),
          date: "2026-09-11",
          startMinute: 600,
          endMinute: 660,
          idempotencyKey: crypto.randomUUID(),
        }),
      }),
    );
    expect(res.status).toBe(409);
    expect(createRoomReservation).toHaveBeenCalledWith(
      {},
      "alice",
      expect.objectContaining({ source: "mobile" }),
    );
  });
  it("authenticates cancellation before parsing a booking ID", async () => {
    expect(
      (
        await DELETE(req("reservations/bad", { method: "DELETE" }), {
          params: Promise.resolve({ id: "bad" }),
        })
      ).status,
    ).toBe(401);
    expect(cancelRoomReservation).not.toHaveBeenCalled();
  });
});
