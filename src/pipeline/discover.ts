/**
 * One discovery pass: run the engines, store what they return, record each run.
 *
 * Shared by `jobscout discover` and the UI's Discover button, so the two cannot
 * drift into searching with different terms or age limits.
 */

import type { Database } from "bun:sqlite";
import type { Config, EngineId, Secrets } from "../config/schema.ts";
import { activeBoards, recordRun, upsertJobs } from "../db/jobs.ts";
import { createHttpClient } from "../engines/http.ts";
import { implementedEngines, runEngines, type EngineRun } from "../engines/registry.ts";

export interface DiscoverOptions {
  db: Database;
  config: Config;
  secrets: Secrets;
  /** Defaults to the engines enabled in config. */
  engines?: string[];
  signal?: AbortSignal;
  onFinish?(run: EngineRun, inserted: number): void;
}

export interface DiscoverResult {
  runs: EngineRun[];
  fetched: number;
  inserted: number;
  boards: number;
  /** Engine names that were requested but have no implementation. */
  notBuilt: string[];
}

export async function discoverJobs(options: DiscoverOptions): Promise<DiscoverResult> {
  const { db, config, secrets } = options;
  const implemented = new Set<string>(implementedEngines());
  const requested = options.engines ?? config.engines.enabled;
  const engines = requested.filter((id): id is EngineId => implemented.has(id));
  const notBuilt = requested.filter((id) => !implemented.has(id));
  const boards = activeBoards(db);

  let fetched = 0;
  let inserted = 0;

  const runs = await runEngines({
    engines,
    boards,
    http: createHttpClient(),
    config,
    secrets,
    signal: options.signal,
    query: {
      terms: config.search.roles,
      locations: config.search.locations,
      remoteOnly: config.search.remoteOnly,
      maxAgeDays: 30,
    },
    onFinish(run) {
      // Persisted as each engine lands, so a later failure cannot lose work
      // that already succeeded.
      const result = upsertJobs(db, run.engine, run.jobs);
      recordRun(db, run, result.inserted);
      fetched += run.fetched;
      inserted += result.inserted;
      options.onFinish?.(run, result.inserted);
    },
  });

  return { runs, fetched, inserted, boards: boards.length, notBuilt };
}
