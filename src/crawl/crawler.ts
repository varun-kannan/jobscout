/**
 * The crawler: one place that decides whether a URL may be fetched, waits its
 * turn, asks the server whether anything changed, and records what happened.
 *
 * Nothing else in jobscout should call `fetch` on a page found in the wild.
 * Routing every such request through here is what makes robots.txt and rate
 * limits enforceable rather than aspirational — a rule you can bypass by
 * calling fetch directly is not a rule.
 *
 * A run has a hard request budget. Crawling is the one part of jobscout that
 * can generate unbounded work from a single command, and a cap is the
 * difference between a long job and a runaway one.
 */

import type { Database } from "bun:sqlite";
import { EMPTY_POLICY, isAllowed, parseRobots, pathOf, type RobotsPolicy } from "./robots.ts";
import { HostLimiter, hostOf } from "./limiter.ts";

export type CrawlOutcome =
  | "ok"
  | "not_modified"
  | "disallowed"
  | "blocked"
  | "not_found"
  | "gone"
  | "error";

export interface CrawlResult {
  url: string;
  host: string;
  outcome: CrawlOutcome;
  status: number | null;
  /** Absent for every outcome but `ok`. */
  body: string | null;
  /** The URL we ended on, which is how a dead posting redirects to a list. */
  finalUrl: string | null;
  etag: string | null;
  lastModified: string | null;
  contentHash: string | null;
  error: string | null;
  /** True when served from our own record without touching the network. */
  cached: boolean;
}

export interface CrawlerOptions {
  db: Database;
  userAgent?: string;
  /** Requests per second per host. */
  perSecond?: number;
  /** Hard cap for this run. */
  maxRequests?: number;
  /** Skip anything fetched more recently than this. */
  freshForMs?: number;
  /** Largest body we will read. */
  maxBytes?: number;
  fetchImpl?: typeof fetch;
  now?: () => Date;
}

const DEFAULT_UA = "jobscout/0.1 (+https://github.com/jobscout/jobscout)";
const DEFAULT_MAX_REQUESTS = 2000;
const DEFAULT_FRESH_MS = 6 * 60 * 60 * 1000;
const DEFAULT_MAX_BYTES = 2 * 1024 * 1024;
const ROBOTS_TTL_MS = 24 * 60 * 60 * 1000;

export interface CrawlStats {
  requested: number;
  ok: number;
  notModified: number;
  disallowed: number;
  blocked: number;
  errors: number;
  cached: number;
  /** True when the run stopped because it hit its cap. */
  budgetExhausted: boolean;
}

export class Crawler {
  private readonly db: Database;
  private readonly ua: string;
  private readonly limiter: HostLimiter;
  private readonly maxRequests: number;
  private readonly freshForMs: number;
  private readonly maxBytes: number;
  private readonly doFetch: typeof fetch;
  private readonly now: () => Date;
  private readonly policies = new Map<string, RobotsPolicy>();

  readonly stats: CrawlStats = {
    requested: 0, ok: 0, notModified: 0, disallowed: 0,
    blocked: 0, errors: 0, cached: 0, budgetExhausted: false,
  };

  constructor(options: CrawlerOptions) {
    this.db = options.db;
    this.ua = options.userAgent ?? DEFAULT_UA;
    this.limiter = new HostLimiter({ perSecond: options.perSecond });
    this.maxRequests = options.maxRequests ?? DEFAULT_MAX_REQUESTS;
    this.freshForMs = options.freshForMs ?? DEFAULT_FRESH_MS;
    this.maxBytes = options.maxBytes ?? DEFAULT_MAX_BYTES;
    this.doFetch = options.fetchImpl ?? fetch;
    this.now = options.now ?? (() => new Date());
  }

  /** Requests still available in this run. */
  get remaining(): number {
    return Math.max(0, this.maxRequests - this.stats.requested);
  }

  /**
   * The rules for a host, fetched at most once a day.
   *
   * A robots.txt we cannot read is treated as no rules — that is what the RFC
   * says a 404 means — but a 5xx is treated as "do not crawl", because a site
   * that is failing should not also be crawled on the assumption it is fine.
   */
  private async policyFor(host: string): Promise<RobotsPolicy> {
    const held = this.policies.get(host);
    if (held) return held;

    const cached = this.db
      .query<{ body: string; fetched_at: string; reachable: number }, [string]>(
        `SELECT body, fetched_at, reachable FROM robots_cache WHERE host = ?`,
      )
      .get(host);

    const age = cached ? this.now().getTime() - Date.parse(cached.fetched_at) : Infinity;
    if (cached && Number.isFinite(age) && age < ROBOTS_TTL_MS) {
      const policy = cached.reachable
        ? parseRobots(cached.body, this.ua)
        : { ...EMPTY_POLICY, rules: [{ allow: false, pattern: "/" }] };
      this.policies.set(host, policy);
      this.limiter.setCrawlDelay(host, policy.crawlDelay);
      return policy;
    }

    let body = "";
    let reachable = 1;
    try {
      this.stats.requested++;
      await this.limiter.take(host);
      const response = await this.doFetch(`https://${host}/robots.txt`, {
        headers: { "user-agent": this.ua, accept: "text/plain" },
        redirect: "follow",
        signal: AbortSignal.timeout(15_000),
      });
      if (response.ok) body = (await response.text()).slice(0, 512_000);
      else if (response.status >= 500) reachable = 0;
      // 404 and other 4xx mean there are simply no rules.
    } catch {
      // Unreachable is not permission. A host we cannot ask is left alone.
      reachable = 0;
    }

    this.db
      .query(
        `INSERT INTO robots_cache (host, body, fetched_at, reachable) VALUES (?, ?, ?, ?)
         ON CONFLICT(host) DO UPDATE SET body = excluded.body,
           fetched_at = excluded.fetched_at, reachable = excluded.reachable`,
      )
      .run(host, body, this.now().toISOString(), reachable);

    const policy = reachable
      ? parseRobots(body, this.ua)
      : { ...EMPTY_POLICY, rules: [{ allow: false, pattern: "/" }] };
    this.policies.set(host, policy);
    this.limiter.setCrawlDelay(host, policy.crawlDelay);
    return policy;
  }

  /** A previous visit, if we have one. */
  private record(url: string) {
    return this.db
      .query<
        { outcome: string; status: number | null; etag: string | null;
          last_modified: string | null; content_hash: string | null; fetched_at: string },
        [string]
      >(
        `SELECT outcome, status, etag, last_modified, content_hash, fetched_at
         FROM crawl_log WHERE url = ?`,
      )
      .get(url);
  }

  private log(result: CrawlResult): void {
    this.db
      .query(
        `INSERT INTO crawl_log (url, host, outcome, status, etag, last_modified,
                                content_hash, content_length, fetched_at, error)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT(url) DO UPDATE SET
           outcome = excluded.outcome, status = excluded.status,
           etag = COALESCE(excluded.etag, crawl_log.etag),
           last_modified = COALESCE(excluded.last_modified, crawl_log.last_modified),
           content_hash = COALESCE(excluded.content_hash, crawl_log.content_hash),
           content_length = excluded.content_length,
           fetched_at = excluded.fetched_at, error = excluded.error`,
      )
      .run(
        result.url, result.host, result.outcome, result.status, result.etag,
        result.lastModified, result.contentHash,
        result.body ? result.body.length : null,
        this.now().toISOString(), result.error,
      );
  }

  /**
   * Fetch one URL, or explain why not.
   *
   * Never throws for an ordinary failure: a crawl of thousands of pages must
   * not stop because one host is down, so every outcome comes back as a result.
   */
  async fetchUrl(url: string, options: { force?: boolean } = {}): Promise<CrawlResult> {
    const host = hostOf(url);
    const base = (outcome: CrawlOutcome, extra: Partial<CrawlResult> = {}): CrawlResult => ({
      url, host: host ?? "", outcome, status: null, body: null, finalUrl: null,
      etag: null, lastModified: null, contentHash: null, error: null, cached: false,
      ...extra,
    });

    if (!host) return base("error", { error: "Not an http(s) URL" });

    const previous = this.record(url);

    // Something fetched a moment ago is not worth asking about again.
    if (!options.force && previous) {
      const age = this.now().getTime() - Date.parse(previous.fetched_at);
      if (Number.isFinite(age) && age < this.freshForMs) {
        this.stats.cached++;
        return base(previous.outcome as CrawlOutcome, {
          status: previous.status, cached: true,
          etag: previous.etag, lastModified: previous.last_modified,
          contentHash: previous.content_hash,
        });
      }
    }

    const policy = await this.policyFor(host);
    if (!isAllowed(policy, pathOf(url))) {
      this.stats.disallowed++;
      const result = base("disallowed", { error: "robots.txt disallows this path" });
      this.log(result);
      return result;
    }

    if (this.remaining <= 0) {
      this.stats.budgetExhausted = true;
      return base("error", { error: "Request budget for this run is exhausted" });
    }

    await this.limiter.take(host);
    this.stats.requested++;

    try {
      const headers: Record<string, string> = {
        "user-agent": this.ua,
        accept: "text/html,application/xhtml+xml,application/json;q=0.9,*/*;q=0.8",
      };
      // Ask whether anything changed rather than downloading it again.
      if (!options.force && previous?.etag) headers["if-none-match"] = previous.etag;
      if (!options.force && previous?.last_modified) {
        headers["if-modified-since"] = previous.last_modified;
      }

      const response = await this.doFetch(url, {
        headers,
        redirect: "follow",
        signal: AbortSignal.timeout(20_000),
      });

      const etag = response.headers.get("etag");
      const lastModified = response.headers.get("last-modified");

      if (response.status === 304) {
        this.stats.notModified++;
        const result = base("not_modified", {
          status: 304, finalUrl: response.url || url, etag, lastModified,
          contentHash: previous?.content_hash ?? null,
        });
        this.log(result);
        return result;
      }

      if (response.status === 429 || response.status === 503) {
        const retryAfter = Number(response.headers.get("retry-after"));
        this.limiter.backOff(host, Number.isFinite(retryAfter) ? retryAfter : null);
        this.stats.blocked++;
        const result = base("blocked", { status: response.status, error: "rate limited" });
        this.log(result);
        return result;
      }

      if (response.status === 404 || response.status === 410) {
        // Distinguished because a 410 is the site saying it is gone for good.
        const outcome: CrawlOutcome = response.status === 410 ? "gone" : "not_found";
        this.stats.ok++;
        const result = base(outcome, { status: response.status, finalUrl: response.url || url });
        this.log(result);
        return result;
      }

      if (!response.ok) {
        this.stats.errors++;
        const result = base("error", {
          status: response.status, error: `HTTP ${response.status}`,
        });
        this.log(result);
        return result;
      }

      const body = (await response.text()).slice(0, this.maxBytes);
      this.stats.ok++;
      const result = base("ok", {
        status: response.status,
        body,
        finalUrl: response.url || url,
        etag,
        lastModified,
        contentHash: Bun.hash(body).toString(36),
      });
      this.log(result);
      return result;
    } catch (err) {
      this.stats.errors++;
      const message = err instanceof Error ? err.message : String(err);
      const result = base("error", { error: message });
      this.log(result);
      return result;
    }
  }
}
