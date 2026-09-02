/**
 * The engine roster, and the runner that drives it.
 *
 * Engines run concurrently and are isolated from one another: one throwing,
 * timing out, or being rate-limited never stops the rest. Every attempt records
 * its own outcome, which is the whole point — in the system this replaces, four
 * of six configured sources silently returned nothing and there was no way to
 * tell a broken source from an empty one.
 */

import type { EngineId } from "../config/schema.ts";
import type { Board, Engine, EngineContext, RawJob, SearchQuery } from "./engine.ts";
import { HttpError } from "./http.ts";

import { greenhouse } from "./ats/greenhouse.ts";
import { lever } from "./ats/lever.ts";
import { ashby } from "./ats/ashby.ts";
import { recruitee } from "./ats/recruitee.ts";
import { workable } from "./ats/workable.ts";
import { smartrecruiters } from "./ats/smartrecruiters.ts";

import { remoteok } from "./boards/remoteok.ts";
import { arbeitnow } from "./boards/arbeitnow.ts";
import { themuse } from "./boards/themuse.ts";
import { remotive } from "./boards/remotive.ts";
import { himalayas } from "./boards/himalayas.ts";
import { jobicy } from "./boards/jobicy.ts";
import { hackernews } from "./boards/hackernews.ts";

import { foundit } from "./india/foundit.ts";
import { instahyre } from "./india/instahyre.ts";

import { adzuna } from "./aggregators/adzuna.ts";
import { careerjet } from "./aggregators/careerjet.ts";
import { jooble } from "./aggregators/jooble.ts";

import { jobspy } from "./scraper/jobspy.ts";

export const ENGINES: readonly Engine[] = [
  greenhouse,
  lever,
  ashby,
  recruitee,
  workable,
  smartrecruiters,
  remoteok,
  arbeitnow,
  themuse,
  remotive,
  himalayas,
  jobicy,
  hackernews,
  foundit,
  instahyre,
  adzuna,
  careerjet,
  jooble,
  jobspy,
];

const BY_ID = new Map<EngineId, Engine>(ENGINES.map((e) => [e.id, e]));

export function getEngine(id: EngineId): Engine | undefined {
  return BY_ID.get(id);
}

/** Engine ids the roster knows how to run, in registration order. */
export function implementedEngines(): EngineId[] {
  return ENGINES.map((e) => e.id);
}

export type RunStatus = "ok" | "empty" | "error" | "rate_limited" | "skipped";

export interface EngineRun {
  engine: EngineId;
  status: RunStatus;
  startedAt: string;
  finishedAt: string;
  fetched: number;
  jobs: RawJob[];
  error?: string;
}

export interface RunOptions {
  engines: EngineId[];
  query: SearchQuery;
  boards: Board[];
  http: EngineContext["http"];
  config: EngineContext["config"];
  secrets: EngineContext["secrets"];
  signal?: AbortSignal;
  /** Engines running at once. Each may itself poll many boards. */
  concurrency?: number;
  onStart?(engine: Engine): void;
  onFinish?(run: EngineRun): void;
}

function describeError(err: unknown): { status: RunStatus; message: string } {
  if (err instanceof HttpError) {
    if (err.rateLimited) return { status: "rate_limited", message: err.message };
    return { status: "error", message: err.message };
  }
  if (err instanceof Error) {
    if (err.name === "TimeoutError" || /timed? ?out/i.test(err.message)) {
      return { status: "error", message: "timed out" };
    }
    return { status: "error", message: err.message };
  }
  return { status: "error", message: String(err) };
}

async function runOne(engine: Engine, options: RunOptions): Promise<EngineRun> {
  const startedAt = new Date().toISOString();
  const base = { engine: engine.id, startedAt, fetched: 0, jobs: [] as RawJob[] };

  const ctx: EngineContext = {
    config: options.config,
    secrets: options.secrets,
    query: options.query,
    http: options.http,
    // ATS engines see only their own platform's boards.
    boards: options.boards.filter((b) => b.ats === engine.id),
    signal: options.signal ?? new AbortController().signal,
  };

  const readiness = engine.ready(ctx);
  if (!readiness.ok) {
    return {
      ...base,
      status: "skipped",
      finishedAt: new Date().toISOString(),
      error: readiness.reason,
    };
  }

  options.onStart?.(engine);

  try {
    const jobs = await engine.fetch(ctx);
    return {
      ...base,
      status: jobs.length > 0 ? "ok" : "empty",
      finishedAt: new Date().toISOString(),
      fetched: jobs.length,
      jobs,
    };
  } catch (err) {
    const { status, message } = describeError(err);
    return { ...base, status, finishedAt: new Date().toISOString(), error: message };
  }
}

/** Run every requested engine, isolating failures. Never rejects. */
export async function runEngines(options: RunOptions): Promise<EngineRun[]> {
  const selected = options.engines
    .map((id) => BY_ID.get(id))
    .filter((e): e is Engine => e !== undefined);

  const limit = Math.max(1, options.concurrency ?? 6);
  const runs: EngineRun[] = new Array(selected.length);
  let cursor = 0;

  async function worker(): Promise<void> {
    while (cursor < selected.length) {
      const index = cursor++;
      const run = await runOne(selected[index]!, options);
      runs[index] = run;
      options.onFinish?.(run);
    }
  }

  await Promise.all(Array.from({ length: Math.min(limit, selected.length) }, worker));
  return runs;
}
