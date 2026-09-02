/**
 * The Muse.
 *
 * Mid-to-large employers, with structured experience levels — the only source
 * in this family that states seniority as data rather than leaving it in the
 * title. Descriptions arrive under `contents`, and the apply link lives in a
 * nested `refs.landing_page`.
 */

import {
  asArray,
  clean,
  htmlToText,
  looksRemote,
  READY,
  type Engine,
  type EngineContext,
  type RawJob,
} from "../engine.ts";
import { matchesTerms, withinAge } from "./filter.ts";

interface MuseJob {
  id?: number;
  name?: string;
  contents?: string;
  publication_date?: string;
  short_name?: string;
  locations?: Array<{ name?: string }>;
  categories?: Array<{ name?: string }>;
  levels?: Array<{ name?: string; short_name?: string }>;
  tags?: Array<{ name?: string }>;
  company?: { name?: string };
  refs?: { landing_page?: string };
}

interface MuseResponse {
  results?: MuseJob[];
}

const PAGES = 2;

export const themuse: Engine = {
  id: "themuse",
  family: "board",
  label: "The Muse",
  keyless: true,
  descriptionQuality: "full",

  ready: () => READY,

  async fetch(ctx: EngineContext): Promise<RawJob[]> {
    const results: RawJob[] = [];
    const seen = new Set<string>();

    for (let page = 1; page <= PAGES; page++) {
      const data = await ctx.http.json<MuseResponse>(
        `https://www.themuse.com/api/public/jobs?page=${page}`,
        { signal: ctx.signal },
      );

      for (const job of asArray<MuseJob>(data.results)) {
        const nativeId = String(job.id ?? job.short_name ?? "");
        if (!nativeId || seen.has(nativeId)) continue;

        const title = clean(job.name);
        const tags = [
          ...(job.categories ?? []).map((c) => clean(c.name)),
          ...(job.tags ?? []).map((t) => clean(t.name)),
        ].filter(Boolean);

        if (!matchesTerms(ctx.query.terms, { title, tags })) continue;
        if (!withinAge(job.publication_date, ctx.query.maxAgeDays)) continue;

        const applyUrl = clean(job.refs?.landing_page);
        if (!applyUrl) continue;

        seen.add(nativeId);

        const location = (job.locations ?? [])
          .map((l) => clean(l.name))
          .filter(Boolean)
          .join(" · ");
        const description = htmlToText(job.contents ?? "");

        results.push({
          nativeId,
          company: clean(job.company?.name),
          title,
          location,
          applyUrl,
          description,
          descriptionComplete: description.length > 0,
          remote: looksRemote(location, title),
          postedAt: job.publication_date ?? null,
          skills: tags,
          raw: job,
        });
      }
    }

    return results;
  },
};
