import { afterEach, describe, expect, it, vi } from 'vitest';
import { ReadCache, invalidateWorkforceReadCache, cachedWorkforceRead } from '../read-cache';
afterEach(() => vi.useRealTimers());
describe('bounded read cache', () => {
  it('coalesces concurrent reads, expires, and explicitly refreshes', async () => {
    vi.useFakeTimers();
    const cache = new ReadCache<number>(60_000, 2), load = vi.fn(async () => 1);
    expect(await Promise.all([cache.read('a', load), cache.read('a', load)])).toEqual([1, 1]);
    expect(load).toHaveBeenCalledTimes(1);
    await cache.read('a', load, true);
    expect(load).toHaveBeenCalledTimes(2);
    vi.advanceTimersByTime(60_001);
    await cache.read('a', load);
    expect(load).toHaveBeenCalledTimes(3);
  });
  it('does not cache failures or let an older read replace a refreshed result', async () => {
    const cache = new ReadCache<number>();
    await expect(cache.read('x', async () => { throw new Error('failed'); })).rejects.toThrow('failed');
    expect(await cache.read('x', async () => 2)).toBe(2);
    let release!: (value: number) => void;
    const old = cache.read('a', () => new Promise<number>(resolve => { release = resolve; }));
    expect(await cache.read('a', async () => 3, true)).toBe(3);
    release(1); await old;
    expect(await cache.read('a', async () => 4)).toBe(3);
  });
  it('bounds entries and isolates database handles and invalidation generations', async () => {
    const cache = new ReadCache<number>(60_000, 1);
    await cache.read('a', async () => 1); await cache.read('b', async () => 2);
    expect(await cache.read('a', async () => 3)).toBe(3);
    const one = {}, two = {}, load = vi.fn(async () => 1);
    await cachedWorkforceRead(one, 'report', 'q', load);
    await cachedWorkforceRead(one, 'report', 'q', load);
    await cachedWorkforceRead(two, 'report', 'q', load);
    expect(load).toHaveBeenCalledTimes(2);
    invalidateWorkforceReadCache();
    await cachedWorkforceRead(one, 'report', 'q', load);
    expect(load).toHaveBeenCalledTimes(3);
  });
  it('does not reuse an abortable in-flight client request and clears every saved result on refresh', async () => {
    const cache = new ReadCache<number>(60_000, 3, false);
    let reject!: (error: Error) => void;
    const old = cache.read('a', () => new Promise<number>((_resolve, fail) => { reject = fail; }));
    await Promise.resolve();
    expect(await cache.read('a', async () => 2)).toBe(2);
    reject(new DOMException('aborted', 'AbortError'));
    await expect(old).rejects.toThrow('aborted');
    expect(await cache.read('a', async () => 3)).toBe(2);
    cache.clear();
    expect(await cache.read('a', async () => 3)).toBe(3);
  });
  it('does not extend old source freshness when deriving a different report', async () => {
    vi.useFakeTimers(); vi.setSystemTime(10_000);
    const cache = new ReadCache<{ asOf: number }>(60_000);
    const load = vi.fn(async () => ({ asOf: 0 }));
    const deadline = (value: { asOf: number }) => value.asOf + 60_000;
    await cache.read('derived', load, false, deadline);
    vi.setSystemTime(60_001);
    await cache.read('derived', load, false, deadline);
    expect(load).toHaveBeenCalledTimes(2);
  });
});
