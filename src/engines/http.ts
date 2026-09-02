/**
 * The one way engines reach the network.
 *
 * Centralised so every source gets the same timeout, retry, and politeness
 * behaviour, and so tests can hand an engine a recorded response instead of a
 * socket. No engine calls `fetch` directly.
 */

export class HttpError extends Error {
  constructor(
    message: string,
    readonly status: number,
    readonly url: string,
    readonly body?: string,
  ) {
    super(message);
    this.name = "HttpError";
  }

  /** 429 and 5xx are worth retrying; 4xx generally is not. */
  get retryable(): boolean {
    return this.status === 429 || this.status >= 500;
  }

  get rateLimited(): boolean {
    return this.status === 429;
  }
}

export interface HttpOptions {
  headers?: Record<string, string>;
  /** Milliseconds before the request is abandoned. */
  timeoutMs?: number;
  /** Attempts after the first, for retryable failures only. */
  retries?: number;
  signal?: AbortSignal;
  method?: "GET" | "POST";
  body?: string;
}

export interface HttpClient {
  json<T = unknown>(url: string, options?: HttpOptions): Promise<T>;
  text(url: string, options?: HttpOptions): Promise<string>;
}

const DEFAULT_TIMEOUT = 20_000;
const DEFAULT_RETRIES = 2;

/**
 * A plain, honest user agent naming the tool and linking to it.
 *
 * Not a spoofed browser string: every source shipped by default offers a public
 * interface meant to be consumed, so there is nothing to disguise. Anything
 * requiring disguise is out of scope.
 */
const USER_AGENT = "jobscout/0.1 (+https://github.com/jobscout/jobscout)";

function sleep(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(resolve, ms);
    signal?.addEventListener(
      "abort",
      () => {
        clearTimeout(timer);
        reject(new Error("aborted"));
      },
      { once: true },
    );
  });
}

/** Exponential backoff, honouring Retry-After when the server sends one. */
function backoffMs(attempt: number, retryAfter?: string | null): number {
  if (retryAfter) {
    const seconds = Number(retryAfter);
    if (Number.isFinite(seconds) && seconds > 0) return Math.min(seconds * 1000, 30_000);
  }
  return Math.min(500 * 2 ** attempt, 8_000);
}

export function createHttpClient(defaults: HttpOptions = {}): HttpClient {
  async function request(url: string, options: HttpOptions): Promise<Response> {
    const timeoutMs = options.timeoutMs ?? defaults.timeoutMs ?? DEFAULT_TIMEOUT;
    const retries = options.retries ?? defaults.retries ?? DEFAULT_RETRIES;

    let lastError: unknown;

    for (let attempt = 0; attempt <= retries; attempt++) {
      const timeout = AbortSignal.timeout(timeoutMs);
      // The caller's signal cancels the whole run; the timeout cancels this try.
      const signal = options.signal
        ? AbortSignal.any([options.signal, timeout])
        : timeout;

      try {
        const response = await fetch(url, {
          method: options.method ?? "GET",
          headers: {
            "user-agent": USER_AGENT,
            accept: "application/json",
            ...defaults.headers,
            ...options.headers,
          },
          body: options.body,
          signal,
          redirect: "follow",
        });

        if (response.ok) return response;

        const body = await response.text().catch(() => "");
        const error = new HttpError(
          `HTTP ${response.status} from ${new URL(url).host}`,
          response.status,
          url,
          body.slice(0, 300),
        );

        if (!error.retryable || attempt === retries) throw error;
        await sleep(backoffMs(attempt, response.headers.get("retry-after")), options.signal);
        lastError = error;
        continue;
      } catch (err) {
        // A caller-initiated abort is final; never retry through it.
        if (options.signal?.aborted) throw err;
        if (err instanceof HttpError && !err.retryable) throw err;
        if (attempt === retries) throw err;
        lastError = err;
        await sleep(backoffMs(attempt), options.signal);
      }
    }

    throw lastError ?? new Error(`request failed: ${url}`);
  }

  return {
    async json<T>(url: string, options: HttpOptions = {}): Promise<T> {
      const response = await request(url, options);
      const text = await response.text();
      try {
        return JSON.parse(text) as T;
      } catch {
        throw new HttpError(
          `expected JSON but got ${text.slice(0, 60)}…`,
          response.status,
          url,
        );
      }
    },

    async text(url: string, options: HttpOptions = {}): Promise<string> {
      const response = await request(url, options);
      return response.text();
    },
  };
}

/** A client that serves recorded responses. Used by the contract tests. */
export function createStubClient(routes: Record<string, unknown>): HttpClient {
  function lookup(url: string): unknown {
    if (url in routes) return routes[url];
    // Fall back to a prefix match so tests need not spell out query strings.
    const key = Object.keys(routes).find((r) => url.startsWith(r));
    if (key) return routes[key];
    throw new HttpError(`no recorded response for ${url}`, 404, url);
  }

  return {
    async json<T>(url: string): Promise<T> {
      return lookup(url) as T;
    },
    async text(url: string): Promise<string> {
      const value = lookup(url);
      return typeof value === "string" ? value : JSON.stringify(value);
    },
  };
}
