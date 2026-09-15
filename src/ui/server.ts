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

import { writeFile } from "node:fs/promises";
import { join } from "node:path";
import type { Database } from "bun:sqlite";
import type { Config } from "../config/schema.ts";
import type { Paths } from "../config/paths.ts";
import { saveConfig } from "../config/load.ts";
import { extractResume, resumeHeader, ResumeError } from "../profile/resume.ts";
import { buildProfile, loadProfile } from "../skills/profile.ts";
import {
  listTracked,
  markViewed,
  trackedAsCsv,
  trackerCounts,
  untrack,
  updateTracked,
} from "./tracker.ts";
import { APPLICATION_STATUSES } from "../db/applications.ts";
import { applySettings, settingsOptions } from "./settings.ts";
import { probeBackends } from "../setup/ai-setup.ts";
import { loadSecrets } from "../config/load.ts";
import { rankAll } from "../skills/rank.ts";
import { discoverJobs } from "../pipeline/discover.ts";
import { DiscoveryJob } from "./discovery-job.ts";
import { engineHealth, lastDiscoveryAt } from "../engines/health.ts";
import { activeBoards } from "../db/jobs.ts";
import { pythonCheck } from "../setup/checks/engines.ts";
import { classifyCompany, COMPANY_TYPES } from "../signals/company-type.ts";
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
  paths: Paths;
  /** 0 asks the operating system for any free port. */
  port?: number;
  /** Called with the final URL once listening. */
  onReady?(url: string): void;
}

const DECISIONS = new Set(["approved", "rejected", "new"]);

/** Formats `extractResume` can read. Anything else is refused before writing. */
const RESUME_TYPES: Record<string, string> = {
  pdf: ".pdf", docx: ".docx", txt: ".txt", md: ".md",
};
const MAX_RESUME_BYTES = 10 * 1024 * 1024;

/**
 * The extension to save under, from the client's filename.
 *
 * Only the extension is taken. The name itself never reaches the filesystem:
 * an upload called `../../.ssh/authorized_keys` would otherwise decide where
 * the file lands.
 */
export function resumeExtension(filename: unknown): string | null {
  // Whatever the client sent, including nothing: an upload with no filename
  // crashed this with "undefined is not an object".
  if (typeof filename !== "string") return null;
  const dot = filename.lastIndexOf(".");
  if (dot < 0) return null;
  const ext = filename.slice(dot + 1).toLowerCase();
  return RESUME_TYPES[ext] ?? null;
}

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
    companyType: p.get("companyType") ?? undefined,
    liveness: p.get("liveness") ?? undefined,
    postedWithinDays: num("postedWithin"),
    sort: (["score", "coverage", "posted", "company"] as const).includes(sort as never)
      ? (sort as JobFilters["sort"])
      : undefined,
    limit: num("limit"),
    offset: num("offset"),
  };
}

export function createServer(options: UiOptions): { url: string; stop(): void } {
  const { db, paths } = options;
  // Reassigned when a résumé is uploaded, so the Setup view reflects the change
  // without a restart.
  let config = options.config;

  const setStatus = db.prepare(`UPDATE jobs SET review_status = ? WHERE id = ?`);

  // Config and secrets are read when a pass starts, not when the server did,
  // so a key added in the meantime is used.
  const discovery = new DiscoveryJob(
    async (onFinish) =>
      discoverJobs({ db, config, secrets: await loadSecrets(paths), onFinish }),
    () => rankAll(db, config, { onlyNew: true }).ranked,
  );

  const server = Bun.serve({
    // Loopback only. This exposes an unauthenticated view of your job search
    // and résumé-derived profile; binding 0.0.0.0 would put it on the network.
    hostname: "127.0.0.1",
    port: options.port ?? 0,

    async fetch(request) {
      try {
        return await route(request);
      } catch (err) {
        // Unhandled, this renders Bun's development error page, a stack trace
        // into the compiled binary, served to the browser. JSON and a 500 are
        // both more useful and less revealing.
        const message = err instanceof Error ? err.message : String(err);
        return json({ error: `Request failed: ${message}` }, 500);
      }
    },
  });

  async function route(request: Request): Promise<Response> {
      const url = new URL(request.url);
      const { pathname } = url;

      if (pathname === "/" || pathname === "/index.html") {
        return new Response(page, {
          headers: { "content-type": "text/html; charset=utf-8" },
        });
      }

      if (pathname === "/api/dashboard") return json(dashboard(db));
      if (pathname === "/api/facets") return json(facets(db));

      if (pathname === "/api/config" && (request.method === "POST" || request.method === "PATCH")) {
        let patch: Record<string, unknown>;
        try {
          patch = (await request.json()) as Record<string, unknown>;
        } catch {
          return json({ error: "Body must be JSON" }, 400);
        }
        const result = applySettings(config, patch);
        if (!result.ok) return json({ errors: result.errors }, 422);
        config = result.config!;
        await saveConfig(paths, config);
        return json({ ok: true, config, options: settingsOptions() });
      }

      if (pathname === "/api/config") {
        // The résumé path and provider chain are shown; secrets are in a
        // different file and deliberately never read here.
        return json({
          search: config.search,
          match: config.match,
          ai: { providers: config.ai.providers, model: config.ai.model, budget: config.ai.budget },
          engines: config.engines,
          profile: { resumeFile: config.profile.resumeFile },
          options: settingsOptions(),
          companyTypes: COMPANY_TYPES,
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
        const id = decodeURIComponent(detail[1]!);
        const job = getJob(db, id);
        if (!job) return json({ error: "No such job" }, 404);
        // Opening a posting is what "viewed" means. Only ever creates a row, so
        // re-reading something you already applied to does not undo it.
        markViewed(db, id);
        return json(job);
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

      if (pathname === "/api/engines") {
        return json({
          lastDiscoveryAt: lastDiscoveryAt(db),
          engines: await engineHealth({
            db,
            config,
            secrets: await loadSecrets(paths),
            boards: activeBoards(db),
            pythonStatus: async () => {
              const result = await pythonCheck.run({} as never);
              return {
                ok: result.state === "ok",
                reason: `${result.summary}; JobSpy needs Python 3.10 or newer`,
              };
            },
          }),
        });
      }

      if (pathname === "/api/discover") {
        if (request.method === "POST") {
          const started = discovery.start();
          return json({ started, state: discovery.state() }, started ? 202 : 409);
        }
        return json(discovery.state());
      }

      if (pathname === "/api/providers") {
        // The chain is a preference, not a record of what is installed. Showing
        // which entries actually resolve is the difference between "why is
        // gemini-cli listed" and "it is listed but will be skipped".
        const secrets = await loadSecrets(paths);
        return json({ backends: await probeBackends(secrets) });
      }

      if (pathname === "/api/rerank" && request.method === "POST") {
        // Everything, not just new postings: the point is that the profile
        // changed, which invalidates rankings that already exist.
        const summary = rankAll(db, config, { onlyNew: false });
        return json({ ok: true, ...summary, dashboard: dashboard(db) });
      }

      if (pathname === "/api/classify" && request.method === "POST") {
        const rows = db
          .query<{ id: string; company: string; description: string }, []>(
            `SELECT id, company, COALESCE(description,'') AS description
             FROM jobs WHERE company_type IS NULL AND canonical_id IS NULL`,
          )
          .all();
        const set = db.prepare(`UPDATE jobs SET company_type = ? WHERE id = ?`);
        const counts: Record<string, number> = {};
        db.transaction(() => {
          for (const row of rows) {
            const { type } = classifyCompany(row.company, row.description);
            set.run(type, row.id);
            counts[type] = (counts[type] ?? 0) + 1;
          }
        })();
        return json({ ok: true, classified: rows.length, counts });
      }

      if (pathname === "/api/tracker") {
        const status = url.searchParams.get("status") ?? undefined;
        const stale = Number(url.searchParams.get("staleAfterDays") ?? 14);
        return json({
          statuses: APPLICATION_STATUSES,
          counts: trackerCounts(db),
          applications: listTracked(db, {
            status,
            staleAfterDays: Number.isFinite(stale) ? stale : 14,
          }),
        });
      }

      if (pathname === "/api/tracker.csv") {
        return new Response(trackedAsCsv(listTracked(db)), {
          headers: {
            "content-type": "text/csv; charset=utf-8",
            "content-disposition": 'attachment; filename="jobscout-applications.csv"',
          },
        });
      }

      const track = pathname.match(/^\/api\/tracker\/([^/]+)$/);
      if (track) {
        const id = decodeURIComponent(track[1]!);
        if (request.method === "POST" || request.method === "PATCH") {
          let body: { status?: unknown; note?: unknown };
          try {
            body = (await request.json()) as { status?: unknown; note?: unknown };
          } catch {
            return json({ error: "Body must be JSON" }, 400);
          }
          const result = updateTracked(db, id, body);
          if (!result.ok) return json({ error: result.error }, result.error === "No such job" ? 404 : 400);
          return json({ ok: true, applications: listTracked(db), counts: trackerCounts(db) });
        }
        if (request.method === "DELETE") {
          return untrack(db, id)
            ? json({ ok: true, counts: trackerCounts(db) })
            : json({ error: "Not tracked" }, 404);
        }
      }

      if (pathname === "/api/profile") {
        return json({
          resumeFile: config.profile.resumeFile,
          skills: loadProfile(db),
        });
      }

      if (pathname === "/api/resume" && request.method === "POST") {
        // Typed from the request rather than annotated: undici and the DOM
        // disagree on FormData's iterator type, and the request's own is right.
        let form: Awaited<ReturnType<Request["formData"]>>;
        try {
          form = await request.formData();
        } catch {
          return json({ error: "Expected a file upload" }, 400);
        }
        const file = form.get("resume");
        if (!(file instanceof File)) return json({ error: "No file was sent" }, 400);

        const ext = resumeExtension(file.name);
        if (!ext) {
          return json(
            { error: `Unsupported format. Use ${Object.keys(RESUME_TYPES).join(", ")}.` },
            415,
          );
        }
        if (file.size === 0) return json({ error: "That file is empty" }, 400);
        if (file.size > MAX_RESUME_BYTES) {
          return json({ error: "That file is larger than 10 MB" }, 413);
        }

        // A fixed name, in jobscout's own directory. Uploading through the
        // browser also sidesteps the macOS restriction that stops the CLI
        // reading ~/Downloads at all.
        const target = join(paths.profile, `resume${ext}`);
        await writeFile(target, Buffer.from(await file.arrayBuffer()));

        config = { ...config, profile: { ...config.profile, resumeFile: target } };
        await saveConfig(paths, config);

        try {
          const extracted = await extractResume(target);
          await writeFile(
            paths.resumeText,
            resumeHeader(`resume${ext}`) + extracted.text,
            "utf8",
          );
          const result = buildProfile(db, extracted.text);
          return json({
            file: `resume${ext}`,
            words: extracted.words,
            suspect: extracted.suspect,
            skills: result.skills.length,
            added: result.added,
            updated: result.updated,
            profile: loadProfile(db),
          });
        } catch (err) {
          // The file is saved and configured either way; only the reading
          // failed, and saying which is the difference between a fixable
          // problem and a mystery.
          const message = err instanceof ResumeError ? err.message : String(err);
          return json({ error: `Saved, but could not read it: ${message}` }, 422);
        }
      }

      return json({ error: "Not found" }, 404);
  }

  const url = `http://127.0.0.1:${server.port}`;
  options.onReady?.(url);
  return { url, stop: () => server.stop(true) };
}
