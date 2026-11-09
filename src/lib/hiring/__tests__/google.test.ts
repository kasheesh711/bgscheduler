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
    { email: "people@begiftededucation.com" },
    { email: "admin@begiftededucation.com" },
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

it("titles a visit's two private events, and only the mock invites the head", async () => {
  const db = {
    select: () => ({
      from: () => ({ where: async () => [{ refreshTokenCiphertext: "encrypted", scope: GOOGLE_SCOPES.join(" ") }] }),
    }),
  } as unknown as Database;
  const row = (kind: "paper" | "mock", id: string, interviewerEmail: string | null) =>
    ({
      id,
      kind,
      visitId: "00000000-0000-4000-8000-000000000009",
      calendarOwner: "owner@example.com",
      interviewerEmail,
      subjects: ["Mathematics"],
      startTime: new Date("2026-11-02T03:00:00Z"),
      endTime: new Date("2026-11-02T05:00:00Z"),
    }) as typeof hiringBookings.$inferSelect;
  const candidate = { name: "Candidate", email: "candidate@example.com" } as Candidate;
  const events: Record<string, unknown>[] = [];
  vi.stubGlobal(
    "fetch",
    vi.fn(async (_url: string, init?: RequestInit) => {
      if (init?.method !== "POST") return new Response(null, { status: 404 });
      events.push(JSON.parse(init.body as string));
      return Response.json(events.at(-1));
    }),
  );
  await deliverCalendar(row("paper", "00000000-0000-4000-8000-000000000002", null), candidate, "BeGifted", db);
  await deliverCalendar(row("mock", "00000000-0000-4000-8000-000000000003", "peat@example.com"), candidate, "BeGifted", db);
  expect(events.map((e) => e.summary)).toEqual(["BeGifted exam", "BeGifted mock teaching"]);
  expect(events.map((e) => e.visibility)).toEqual(["private", "private"]);
  expect(events[0].attendees).toEqual([{ email: "candidate@example.com" }]);
  expect(events[1].attendees).toEqual([{ email: "peat@example.com" }, { email: "candidate@example.com" }, { email: "people@begiftededucation.com" }, { email: "admin@begiftededucation.com" }]);
  expect(String(events[1].description)).toContain("Candidate");
});

it("adds staff to an existing mock once, preserving guests and their responses", async () => {
  const db = { select: () => ({ from: () => ({ where: async () => [{ refreshTokenCiphertext: "encrypted", scope: GOOGLE_SCOPES.join(" ") }] }) }) } as unknown as Database;
  const booking = { id: "00000000-0000-4000-8000-000000000001", kind: "mock", calendarOwner: "owner@example.com",
    startTime: new Date("2026-11-17T03:00:00Z"), endTime: new Date("2026-11-17T04:00:00Z") } as typeof hiringBookings.$inferSelect;
  let event = { etag: "version-1", start: { dateTime: booking.startTime.toISOString() }, end: { dateTime: booking.endTime.toISOString() },
    extendedProperties: { private: { hiringBookingId: booking.id } }, attendees: [{ email: "candidate@example.com", responseStatus: "accepted" }] };
  const fetcher = vi.fn(async (_url, init) => {
    if (init?.method === "PATCH") event = { ...event, ...JSON.parse(init.body) };
    return Response.json(event);
  });
  vi.stubGlobal("fetch", fetcher);
  await deliverCalendar(booking, {} as Candidate, "BeGifted", db);
  await deliverCalendar(booking, {} as Candidate, "BeGifted", db);
  expect(fetcher.mock.calls.filter(([, init]) => init?.method === "PATCH")).toHaveLength(1);
  expect(new Headers(fetcher.mock.calls.find(([, init]) => init?.method === "PATCH")?.[1].headers).get("if-match")).toBe("version-1");
  expect(event.attendees[0]).toEqual({ email: "candidate@example.com", responseStatus: "accepted" });
  expect(event.attendees.map(a => a.email)).toContain("people@begiftededucation.com");
});
