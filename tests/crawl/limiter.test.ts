import { describe, expect, test } from "bun:test";
import { HostLimiter, hostOf } from "../../src/crawl/limiter.ts";

/** A clock and a sleep that advance it, so timing is exact and instant. */
function fake(perSecond = 1) {
  let clock = 0;
  const slept: number[] = [];
  const limiter = new HostLimiter({
    perSecond,
    now: () => clock,
    sleep: async (ms) => {
      slept.push(ms);
      clock += ms;
    },
  });
  return { limiter, slept, tick: (ms: number) => (clock += ms), at: () => clock };
}

describe("HostLimiter", () => {
  test("the first request to a host does not wait", async () => {
    const { limiter, slept } = fake();
    await limiter.take("a.com");
    expect(slept).toEqual([]);
  });

  test("a second request waits the interval", async () => {
    const { limiter, slept } = fake(1);
    await limiter.take("a.com");
    await limiter.take("a.com");
    expect(slept).toEqual([1000]);
  });

  /** Politeness is per host: a slow site must not hold up a fast one. */
  test("different hosts do not queue behind each other", async () => {
    const { limiter, slept } = fake(1);
    await limiter.take("a.com");
    await limiter.take("b.com");
    expect(slept).toEqual([]);
  });

  test("time already elapsed counts towards the interval", async () => {
    const { limiter, slept, tick } = fake(1);
    await limiter.take("a.com");
    tick(1000);
    await limiter.take("a.com");
    expect(slept).toEqual([]);
  });

  test("queued callers stack rather than all seeing the same free moment", async () => {
    const { limiter, slept } = fake(1);
    await limiter.take("a.com");
    await limiter.take("a.com");
    await limiter.take("a.com");
    expect(slept).toEqual([1000, 1000]);
  });

  describe("crawl delay", () => {
    /** A site asking for more gets it. */
    test("a longer stated delay is honoured", () => {
      const { limiter } = fake(1);
      limiter.setCrawlDelay("a.com", 5);
      expect(limiter.intervalFor("a.com")).toBe(5000);
    });

    /**
     * A stated delay is a minimum, not a permission — a site saying 0.01s does
     * not licence us to go that fast.
     */
    test("a shorter stated delay does not speed us past the floor", () => {
      const { limiter } = fake(1);
      limiter.setCrawlDelay("a.com", 0.01);
      expect(limiter.intervalFor("a.com")).toBe(100);
    });

    test("nonsense is ignored rather than applied", () => {
      const { limiter } = fake(1);
      limiter.setCrawlDelay("a.com", null);
      limiter.setCrawlDelay("a.com", -5);
      limiter.setCrawlDelay("a.com", NaN);
      expect(limiter.intervalFor("a.com")).toBe(1000);
    });
  });

  describe("backOff", () => {
    /** A 429 should slow that host, not the whole run. */
    test("doubles the interval for the offending host only", () => {
      const { limiter } = fake(1);
      limiter.backOff("a.com");
      expect(limiter.intervalFor("a.com")).toBe(2000);
      expect(limiter.intervalFor("b.com")).toBe(1000);
    });

    test("honours Retry-After when the server gives one", () => {
      const { limiter } = fake(1);
      limiter.backOff("a.com", 30);
      expect(limiter.intervalFor("a.com")).toBe(30_000);
    });

    test("pushes the next slot out, so the next call actually waits", async () => {
      const { limiter, slept } = fake(1);
      limiter.backOff("a.com", 10);
      await limiter.take("a.com");
      expect(slept).toEqual([10_000]);
    });
  });
});

describe("hostOf", () => {
  test("lowercases the host", () => {
    expect(hostOf("https://Example.COM/x")).toBe("example.com");
  });

  test("keeps the port, since it is a different server", () => {
    expect(hostOf("http://x.com:8080/a")).toBe("x.com:8080");
  });

  /** Anything not fetchable over HTTP must never reach the crawler. */
  test("refuses schemes we do not crawl", () => {
    expect(hostOf("file:///etc/passwd")).toBeNull();
    expect(hostOf("javascript:alert(1)")).toBeNull();
    expect(hostOf("not a url")).toBeNull();
  });
});
