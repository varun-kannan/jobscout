/**
 * Turning raw engine output into rows, and recording what each engine did.
 */

import { createHash } from "node:crypto";
import type { Database } from "bun:sqlite";
import type { RawJob } from "../engines/engine.ts";
import type { EngineRun } from "../engines/registry.ts";
import type { Board } from "../engines/engine.ts";

/**
 * A stable id for a posting.
 *
 * Derived from the engine and the source's own identifier, so re-running
 * discovery recognises what it already has. Falls back to the apply URL when a
 * source gives no id of its own.
 */
export function jobId(engine: string, nativeId: string, applyUrl = ""): string {
  const basis = nativeId || applyUrl;
  const digest = createHash("sha1").update(`${engine}:${basis}`).digest("hex").slice(0, 12);
  return `${engine}-${digest}`;
}

export interface UpsertResult {
  inserted: number;
  updated: number;
}

/**
 * Insert new postings; refresh `last_seen` on ones already held.
 *
 * An existing row is never overwritten: its triage status, scores, and match
 * results must survive re-discovery. Only `last_seen` moves, which is what
 * lets repost churn be measured later.
 */
export function upsertJobs(db: Database, engine: string, jobs: RawJob[]): UpsertResult {
  const now = new Date().toISOString();

  const insert = db.prepare(`
    INSERT INTO jobs (
      id, engine, native_id, company, title, location, remote,
      apply_url, description, description_complete,
      salary_min, salary_max, salary_currency, salary_period,
      employment_type, posted_at, first_seen, last_seen, raw
    ) VALUES (
      $id, $engine, $native_id, $company, $title, $location, $remote,
      $apply_url, $description, $description_complete,
      $salary_min, $salary_max, $salary_currency, $salary_period,
      $employment_type, $posted_at, $first_seen, $last_seen, $raw
    )
    ON CONFLICT(id) DO UPDATE SET last_seen = excluded.last_seen
  `);

  const existing = db.prepare<{ id: string }, [string]>(`SELECT id FROM jobs WHERE id = ?`);

  /**
   * Some sources hand over skills already structured — Foundit ships a skill
   * list with synonyms, Instahyre keywords, Recruitee and RemoteOK tags. That
   * is free matching data, so it is stored on arrival rather than thrown away
   * and re-derived by an AI call later.
   *
   * They are recorded as `required` because a listed skill is what the role
   * asks for. The extract stage refines the required/preferred split for jobs
   * that also carry a description; for Foundit, which returns none, this is the
   * only skill data there will ever be.
   */
  const insertSkill = db.prepare(`
    INSERT INTO job_skills (job_id, skill, label, requirement, source)
    VALUES (?, ?, ?, 'required', 'engine')
    ON CONFLICT(job_id, skill) DO NOTHING
  `);

  let inserted = 0;
  let updated = 0;

  db.transaction(() => {
    for (const job of jobs) {
      const id = jobId(engine, job.nativeId, job.applyUrl);
      const seen = existing.get(id) !== null;

      insert.run({
        $id: id,
        $engine: engine,
        $native_id: job.nativeId || null,
        $company: job.company,
        $title: job.title,
        $location: job.location,
        $remote: job.remote === null || job.remote === undefined ? null : job.remote ? 1 : 0,
        $apply_url: job.applyUrl,
        $description: job.description,
        $description_complete: job.descriptionComplete ? 1 : 0,
        $salary_min: job.salary?.min ?? null,
        $salary_max: job.salary?.max ?? null,
        $salary_currency: job.salary?.currency || null,
        $salary_period: job.salary?.period ?? null,
        $employment_type: job.employmentType ?? null,
        $posted_at: job.postedAt ?? null,
        $first_seen: now,
        $last_seen: now,
        $raw: JSON.stringify(job.raw ?? null),
      });

      for (const label of job.skills ?? []) {
        const canonical = label.toLowerCase().trim();
        if (canonical) insertSkill.run(id, canonical, label);
      }

      if (seen) updated++;
      else inserted++;
    }
  })();

  return { inserted, updated };
}

/** Record what an engine did, so a broken source is never mistaken for an empty one. */
export function recordRun(db: Database, run: EngineRun, inserted: number): void {
  db.prepare(`
    INSERT INTO engine_runs (engine, started_at, finished_at, status, fetched, inserted, error)
    VALUES (?, ?, ?, ?, ?, ?, ?)
  `).run(
    run.engine,
    run.startedAt,
    run.finishedAt,
    run.status,
    run.fetched,
    inserted,
    run.error ?? null,
  );
}

export function activeBoards(db: Database): Board[] {
  return db
    .query<{ company: string; ats: string; token: string }, []>(
      `SELECT company, ats, token FROM boards WHERE active = 1 ORDER BY company`,
    )
    .all();
}

export function addBoard(
  db: Database,
  board: Board & { verified?: boolean },
): { added: boolean } {
  const result = db
    .prepare(
      `INSERT INTO boards (company, ats, token, verified_at, active)
       VALUES (?, ?, ?, ?, 1)
       ON CONFLICT(ats, token) DO NOTHING`,
    )
    .run(board.company, board.ats, board.token, board.verified ? new Date().toISOString() : null);
  return { added: result.changes > 0 };
}

export function countJobs(db: Database): number {
  return db.query<{ n: number }, []>(`SELECT COUNT(*) AS n FROM jobs`).get()?.n ?? 0;
}
