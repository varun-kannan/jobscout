import { defineCommand } from "citty";
import { getPaths } from "../config/paths.ts";
import { openAndMigrate } from "../db/db.ts";
import { prepareApproved } from "../pipeline/prepare.ts";
import {
  AmbiguousJobError,
  APPLICATION_STATUSES,
  listAnswers,
  recordAnswer,
  resolveApplication,
  setStatus,
  staleApplications,
  statusCounts,
  UnknownJobError,
  type ApplicationStatus,
} from "../db/applications.ts";
import { c, hint, line, ok, pad, warn } from "../output/theme.ts";
import { periodResets, periodStart, spendSince } from "../ai/budget.ts";
import { formatUsd } from "../ai/pricing.ts";
import { loadConfigOrDefault } from "../config/load.ts";

/* ── prepare ──────────────────────────────────────────────────────── */

export const prepareCommand = defineCommand({
  meta: { name: "prepare", description: "Finalise approved jobs into the outbox" },
  args: { root: { type: "string", description: "Data directory" } },

  async run({ args }) {
    const paths = getPaths(args.root as string | undefined);
    const db = await openAndMigrate(paths.db);

    try {
      const summary = await prepareApproved(db.raw, paths);

      line();
      if (summary.approved === 0) {
        line(warn("Nothing approved yet."));
        line(hint("  Run `jobscout review` and approve some jobs first."));
        line();
        return;
      }

      for (const job of summary.prepared) {
        line(
          `  ${ok(`${pad(job.company.slice(0, 18), 19)}${job.title.slice(0, 40)}`)}` +
            (job.missing.length ? c.yellow(`  ${job.missing.length} gap(s)`) : ""),
        );
      }

      for (const job of summary.undrafted) {
        line(`  ${warn(`${pad(job.company.slice(0, 18), 19)}${job.title.slice(0, 40)}`)}`);
        line(`    ${c.dim("approved but not drafted — run `jobscout draft`")}`);
      }

      line();
      line(
        `  ${c.bold(String(summary.prepared.length))} ready in ${paths.outbox}` +
          (summary.undrafted.length ? c.yellow(`  ·  ${summary.undrafted.length} still need drafting`) : ""),
      );
      if (summary.prepared.length > 0) line(hint("  Next: `jobscout apply`."));
      line();
    } finally {
      db.close();
    }
  },
});

/* ── status ───────────────────────────────────────────────────────── */

const STATUS_COLOUR: Record<string, (s: string) => string> = {
  prepared: c.dim,
  submitted: c.cyan,
  responded: c.blue,
  interviewing: c.magenta,
  offer: c.green,
  closed: c.red,
  ghosted: c.dim,
};

export const statusCommand = defineCommand({
  meta: { name: "status", description: "Where everything stands, and what has gone quiet" },
  args: {
    submitted: { type: "string", description: "Mark an application submitted (company or id)" },
    set: { type: "string", description: "Set a status: <reference>=<status>" },
    answer: { type: "string", description: "Record a screening answer: <question>=<answer>" },
    stale: { type: "string", description: "Days of silence before a job counts as stale (default 14)" },
    root: { type: "string", description: "Data directory" },
  },

  async run({ args }) {
    const paths = getPaths(args.root as string | undefined);
    const config = await loadConfigOrDefault(paths);
    const db = await openAndMigrate(paths.db);

    try {
      /* — mutations first, so the report reflects them — */

      if (args.answer) {
        const [question, ...rest] = String(args.answer).split("=");
        const answer = rest.join("=");
        if (!question || !answer) {
          line(warn('Use --answer "question=answer".'));
          process.exitCode = 1;
          return;
        }
        recordAnswer(db.raw, question, answer);
        line(ok(`Recorded. It will be reused rather than re-drafted.`));
        return;
      }

      const change = args.submitted
        ? { reference: String(args.submitted), status: "submitted" as ApplicationStatus }
        : args.set
          ? (() => {
              const [reference, status] = String(args.set).split("=");
              return { reference: reference ?? "", status: status as ApplicationStatus };
            })()
          : null;

      if (change) {
        if (!APPLICATION_STATUSES.includes(change.status)) {
          line(warn(`Unknown status "${change.status}".`));
          line(hint(`  One of: ${APPLICATION_STATUSES.join(", ")}`));
          process.exitCode = 1;
          return;
        }
        try {
          const app = resolveApplication(db.raw, change.reference);
          setStatus(db.raw, app.jobId, change.status);
          line(ok(`${app.company} — ${app.title}  →  ${change.status}`));
        } catch (err) {
          if (err instanceof AmbiguousJobError) {
            line(warn(err.message));
            // Never guess between two real applications.
            for (const candidate of err.candidates.slice(0, 6)) {
              line(`  ${c.dim(candidate.jobId)}  ${candidate.company} — ${candidate.title.slice(0, 40)}`);
            }
            line(hint("  Try a longer reference, or use the id."));
          } else if (err instanceof UnknownJobError) {
            line(warn(err.message));
          } else throw err;
          process.exitCode = 1;
        }
        return;
      }

      /* — the report — */

      const pipeline = db.raw
        .query<{ status: string; n: number }, []>(
          `SELECT review_status AS status, COUNT(*) AS n FROM jobs GROUP BY review_status`,
        )
        .all();
      const seen = pipeline.reduce((sum, r) => sum + r.n, 0);
      const byReview = Object.fromEntries(pipeline.map((r) => [r.status, r.n]));

      line();
      line(
        `  ${c.bold("Pipeline")}     ${seen} seen · ` +
          `${byReview.scored ?? 0} scored · ${byReview.drafted ?? 0} drafted · ` +
          `${c.green(String(byReview.approved ?? 0) + " approved")} · ` +
          `${c.dim(String(byReview.rejected ?? 0) + " rejected")}`,
      );

      const counts = statusCounts(db.raw);
      const total = Object.values(counts).reduce((a, b) => a + b, 0);
      if (total > 0) {
        line();
        line(`  ${c.bold("Applications")}`);
        for (const status of APPLICATION_STATUSES) {
          const n = counts[status] ?? 0;
          if (n === 0) continue;
          const paint = STATUS_COLOUR[status] ?? ((s: string) => s);
          line(`    ${paint(pad(status, 14))}${n}`);
        }
      }

      const afterDays = Number(args.stale ?? 14);
      const stale = staleApplications(db.raw, Number.isFinite(afterDays) ? afterDays : 14);
      if (stale.length > 0) {
        line();
        line(`  ${c.red(`Stale — no response in ${afterDays}+ days`)}`);
        for (const app of stale.slice(0, 10)) {
          line(
            `    ${c.dim(app.lastStatusAt.slice(0, 10))}  ${pad(app.company.slice(0, 18), 19)}` +
              `${pad(app.title.slice(0, 34), 35)}${c.red(`${app.daysSince}d`)}`,
          );
        }
      }

      const engines = db.raw
        .query<{ engine: string; status: string; error: string | null }, []>(
          `SELECT engine, status, error FROM engine_runs
           WHERE id IN (SELECT MAX(id) FROM engine_runs GROUP BY engine)
           ORDER BY engine`,
        )
        .all();
      if (engines.length > 0) {
        const okCount = engines.filter((e) => e.status === "ok").length;
        const bad = engines.filter((e) => e.status === "error" || e.status === "rate_limited");
        line();
        line(
          `  ${c.bold("Engines")}      ${c.green(`${okCount} ok`)}` +
            ` · ${c.dim(`${engines.length - okCount - bad.length} idle`)}` +
            (bad.length ? ` · ${c.red(`${bad.length} failing`)}` : ""),
        );
        for (const engine of bad) {
          line(`    ${c.red(pad(engine.engine, 18))}${c.dim((engine.error ?? "").slice(0, 52))}`);
        }
      }

      const budget = config.ai.budget;
      const spend = spendSince(db.raw, periodStart(budget.period));
      if (spend.calls > 0) {
        const resets = periodResets(budget.period);
        line();
        line(
          `  ${c.bold("AI spend")}     ${formatUsd(spend.total)} estimated` +
            (budget.limit > 0 ? c.dim(` of ${formatUsd(budget.limit)} ${budget.period}`) : c.dim(" · no limit set")) +
            c.dim(` · ${spend.calls} call(s)`),
        );
        for (const row of spend.byStage.slice(0, 4)) {
          line(`    ${c.dim(pad(row.stage, 16))}${formatUsd(row.usd)}${c.dim(`  ${row.calls} call(s)`)}`);
        }
        // Silence about unpriced calls would make the total look complete.
        if (spend.unpriced > 0) {
          line(`    ${c.yellow(`${spend.unpriced} call(s) had no known price — the total understates`)}`);
        }
        if (resets) line(`    ${c.dim(`resets ${resets.toISOString().slice(0, 10)}`)}`);
      }

      const answers = listAnswers(db.raw);
      if (answers.length > 0) {
        line();
        line(`  ${c.bold("Answer bank")}  ${answers.length} confirmed answer(s)`);
      }

      line();
    } finally {
      db.close();
    }
  },
});
