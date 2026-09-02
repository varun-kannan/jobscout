/**
 * Running the matcher over stored jobs and persisting the result.
 *
 * The matcher itself stays pure; this is the thin layer that reads rows, calls
 * it, and writes rows back. Keeping the split means the arithmetic can be
 * tested without a database, and the database work has no judgement in it.
 */

import type { Database } from "bun:sqlite";
import type { Config } from "../config/schema.ts";
import { extractSkills } from "./extract.ts";
import { AliasResolver } from "./aliases.ts";
import { loadProfile } from "./profile.ts";
import { matchJob, type JobSkill, type MatchResult } from "./match.ts";
import { labelOf } from "./canonical.ts";

export interface RankSummary {
  considered: number;
  extracted: number;
  ranked: number;
  aboveThreshold: number;
  skipped: number;
}

interface JobRow {
  id: string;
  title: string;
  description: string;
  description_complete: number;
}

/**
 * Ensure a job has skills recorded.
 *
 * Sources like Foundit hand skills over directly, and those were stored on
 * arrival. For everything else the description is scanned. A job with neither
 * simply has no requirements, which the matcher scores as zero rather than as a
 * perfect match.
 */
function ensureJobSkills(db: Database, job: JobRow, resolver: AliasResolver): number {
  const existing = db
    .query<{ n: number }, [string]>(`SELECT COUNT(*) AS n FROM job_skills WHERE job_id = ?`)
    .get(job.id);
  if ((existing?.n ?? 0) > 0) return 0;
  if (!job.description) return 0;

  const found = extractSkills(`${job.title}\n${job.description}`, { resolver });
  if (found.length === 0) return 0;

  const insert = db.prepare(`
    INSERT INTO job_skills (job_id, skill, label, requirement, source)
    VALUES (?, ?, ?, ?, 'scan')
    ON CONFLICT(job_id, skill) DO NOTHING
  `);
  db.transaction(() => {
    for (const skill of found) insert.run(job.id, skill.slug, skill.label, skill.requirement);
  })();

  return found.length;
}

function jobSkillsOf(db: Database, jobId: string): JobSkill[] {
  return db
    .query<{ skill: string; label: string; requirement: string }, [string]>(
      `SELECT skill, label, requirement FROM job_skills WHERE job_id = ?`,
    )
    .all(jobId)
    .map((r) => ({
      slug: r.skill,
      label: r.label || labelOf(r.skill),
      requirement: r.requirement === "preferred" ? "preferred" : "required",
    }));
}

function persist(db: Database, jobId: string, result: MatchResult, now: string): void {
  db.prepare(`
    INSERT INTO matches (
      job_id, matched_required, total_required, matched_preferred, total_preferred,
      coverage, match_score, matched, missing, bonus, matched_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(job_id) DO UPDATE SET
      matched_required = excluded.matched_required,
      total_required   = excluded.total_required,
      matched_preferred= excluded.matched_preferred,
      total_preferred  = excluded.total_preferred,
      coverage         = excluded.coverage,
      match_score      = excluded.match_score,
      matched          = excluded.matched,
      missing          = excluded.missing,
      bonus            = excluded.bonus,
      matched_at       = excluded.matched_at
  `).run(
    jobId,
    result.matchedRequired,
    result.totalRequired,
    result.matchedPreferred,
    result.totalPreferred,
    result.coverage,
    result.matchScore,
    JSON.stringify(result.matched),
    JSON.stringify(result.missing),
    JSON.stringify(result.bonus),
    now,
  );
}

export function rankAll(
  db: Database,
  config: Config,
  options: { onlyNew?: boolean } = {},
): RankSummary {
  const profile = loadProfile(db);
  const resolver = new AliasResolver(
    db
      .query<{ alias: string; canonical: string }, []>(`SELECT alias, canonical FROM skill_aliases`)
      .all()
      .map((r) => [r.alias, r.canonical] as [string, string]),
  );

  const jobs = db
    .query<JobRow, []>(
      options.onlyNew
        ? `SELECT id, title, description, description_complete FROM jobs
           WHERE canonical_id IS NULL AND id NOT IN (SELECT job_id FROM matches)`
        : `SELECT id, title, description, description_complete FROM jobs WHERE canonical_id IS NULL`,
    )
    .all();

  const now = new Date().toISOString();
  const summary: RankSummary = {
    considered: jobs.length,
    extracted: 0,
    ranked: 0,
    aboveThreshold: 0,
    skipped: 0,
  };

  for (const job of jobs) {
    summary.extracted += ensureJobSkills(db, job, resolver) > 0 ? 1 : 0;

    const skills = jobSkillsOf(db, job.id);
    if (skills.length === 0) {
      summary.skipped++;
      continue;
    }

    const result = matchJob({
      profile,
      job: skills,
      weights: config.match,
      domains: profile.filter((s) => s.category === "domain").map((s) => s.slug),
    });

    persist(db, job.id, result, now);
    summary.ranked++;
    if (result.matchScore >= config.match.threshold) summary.aboveThreshold++;
  }

  return summary;
}

export interface RankedJob {
  id: string;
  company: string;
  title: string;
  location: string;
  engine: string;
  matchedRequired: number;
  totalRequired: number;
  coverage: number;
  matchScore: number;
  matched: string[];
  missing: string[];
  bonus: string[];
}

export function topMatches(db: Database, limit = 20): RankedJob[] {
  return db
    .query<
      {
        id: string; company: string; title: string; location: string; engine: string;
        matched_required: number; total_required: number; coverage: number;
        match_score: number; matched: string; missing: string; bonus: string;
      },
      [number]
    >(
      `SELECT j.id, j.company, j.title, j.location, j.engine,
              m.matched_required, m.total_required, m.coverage, m.match_score,
              m.matched, m.missing, m.bonus
       FROM matches m JOIN jobs j ON j.id = m.job_id
       ORDER BY m.match_score DESC, m.coverage DESC
       LIMIT ?`,
    )
    .all(limit)
    .map((r) => ({
      id: r.id,
      company: r.company,
      title: r.title,
      location: r.location,
      engine: r.engine,
      matchedRequired: r.matched_required,
      totalRequired: r.total_required,
      coverage: r.coverage,
      matchScore: r.match_score,
      matched: JSON.parse(r.matched) as string[],
      missing: JSON.parse(r.missing) as string[],
      bonus: JSON.parse(r.bonus) as string[],
    }));
}
