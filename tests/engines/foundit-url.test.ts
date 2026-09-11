import { describe, expect, test } from "bun:test";
import { applyUrlOf } from "../../src/engines/india/foundit.ts";

describe("applyUrlOf", () => {
  /** The outbound link to the employer is the one worth having. */
  test("prefers a real outbound link", () => {
    expect(applyUrlOf({ redirectUrl: "https://click.appcast.io/t/abc" }))
      .toBe("https://click.appcast.io/t/abc");
    expect(applyUrlOf({ applyUrl: "https://employer.com/job/1", redirectUrl: "https://other" }))
      .toBe("https://employer.com/job/1");
  });

  /**
   * The bug: syndicated postings return redirectUrl as an empty string while
   * seoJdUrl still points at foundit's own page. Reading only the first two
   * left 37 postings with no link, including EY and BNY Mellon.
   */
  test("falls back to foundit's own page when the outbound link is empty", () => {
    expect(applyUrlOf({ redirectUrl: "", seoJdUrl: "/job/ey-chennai-india-64949856" }))
      .toBe("https://www.foundit.in/job/ey-chennai-india-64949856");
  });

  test("uses jdUrl when seoJdUrl is absent", () => {
    expect(applyUrlOf({ jdUrl: "/job/x-123" })).toBe("https://www.foundit.in/job/x-123");
  });

  test("prefers the canonical seoJdUrl over jdUrl", () => {
    expect(applyUrlOf({ jdUrl: "/job/a", seoJdUrl: "/job/b" }))
      .toBe("https://www.foundit.in/job/b");
  });

  test("does not double the host on an absolute fallback", () => {
    expect(applyUrlOf({ seoJdUrl: "https://www.foundit.in/job/x" }))
      .toBe("https://www.foundit.in/job/x");
  });

  test("joins a path that has no leading slash", () => {
    expect(applyUrlOf({ jdUrl: "job/x" })).toBe("https://www.foundit.in/job/x");
  });

  test("returns empty when the payload really has no link", () => {
    expect(applyUrlOf({})).toBe("");
    expect(applyUrlOf({ redirectUrl: "", jdUrl: "" })).toBe("");
  });
});
