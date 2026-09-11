import { describe, expect, test, beforeEach } from "bun:test";
import { Database } from "bun:sqlite";
import { Crawler } from "../../src/crawl/crawler.ts";

/** Every request the stub saw, so we can assert what was *not* fetched. */
interface Call { url: string; headers: Record<string, string> }

function setup(
  routes: Record<string, { status?: number; body?: string; headers?: Record<string, string> }>,
  options: Record<string, unknown> = {},
) {
  const db = new Database(":memory:");
  db.run(`CREATE TABLE crawl_log (url TEXT PRIMARY KEY, host TEXT NOT NULL, outcome TEXT NOT NULL,
    status INTEGER, etag TEXT, last_modified TEXT, content_hash TEXT, content_length INTEGER,
    fetched_at TEXT NOT NULL, error TEXT)`);
  db.run(`CREATE TABLE robots_cache (host TEXT PRIMARY KEY, body TEXT NOT NULL,
    fetched_at TEXT NOT NULL, reachable INTEGER NOT NULL DEFAULT 1)`);

  const calls: Call[] = [];
  const fetchImpl = (async (url: string | URL, init?: RequestInit) => {
    const key = String(url);
    calls.push({ url: key, headers: (init?.headers ?? {}) as Record<string, string> });
    const route = routes[key];
    if (!route) return new Response("not found", { status: 404 });
    if (route.status === 0) throw new Error("network down");
    return new Response(route.body ?? "", {
      status: route.status ?? 200,
      headers: route.headers ?? {},
    });
  }) as unknown as typeof fetch;

  const crawler = new Crawler({
    db, fetchImpl, perSecond: 1000, freshForMs: 0, ...options,
  });
  return { db, crawler, calls };
}

const ROBOTS_ALLOW = { "https://x.com/robots.txt": { body: "User-agent: *\nDisallow: /private/" } };

describe("Crawler", () => {
  test("fetches a permitted page and returns its body", async () => {
    const { crawler } = setup({ ...ROBOTS_ALLOW, "https://x.com/jobs/1": { body: "hello" } });
    const r = await crawler.fetchUrl("https://x.com/jobs/1");
    expect(r.outcome).toBe("ok");
    expect(r.body).toBe("hello");
    expect(r.contentHash).toBeTruthy();
  });

  /** The whole point: a disallowed path is never requested at all. */
  test("never requests a path robots.txt disallows", async () => {
    const { crawler, calls } = setup({ ...ROBOTS_ALLOW, "https://x.com/private/1": { body: "x" } });
    const r = await crawler.fetchUrl("https://x.com/private/1");
    expect(r.outcome).toBe("disallowed");
    expect(r.body).toBeNull();
    expect(calls.map((c) => c.url)).toEqual(["https://x.com/robots.txt"]);
  });

  test("reads robots.txt once per host, not once per request", async () => {
    const { crawler, calls } = setup({
      ...ROBOTS_ALLOW,
      "https://x.com/a": { body: "a" }, "https://x.com/b": { body: "b" },
    });
    await crawler.fetchUrl("https://x.com/a");
    await crawler.fetchUrl("https://x.com/b");
    expect(calls.filter((c) => c.url.endsWith("robots.txt"))).toHaveLength(1);
  });

  /** A 404 for robots.txt means there are no rules, per the RFC. */
  test("treats a missing robots.txt as no rules", async () => {
    const { crawler } = setup({ "https://x.com/a": { body: "a" } });
    expect((await crawler.fetchUrl("https://x.com/a")).outcome).toBe("ok");
  });

  /**
   * A host we cannot ask has not given permission. A failing site should not
   * also be crawled on the assumption it is fine.
   */
  test("treats an unreachable robots.txt as do-not-crawl", async () => {
    const { crawler } = setup({
      "https://x.com/robots.txt": { status: 0 },
      "https://x.com/a": { body: "a" },
    });
    expect((await crawler.fetchUrl("https://x.com/a")).outcome).toBe("disallowed");
  });

  test("treats a 5xx robots.txt as do-not-crawl", async () => {
    const { crawler } = setup({
      "https://x.com/robots.txt": { status: 503 },
      "https://x.com/a": { body: "a" },
    });
    expect((await crawler.fetchUrl("https://x.com/a")).outcome).toBe("disallowed");
  });

  describe("conditional requests", () => {
    test("sends the stored validators on a repeat visit", async () => {
      const { crawler, calls } = setup({
        ...ROBOTS_ALLOW,
        "https://x.com/a": { body: "a", headers: { etag: 'W/"v1"', "last-modified": "Mon, 1 Jan 2026 00:00:00 GMT" } },
      });
      await crawler.fetchUrl("https://x.com/a");
      await crawler.fetchUrl("https://x.com/a");
      const second = calls.filter((c) => c.url === "https://x.com/a")[1]!;
      expect(second.headers["if-none-match"]).toBe('W/"v1"');
      expect(second.headers["if-modified-since"]).toBe("Mon, 1 Jan 2026 00:00:00 GMT");
    });

    test("a 304 is reported as unchanged, not as a failure", async () => {
      const { crawler } = setup({ ...ROBOTS_ALLOW, "https://x.com/a": { status: 304 } });
      const r = await crawler.fetchUrl("https://x.com/a");
      expect(r.outcome).toBe("not_modified");
      expect(crawler.stats.notModified).toBe(1);
    });
  });

  describe("outcomes", () => {
    test("distinguishes gone from merely missing", async () => {
      const { crawler } = setup({
        ...ROBOTS_ALLOW,
        "https://x.com/a": { status: 404 }, "https://x.com/b": { status: 410 },
      });
      expect((await crawler.fetchUrl("https://x.com/a")).outcome).toBe("not_found");
      expect((await crawler.fetchUrl("https://x.com/b")).outcome).toBe("gone");
    });

    test("a rate limit is recorded as blocked and slows that host", async () => {
      const { crawler } = setup({
        ...ROBOTS_ALLOW,
        "https://x.com/a": { status: 429, headers: { "retry-after": "30" } },
      });
      const r = await crawler.fetchUrl("https://x.com/a");
      expect(r.outcome).toBe("blocked");
      expect(crawler.stats.blocked).toBe(1);
    });

    /** One dead host must not stop a crawl of thousands of pages. */
    test("a network failure comes back as a result, not a throw", async () => {
      const { crawler } = setup({ ...ROBOTS_ALLOW, "https://x.com/a": { status: 0 } });
      const r = await crawler.fetchUrl("https://x.com/a");
      expect(r.outcome).toBe("error");
      expect(r.error).toContain("network down");
    });

    test("refuses a scheme it cannot crawl", async () => {
      const { crawler, calls } = setup({});
      const r = await crawler.fetchUrl("file:///etc/passwd");
      expect(r.outcome).toBe("error");
      expect(calls).toHaveLength(0);
    });
  });

  describe("budget and freshness", () => {
    /** Crawling is the one command that can generate unbounded work. */
    test("stops once the run's request budget is spent", async () => {
      const { crawler } = setup(
        { ...ROBOTS_ALLOW, "https://x.com/a": { body: "a" }, "https://x.com/b": { body: "b" } },
        { maxRequests: 2 },
      );
      await crawler.fetchUrl("https://x.com/a");
      const second = await crawler.fetchUrl("https://x.com/b");
      expect(second.outcome).toBe("error");
      expect(second.error).toContain("budget");
      expect(crawler.stats.budgetExhausted).toBe(true);
    });

    test("serves a recent visit from the log without a request", async () => {
      const { crawler, calls } = setup(
        { ...ROBOTS_ALLOW, "https://x.com/a": { body: "a" } },
        { freshForMs: 60_000 },
      );
      await crawler.fetchUrl("https://x.com/a");
      const before = calls.length;
      const again = await crawler.fetchUrl("https://x.com/a");
      expect(again.cached).toBe(true);
      expect(calls.length).toBe(before);
    });

    test("force ignores freshness", async () => {
      const { crawler, calls } = setup(
        { ...ROBOTS_ALLOW, "https://x.com/a": { body: "a" } },
        { freshForMs: 60_000 },
      );
      await crawler.fetchUrl("https://x.com/a");
      const before = calls.length;
      await crawler.fetchUrl("https://x.com/a", { force: true });
      expect(calls.length).toBeGreaterThan(before);
    });
  });

  test("records every visit in the crawl log", async () => {
    const { crawler, db } = setup({ ...ROBOTS_ALLOW, "https://x.com/a": { body: "a" } });
    await crawler.fetchUrl("https://x.com/a");
    const row = db.query<{ outcome: string; host: string }, []>(
      `SELECT outcome, host FROM crawl_log WHERE url='https://x.com/a'`).get();
    expect(row!.outcome).toBe("ok");
    expect(row!.host).toBe("x.com");
  });
});
