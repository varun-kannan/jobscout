import { describe, expect, test } from "bun:test";
import { currentVersion, migrate, openMemoryDb, SCHEMA_VERSION } from "../../src/db/db.ts";
import { MIGRATIONS } from "../../src/db/migrations/index.ts";

function fresh() {
  const handle = openMemoryDb();
  migrate(handle.raw);
  return handle;
}

/** Every table name declared across all migration steps. */
function declaredTables(upToVersion = Infinity): string[] {
  return MIGRATIONS.filter((m) => m.version <= upToVersion).flatMap((m) =>
    [...m.sql.matchAll(/CREATE TABLE IF NOT EXISTS (\w+)/g)].map((x) => x[1]!),
  );
}

function tablesIn(db: ReturnType<typeof openMemoryDb>): string[] {
  return db.raw
    .query<{ name: string }, []>("SELECT name FROM sqlite_master WHERE type='table'")
    .all()
    .map((r) => r.name);
}

describe("migrations", () => {
  test("brings a new database up to the latest version", () => {
    const handle = openMemoryDb();
    const result = migrate(handle.raw);
    expect(result.from).toBe(0);
    expect(result.to).toBe(SCHEMA_VERSION);
    expect(result.applied.map((m) => m.version)).toEqual(MIGRATIONS.map((m) => m.version));
    expect(currentVersion(handle.raw)).toBe(SCHEMA_VERSION);
    handle.close();
  });

  test("is a no-op the second time", () => {
    const handle = fresh();
    const again = migrate(handle.raw);
    expect(again.applied).toHaveLength(0);
    expect(again.to).toBe(SCHEMA_VERSION);
    handle.close();
  });

  test("refuses a database written by a newer build", () => {
    const handle = openMemoryDb();
    handle.raw.exec(`PRAGMA user_version = ${SCHEMA_VERSION + 5}`);
    expect(() => migrate(handle.raw)).toThrow(/only understands/);
    handle.close();
  });

  test("versions are unique and ascending", () => {
    const versions = MIGRATIONS.map((m) => m.version);
    expect(new Set(versions).size).toBe(versions.length);
    expect([...versions].sort((a, b) => a - b)).toEqual(versions);
  });

  /**
   * Read expected tables from the migration files rather than hardcoding them.
   * A hardcoded list is what let `signals` and `company_notes` ship without
   * ever being created on an existing database — the schema grew, the list did
   * not, and the suite stayed green.
   */
  test("creates every table the migrations declare", () => {
    const declared = declaredTables();
    expect(declared.length).toBeGreaterThan(8);

    const handle = fresh();
    const names = tablesIn(handle);
    for (const table of declared) expect(names).toContain(table);
    handle.close();
  });

  /**
   * The upgrade path. The old single-file approach skipped this entirely
   * whenever the version was not bumped, and could not have handled it even
   * then, because IF NOT EXISTS leaves an existing table at its old shape.
   */
  test("steps a partially-migrated database up to the latest version", () => {
    const handle = openMemoryDb();

    // Apply only v1, exactly as a database created before v2 existed.
    const first = MIGRATIONS[0]!;
    handle.raw.exec(first.sql);
    handle.raw.exec(`PRAGMA user_version = ${first.version}`);

    const before = tablesIn(handle);
    expect(before).not.toContain("signals");

    const result = migrate(handle.raw);
    expect(result.from).toBe(1);
    expect(result.to).toBe(SCHEMA_VERSION);
    expect(result.applied.map((m) => m.name)).toEqual(["signals", "skill-source", "ai-spend"]);

    const after = tablesIn(handle);
    for (const table of declaredTables()) expect(after).toContain(table);
    handle.close();
  });

  test("reports which step failed rather than a bare SQL error", () => {
    const handle = openMemoryDb();
    // A table that collides with something a migration creates, without the
    // columns its indexes need — the shape that produced "no such column".
    handle.raw.exec(`CREATE TABLE jobs (id TEXT PRIMARY KEY);`);
    expect(() => migrate(handle.raw)).toThrow(/Migration 1 \(initial\) failed/);
    handle.close();
  });
});

describe("schema constraints", () => {
  test("rejects an unknown review status", () => {
    const handle = fresh();
    expect(() =>
      handle.raw.run(
        `INSERT INTO jobs (id, engine, first_seen, last_seen, review_status)
         VALUES ('a', 'greenhouse', '2026-01-01', '2026-01-01', 'maybe')`,
      ),
    ).toThrow();
    handle.close();
  });

  test("rejects an ai_score outside 1-5", () => {
    const handle = fresh();
    handle.raw.run(
      `INSERT INTO jobs (id, engine, first_seen, last_seen)
       VALUES ('a', 'greenhouse', '2026-01-01', '2026-01-01')`,
    );
    expect(() =>
      handle.raw.run(
        `INSERT INTO scores (job_id, ai_score, scored_at) VALUES ('a', 9, '2026-01-01')`,
      ),
    ).toThrow();
    handle.close();
  });

  test("rejects an unknown salary state", () => {
    const handle = fresh();
    handle.raw.run(
      `INSERT INTO jobs (id, engine, first_seen, last_seen)
       VALUES ('a', 'foundit', '2026-01-01', '2026-01-01')`,
    );
    expect(() =>
      handle.raw.run(
        `INSERT INTO signals (job_id, salary_state, computed_at)
         VALUES ('a', 'probably-fine', '2026-01-01')`,
      ),
    ).toThrow();
    handle.close();
  });

  test("cascades match and signal rows when a job is deleted", () => {
    const handle = fresh();
    handle.raw.run(
      `INSERT INTO jobs (id, engine, first_seen, last_seen)
       VALUES ('a', 'lever', '2026-01-01', '2026-01-01')`,
    );
    handle.raw.run(`INSERT INTO matches (job_id, matched_at) VALUES ('a', '2026-01-01')`);
    handle.raw.run(`INSERT INTO signals (job_id, computed_at) VALUES ('a', '2026-01-01')`);
    handle.raw.run(`DELETE FROM jobs WHERE id = 'a'`);

    for (const table of ["matches", "signals"]) {
      const row = handle.raw
        .query<{ n: number }, []>(`SELECT COUNT(*) AS n FROM ${table}`)
        .get();
      expect(row?.n).toBe(0);
    }
    handle.close();
  });

  test("keeps triage and application status independent", () => {
    const handle = fresh();
    handle.raw.run(
      `INSERT INTO jobs (id, engine, first_seen, last_seen, review_status)
       VALUES ('a', 'ashby', '2026-01-01', '2026-01-01', 'approved')`,
    );
    handle.raw.run(
      `INSERT INTO applications (job_id, status, last_status_at)
       VALUES ('a', 'submitted', '2026-01-02')`,
    );
    // An application moving on must not rewrite why the job was approved.
    handle.raw.run(`UPDATE applications SET status = 'interviewing' WHERE job_id = 'a'`);
    const job = handle.raw
      .query<{ review_status: string }, []>("SELECT review_status FROM jobs WHERE id='a'")
      .get();
    expect(job?.review_status).toBe("approved");
    handle.close();
  });
});
