/**
 * JobSpy — opt-in, off by default.
 *
 * The only route to Indeed and LinkedIn, which together supplied 42% of a
 * typical corpus and are reachable no other way: neither offers a public API.
 * It is also the only engine here that does not simply ask. JobSpy reaches
 * Indeed by presenting an API key extracted from Indeed's iOS app together
 * with a fabricated device fingerprint, and LinkedIn by scraping the
 * logged-out guest endpoint behind randomised delays.
 *
 * jobscout does not author any of that. This is a bridge to a third-party
 * package you choose to install, and `jobscout init` states the trade plainly
 * before enabling it.
 *
 * Its Naukri, Glassdoor, Google and ZipRecruiter scrapers all return zero and
 * are deliberately not offered — Naukri now answers `recaptcha required`.
 */

import {
  asArray,
  clean,
  looksRemote,
  notReady,
  READY,
  type Engine,
  type EngineContext,
  type RawJob,
} from "../engine.ts";
import { fromStructured } from "../../signals/salary.ts";

/** Only the two that actually return results. */
const SITES = ["indeed", "linkedin"] as const;

const TIMEOUT_MS = 180_000;

/**
 * Run inside the sidecar. Kept here rather than in a file on disk so the
 * compiled binary carries it, matching how migrations are embedded.
 */
const BRIDGE = `
import json, sys, warnings, logging
warnings.filterwarnings("ignore")
logging.disable(logging.CRITICAL)

try:
    from jobspy import scrape_jobs
except ImportError:
    print(json.dumps({"error": "jobspy not installed"}))
    sys.exit(0)

cfg = json.loads(sys.stdin.read())
out, errors = [], {}

for site in cfg["sites"]:
    for term in cfg["terms"]:
        try:
            kw = dict(
                site_name=[site],
                search_term=term,
                location=cfg.get("location") or "",
                results_wanted=cfg.get("results", 25),
                hours_old=cfg.get("hours", 720),
            )
            if site == "indeed" and cfg.get("country"):
                kw["country_indeed"] = cfg["country"]
            if site == "linkedin":
                kw["linkedin_fetch_description"] = True
            df = scrape_jobs(**kw)
            if df is None or len(df) == 0:
                continue
            for _, row in df.iterrows():
                out.append({k: (None if str(v) == "nan" else v) for k, v in row.items()})
        except Exception as exc:
            errors.setdefault(site, str(exc)[:160])

print(json.dumps({"jobs": out, "errors": errors}, default=str))
`;

interface SpyRow {
  id?: string;
  site?: string;
  title?: string;
  company?: string;
  location?: string;
  job_url?: string;
  description?: string;
  date_posted?: string;
  job_type?: string;
  is_remote?: boolean;
  min_amount?: number;
  max_amount?: number;
  currency?: string;
  interval?: string;
}

interface BridgeResult {
  jobs?: SpyRow[];
  errors?: Record<string, string>;
  error?: string;
}

/** Which python to use, if any. Resolved fresh each run — it may have appeared. */
async function findPython(): Promise<string | null> {
  for (const bin of ["python3", "python"]) {
    try {
      const proc = Bun.spawn([bin, "-c", "import jobspy"], {
        stdout: "ignore",
        stderr: "ignore",
      });
      if ((await proc.exited) === 0) return bin;
    } catch {
      continue;
    }
  }
  return null;
}

function period(interval: string | undefined): "annual" | "monthly" | "hourly" {
  if (interval === "hourly") return "hourly";
  if (interval === "monthly") return "monthly";
  return "annual";
}

export const jobspy: Engine = {
  id: "jobspy",
  family: "scraper",
  label: "JobSpy",
  keyless: false,
  descriptionQuality: "full",

  // Readiness cannot spawn a process synchronously, so the real check lives in
  // `jobscout init`; this only reports that the engine is opt-in.
  ready(ctx) {
    return ctx.config.engines.enabled.includes("jobspy")
      ? READY
      : notReady("opt-in; enable it during `jobscout init`");
  },

  async fetch(ctx: EngineContext): Promise<RawJob[]> {
    const python = await findPython();
    if (!python) {
      throw new Error(
        "Python with jobspy not found. Re-run `jobscout init` to set up the sidecar.",
      );
    }

    const proc = Bun.spawn([python, "-c", BRIDGE], {
      stdin: "pipe",
      stdout: "pipe",
      stderr: "pipe",
    });

    proc.stdin.write(
      JSON.stringify({
        sites: SITES,
        terms: ctx.query.terms.length > 0 ? ctx.query.terms : ["software engineer"],
        location: ctx.query.locations[0] ?? "",
        country: "india",
        results: 40,
        hours: ctx.query.maxAgeDays * 24,
      }),
    );
    await proc.stdin.end();

    const timeout = setTimeout(() => proc.kill(), TIMEOUT_MS);
    const [stdout, code] = await Promise.all([
      new Response(proc.stdout).text(),
      proc.exited,
    ]);
    clearTimeout(timeout);

    if (code !== 0) {
      const stderr = await new Response(proc.stderr).text();
      throw new Error(`sidecar exited ${code}: ${stderr.slice(0, 200)}`);
    }

    let parsed: BridgeResult;
    try {
      parsed = JSON.parse(stdout) as BridgeResult;
    } catch {
      throw new Error(`sidecar returned unparseable output: ${stdout.slice(0, 120)}`);
    }

    if (parsed.error) throw new Error(parsed.error);

    // A site failing is normal here and must not lose the ones that worked.
    const failed = Object.entries(parsed.errors ?? {});
    if (failed.length === SITES.length) {
      throw new Error(failed.map(([site, msg]) => `${site}: ${msg}`).join("; "));
    }

    return asArray<SpyRow>(parsed.jobs).flatMap((row) => {
      const applyUrl = clean(row.job_url);
      const nativeId = clean(row.id) || applyUrl;
      if (!nativeId) return [];

      const location = clean(row.location);
      const title = clean(row.title);
      const description = clean(row.description);

      return [
        {
          // Prefixed so an Indeed and a LinkedIn row can never collide.
          nativeId: `${clean(row.site) || "spy"}:${nativeId}`,
          company: clean(row.company),
          title,
          location,
          applyUrl,
          description,
          descriptionComplete: description.length > 0,
          remote: row.is_remote === true ? true : looksRemote(location, title),
          salary: fromStructured({
            min: row.min_amount ?? null,
            max: row.max_amount ?? null,
            currency: clean(row.currency) || "INR",
            period: period(row.interval),
          }),
          employmentType: clean(row.job_type) || null,
          postedAt: clean(row.date_posted) || null,
          raw: row,
        } satisfies RawJob,
      ];
    });
  },
};
