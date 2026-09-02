/**
 * The AI stages: normalise, extract skills, score, draft.
 *
 * Each one reads rows, asks a question, validates the answer, and writes rows
 * back. None of them decide your ranking — that stays arithmetic in
 * `skills/match.ts`. What happens here is the fuzzy work around it: turning
 * prose into structure, and structure back into prose.
 *
 * Every stage isolates failure per job. One posting that a model chokes on must
 * not lose the other nine hundred.
 */

import type { Database } from "bun:sqlite";
import type { AiClient } from "./client.ts";
import { NoAiError } from "./client.ts";
import {
  draftSchema,
  jobSkillsSchema,
  normaliseSchema,
  scoreSchema,
  type Draft,
} from "./schemas.ts";
import { AliasResolver } from "../skills/aliases.ts";
import { labelOf } from "../skills/canonical.ts";

import normalisePrompt from "./prompts/normalise.md" with { type: "text" };
import extractSkillsPrompt from "./prompts/extract-skills.md" with { type: "text" };
import scorePrompt from "./prompts/score.md" with { type: "text" };
import draftPrompt from "./prompts/draft.md" with { type: "text" };

export interface StageSummary {
  considered: number;
  succeeded: number;
  failed: number;
  /** First few failures, so an error is visible without trawling logs. */
  errors: string[];
}

function emptySummary(considered = 0): StageSummary {
  return { considered, succeeded: 0, failed: 0, errors: [] };
}

/** Typical prompt size for a stage, for sizing the budget check. */
function averageLength(jobs: Array<{ description: string }>): number {
  if (jobs.length === 0) return 0;
  const total = jobs.reduce((sum, j) => sum + Math.min(j.description.length, 12_000), 0);
  return Math.ceil(total / jobs.length);
}

function note(summary: StageSummary, jobId: string, err: unknown): void {
  summary.failed++;
  if (summary.errors.length < 3) {
    summary.errors.push(`${jobId}: ${err instanceof Error ? err.message : String(err)}`);
  }
}

interface JobRow {
  id: string;
  company: string;
  title: string;
  location: string;
  description: string;
}

/* ── normalise ────────────────────────────────────────────────────── */

export async function normaliseJobs(
  db: Database,
  ai: AiClient,
  options: { limit?: number } = {},
): Promise<StageSummary> {
  const jobs = db
    .query<JobRow, [number]>(
      `SELECT id, company, title, location, description FROM jobs
       WHERE seniority IS NULL AND description <> '' AND canonical_id IS NULL
       LIMIT ?`,
    )
    .all(options.limit ?? 100);

  const summary = emptySummary(jobs.length);
  if (jobs.length === 0) return summary;

  // Authorised before any call is made, so the stage either runs whole or
  // does not begin. Throws BudgetExceededError, which the caller reports.
  ai.authoriseStage({
    calls: jobs.length,
    averageChars: averageLength(jobs),
    tier: "extract",
  });

  const update = db.prepare(`
    UPDATE jobs SET seniority = ?, employment_type = ?, remote = ?, remote_restriction = ?,
      salary_min = COALESCE(?, salary_min), salary_max = COALESCE(?, salary_max),
      salary_currency = COALESCE(?, salary_currency), salary_period = COALESCE(?, salary_period)
    WHERE id = ?
  `);

  for (const job of jobs) {
    try {
      const result = await ai.ask({
        instruction: normalisePrompt,
        context: `${job.title}\n${job.location}\n\n${job.description.slice(0, 12_000)}`,
        schema: normaliseSchema,
        tier: "extract",
        stage: "normalise",
      });

      update.run(
        result.seniority,
        result.employmentType,
        // "remote-restricted" is still remote — the restriction is the detail
        // that matters, and it is recorded separately rather than flattened.
        result.remote === "remote" || result.remote === "remote-restricted"
          ? 1
          : result.remote === "unknown"
            ? null
            : 0,
        result.remoteRestriction,
        result.salaryMin,
        result.salaryMax,
        result.salaryCurrency,
        result.salaryPeriod,
        job.id,
      );
      summary.succeeded++;
    } catch (err) {
      if (err instanceof NoAiError) throw err;
      note(summary, job.id, err);
    }
  }

  return summary;
}

/* ── extract skills ───────────────────────────────────────────────── */

/**
 * Re-extract skills with a model, replacing what the keyword scanner found.
 *
 * Worth the calls because the deterministic extractor cannot follow paraphrase:
 * "experience with event streaming platforms" is Kafka, and no keyword list
 * catches every rewording.
 */
export async function extractJobSkills(
  db: Database,
  ai: AiClient,
  options: { limit?: number } = {},
): Promise<StageSummary> {
  const jobs = db
    .query<JobRow, [number]>(
      `SELECT j.id, j.company, j.title, j.location, j.description FROM jobs j
       WHERE j.description <> '' AND j.canonical_id IS NULL
         AND NOT EXISTS (SELECT 1 FROM job_skills s WHERE s.job_id = j.id AND s.source = 'ai')
       LIMIT ?`,
    )
    .all(options.limit ?? 100);

  const summary = emptySummary(jobs.length);
  if (jobs.length === 0) return summary;

  ai.authoriseStage({ calls: jobs.length, averageChars: averageLength(jobs), tier: "extract" });

  const resolver = new AliasResolver(
    db
      .query<{ alias: string; canonical: string }, []>(`SELECT alias, canonical FROM skill_aliases`)
      .all()
      .map((r) => [r.alias, r.canonical] as [string, string]),
  );

  const clear = db.prepare(`DELETE FROM job_skills WHERE job_id = ?`);
  const insert = db.prepare(`
    INSERT INTO job_skills (job_id, skill, label, requirement, source)
    VALUES (?, ?, ?, ?, 'ai')
    ON CONFLICT(job_id, skill) DO UPDATE SET requirement = excluded.requirement, source = 'ai'
  `);

  for (const job of jobs) {
    try {
      const result = await ai.ask({
        instruction: extractSkillsPrompt,
        context: `${job.title}\n\n${job.description.slice(0, 12_000)}`,
        schema: jobSkillsSchema,
        tier: "extract",
        stage: "extract-skills",
      });

      db.transaction(() => {
        clear.run(job.id);
        for (const [list, requirement] of [
          [result.required, "required"],
          [result.preferred, "preferred"],
        ] as const) {
          for (const raw of list) {
            const slug = resolver.resolve(raw);
            if (slug) insert.run(job.id, slug, labelOf(slug), requirement);
          }
        }
      })();
      summary.succeeded++;
    } catch (err) {
      if (err instanceof NoAiError) throw err;
      note(summary, job.id, err);
    }
  }

  return summary;
}

/* ── score ────────────────────────────────────────────────────────── */

interface ScoreRow extends JobRow {
  matched: string;
  missing: string;
  bonus: string;
  coverage: number;
}

export async function scoreJobs(
  db: Database,
  ai: AiClient,
  options: { threshold: number; limit?: number; profileSummary: string },
): Promise<StageSummary> {
  // Only jobs the arithmetic already rates worth a second opinion. Scoring
  // everything would spend most of the calls on roles you will never see.
  const jobs = db
    .query<ScoreRow, [number, number]>(
      `SELECT j.id, j.company, j.title, j.location, j.description,
              m.matched, m.missing, m.bonus, m.coverage
       FROM jobs j JOIN matches m ON m.job_id = j.id
       WHERE m.match_score >= ? AND j.canonical_id IS NULL
         AND NOT EXISTS (SELECT 1 FROM scores s WHERE s.job_id = j.id)
       ORDER BY m.match_score DESC
       LIMIT ?`,
    )
    .all(options.threshold, options.limit ?? 40);

  const summary = emptySummary(jobs.length);
  if (jobs.length === 0) return summary;

  ai.authoriseStage({ calls: jobs.length, averageChars: averageLength(jobs), tier: "judge" });

  const insert = db.prepare(`
    INSERT INTO scores (job_id, ai_score, reason, concerns, model, scored_at)
    VALUES (?, ?, ?, ?, ?, ?)
    ON CONFLICT(job_id) DO UPDATE SET
      ai_score = excluded.ai_score, reason = excluded.reason,
      concerns = excluded.concerns, scored_at = excluded.scored_at
  `);

  const labels = (json: string) =>
    (JSON.parse(json) as string[]).map((s) => labelOf(s)).join(", ") || "none";

  for (const job of jobs) {
    try {
      const result = await ai.ask({
        instruction: scorePrompt,
        system: `Candidate profile:\n${options.profileSummary}`,
        context: [
          `POSTING: ${job.title} at ${job.company} (${job.location})`,
          ``,
          `Skill overlap already counted — do not re-derive it:`,
          `  matched: ${labels(job.matched)}`,
          `  missing: ${labels(job.missing)}`,
          `  candidate strengths not asked for: ${labels(job.bonus)}`,
          ``,
          job.description.slice(0, 12_000),
        ].join("\n"),
        schema: scoreSchema,
        tier: "judge",
        stage: "score",
      });

      // A different kind of work is a hard cap, whatever the skills say. This
      // is the specific failure the stage exists for: a payments engineer's
      // skills match "Account Executive, Payments" almost perfectly.
      const capped =
        result.roleTypeMatch === "different"
          ? Math.min(result.score, 2)
          : result.roleTypeMatch === "adjacent"
            ? Math.min(result.score, 4)
            : result.score;

      const concerns = [...result.concerns];
      if (capped !== result.score) {
        concerns.unshift(`Different kind of role (${result.roleTypeMatch})`);
      }

      insert.run(
        job.id,
        capped,
        result.reason,
        JSON.stringify(concerns),
        await ai.describe(),
        new Date().toISOString(),
      );
      summary.succeeded++;
    } catch (err) {
      if (err instanceof NoAiError) throw err;
      note(summary, job.id, err);
    }
  }

  return summary;
}

/* ── draft ────────────────────────────────────────────────────────── */

export interface DraftInput {
  jobId: string;
  company: string;
  title: string;
  description: string;
  matched: string[];
  bonus: string[];
  profile: string;
  workHistory: string;
  styleNotes: string;
  answerBank: Array<{ question: string; answer: string }>;
}

export async function draftFor(ai: AiClient, input: DraftInput): Promise<Draft> {
  return ai.ask({
    instruction: draftPrompt,
    system: [
      "CANDIDATE PROFILE",
      input.profile,
      "",
      "WORK HISTORY",
      input.workHistory || "(none supplied)",
      "",
      "STYLE NOTES",
      input.styleNotes || "(none supplied)",
      "",
      "PREVIOUSLY CONFIRMED ANSWERS — reuse verbatim where the question matches",
      input.answerBank.map((a) => `Q: ${a.question}\nA: ${a.answer}`).join("\n\n") || "(none)",
    ].join("\n"),
    context: [
      `POSTING: ${input.title} at ${input.company}`,
      `Matched skills: ${input.matched.map(labelOf).join(", ") || "none"}`,
      `Strengths not asked for: ${input.bonus.map(labelOf).join(", ") || "none"}`,
      "",
      input.description.slice(0, 14_000),
    ].join("\n"),
    schema: draftSchema,
    tier: "write",
    stage: "draft",
  });
}
