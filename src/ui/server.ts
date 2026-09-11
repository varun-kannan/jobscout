/**
 * The local web UI.
 *
 * A terminal is the wrong place to read a twelve-thousand-character job
 * description or to sort two thousand rows by pay. This serves the same
 * database the CLI uses, from the same binary, on loopback only.
 *
 * It is deliberately small: no build step, no framework, no CDN. The page is
 * one embedded file, so `bun build --compile` still produces a single binary
 * that works with no network at all.
 */

import type { Database } from "bun:sqlite";
import type { Config } from "../config/schema.ts";
import {
  countJobs,
  dashboard,
  facets,
  getJob,
  listJobs,
  type JobFilters,
} from "./queries.ts";
// Bun types an `.html` import as HTMLBundle even under `type: "text"`, but the
// text loader hands back a plain string at runtime. The cast records that the
// annotation is wrong, not the code.
import pageAsset from "./app.html" with { type: "text" };
const page = pageAsset as unknown as string;

export interface UiOptions {
  db: Database;
  config: Config;
  /** 0 asks the operating system for any free port. */
  port?: number;
  /** Called with the final URL once listening. */
  onReady?(url: string): void;
}

const DECISIONS = new Set(["approved", "rejected", "new"]);

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: {
      "content-type": "application/json",
      // Nothing here should ever be cached: the page polls for changes the
      // CLI makes while it is open.
      "cache-control": "no-store",
    },
  });
}

/** Read filters from the query string, ignoring anything unrecognised. */
export function filtersFrom(url: URL): JobFilters {
  const p = url.searchParams;
  const num = (key: string): number | undefined => {
    const raw = p.get(key);
    if (raw === null || raw.trim() === "") return undefined;
    const value = Number(raw);
    return Number.isFinite(value) ? value : undefined;
  };
  const sort = p.get("sort") ?? undefined;
  return {
    q: p.get("q") ?? undefined,
    location: p.get("location") ?? undefined,
    company: p.get("company") ?? undefined,
    minAiScore: num("minAiScore"),
    minCoverage: num("minCoverage"),
    remoteOnly: p.get("remoteOnly") === "1",
    status: p.get("status") ?? undefined,
    sort: (["score", "coverage", "posted", "company"] as const).includes(sort as never)
      ? (sort as JobFilters["sort"])
      : undefined,
    limit: num("limit"),
    offset: num("offset"),
  };
}

export function createServer(options: UiOptions): { url: string; stop(): void } {
  const { db, config } = options;

  const setStatus = db.prepare(`UPDATE jobs SET review_status = ? WHERE id = ?`);

  const server = Bun.serve({
    // Loopback only. This exposes an unauthenticated view of your job search
    // and résumé-derived profile; binding 0.0.0.0 would put it on the network.
    hostname: "127.0.0.1",
    port: options.port ?? 0,

    async fetch(request) {
      const url = new URL(request.url);
      const { pathname } = url;

      if (pathname === "/" || pathname === "/index.html") {
        return new Response(page, {
          headers: { "content-type": "text/html; charset=utf-8" },
        });
      }

      if (pathname === "/api/dashboard") return json(dashboard(db));
      if (pathname === "/api/facets") return json(facets(db));

      if (pathname === "/api/config") {
        // The résumé path and provider chain are shown; secrets are in a
        // different file and deliberately never read here.
        return json({
          search: config.search,
          match: config.match,
          ai: { providers: config.ai.providers, model: config.ai.model, budget: config.ai.budget },
          engines: config.engines,
          profile: { resumeFile: config.profile.resumeFile },
        });
      }

      if (pathname === "/api/jobs") {
        const filters = filtersFrom(url);
        return json({
          total: countJobs(db, filters),
          jobs: listJobs(db, filters),
        });
      }

      const detail = pathname.match(/^\/api\/jobs\/([^/]+)$/);
      if (detail) {
        const job = getJob(db, decodeURIComponent(detail[1]!));
        return job ? json(job) : json({ error: "No such job" }, 404);
      }

      const decide = pathname.match(/^\/api\/jobs\/([^/]+)\/decision$/);
      if (decide && request.method === "POST") {
        const id = decodeURIComponent(decide[1]!);
        let body: { status?: string };
        try {
          body = (await request.json()) as { status?: string };
        } catch {
          return json({ error: "Body must be JSON" }, 400);
        }
        const status = body.status ?? "";
        if (!DECISIONS.has(status)) {
          return json({ error: `status must be one of ${[...DECISIONS].join(", ")}` }, 400);
        }
        if (!getJob(db, id)) return json({ error: "No such job" }, 404);
        setStatus.run(status, id);
        return json({ id, status });
      }

      return json({ error: "Not found" }, 404);
    },
  });

  const url = `http://127.0.0.1:${server.port}`;
  options.onReady?.(url);
  return { url, stop: () => server.stop(true) };
}
