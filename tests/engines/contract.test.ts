/**
 * One suite every engine must pass.
 *
 * Shapes here were taken from live responses during development, trimmed to the
 * fields the engines actually read. A new engine cannot ship half-implemented:
 * it either satisfies the same contract as the rest or it fails here.
 */

import { describe, expect, test } from "bun:test";
import { ENGINES, getEngine, runEngines } from "../../src/engines/registry.ts";
import { createStubClient } from "../../src/engines/http.ts";
import { defaultConfig, type Secrets } from "../../src/config/schema.ts";
import type { Board, EngineContext, RawJob } from "../../src/engines/engine.ts";
import { clean, htmlToText, looksRemote } from "../../src/engines/engine.ts";

const QUERY = { terms: ["backend"], locations: [], remoteOnly: false, maxAgeDays: 30 };

function contextWith(
  routes: Record<string, unknown>,
  boards: Board[],
  secrets: Secrets = {},
): EngineContext {
  return {
    config: defaultConfig(),
    secrets,
    query: QUERY,
    http: createStubClient(routes),
    boards,
    signal: new AbortController().signal,
  };
}

/* ── recorded fixtures, trimmed to what the engines read ───────────── */

const FIXTURES: Record<
  string,
  {
    board: Board;
    routes: Record<string, unknown>;
    expect: Partial<RawJob>;
    /** Present for engines that need a credential before they will run. */
    secrets?: Secrets;
  }
> = {
  greenhouse: {
    board: { company: "Stripe", ats: "greenhouse", token: "stripe" },
    routes: {
      "https://boards-api.greenhouse.io/v1/boards/stripe/jobs": {
        jobs: [
          {
            id: 8130725,
            title: "Backend Engineer, Payments",
            absolute_url: "https://stripe.com/jobs/search?gh_jid=8130725",
            company_name: "Stripe",
            location: { name: "Remote, India" },
            first_published: "2026-08-01T00:00:00Z",
            content: "&lt;p&gt;Build ledgers.&lt;/p&gt;&lt;li&gt;Go&lt;/li&gt;",
          },
        ],
      },
    },
    expect: { nativeId: "8130725", company: "Stripe", remote: true },
  },

  lever: {
    board: { company: "Meesho", ats: "lever", token: "meesho" },
    routes: {
      "https://api.lever.co/v0/postings/meesho": [
        {
          id: "abc-123",
          text: "Senior Backend Engineer",
          hostedUrl: "https://jobs.lever.co/meesho/abc-123",
          applyUrl: "https://jobs.lever.co/meesho/abc-123/apply",
          descriptionPlain: "Own the payments platform end to end.",
          additionalPlain: "PostgreSQL, Go, Kafka.",
          createdAt: 1754006400000,
          categories: { location: "Bengaluru, India", commitment: "Full-time" },
        },
      ],
    },
    expect: { nativeId: "abc-123", company: "Meesho", employmentType: "Full-time" },
  },

  ashby: {
    board: { company: "Ramp", ats: "ashby", token: "ramp" },
    routes: {
      "https://jobs.ashbyhq.com/api/non-user-graphql?op=ApiJobBoardWithTeams": {
        data: {
          jobBoard: {
            jobPostings: [
              {
                id: "1515fe6d",
                title: "Software Engineer, Platform",
                locationName: "New York, NY",
                employmentType: "FullTime",
              },
            ],
          },
        },
      },
      "https://jobs.ashbyhq.com/api/non-user-graphql?op=ApiJobPosting": {
        data: { jobPosting: { descriptionHtml: "<p>Distributed systems work.</p>" } },
      },
    },
    expect: { nativeId: "1515fe6d", company: "Ramp", employmentType: "FullTime" },
  },

  recruitee: {
    board: { company: "Hygraph", ats: "recruitee", token: "hygraph" },
    routes: {
      "https://hygraph.recruitee.com/api/offers/": {
        offers: [
          {
            id: 2211448,
            title: "Financial Accountant",
            location: "Berlin, Germany",
            city: "Berlin",
            careers_apply_url: "https://jobs.hygraph.com/o/accountant/apply",
            description: "<p>Own the ledger.</p>",
            requirements: "<p>Five years experience.</p>",
            employment_type_code: "fulltime_permanent",
            published_at: "2026-08-05 10:10:39 UTC",
            company_name: "Hygraph",
            tags: ["finance", "accounting"],
            remote: true,
          },
        ],
      },
    },
    expect: { nativeId: "2211448", company: "Hygraph", remote: true, skills: ["finance", "accounting"] },
  },

  workable: {
    board: { company: "Acme", ats: "workable", token: "acme" },
    routes: {
      "https://apply.workable.com/api/v1/widget/accounts/acme": {
        name: "Acme",
        jobs: [
          {
            shortcode: "ABC123",
            title: "Platform Engineer",
            description: "<p>Run the platform.</p>",
            requirements: "<p>Kubernetes.</p>",
            url: "https://apply.workable.com/acme/j/ABC123/",
            application_url: "https://apply.workable.com/acme/j/ABC123/apply",
            employment_type: "Full-time",
            published_on: "2026-08-10",
            telecommuting: true,
            city: "Chennai",
            country: "India",
          },
        ],
      },
    },
    expect: { nativeId: "ABC123", company: "Acme", remote: true },
  },

  smartrecruiters: {
    board: { company: "Bosch", ats: "smartrecruiters", token: "Bosch" },
    routes: {
      "https://api.smartrecruiters.com/v1/companies/Bosch/postings?limit=": {
        totalFound: 1,
        content: [
          {
            id: "744000",
            name: "Backend Developer",
            releasedDate: "2026-08-12T00:00:00.000Z",
            company: { name: "Bosch" },
            location: { city: "Bangalore", country: "in", remote: false },
            typeOfEmployment: { label: "Regular" },
          },
        ],
      },
      "https://api.smartrecruiters.com/v1/companies/Bosch/postings/744000": {
        jobAd: {
          sections: {
            jobDescription: { title: "Job", text: "<p>Write services.</p>" },
            qualifications: { title: "You", text: "<p>Java, Spring.</p>" },
          },
        },
      },
    },
    expect: { nativeId: "744000", company: "Bosch", remote: false },
  },

  /* ── boards family: no tokens needed, so `board` is unused ───────── */

  remoteok: {
    board: { company: "-", ats: "remoteok", token: "-" },
    routes: {
      "https://remoteok.com/api": [
        // The API leads with a legal notice, not a job.
        { legal: "Scraping this API is prohibited without attribution." },
        {
          id: 1137153,
          slug: "backend-engineer-acme-1137153",
          position: "Backend Engineer",
          company: "Acme",
          location: "Worldwide",
          description: "<p>Build APIs in Go.</p>",
          apply_url: "https://remoteOK.com/remote-jobs/backend-engineer-acme-1137153",
          url: "https://remoteOK.com/remote-jobs/backend-engineer-acme-1137153",
          date: "2026-08-26T05:24:03+00:00",
          tags: ["backend", "golang"],
          salary_min: 0,
          salary_max: 0,
        },
      ],
    },
    expect: { nativeId: "1137153", company: "Acme", remote: true },
  },

  arbeitnow: {
    board: { company: "-", ats: "arbeitnow", token: "-" },
    routes: {
      "https://www.arbeitnow.com/api/job-board-api": {
        data: [
          {
            slug: "backend-engineer-berlin-123",
            company_name: "Ilg GmbH",
            title: "Backend Engineer (m/w/d)",
            description: "<p>Wir suchen einen Backend Engineer.</p>",
            remote: false,
            url: "https://www.arbeitnow.com/jobs/companies/ilg/backend-engineer-123",
            tags: ["Engineering"],
            job_types: ["full_time"],
            location: "Düsseldorf",
            created_at: 1787815839,
          },
        ],
      },
    },
    expect: { nativeId: "backend-engineer-berlin-123", company: "Ilg GmbH", remote: false },
  },

  themuse: {
    board: { company: "-", ats: "themuse", token: "-" },
    routes: {
      "https://www.themuse.com/api/public/jobs": {
        results: [
          {
            id: 18054997,
            name: "Backend Engineer",
            contents: "<p><strong>Acme</strong> is hiring engineers.</p>",
            publication_date: new Date().toISOString(),
            short_name: "backend-engineer-ff84b8",
            locations: [{ name: "Seattle, WA" }],
            categories: [{ name: "Engineering" }],
            company: { name: "Acme" },
            refs: { landing_page: "https://www.themuse.com/jobs/acme/backend-engineer" },
          },
        ],
      },
    },
    expect: { nativeId: "18054997", company: "Acme" },
  },

  remotive: {
    board: { company: "-", ats: "remotive", token: "-" },
    routes: {
      "https://remotive.com/api/remote-jobs": {
        jobs: [
          {
            id: 2091105,
            url: "https://remotive.com/remote-jobs/backend/backend-engineer-2091105",
            title: "Backend Engineer",
            company_name: "TELUS Digital",
            tags: ["golang", "AI/ML"],
            job_type: "full_time",
            publication_date: new Date().toISOString(),
            // The field that states "remote, but…" as data rather than prose.
            candidate_required_location: "USA",
            description: "<p>Build services.</p>",
          },
        ],
      },
    },
    expect: { nativeId: "2091105", company: "TELUS Digital", location: "USA", remote: true },
  },

  himalayas: {
    board: { company: "-", ats: "himalayas", token: "-" },
    routes: {
      "https://himalayas.app/jobs/api": {
        jobs: [
          {
            title: "Backend Engineer",
            companyName: "Venon Solutions",
            employmentType: "Full Time",
            minSalary: 120000,
            maxSalary: 160000,
            currency: "USD",
            salaryPeriod: "annual",
            locationRestrictions: ["United States"],
            categories: ["Backend-Engineer"],
            description: "<h3>Build things</h3>",
            pubDate: Math.floor(Date.now() / 1000),
            applicationLink: "https://himalayas.app/companies/venon/jobs/backend-engineer",
          },
        ],
      },
    },
    expect: {
      company: "Venon Solutions",
      // A restriction list must surface as the location, not the word "Remote".
      location: "Remote (United States)",
      remote: true,
    },
  },

  jobicy: {
    board: { company: "-", ats: "jobicy", token: "-" },
    routes: {
      "https://jobicy.com/api/v2/remote-jobs": {
        jobs: [
          {
            id: 149748,
            url: "https://jobicy.com/jobs/149748-backend-engineer",
            jobSlug: "149748-backend-engineer",
            jobTitle: "Backend Engineer",
            companyName: "Welo Global",
            jobIndustry: ["Engineering"],
            jobType: ["Full-Time"],
            jobGeo: "Anywhere",
            jobDescription: "<p><strong>About us</strong> we build things</p>",
            pubDate: new Date().toISOString(),
          },
        ],
      },
    },
    expect: {
      nativeId: "149748",
      company: "Welo Global",
      location: "Remote (worldwide)",
      remote: true,
    },
  },

  hackernews: {
    board: { company: "-", ats: "hackernews", token: "-" },
    routes: {
      "https://hn.algolia.com/api/v1/search_by_date?tags=story,author_whoishiring": {
        hits: [
          { objectID: "49156682", title: "Ask HN: Who wants to be hired? (August 2026)" },
          { objectID: "49156683", title: "Ask HN: Who is hiring? (August 2026)" },
        ],
      },
      "https://hn.algolia.com/api/v1/search_by_date?tags=comment,story_49156683": {
        hits: [
          {
            objectID: "49439143",
            parent_id: 49156683,
            story_id: 49156683,
            created_at: "2026-08-04T12:00:00Z",
            comment_text:
              "Spade | Backend Engineer | REMOTE (US/Can) | $170,000 - $240,000 + equity<p>Spade is the data platform for modern finance.",
          },
          {
            // A reply, not a posting — must be ignored.
            objectID: "49439144",
            parent_id: 49336502,
            story_id: 49156683,
            comment_text: "Incorrect, they are hiring in Europe too.",
          },
        ],
      },
    },
    expect: { nativeId: "49439143", company: "Spade", remote: true },
  },

  /* ── India ───────────────────────────────────────────────────────── */

  foundit: {
    board: { company: "-", ats: "foundit", token: "-" },
    routes: {
      "https://www.foundit.in/middleware/jobsearch": {
        jobSearchResponse: {
          data: [
            {
              id: 64283298,
              jobId: 64283298,
              title: "Java Backend Engineer",
              companyName: "Deutsche Bank",
              locations: "Pune, India",
              applyUrl: "https://careers.db.com/roles/64283298",
              createdAt: 1787798474000,
              skills: "Tomcat, Spring Boot, Microservices",
              skillsWithSynonyms: [
                { value: "tomcat", synonyms: ["apache tomcat", "apachetomcat"] },
                { value: "spring boot", synonyms: ["springboot", "spring.boot"] },
              ],
              employmentTypes: ["Full time"],
              // Zero is Foundit's "not disclosed", not a real figure.
              minimumSalary: { currency: "INR", absoluteValue: 0 },
              maximumSalary: { currency: "INR", absoluteValue: 0 },
              currencyCode: "INR",
              hideSalary: 0,
            },
          ],
        },
      },
    },
    expect: {
      nativeId: "64283298",
      company: "Deutsche Bank",
      // Canonical values win over the raw comma-separated string.
      skills: ["tomcat", "spring boot"],
      descriptionComplete: false,
    },
  },

  instahyre: {
    board: { company: "-", ats: "instahyre", token: "-" },
    routes: {
      "https://www.instahyre.com/api/v1/job_search": {
        meta: { total_count: 13797 },
        objects: [
          {
            id: 440836,
            title: "Backend Engineer",
            locations: "Bangalore,Delhi,Pune",
            keywords: ["Java", "Spring"],
            public_url: "https://www.instahyre.com/job-440836-backend-engineer",
            employer: { company_name: "Samsung" },
          },
        ],
      },
    },
    expect: {
      nativeId: "440836",
      company: "Samsung",
      location: "Bangalore, Delhi, Pune",
      descriptionComplete: false,
    },
  },

  /* ── keyed aggregators ───────────────────────────────────────────── */

  adzuna: {
    board: { company: "-", ats: "adzuna", token: "-" },
    secrets: { adzuna: { appId: "id", appKey: "key" } },
    routes: {
      "https://api.adzuna.com/v1/api/jobs/in/search/1": {
        results: [
          {
            id: "5123456",
            title: "Backend Engineer",
            description: "Truncated snippet of the posting…",
            redirect_url: "https://www.adzuna.in/land/ad/5123456",
            created: new Date().toISOString(),
            salary_min: 2000000,
            salary_max: 3000000,
            // Adzuna reports this as a string, not a boolean.
            salary_is_predicted: "1",
            company: { display_name: "Acme India" },
            location: { display_name: "Bengaluru, Karnataka" },
            category: { label: "IT Jobs" },
          },
        ],
      },
    },
    expect: { nativeId: "5123456", company: "Acme India", descriptionComplete: false },
  },

  careerjet: {
    board: { company: "-", ats: "careerjet", token: "-" },
    secrets: { careerjet: { affid: "abc123" } },
    routes: {
      "http://public.api.careerjet.net/search": {
        type: "JOBS",
        jobs: [
          {
            title: "Backend Engineer",
            description: "Short snippet.",
            company: "Acme",
            locations: "Chennai",
            url: "https://www.careerjet.co.in/jobad/in-123",
            salary: "20,00,000 - 30,00,000 per year",
            date: "2026-08-20",
          },
        ],
      },
    },
    expect: { company: "Acme", location: "Chennai", descriptionComplete: false },
  },

  jooble: {
    board: { company: "-", ats: "jooble", token: "-" },
    secrets: { jooble: { key: "k", domain: "in.jooble.org" } },
    routes: {
      "https://in.jooble.org/api/k": {
        totalCount: 1,
        jobs: [
          {
            id: 9911,
            title: "Backend Engineer",
            location: "Chennai",
            snippet: "Truncated description…",
            link: "https://in.jooble.org/jdp/9911",
            company: "Acme",
            updated: "2026-08-21T00:00:00Z",
          },
        ],
      },
    },
    expect: { nativeId: "9911", company: "Acme", descriptionComplete: false },
  },
};

describe("engine registry", () => {
  test("every engine declares a complete identity", () => {
    for (const engine of ENGINES) {
      expect(engine.id).toBeTruthy();
      expect(engine.label).toBeTruthy();
      expect(["ats", "board", "india", "inbox", "aggregator", "scraper"]).toContain(
        engine.family,
      );
      expect(typeof engine.keyless).toBe("boolean");
      expect(["full", "snippet", "none"]).toContain(engine.descriptionQuality);
      expect(typeof engine.ready).toBe("function");
      expect(typeof engine.fetch).toBe("function");
    }
  });

  test("ids are unique", () => {
    const ids = ENGINES.map((e) => e.id);
    expect(new Set(ids).size).toBe(ids.length);
  });

  /**
   * Engines that cannot be driven by a recorded HTTP response.
   *
   * Listed by name rather than skipped by category, so an engine can never
   * quietly join this list to avoid the contract. Adding one here is a visible
   * decision that shows up in review.
   */
  const NOT_HTTP_DRIVEN = new Set([
    // Spawns a Python subprocess; there is no request for the stub to answer.
    "jobspy",
  ]);

  test("every HTTP-driven engine has a fixture in this suite", () => {
    for (const engine of ENGINES) {
      if (NOT_HTTP_DRIVEN.has(engine.id)) continue;
      expect(Object.keys(FIXTURES)).toContain(engine.id);
    }
  });

  test("the exemption list stays exactly as small as expected", () => {
    expect([...NOT_HTTP_DRIVEN]).toEqual(["jobspy"]);
  });
});

describe.each(Object.entries(FIXTURES))("engine: %s", (id, fixture) => {
  const engine = getEngine(id as never)!;
  const needsBoards = engine.family === "ats";

  test.if(needsBoards)("reports not-ready when it has no boards", () => {
    const readiness = engine.ready(contextWith(fixture.routes, [], fixture.secrets));
    expect(readiness.ok).toBe(false);
    if (!readiness.ok) expect(readiness.reason).toMatch(/board/i);
  });

  test("is ready when it has what it needs", () => {
    expect(engine.ready(contextWith(fixture.routes, [fixture.board], fixture.secrets)).ok).toBe(true);
  });

  test("returns jobs satisfying the RawJob contract", async () => {
    const jobs = await engine.fetch(contextWith(fixture.routes, [fixture.board], fixture.secrets));
    expect(jobs.length).toBeGreaterThan(0);

    for (const job of jobs) {
      expect(job.nativeId).toBeTruthy();
      expect(typeof job.company).toBe("string");
      expect(typeof job.title).toBe("string");
      expect(typeof job.location).toBe("string");
      expect(job.applyUrl).toMatch(/^https?:\/\//);
      expect(typeof job.description).toBe("string");
      expect(typeof job.descriptionComplete).toBe("boolean");
      expect(job.raw).toBeDefined();
      // Titles and locations must arrive already normalised.
      expect(job.title).toBe(job.title.trim());
      expect(job.title).not.toMatch(/\s{2,}/);
    }
  });

  test("delivers descriptions matching what it declares", async () => {
    const jobs = await engine.fetch(contextWith(fixture.routes, [fixture.board], fixture.secrets));
    const job = jobs[0]!;

    switch (engine.descriptionQuality) {
      case "full":
        expect(job.description.length).toBeGreaterThan(5);
        expect(job.descriptionComplete).toBe(true);
        break;
      case "snippet":
        expect(job.description.length).toBeGreaterThan(0);
        // A snippet must never claim to be the whole posting, or the
        // enrichment relay will skip a job it should have re-fetched.
        expect(job.descriptionComplete).toBe(false);
        break;
      case "none":
        expect(job.description).toBe("");
        expect(job.descriptionComplete).toBe(false);
        // A source with no body must earn its place some other way.
        expect(job.skills?.length ?? 0).toBeGreaterThan(0);
        break;
    }

    // Whatever arrives reaches the pipeline as text, never as markup.
    expect(job.description).not.toMatch(/<[a-z]+[\s>]/i);
  });

  test("maps the fields this source is expected to provide", async () => {
    const jobs = await engine.fetch(contextWith(fixture.routes, [fixture.board], fixture.secrets));
    expect(jobs[0]).toMatchObject(fixture.expect);
  });

  test("returns nothing rather than throwing when the source is empty", async () => {
    const empty: Record<string, unknown> = {};
    for (const key of Object.keys(fixture.routes)) {
      empty[key] = key.includes("lever") || key.includes("remoteok.com/api")
        ? []
        : { jobs: [], offers: [], content: [], results: [], hits: [], data: { jobBoard: null } };
    }
    const jobs = await engine.fetch(contextWith(empty, [fixture.board], fixture.secrets));
    expect(jobs).toEqual([]);
  });
});

describe("ashby error handling", () => {
  /**
   * GraphQL reports failures as HTTP 200 with an errors array. Before this was
   * handled, a rejected query looked identical to a board with no jobs — the
   * exact broken-versus-empty confusion the run log exists to prevent.
   */
  test("surfaces a GraphQL error instead of reporting empty", async () => {
    const ctx = contextWith(
      {
        "https://jobs.ashbyhq.com/api/non-user-graphql?op=ApiJobBoardWithTeams": {
          errors: [{ message: 'Cannot query field "descriptionHtml"' }],
        },
      },
      [{ company: "Ramp", ats: "ashby", token: "ramp" }],
    );
    await expect(getEngine("ashby")!.fetch(ctx)).rejects.toThrow(/descriptionHtml/);
  });
});

describe("runEngines", () => {
  const boards: Board[] = [{ company: "Stripe", ats: "greenhouse", token: "stripe" }];

  test("marks an engine with no boards as skipped, with a reason", async () => {
    const runs = await runEngines({
      engines: ["lever"],
      boards: [],
      http: createStubClient({}),
      config: defaultConfig(),
      secrets: {},
      query: QUERY,
    });
    expect(runs[0]!.status).toBe("skipped");
    expect(runs[0]!.error).toMatch(/board/i);
  });

  test("marks a source that returned nothing as empty, not ok", async () => {
    const runs = await runEngines({
      engines: ["greenhouse"],
      boards,
      http: createStubClient({
        "https://boards-api.greenhouse.io": { jobs: [] },
      }),
      config: defaultConfig(),
      secrets: {},
      query: QUERY,
    });
    expect(runs[0]!.status).toBe("empty");
    expect(runs[0]!.fetched).toBe(0);
  });

  test("isolates a failing engine from the rest", async () => {
    const runs = await runEngines({
      engines: ["greenhouse", "lever"],
      boards: [...boards, { company: "Meesho", ats: "lever", token: "meesho" }],
      http: createStubClient({
        // Greenhouse has no recorded route and will fail; Lever succeeds.
        "https://api.lever.co/v0/postings/meesho": FIXTURES.lever!.routes[
          "https://api.lever.co/v0/postings/meesho"
        ],
      }),
      config: defaultConfig(),
      secrets: {},
      query: QUERY,
    });

    const byId = Object.fromEntries(runs.map((r) => [r.engine, r]));
    expect(byId.greenhouse!.status).toBe("error");
    expect(byId.greenhouse!.error).toBeTruthy();
    expect(byId.lever!.status).toBe("ok");
    expect(byId.lever!.fetched).toBe(1);
  });

  test("never rejects, whatever the engines do", async () => {
    const runs = await runEngines({
      engines: ["greenhouse", "lever", "ashby", "recruitee"],
      boards,
      http: createStubClient({}),
      config: defaultConfig(),
      secrets: {},
      query: QUERY,
    });
    expect(runs).toHaveLength(4);
    for (const run of runs) expect(run.finishedAt).toBeTruthy();
  });
});

describe("shared helpers", () => {
  test("clean collapses whitespace and neutralises null-ish text", () => {
    expect(clean("  Senior   Engineer \n")).toBe("Senior Engineer");
    expect(clean(null)).toBe("");
    expect(clean("nan")).toBe("");
  });

  test("htmlToText strips markup and decodes entities", () => {
    expect(htmlToText("<p>Go &amp; Rust</p>")).toBe("Go & Rust");
    expect(htmlToText("<li>One</li><li>Two</li>")).toContain("• One");
    expect(htmlToText("<script>bad()</script><p>ok</p>")).toBe("ok");
  });

  test("looksRemote answers null rather than guessing", () => {
    expect(looksRemote("Remote, India")).toBe(true);
    expect(looksRemote("Hybrid - Chennai")).toBe(false);
    expect(looksRemote("Bengaluru")).toBeNull();
  });
});
