/**
 * Foundit (formerly Monster India).
 *
 * The most useful source in the roster for ranking, and the strangest shape.
 * It returns **no description at all**, but hands over the skill list already
 * structured — plus `skillsWithSynonyms`, a canonical-to-synonyms map that is
 * precisely what the alias table needs:
 *
 *     { "value": "spring boot", "synonyms": ["springboot", "spring.boot"] }
 *
 * Every other engine hands over prose that costs an AI call to turn into
 * skills. This one arrives ready to match. The trade is that drafting has
 * nothing to work from, so these postings are marked incomplete and the
 * enrichment relay fills them in when the company has a known board.
 */

import {
  asArray,
  clean,
  READY,
  type Engine,
  type EngineContext,
  type RawJob,
} from "../engine.ts";
import { fromStructured, type SalaryRange } from "../../signals/salary.ts";
import { looksRemote } from "../engine.ts";

const LIMIT = 40;

interface FounditSalary {
  currency?: string;
  absoluteValue?: number;
  absoluteMonthlyValue?: number;
}

interface FounditJob {
  id?: number;
  jobId?: number;
  title?: string;
  companyName?: string;
  locations?: string;
  redirectUrl?: string;
  applyUrl?: string;
  createdAt?: number;
  skills?: string;
  skillsWithSynonyms?: Array<{ value?: string; synonyms?: string[] }>;
  employmentTypes?: string[];
  minimumSalary?: FounditSalary;
  maximumSalary?: FounditSalary;
  minimumExperience?: { years?: number };
  maximumExperience?: { years?: number };
  currencyCode?: string;
  hideSalary?: number;
}

interface FounditResponse {
  jobSearchResponse?: { data?: FounditJob[] };
}

/**
 * Zero is Foundit's "not disclosed", not a real figure, and `hideSalary`
 * marks a posting whose range the employer chose to withhold.
 */
function salaryOf(job: FounditJob): SalaryRange | undefined {
  if (job.hideSalary) return undefined;
  const min = job.minimumSalary?.absoluteValue ?? 0;
  const max = job.maximumSalary?.absoluteValue ?? 0;
  if (min <= 0 && max <= 0) return undefined;
  return fromStructured({
    min: min > 0 ? min : null,
    max: max > 0 ? max : null,
    currency: clean(job.minimumSalary?.currency ?? job.currencyCode) || "INR",
    period: "annual",
  });
}

/** The comma-separated `skills` string, preferring canonical values where given. */
function skillsOf(job: FounditJob): string[] {
  const canonical = asArray<{ value?: string }>(job.skillsWithSynonyms)
    .map((s) => clean(s.value))
    .filter(Boolean);
  if (canonical.length > 0) return canonical;
  return clean(job.skills)
    .split(",")
    .map((s) => clean(s))
    .filter(Boolean);
}

export const foundit: Engine = {
  id: "foundit",
  family: "india",
  label: "Foundit",
  keyless: true,
  descriptionQuality: "none",

  ready: () => READY,

  async fetch(ctx: EngineContext): Promise<RawJob[]> {
    const terms = ctx.query.terms.length > 0 ? ctx.query.terms : ["software engineer"];
    const locations = ctx.query.locations.length > 0 ? ctx.query.locations : ["india"];
    const seen = new Set<string>();
    const results: RawJob[] = [];

    for (const term of terms) {
      const url = new URL("https://www.foundit.in/middleware/jobsearch");
      url.searchParams.set("query", term);
      url.searchParams.set("locations", locations.join(","));
      url.searchParams.set("limit", String(LIMIT));

      const data = await ctx.http.json<FounditResponse>(url.toString(), {
        signal: ctx.signal,
        // The middleware rejects a bare JSON accept header.
        headers: { accept: "application/json, text/plain, */*", referer: "https://www.foundit.in/" },
      });

      for (const job of asArray<FounditJob>(data.jobSearchResponse?.data)) {
        const nativeId = String(job.jobId ?? job.id ?? "");
        if (!nativeId || seen.has(nativeId)) continue;
        seen.add(nativeId);

        const location = clean(job.locations);
        const title = clean(job.title);
        const skills = skillsOf(job);

        results.push({
          nativeId,
          company: clean(job.companyName),
          title,
          location,
          applyUrl: clean(job.applyUrl ?? job.redirectUrl),
          // Foundit's search response carries no body. Saying so lets the
          // enrichment relay know this is worth re-fetching from an ATS board.
          description: "",
          descriptionComplete: false,
          remote: looksRemote(location, title),
          salary: salaryOf(job),
          employmentType: job.employmentTypes?.length
            ? clean(job.employmentTypes[0])
            : null,
          postedAt: job.createdAt ? new Date(job.createdAt).toISOString() : null,
          skills,
          raw: job,
        });
      }
    }

    return results;
  },
};
