/**
 * Remotive.
 *
 * Curated remote roles with full descriptions. One of the few boards in this
 * family with a real search parameter, so filtering happens server-side and the
 * client-side filter only tidies the edges.
 *
 * `candidate_required_location` is the field that matters most here: it is
 * where "remote, but USA only" is stated plainly rather than buried in prose.
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

interface RemotiveJob {
  id?: number;
  url?: string;
  title?: string;
  company_name?: string;
  category?: string;
  tags?: string[];
  job_type?: string;
  publication_date?: string;
  candidate_required_location?: string;
  salary?: string;
  description?: string;
}

interface RemotiveResponse {
  jobs?: RemotiveJob[];
}

const LIMIT = 50;

export const remotive: Engine = {
  id: "remotive",
  family: "board",
  label: "Remotive",
  keyless: true,
  descriptionQuality: "full",

  ready: () => READY,

  async fetch(ctx: EngineContext): Promise<RawJob[]> {
    // One request per search term, since the API takes a single search string.
    const terms = ctx.query.terms.length > 0 ? ctx.query.terms : [""];
    const seen = new Set<string>();
    const results: RawJob[] = [];

    for (const term of terms) {
      const url = new URL("https://remotive.com/api/remote-jobs");
      url.searchParams.set("limit", String(LIMIT));
      if (term) url.searchParams.set("search", term);

      const data = await ctx.http.json<RemotiveResponse>(url.toString(), {
        signal: ctx.signal,
      });

      for (const job of asArray<RemotiveJob>(data.jobs)) {
        const nativeId = String(job.id ?? "");
        if (!nativeId || seen.has(nativeId)) continue;

        const title = clean(job.title);
        const tags = (job.tags ?? []).map((t) => clean(t)).filter(Boolean);
        if (!matchesTerms(ctx.query.terms, { title, tags })) continue;
        if (!withinAge(job.publication_date, ctx.query.maxAgeDays)) continue;

        seen.add(nativeId);
        const description = htmlToText(job.description ?? "");

        results.push({
          nativeId,
          company: clean(job.company_name),
          title,
          // Kept verbatim: "USA only" here is the restriction, not a location.
          location: clean(job.candidate_required_location) || "Remote",
          applyUrl: clean(job.url),
          description,
          descriptionComplete: description.length > 0,
          remote: true,
          employmentType: clean(job.job_type) || null,
          postedAt: job.publication_date ?? null,
          skills: tags,
          raw: job,
        });
      }
    }

    return results;
  },
};
