import { describe, expect, test } from "bun:test";
import { assessLiveness, hasOgTitle, hidesFromShortlist } from "../../src/crawl/liveness.ts";

const at = (over: Partial<Parameters<typeof assessLiveness>[0]> = {}) =>
  assessLiveness({ url: "https://x.com/j/1", outcome: "ok", status: 200,
    finalUrl: "https://x.com/j/1", body: "", ...over });

describe("unreachable is not closed", () => {
  /**
   * The distinction that protects your list: LinkedIn disallows us and Foundit
   * returns 403. Calling those "closed" would delete real jobs on the strength
   * of a site we were never allowed to ask.
   */
  test("robots.txt disallowing us means we do not know", () => {
    const v = at({ outcome: "disallowed" });
    expect(v.state).toBe("unreachable");
    expect(v.reason).toContain("robots.txt");
  });

  test("a 403 means we do not know", () => {
    expect(at({ outcome: "error", status: 403 }).state).toBe("unreachable");
  });

  test("a network failure means we do not know", () => {
    expect(at({ outcome: "error", status: null }).state).toBe("unreachable");
  });

  test("being rate limited means we do not know", () => {
    expect(at({ outcome: "blocked", status: 429 }).state).toBe("unreachable");
  });
});

describe("status-based verdicts", () => {
  test("410 is gone for good", () => {
    expect(at({ outcome: "gone", status: 410 }).state).toBe("gone");
  });

  test("404 is closed", () => {
    expect(at({ outcome: "not_found", status: 404 }).state).toBe("closed");
  });

  /** Byte-identical to last time is evidence it has not been taken down. */
  test("unchanged since last check counts as open", () => {
    expect(at({ outcome: "not_modified", status: 304 }).state).toBe("open");
  });
});

describe("Greenhouse", () => {
  /**
   * The finding that made per-host rules necessary: a dead Greenhouse posting
   * returns 200 and redirects to the board, so a status check alone reports
   * every dead job as open.
   */
  test("a redirect to the board with error=true is closed", () => {
    const v = assessLiveness({
      url: "https://job-boards.greenhouse.io/postman/jobs/7703523003",
      outcome: "ok", status: 200,
      finalUrl: "https://job-boards.greenhouse.io/postman?error=true",
      body: "<html>Current openings at Postman</html>",
    });
    expect(v.state).toBe("closed");
    expect(v.reason).toContain("Greenhouse");
  });

  test("a posting still on its own page is open", () => {
    const v = assessLiveness({
      url: "https://job-boards.greenhouse.io/postman/jobs/123",
      outcome: "ok", status: 200,
      finalUrl: "https://job-boards.greenhouse.io/postman/jobs/123",
      body: "<html>Senior Engineer</html>",
    });
    expect(v.state).toBe("open");
  });
});

describe("Ashby", () => {
  /** A single-page app: both states return 200, so the body decides. */
  test("no og:title means the posting is gone", () => {
    const v = assessLiveness({
      url: "https://jobs.ashbyhq.com/ramp/000", outcome: "ok", status: 200,
      finalUrl: "https://jobs.ashbyhq.com/ramp/000", body: "<title>Jobs</title>",
    });
    expect(v.state).toBe("closed");
  });

  test("an og:title means it is live", () => {
    const v = assessLiveness({
      url: "https://jobs.ashbyhq.com/ramp/abc", outcome: "ok", status: 200,
      finalUrl: "https://jobs.ashbyhq.com/ramp/abc",
      body: '<meta property="og:title" content="Account Executive">',
    });
    expect(v.state).toBe("open");
  });
});

describe("Recruitee", () => {
  test("redirecting to recruitee.com means the board is gone", () => {
    const v = assessLiveness({
      url: "https://accenture.recruitee.com/o/x", outcome: "ok", status: 200,
      finalUrl: "https://recruitee.com/", body: "",
    });
    expect(v.state).toBe("closed");
  });
});

describe("generic rules", () => {
  test("a redirect to a different host reads as closed", () => {
    const v = at({ finalUrl: "https://elsewhere.com/careers" });
    expect(v.state).toBe("closed");
    expect(v.reason).toContain("elsewhere.com");
  });

  test("the wording LinkedIn uses is recognised where we can read it", () => {
    expect(at({ body: "<p>No longer accepting applications</p>" }).state).toBe("closed");
  });

  test("other closed wordings are recognised", () => {
    expect(at({ body: "This position has been filled." }).state).toBe("closed");
    expect(at({ body: "Applications are now closed" }).state).toBe("closed");
  });

  /**
   * A board listing can easily contain a closed phrase for some other posting,
   * so the host rule has to win. This is why phrases are checked last.
   */
  test("a host rule beats a stray phrase in the body", () => {
    const v = assessLiveness({
      url: "https://job-boards.greenhouse.io/x/jobs/1", outcome: "ok", status: 200,
      finalUrl: "https://job-boards.greenhouse.io/x/jobs/1",
      body: "Another role: no longer accepting applications",
    });
    expect(v.state).toBe("open");
  });

  test("an ordinary page with nothing alarming is open", () => {
    expect(at({ body: "<h1>Senior Engineer</h1><p>Apply now</p>" }).state).toBe("open");
  });
});

describe("hasOgTitle", () => {
  test("reads the attribute in either order", () => {
    expect(hasOgTitle('<meta property="og:title" content="X">')).toBe(true);
    expect(hasOgTitle('<meta content="X" property="og:title">')).toBe(true);
  });

  test("an empty title does not count", () => {
    expect(hasOgTitle('<meta property="og:title" content="">')).toBe(false);
    expect(hasOgTitle('<meta property="og:title" content="  ">')).toBe(false);
  });

  test("absent means absent", () => {
    expect(hasOgTitle("<title>Jobs</title>")).toBe(false);
  });
});

describe("hidesFromShortlist", () => {
  /** Only a verdict we are sure of removes a job from your list. */
  test("hides closed and gone, keeps everything uncertain", () => {
    expect(hidesFromShortlist("closed")).toBe(true);
    expect(hidesFromShortlist("gone")).toBe(true);
    expect(hidesFromShortlist("unreachable")).toBe(false);
    expect(hidesFromShortlist("unknown")).toBe(false);
    expect(hidesFromShortlist("open")).toBe(false);
  });
});
