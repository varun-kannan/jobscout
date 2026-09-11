import { describe, expect, test } from "bun:test";
import { parseRobots, isAllowed, pathOf } from "../../src/crawl/robots.ts";

const UA = "jobscout/0.1 (+https://example.com)";
const policy = (text: string, agent = UA) => parseRobots(text, agent);
const can = (text: string, path: string, agent = UA) => isAllowed(policy(text, agent), path);

describe("parseRobots", () => {
  test("reads a simple wildcard group", () => {
    const p = policy(`User-agent: *\nDisallow: /private/`);
    expect(p.rules).toEqual([{ allow: false, pattern: "/private/" }]);
  });

  /** Consecutive user-agent lines share one group of rules. */
  test("shares rules across stacked user-agent lines", () => {
    const p = policy(`User-agent: googlebot\nUser-agent: jobscout\nDisallow: /x/`);
    expect(p.rules).toEqual([{ allow: false, pattern: "/x/" }]);
  });

  /** A group naming us wins over `*`, wherever it appears. */
  test("prefers our own group over the wildcard", () => {
    const text = `User-agent: *\nDisallow: /\n\nUser-agent: jobscout\nDisallow: /admin/`;
    expect(can(text, "/jobs/1")).toBe(true);
    expect(can(text, "/admin/x")).toBe(false);
  });

  test("uses the wildcard when no group names us", () => {
    const text = `User-agent: googlebot\nDisallow: /\n\nUser-agent: *\nDisallow: /private/`;
    expect(can(text, "/jobs/1")).toBe(true);
    expect(can(text, "/private/x")).toBe(false);
  });

  /** No applicable group at all means nothing is forbidden. */
  test("permits everything when no group applies", () => {
    expect(can(`User-agent: googlebot\nDisallow: /`, "/anything")).toBe(true);
  });

  test("ignores comments and blank lines", () => {
    const p = policy(`# hello\n\nUser-agent: *  # everyone\nDisallow: /x/ # not here\n`);
    expect(p.rules).toEqual([{ allow: false, pattern: "/x/" }]);
  });

  test("collects sitemaps and crawl-delay", () => {
    const p = policy(`User-agent: *\nCrawl-delay: 2.5\nSitemap: https://x.com/sitemap.xml`);
    expect(p.crawlDelay).toBe(2.5);
    expect(p.sitemaps).toEqual(["https://x.com/sitemap.xml"]);
  });

  test("survives a malformed file rather than throwing", () => {
    expect(() => policy("garbage\n::::\nUser-agent\nDisallow")).not.toThrow();
  });
});

describe("isAllowed", () => {
  /** An empty Disallow permits everything — the classic inversion. */
  test("an empty Disallow allows everything", () => {
    expect(can(`User-agent: *\nDisallow:`, "/anything")).toBe(true);
  });

  test("a bare slash disallows everything", () => {
    expect(can(`User-agent: *\nDisallow: /`, "/anything")).toBe(false);
  });

  /**
   * The rule that makes "block the section, open one subtree" work. Longest
   * match wins, not first match.
   */
  test("the longest match wins, not the first", () => {
    const text = `User-agent: *\nDisallow: /jobs/\nAllow: /jobs/public/`;
    expect(can(text, "/jobs/secret")).toBe(false);
    expect(can(text, "/jobs/public/1")).toBe(true);
  });

  test("Allow wins a tie of equal length", () => {
    const text = `User-agent: *\nDisallow: /x\nAllow: /x`;
    expect(can(text, "/x")).toBe(true);
  });

  test("* matches any run of characters", () => {
    const text = `User-agent: *\nDisallow: /*/apply`;
    expect(can(text, "/jobs/apply")).toBe(false);
    expect(can(text, "/jobs/view")).toBe(true);
  });

  test("$ anchors the end", () => {
    const text = `User-agent: *\nDisallow: /*.pdf$`;
    expect(can(text, "/a/b.pdf")).toBe(false);
    expect(can(text, "/a/b.pdf.html")).toBe(true);
  });

  test("a path not mentioned at all is allowed", () => {
    expect(can(`User-agent: *\nDisallow: /private/`, "/jobs")).toBe(true);
  });

  /** A pattern that will not compile must not take the crawl down. */
  test("an uncompilable pattern is treated as not matching", () => {
    expect(() => can(`User-agent: *\nDisallow: /[`, "/anything")).not.toThrow();
  });
});

describe("pathOf", () => {
  test("keeps the query, which rules can match on", () => {
    expect(pathOf("https://x.com/jobs?id=1")).toBe("/jobs?id=1");
  });

  test("a bare host is the root", () => {
    expect(pathOf("https://x.com")).toBe("/");
  });

  test("something unparseable is treated as the root", () => {
    expect(pathOf("not a url")).toBe("/");
  });
});
