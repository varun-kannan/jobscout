/**
 * One queue per host, so a slow or fragile site cannot be hammered and a fast
 * one is not held up waiting for it.
 *
 * Politeness here is per host, not global: forty-four hosts at one request a
 * second each is forty-four requests a second in total, which is fine, whereas
 * one host at forty-four is not.
 *
 * A site that states a `Crawl-delay` gets it honoured even when it is slower
 * than our default — it asked.
 */

export interface LimiterOptions {
  /** Requests per second per host when the site has not said otherwise. */
  perSecond?: number;
  /** Never go faster than this, whatever a site permits. */
  minIntervalMs?: number;
  /** Injectable for tests. */
  now?: () => number;
  sleep?: (ms: number) => Promise<void>;
}

const DEFAULT_PER_SECOND = 1;
const FLOOR_MS = 100;

export class HostLimiter {
  private readonly nextFreeAt = new Map<string, number>();
  private readonly delays = new Map<string, number>();
  private readonly defaultIntervalMs: number;
  private readonly floorMs: number;
  private readonly now: () => number;
  private readonly sleep: (ms: number) => Promise<void>;

  constructor(options: LimiterOptions = {}) {
    const perSecond = options.perSecond ?? DEFAULT_PER_SECOND;
    this.defaultIntervalMs = perSecond > 0 ? 1000 / perSecond : 1000;
    this.floorMs = options.minIntervalMs ?? FLOOR_MS;
    this.now = options.now ?? (() => Date.now());
    this.sleep = options.sleep ?? ((ms) => new Promise((r) => setTimeout(r, ms)));
  }

  /** Record a `Crawl-delay` the site asked for, in seconds. */
  setCrawlDelay(host: string, seconds: number | null): void {
    if (seconds === null || !Number.isFinite(seconds) || seconds < 0) return;
    this.delays.set(host, seconds * 1000);
  }

  /** The gap this host gets between requests. */
  intervalFor(host: string): number {
    const asked = this.delays.get(host);
    // A site asking for more gets it; asking for less does not speed us past
    // the floor, because a stated delay is a minimum, not a permission.
    const interval = asked === undefined ? this.defaultIntervalMs : Math.max(asked, this.floorMs);
    return Math.max(interval, this.floorMs);
  }

  /** How long a request to this host would have to wait right now. */
  waitFor(host: string): number {
    const free = this.nextFreeAt.get(host) ?? 0;
    return Math.max(0, free - this.now());
  }

  /**
   * Wait until this host is free, then claim the slot.
   *
   * The slot is claimed before the caller's request runs, so concurrent callers
   * queue behind each other rather than all seeing the same free moment.
   */
  async take(host: string): Promise<void> {
    const interval = this.intervalFor(host);
    const now = this.now();
    const free = this.nextFreeAt.get(host) ?? 0;
    const startAt = Math.max(now, free);

    this.nextFreeAt.set(host, startAt + interval);

    const wait = startAt - now;
    if (wait > 0) await this.sleep(wait);
  }

  /**
   * Back off after a rate-limit response.
   *
   * Doubles this host's interval and pushes the next slot out, so a 429 slows
   * that host rather than the whole run.
   */
  backOff(host: string, retryAfterSeconds?: number | null): void {
    const current = this.intervalFor(host);
    const next = retryAfterSeconds && retryAfterSeconds > 0
      ? retryAfterSeconds * 1000
      : current * 2;
    this.delays.set(host, next);
    this.nextFreeAt.set(host, this.now() + next);
  }

  /** Hosts this limiter has seen, for reporting. */
  hosts(): string[] {
    return [...this.nextFreeAt.keys()];
  }
}

/** The host part of a URL, or null when it is not a URL we can crawl. */
export function hostOf(url: string): string | null {
  try {
    const parsed = new URL(url);
    if (parsed.protocol !== "http:" && parsed.protocol !== "https:") return null;
    return parsed.host.toLowerCase();
  } catch {
    return null;
  }
}
