import { describe, expect, test, beforeAll, afterAll } from "bun:test";
import { Database } from "bun:sqlite";
import { listJobs, countJobs, getJob, dashboard, facets } from "../../src/ui/queries.ts";

let db: Database;

beforeAll(() => {
  db = new Database(":memory:");
  db.run(`CREATE TABLE jobs (id TEXT PRIMARY KEY, engine TEXT, native_id TEXT, company TEXT,
    title TEXT, location TEXT, remote INTEGER, remote_restriction TEXT, apply_url TEXT,
    description TEXT, description_complete INTEGER, salary_min REAL, salary_max REAL,
    salary_currency TEXT, salary_period TEXT, seniority TEXT, employment_type TEXT,
    posted_at TEXT, first_seen TEXT, last_seen TEXT, raw TEXT, canonical_id TEXT,
    review_status TEXT, company_type TEXT)`);
  db.run(`CREATE TABLE matches (job_id TEXT PRIMARY KEY, matched_required INTEGER,
    total_required INTEGER, matched_preferred INTEGER, total_preferred INTEGER,
    coverage REAL, match_score REAL, matched TEXT, missing TEXT, bonus TEXT, matched_at TEXT,
    profile_fingerprint TEXT)`);
  db.run(`CREATE TABLE scores (job_id TEXT PRIMARY KEY, ai_score INTEGER, reason TEXT,
    concerns TEXT, model TEXT, scored_at TEXT, profile_fingerprint TEXT)`);
  db.run(`CREATE TABLE signals (job_id TEXT PRIMARY KEY, salary_state TEXT,
    salary_vs_target TEXT, wlb_score INTEGER, wlb_evidence TEXT, red_flags TEXT,
    green_flags TEXT, remote_reality TEXT, interview_stages INTEGER, repost_count INTEGER,
    computed_at TEXT)`);
  db.run(`CREATE TABLE profile_skills (skill TEXT PRIMARY KEY, label TEXT, category TEXT,
    years REAL, level TEXT, evidence TEXT, source TEXT, pinned INTEGER, updated_at TEXT)`);
  db.run(`CREATE TABLE boards (id INTEGER PRIMARY KEY, company TEXT, ats TEXT, token TEXT,
    verified_at TEXT, active INTEGER)`);
  db.run(`CREATE TABLE engine_runs (id INTEGER PRIMARY KEY, engine TEXT, started_at TEXT,
    finished_at TEXT, status TEXT, fetched INTEGER, inserted INTEGER, error TEXT)`);
  db.run(`CREATE TABLE ai_spend (id INTEGER PRIMARY KEY, at TEXT, provider TEXT, model TEXT,
    stage TEXT, input_tokens INTEGER, output_tokens INTEGER, estimated_usd REAL, cost_source TEXT)`);

  const job = db.prepare(`INSERT INTO jobs (id,engine,company,title,location,remote,apply_url,
    description,description_complete,canonical_id,review_status,salary_currency)
    VALUES (?,?,?,?,?,?,?,?,1,?,?,'USD')`);
  job.run("a", "greenhouse", "Stripe", "Backend Engineer", "Remote", 1, "u1", "desc a", null, "new");
  job.run("b", "lever", "Acme", "Sales Lead", "Chennai", 0, "u2", "desc b", null, "approved");
  db.run(`UPDATE jobs SET company_type='staffing' WHERE id='b'`);
  db.run(`UPDATE jobs SET company_type='product'  WHERE id='a'`);
  job.run("c", "ashby", "Beta", "Platform Engineer", "London", null, "u3", "desc c", null, "rejected");
  // A duplicate folded into another posting: it must never appear in a list.
  job.run("d", "ashby", "Beta", "Platform Engineer (dup)", "London", null, "u4", "x", "c", "new");

  const m = db.prepare(`INSERT INTO matches (job_id,matched_required,total_required,coverage,
    match_score,matched,missing,bonus) VALUES (?,?,?,?,?,?,?,?)`);
  m.run("a", 9, 11, 0.82, 0.71, '["go","sql"]', '["kafka"]', '["pci"]');
  m.run("b", 2, 2, 1.0, 0.52, '["payments"]', "[]", "[]");
  m.run("c", 5, 10, 0.5, 0.4, "[]", "[]", "[]");

  db.run(`INSERT INTO scores (job_id,ai_score,reason,concerns) VALUES ('a',5,'great','[]')`);
  db.run(`INSERT INTO scores (job_id,ai_score,reason,concerns) VALUES ('b',1,'sales role','["different"]')`);
  db.run(`INSERT INTO signals (job_id,wlb_score,salary_vs_target,red_flags,green_flags,
    wlb_evidence,repost_count) VALUES ('a',4,'above','[]','["four-day week"]','[]',1)`);
  db.run(`INSERT INTO boards (company,ats,token,active) VALUES ('Stripe','greenhouse','stripe',1)`);
  db.run(`INSERT INTO engine_runs (engine,started_at,status,fetched,inserted)
          VALUES ('greenhouse','2026-09-10T10:00:00Z','ok',10,5)`);
  db.run(`INSERT INTO ai_spend (at,provider,model,stage,estimated_usd) VALUES ('x','p','m','score',0.25)`);
});

afterAll(() => db.close());

describe("listJobs", () => {
  /** A posting folded into another is a duplicate, not a result. */
  test("never returns a posting that was deduplicated away", () => {
    expect(listJobs(db).map((j) => j.id)).not.toContain("d");
  });

  test("orders by AI score first, unscored last", () => {
    const ids = listJobs(db, { sort: "score" }).map((j) => j.id);
    expect(ids[0]).toBe("a");
    expect(ids[ids.length - 1]).toBe("c");
  });

  test("joins the score and signal onto the row", () => {
    const a = listJobs(db).find((j) => j.id === "a")!;
    expect(a.aiScore).toBe(5);
    expect(a.wlbScore).toBe(4);
    expect(a.salaryVsTarget).toBe("above");
  });

  /** An unscored posting has not been judged; it is not a zero. */
  test("a minimum score excludes unscored postings rather than ranking them last", () => {
    const ids = listJobs(db, { minAiScore: 1 }).map((j) => j.id);
    expect(ids).toContain("a");
    expect(ids).toContain("b");
    expect(ids).not.toContain("c");
  });

  test("searches company, title and location together", () => {
    expect(listJobs(db, { q: "Chennai" }).map((j) => j.id)).toEqual(["b"]);
    expect(listJobs(db, { q: "Backend" }).map((j) => j.id)).toEqual(["a"]);
  });

  /**
   * "undecided" is not a stored value: the pipeline writes 'new', then
   * 'scored'/'drafted'. Only approved and rejected are decisions.
   */
  test("undecided means anything not approved or rejected", () => {
    expect(listJobs(db, { status: "undecided" }).map((j) => j.id)).toEqual(["a"]);
    expect(listJobs(db, { status: "approved" }).map((j) => j.id)).toEqual(["b"]);
  });

  /** A staffing firm and the employer post the same titles. */
  test("filters by company type", () => {
    expect(listJobs(db, { companyType: "product" }).map((j) => j.id)).toEqual(["a"]);
    expect(listJobs(db, { companyType: "staffing" }).map((j) => j.id)).toEqual(["b"]);
  });

  /** Absence of a value, which a plain equality test would never match. */
  test("unclassified means the column is null", () => {
    expect(listJobs(db, { companyType: "unclassified" }).map((j) => j.id)).toEqual(["c"]);
  });

  test("remote filter keeps only postings marked remote", () => {
    expect(listJobs(db, { remoteOnly: true }).map((j) => j.id)).toEqual(["a"]);
  });

  test("caps an absurd limit rather than trying to serve it", () => {
    expect(() => listJobs(db, { limit: 10_000_000 })).not.toThrow();
  });

  /** Sorting is chosen from a fixed map; user input is never interpolated. */
  test("an unknown sort falls back instead of breaking the query", () => {
    expect(() => listJobs(db, { sort: "; DROP TABLE jobs" as never })).not.toThrow();
    expect(listJobs(db).length).toBeGreaterThan(0);
  });

  test("a quote in the search text cannot break out of the binding", () => {
    expect(() => listJobs(db, { q: "'; DROP TABLE jobs; --" })).not.toThrow();
    expect(countJobs(db)).toBe(3);
  });
});

describe("countJobs", () => {
  test("counts the same set the list would return", () => {
    expect(countJobs(db)).toBe(3);
    expect(countJobs(db, { remoteOnly: true })).toBe(1);
  });
});

describe("getJob", () => {
  test("parses the JSON columns into arrays", () => {
    const a = getJob(db, "a")!;
    expect(a.matched).toEqual(["go", "sql"]);
    expect(a.missing).toEqual(["kafka"]);
    expect(a.greenFlags).toEqual(["four-day week"]);
  });

  test("returns null for an unknown id", () => {
    expect(getJob(db, "nope")).toBeNull();
  });

  /** A malformed column must not take the whole page down. */
  test("survives malformed JSON in a column", () => {
    db.run(`UPDATE matches SET matched = '{oops' WHERE job_id = 'a'`);
    expect(getJob(db, "a")!.matched).toEqual([]);
    db.run(`UPDATE matches SET matched = '["go","sql"]' WHERE job_id = 'a'`);
  });
});

describe("dashboard", () => {
  test("counts review states, treating 'new' as undecided", () => {
    const d = dashboard(db);
    expect(d.approved).toBe(1);
    expect(d.rejected).toBe(1);
    expect(d.pending).toBe(1);
  });

  /** The number that made 5% coverage obvious. */
  test("reports the share of ranked postings that were scored", () => {
    const d = dashboard(db);
    expect(d.ranked).toBe(3);
    expect(d.scored).toBe(2);
    expect(d.scoreCoverage).toBeCloseTo(2 / 3, 5);
  });

  test("sums spend from the estimated column", () => {
    expect(dashboard(db).spend.total).toBeCloseTo(0.25, 5);
  });

  test("reports engine health from the most recent run", () => {
    const e = dashboard(db).engines.find((x) => x.engine === "greenhouse")!;
    expect(e.status).toBe("ok");
  });
});

describe("facets", () => {
  test("offers companies and locations with counts", () => {
    const f = facets(db);
    expect(f.companies.map((c) => c.value)).toContain("Stripe");
    expect(f.locations.map((l) => l.value)).toContain("Chennai");
  });
});
