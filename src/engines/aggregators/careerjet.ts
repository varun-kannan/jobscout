/**
 * Careerjet.
 *
 * The broadest geographic reach in the roster — 90-plus countries, with an
 * `en_IN` locale for India. Like Adzuna it is a breadth source: descriptions
 * come back as short snippets and the link redirects rather than pointing at
 * the employer.
 *
 * Its API requires a `user_ip` and `user_agent` on every call, which is unusual
 * but documented: it attributes the search to an end user rather than a server.
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

const PAGE_SIZE = 50;

interface CareerjetJob {
  title?: string;
  description?: string;
  company?: string;
  locations?: string;
  url?: string;
  salary?: string;
  date?: string;
}

interface CareerjetResponse {
  type?: string;
  jobs?: CareerjetJob[];
  error?: string;
}

export const careerjet: Engine = {
  id: "careerjet",
  family: "aggregator",
  label: "Careerjet",
  keyless: false,
  descriptionQuality: "snippet",

  ready(ctx) {
    return ctx.secrets.careerjet?.affid
      ? READY
      : notReady("needs a Careerjet affiliate ID — free at careerjet.com/partners/api");
  },

  async fetch(ctx: EngineContext): Promise<RawJob[]> {
    const affid = ctx.secrets.careerjet!.affid;
    const terms = ctx.query.terms.length > 0 ? ctx.query.terms : ["software engineer"];
    const seen = new Set<string>();
    const results: RawJob[] = [];

    for (const term of terms) {
      const url = new URL("http://public.api.careerjet.net/search");
      url.searchParams.set("affid", affid);
      url.searchParams.set("keywords", term);
      url.searchParams.set("location", ctx.query.locations[0] ?? "India");
      url.searchParams.set("locale_code", "en_IN");
      url.searchParams.set("pagesize", String(PAGE_SIZE));
      url.searchParams.set("sort", "date");
      // Both are required by the API; it attributes searches to an end user.
      url.searchParams.set("user_ip", "127.0.0.1");
      url.searchParams.set("user_agent", "jobscout/0.1");

      const data = await ctx.http.json<CareerjetResponse>(url.toString(), {
        signal: ctx.signal,
      });

      if (data.error) throw new Error(`Careerjet: ${data.error}`);

      for (const job of asArray<CareerjetJob>(data.jobs)) {
        const applyUrl = clean(job.url);
        if (!applyUrl || seen.has(applyUrl)) continue;

        const title = clean(job.title);
        if (!matchesTerms(ctx.query.terms, { title })) continue;

        seen.add(applyUrl);
        const location = clean(job.locations);
        const description = clean(job.description);

        results.push({
          // Careerjet returns no id of its own, so the URL is the key.
          nativeId: applyUrl,
          company: clean(job.company),
          title,
          location,
          applyUrl,
          description,
          descriptionComplete: false,
          remote: looksRemote(location, title),
          // Salary arrives as free text ("₹20,00,000 - ₹30,00,000 per year").
          salary: job.salary ? parseSalary(`salary ${job.salary}`, "INR") : undefined,
          postedAt: job.date ?? null,
          raw: job,
        });
      }
    }

    return results;
  },
};
