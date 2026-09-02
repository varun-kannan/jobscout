/**
 * Instahyre.
 *
 * India engineering-focused, with a large pool — a live check reported 13,797
 * full-time postings. Like Foundit it returns keywords rather than a
 * description, so postings arrive matchable but not draftable until the
 * enrichment relay fills them in.
 */

import {
  asArray,
  clean,
  looksRemote,
  READY,
  type Engine,
  type EngineContext,
  type RawJob,
} from "../engine.ts";

const LIMIT = 50;
/** job_type=1 is full-time; internships are 2. */
const FULL_TIME = 1;

interface InstahyreJob {
  id?: number;
  title?: string;
  candidate_title?: string;
  locations?: string;
  keywords?: string[];
  public_url?: string;
  employer?: { company_name?: string };
}

interface InstahyreResponse {
  objects?: InstahyreJob[];
  meta?: { total_count?: number };
}

export const instahyre: Engine = {
  id: "instahyre",
  family: "india",
  label: "Instahyre",
  keyless: true,
  descriptionQuality: "none",

  ready: () => READY,

  async fetch(ctx: EngineContext): Promise<RawJob[]> {
    const url = new URL("https://www.instahyre.com/api/v1/job_search");
    url.searchParams.set("job_type", String(FULL_TIME));
    url.searchParams.set("limit", String(LIMIT));

    const data = await ctx.http.json<InstahyreResponse>(url.toString(), {
      signal: ctx.signal,
    });

    const results: RawJob[] = [];

    for (const job of asArray<InstahyreJob>(data.objects)) {
      const nativeId = String(job.id ?? "");
      const applyUrl = clean(job.public_url);
      if (!nativeId || !applyUrl) continue;

      const title = clean(job.title ?? job.candidate_title);
      // Locations arrive as one comma-separated string: "Bangalore,Delhi,Pune".
      const location = clean(job.locations).split(",").map((l) => clean(l)).filter(Boolean).join(", ");
      const skills = (job.keywords ?? []).map((k) => clean(k)).filter(Boolean);

      results.push({
        nativeId,
        company: clean(job.employer?.company_name),
        title,
        location,
        applyUrl,
        description: "",
        descriptionComplete: false,
        remote: looksRemote(location, title),
        postedAt: null,
        skills,
        raw: job,
      });
    }

    return results;
  },
};
