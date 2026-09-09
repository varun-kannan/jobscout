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
  signalsSchema,
  type Draft,
} from "./schemas.ts";
import {
  remoteReality,
  salaryState,
  salaryVsTarget,
  type PayTarget,
} from "../signals/compute.ts";
import { AliasResolver } from "../skills/aliases.ts";
import { labelOf } from "../skills/canonical.ts";

import normalisePrompt from "./prompts/normalise.md" with { type: "text" };
import extractSkillsPrompt from "./prompts/extract-skills.md" with { type: "text" };
import scorePrompt from "./prompts/score.md" with { type: "text" };
import draftPrompt from "./prompts/draft.md" with { type: "text" };
import signalsPrompt from "./prompts/signals.md" with { type: "text" };

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

/**
 * Apply the shared "worth a second opinion" filter, narrowed to one place when
 * asked.
 *
 * Both AI stages work down from the highest match score, which is right until
 * you care about somewhere specific: a city's postings can rank below hundreds
 * of others and never be reached at all.
 */
function locationFiltered<T>(
  db: Database,
  select: string,
  options: { threshold: number; limit?: number; location?: string },
): T[] {
  const limit = options.limit ?? 40;
  const place = options.location?.trim();
  const order = ` ORDER BY m.match_score DESC LIMIT ?`;

  if (!place) {
    return db.query<T, [number, number]>(select + order).all(options.threshold, limit);
  }
  // Matched loosely: a posting writes "Chennai, Tamil Nadu, India" and nobody
  // types that.
  return db
    .query<T, [number, string, number]>(`${select} AND j.location LIKE ?${order}`)
    .all(options.threshold, `%${place}%`, limit);
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
  options: { threshold: number; limit?: number; profileSummary: string; location?: string },
): Promise<StageSummary> {
  // Only jobs the arithmetic already rates worth a second opinion. Scoring
  // everything would spend most of the calls on roles you will never see.
  //
  // The location filter exists because ranking alone cannot reach a shortlist
  // you care about: postings in your city sat below three hundred others, so
  // scoring "the top 40" never touched a single one of them.
  const jobs = locationFiltered<ScoreRow>(
    db,
    `SELECT j.id, j.company, j.title, j.location, j.description,
            m.matched, m.missing, m.bonus, m.coverage
     FROM jobs j JOIN matches m ON m.job_id = j.id
     WHERE m.match_score >= ? AND j.canonical_id IS NULL
       AND NOT EXISTS (SELECT 1 FROM scores s WHERE s.job_id = j.id)`,
    options,
  );

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

/* ── signals ──────────────────────────────────────────────────────── */

interface SignalRow extends JobRow {
  salary_min: number | null;
  salary_max: number | null;
  salary_currency: string | null;
  salary_period: string | null;
  remote: number | null;
  remote_restriction: string | null;
}

/**
 * What a posting suggests about working there.
 *
 * Pay and remote status are settled arithmetically — they are stated facts, and
 * asking a model to compare two numbers invites it to be wrong about one. Only
 * the reading of tone is asked for, and every point it makes has to quote the
 * posting, so a claim can always be checked against the source.
 *
 * A model failure costs the judgement, not the row: the arithmetic is written
 * either way, because a salary comparison is still useful without a tone score.
 */
export async function computeSignals(
  db: Database,
  ai: AiClient,
  options: { threshold: number; limit?: number; target: PayTarget; location?: string },
): Promise<StageSummary> {
  const jobs = locationFiltered<SignalRow>(
    db,
    `SELECT j.id, j.company, j.title, j.location, j.description,
            j.salary_min, j.salary_max, j.salary_currency, j.salary_period,
            j.remote, j.remote_restriction
     FROM jobs j JOIN matches m ON m.job_id = j.id
     WHERE m.match_score >= ? AND j.canonical_id IS NULL
       AND NOT EXISTS (SELECT 1 FROM signals s WHERE s.job_id = j.id)`,
    options,
  );

  const summary = emptySummary(jobs.length);
  if (jobs.length === 0) return summary;

  ai.authoriseStage({ calls: jobs.length, averageChars: averageLength(jobs), tier: "judge" });

  const insert = db.prepare(`
    INSERT INTO signals (job_id, salary_state, salary_vs_target, wlb_score, wlb_evidence,
                         red_flags, green_flags, remote_reality, interview_stages,
                         repost_count, computed_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(job_id) DO UPDATE SET
      salary_state = excluded.salary_state, salary_vs_target = excluded.salary_vs_target,
      wlb_score = excluded.wlb_score, wlb_evidence = excluded.wlb_evidence,
      red_flags = excluded.red_flags, green_flags = excluded.green_flags,
      remote_reality = excluded.remote_reality, interview_stages = excluded.interview_stages,
      repost_count = excluded.repost_count, computed_at = excluded.computed_at
  `);

  // A role posted over and over is worth knowing about: it usually means the
  // last several hires did not stay, or the req is never actually filled.
  const reposts = db.prepare<{ n: number }, [string, string]>(
    `SELECT COUNT(*) AS n FROM jobs WHERE company = ? AND title = ?`,
  );

  for (const job of jobs) {
    const pay = {
      salaryMin: job.salary_min,
      salaryMax: job.salary_max,
      salaryCurrency: job.salary_currency,
      salaryPeriod: job.salary_period,
    };
    const arithmetic = {
      salaryState: salaryState(pay),
      salaryVsTarget: salaryVsTarget(pay, options.target),
      remoteReality: remoteReality({
        remote: job.remote === null ? null : job.remote === 1,
        remoteRestriction: job.remote_restriction,
      }),
      repostCount: reposts.get(job.company, job.title)?.n ?? 1,
    };

    try {
      const result = await ai.ask({
        instruction: signalsPrompt,
        context: [
          `POSTING: ${job.title} at ${job.company} (${job.location})`,
          ``,
          job.description.slice(0, 12_000),
        ].join("\n"),
        schema: signalsSchema,
        tier: "judge",
        stage: "signals",
      });

      insert.run(
        job.id,
        arithmetic.salaryState,
        arithmetic.salaryVsTarget,
        result.wlbScore,
        JSON.stringify(result.evidence),
        JSON.stringify(result.redFlags),
        JSON.stringify(result.greenFlags),
        arithmetic.remoteReality,
        result.interviewStages,
        arithmetic.repostCount,
        new Date().toISOString(),
      );
      summary.succeeded++;
    } catch (err) {
      if (err instanceof NoAiError) throw err;
      // The arithmetic still holds without a tone score, and a salary
      // comparison is worth keeping on its own.
      insert.run(
        job.id,
        arithmetic.salaryState,
        arithmetic.salaryVsTarget,
        null,
        "[]",
        "[]",
        "[]",
        arithmetic.remoteReality,
        null,
        arithmetic.repostCount,
        new Date().toISOString(),
      );
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
