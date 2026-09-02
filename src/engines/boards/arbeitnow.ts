/**
 * Arbeitnow.
 *
 * Europe-weighted, and the largest single page in this family — a live check
 * returned 175 postings in one call. It gives an explicit `remote` boolean
 * rather than leaving it to be inferred, and a numeric `created_at` in seconds.
 *
 * Many postings are in German. That is left alone: translating would invent
 * content, and the skill extractor reads technology names regardless of the
 * surrounding language.
 */

import {
  asArray,
  clean,
  htmlToText,
  remoteFrom,
  READY,
  type Engine,
  type EngineContext,
  type RawJob,
} from "../engine.ts";
import { epochToIso, matchesTerms, withinAge } from "./filter.ts";

interface ArbeitnowJob {
  slug?: string;
  company_name?: string;
  title?: string;
  description?: string;
  remote?: boolean;
  url?: string;
  tags?: string[];
  job_types?: string[];
  location?: string;
  created_at?: number;
}

interface ArbeitnowResponse {
  data?: ArbeitnowJob[];
}

export const arbeitnow: Engine = {
  id: "arbeitnow",
  family: "board",
  label: "Arbeitnow",
  keyless: true,
  descriptionQuality: "full",

  ready: () => READY,

  async fetch(ctx: EngineContext): Promise<RawJob[]> {
    const data = await ctx.http.json<ArbeitnowResponse>(
      "https://www.arbeitnow.com/api/job-board-api",
      { signal: ctx.signal },
    );

    const results: RawJob[] = [];

    for (const job of asArray<ArbeitnowJob>(data.data)) {
      const slug = clean(job.slug);
      if (!slug) continue;

      const title = clean(job.title);
      const tags = (job.tags ?? []).map((t) => clean(t)).filter(Boolean);
      if (!matchesTerms(ctx.query.terms, { title, tags })) continue;

      const postedAt = epochToIso(job.created_at);
      if (!withinAge(postedAt, ctx.query.maxAgeDays)) continue;

      const location = clean(job.location);
      const description = htmlToText(job.description ?? "");

      results.push({
        nativeId: slug,
        company: clean(job.company_name),
        title,
        location,
        applyUrl: clean(job.url),
        description,
        descriptionComplete: description.length > 0,
        remote: remoteFrom(job.remote, location, title),
        employmentType: job.job_types?.length ? clean(job.job_types[0]) : null,
        postedAt,
        skills: tags,
        raw: job,
      });
    }

    return results;
  },
};
