import { defineCommand } from "citty";
import { getPaths } from "../config/paths.ts";
import { loadConfigOrDefault } from "../config/load.ts";
import { openAndMigrate } from "../db/db.ts";
import { loadProfile } from "../skills/profile.ts";
import { rankAll, topMatches } from "../skills/rank.ts";
import { labelsFor } from "../skills/match.ts";
import { c, hint, line, pad, warn } from "../output/theme.ts";

/** A short bar so coverage reads at a glance rather than as a number to parse. */
function bar(fraction: number, width = 18): string {
  const filled = Math.round(Math.max(0, Math.min(1, fraction)) * width);
  return c.green("█".repeat(filled)) + c.dim("░".repeat(width - filled));
}

export const matchCommand = defineCommand({
  meta: {
    name: "match",
    description: "Rank postings by skill overlap with your profile",
  },
  args: {
    all: { type: "boolean", description: "Re-rank everything, not just new postings", default: false },
    top: { type: "string", description: "How many to show (default 15)" },
    root: { type: "string", description: "Data directory" },
  },

  async run({ args }) {
    const paths = getPaths(args.root as string | undefined);
    const config = await loadConfigOrDefault(paths);
    const db = await openAndMigrate(paths.db);

    try {
      const profile = loadProfile(db.raw);
      if (profile.length === 0) {
        line();
        line(warn("No skill profile — there is nothing to match against."));
        line(hint("Run `jobscout skills --extract` first."));
        line();
        process.exitCode = 1;
        return;
      }

      line();
      line(c.dim(`Matching against ${profile.length} skills…`));

      const summary = rankAll(db.raw, config, { onlyNew: !args.all });

      line(
        `  ${c.bold(String(summary.ranked))} ranked` +
          c.dim(` · ${summary.extracted} had skills extracted from text`) +
          (summary.skipped ? c.dim(` · ${summary.skipped} had no requirements listed`) : ""),
      );
      line(
        c.dim(
          `  ${summary.aboveThreshold} above your threshold of ${(config.match.threshold * 100).toFixed(0)}%`,
        ),
      );

      const limit = Number(args.top ?? 15);
      const top = topMatches(db.raw, Number.isFinite(limit) ? limit : 15);
      if (top.length === 0) {
        line();
        line(hint("Nothing ranked yet. Run `jobscout discover` first."));
        line();
        return;
      }

      line();
      line(c.bold("  Best matches"));
      line();
      for (const job of top) {
        const count = `${job.matchedRequired}/${job.totalRequired}`;
        const pct = `${Math.round(job.coverage * 100)}%`;
        line(
          `  ${c.bold(pad(count, 6))}${bar(job.coverage)} ${pad(pct, 5)} ` +
            `${pad(job.company.slice(0, 18), 19)}${job.title.slice(0, 40)}`,
        );
      }

      // Show the working for the top result, so a rank is never just a number.
      const best = top[0];
      if (best) {
        line();
        line(c.dim(`  Why ${best.company} — ${best.title.slice(0, 46)} ranks first:`));
        if (best.matched.length) {
          line(`    ${c.green("✓")} ${labelsFor(best.matched).slice(0, 9).join(" · ")}`);
        }
        if (best.missing.length) {
          line(`    ${c.red("✗")} ${labelsFor(best.missing).slice(0, 6).join(" · ")}`);
        }
        if (best.bonus.length) {
          line(`    ${c.yellow("+")} ${labelsFor(best.bonus).slice(0, 6).join(" · ")} ${c.dim("(not asked for)")}`);
        }
      }
      line();
    } finally {
      db.close();
    }
  },
});
