import { defineCommand } from "citty";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { getPaths, type Paths } from "../config/paths.ts";
import { loadConfigOrDefault, loadSecrets } from "../config/load.ts";
import { openAndMigrate, type DbHandle } from "../db/db.ts";
import { BudgetExceededError, createAiClient, NoAiError, type AiClient } from "../ai/client.ts";
import { formatUsd } from "../ai/pricing.ts";
import { periodResets, spendSince, periodStart } from "../ai/budget.ts";
import { draftFor, extractJobSkills, normaliseJobs, scoreJobs, type StageSummary } from "../ai/stages.ts";
import { enrichSnippets } from "../pipeline/enrich.ts";
import { createHttpClient } from "../engines/http.ts";
import { loadProfile } from "../skills/profile.ts";
import { rankAll } from "../skills/rank.ts";
import { labelOf } from "../skills/canonical.ts";
import type { Config } from "../config/schema.ts";
import { c, hint, line, ok, pad, warn } from "../output/theme.ts";

async function open(root?: string): Promise<{
  paths: Paths;
  config: Config;
  db: DbHandle;
  ai: AiClient;
}> {
  const paths = getPaths(root);
  const config = await loadConfigOrDefault(paths);
  const secrets = await loadSecrets(paths);
  const db = await openAndMigrate(paths.db);
  const ai = createAiClient({
    db: db.raw,
    config,
    secrets,
    // Runs in the data directory, which has no .claude/, so no project hooks
    // or MCP servers from the user's current folder are loaded.
    cwd: paths.root,
  });
  return { paths, config, db, ai };
}

/**
 * Report a budget stop.
 *
 * Distinct from a failure: nothing went wrong, and nothing was left
 * half-written. Exits non-zero so a script can tell, but says plainly what
 * happened and how to continue.
 */
function reportBudgetStop(err: BudgetExceededError): void {
  line();
  line(warn("Stopped before this stage — the spend limit would be exceeded."));
  line(`  ${c.dim(err.verdict.reason ?? "")}`);
  line(
    `  ${c.dim(`estimated so far: ${formatUsd(err.verdict.spent)} of ${formatUsd(err.verdict.limit)}` +
      ` · this stage: ~${formatUsd(err.verdict.projected)}`)}`,
  );
  line();
  line(hint("  Nothing was left half-finished. To continue:"));
  line(hint("    jobscout config --budget <amount>    raise the limit"));
  line(hint("    jobscout config --budget 0           remove it entirely"));
  line();
  process.exitCode = 1;
}

/** One line per stage, and never a silent failure. */
function report(label: string, summary: StageSummary): void {
  if (summary.considered === 0) {
    line(`  ${c.dim(pad(label, 16))}${c.dim("nothing to do")}`);
    return;
  }
  const detail =
    summary.failed > 0
      ? `${summary.succeeded} done, ${c.red(`${summary.failed} failed`)}`
      : `${summary.succeeded} done`;
  line(`  ${pad(label, 16)}${detail}`);
  for (const err of summary.errors) line(`    ${c.dim(err.slice(0, 110))}`);
}

/** A compact profile for the model — the whole résumé would waste the window. */
function profileSummary(db: DbHandle): string {
  const skills = loadProfile(db.raw);
  const byCategory = new Map<string, string[]>();
  for (const s of skills) {
    const list = byCategory.get(s.category) ?? [];
    list.push(`${s.label} (${s.level}${s.years ? `, ${s.years}y` : ""})`);
    byCategory.set(s.category, list);
  }
  return [...byCategory.entries()].map(([cat, list]) => `${cat}: ${list.join(", ")}`).join("\n");
}

async function requireAi(ai: AiClient): Promise<boolean> {
  if (await ai.available()) return true;
  line();
  line(warn("No AI available."));
  line(
    hint(
      "  No configured backend is available. Run `jobscout init` to set one up.",
    ),
  );
  line(hint("  Discovery, matching and ranking all work without it."));
  line();
  return false;
}

/* ── enrich ───────────────────────────────────────────────────────── */

export const enrichCommand = defineCommand({
  meta: { name: "enrich", description: "Fetch full descriptions for truncated postings" },
  args: { root: { type: "string", description: "Data directory" } },

  async run({ args }) {
    const { config, db } = await open(args.root as string | undefined);
    const secrets = await loadSecrets(getPaths(args.root as string | undefined));
    try {
      line();
      const summary = await enrichSnippets(db.raw, {
        http: createHttpClient(),
        config,
        secrets,
      });
      line(
        `  ${summary.candidates} truncated · ${summary.boardsQueried} board(s) queried · ` +
          `${c.bold(String(summary.enriched))} completed · ${summary.unmatched} left as-is`,
      );
      line();
    } finally {
      db.close();
    }
  },
});

/* ── score ────────────────────────────────────────────────────────── */

export const scoreCommand = defineCommand({
  meta: { name: "score", description: "AI second opinion on what skill counts can't see" },
  args: {
    limit: { type: "string", description: "How many to score (default 40)" },
    root: { type: "string", description: "Data directory" },
  },

  async run({ args }) {
    const { config, db, ai } = await open(args.root as string | undefined);
    try {
      if (!(await requireAi(ai))) {
        process.exitCode = 1;
        return;
      }
      line();
      const summary = await scoreJobs(db.raw, ai, {
        threshold: config.match.threshold,
        limit: Number(args.limit ?? 40),
        profileSummary: profileSummary(db),
      });
      report("scored", summary);

      const rows = db.raw
        .query<{ company: string; title: string; ai_score: number; reason: string }, []>(
          `SELECT j.company, j.title, s.ai_score, s.reason
           FROM scores s JOIN jobs j ON j.id = s.job_id
           ORDER BY s.ai_score DESC, s.scored_at DESC LIMIT 8`,
        )
        .all();
      if (rows.length) {
        line();
        for (const r of rows) {
          line(
            `  ${c.bold("★" + r.ai_score)} ${pad(r.company.slice(0, 16), 17)}` +
              `${pad(r.title.slice(0, 34), 35)}${c.dim(r.reason.slice(0, 48))}`,
          );
        }
      }
      line();
    } catch (err) {
      if (err instanceof BudgetExceededError) {
        reportBudgetStop(err);
        return;
      }
      if (err instanceof NoAiError) {
        line(warn(err.message));
        process.exitCode = 1;
        return;
      }
      throw err;
    } finally {
      db.close();
    }
  },
});

/* ── draft ────────────────────────────────────────────────────────── */

async function readIfPresent(path: string): Promise<string> {
  try {
    return await readFile(path, "utf8");
  } catch {
    return "";
  }
}

export const draftCommand = defineCommand({
  meta: { name: "draft", description: "Write cover letter and screening answers per job" },
  args: {
    limit: { type: "string", description: "How many to draft (default 10)" },
    root: { type: "string", description: "Data directory" },
  },

  async run({ args }) {
    const { paths, config, db, ai } = await open(args.root as string | undefined);
    try {
      if (!(await requireAi(ai))) {
        process.exitCode = 1;
        return;
      }

      const jobs = db.raw
        .query<
          { id: string; company: string; title: string; description: string; matched: string; bonus: string },
          [number, number]
        >(
          `SELECT j.id, j.company, j.title, j.description, m.matched, m.bonus
           FROM matches m JOIN jobs j ON j.id = m.job_id
           LEFT JOIN scores s ON s.job_id = j.id
           WHERE m.match_score >= ? AND j.review_status IN ('new','scored')
             AND j.description <> ''
           ORDER BY COALESCE(s.ai_score, 3) DESC, m.match_score DESC
           LIMIT ?`,
        )
        .all(config.match.threshold, Number(args.limit ?? 10));

      if (jobs.length === 0) {
        line();
        line(hint("Nothing above threshold to draft. Run `jobscout match` first."));
        line();
        return;
      }

      const profile = profileSummary(db);
      const workHistory = await readIfPresent(paths.workHistory);
      const styleNotes = await readIfPresent(paths.coverLetterStyle);
      const answerBank = db.raw
        .query<{ question: string; answer: string }, []>(
          `SELECT question, answer FROM answers ORDER BY times_used DESC LIMIT 20`,
        )
        .all();

      line();
      line(c.dim(`Drafting ${jobs.length} job(s)…`));

      let done = 0;
      let failed = 0;
      const markDrafted = db.raw.prepare(`UPDATE jobs SET review_status = 'drafted' WHERE id = ?`);

      for (const job of jobs) {
        try {
          const draft = await draftFor(ai, {
            jobId: job.id,
            company: job.company,
            title: job.title,
            description: job.description,
            matched: JSON.parse(job.matched) as string[],
            bonus: JSON.parse(job.bonus) as string[],
            profile,
            workHistory,
            styleNotes,
            answerBank,
          });

          const dir = join(paths.drafts, job.id);
          await mkdir(dir, { recursive: true });
          await writeFile(join(dir, "cover_letter.md"), draft.coverLetter, "utf8");
          await writeFile(
            join(dir, "resume_notes.md"),
            draft.resumeNotes.map((n) => `- ${n}`).join("\n"),
            "utf8",
          );
          await writeFile(
            join(dir, "answers.md"),
            draft.answers.map((a) => `## ${a.question}\n\n${a.answer}`).join("\n\n"),
            "utf8",
          );
          // Gaps are recorded, never papered over — a guessed personal detail
          // in a job application is worse than a visible blank.
          if (draft.missingInformation.length) {
            await writeFile(
              join(dir, "MISSING.md"),
              ["The posting asks for things your profile does not contain:", "", ...draft.missingInformation.map((m) => `- ${m}`)].join("\n"),
              "utf8",
            );
          }

          markDrafted.run(job.id);
          done++;
          line(
            `  ${ok(`${pad(job.company.slice(0, 16), 17)}${job.title.slice(0, 40)}`)}` +
              (draft.missingInformation.length
                ? c.yellow(`  ${draft.missingInformation.length} gap(s)`)
                : ""),
          );
        } catch (err) {
          failed++;
          line(`  ${warn(job.company)} ${c.dim(err instanceof Error ? err.message.slice(0, 70) : "")}`);
        }
      }

      line();
      line(`  ${c.bold(String(done))} drafted into ${paths.drafts}${failed ? c.red(`, ${failed} failed`) : ""}`);
      line();
    } catch (err) {
      if (err instanceof BudgetExceededError) {
        reportBudgetStop(err);
        return;
      }
      throw err;
    } finally {
      db.close();
    }
  },
});

/* ── run ──────────────────────────────────────────────────────────── */

export const runCommand = defineCommand({
  meta: { name: "run", description: "discover → enrich → match → score → draft, in one go" },
  args: {
    draft: { type: "boolean", description: "Also draft (--no-draft stops after scoring)", default: true },
    root: { type: "string", description: "Data directory" },
  },

  async run({ args }) {
    const { config, db, ai } = await open(args.root as string | undefined);
    const secrets = await loadSecrets(getPaths(args.root as string | undefined));
    try {
      const hasAi = await ai.available();

      line();
      line(c.dim("Enriching truncated postings…"));
      const enriched = await enrichSnippets(db.raw, { http: createHttpClient(), config, secrets });
      line(`  ${enriched.enriched} completed from ${enriched.boardsQueried} board(s)`);

      if (hasAi) {
        line();
        line(c.dim("Reading postings…"));
        report("normalise", await normaliseJobs(db.raw, ai, { limit: 60 }));
        report("skills", await extractJobSkills(db.raw, ai, { limit: 60 }));
      } else {
        line();
        line(c.dim("No AI — using the deterministic extractor."));
      }

      line();
      line(c.dim("Matching…"));
      const ranked = rankAll(db.raw, config, { onlyNew: false });
      line(
        `  ${ranked.ranked} ranked · ${ranked.aboveThreshold} above threshold` +
          (ranked.skipped ? c.dim(` · ${ranked.skipped} had no requirements`) : ""),
      );

      if (hasAi) {
        line();
        line(c.dim("Scoring…"));
        report(
          "score",
          await scoreJobs(db.raw, ai, {
            threshold: config.match.threshold,
            limit: 40,
            profileSummary: profileSummary(db),
          }),
        );
      }

      line();
      line(
        hasAi
          ? c.green("Done.") + c.dim("  Run `jobscout draft`, then `jobscout review`.")
          : c.green("Done.") + c.dim("  Run `jobscout match --top 20` to see the list."),
      );
      line();
    } catch (err) {
      if (err instanceof BudgetExceededError) {
        reportBudgetStop(err);
        return;
      }
      throw err;
    } finally {
      db.close();
    }
  },
});
