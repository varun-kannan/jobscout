import { defineCommand } from "citty";
import { getPaths } from "../config/paths.ts";
import { loadConfigOrDefault, loadSecrets } from "../config/load.ts";
import { openAndMigrate } from "../db/db.ts";
import { activeBoards, recordRun, upsertJobs } from "../db/jobs.ts";
import { createHttpClient } from "../engines/http.ts";
import { implementedEngines, runEngines, type EngineRun } from "../engines/registry.ts";
import type { EngineId } from "../config/schema.ts";
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
      const implemented = new Set(implementedEngines());
      const requested = args.engine
        ? String(args.engine)
            .split(",")
            .map((s) => s.trim())
            .filter(Boolean)
        : config.engines.enabled;

      const engines = requested.filter((id): id is EngineId =>
        implemented.has(id as EngineId),
      );
      const notYetBuilt = requested.filter((id) => !implemented.has(id as EngineId));

      if (engines.length === 0) {
        line(c.yellow("No runnable engines enabled."));
        if (notYetBuilt.length) {
          line(hint(`Not built yet: ${notYetBuilt.join(", ")}`));
        }
        process.exitCode = 1;
        return;
      }

      const boards = activeBoards(db.raw);
      line();
      line(c.dim(`Discovering across ${engines.length} engine(s), ${boards.length} board(s)…`));
      line();

      const http = createHttpClient();
      let totalFetched = 0;
      let totalInserted = 0;

      const runs = await runEngines({
        engines,
        boards,
        http,
        config,
        secrets,
        query: {
          terms: config.search.roles,
          locations: config.search.locations,
          remoteOnly: config.search.remoteOnly,
          maxAgeDays: 30,
        },
        onFinish(run) {
          // Persist as each engine lands, so a later crash cannot lose work
          // that already succeeded.
          const { inserted } = upsertJobs(db.raw, run.engine, run.jobs);
          recordRun(db.raw, run, inserted);
          totalFetched += run.fetched;
          totalInserted += inserted;

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
      const failed = runs.filter((r) => r.status === "error" || r.status === "rate_limited");
      line(
        `  ${c.bold(String(totalInserted))} new posting(s) from ${totalFetched} fetched` +
          (failed.length ? c.red(`  ·  ${failed.length} engine(s) failed`) : ""),
      );
      if (notYetBuilt.length) {
        line(hint(`  Not built yet: ${notYetBuilt.join(", ")}`));
      }
      line();
    } finally {
      db.close();
    }
  },
});
