/**
 * Jooble.
 *
 * The only engine that POSTs its query as JSON, and the only one whose key is
 * scoped to a single country: a key issued on jooble.org reaches US listings
 * only, and India needs a separate key from the regional domain. The domain is
 * therefore stored alongside the key rather than hardcoded.
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
import { parseSalary } from "../../signals/salary.ts";
import { matchesTerms } from "../boards/filter.ts";

interface JoobleJob {
  id?: number | string;
  title?: string;
  location?: string;
  snippet?: string;
  salary?: string;
  source?: string;
  type?: string;
  link?: string;
  company?: string;
  updated?: string;
}

interface JoobleResponse {
  totalCount?: number;
  jobs?: JoobleJob[];
}

export const jooble: Engine = {
  id: "jooble",
  family: "aggregator",
  label: "Jooble",
  keyless: false,
  descriptionQuality: "snippet",

  ready(ctx) {
    return ctx.secrets.jooble?.key
      ? READY
      : notReady("needs a Jooble API key for your country's domain — jooble.org/api/about");
  },

  async fetch(ctx: EngineContext): Promise<RawJob[]> {
    const creds = ctx.secrets.jooble!;
    const host = creds.domain || "jooble.org";
    const terms = ctx.query.terms.length > 0 ? ctx.query.terms : ["software engineer"];
    const seen = new Set<string>();
    const results: RawJob[] = [];

    for (const term of terms) {
      const data = await ctx.http.json<JoobleResponse>(
        `https://${host}/api/${encodeURIComponent(creds.key)}`,
        {
          method: "POST",
          headers: { "content-type": "application/json" },
          signal: ctx.signal,
          body: JSON.stringify({
            keywords: term,
            location: ctx.query.locations[0] ?? "",
          }),
        },
      );

      for (const job of asArray<JoobleJob>(data.jobs)) {
        const link = clean(job.link);
        const nativeId = String(job.id ?? link);
        if (!nativeId || !link || seen.has(nativeId)) continue;

        const title = clean(job.title);
        if (!matchesTerms(ctx.query.terms, { title })) continue;

        seen.add(nativeId);
        const location = clean(job.location);
        // Jooble calls its truncated description a "snippet", accurately.
        const description = clean(job.snippet);

        results.push({
          nativeId,
          company: clean(job.company),
          title,
          location,
          applyUrl: link,
          description,
          descriptionComplete: false,
          remote: looksRemote(location, title),
          salary: job.salary ? parseSalary(`salary ${job.salary}`) : undefined,
          employmentType: clean(job.type) || null,
          postedAt: job.updated ?? null,
          raw: job,
        });
      }
    }

    return results;
  },
};
