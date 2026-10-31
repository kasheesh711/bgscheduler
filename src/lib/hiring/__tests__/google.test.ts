import { afterEach, expect, it, vi } from "vitest";
import type { Database } from "@/lib/db";
import type { hiringBookings } from "@/lib/db/schema";
import type { Candidate } from "../service";
import { deliverCalendar } from "../google";
import { GOOGLE_SCOPES } from "../model";

vi.mock("@/lib/sales-dashboard/google-oauth", () => ({
  SHEETS_WRITE_SCOPE: "https://www.googleapis.com/auth/spreadsheets",
  getGoogleSheetsAccessToken: vi.fn().mockResolvedValue("test-access-token"),
}));

afterEach(() => vi.unstubAllGlobals());

it("creates one calendar event with both attendees and recovers it by identity on retry", async () => {
  const db = {
    select: () => ({
      from: () => ({
        where: async () => [
          {
            refreshTokenCiphertext: "encrypted",
            scope: GOOGLE_SCOPES.join(" "),
          },
        ],
      }),
    }),
  } as unknown as Database;
  const booking = {
    id: "00000000-0000-4000-8000-000000000001",
    kind: "mock",
    calendarOwner: "owner@example.com",
    interviewerEmail: "peat@example.com",
    subjects: ["Mathematics"],
    startTime: new Date("2026-11-02T03:00:00Z"),
    endTime: new Date("2026-11-02T04:00:00Z"),
  } as typeof hiringBookings.$inferSelect;
  const candidate = {
    name: "Candidate",
    email: "candidate@example.com",
  } as Candidate;
  let event: Record<string, unknown> | null = null;
  const fetcher = vi.fn(async (_url: string, init?: RequestInit) => {
    if (init?.method === "POST") {
      event = JSON.parse(init.body as string);
      return Response.json(event);
    }
    return event ? Response.json(event) : new Response(null, { status: 404 });
  });
  vi.stubGlobal("fetch", fetcher);
  const first = await deliverCalendar(booking, candidate, "BeGifted", db);
  const second = await deliverCalendar(booking, candidate, "BeGifted", db);
  expect(second).toEqual({ id: first.id, recovered: true });
  const creates = fetcher.mock.calls.filter(
    ([, init]) => init?.method === "POST",
  );
  expect(creates).toHaveLength(1);
  expect(creates[0][0]).toContain("sendUpdates=all");
  expect(JSON.parse(creates[0][1]!.body as string).attendees).toEqual([
    { email: "peat@example.com" },
    { email: "candidate@example.com" },
  ]);
  event = Object.assign({}, event, {
    extendedProperties: { private: { hiringBookingId: "another-booking" } },
  });
  await expect(
    deliverCalendar(booking, candidate, "BeGifted", db),
  ).rejects.toThrow(/conflicting identity/);
  expect(
    fetcher.mock.calls.filter(([, init]) => init?.method === "POST"),
  ).toHaveLength(1);
});
