import { defineCommand } from "citty";
import React from "react";
import { render } from "ink";
import { getPaths } from "../config/paths.ts";
import { loadConfigOrDefault } from "../config/load.ts";
import { openAndMigrate, type DbHandle } from "../db/db.ts";
import { Review } from "../tui/Review.tsx";
import { initialState, summarise, type ReviewJob, type ReviewState } from "../tui/state.ts";
import { formatSalary, fromStructured } from "../signals/salary.ts";
import { c, hint, line, warn } from "../output/theme.ts";

interface Row {
  id: string;
  company: string;
  title: string;
  location: string;
  engine: string;
  description: string;
  remote: number | null;
  remote_restriction: string | null;
  salary_min: number | null;
  salary_max: number | null;
  salary_currency: string | null;
  salary_period: string | null;
  matched_required: number;
  total_required: number;
  coverage: number;
  match_score: number;
  matched: string;
  missing: string;
  bonus: string;
  ai_score: number | null;
  reason: string | null;
  concerns: string | null;
  has_draft: number;
}

function loadJobs(db: DbHandle, threshold: number, all: boolean): ReviewJob[] {
  return db.raw
    .query<Row, [number]>(
      `SELECT j.id, j.company, j.title, j.location, j.engine, j.description,
              j.remote, j.remote_restriction,
              j.salary_min, j.salary_max, j.salary_currency, j.salary_period,
              m.matched_required, m.total_required, m.coverage, m.match_score,
              m.matched, m.missing, m.bonus,
              s.ai_score, s.reason, s.concerns,
              (SELECT COUNT(*) FROM jobs d WHERE d.id = j.id AND d.review_status = 'drafted') AS has_draft
       FROM matches m
       JOIN jobs j ON j.id = m.job_id
       LEFT JOIN scores s ON s.job_id = j.id
       WHERE j.canonical_id IS NULL
         AND j.review_status IN ('new','scored','drafted')
         AND m.match_score >= ?
       ORDER BY m.match_score DESC`,
    )
    .all(all ? 0 : threshold)
    .map((r) => ({
      id: r.id,
      company: r.company,
      title: r.title,
      location: r.location,
      engine: r.engine,
      description: r.description,
      matchedRequired: r.matched_required,
      totalRequired: r.total_required,
      coverage: r.coverage,
      matchScore: r.match_score,
      matched: JSON.parse(r.matched) as string[],
      missing: JSON.parse(r.missing) as string[],
      bonus: JSON.parse(r.bonus) as string[],
      aiScore: r.ai_score,
      reason: r.reason,
      concerns: r.concerns ? (JSON.parse(r.concerns) as string[]) : [],
      remote: r.remote,
      remoteRestriction: r.remote_restriction,
      hasDraft: r.has_draft > 0,
      salary: formatSalary(
        fromStructured({
          min: r.salary_min,
          max: r.salary_max,
          currency: r.salary_currency ?? "",
          period: (r.salary_period as "annual" | "monthly" | "hourly") ?? "annual",
        }),
      ),
    }));
}

/**
 * Write the session's decisions.
 *
 * Nothing is persisted until the screen is left, so a mis-keyed `r` can be
 * undone with `u` for as long as you are still reviewing.
 */
function persist(db: DbHandle, state: ReviewState): { approved: number; rejected: number; notes: number } {
  const summary = summarise(state);
  const setStatus = db.raw.prepare(`UPDATE jobs SET review_status = ? WHERE id = ?`);
  const setNote = db.raw.prepare(`
    INSERT INTO applications (job_id, status, last_status_at, note)
    VALUES (?, 'prepared', ?, ?)
    ON CONFLICT(job_id) DO UPDATE SET note = excluded.note
  `);

  db.raw.transaction(() => {
    for (const id of summary.approved) setStatus.run("approved", id);
    for (const id of summary.rejected) setStatus.run("rejected", id);
    const now = new Date().toISOString();
    for (const { jobId, note } of summary.notes) {
      // A note belongs to an application, which only exists once approved.
      if (summary.approved.includes(jobId)) setNote.run(jobId, now, note);
    }
  })();

  return {
    approved: summary.approved.length,
    rejected: summary.rejected.length,
    notes: summary.notes.length,
  };
}

export const reviewCommand = defineCommand({
  meta: {
    name: "review",
    description: "Full-screen triage — approve or reject by keystroke",
  },
  args: {
    all: { type: "boolean", description: "Include jobs below your threshold", default: false },
    root: { type: "string", description: "Data directory" },
  },

  async run({ args }) {
    const paths = getPaths(args.root as string | undefined);
    const config = await loadConfigOrDefault(paths);
    const db = await openAndMigrate(paths.db);

    try {
      const jobs = loadJobs(db, config.match.threshold, Boolean(args.all));

      if (jobs.length === 0) {
        line();
        line(warn("Nothing to review."));
        line(hint("  Run `jobscout run` to discover and rank, then come back."));
        line();
        return;
      }

      if (!process.stdout.isTTY) {
        line(warn("`jobscout review` needs an interactive terminal."));
        line(hint("  Use `jobscout match --top 20` for a non-interactive list."));
        process.exitCode = 1;
        return;
      }

      let finished: ReviewState | null = null;
      const app = render(
        React.createElement(Review, {
          initial: initialState(jobs),
          onDone: (state: ReviewState) => {
            finished = state;
          },
        }),
      );
      await app.waitUntilExit();

      if (!finished) {
        line(hint("No decisions recorded."));
        return;
      }

      const written = persist(db, finished);
      line();
      line(
        `  ${c.green(String(written.approved) + " approved")} · ` +
          `${c.red(String(written.rejected) + " rejected")}` +
          (written.notes ? c.dim(` · ${written.notes} note(s)`) : ""),
      );
      if (written.approved > 0) {
        line(hint("  Next: `jobscout draft`, then `jobscout prepare`."));
      }
      line();
    } finally {
      db.close();
    }
  },
});
