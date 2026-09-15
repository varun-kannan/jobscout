/**
 * What each engine would do if discovery ran now, and what it did last time.
 *
 * Readiness comes from each engine's own `ready()`, the same call discovery
 * makes, so this report cannot claim an engine works when discovery would skip
 * it. `doctor` uses a shorter rule and calls Workable ready even with no boards,
 * which is exactly the kind of disagreement this avoids.
 */

import type { Database } from "bun:sqlite";
import type { Config, EngineId, Secrets } from "../config/schema.ts";
import type { Board } from "./engine.ts";
import { ENGINES } from "./registry.ts";

export interface EngineHealth {
  id: EngineId;
  family: string;
  enabled: boolean;
  /** Would run if discovery started now. Always false when disabled. */
  ready: boolean;
  /** Why it would not run, when enabled but not ready. */
  blockedBy: string | null;
  lastRun: {
    status: string;
    startedAt: string;
    fetched: number;
    inserted: number;
    error: string | null;
  } | null;
  /** Postings currently stored from this engine. */
  jobs: number;
}

export interface HealthOptions {
  db: Database;
  config: Config;
  secrets: Secrets;
  boards: Board[];
  /**
   * JobSpy's `ready()` only checks that it is enabled, then fails at runtime
   * without a new enough Python. The caller supplies that check so tests do
   * not depend on what is installed.
   */
  pythonStatus?: () => Promise<{ ok: boolean; reason: string }>;
}

export async function engineHealth(options: HealthOptions): Promise<EngineHealth[]> {
  const { db, config, secrets, boards } = options;
  const enabled = new Set<string>(config.engines.enabled);

  const lastRuns = new Map(
    db
      .query<{ engine: string; status: string; started_at: string; fetched: number;
               inserted: number; error: string | null }, []>(
        `SELECT r.engine, r.status, r.started_at, r.fetched, r.inserted, r.error
         FROM engine_runs r
         JOIN (SELECT engine, MAX(started_at) AS latest FROM engine_runs GROUP BY engine) x
           ON x.engine = r.engine AND x.latest = r.started_at`,
      )
      .all()
      .map((r) => [r.engine, r]),
  );

  const counts = new Map(
    db
      .query<{ engine: string; n: number }, []>(
        `SELECT engine, COUNT(*) AS n FROM jobs GROUP BY engine`,
      )
      .all()
      .map((r) => [r.engine, r.n]),
  );

  // Only spawn Python when JobSpy could actually be affected by it.
  const python = enabled.has("jobspy") && options.pythonStatus
    ? await options.pythonStatus()
    : null;

  const signal = new AbortController().signal;

  return ENGINES.map((engine) => {
    const isEnabled = enabled.has(engine.id);
    let ready = false;
    let blockedBy: string | null = null;

    if (isEnabled) {
      const readiness = engine.ready({
        config,
        secrets,
        query: { terms: config.search.roles, locations: config.search.locations,
                 remoteOnly: config.search.remoteOnly, maxAgeDays: 30 },
        // ready() never makes requests; it only inspects config and boards.
        http: undefined as never,
        boards: boards.filter((b) => b.ats === engine.id),
        signal,
      });
      ready = readiness.ok;
      if (!readiness.ok) blockedBy = readiness.reason;

      if (ready && engine.id === "jobspy" && python && !python.ok) {
        ready = false;
        blockedBy = python.reason;
      }
    }

    const run = lastRuns.get(engine.id);
    return {
      id: engine.id,
      family: engine.family,
      enabled: isEnabled,
      ready,
      blockedBy,
      lastRun: run
        ? { status: run.status, startedAt: run.started_at, fetched: run.fetched,
            inserted: run.inserted, error: run.error }
        : null,
      jobs: counts.get(engine.id) ?? 0,
    };
  });
}

/** When discovery last ran at all, from the newest engine run. */
export function lastDiscoveryAt(db: Database): string | null {
  return db
    .query<{ at: string | null }, []>(`SELECT MAX(started_at) AS at FROM engine_runs`)
    .get()?.at ?? null;
}
