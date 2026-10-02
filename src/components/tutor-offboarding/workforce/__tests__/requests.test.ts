import { describe, expect, it, vi, afterEach } from "vitest";
import { workforceFixture } from "../fixtures";
import {
  fetchWorkforceReport,
  queryParams,
  LatestRequest,
  withFreshRevision,
  WorkforceRequestError,
} from "../requests";
afterEach(() => vi.unstubAllGlobals());
describe("workforce reads", () => {
  it("explicit refresh bypasses server cache without changing the report filters", async () => {
    const mock = vi.fn().mockResolvedValue(new Response(JSON.stringify(workforceFixture())));
    vi.stubGlobal("fetch", mock);
    await fetchWorkforceReport(workforceFixture().query, new AbortController().signal, true);
    expect(mock).toHaveBeenCalledWith(expect.not.stringContaining("refresh="), expect.objectContaining({ headers: { "x-workforce-refresh": "1" } }));
  });
  it("omits empty filters and issues abortable GET only", async () => {
    const mock = vi
      .fn()
      .mockResolvedValue(new Response(JSON.stringify(workforceFixture())));
    vi.stubGlobal("fetch", mock);
    const controller = new AbortController();
    await fetchWorkforceReport(workforceFixture().query, controller.signal);
    expect(mock).toHaveBeenCalledWith(
      expect.stringContaining("/analytics/workforce?"),
      expect.objectContaining({
        method: "GET",
        cache: "no-store",
        signal: controller.signal,
      }),
    );
    expect(
      queryParams({ ...workforceFixture().query, subject: "" }).has("subject"),
    ).toBe(false);
  });
  it("rejects malformed success and HTTP errors instead of reporting clean zero", async () => {
    vi.stubGlobal(
      "fetch",
      vi
        .fn()
        .mockResolvedValue(new Response(JSON.stringify({ available: false }))),
    );
    await expect(
      fetchWorkforceReport(
        workforceFixture().query,
        new AbortController().signal,
      ),
    ).rejects.toThrow("incomplete");
    vi.stubGlobal(
      "fetch",
      vi
        .fn()
        .mockResolvedValue(
          new Response(JSON.stringify({ error: "Not ready" }), { status: 503 }),
        ),
    );
    await expect(
      fetchWorkforceReport(
        workforceFixture().query,
        new AbortController().signal,
      ),
    ).rejects.toThrow("Not ready");
  });
  it("cancels obsolete reads and refuses their result even if fetch ignores abort", async () => {
    const gate = new LatestRequest();
    const a = gate.begin();
    const b = gate.begin();
    expect(a.signal.aborted).toBe(true);
    expect(gate.isCurrent(a)).toBe(false);
    expect(gate.isCurrent(b)).toBe(true);
    gate.cancel();
    expect(b.signal.aborted).toBe(true);
  });
  it("refreshes report before retrying stale detail or export once", async () => {
    const calls: string[] = [];
    const action = vi.fn(async (r: string) => {
      calls.push(r);
      if (r === "old") throw new WorkforceRequestError("stale", 409);
      return "csv";
    });
    const refresh = vi.fn(async () => {
      calls.push("refresh");
      return { ...workforceFixture(), reportRevision: "new" };
    });
    expect(await withFreshRevision("old", action, refresh)).toBe("csv");
    expect(calls).toEqual(["old", "refresh", "new"]);
    expect(refresh).toHaveBeenCalledOnce();
  });
  it("does not resend stale actions repeatedly", async () => {
    const action = vi
      .fn()
      .mockRejectedValue(new WorkforceRequestError("stale", 409));
    await expect(
      withFreshRevision("old", action, async () => workforceFixture()),
    ).rejects.toThrow("stale");
    expect(action).toHaveBeenCalledTimes(2);
  });
});
