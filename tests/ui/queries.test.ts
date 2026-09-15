import { describe, expect, test, beforeAll, afterAll } from "bun:test";
import { Database } from "bun:sqlite";
import { MIGRATIONS } from "../../src/db/migrations/index.ts";
import { listJobs, countJobs, getJob, dashboard, facets } from "../../src/ui/queries.ts";

let db: Database;

beforeAll(() => {
  // Built from the real migrations rather than hand-copied DDL. Three times a
  // hand-written fixture fell behind a new column and failed for no reason
  // that had anything to do with what was being tested.
  db = new Database(":memory:");
  for (const step of MIGRATIONS) db.exec(step.sql);

  // The real schema requires native_id, first_seen and last_seen.
  const job = db.prepare(`INSERT INTO jobs (id,engine,native_id,company,title,location,remote,
    apply_url,description,description_complete,canonical_id,review_status,salary_currency,
    first_seen,last_seen)
    VALUES (?,?,?,?,?,?,?,?,?,1,?,?,'USD','2026-09-01','2026-09-01')`);
  job.run("a", "greenhouse", "n-a", "Stripe", "Backend Engineer", "Remote", 1, "u1", "desc a", null, "new");
  job.run("b", "lever", "n-b", "Acme", "Sales Lead", "Chennai", 0, "u2", "desc b", null, "approved");
  db.run(`UPDATE jobs SET company_type='staffing' WHERE id='b'`);
  db.run(`UPDATE jobs SET company_type='product'  WHERE id='a'`);
  job.run("c", "ashby", "n-c", "Beta", "Platform Engineer", "London", null, "u3", "desc c", null, "rejected");
  // A duplicate folded into another posting: it must never appear in a list.
  job.run("d", "ashby", "n-d", "Beta", "Platform Engineer (dup)", "London", null, "u4", "x", "c", "new");

  const m = db.prepare(`INSERT INTO matches (job_id,matched_required,total_required,coverage,
    match_score,matched,missing,bonus,matched_at) VALUES (?,?,?,?,?,?,?,?,'2026-09-01')`);
  m.run("a", 9, 11, 0.82, 0.71, '["go","sql"]', '["kafka"]', '["pci"]');
  m.run("b", 2, 2, 1.0, 0.52, '["payments"]', "[]", "[]");
  m.run("c", 5, 10, 0.5, 0.4, "[]", "[]", "[]");

  db.run(`INSERT INTO scores (job_id,ai_score,reason,concerns,scored_at)
          VALUES ('a',5,'great','[]','2026-09-01')`);
  db.run(`INSERT INTO scores (job_id,ai_score,reason,concerns,scored_at)
          VALUES ('b',1,'sales role','["different"]','2026-09-01')`);
  db.run(`INSERT INTO signals (job_id,wlb_score,salary_vs_target,red_flags,green_flags,
    wlb_evidence,repost_count,computed_at)
    VALUES ('a',4,'above','[]','["four-day week"]','[]',1,'2026-09-01')`);
  db.run(`INSERT INTO boards (company,ats,token,active,verified_at)
          VALUES ('Stripe','greenhouse','stripe',1,'2026-09-01')`);
  db.run(`INSERT INTO engine_runs (engine,started_at,status,fetched,inserted)
          VALUES ('greenhouse','2026-09-10T10:00:00Z','ok',10,5)`);
  db.run(`UPDATE jobs SET liveness='open'   WHERE id='a'`);
  db.run(`UPDATE jobs SET liveness='closed' WHERE id='b'`);
  db.run(`INSERT INTO ai_spend (at,provider,model,stage,estimated_usd,cost_source)
          VALUES ('2026-09-01','p','m','score',0.25,'derived')`);
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

  /** A closed posting is not a candidate, so browsing hides it by default. */
  test("hides closed postings, keeping unchecked ones", () => {
    const ids = listJobs(db, { liveness: "open-or-unknown" }).map((j) => j.id);
    expect(ids).toContain("a");
    expect(ids).toContain("c");
    expect(ids).not.toContain("b");
  });

  test("can ask for exactly one liveness state", () => {
    expect(listJobs(db, { liveness: "closed" }).map((j) => j.id)).toEqual(["b"]);
    expect(listJobs(db, { liveness: "unchecked" }).map((j) => j.id)).toEqual(["c"]);
  });

  test("a date window keeps recent postings and drops old and undated ones", () => {
    const iso = (daysAgo: number) => new Date(Date.now() - daysAgo * 86_400_000).toISOString();
    db.run(`UPDATE jobs SET posted_at = ? WHERE id = 'a'`, [iso(2)]);
    db.run(`UPDATE jobs SET posted_at = ? WHERE id = 'b'`, [iso(40)]);
    db.run(`UPDATE jobs SET posted_at = NULL WHERE id = 'c'`);

    expect(listJobs(db, { postedWithinDays: 7 }).map((j) => j.id)).toEqual(["a"]);
    expect(listJobs(db, { postedWithinDays: 60 }).map((j) => j.id).sort()).toEqual(["a", "b"]);
    // Zero or absent means no window at all.
    expect(countJobs(db, { postedWithinDays: 0 })).toBe(3);
  });

  /** Jobs you can take come first; the score order decides within each group. */
  test("relevance puts your locations first, then open remote, then the rest", () => {
    db.run(`UPDATE jobs SET location = 'Seattle', remote = 0 WHERE id = 'a'`);   // ai 5
    db.run(`UPDATE jobs SET location = 'Chennai', remote = 0 WHERE id = 'b'`);   // ai 1
    db.run(`UPDATE jobs SET location = 'Remote', remote = 1 WHERE id = 'c'`);    // unscored
    const ids = listJobs(db, { sort: "relevance", preferLocations: ["Chennai"] }).map((j) => j.id);
    expect(ids).toEqual(["b", "c", "a"]);

    // Without locations, relevance is the AI score order.
    expect(listJobs(db, { sort: "relevance" }).map((j) => j.id)[0]).toBe("a");

    db.run(`UPDATE jobs SET location = 'Remote', remote = 1 WHERE id = 'a'`);
    db.run(`UPDATE jobs SET location = 'Chennai', remote = 0 WHERE id = 'b'`);
    db.run(`UPDATE jobs SET location = 'London', remote = NULL WHERE id = 'c'`);
  });

  test("relevance composes with filters without mixing up bound values", () => {
    db.run(`UPDATE jobs SET location = 'Chennai' WHERE id = 'b'`);
    const ids = listJobs(db, { sort: "relevance", preferLocations: ["Chennai"], q: "Acme" }).map((j) => j.id);
    expect(ids).toEqual(["b"]);
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
