import { describe, expect, test, beforeEach, afterEach } from "bun:test";
import { Database } from "bun:sqlite";
import {
  listTracked,
  markViewed,
  trackerCounts,
  trackedAsCsv,
  untrack,
  updateTracked,
  isTrackerStatus,
} from "../../src/ui/tracker.ts";

let db: Database;

beforeEach(() => {
  db = new Database(":memory:");
  db.run(`CREATE TABLE jobs (id TEXT PRIMARY KEY, company TEXT, title TEXT, location TEXT,
    apply_url TEXT, review_status TEXT)`);
  db.run(`CREATE TABLE scores (job_id TEXT PRIMARY KEY, ai_score INTEGER)`);
  db.run(`CREATE TABLE applications (
    job_id TEXT PRIMARY KEY REFERENCES jobs(id) ON DELETE CASCADE,
    status TEXT NOT NULL DEFAULT 'viewed'
      CHECK (status IN ('viewed','prepared','submitted','responded','interviewing',
                        'offer','rejected','closed','ghosted')),
    prepared_at TEXT, submitted_at TEXT, last_status_at TEXT NOT NULL, note TEXT)`);
  db.run(`INSERT INTO jobs VALUES ('a','Stripe','Backend Engineer','Remote','u1','new')`);
  db.run(`INSERT INTO jobs VALUES ('b','Acme','Platform Engineer','Chennai','u2','new')`);
  db.run(`INSERT INTO scores VALUES ('a', 5)`);
});

afterEach(() => db.close());

describe("markViewed", () => {
  test("creates a row the first time a posting is opened", () => {
    expect(markViewed(db, "a")).toBe(true);
    expect(listTracked(db)[0]!.status).toBe("viewed");
  });

  /**
   * Re-reading a posting you already applied to must not undo the application.
   * This only ever inserts.
   */
  test("never drags an existing row backwards", () => {
    markViewed(db, "a");
    updateTracked(db, "a", { status: "submitted" });
    expect(markViewed(db, "a")).toBe(false);
    expect(listTracked(db)[0]!.status).toBe("submitted");
  });
});

describe("updateTracked", () => {
  test("sets a status and mirrors it onto the job's review column", () => {
    expect(updateTracked(db, "a", { status: "submitted" }).ok).toBe(true);
    const review = db.query<{ review_status: string }, []>(
      `SELECT review_status FROM jobs WHERE id='a'`).get();
    expect(review!.review_status).toBe("approved");
  });

  test("a rejection marks the job rejected, not approved", () => {
    updateTracked(db, "a", { status: "rejected" });
    const review = db.query<{ review_status: string }, []>(
      `SELECT review_status FROM jobs WHERE id='a'`).get();
    expect(review!.review_status).toBe("rejected");
  });

  /** The date you applied is a fact about the past. */
  test("stamps submitted_at once and never moves it", () => {
    updateTracked(db, "a", { status: "submitted" }, new Date("2026-01-01T00:00:00Z"));
    const first = listTracked(db)[0]!.submittedAt;
    expect(first).toBe("2026-01-01T00:00:00.000Z");

    updateTracked(db, "a", { status: "interviewing" }, new Date("2026-02-01T00:00:00Z"));
    updateTracked(db, "a", { status: "submitted" }, new Date("2026-03-01T00:00:00Z"));
    expect(listTracked(db)[0]!.submittedAt).toBe(first);
  });

  test("moves last_status_at on every change", () => {
    updateTracked(db, "a", { status: "submitted" }, new Date("2026-01-01T00:00:00Z"));
    updateTracked(db, "a", { status: "responded" }, new Date("2026-02-01T00:00:00Z"));
    expect(listTracked(db)[0]!.lastStatusAt).toBe("2026-02-01T00:00:00.000Z");
  });

  test("creates the row even when the job was never opened", () => {
    expect(updateTracked(db, "b", { status: "submitted" }).ok).toBe(true);
    expect(listTracked(db).map((a) => a.jobId)).toContain("b");
  });

  test("stores and clears a note", () => {
    updateTracked(db, "a", { note: "  referred by Priya  " });
    expect(listTracked(db)[0]!.note).toBe("referred by Priya");
    updateTracked(db, "a", { note: "   " });
    expect(listTracked(db)[0]!.note).toBeNull();
  });

  test("refuses a status outside the lifecycle", () => {
    const r = updateTracked(db, "a", { status: "hired" });
    expect(r.ok).toBe(false);
    expect(r.error).toContain("status must be one of");
  });

  test("refuses a note that is not text", () => {
    expect(updateTracked(db, "a", { note: 42 }).ok).toBe(false);
  });

  test("refuses an unknown job", () => {
    expect(updateTracked(db, "nope", { status: "submitted" }).error).toBe("No such job");
  });
});

describe("staleness", () => {
  /** Silence only means something when the ball is in their court. */
  test("marks a long-silent submission stale", () => {
    updateTracked(db, "a", { status: "submitted" }, new Date("2026-01-01T00:00:00Z"));
    const rows = listTracked(db, { now: new Date("2026-02-01T00:00:00Z"), staleAfterDays: 14 });
    expect(rows[0]!.stale).toBe(true);
    expect(rows[0]!.daysSince).toBe(31);
  });

  test("does not call a job you merely viewed stale", () => {
    markViewed(db, "a", new Date("2026-01-01T00:00:00Z"));
    const rows = listTracked(db, { now: new Date("2026-06-01T00:00:00Z") });
    expect(rows[0]!.stale).toBe(false);
  });

  test("a decided outcome is never stale", () => {
    updateTracked(db, "a", { status: "rejected" }, new Date("2026-01-01T00:00:00Z"));
    const rows = listTracked(db, { now: new Date("2026-06-01T00:00:00Z") });
    expect(rows[0]!.stale).toBe(false);
  });
});

describe("listTracked and counts", () => {
  test("filters by status and orders by most recent movement", () => {
    updateTracked(db, "a", { status: "submitted" }, new Date("2026-01-01T00:00:00Z"));
    updateTracked(db, "b", { status: "submitted" }, new Date("2026-02-01T00:00:00Z"));
    expect(listTracked(db, { status: "submitted" }).map((a) => a.jobId)).toEqual(["b", "a"]);
  });

  test("an unrecognised status filter lists everything rather than nothing", () => {
    markViewed(db, "a");
    expect(listTracked(db, { status: "nonsense" }).length).toBe(1);
  });

  test("counts include statuses nothing sits at", () => {
    updateTracked(db, "a", { status: "offer" });
    const counts = trackerCounts(db);
    expect(counts.offer).toBe(1);
    expect(counts.ghosted).toBe(0);
  });
});

describe("untrack", () => {
  test("removes a row and reports whether there was one", () => {
    markViewed(db, "a");
    expect(untrack(db, "a")).toBe(true);
    expect(untrack(db, "a")).toBe(false);
    expect(listTracked(db)).toHaveLength(0);
  });
});

describe("trackedAsCsv", () => {
  test("quotes a value containing a comma or a quote", () => {
    updateTracked(db, "a", { status: "submitted", note: 'said "maybe", then went quiet' });
    const csv = trackedAsCsv(listTracked(db));
    expect(csv.split("\n")[0]).toContain("company,title");
    expect(csv).toContain('"said ""maybe"", then went quiet"');
  });

  test("a newline in a note cannot break the row structure", () => {
    updateTracked(db, "a", { note: "line one\nline two" });
    const csv = trackedAsCsv(listTracked(db));
    expect(csv).toContain('"line one\nline two"');
  });

  test("renders an empty tracker as just the header", () => {
    expect(trackedAsCsv([]).trim().split("\n")).toHaveLength(1);
  });
});

describe("isTrackerStatus", () => {
  test("accepts the lifecycle and nothing else", () => {
    expect(isTrackerStatus("viewed")).toBe(true);
    expect(isTrackerStatus("rejected")).toBe(true);
    expect(isTrackerStatus("hired")).toBe(false);
    expect(isTrackerStatus(null)).toBe(false);
  });
});
