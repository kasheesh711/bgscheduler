import { afterEach, describe, expect, it, vi } from "vitest";
import { bangkokDay, watchTodaySessions } from "../today-sessions";

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (error: Error) => void;
  const promise = new Promise<T>((done, fail) => { resolve = done; reject = fail; });
  return { promise, resolve, reject };
}

function setup(request: () => Promise<string>) {
  const focus = new EventTarget();
  const visibility = Object.assign(new EventTarget(), { visibilityState: "visible" });
  const onRefresh = vi.fn();
  const onResult = vi.fn();
  const onError = vi.fn();
  const watch = watchTodaySessions({ request, onRefresh, onResult, onError, focus, visibility });
  return { ...watch, focus, visibility, onRefresh, onResult, onError };
}

afterEach(() => vi.useRealTimers());

describe("today's class list refresh", () => {
  it("refreshes at Bangkok midnight and sends no client date to its request", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-10-01T16:59:59Z"));
    const request = vi.fn(async () => "synthetic own classes");
    const watch = setup(request);
    await vi.advanceTimersByTimeAsync(1_001);
    expect(bangkokDay(Date.now())).toBe("2026-10-02");
    expect(watch.onRefresh.mock.calls.map(([day]) => day)).toEqual(["2026-10-01", "2026-10-02"]);
    expect(request.mock.calls).toEqual([[], []]);
    watch.stop();
  });

  it("refreshes on focus and visible return after suspended timers", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-10-01T16:00:00Z"));
    const request = vi.fn(async () => "synthetic classes");
    const watch = setup(request);
    vi.setSystemTime(new Date("2026-10-02T02:00:00Z"));
    watch.visibility.visibilityState = "hidden";
    watch.visibility.dispatchEvent(new Event("visibilitychange"));
    expect(request).toHaveBeenCalledTimes(1);
    watch.visibility.visibilityState = "visible";
    watch.visibility.dispatchEvent(new Event("visibilitychange"));
    watch.focus.dispatchEvent(new Event("focus"));
    expect(request).toHaveBeenCalledTimes(3);
    expect(watch.onRefresh).toHaveBeenLastCalledWith("2026-10-02");
    watch.stop();
  });

  it("ignores older responses and older errors after a newer refresh", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-10-01T10:00:00Z"));
    const old = deferred<string>();
    const current = deferred<string>();
    const request = vi.fn().mockReturnValueOnce(old.promise).mockReturnValueOnce(current.promise);
    const watch = setup(request);
    watch.refresh();
    current.resolve("current classes");
    await Promise.resolve();
    old.reject(new Error("obsolete failure"));
    await Promise.resolve();
    expect(watch.onResult).toHaveBeenCalledExactlyOnceWith("current classes", "2026-10-01");
    expect(watch.onError).not.toHaveBeenCalled();
    watch.stop();
  });

  it("rejects a yesterday response even when the midnight timer did not run", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-10-01T16:59:59Z"));
    const old = deferred<string>();
    const request = vi.fn().mockReturnValueOnce(old.promise).mockResolvedValueOnce("today");
    const watch = setup(request);
    vi.setSystemTime(new Date("2026-10-01T17:00:01Z"));
    old.resolve("yesterday");
    await vi.advanceTimersByTimeAsync(0);
    expect(watch.onResult).toHaveBeenCalledExactlyOnceWith("today", "2026-10-02");
    watch.stop();
  });

  it("reports a current failure and retries, then ignores completion after unmount", async () => {
    vi.useFakeTimers();
    const pending = deferred<string>();
    const request = vi.fn().mockRejectedValueOnce(new Error("offline")).mockReturnValueOnce(pending.promise);
    const watch = setup(request);
    await Promise.resolve();
    expect(watch.onError).toHaveBeenCalledOnce();
    watch.refresh();
    watch.stop();
    pending.resolve("too late");
    await Promise.resolve();
    watch.focus.dispatchEvent(new Event("focus"));
    await vi.advanceTimersByTimeAsync(2 * 24 * 60 * 60 * 1_000);
    expect(request).toHaveBeenCalledTimes(2);
    expect(watch.onResult).not.toHaveBeenCalled();
  });
});
