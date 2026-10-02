/** A short application-memory cache. Authentication remains outside every cached read. */
export const WORKFORCE_READ_CACHE_MS = 60_000;
export const WORKFORCE_REFRESH_HEADER = 'x-workforce-refresh';
export class ReadCache<T> {
  private entries = new Map<string, { expiresAt: number; promise: Promise<T> }>();
  constructor(private ttl = WORKFORCE_READ_CACHE_MS, private limit = 2, private coalesce = true) {}
  clear(): void { this.entries.clear(); }
  read(key: string, load: () => Promise<T>, refresh = false, deadline?: (value: T) => number): Promise<T> {
    const previous = this.entries.get(key);
    if (!refresh && previous && previous.expiresAt > Date.now() && (this.coalesce || previous.expiresAt !== Infinity)) {
      this.entries.delete(key);
      this.entries.set(key, previous);
      return previous.promise;
    }
    const entry = { expiresAt: Infinity, promise: undefined as unknown as Promise<T> };
    entry.promise = Promise.resolve().then(load).then(value => {
      entry.expiresAt = Math.min(Date.now() + this.ttl, deadline ? deadline(value) : Infinity);
      return value;
    }, error => {
      if (this.entries.get(key) === entry) this.entries.delete(key);
      throw error;
    });
    this.entries.delete(key);
    this.entries.set(key, entry);
    while (this.entries.size > this.limit) this.entries.delete(this.entries.keys().next().value!);
    return entry.promise;
  }
}
let generation = 0;
const databases = new WeakMap<object, { generation: number; reads: Map<string, ReadCache<unknown>> }>();
/** Call after a local evidence mutation, such as saving a reviewed subject mapping. */
export function invalidateWorkforceReadCache(): void { generation++; }
export function cachedWorkforceRead<T>(db: object, scope: string, key: string, load: () => Promise<T>, refresh = false, deadline?: (value: T) => number): Promise<T> {
  let state = databases.get(db);
  if (!state || state.generation !== generation) {
    state = { generation, reads: new Map() };
    databases.set(db, state);
  }
  let cache = state.reads.get(scope);
  if (!cache) { cache = new ReadCache<unknown>(); state.reads.set(scope, cache); }
  return cache.read(key, load, refresh, deadline ? value => deadline(value as T) : undefined) as Promise<T>;
}
export function workforceReportDeadline(value: { generatedAt: string }): number {
  const instant = Date.parse(value.generatedAt);
  return Number.isFinite(instant) ? instant + WORKFORCE_READ_CACHE_MS : 0;
}
/** Stable ordering prevents otherwise-identical query objects creating duplicate work. */
export function workforceReadKey(value: object): string {
  return JSON.stringify(value, (_key, item) => item && typeof item === 'object' && !Array.isArray(item)
    ? Object.fromEntries(Object.entries(item).filter(([, v]) => v !== undefined).sort(([a], [b]) => a.localeCompare(b))) : item);
}
