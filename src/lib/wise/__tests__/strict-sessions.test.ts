import { describe, expect, it, vi } from "vitest";
import { fetchAllFutureSessions } from "../fetchers";
import type { WiseClient } from "../client";
const session = (id: string) => ({ _id: id, scheduledStartTime: "2026-09-12T03:00:00Z", scheduledEndTime: "2026-09-12T04:00:00Z" });
function client(pages: unknown[]) {
  const get = vi.fn();
  for (const data of pages) get.mockResolvedValueOnce({ data });
  return { get } as unknown as WiseClient;
}
describe("strict live Wise pagination", () => {
  it("reads every advertised page", async () => {
    expect(await fetchAllFutureSessions(client([{ sessions: [session("one")], page_count: 2 }, { sessions: [session("two")], page_count: 2 }]), "institute", { strict: true })).toHaveLength(2);
  });
  it.each([
    [{}],
    [{ sessions: [], page_count: 2 }],
    [{ sessions: [session("one")], page_count: 2 }, { sessions: [], page_count: 2 }],
    [{ sessions: [session("one")], page_count: 2 }, { sessions: [session("one")], page_count: 2 }],
    [{ sessions: [session("one")], page_count: 2 }, { sessions: [session("two")], page_count: 3 }],
    [{ sessions: [{ ...session("one"), scheduledEndTime: "invalid" }], page_count: 1 }],
    [{ sessions: [session("one")], page_count: 0 }],
  ])("fails closed on incomplete, inconsistent or malformed evidence: %j", async (...pages) => {
    await expect(fetchAllFutureSessions(client(pages), "institute", { strict: true })).rejects.toThrow();
  });
  it("accepts an explicitly empty dataset", async () => {
    expect(await fetchAllFutureSessions(client([{ sessions: [], page_count: 0 }]), "institute", { strict: true })).toEqual([]);
  });
});
