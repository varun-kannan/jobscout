import { describe, expect, test } from "bun:test";
import { migrate, openMemoryDb } from "../../src/db/db.ts";
import { activeBoards, addBoard, countJobs, jobId, recordRun, upsertJobs } from "../../src/db/jobs.ts";
import type { RawJob } from "../../src/engines/engine.ts";
import type { EngineRun } from "../../src/engines/registry.ts";

function db() {
  const handle = openMemoryDb();
  migrate(handle.raw);
  return handle;
}

function job(overrides: Partial<RawJob> = {}): RawJob {
  return {
    nativeId: "123",
    company: "Stripe",
    title: "Backend Engineer",
    location: "Remote, India",
    applyUrl: "https://stripe.com/jobs/123",
    description: "Build ledgers.",
    descriptionComplete: true,
    remote: true,
    raw: { id: 123 },
    ...overrides,
  };
}

describe("jobId", () => {
  test("is stable across calls", () => {
    expect(jobId("greenhouse", "123")).toBe(jobId("greenhouse", "123"));
  });

  test("differs per engine, so two sources never collide", () => {
    expect(jobId("greenhouse", "123")).not.toBe(jobId("lever", "123"));
  });

  test("is prefixed with the engine for readability", () => {
    expect(jobId("greenhouse", "123")).toMatch(/^greenhouse-[0-9a-f]{12}$/);
  });

  test("falls back to the apply URL when a source gives no id", () => {
    const withUrl = jobId("board", "", "https://example.com/a");
    const other = jobId("board", "", "https://example.com/b");
    expect(withUrl).not.toBe(other);
  });
});

describe("upsertJobs", () => {
  test("inserts new postings", () => {
    const handle = db();
    const result = upsertJobs(handle.raw, "greenhouse", [job(), job({ nativeId: "456" })]);
    expect(result.inserted).toBe(2);
    expect(result.updated).toBe(0);
    expect(countJobs(handle.raw)).toBe(2);
    handle.close();
  });

  test("re-running discovery updates rather than duplicating", () => {
    const handle = db();
    upsertJobs(handle.raw, "greenhouse", [job()]);
    const second = upsertJobs(handle.raw, "greenhouse", [job()]);
    expect(second.inserted).toBe(0);
    expect(second.updated).toBe(1);
    expect(countJobs(handle.raw)).toBe(1);
    handle.close();
  });

  /**
   * The property that matters most: re-discovery must never undo triage. If a
   * later run reset review_status, every approval would be lost the next time
   * the same posting was seen.
   */
  test("preserves triage status when a posting is seen again", () => {
    const handle = db();
    upsertJobs(handle.raw, "greenhouse", [job()]);
    const id = jobId("greenhouse", "123");
    handle.raw.run(`UPDATE jobs SET review_status = 'approved' WHERE id = ?`, [id]);

    upsertJobs(handle.raw, "greenhouse", [job({ title: "Retitled Role" })]);

    const row = handle.raw
      .query<{ review_status: string; title: string }, [string]>(
        `SELECT review_status, title FROM jobs WHERE id = ?`,
      )
      .get(id);
    expect(row?.review_status).toBe("approved");
    // Existing content is left alone too — only last_seen moves.
    expect(row?.title).toBe("Backend Engineer");
    handle.close();
  });

  test("advances last_seen so repost churn can be measured", async () => {
    const handle = db();
    upsertJobs(handle.raw, "greenhouse", [job()]);
    const id = jobId("greenhouse", "123");
    const before = handle.raw
      .query<{ last_seen: string; first_seen: string }, [string]>(
        `SELECT last_seen, first_seen FROM jobs WHERE id = ?`,
      )
      .get(id)!;

    await Bun.sleep(5);
    upsertJobs(handle.raw, "greenhouse", [job()]);

    const after = handle.raw
      .query<{ last_seen: string; first_seen: string }, [string]>(
        `SELECT last_seen, first_seen FROM jobs WHERE id = ?`,
      )
      .get(id)!;

    expect(after.first_seen).toBe(before.first_seen);
    expect(after.last_seen >= before.last_seen).toBe(true);
    handle.close();
  });

  test("stores a null remote as null rather than 0", () => {
    const handle = db();
    upsertJobs(handle.raw, "lever", [job({ remote: null })]);
    const row = handle.raw
      .query<{ remote: number | null }, []>(`SELECT remote FROM jobs`)
      .get();
    expect(row?.remote).toBeNull();
    handle.close();
  });

  test("keeps the raw payload for later re-parsing", () => {
    const handle = db();
    upsertJobs(handle.raw, "greenhouse", [job({ raw: { id: 123, extra: "kept" } })]);
    const row = handle.raw.query<{ raw: string }, []>(`SELECT raw FROM jobs`).get();
    expect(JSON.parse(row!.raw)).toMatchObject({ extra: "kept" });
    handle.close();
  });
});

describe("recordRun", () => {
  function run(overrides: Partial<EngineRun> = {}): EngineRun {
    return {
      engine: "greenhouse",
      status: "ok",
      startedAt: "2026-08-26T10:00:00Z",
      finishedAt: "2026-08-26T10:00:05Z",
      fetched: 10,
      jobs: [],
      ...overrides,
    };
  }

  test("distinguishes a broken source from an empty one", () => {
    const handle = db();
    recordRun(handle.raw, run({ engine: "greenhouse", status: "empty", fetched: 0 }), 0);
    recordRun(
      handle.raw,
      run({ engine: "lever", status: "error", fetched: 0, error: "HTTP 500" }),
      0,
    );

    const rows = handle.raw
      .query<{ engine: string; status: string; error: string | null }, []>(
        `SELECT engine, status, error FROM engine_runs ORDER BY engine`,
      )
      .all();

    expect(rows).toHaveLength(2);
    const byEngine = Object.fromEntries(rows.map((r) => [r.engine, r]));
    expect(byEngine.greenhouse!.status).toBe("empty");
    expect(byEngine.greenhouse!.error).toBeNull();
    expect(byEngine.lever!.status).toBe("error");
    expect(byEngine.lever!.error).toBe("HTTP 500");
    handle.close();
  });

  test("rejects a status the schema does not know", () => {
    const handle = db();
    expect(() =>
      recordRun(handle.raw, run({ status: "probably-fine" as never }), 0),
    ).toThrow();
    handle.close();
  });
});

describe("boards", () => {
  test("adds and lists active boards", () => {
    const handle = db();
    addBoard(handle.raw, { company: "Stripe", ats: "greenhouse", token: "stripe" });
    addBoard(handle.raw, { company: "Meesho", ats: "lever", token: "meesho" });
    expect(activeBoards(handle.raw)).toHaveLength(2);
    handle.close();
  });

  test("ignores a duplicate token for the same platform", () => {
    const handle = db();
    expect(addBoard(handle.raw, { company: "Stripe", ats: "greenhouse", token: "stripe" }).added).toBe(true);
    expect(addBoard(handle.raw, { company: "Stripe", ats: "greenhouse", token: "stripe" }).added).toBe(false);
    expect(activeBoards(handle.raw)).toHaveLength(1);
    handle.close();
  });

  test("allows the same token on different platforms", () => {
    const handle = db();
    addBoard(handle.raw, { company: "Acme", ats: "greenhouse", token: "acme" });
    addBoard(handle.raw, { company: "Acme", ats: "lever", token: "acme" });
    expect(activeBoards(handle.raw)).toHaveLength(2);
    handle.close();
  });
});
