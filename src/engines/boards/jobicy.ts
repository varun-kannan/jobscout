/**
 * Jobicy.
 *
 * Remote roles with full descriptions and a useful `jobGeo` field carrying the
 * region restriction ("Anywhere", "USA", "Europe"). Field names are camelCase
 * and prefixed with `job`, unlike every other source in this family.
 */

import {
  asArray,
  clean,
  htmlToText,
  READY,
  type Engine,
  type EngineContext,
  type RawJob,
} from "../engine.ts";
import { matchesTerms, withinAge } from "./filter.ts";

interface JobicyJob {
  id?: number;
  url?: string;
  jobSlug?: string;
  jobTitle?: string;
  companyName?: string;
  jobIndustry?: string[];
  jobType?: string[];
  jobGeo?: string;
  jobLevel?: string;
  jobExcerpt?: string;
  jobDescription?: string;
  pubDate?: string;
}

interface JobicyResponse {
  jobs?: JobicyJob[];
}

const COUNT = 50;

export const jobicy: Engine = {
  id: "jobicy",
  family: "board",
  label: "Jobicy",
  keyless: true,
  descriptionQuality: "full",

  ready: () => READY,

  async fetch(ctx: EngineContext): Promise<RawJob[]> {
    const data = await ctx.http.json<JobicyResponse>(
      `https://jobicy.com/api/v2/remote-jobs?count=${COUNT}`,
      { signal: ctx.signal },
    );

    const results: RawJob[] = [];

    for (const job of asArray<JobicyJob>(data.jobs)) {
      const nativeId = String(job.id ?? job.jobSlug ?? "");
      if (!nativeId) continue;

      const title = clean(job.jobTitle);
      const tags = (job.jobIndustry ?? []).map((t) => clean(t)).filter(Boolean);
      if (!matchesTerms(ctx.query.terms, { title, tags })) continue;
      if (!withinAge(job.pubDate, ctx.query.maxAgeDays)) continue;

      const description = htmlToText(job.jobDescription ?? job.jobExcerpt ?? "");
      const geo = clean(job.jobGeo);

      results.push({
        nativeId,
        company: clean(job.companyName),
        title,
        // "Anywhere" is Jobicy's unrestricted marker; anything else is a limit.
        location: !geo || /^anywhere$/i.test(geo) ? "Remote (worldwide)" : `Remote (${geo})`,
        applyUrl: clean(job.url),
        description,
        descriptionComplete: description.length > 0,
        remote: true,
        employmentType: job.jobType?.length ? clean(job.jobType[0]) : null,
        postedAt: job.pubDate ?? null,
        skills: tags,
        raw: job,
      });
    }

    return results;
  },
};
