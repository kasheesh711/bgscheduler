import { describe, expect, it, vi } from "vitest";
import { fetchWiseSessionsForBangkokDates } from "../day-sessions";
import type { WiseClient } from "../client";

const date = "2026-09-12";
const now = new Date("2026-09-11T10:00:00Z");
const row = (id: string) => ({ _id: id, scheduledStartTime: "2026-09-12T02:00:00Z", scheduledEndTime: "2026-09-12T03:00:00Z" });
const page = (sessions: unknown[], page_count = 1) => ({ data: { sessions, page_count } });
function mock(...responses: unknown[]) {
  const get = vi.fn();
  for (const response of responses) get.mockResolvedValueOnce(response);
  return { get } as unknown as Pick<WiseClient, "get">;
}

describe("complete Bangkok-day Wise reads", () => {
  it("reads all pages with an exclusive next-day boundary", async () => {
    const client = mock(page(Array.from({ length: 100 }, (_, i) => row(String(i))), 2), page([row("last")], 2));
    expect(await fetchWiseSessionsForBangkokDates(client, "institute", [date], { now })).toHaveLength(101);
    expect(client.get).toHaveBeenNthCalledWith(2, "/institutes/institute/sessions", expect.objectContaining({
      paginateBy: "DATE", status: "FUTURE", startDate: date, endDate: "2026-09-13", page_number: "2", page_size: "100",
    }), expect.objectContaining({ cache: "no-store" }));
  });
  it("reads PAST and FUTURE for today across the Bangkok midnight boundary", async () => {
    const client = mock(page([]), page([row("future")]));
    await fetchWiseSessionsForBangkokDates(client, "i", [date], { now: new Date("2026-09-11T17:01:00Z") });
    expect(vi.mocked(client.get).mock.calls.map(call => call[1]?.status)).toEqual(["PAST", "FUTURE"]);
  });
  it("reads PAST for an earlier date and accepts an explicitly empty day", async () => {
    const client = mock(page([], 0));
    expect(await fetchWiseSessionsForBangkokDates(client, "i", [date], { now: new Date("2026-09-13T00:00:00Z") })).toEqual([]);
    expect(vi.mocked(client.get).mock.calls[0][1]?.status).toBe("PAST");
  });
  it.each([
    {}, page([row("a")], 0), page([row("a")], 2), page([], 2), page([row("a"), row("a")]),
    page([{ ...row("a"), scheduledEndTime: "invalid" }]),
    page([{ ...row("a"), scheduledStartTime: "2026-09-11T16:59:00Z" }]),
  ])("rejects incomplete or invalid evidence %#", async response => {
    await expect(fetchWiseSessionsForBangkokDates(mock(response), "i", [date], { now })).rejects.toThrow();
  });
  it("rejects page-count changes and an empty advertised final page", async () => {
    const first = page(Array.from({ length: 100 }, (_, i) => row(String(i))), 2);
    await expect(fetchWiseSessionsForBangkokDates(mock(first, page([row("last")], 3)), "i", [date], { now })).rejects.toThrow("pagination");
    await expect(fetchWiseSessionsForBangkokDates(mock(first, page([], 2)), "i", [date], { now })).rejects.toThrow("pagination");
  });
  it("does not return partial results after a later request fails", async () => {
    const client = mock(page(Array.from({ length: 100 }, (_, i) => row(String(i))), 2));
    vi.mocked(client.get).mockRejectedValueOnce(new Error("429"));
    await expect(fetchWiseSessionsForBangkokDates(client, "i", [date], { now })).rejects.toThrow("429");
  });
});
