export interface WiseClientConfig {
  userId: string;
  apiKey: string;
  namespace: string;
  baseUrl?: string;
  maxConcurrency?: number;
  maxRetries?: number;
  requestsPerSecond?: number;
  signal?: AbortSignal;
}

interface QueuedRequest<T> {
  fn: () => Promise<T>;
  resolve: (value: T) => void;
  reject: (reason: unknown) => void;
  signal?: AbortSignal;
  onAbort?: () => void;
}

/**
 * EFF-00: per-instance Wise request tally. Wise is the slowest dependency in
 * every sync, but no run ever recorded how many calls it actually made, so
 * "is this sync API-bound?" could only be guessed. Counted per logical call
 * (retries included), bucketed by a normalized path.
 */
export interface WiseClientStats {
  requests: number;
  byPath: Record<string, number>;
}

/** Matches a Mongo-style 24-hex object id segment. */
const OBJECT_ID_SEGMENT = /^[0-9a-f]{24}$/i;

export class WiseClient {
  // REL-05: only these HTTP status codes are considered transient and worth
  // retrying. Permanent 4xx (401/403/404/422) fail fast — no retry budget
  // wasted on errors that won't fix themselves.
  // Sources:
  // - oneuptime.com/blog/post/2026-01-06-nodejs-retry-exponential-backoff
  // - 1xapi.com/blog/resilient-api-circuit-breaker-bulkhead-retry-nodejs-2026
  private static readonly RETRYABLE_STATUS_CODES: ReadonlySet<number> = new Set([
    408, // Request Timeout
    429, // Too Many Requests
    500, // Internal Server Error
    502, // Bad Gateway
    503, // Service Unavailable
    504, // Gateway Timeout
  ]);

  private userId: string;
  private apiKey: string;
  private namespace: string;
  private baseUrl: string;
  private maxRetries: number;
  private requestsPerSecond: number;
  private signal?: AbortSignal;
  private nextAttemptAt = 0;
  private cooldownUntil = 0;

  // Simple concurrency limiter
  private maxConcurrency: number;
  private activeRequests = 0;
  private queue: QueuedRequest<unknown>[] = [];

  // EFF-00 request tally
  private stats: WiseClientStats = { requests: 0, byPath: {} };

  constructor(config: WiseClientConfig) {
    this.userId = config.userId;
    this.apiKey = config.apiKey;
    this.namespace = config.namespace;
    this.baseUrl = config.baseUrl ?? "https://api.wiseapp.live";
    this.maxConcurrency = config.maxConcurrency ?? 5;
    this.maxRetries = config.maxRetries ?? 3;
    this.requestsPerSecond = config.requestsPerSecond ?? 0;
    this.signal = config.signal;
  }

  private get headers(): Record<string, string> {
    const credentials = Buffer.from(`${this.userId}:${this.apiKey}`).toString("base64");
    return {
      "Content-Type": "application/json",
      Authorization: `Basic ${credentials}`,
      "x-api-key": this.apiKey,
      "x-wise-namespace": this.namespace,
      "user-agent": `VendorIntegrations/${this.namespace}`,
    };
  }

  /**
   * Collapse id segments so the histogram has one bucket per endpoint shape,
   * not one per teacher: `/institutes/{id}/teachers/{id}/availability`. The
   * instituteId is itself a 24-hex object id, so it collapses too.
   */
  static normalizeStatsPath(path: string): string {
    return path
      .split("/")
      .map((segment) => (OBJECT_ID_SEGMENT.test(segment) ? "{id}" : segment))
      .join("/");
  }

  private recordRequest(path: string): void {
    const key = WiseClient.normalizeStatsPath(path);
    this.stats.requests += 1;
    this.stats.byPath[key] = (this.stats.byPath[key] ?? 0) + 1;
  }

  /** Snapshot of this client's Wise call tally (EFF-00). */
  getStats(): WiseClientStats {
    return { requests: this.stats.requests, byPath: { ...this.stats.byPath } };
  }

  async get<T>(path: string, params?: Record<string, string>, init?: RequestInit): Promise<T> {
    const url = new URL(`${this.baseUrl}${path}`);
    if (params) {
      for (const [k, v] of Object.entries(params)) {
        url.searchParams.set(k, v);
      }
    }
    const signal = this.requestSignal(init?.signal);
    return this.withConcurrency(() => this.fetchWithRetry<T>(url.toString(), { ...init, signal, method: "GET" }), signal);
  }

  async post<T>(path: string, body: unknown): Promise<T> {
    return this.withConcurrency(() =>
      this.fetchWithRetry<T>(`${this.baseUrl}${path}`, {
        signal: this.signal,
        method: "POST",
        body: JSON.stringify(body),
      }), this.signal
    );
  }

  async put<T>(path: string, body: unknown): Promise<T> {
    return this.withConcurrency(() =>
      this.fetchWithRetry<T>(`${this.baseUrl}${path}`, {
        signal: this.signal,
        method: "PUT",
        body: JSON.stringify(body),
      }), this.signal
    );
  }

  private async fetchWithRetry<T>(
    url: string,
    init: RequestInit,
    attempt = 0,
  ): Promise<T> {
    const signal = init.signal ?? undefined;
    signal?.throwIfAborted();
    while (true) {
      while (this.cooldownUntil > Date.now()) await abortableDelay(this.cooldownUntil - Date.now(), signal);
      const slot = Math.max(Date.now(), this.nextAttemptAt);
      if (this.requestsPerSecond > 0) this.nextAttemptAt = slot + 1000 / this.requestsPerSecond;
      if (slot > Date.now()) await abortableDelay(slot - Date.now(), signal);
      if (this.cooldownUntil <= Date.now()) break;
    }
    signal?.throwIfAborted();
    this.recordRequest(new URL(url).pathname);
    let response: Response;
    try {
      response = await fetch(url, {
        ...init,
        headers: {
          ...this.headers,
          ...(init.headers as Record<string, string> | undefined),
        },
      });
    } catch (networkErr) {
      if (signal?.aborted || (networkErr instanceof Error && networkErr.name === "AbortError")) throw networkErr;
      // Network-level failure (DNS / ECONNRESET / fetch TypeError) — retry.
      if (attempt < this.maxRetries) {
        const delay = Math.pow(2, attempt) * 1000; // 1s, 2s, 4s
        await abortableDelay(delay, signal);
        return this.fetchWithRetry<T>(url, init, attempt + 1);
      }
      throw networkErr;
    }

    if (response.ok) {
      return (await response.json()) as T;
    }

    const text = await response.text().catch(() => "");

    // Permanent error path — 4xx (except 429) and any other non-retryable
    // status. Fail fast; no retry budget wasted.
    if (!WiseClient.RETRYABLE_STATUS_CODES.has(response.status)) {
      throw new Error(`Wise API ${response.status}: ${text} (${url})`);
    }

    const retryAfterMs = parseRetryAfter(response.headers.get("retry-after"));
    if (response.status === 429 && retryAfterMs !== null) this.cooldownUntil = Math.max(this.cooldownUntil, Date.now() + retryAfterMs);

    // Retryable error path — 5xx, 408, 429.
    if (attempt < this.maxRetries) {
      const delay = retryAfterMs ?? Math.pow(2, attempt) * 1000;
      await abortableDelay(delay, signal);
      return this.fetchWithRetry<T>(url, init, attempt + 1);
    }
    throw new Error(`Wise API ${response.status}: ${text} (${url})`);
  }

  private requestSignal(signal?: AbortSignal | null): AbortSignal | undefined {
    return signal && this.signal ? AbortSignal.any([signal, this.signal]) : signal ?? this.signal;
  }

  private withConcurrency<T>(fn: () => Promise<T>, signal?: AbortSignal): Promise<T> {
    return new Promise<T>((resolve, reject) => {
      if (signal?.aborted) { reject(signal.reason); return; }
      const item = { fn, resolve, reject, signal } as QueuedRequest<unknown>;
      item.onAbort = () => {
        const index = this.queue.indexOf(item);
        if (index >= 0) this.queue.splice(index, 1);
        reject(signal?.reason);
      };
      signal?.addEventListener("abort", item.onAbort, { once: true });
      this.queue.push(item);
      this.processQueue();
    });
  }

  private processQueue() {
    while (this.activeRequests < this.maxConcurrency && this.queue.length > 0) {
      const item = this.queue.shift()!;
      if (item.onAbort) item.signal?.removeEventListener("abort", item.onAbort);
      if (item.signal?.aborted) { item.reject(item.signal.reason); continue; }
      this.activeRequests++;
      item.fn().then(item.resolve).catch(item.reject).finally(() => {
        this.activeRequests--;
        this.processQueue();
      });
    }
  }

}

/**
 * The busiest normalized paths, for a sync run's metadata. Bounded so an
 * unexpectedly wide histogram can never bloat the persisted JSON.
 */
export function topWisePaths(stats: WiseClientStats, limit = 10): Record<string, number> {
  return Object.fromEntries(
    Object.entries(stats.byPath)
      .sort((a, b) => b[1] - a[1])
      .slice(0, limit),
  );
}

export const DEFAULT_WISE_MAX_CONCURRENCY = 15;

/**
 * AVAIL-00: in-flight cap, operator-tunable via WISE_MAX_CONCURRENCY.
 *
 * The limiter is per WiseClient instance, so it caps one job, not the institute.
 * When Wise returns 429 RATE_LIMITED, lowering this converts failing runs into
 * slower successful ones — the opposite of the usual instinct. Raising it past
 * the default is rarely right: several Wise-facing crons overlap, so the real
 * institute-wide ceiling is already a multiple of this number.
 */
export function resolveWiseMaxConcurrency(): number {
  const raw = process.env.WISE_MAX_CONCURRENCY;
  if (!raw) return DEFAULT_WISE_MAX_CONCURRENCY;
  const parsed = Number.parseInt(raw, 10);
  if (!Number.isFinite(parsed) || parsed < 1) return DEFAULT_WISE_MAX_CONCURRENCY;
  return parsed;
}

export function createWiseClient(options: Pick<WiseClientConfig, "requestsPerSecond" | "signal" | "maxConcurrency"> = {}): WiseClient {
  return new WiseClient({
    userId: process.env.WISE_USER_ID!,
    apiKey: process.env.WISE_API_KEY!,
    namespace: process.env.WISE_NAMESPACE ?? "begifted-education",
    maxConcurrency: resolveWiseMaxConcurrency(),
    ...options,
  });
}

/** Supports Retry-After seconds and HTTP dates. */
export function parseRetryAfter(value: string | null, now = Date.now()): number | null {
  if (!value?.trim()) return null;
  const seconds = Number(value);
  if (Number.isFinite(seconds) && seconds >= 0) return seconds * 1000;
  const date = Date.parse(value);
  return Number.isFinite(date) ? Math.max(0, date - now) : null;
}

export function abortableDelay(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) { reject(signal.reason); return; }
    const onAbort = () => { clearTimeout(timer); reject(signal?.reason); };
    const timer = setTimeout(() => { signal?.removeEventListener("abort", onAbort); resolve(); }, Math.max(0, ms));
    signal?.addEventListener("abort", onAbort, { once: true });
  });
}
