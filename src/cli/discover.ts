import { defineCommand } from "citty";
import { getPaths } from "../config/paths.ts";
import { loadConfigOrDefault, loadSecrets } from "../config/load.ts";
import { openAndMigrate } from "../db/db.ts";
import { activeBoards } from "../db/jobs.ts";
import { implementedEngines, type EngineRun } from "../engines/registry.ts";
import { discoverJobs } from "../pipeline/discover.ts";
import { c, hint, line, pad, sym } from "../output/theme.ts";

function statusMark(run: EngineRun): string {
  switch (run.status) {
    case "ok":
      return c.green(sym.ok);
    case "empty":
      return c.dim(sym.skip);
    case "skipped":
      return c.dim(sym.skip);
    case "rate_limited":
      return c.yellow(sym.warn);
    default:
      return c.red(sym.fail);
  }
}

export const discoverCommand = defineCommand({
  meta: {
    name: "discover",
    description: "Fetch new postings from every enabled engine",
  },
  args: {
    engine: {
      type: "string",
      description: "Run only this engine (repeatable via commas)",
    },
    root: { type: "string", description: "Data directory" },
  },

  async run({ args }) {
    const paths = getPaths(args.root as string | undefined);
    const config = await loadConfigOrDefault(paths);
    const secrets = await loadSecrets(paths);
    const db = await openAndMigrate(paths.db);

    try {
      const implemented = new Set<string>(implementedEngines());
      const requested = args.engine
        ? String(args.engine)
            .split(",")
            .map((s) => s.trim())
            .filter(Boolean)
        : config.engines.enabled;
      const runnable = requested.filter((id) => implemented.has(id));

      if (runnable.length === 0) {
        line(c.yellow("No runnable engines enabled."));
        const notBuilt = requested.filter((id) => !implemented.has(id));
        if (notBuilt.length) line(hint(`Not built yet: ${notBuilt.join(", ")}`));
        process.exitCode = 1;
        return;
      }

      line();
      line(c.dim(`Discovering across ${runnable.length} engine(s), ${activeBoards(db.raw).length} board(s)...`));
      line();

      const result = await discoverJobs({
        db: db.raw,
        config,
        secrets,
        engines: requested,
        onFinish(run, inserted) {
          const detail =
            run.status === "ok"
              ? `${String(run.fetched).padStart(4)} fetched  ${String(inserted).padStart(3)} new`
              : run.error
                ? c.dim(run.error)
                : run.status;
          line(`  ${statusMark(run)} ${pad(run.engine, 18)}${detail}`);
        },
      });

      line();
      const failed = result.runs.filter((r) => r.status === "error" || r.status === "rate_limited");
      line(
        `  ${c.bold(String(result.inserted))} new posting(s) from ${result.fetched} fetched` +
          (failed.length ? c.red(`  |  ${failed.length} engine(s) failed`) : ""),
      );
      if (result.notBuilt.length) {
        line(hint(`  Not built yet: ${result.notBuilt.join(", ")}`));
      }
      line();
    } finally {
      db.close();
    }
  },
});
