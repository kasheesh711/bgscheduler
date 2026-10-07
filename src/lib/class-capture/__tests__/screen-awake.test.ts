import { describe, expect, it, vi } from "vitest";
import { keepScreenAwake } from "../screen-awake";
const flush = () => new Promise(resolve => setTimeout(resolve, 0));
function sentinel() { return Object.assign(new EventTarget(), { released: false, release: vi.fn(async () => undefined) }); }
describe("recording screen wake lock", () => {
  it("holds a screen lock while recording, reports system revocation and releases on stop", async () => {
    const lock = sentinel(), change = vi.fn();
    const stop = keepScreenAwake(change, async () => lock);
    await flush();
    expect(change).toHaveBeenLastCalledWith("active");
    lock.dispatchEvent(new Event("release"));
    expect(change).toHaveBeenLastCalledWith("unavailable");
    stop();
    expect(lock.release).toHaveBeenCalledTimes(1);
  });
  it("releases a permission result arriving after recording stops", async () => {
    const lock = sentinel(), change = vi.fn();
    let resolve!: (value: typeof lock) => void;
    const stop = keepScreenAwake(change, () => new Promise(done => { resolve = done; }));
    stop(); resolve(lock); await flush();
    expect(lock.release).toHaveBeenCalledTimes(1);
    expect(change).not.toHaveBeenCalledWith("active");
  });
  it("reports denial so the UI can explain the Voice Memos fallback", async () => {
    const change = vi.fn();
    keepScreenAwake(change, async () => { throw new Error("low battery"); });
    await flush();
    expect(change).toHaveBeenLastCalledWith("unavailable");
  });
});
