export type MemoryType = "fact" | "preference" | "episode" | "summary";

export interface Memory {
  _id: string;
  namespace: string;
  userId: string;
  type: MemoryType;
  content: string;
  tags: string[];
  importance: number;
  accessCount: number;
  lastAccessedAt: string;
  createdAt: string;
  expiresAt: string | null;
  status: "active" | "archived";
  source: { sessionId: string | null; messageId: string | null };
  consolidatedInto: string | null;
}

export interface RememberInput {
  userId: string;
  content: string;
  type?: MemoryType;
  tags?: string[];
  importance?: number;
  ttlDays?: number;
  source?: Memory["source"];
}

export interface RecallInput {
  userId: string;
  query: string;
  /** How many memories to return (1 to 50, default 5). */
  k?: number;
  types?: MemoryType[];
  since?: Date | string;
  /** hybrid (default) = keywords + meaning, vector = meaning only, text = keywords only. */
  mode?: "hybrid" | "vector" | "text";
}

/** Why a memory ranked where it did. Values are 0 to 1; ranks are 1-based or null. */
export interface RecallSignals {
  relevance: number;
  importance: number;
  recency: number;
  vectorRank: number | null;
  textRank: number | null;
}

export interface RecallResult {
  memory: Memory;
  score: number;
  signals: RecallSignals;
}

export interface ListInput {
  userId: string;
  type?: MemoryType;
  status?: "active" | "archived";
  limit?: number;
  cursor?: string;
}

export class EngramApiError extends Error {
  constructor(
    public readonly status: number,
    public readonly code: string,
    message: string,
    public readonly details?: unknown,
  ) {
    super(message);
    this.name = "EngramApiError";
  }
}

export interface ClientOptions {
  baseUrl: string;
  namespace: string;
  apiKey: string;
  maxRetries?: number;
  timeoutMs?: number;
  fetch?: typeof fetch;
}

export class EngramClient {
  private readonly baseUrl: string;
  private readonly maxRetries: number;
  private readonly timeoutMs: number;

  constructor(private readonly options: ClientOptions) {
    const url = new URL(options.baseUrl);
    if (
      !["http:", "https:"].includes(url.protocol) ||
      url.username ||
      url.password ||
      url.search ||
      url.hash
    )
      throw new Error("Use an HTTP base URL without credentials, query parameters, or fragments.");
    if (!options.namespace.trim() || !options.apiKey)
      throw new Error("Namespace and API key are required.");
    this.baseUrl = options.baseUrl.replace(/\/+$/, "");
    this.maxRetries = options.maxRetries ?? 2;
    this.timeoutMs = options.timeoutMs ?? 30000;
    if (
      !Number.isInteger(this.maxRetries) ||
      this.maxRetries < 0 ||
      this.maxRetries > 5 ||
      !Number.isInteger(this.timeoutMs) ||
      this.timeoutMs < 1
    )
      throw new Error("Invalid retry or timeout settings.");
  }

  remember(input: RememberInput, signal?: AbortSignal): Promise<Memory> {
    return this.request(
      "/remember",
      "POST",
      { ...input, namespace: this.options.namespace },
      false,
      signal,
    );
  }

  recall(input: RecallInput, signal?: AbortSignal): Promise<RecallResult[]> {
    return this.request(
      "/recall",
      "POST",
      { ...input, namespace: this.options.namespace },
      true,
      signal,
    );
  }

  forget(
    input: { id: string } | { userId: string },
    signal?: AbortSignal,
  ): Promise<{ deleted: number }> {
    return this.request(
      "/forget",
      "POST",
      "id" in input ? input : { ...input, namespace: this.options.namespace },
      false,
      signal,
    );
  }

  list(
    input: ListInput,
    signal?: AbortSignal,
  ): Promise<{ memories: Memory[]; nextCursor: string | null }> {
    const query = new URLSearchParams({ namespace: this.options.namespace });
    for (const [key, value] of Object.entries(input))
      if (value !== undefined) query.set(key, String(value));
    return this.request(`/memories?${query}`, "GET", undefined, true, signal);
  }

  private async request<T>(
    path: string,
    method: string,
    body: unknown,
    retryable: boolean,
    signal?: AbortSignal,
  ): Promise<T> {
    const attempts = retryable ? this.maxRetries + 1 : 1;
    for (let attempt = 0; attempt < attempts; attempt++) {
      signal?.throwIfAborted();
      let delay = Math.min(10000, 250 * 2 ** attempt + Math.random() * 100);
      try {
        const timeout = AbortSignal.timeout(this.timeoutMs);
        const response = await (this.options.fetch ?? fetch)(`${this.baseUrl}${path}`, {
          method,
          headers: {
            "x-api-key": this.options.apiKey,
            ...(body === undefined ? {} : { "Content-Type": "application/json" }),
          },
          body: body === undefined ? undefined : JSON.stringify(body),
          signal: signal ? AbortSignal.any([signal, timeout]) : timeout,
          redirect: "error",
        });
        if (response.ok) return (await response.json()) as T;
        const data = (await response.json().catch(() => null)) as {
          error?: { code?: string; message?: string; details?: unknown };
        } | null;
        const error = new EngramApiError(
          response.status,
          data?.error?.code ?? "HTTP_ERROR",
          data?.error?.message ?? `HTTP ${response.status}`,
          data?.error?.details,
        );
        if (![429, 502, 503, 504].includes(response.status) || attempt === attempts - 1)
          throw error;
        const retryAfter = response.headers.get("retry-after");
        if (retryAfter) {
          const seconds = Number(retryAfter);
          const duration = Number.isFinite(seconds)
            ? seconds * 1000
            : Date.parse(retryAfter) - Date.now();
          if (Number.isFinite(duration)) delay = Math.min(10000, Math.max(0, duration));
        }
      } catch (error) {
        if (
          signal?.aborted ||
          error instanceof EngramApiError ||
          attempt === attempts - 1 ||
          !(error instanceof TypeError || (error instanceof Error && error.name === "TimeoutError"))
        )
          throw error;
      }
      await new Promise<void>((resolve, reject) => {
        const abort = () => {
          clearTimeout(timer);
          signal?.removeEventListener("abort", abort);
          reject(signal?.reason);
        };
        const timer = setTimeout(() => {
          signal?.removeEventListener("abort", abort);
          resolve();
        }, delay);
        signal?.addEventListener("abort", abort, { once: true });
        if (signal?.aborted) abort();
      });
    }
    throw new Error("Request exhausted its attempts.");
  }
}
