export interface WiseClientConfig {
  userId: string;
  apiKey: string;
  namespace: string;
  baseUrl?: string;
  maxConcurrency?: number;
  maxRetries?: number;
}

interface QueuedRequest<T> {
  fn: () => Promise<T>;
  resolve: (value: T) => void;
  reject: (reason: unknown) => void;
}

export class WiseClient {
  private userId: string;
  private apiKey: string;
  private namespace: string;
  private baseUrl: string;
  private maxRetries: number;

  // Simple concurrency limiter
  private maxConcurrency: number;
  private activeRequests = 0;
  private queue: QueuedRequest<unknown>[] = [];

  constructor(config: WiseClientConfig) {
    this.userId = config.userId;
    this.apiKey = config.apiKey;
    this.namespace = config.namespace;
    this.baseUrl = config.baseUrl ?? "https://api.wiseapp.live";
    this.maxConcurrency = config.maxConcurrency ?? 5;
    this.maxRetries = config.maxRetries ?? 3;
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

  async get<T>(path: string, params?: Record<string, string>): Promise<T> {
    const url = new URL(`${this.baseUrl}${path}`);
    if (params) {
      for (const [k, v] of Object.entries(params)) {
        url.searchParams.set(k, v);
      }
    }
    return this.withConcurrency(() => this.fetchWithRetry<T>(url.toString(), { method: "GET" }));
  }

  async post<T>(path: string, body: unknown): Promise<T> {
    return this.withConcurrency(() =>
      this.fetchWithRetry<T>(`${this.baseUrl}${path}`, {
        method: "POST",
        body: JSON.stringify(body),
      })
    );
  }

  private async fetchWithRetry<T>(url: string, init: RequestInit, attempt = 0): Promise<T> {
    try {
      const response = await fetch(url, {
        ...init,
        headers: {
          ...this.headers,
          ...(init.headers as Record<string, string> | undefined),
        },
      });

      if (!response.ok) {
        const text = await response.text().catch(() => "");
        throw new Error(`Wise API ${response.status}: ${text} (${url})`);
      }

      return (await response.json()) as T;
    } catch (error) {
      if (attempt < this.maxRetries) {
        const delay = Math.pow(2, attempt) * 1000; // 1s, 2s, 4s
        await new Promise((r) => setTimeout(r, delay));
        return this.fetchWithRetry<T>(url, init, attempt + 1);
      }
      throw error;
    }
  }

  private withConcurrency<T>(fn: () => Promise<T>): Promise<T> {
    return new Promise<T>((resolve, reject) => {
      this.queue.push({ fn, resolve, reject } as QueuedRequest<unknown>);
      this.processQueue();
    });
  }

  private processQueue() {
    while (this.activeRequests < this.maxConcurrency && this.queue.length > 0) {
      const item = this.queue.shift()!;
      this.activeRequests++;
      item
        .fn()
        .then(item.resolve)
        .catch(item.reject)
        .finally(() => {
          this.activeRequests--;
          this.processQueue();
        });
    }
  }
}

export function createWiseClient(): WiseClient {
  return new WiseClient({
    userId: process.env.WISE_USER_ID!,
    apiKey: process.env.WISE_API_KEY!,
    namespace: process.env.WISE_NAMESPACE ?? "begifted-education",
  });
}
