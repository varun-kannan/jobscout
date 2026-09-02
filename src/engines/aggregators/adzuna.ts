/**
 * Adzuna.
 *
 * A breadth source, not a depth source. Its own documentation is explicit that
 * only a snippet of each description is returned, and `redirect_url` points at
 * an Adzuna landing page rather than the employer — the API exists to send
 * traffic to Adzuna, not to hand over complete records.
 *
 * That makes it valuable for *discovery*: it covers 19 countries including
 * India and reports salaries, so it finds roles the ATS engines have never
 * heard of. The enrichment relay then fetches the real posting when the
 * company turns out to have a known board.
 *
 * Free tier is roughly 1,000 calls a month, so requests are kept deliberately
 * few: one per search term, one page each.
 */

import {
  asArray,
  clean,
  notReady,
  READY,
  type Engine,
  type EngineContext,
  type RawJob,
} from "../engine.ts";
import { fromStructured } from "../../signals/salary.ts";
import { matchesTerms, withinAge } from "../boards/filter.ts";

const RESULTS_PER_PAGE = 50;

interface AdzunaJob {
  id?: string;
  title?: string;
  description?: string;
  redirect_url?: string;
  created?: string;
  salary_min?: number;
  salary_max?: number;
  salary_is_predicted?: string | number | boolean;
  contract_time?: string;
  company?: { display_name?: string };
  location?: { display_name?: string; area?: string[] };
  category?: { label?: string };
}

interface AdzunaResponse {
  results?: AdzunaJob[];
}

/** Adzuna reports this as "0"/"1" strings rather than booleans. */
function isPredicted(value: AdzunaJob["salary_is_predicted"]): boolean {
  return value === true || value === 1 || value === "1";
}

export const adzuna: Engine = {
  id: "adzuna",
  family: "aggregator",
  label: "Adzuna",
  keyless: false,
  descriptionQuality: "snippet",

  ready(ctx) {
    const key = ctx.secrets.adzuna;
    return key?.appId && key?.appKey
      ? READY
      : notReady("needs an Adzuna app ID and key — free at developer.adzuna.com");
  },

  async fetch(ctx: EngineContext): Promise<RawJob[]> {
    const creds = ctx.secrets.adzuna!;
    // Adzuna is country-scoped in the path. India unless told otherwise.
    const country = (ctx.config.search.locations[0] ?? "").toLowerCase().includes("us")
      ? "us"
      : "in";

    const terms = ctx.query.terms.length > 0 ? ctx.query.terms : ["software engineer"];
    const seen = new Set<string>();
    const results: RawJob[] = [];

    for (const term of terms) {
      const url = new URL(`https://api.adzuna.com/v1/api/jobs/${country}/search/1`);
      url.searchParams.set("app_id", creds.appId);
      url.searchParams.set("app_key", creds.appKey);
      url.searchParams.set("results_per_page", String(RESULTS_PER_PAGE));
      url.searchParams.set("what", term);
      url.searchParams.set("max_days_old", String(ctx.query.maxAgeDays));
      if (ctx.query.locations[0]) url.searchParams.set("where", ctx.query.locations[0]);

      const data = await ctx.http.json<AdzunaResponse>(url.toString(), {
        signal: ctx.signal,
      });

      for (const job of asArray<AdzunaJob>(data.results)) {
        const nativeId = clean(job.id);
        if (!nativeId || seen.has(nativeId)) continue;

        const title = clean(job.title);
        const category = clean(job.category?.label);
        if (!matchesTerms(ctx.query.terms, { title, tags: [category] })) continue;
        if (!withinAge(job.created, ctx.query.maxAgeDays)) continue;

        seen.add(nativeId);
        const description = clean(job.description);

        results.push({
          nativeId,
          company: clean(job.company?.display_name),
          title,
          location: clean(job.location?.display_name),
          applyUrl: clean(job.redirect_url),
          description,
          // Always a snippet by design, never the whole posting.
          descriptionComplete: false,
          salary: fromStructured({
            min: job.salary_min ?? null,
            max: job.salary_max ?? null,
            currency: country === "in" ? "INR" : "USD",
            // Marking a predicted figure as disclosed would be a lie.
            predicted: isPredicted(job.salary_is_predicted),
          }),
          employmentType: clean(job.contract_time) || null,
          postedAt: job.created ?? null,
          raw: job,
        });
      }
    }

    return results;
  },
};
